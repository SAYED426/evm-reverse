/** Bytecode scanning helpers used to recover selectors and event topics. */

import { strip0x } from "./util.ts";

const OP_PUSH1 = 0x60;
const OP_PUSH32 = 0x7f;

/**
 * Walk the bytecode and yield every PUSH-prefixed constant, correctly skipping
 * over the data bytes so we never mistake pushed data for opcodes.
 */
function* pushConstants(code: string): Generator<{ opcode: number; size: number; value: string }> {
  const hex = strip0x(code).toLowerCase();
  let i = 0;
  while (i + 2 <= hex.length) {
    const opcode = Number.parseInt(hex.slice(i, i + 2), 16);
    i += 2;
    if (opcode >= OP_PUSH1 && opcode <= OP_PUSH32) {
      const size = opcode - OP_PUSH1 + 1;
      const value = hex.slice(i, i + size * 2);
      i += size * 2;
      yield { opcode, size, value };
    }
  }
}

/** All distinct 32-byte constants pushed in the bytecode (candidate event topics). */
export function extractPush32(code: string): string[] {
  const seen = new Set<string>();
  for (const push of pushConstants(code)) {
    if (push.size === 32 && push.value.length === 64) seen.add(`0x${push.value}`);
  }
  return [...seen];
}

/** All distinct 4-byte constants pushed in the bytecode (candidate selectors). */
export function extractPush4(code: string): string[] {
  const seen = new Set<string>();
  for (const push of pushConstants(code)) {
    if (push.size === 4 && push.value.length === 8) seen.add(`0x${push.value}`);
  }
  return [...seen];
}
