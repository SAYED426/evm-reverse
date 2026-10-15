/**
 * LLM readability pass.
 *
 * Heimdall's output is correct-ish but machine-flavoured: `var_a`, `arg0`,
 * `storage_map_c`. This module asks a local Ollama model to rename identifiers
 * and add comments while preserving behaviour exactly.
 *
 * Large contracts exceed a small model's context, so the body is split at
 * top-level function boundaries and cleaned one block at a time. Every response
 * is validated; anything that looks like a mangled rewrite is discarded in
 * favour of the original text.
 */

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_LLM_MODEL = process.env.EVM_REVERSE_LLM_MODEL ?? "qwen2.5:7b";

export interface LlmOptions {
  baseUrl?: string;
  /** Bearer token for authenticated endpoints (default: EVM_REVERSE_OLLAMA_API_KEY). */
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** Context window to request from Ollama. Default 16384. */
  numCtx?: number;
  /** Send the whole body in one request up to this size. */
  maxWholeChars?: number;
  /** Skip any single function block larger than this (context safety). */
  maxBlockChars?: number;
  onProgress?: (message: string) => void;
}

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface OllamaTags {
  models?: Array<{ name?: string }>;
}

interface OllamaChat {
  message?: { content?: string };
  error?: string;
}

export function baseUrl(options: LlmOptions = {}): string {
  return options.baseUrl ?? process.env.EVM_REVERSE_OLLAMA_URL ?? DEFAULT_OLLAMA_URL;
}

/** Bearer token for authenticated endpoints (e.g. ollama.com). Optional. */
export function apiKey(options: LlmOptions = {}): string | undefined {
  const key = options.apiKey ?? process.env.EVM_REVERSE_OLLAMA_API_KEY;
  return key && key.length > 0 ? key : undefined;
}

export function modelName(options: LlmOptions = {}): string {
  return options.model ?? DEFAULT_LLM_MODEL;
}

function headers(options: LlmOptions): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const key = apiKey(options);
  if (key) h.authorization = `Bearer ${key}`;
  return h;
}

/** List models served by the configured endpoint. Throws if unreachable. */
export async function listModels(options: LlmOptions = {}): Promise<string[]> {
  const res = await fetch(`${baseUrl(options)}/api/tags`, {
    headers: headers(options),
    signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
  const body = (await res.json()) as OllamaTags;
  return (body.models ?? []).map((m) => m.name).filter((n): n is string => Boolean(n));
}

export interface LlmAvailability {
  ok: boolean;
  baseUrl: string;
  models: string[];
  /** Whether a bearer token is configured (the value itself is never returned). */
  hasKey: boolean;
  error?: string;
}

export async function availability(options: LlmOptions = {}): Promise<LlmAvailability> {
  const hasKey = apiKey(options) !== undefined;
  try {
    const models = await listModels(options);
    return { ok: true, baseUrl: baseUrl(options), models, hasKey };
  } catch (err) {
    return { ok: false, baseUrl: baseUrl(options), models: [], hasKey, error: (err as Error).message };
  }
}

async function chat(messages: ChatMessage[], options: LlmOptions): Promise<string> {
  const res = await fetch(`${baseUrl(options)}/api/chat`, {
    method: "POST",
    headers: headers(options),
    body: JSON.stringify({
      model: modelName(options),
      stream: false,
      messages,
      options: { temperature: 0, num_ctx: options.numCtx ?? 16_384 },
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 300_000),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
  const body = (await res.json()) as OllamaChat;
  if (body.error) throw new Error(`ollama: ${body.error}`);
  return body.message?.content ?? "";
}

const SYSTEM_PROMPT =
  "You are a smart-contract reverse-engineering assistant. You rewrite DECOMPILED Solidity so a " +
  "human can read it, while preserving behaviour EXACTLY. Rules:\n" +
  "1. Do not change logic, control flow, types, ordering, or require/assert conditions.\n" +
  "2. NEVER add, remove, or alter revert reason strings. If `require(x)` has no message, keep it with no message. Do not write `require(x, ...)`.\n" +
  "3. Never rename the contract or any declared type. Keep the contract name, event names, and struct names exactly as given.\n" +
  "4. Never add or remove state variables, functions, events, modifiers, imports, or pragmas.\n" +
  "5. Rename only meaningless local/parameter/state identifiers (var_a, arg0, storage_map_c, store_b) to short descriptive camelCase names inferred from usage.\n" +
  "6. Add brief inline comments explaining what non-obvious code does.\n" +
  "7. Keep every function, event, and state variable. Remove nothing.\n" +
  "8. Output ONLY Solidity code. No markdown fences, no prose before or after.";

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/m.exec(trimmed);
  if (fence?.[1]) return fence[1].trim();
  return trimmed.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
}

/** Count require/assert calls that carry a revert reason string. */
export function revertStringCount(text: string): number {
  return (text.match(/(require|assert)\s*\([^;{}]*?,\s*["']/g) ?? []).length;
}

/**
 * Remove revert reason strings the model invented. Heimdall drops messages, so
 * when the original had none, any message is an addition that would change the
 * deployed behaviour.
 */
export function stripRevertMessages(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const match = /^(require|assert)\s*\(/.exec(text.slice(i));
    if (!match) {
      out += text[i]!;
      i++;
      continue;
    }
    const open = i + match[0].length - 1;
    let depth = 0;
    let j = open;
    let topComma = -1;
    for (; j < text.length; j++) {
      const ch = text[j]!;
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      } else if (ch === "," && depth === 1 && topComma === -1) {
        topComma = j;
      }
    }
    if (j >= text.length) {
      out += text.slice(i);
      break;
    }
    const call = text.slice(open + 1, j);
    let rebuilt = call;
    if (topComma !== -1) {
      const rel = topComma - (open + 1);
      const condition = call.slice(0, rel).trim();
      const second = call.slice(rel + 1).trim();
      if (/^["']/.test(second)) rebuilt = condition;
    }
    out += `${match[1]}(${rebuilt})`;
    i = j + 1;
  }
  return out;
}

/** Reject obviously broken rewrites rather than trusting them. */
function looksSane(original: string, cleaned: string): boolean {
  if (cleaned.length < original.length * 0.35) return false;
  if (cleaned.length > original.length * 3) return false;
  return /\b(function|contract|fallback|receive|constructor|mapping|event)\b/.test(cleaned);
}

/** Keep the original contract name even if the model renamed it. */
function restoreContractName(original: string, cleaned: string): string {
  const originalName = /contract\s+(\w+)/.exec(original)?.[1];
  const cleanedName = /contract\s+(\w+)/.exec(cleaned)?.[1];
  if (!originalName || !cleanedName || originalName === cleanedName) return cleaned;
  return cleaned.replace(new RegExp(`contract\\s+${cleanedName}\\b`), `contract ${originalName}`);
}

/** Index ranges of top-level function-like blocks. */
interface Block {
  start: number;
  end: number;
  text: string;
}

const FN_HEADER = /^[ \t]*(function|constructor|receive|fallback|modifier)\b/gm;

function findBlockEnd(src: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function topLevelBlocks(code: string): Block[] {
  const blocks: Block[] = [];
  for (const match of code.matchAll(FN_HEADER)) {
    const start = match.index!;
    const brace = code.indexOf("{", start);
    if (brace === -1) continue;
    const end = findBlockEnd(code, brace);
    if (end === -1) continue;
    blocks.push({ start, end: end + 1, text: code.slice(start, end + 1) });
  }
  return blocks;
}

/** Declarations and signatures, with bodies blanked, as shared context. */
function buildContext(code: string, blocks: Block[], limit = 4000): string {
  let context = code;
  for (const block of [...blocks].reverse()) {
    const signature = block.text.split("{")[0]!.trim();
    context = context.slice(0, block.start) + signature + " { /* ... */ }" + context.slice(block.end);
  }
  return context.slice(0, limit);
}

async function cleanChunk(text: string, options: LlmOptions, context?: string): Promise<string | null> {
  const userParts = [];
  if (context) userParts.push(`Contract context (for reference, do not repeat):\n\`\`\`solidity\n${context}\n\`\`\``);
  userParts.push(`Rewrite this decompiled Solidity for readability:\n\`\`\`solidity\n${text}\n\`\`\``);
  const raw = await chat(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userParts.join("\n\n") },
    ],
    options,
  );
  const cleaned = stripFences(raw);
  if (!looksSane(text, cleaned)) return null;
  let repaired = restoreContractName(text, cleaned);
  const originalMessages = revertStringCount(text);
  if (originalMessages === 0) {
    repaired = stripRevertMessages(repaired);
  } else if (revertStringCount(repaired) > originalMessages) {
    return null;
  }
  return repaired;
}

export interface CleanupResult {
  code: string;
  notes: string[];
}

/**
 * Rewrite decompiled Solidity for readability. On any failure the original text
 * for that block is preserved, so this never makes the output worse than useless.
 */
export async function cleanupSolidity(code: string, options: LlmOptions = {}): Promise<CleanupResult> {
  const notes: string[] = [];
  const model = modelName(options);
  const blocks = topLevelBlocks(code);
  const maxBlockChars = options.maxBlockChars ?? 12_000;

  if (code.length <= (options.maxWholeChars ?? 6000) || blocks.length === 0) {
    options.onProgress?.(`llm (${model}): cleaning contract as a whole`);
    try {
      const cleaned = await cleanChunk(code, options);
      if (cleaned) return { code: cleaned, notes };
      notes.push("llm response failed validation; kept original");
    } catch (err) {
      notes.push(`llm failed: ${(err as Error).message}`);
    }
    return { code, notes };
  }

  options.onProgress?.(`llm (${model}): cleaning ${blocks.length} function block(s)`);
  const context = buildContext(code, blocks);
  let out = code;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.text.length > maxBlockChars) {
      notes.push(`block ${i + 1}: skipped (too large: ${block.text.length} chars)`);
      continue;
    }
    options.onProgress?.(`llm: block ${blocks.length - i}/${blocks.length}`);
    try {
      const cleaned = await cleanChunk(block.text, options, context);
      if (cleaned) out = out.slice(0, block.start) + cleaned + out.slice(block.end);
      else notes.push(`block ${i + 1}: kept original (failed validation)`);
    } catch (err) {
      notes.push(`block ${i + 1}: ${(err as Error).message}`);
    }
  }
  return { code: out, notes };
}
