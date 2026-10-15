/**
 * Local web UI server.
 *
 * Zero dependencies: serves the static page in ./web and exposes two endpoints.
 *   GET  /api/health   - Heimdall + Ollama status
 *   POST /api/reverse  - runs the pipeline, streaming progress as NDJSON
 *
 * Jobs are serialized: the log sink is global, so overlapping runs would
 * interleave their progress on the wire.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findHeimdall } from "./heimdall.ts";
import { DEFAULT_LLM_MODEL, availability } from "./llm.ts";
import { reverse } from "./pipeline.ts";
import { log, setLogSink } from "./util.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, "..", "web");
const RUNS_DIR = join(homedir(), ".cache", "evm-reverse", "runs");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

interface ReverseRequest {
  address?: string;
  rpcUrl?: string;
  storage?: boolean;
  includeProxy?: boolean;
  llm?: boolean;
  llmModel?: string;
  llmUrl?: string;
  llmApiKey?: string;
  perFunctionMs?: number;
  hardfork?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const target = normalize(join(WEB_DIR, relative));
  if (!target.startsWith(WEB_DIR + sep)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  try {
    const data = await readFile(target);
    res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function handleReverse(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: ReverseRequest;
  try {
    body = JSON.parse((await readBody(req)) || "{}") as ReverseRequest;
  } catch (err) {
    sendJson(res, 400, { error: (err as Error).message });
    return;
  }

  const address = String(body.address ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) && !/^0x[0-9a-fA-F]+$/.test(address)) {
    sendJson(res, 400, { error: "a 0x contract address (or raw bytecode) is required" });
    return;
  }

  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const emit = (obj: unknown): void => {
    res.write(JSON.stringify(obj) + "\n");
  };

  let closed = false;
  res.on("close", () => {
    closed = true;
  });

  const outDir = join(RUNS_DIR, `${address.slice(0, 10)}-${Date.now()}`);
  setLogSink((line) => {
    if (!closed) emit({ type: "log", line });
  });

  try {
    const result = await enqueue(() =>
      reverse({
        target: address,
        rpcUrl: body.rpcUrl,
        outDir,
        withStorage: Boolean(body.storage),
        includeProxy: Boolean(body.includeProxy),
        llm: Boolean(body.llm),
        llmModel: body.llmModel,
        llmBaseUrl: body.llmUrl,
        llmApiKey: body.llmApiKey,
        perFunctionTimeoutMs: body.perFunctionMs,
        hardfork: body.hardfork,
      }),
    );
    if (!closed) {
      let abi = "";
      try {
        abi = await readFile(result.abiPath, "utf8");
      } catch {
        abi = "";
      }
      emit({
        type: "result",
        metadata: result.metadata,
        solidity: result.solidity,
        abi,
        paths: { solidity: result.solidityPath, abi: result.abiPath, metadata: result.metadataPath },
      });
    }
  } catch (err) {
    if (!closed) emit({ type: "error", message: (err as Error).message });
  } finally {
    setLogSink(undefined);
    if (!closed) res.end();
  }
}

async function handleHealth(res: ServerResponse, options: { url?: string; key?: string }): Promise<void> {
  let heimdall: { ok: boolean; path?: string; error?: string };
  try {
    heimdall = { ok: true, path: findHeimdall() };
  } catch (err) {
    heimdall = { ok: false, error: (err as Error).message };
  }
  const llm = await availability({ baseUrl: options.url || undefined, apiKey: options.key || undefined });
  sendJson(res, 200, {
    heimdall,
    llm: { ...llm, defaultModel: DEFAULT_LLM_MODEL },
    defaultRpc: process.env.ETH_RPC_URL ?? "",
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/health") {
    void handleHealth(res, {
      url: url.searchParams.get("url") ?? undefined,
      key: url.searchParams.get("key") ?? undefined,
    });
    return;
  }
  if (req.method === "POST" && path === "/api/reverse") {
    void handleReverse(req, res);
    return;
  }
  if (req.method === "GET") {
    void serveStatic(res, path);
    return;
  }
  sendJson(res, 405, { error: "method not allowed" });
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
server.listen(port, host, () => {
  log.ok(`evm-reverse web UI: http://${host}:${port}`);
  log.info(`run dir: ${RUNS_DIR}`);
});
