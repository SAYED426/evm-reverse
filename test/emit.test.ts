/**
 * Unit tests for output assembly. Pure functions only — no network, no Heimdall.
 *
 *   npm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyResolvedNames,
  buildHeader,
  composeSolidity,
  contractNameFrom,
  extractCode,
  type EmitMetadata,
} from "../src/emit.ts";
import type { ProxyInfo } from "../src/proxy.ts";
import type { ResolvedSignature } from "../src/selectors.ts";

const NO_PROXY: ProxyInfo = { isProxy: false, kind: "none" };

function metadata(overrides: Partial<EmitMetadata> = {}): EmitMetadata {
  return {
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    chainId: 1,
    blockNumber: 26_199_737,
    generatedAt: "2026-01-01T00:00:00.000Z",
    rpc: "https://example.invalid",
    proxy: NO_PROXY,
    targetKind: "address",
    resolvedFunctions: 11,
    unresolvedFunctions: 0,
    resolvedEvents: 4,
    unresolvedEvents: 0,
    ...overrides,
  };
}

test("contractNameFrom derives a stable label from the address", () => {
  assert.equal(contractNameFrom("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"), "Decompiled_C02aaA39");
});

test("extractCode drops Heimdall's banner but keeps the contract body", () => {
  const raw = [
    "// Heimdall output banner",
    "// more noise",
    "contract Foo {",
    "    uint256 a;",
    "}",
  ].join("\n");
  const code = extractCode(raw);
  assert.ok(code.startsWith("contract Foo {"));
  assert.ok(!code.includes("Heimdall output banner"));
});

test("extractCode strips NUL bytes", () => {
  assert.equal(extractCode("contract A {}\u0000"), "contract A {}");
});

test("composeSolidity emits SPDX + pragma + header + body", () => {
  const out = composeSolidity("contract Foo {}", "// HEADER");
  const lines = out.split("\n");
  assert.equal(lines[0], "// SPDX-License-Identifier: UNLICENSED");
  assert.equal(lines[1], "pragma solidity >=0.8.0;");
  assert.ok(out.includes("// HEADER"));
  assert.ok(out.trimEnd().endsWith("contract Foo {}"));
});

test("buildHeader reports resolution counts and proxy state", () => {
  const header = buildHeader(metadata(), "Decompiled_X");
  assert.ok(header.includes("// Resolved:          11 function(s), 4 event(s)"));
  assert.ok(header.includes("// Unresolved:        0 function(s), 0 event(s)"));
  assert.ok(header.includes("// Proxy:            no"));
  assert.ok(!header.includes("LLM readability pass"));
});

test("buildHeader notes the LLM pass only when it ran", () => {
  const header = buildHeader(metadata({ llm: { model: "qwen2.5:7b", notes: [] } }), "Decompiled_X");
  assert.ok(header.includes("LLM readability pass by qwen2.5:7b"));
});

test("buildHeader lists implementation and beacon for proxies", () => {
  const proxy: ProxyInfo = {
    isProxy: true,
    kind: "eip1967",
    implementation: "0x1111111111111111111111111111111111111111",
    beacon: "0x2222222222222222222222222222222222222222",
  };
  const header = buildHeader(metadata({ proxy }), "Decompiled_X");
  assert.ok(header.includes("// Proxy:            yes (eip1967)"));
  assert.ok(header.includes("0x1111111111111111111111111111111111111111"));
  assert.ok(header.includes("0x2222222222222222222222222222222222222222"));
});

test("applyResolvedNames replaces function placeholders and signatures", () => {
  const sol = [
    "    /// @custom:signature   Unresolved_a9059cbb(address,uint256) public returns (bool)",
    "    function Unresolved_a9059cbb(address arg0, uint256 arg1) public returns (bool) {",
  ].join("\n");

  const functions = new Map<string, ResolvedSignature>([
    [
      "0xa9059cbb",
      {
        selector: "0xa9059cbb",
        name: "transfer",
        signature: "transfer(address,uint256) public returns (bool)",
        source: "openchain",
      },
    ],
  ]);

  const out = applyResolvedNames(sol, functions, new Map());
  assert.ok(out.includes("function transfer(address arg0, uint256 arg1)"));
  assert.ok(out.includes("transfer(address,uint256) public returns (bool)"));
  assert.ok(!out.includes("Unresolved_a9059cbb"));
});

test("applyResolvedNames expands event declarations with their parameters", () => {
  const sol = "    event Event_ddf252ad();";
  const events = new Map<string, ResolvedSignature>([
    [
      "0xddf252ad",
      {
        selector: "0xddf252ad",
        name: "Transfer",
        signature: "Transfer(address,address,uint256)",
        source: "openchain",
      },
    ],
  ]);

  const out = applyResolvedNames(sol, new Map(), events);
  assert.equal(out.trim(), "event Transfer(address,address,uint256);");
});

test("applyResolvedNames leaves unresolved selectors untouched", () => {
  const sol = "function Unresolved_deadbeef() public {}";
  const out = applyResolvedNames(sol, new Map(), new Map());
  assert.equal(out, sol);
});
