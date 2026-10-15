/**
 * Function / event selector resolution.
 *
 * Heimdall emits names like `Unresolved_a9059cbb` when its own resolver cannot
 * reach a signature database. We resolve them ourselves via OpenChain (batch)
 * with 4byte.directory as a fallback, and cache the results on disk.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "./util.ts";

export interface ResolvedSignature {
  selector: string;
  signature: string;
  name: string;
  source: "openchain" | "4byte" | "cache";
}

const CACHE_FILE = join(homedir(), ".cache", "evm-reverse", "signatures.json");

type CacheShape = Record<string, { signature: string; source: string }>;

async function loadCache(): Promise<CacheShape> {
  try {
    return JSON.parse(await readFile(CACHE_FILE, "utf8")) as CacheShape;
  } catch {
    return {};
  }
}

async function saveCache(cache: CacheShape): Promise<void> {
  try {
    await mkdir(dirname(CACHE_FILE), { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(cache, null, 0), "utf8");
  } catch {
    // Cache is best-effort.
  }
}

/** `transfer(address,uint256)` -> `transfer` */
function nameOf(signature: string): string {
  const paren = signature.indexOf("(");
  return paren === -1 ? signature : signature.slice(0, paren);
}

interface OpenChainEntry {
  name: string;
  filtered?: boolean;
}

interface OpenChainResponse {
  ok: boolean;
  result: Record<string, Record<string, OpenChainEntry[]>>;
}

async function lookupOpenChain(
  selectors: string[],
  kind: "function" | "event",
): Promise<Map<string, ResolvedSignature>> {
  const out = new Map<string, ResolvedSignature>();
  if (selectors.length === 0) return out;
  const param = kind === "function" ? "function" : "event";
  const url = `https://api.openchain.xyz/signature-database/v1/lookup?${param}=${selectors.join(",")}&filter=true`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return out;
    const body = (await res.json()) as OpenChainResponse;
    const bucket = body.result?.[param] ?? {};
    for (const [selector, entries] of Object.entries(bucket)) {
      const first = entries.find((e) => e.filtered !== false) ?? entries[0];
      if (!first?.name) continue;
      out.set(selector.toLowerCase(), {
        selector: selector.toLowerCase(),
        signature: first.name,
        name: nameOf(first.name),
        source: "openchain",
      });
    }
  } catch (err) {
    log.warn(`openchain lookup failed: ${(err as Error).message}`);
  }
  return out;
}

interface FourByteResponse {
  results: Array<{ text_signature: string }>;
}

async function lookup4byte(selector: string): Promise<ResolvedSignature | null> {
  try {
    const url = `https://www.4byte.directory/api/v1/signatures/?hex_signature=${selector}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as FourByteResponse;
    const first = body.results?.[0];
    if (!first?.text_signature) return null;
    return {
      selector: selector.toLowerCase(),
      signature: first.text_signature,
      name: nameOf(first.text_signature),
      source: "4byte",
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a batch of selectors. Returns a map keyed by lowercase selector.
 * Unknown selectors are simply absent from the map.
 */
export async function resolveSelectors(
  selectors: string[],
  kind: "function" | "event" = "function",
): Promise<Map<string, ResolvedSignature>> {
  const unique = [...new Set(selectors.map((s) => s.toLowerCase()))];
  const cache = await loadCache();
  const resolved = new Map<string, ResolvedSignature>();
  const missing: string[] = [];

  for (const selector of unique) {
    const hit = cache[selector];
    if (hit) {
      resolved.set(selector, {
        selector,
        signature: hit.signature,
        name: nameOf(hit.signature),
        source: "cache",
      });
    } else {
      missing.push(selector);
    }
  }

  if (missing.length > 0) {
    const fetched = await lookupOpenChain(missing, kind);
    let stillMissing = missing.filter((s) => !fetched.has(s));
    for (const [selector, sig] of fetched) {
      resolved.set(selector, sig);
      cache[selector] = { signature: sig.signature, source: sig.source };
    }
    if (stillMissing.length > 0) {
      const fallbacks = await Promise.all(stillMissing.map((s) => lookup4byte(s)));
      for (const sig of fallbacks) {
        if (!sig) continue;
        resolved.set(sig.selector, sig);
        cache[sig.selector] = { signature: sig.signature, source: sig.source };
      }
      stillMissing = stillMissing.filter((s) => !resolved.has(s));
    }
    if (stillMissing.length > 0) {
      log.info(`unresolved ${kind} selectors: ${stillMissing.join(", ")}`);
    }
    await saveCache(cache);
  }

  return resolved;
}

/** Extract the 4-byte selector from `Unresolved_deadbeef` / `Event_deadbeef`. */
export function selectorFromHeimdallName(name: string): string | null {
  const match = /^(?:Unresolved_|Event_)?([0-9a-fA-F]{8})$/.exec(name);
  return match ? `0x${match[1]!.toLowerCase()}` : null;
}

interface FourByteEventResponse {
  results: Array<{ text_signature: string }>;
}

async function lookup4byteEvent(topic: string): Promise<ResolvedSignature | null> {
  try {
    const url = `https://www.4byte.directory/api/v1/event-signatures/?hex_signature=${topic}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as FourByteEventResponse;
    const first = body.results?.[0];
    if (!first?.text_signature) return null;
    return {
      selector: topic.toLowerCase(),
      signature: first.text_signature,
      name: nameOf(first.text_signature),
      source: "4byte",
    };
  } catch {
    return null;
  }
}

/**
 * Resolve full 32-byte event topics. Unlike function selectors these are full
 * hashes, so they can be looked up directly. Returns a map keyed by topic.
 */
export async function resolveEventTopics(topics: string[]): Promise<Map<string, ResolvedSignature>> {
  const unique = [...new Set(topics.map((t) => t.toLowerCase()))].filter((t) => /^0x[0-9a-f]{64}$/.test(t));
  const resolved = new Map<string, ResolvedSignature>();
  if (unique.length === 0) return resolved;

  const batchSize = 100;
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    try {
      const url = `https://api.openchain.xyz/signature-database/v1/lookup?event=${batch.join(",")}&filter=true`;
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) {
        const body = (await res.json()) as OpenChainResponse;
        const bucket = body.result?.event ?? {};
        for (const [topic, entries] of Object.entries(bucket)) {
          const first = entries.find((e) => e.filtered !== false) ?? entries[0];
          if (!first?.name) continue;
          resolved.set(topic.toLowerCase(), {
            selector: topic.toLowerCase(),
            signature: first.name,
            name: nameOf(first.name),
            source: "openchain",
          });
        }
      }
    } catch (err) {
      log.warn(`openchain event lookup failed: ${(err as Error).message}`);
    }
  }

  const stillMissing = unique.filter((t) => !resolved.has(t));
  if (stillMissing.length > 0 && stillMissing.length <= 40) {
    const fallbacks = await Promise.all(stillMissing.map((t) => lookup4byteEvent(t)));
    for (const sig of fallbacks) {
      if (sig) resolved.set(sig.selector, sig);
    }
  }

  return resolved;
}
