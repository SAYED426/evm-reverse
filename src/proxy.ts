/**
 * Proxy detection.
 *
 * Most on-chain logic sits behind a proxy, so decompiling the address the user
 * gave us often yields an empty shell. We look for the standard storage slots
 * and bytecode patterns and, when we find one, resolve the implementation so
 * the pipeline can decompile the code that actually matters.
 */

import type { Rpc } from "./rpc.ts";
import { log, strip0x, wordToAddress, decodeAbiAddress } from "./util.ts";

// keccak256("eip1967.proxy.implementation") - 1
export const SLOT_EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
// keccak256("eip1967.proxy.beacon") - 1
export const SLOT_EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
// keccak256("eip1967.proxy.admin") - 1
export const SLOT_EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
// keccak256("PROXIABLE") - EIP-1822 / early UUPS
export const SLOT_EIP1822_PROXIABLE = "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876ffce22873";
// keccak256("org.zeppelinos.proxy.implementation") - older OpenZeppelin proxy (e.g. USDC)
export const SLOT_ZOS_IMPL = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
// keccak256("org.zeppelinos.proxy.admin")
export const SLOT_ZOS_ADMIN = "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b";

// implementation()
const SIG_IMPLEMENTATION = "0x5c60da1b";

export interface ProxyInfo {
  isProxy: boolean;
  /** "eip1967" | "eip1967-beacon" | "eip1822" | "zeppelinos" | "eip1167" | "eip897" | "none" */
  kind: string;
  implementation?: string;
  beacon?: string;
  admin?: string;
}

function extractMinimalProxyTarget(code: string): string | null {
  // EIP-1167: 363d3d373d3d3d363d73<20-byte target>5af43d82803e903d91602b57fd5bf3
  const hex = strip0x(code).toLowerCase();
  const marker = "363d3d373d3d3d363d73";
  const at = hex.indexOf(marker);
  if (at === -1) return null;
  const target = hex.slice(at + marker.length, at + marker.length + 40);
  if (target.length !== 40) return null;
  return `0x${target}`;
}

async function readImplementationViaBeacon(rpc: Rpc, beacon: string): Promise<string | null> {
  try {
    const data = await rpc.call0(beacon, SIG_IMPLEMENTATION);
    return decodeAbiAddress(data);
  } catch {
    return null;
  }
}

async function tryEthCallImplementation(rpc: Rpc, address: string): Promise<string | null> {
  try {
    const data = await rpc.call0(address, SIG_IMPLEMENTATION);
    return decodeAbiAddress(data);
  } catch {
    return null;
  }
}

/** Inspect a contract for known proxy patterns and resolve its implementation. */
export async function detectProxy(address: string, code: string, rpc: Rpc): Promise<ProxyInfo> {
  const minimal = extractMinimalProxyTarget(code);
  if (minimal) {
    return { isProxy: true, kind: "eip1167", implementation: minimal };
  }

  const [implWord, beaconWord, adminWord, uupsWord, zosWord, zosAdminWord] = await Promise.all([
    rpc.getStorageAt(address, SLOT_EIP1967_IMPL).catch(() => null),
    rpc.getStorageAt(address, SLOT_EIP1967_BEACON).catch(() => null),
    rpc.getStorageAt(address, SLOT_EIP1967_ADMIN).catch(() => null),
    rpc.getStorageAt(address, SLOT_EIP1822_PROXIABLE).catch(() => null),
    rpc.getStorageAt(address, SLOT_ZOS_IMPL).catch(() => null),
    rpc.getStorageAt(address, SLOT_ZOS_ADMIN).catch(() => null),
  ]);

  const admin = adminWord ? wordToAddress(adminWord) : null;
  const zosAdmin = zosAdminWord ? wordToAddress(zosAdminWord) : null;

  const zosImpl = zosWord ? wordToAddress(zosWord) : null;
  if (zosImpl) {
    return { isProxy: true, kind: "zeppelinos", implementation: zosImpl, admin: zosAdmin ?? undefined };
  }

  const eip1967Impl = implWord ? wordToAddress(implWord) : null;
  if (eip1967Impl) {
    return { isProxy: true, kind: "eip1967", implementation: eip1967Impl, admin: admin ?? undefined };
  }

  const beacon = beaconWord ? wordToAddress(beaconWord) : null;
  if (beacon) {
    const impl = await readImplementationViaBeacon(rpc, beacon);
    return {
      isProxy: true,
      kind: "eip1967-beacon",
      beacon,
      implementation: impl ?? undefined,
      admin: admin ?? undefined,
    };
  }

  const uups = uupsWord ? wordToAddress(uupsWord) : null;
  if (uups) {
    return { isProxy: true, kind: "eip1822", implementation: uups, admin: admin ?? undefined };
  }

  // Last resort: a bare `implementation()` view.
  const viaCall = await tryEthCallImplementation(rpc, address);
  if (viaCall) {
    return { isProxy: true, kind: "eip897", implementation: viaCall, admin: admin ?? undefined };
  }

  if (admin) {
    log.warn(`address has an EIP-1967 admin at ${admin} but no implementation slot`);
  }

  return { isProxy: false, kind: "none" };
}
