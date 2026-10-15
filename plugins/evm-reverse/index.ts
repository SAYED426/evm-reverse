/**
 * evm-reverse - OpenCode plugin
 *
 * Registers an `evm_reverse_contract` tool that runs the evm-reverse CLI and
 * returns the decompiled Solidity for an on-chain contract.
 *
 * OpenCode runs on the Windows host while the CLI + Heimdall live inside WSL,
 * so on win32 we spawn the CLI through `wsl bash`. On Linux/macOS we spawn it
 * directly.
 */

import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { Plugin } from "@opencode/plugin";

const execFileAsync = promisify(execFile);

/**
 * The CLI and Heimdall live inside WSL while OpenCode runs on the Windows host,
 * so default paths have to be resolved through WSL. Override with
 * EVM_REVERSE_WSL_HOME or EVM_REVERSE_CLI if your layout differs.
 */
function resolveWslHome(): string {
  if (process.env.EVM_REVERSE_WSL_HOME) return process.env.EVM_REVERSE_WSL_HOME;
  if (process.platform !== "win32") return homedir();
  try {
    const out = execFileSync("wsl", ["bash", "-lc", "echo $HOME"], { encoding: "utf8" }).trim();
    return out || "/home";
  } catch {
    return "/home";
  }
}

const WSL_HOME = resolveWslHome();
const CLI_PATH = process.env.EVM_REVERSE_CLI ?? `${WSL_HOME}/evm-reverse/bin/evm-reverse`;
const DEFAULT_OUT = process.env.EVM_REVERSE_OUTDIR ?? `${WSL_HOME}/reversed`;
const MAX_CHARS = 120_000;

interface ReverseInput {
  address?: string;
  rpcUrl?: string;
  outDir?: string;
  storage?: boolean;
  perFunctionMs?: number;
  hardfork?: string;
  llm?: boolean;
  llmModel?: string;
  llmUrl?: string;
  llmApiKey?: string;
}

interface ReverseMetadata {
  address: string;
  chainId: number;
  blockNumber: number;
  proxy: { isProxy: boolean; kind: string; implementation?: string };
  resolvedFunctions: number;
  unresolvedFunctions: number;
  resolvedEvents: number;
  unresolvedEvents: number;
  solidity: string;
  paths?: { solidity: string };
}

function buildCommand(args: string[]): { file: string; argv: string[] } {
  if (process.platform === "win32") {
    return { file: "wsl", argv: ["bash", CLI_PATH, ...args] };
  }
  return { file: CLI_PATH, argv: args };
}

function summarize(meta: ReverseMetadata): string {
  const proxy = meta.proxy?.isProxy
    ? `Proxy: ${meta.proxy.kind} -> implementation ${meta.proxy.implementation ?? "unresolved"}`
    : "Proxy: none";
  return [
    `Decompiled ${meta.address} (chain ${meta.chainId}, block ${meta.blockNumber}).`,
    proxy,
    `Selectors resolved: ${meta.resolvedFunctions} functions, ${meta.resolvedEvents} events ` +
      `(${meta.unresolvedFunctions + meta.unresolvedEvents} unresolved).`,
  ].join("\n");
}

export default Plugin.define({
  id: "evm-reverse",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "evm",
        description: "On-chain EVM reverse engineering (decompile unverified contracts)",
      });

      editor.add({
        name: "reverse_contract",
        description:
          "Reverse-engineer an unverified EVM smart contract from its on-chain address into readable Solidity. " +
          "Fetches bytecode, detects and follows proxies (EIP-1967, beacon, UUPS, ZeppelinOS, EIP-1167), decompiles " +
          "via Heimdall, and resolves function/event selectors via OpenChain and 4byte. Returns the decompiled source.",
        input: {
          type: "object",
          properties: {
            address: { type: "string", description: "0x-prefixed contract address (or raw bytecode hex)" },
            rpcUrl: {
              type: "string",
              description: "Ethereum RPC URL. Optional if ETH_RPC_URL is set; public fallbacks are used otherwise.",
            },
            outDir: { type: "string", description: "WSL output directory. Defaults to <home>/reversed/<address>." },
            storage: { type: "boolean", description: "Also dump accessed storage slots." },
            perFunctionMs: {
              type: "number",
              description: "Per-function symbolic execution timeout in ms. Lower it for large contracts.",
            },
            hardfork: { type: "string", description: "Hardfork for opcode recognition (default: latest)." },
            llm: {
              type: "boolean",
              description:
                "Run an Ollama LLM pass to rename identifiers and add comments. Slower; review before trusting.",
            },
            llmModel: {
              type: "string",
              description: "Ollama model for the LLM pass (default: qwen2.5:7b).",
            },
            llmUrl: {
              type: "string",
              description: "Ollama base URL (default: http://127.0.0.1:11434, or $EVM_REVERSE_OLLAMA_URL).",
            },
            llmApiKey: {
              type: "string",
              description: "Bearer token for an authenticated Ollama endpoint (default: $EVM_REVERSE_OLLAMA_API_KEY).",
            },
          },
          required: ["address"],
          additionalProperties: false,
        },
        options: { namespace: "evm", codemode: true },
        execute: async (rawInput, context) => {
          const input = rawInput as ReverseInput;
          const address = String(input.address ?? "").trim();
          if (!address) return { content: "error: `address` is required" };

          const outDir = input.outDir ?? `${DEFAULT_OUT}/${address.slice(0, 12)}`;
          const args = [address, "--json", "-o", outDir];
          if (input.rpcUrl) args.push("--rpc", input.rpcUrl);
          if (input.storage) args.push("--storage");
          if (input.perFunctionMs) args.push("--per-function", String(input.perFunctionMs));
          if (input.hardfork) args.push("--hardfork", input.hardfork);
          if (input.llm) args.push("--llm");
          if (input.llmModel) args.push("--llm-model", input.llmModel);
          if (input.llmUrl) args.push("--llm-url", input.llmUrl);
          if (input.llmApiKey) args.push("--llm-key", input.llmApiKey);

          const { file, argv } = buildCommand(args);
          await context.progress({ status: `decompiling ${address}` });

          try {
            const { stdout } = await execFileAsync(file, argv, {
              maxBuffer: 256 * 1024 * 1024,
              signal: context.signal,
              env: process.env,
            });
            const meta = JSON.parse(stdout) as ReverseMetadata;
            const source = meta.solidity ?? "(no solidity produced)";
            const truncated =
              source.length > MAX_CHARS
                ? source.slice(0, MAX_CHARS) + `\n\n// ... truncated; full file: ${meta.paths?.solidity ?? outDir}\n`
                : source;
            return { content: `evm_reverse_contract\n${summarize(meta)}\n\n${truncated}` };
          } catch (err) {
            const e = err as { stderr?: string; message?: string };
            const detail = (e.stderr || e.message || String(err)).slice(-4000);
            return { content: `evm-reverse failed for ${address}:\n${detail}` };
          }
        },
      });
    });
  },
});
