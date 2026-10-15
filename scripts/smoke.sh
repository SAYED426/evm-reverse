#!/usr/bin/env bash
#
# End-to-end smoke test. Decompiles Wrapped Ether on Ethereum mainnet and checks
# that the output is sane.
#
#   scripts/smoke.sh
#
# Needs network access to an Ethereum RPC. Override with:
#   RPC=https://your-rpc scripts/smoke.sh
#
# Not run in CI (mainnet RPCs are rate-limited and flaky); run it locally.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC="${RPC:-https://ethereum-rpc.publicnode.com}"
OUT="${OUT:-$REPO_DIR/.test-out/smoke}"
WETH="0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok: $*"; }

echo "== prerequisites =="
command -v node >/dev/null 2>&1 || fail "node not found on PATH"
pass "node $(node --version)"
heimdall --version >/dev/null 2>&1 || fail "heimdall not found on PATH (see scripts/install-heimdall.sh)"
pass "$(heimdall --version 2>&1 | head -1)"

echo
echo "== decompile WETH =="
echo "  rpc: $RPC"
rm -rf "$OUT"
mkdir -p "$OUT"

META="$("$REPO_DIR/bin/evm-reverse" "$WETH" --rpc "$RPC" -o "$OUT" --json 2>/dev/null)" \
  || fail "cli exited non-zero"

echo "$META" | node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  const m = JSON.parse(raw);
  const checks = [
    ["resolved functions >= 10", m.resolvedFunctions >= 10],
    ["resolved events >= 4", m.resolvedEvents >= 4],
    ["chain is mainnet", m.chainId === 1],
    ["not treated as a proxy", m.proxy && m.proxy.isProxy === false],
  ];
  let bad = 0;
  for (const [label, ok] of checks) {
    console.log((ok ? "  ok: " : "  FAIL: ") + label);
    if (!ok) bad++;
  }
  process.exit(bad === 0 ? 0 : 1);
});
' || fail "metadata assertions failed"

echo
echo "== artifacts =="
[ -s "$OUT/decompiled.sol" ] || fail "decompiled.sol missing or empty"
pass "decompiled.sol ($(wc -c <"$OUT/decompiled.sol") bytes)"

[ -s "$OUT/abi.json" ] || fail "abi.json missing or empty"
node -e '
const abi = require(process.argv[1]);
if (!Array.isArray(abi)) throw new Error("abi is not an array");
if (abi.length < 5) throw new Error("abi has only " + abi.length + " entries");
' "$OUT/abi.json" >/dev/null || fail "abi.json is not a usable ABI array"
pass "abi.json parses"

grep -q "function transfer(" "$OUT/decompiled.sol" || fail "transfer() was not resolved"
pass "transfer() resolved by name"
grep -q "event Transfer(" "$OUT/decompiled.sol" || fail "Transfer event was not resolved"
pass "Transfer event resolved by name"

echo
echo "smoke test passed. output: $OUT"
