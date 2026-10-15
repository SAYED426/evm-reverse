/**
 * Storage inspection.
 *
 * A full storage dump needs tracing (`trace_replayBlockTransactions`), which
 * ordinary RPC endpoints do not expose. Instead we scan the low, fixed slot
 * range with the standard `eth_getStorageAt`, which works on any endpoint and
 * exposes most hand-declared state variables (the ones that are not inside
 * mappings or dynamic arrays).
 */

import {
  SLOT_EIP1967_ADMIN,
  SLOT_EIP1967_BEACON,
  SLOT_EIP1967_IMPL,
  SLOT_EIP1822_PROXIABLE,
  SLOT_ZOS_ADMIN,
  SLOT_ZOS_IMPL,
} from "./proxy.ts";
import type { Rpc } from "./rpc.ts";
import { strip0x } from "./util.ts";

/** Known storage slots we can label by name. */
const KNOWN_SLOTS: Record<string, string> = {
  [SLOT_EIP1967_IMPL]: "eip1967.implementation",
  [SLOT_EIP1967_BEACON]: "eip1967.beacon",
  [SLOT_EIP1967_ADMIN]: "eip1967.admin",
  [SLOT_EIP1822_PROXIABLE]: "eip1822.proxiable",
  [SLOT_ZOS_IMPL]: "zeppelinos.implementation",
  [SLOT_ZOS_ADMIN]: "zeppelinos.admin",
};

export interface StorageScan {
  /** Slot index (hex) -> raw 32-byte word, for non-zero slots 0..count-1. */
  slots: Record<string, string>;
  /** Known proxy slots that are non-zero, keyed by label. */
  labeled: Record<string, string>;
  scanned: number;
}

function isEmptyWord(word: string | null): boolean {
  return !word || /^0+$/.test(strip0x(word));
}

/**
 * Read slots `0..count-1` plus the known proxy slots. Bounded and batched so it
 * stays fast and within rate limits.
 */
export async function scanStorage(rpc: Rpc, address: string, count = 64): Promise<StorageScan> {
  const slots: Record<string, string> = {};
  const batchSize = 16;
  const indices = Array.from({ length: count }, (_, i) => i);

  for (let i = 0; i < indices.length; i += batchSize) {
    const batch = indices.slice(i, i + batchSize);
    const words = await Promise.all(
      batch.map((index) => rpc.getStorageAt(address, `0x${index.toString(16)}`).catch(() => null)),
    );
    words.forEach((word, offset) => {
      if (isEmptyWord(word)) return;
      const index = batch[offset]!;
      slots[`0x${index.toString(16)}`] = word!;
    });
  }

  const labeled: Record<string, string> = {};
  const labels = Object.keys(KNOWN_SLOTS);
  const knownWords = await Promise.all(labels.map((slot) => rpc.getStorageAt(address, slot).catch(() => null)));
  knownWords.forEach((word, offset) => {
    if (isEmptyWord(word)) return;
    labeled[KNOWN_SLOTS[labels[offset]!]!] = word!;
  });

  return { slots, labeled, scanned: count };
}
