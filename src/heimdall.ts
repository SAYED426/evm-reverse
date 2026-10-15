/**
 * Heimdall integration.
 *
 * Heimdall is the decompiler engine. We shell out to it, then read the files it
 * writes. Keeping this in one module means the rest of the pipeline never has to
 * know about its CLI quirks.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./util.ts";

export class HeimdallNotFoundError extends Error {
  constructor() {
    super(
      "heimdall binary not found. Install it with:\n" +
        "  curl -sSL -o ~/.local/bin/heimdall https://github.com/Jon-Becker/heimdall-rs/releases/download/0.9.3/heimdall-linux-amd64 && chmod +x ~/.local/bin/heimdall",
    );
    this.name = "HeimdallNotFoundError";
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return existsSync(path);
  } catch {
    return false;
  }
}

export function findHeimdall(): string {
  const explicit = process.env.HEIMDALL_BIN;
  if (explicit && isExecutable(explicit)) return explicit;

  const home = homedir();
  const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  const candidates = [
    ...pathDirs.map((dir) => join(dir, "heimdall")),
    join(home, ".local", "bin", "heimdall"),
    join(home, ".heimdall", "bin", "heimdall"),
    join(home, ".cargo", "bin", "heimdall"),
    "/usr/local/bin/heimdall",
    "/usr/bin/heimdall",
  ];
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }
  throw new HeimdallNotFoundError();
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`heimdall timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export interface DecompileOptions {
  rpcUrl?: string;
  outDir: string;
  includeSol?: boolean;
  timeoutMs?: number;
  perFunctionTimeoutMs?: number;
  hardfork?: string;
}

export interface DecompileResult {
  sol: string;
  abi: unknown[];
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Decompile a target (address / bytecode / file) into Solidity + ABI. */
export async function decompile(target: string, options: DecompileOptions): Promise<DecompileResult> {
  const bin = findHeimdall();
  const args = ["decompile", target, "-o", options.outDir, "-q", "--color", "never"];
  if (options.rpcUrl) args.push("-r", options.rpcUrl);
  if (options.includeSol !== false) args.push("--include-sol");
  if (options.perFunctionTimeoutMs) args.push("-t", String(options.perFunctionTimeoutMs));
  if (options.hardfork) args.push("-f", options.hardfork);

  log.step(`heimdall decompile ${target}`);
  const result = await run(bin, args, options.timeoutMs ?? 20 * 60_000);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-8).join("\n");
    throw new Error(`heimdall decompile failed (exit ${result.code})\n${detail}`);
  }

  const sol = (await readIfExists(join(options.outDir, "decompiled.sol"))) ?? "";
  const abiRaw = await readIfExists(join(options.outDir, "abi.json"));
  let abi: unknown[] = [];
  if (abiRaw) {
    try {
      const parsed = JSON.parse(abiRaw) as unknown;
      if (Array.isArray(parsed)) abi = parsed;
    } catch {
      log.warn("could not parse heimdall abi.json");
    }
  }
  return { sol, abi };
}

