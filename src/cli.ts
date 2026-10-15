/**
 * evm-reverse CLI
 *
 *   evm-reverse <address> --rpc <url> -o out/
 */

import { resolve } from "node:path";
import { reverse } from "./pipeline.ts";
import { HeimdallNotFoundError } from "./heimdall.ts";
import { log } from "./util.ts";

const VERSION = "0.1.0";

interface CliOptions {
  target?: string;
  rpcUrl?: string;
  outDir?: string;
  includeSol: boolean;
  withStorage: boolean;
  slotCount?: number;
  llm: boolean;
  llmModel?: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  includeProxy: boolean;
  print: boolean;
  json: boolean;
  decompileTimeoutMs?: number;
  perFunctionTimeoutMs?: number;
  hardfork?: string;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    includeSol: true,
    withStorage: false,
    llm: false,
    includeProxy: false,
    print: false,
    json: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "-V":
      case "--version":
        opts.version = true;
        break;
      case "-r":
      case "--rpc":
        opts.rpcUrl = next();
        break;
      case "-o":
      case "--out":
        opts.outDir = next();
        break;
      case "--no-sol":
        opts.includeSol = false;
        break;
      case "--storage":
        opts.withStorage = true;
        break;
      case "--slots":
        opts.slotCount = Number(next());
        break;
      case "--llm":
        opts.llm = true;
        break;
      case "--llm-model":
        opts.llm = true;
        opts.llmModel = next();
        break;
      case "--llm-url":
        opts.llmBaseUrl = next();
        break;
      case "--llm-key":
        opts.llmApiKey = next();
        break;
      case "--include-proxy":
        opts.includeProxy = true;
        break;
      case "--print":
        opts.print = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--timeout":
        opts.decompileTimeoutMs = Number(next()) * 1000;
        break;
      case "--per-function":
        opts.perFunctionTimeoutMs = Number(next());
        break;
      case "--hardfork":
        opts.hardfork = next();
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
        if (opts.target) throw new Error(`unexpected extra argument: ${arg}`);
        opts.target = arg;
    }
  }
  return opts;
}

function usage(): string {
  return `evm-reverse ${VERSION} — reverse an unverified EVM contract into readable Solidity

Usage:
  evm-reverse <address|bytecode> [options]

Options:
  -r, --rpc <url>       Ethereum RPC endpoint (or set ETH_RPC_URL)
  -o, --out <dir>       Output directory (default: ./reversed/<address>)
      --no-sol          Skip the experimental Solidity body (ABI only)
      --storage         Scan storage slots 0..63 (eth_getStorageAt) into storage.json
      --slots <n>       Number of slots to scan with --storage (default: 64)
      --llm             Run an Ollama LLM pass to rename identifiers and add comments
      --llm-model <m>   LLM model to use (default: qwen2.5:7b)
      --llm-url <url>   Ollama base URL (default: http://127.0.0.1:11434)
      --llm-key <key>   Bearer token for authenticated Ollama endpoints
                        (default: $EVM_REVERSE_OLLAMA_API_KEY)
      --include-proxy   Also decompile the proxy shell itself
      --timeout <sec>   Overall decompile timeout (default: 1200)
      --per-function <ms>  Per-function symbolic execution timeout
      --hardfork <name> Hardfork for opcode recognition (default: latest)
      --print           Print the Solidity to stdout
      --json            Print run metadata as JSON to stdout
  -h, --help            Show this help
  -V, --version         Show version

Examples:
  evm-reverse 0x1234...abcd --rpc https://eth.llamarpc.com
  ETH_RPC_URL=https://... evm-reverse 0x1234...abcd -o out/ --storage
`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.version) {
    process.stdout.write(`evm-reverse ${VERSION}\n`);
    return;
  }
  if (opts.help || !opts.target) {
    process.stdout.write(usage());
    process.exitCode = opts.help ? 0 : 1;
    return;
  }

  const target = opts.target;
  const outDir = resolve(opts.outDir ?? `./reversed/${target.slice(0, 12)}`);

  const result = await reverse({
    target,
    rpcUrl: opts.rpcUrl,
    outDir,
    includeSol: opts.includeSol,
    includeProxy: opts.includeProxy,
    withStorage: opts.withStorage,
    slotCount: opts.slotCount,
    llm: opts.llm,
    llmModel: opts.llmModel,
    llmBaseUrl: opts.llmBaseUrl,
    llmApiKey: opts.llmApiKey,
    decompileTimeoutMs: opts.decompileTimeoutMs,
    perFunctionTimeoutMs: opts.perFunctionTimeoutMs,
    hardfork: opts.hardfork,
  });

  if (opts.print) process.stdout.write(result.solidity);
  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ...result.metadata,
          solidity: result.solidity,
          paths: {
            solidity: result.solidityPath,
            abi: result.abiPath,
            metadata: result.metadataPath,
          },
        },
        null,
        2,
      ) + "\n",
    );
  }

  log.ok(`wrote ${result.solidityPath}`);
  log.ok(`wrote ${result.abiPath}`);
  log.ok(`wrote ${result.metadataPath}`);
  if (!opts.print && !opts.json) {
    process.stdout.write(result.solidityPath + "\n");
  }
}

main().catch((err: unknown) => {
  if (err instanceof HeimdallNotFoundError) {
    log.error(err.message);
  } else {
    log.error((err as Error).message ?? String(err));
  }
  process.exitCode = 1;
});
