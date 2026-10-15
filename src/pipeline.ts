/**
 * Pipeline orchestration: address in, readable Solidity out.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decompile } from "./heimdall.ts";
import { detectProxy, type ProxyInfo } from "./proxy.ts";
import { Rpc } from "./rpc.ts";
import { resolveSelectors, resolveEventTopics, type ResolvedSignature } from "./selectors.ts";
import { scanStorage } from "./storage.ts";
import { extractPush32 } from "./bytecode.ts";
import { applyResolvedNames, buildHeader, composeFromCode, composeSolidity, contractNameFrom, extractCode, type EmitMetadata } from "./emit.ts";
import { cleanupSolidity, modelName } from "./llm.ts";
import { isAddress, log } from "./util.ts";

export interface ReverseOptions {
  target: string;
  rpcUrl?: string;
  outDir: string;
  includeSol?: boolean;
  includeProxy?: boolean;
  withStorage?: boolean;
  slotCount?: number;
  llm?: boolean;
  llmModel?: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  decompileTimeoutMs?: number;
  perFunctionTimeoutMs?: number;
  hardfork?: string;
}

export interface ReverseResult {
  solidityPath: string;
  abiPath: string;
  metadataPath: string;
  solidity: string;
  metadata: EmitMetadata;
}

interface AbiEntry {
  type?: string;
  name?: string;
}

function selectorsFromAbi(abi: unknown[]): { functions: string[]; events: string[] } {
  const functions = new Set<string>();
  const events = new Set<string>();
  for (const raw of abi) {
    const entry = raw as AbiEntry;
    if (!entry?.name) continue;
    const fn = /^Unresolved_([0-9a-fA-F]{8})$/.exec(entry.name);
    if (fn) functions.add(`0x${fn[1]!.toLowerCase()}`);
    const ev = /^Event_([0-9a-fA-F]{8})$/.exec(entry.name);
    if (ev) events.add(`0x${ev[1]!.toLowerCase()}`);
  }
  return { functions: [...functions], events: [...events] };
}

function selectorsFromSource(sol: string): { functions: string[]; events: string[] } {
  const functions = new Set<string>();
  const events = new Set<string>();
  for (const match of sol.matchAll(/Unresolved_([0-9a-fA-F]{8})/g)) functions.add(`0x${match[1]!.toLowerCase()}`);
  for (const match of sol.matchAll(/Event_([0-9a-fA-F]{8})/g)) events.add(`0x${match[1]!.toLowerCase()}`);
  return { functions: [...functions], events: [...events] };
}

/** map `0xabcdef12` (first 4 bytes of a topic) -> resolved event signature */
function prefixIndex(topics: Map<string, ResolvedSignature>): Map<string, ResolvedSignature> {
  const out = new Map<string, ResolvedSignature>();
  for (const [topic, sig] of topics) {
    out.set(`0x${topic.slice(2, 10)}`, sig);
  }
  return out;
}

function renameInAbi(abi: unknown[], functions: Map<string, ResolvedSignature>, events: Map<string, ResolvedSignature>): unknown[] {
  return abi.map((raw) => {
    const entry = { ...(raw as AbiEntry) } as AbiEntry;
    if (!entry.name) return entry;
    const fn = /^Unresolved_([0-9a-fA-F]{8})$/.exec(entry.name);
    if (fn) {
      const sig = functions.get(`0x${fn[1]!.toLowerCase()}`);
      if (sig) entry.name = sig.name;
      return entry;
    }
    const ev = /^Event_([0-9a-fA-F]{8})$/.exec(entry.name);
    if (ev) {
      const sig = events.get(`0x${ev[1]!.toLowerCase()}`);
      if (sig) entry.name = sig.name;
      return entry;
    }
    return entry;
  });
}

export async function reverse(options: ReverseOptions): Promise<ReverseResult> {
  const { target } = options;
  const isAddr = isAddress(target);
  await mkdir(options.outDir, { recursive: true });

  const rpc = Rpc.fromUrl(options.rpcUrl);
  let proxy: ProxyInfo = { isProxy: false, kind: "none" };
  let chainId = 1;
  let blockNumber = 0;
  let code = "";
  let implCode = "";
  let decompileTarget = target;
  let targetKind = "address";

  if (isAddr) {
    log.step(`fetching bytecode for ${target}`);
    code = await rpc.getCode(target);
    if (!code || code === "0x" || code.length <= 2) {
      throw new Error(`${target} has no bytecode — it is an EOA or self-destructed contract`);
    }
    log.info(`bytecode size: ${(code.length - 2) / 2} bytes`);

    chainId = await rpc.chainId().catch(() => 1);
    blockNumber = await rpc.blockNumber().catch(() => 0);

    proxy = await detectProxy(target, code, rpc);
    if (proxy.isProxy) {
      const impl = proxy.implementation ? ` -> ${proxy.implementation}` : "";
      log.ok(`proxy detected (${proxy.kind})${impl}`);
    }
    if (proxy.isProxy && proxy.implementation) {
      decompileTarget = proxy.implementation;
      targetKind = "implementation";
      implCode = await rpc.getCode(proxy.implementation).catch(() => "");
    }
  } else {
    log.warn(`"${target}" is not an address; treating it as raw bytecode/file input`);
    targetKind = "raw";
  }

  const workDir = join(options.outDir, ".heimdall", targetKind);
  await mkdir(workDir, { recursive: true });

  const { sol, abi } = await decompile(decompileTarget, {
    rpcUrl: options.rpcUrl,
    outDir: workDir,
    includeSol: options.includeSol,
    timeoutMs: options.decompileTimeoutMs,
    perFunctionTimeoutMs: options.perFunctionTimeoutMs,
    hardfork: options.hardfork,
  });

  const fromAbi = selectorsFromAbi(abi);
  const fromSrc = selectorsFromSource(sol);
  const fnSelectors = [...new Set([...fromAbi.functions, ...fromSrc.functions])];
  const evPrefixes = [...new Set([...fromAbi.events, ...fromSrc.events])];

  log.step(`resolving ${fnSelectors.length} function selector(s)`);
  const fnMap = await resolveSelectors(fnSelectors, "function");

  let evMap = new Map<string, ResolvedSignature>();
  if (evPrefixes.length > 0) {
    let topics: string[] = [];
    const topicSource = implCode || code;
    if (isAddr && topicSource) {
      topics = extractPush32(topicSource).slice(0, 300);
    }
    const resolvedTopics = await resolveEventTopics(topics);
    const byPrefix = prefixIndex(resolvedTopics);
    for (const prefix of evPrefixes) {
      const hit = byPrefix.get(prefix);
      if (hit) evMap.set(prefix, hit);
    }
    log.info(`resolved events: ${evMap.size}/${evPrefixes.length}`);
  }

  const renamedSol = applyResolvedNames(sol, fnMap, evMap);
  const contractName = contractNameFrom(isAddr ? target : "0x0000000000000000000000000000000000000000");

  const metadata: EmitMetadata = {
    address: isAddr ? target : "(raw target)",
    chainId,
    blockNumber,
    generatedAt: new Date().toISOString(),
    rpc: rpc.selected ?? options.rpcUrl ?? "fallback",
    proxy,
    targetKind,
    resolvedFunctions: fnMap.size,
    unresolvedFunctions: fnSelectors.length - fnMap.size,
    resolvedEvents: evMap.size,
    unresolvedEvents: evPrefixes.length - evMap.size,
  };

  let codeBody = extractCode(renamedSol);
  if (options.llm) {
    log.step("running LLM readability pass");
    try {
      const result = await cleanupSolidity(codeBody, {
        model: options.llmModel,
        baseUrl: options.llmBaseUrl,
        apiKey: options.llmApiKey,
        onProgress: (message) => log.info(message),
      });
      codeBody = result.code;
      metadata.llm = { model: modelName({ model: options.llmModel }), notes: result.notes };
      for (const note of result.notes) log.warn(`llm: ${note}`);
      if (result.notes.length === 0) log.ok("LLM pass complete");
    } catch (err) {
      log.warn(`LLM pass failed, keeping raw decompilation: ${(err as Error).message}`);
      metadata.llm = { model: modelName({ model: options.llmModel }), notes: [(err as Error).message] };
    }
  }

  const header = buildHeader(metadata, contractName);
  const finalSol = composeFromCode(codeBody, header);

  const solidityPath = join(options.outDir, "decompiled.sol");
  const abiPath = join(options.outDir, "abi.json");
  const metadataPath = join(options.outDir, "metadata.json");

  await writeFile(solidityPath, finalSol, "utf8");
  await writeFile(abiPath, JSON.stringify(renameInAbi(abi, fnMap, evMap), null, 2) + "\n", "utf8");

  if (options.withStorage && isAddr) {
    log.step("scanning storage slots");
    const scan = await scanStorage(rpc, target, options.slotCount ?? 64);
    (metadata as EmitMetadata & { storage?: unknown }).storage = scan;
    await writeFile(join(options.outDir, "storage.json"), JSON.stringify(scan, null, 2) + "\n", "utf8");
  }

  if (options.includeProxy && isAddr && proxy.isProxy) {
    log.step(`decompiling proxy shell ${target}`);
    try {
      const proxyWork = join(options.outDir, ".heimdall", "proxy");
      await mkdir(proxyWork, { recursive: true });
      const shell = await decompile(target, {
        rpcUrl: options.rpcUrl,
        outDir: proxyWork,
        includeSol: options.includeSol,
        timeoutMs: options.decompileTimeoutMs,
        perFunctionTimeoutMs: options.perFunctionTimeoutMs,
        hardfork: options.hardfork,
      });
      const shellFromAbi = selectorsFromAbi(shell.abi);
      const shellFromSrc = selectorsFromSource(shell.sol);
      const shellSelectors = [...new Set([...shellFromAbi.functions, ...shellFromSrc.functions])];
      const shellFns = await resolveSelectors(shellSelectors, "function");
      const shellMeta: EmitMetadata = {
        ...metadata,
        address: target,
        targetKind: "proxy",
        resolvedFunctions: shellFns.size,
        unresolvedFunctions: shellSelectors.length - shellFns.size,
        resolvedEvents: 0,
        unresolvedEvents: 0,
      };
      const proxyDir = join(options.outDir, "proxy");
      await mkdir(proxyDir, { recursive: true });
      await writeFile(
        join(proxyDir, "decompiled.sol"),
        composeSolidity(applyResolvedNames(shell.sol, shellFns, new Map()), buildHeader(shellMeta, contractNameFrom(target))),
        "utf8",
      );
      await writeFile(
        join(proxyDir, "abi.json"),
        JSON.stringify(renameInAbi(shell.abi, shellFns, new Map()), null, 2) + "\n",
        "utf8",
      );
      log.ok(`wrote ${join(proxyDir, "decompiled.sol")}`);
    } catch (err) {
      log.warn(`proxy shell decompilation failed: ${(err as Error).message}`);
    }
  }

  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");

  return { solidityPath, abiPath, metadataPath, solidity: finalSol, metadata };
}
