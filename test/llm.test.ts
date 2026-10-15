/**
 * Unit tests for the LLM pass's safety guards. Pure functions only — no model,
 * no network. The guards are the reason the readability pass can be trusted not
 * to change deployed behaviour.
 *
 *   npm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { apiKey, baseUrl, modelName, revertStringCount, stripRevertMessages } from "../src/llm.ts";

test("stripRevertMessages removes an invented message from require", () => {
  assert.equal(
    stripRevertMessages('require(balance >= amount, "Insufficient balance");'),
    "require(balance >= amount);",
  );
});

test("stripRevertMessages handles single quotes and assert", () => {
  assert.equal(stripRevertMessages("assert(ok, 'nope');"), "assert(ok);");
});

test("stripRevertMessages leaves a bare require untouched", () => {
  const sol = "require(a >= b);";
  assert.equal(stripRevertMessages(sol), sol);
});

test("stripRevertMessages does not touch non-string second arguments", () => {
  const sol = "require(f(a, b) == 1);";
  assert.equal(stripRevertMessages(sol), sol);
});

test("stripRevertMessages tolerates nested calls in the condition", () => {
  assert.equal(
    stripRevertMessages('require(keccak256(abi.encodePacked(a, b)) == c, "bad");'),
    "require(keccak256(abi.encodePacked(a, b)) == c);",
  );
});

test("stripRevertMessages leaves multiple requires independently repaired", () => {
  const input = ['require(a, "one");', 'require(b, "two");'].join("\n");
  assert.equal(stripRevertMessages(input), ["require(a);", "require(b);"].join("\n"));
});

test("revertStringCount counts only message-carrying calls", () => {
  assert.equal(revertStringCount("require(a);"), 0);
  assert.equal(revertStringCount('require(a, "x");'), 1);
  assert.equal(revertStringCount('require(a, "x"); assert(b);'), 1);
});

test("baseUrl prefers explicit option, then env, then localhost default", () => {
  const previous = process.env.EVM_REVERSE_OLLAMA_URL;
  try {
    delete process.env.EVM_REVERSE_OLLAMA_URL;
    assert.equal(baseUrl(), "http://127.0.0.1:11434");
    assert.equal(baseUrl({ baseUrl: "https://ollama.com" }), "https://ollama.com");

    process.env.EVM_REVERSE_OLLAMA_URL = "http://192.168.1.5:11434";
    assert.equal(baseUrl(), "http://192.168.1.5:11434");
    assert.equal(baseUrl({ baseUrl: "https://ollama.com" }), "https://ollama.com");
  } finally {
    if (previous === undefined) delete process.env.EVM_REVERSE_OLLAMA_URL;
    else process.env.EVM_REVERSE_OLLAMA_URL = previous;
  }
});

test("apiKey returns undefined when unset or empty", () => {
  const previous = process.env.EVM_REVERSE_OLLAMA_API_KEY;
  try {
    delete process.env.EVM_REVERSE_OLLAMA_API_KEY;
    assert.equal(apiKey(), undefined);
    assert.equal(apiKey({ apiKey: "" }), undefined);
    assert.equal(apiKey({ apiKey: "  " }), "  ");
    assert.equal(apiKey({ apiKey: "explicit" }), "explicit");

    process.env.EVM_REVERSE_OLLAMA_API_KEY = "from-env";
    assert.equal(apiKey(), "from-env");
    assert.equal(apiKey({ apiKey: "explicit" }), "explicit");
  } finally {
    if (previous === undefined) delete process.env.EVM_REVERSE_OLLAMA_API_KEY;
    else process.env.EVM_REVERSE_OLLAMA_API_KEY = previous;
  }
});

test("modelName prefers the explicit option", () => {
  assert.equal(modelName({ model: "llama3:8b" }), "llama3:8b");
  assert.equal(typeof modelName(), "string");
});
