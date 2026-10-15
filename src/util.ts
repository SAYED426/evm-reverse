/** Small shared helpers: logging and hex/number utilities. */

const COLOR = process.env.NO_COLOR === undefined && process.stderr.isTTY === true;

function paint(code: string, text: string): string {
  return COLOR ? `\u001b[${code}m${text}\u001b[0m` : text;
}

/** Optional listener used by the web server to stream progress to a browser. */
export type LogSink = (line: string) => void;
let sink: LogSink | undefined;

export function setLogSink(fn?: LogSink): void {
  sink = fn;
}

function write(symbol: string, color: string, msg: string): void {
  process.stderr.write(`${paint(color, symbol)} ${msg}\n`);
  sink?.(`${symbol} ${msg}`);
}

export const log = {
  step(msg: string): void {
    write("›", "36", msg);
  },
  info(msg: string): void {
    process.stderr.write(`${paint("90", msg)}\n`);
    sink?.(msg);
  },
  ok(msg: string): void {
    write("✓", "32", msg);
  },
  warn(msg: string): void {
    write("!", "33", msg);
  },
  error(msg: string): void {
    write("✗", "31", msg);
  },
};

/** True for a 0x-prefixed 20-byte hex address. */
export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/** Interpret a 32-byte storage word as an address, or null when empty. */
export function wordToAddress(word: string): string | null {
  const hex = strip0x(word).padStart(64, "0");
  if (/^0+$/.test(hex)) return null;
  const addr = hex.slice(24);
  if (/^0+$/.test(addr)) return null;
  return `0x${addr}`;
}

/** First non-empty hex payload out of a nested string, useful for ABI-returned values. */
export function decodeAbiAddress(data: string): string | null {
  const hex = strip0x(data);
  if (hex.length < 64) return null;
  return wordToAddress(hex.slice(0, 64));
}

export function withTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}
