<!--
  Replace OWNER/REPO with your GitHub path before publishing (badges + links).
-->

# evm-reverse

**Turn an unverified smart contract address into readable Solidity.**

[![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >= 22.18](https://img.shields.io/badge/node-%3E%3D%2022.18-brightgreen.svg)](https://nodejs.org)

You cannot recover a contract's original source — it is not on-chain. What you
*can* do is reconstruct an approximation of it from the bytecode. That is what
this does: point it at an address, get back Solidity you can actually read, with
real function and event names resolved from public signature databases.

```console
$ ./bin/evm-reverse 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 -o out/weth
› fetching bytecode for 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
bytecode size: 3124 bytes
› heimdall decompile 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
› resolving 11 function selector(s)
resolved events: 4/4
✓ wrote out/weth/decompiled.sol
✓ wrote out/weth/abi.json
✓ wrote out/weth/metadata.json
```

```solidity
/// @custom:selector    0xa9059cbb
function transfer(address recipient, uint256 amount) public returns (bool) {
    address sender = msg.sender;
    require(!storage_map_c[sender] < amount);
    storage_map_c[sender] = storage_map_c[sender] - amount;
    storage_map_c[recipient] = storage_map_c[recipient] + amount;
    emit Transfer(sender, recipient, amount);
    return true;
}
```

---

## Contents

- [What it is (and isn't)](#what-it-is-and-isnt)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [Output](#output)
- [Local web UI](#local-web-ui)
- [LLM readability pass](#llm-readability-pass)
- [OpenCode tool](#opencode-tool)
- [How it works](#how-it-works)
- [Proxy support](#proxy-support)
- [Verified results](#verified-results)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## What it is (and isn't)

| ✅ It does | ❌ It doesn't |
| --- | --- |
| Follow proxies (EIP-1967, beacon, UUPS, ZeppelinOS, EIP-1167) to the real logic | Recover original variable or function names |
| Reconstruct control flow with symbolic execution | Recover original comments, docs, or custom errors |
| Resolve function selectors and event topics by name | Produce byte-identical or compilable-equal source |
| Emit an ABI, metadata, and an optional storage scan | Read values behind mappings or dynamic arrays |

Everything it emits is **a map of the contract, not a reproduction of it**. The
generated header says so too.

## Quick start

**Requirements**

- **Node.js >= 22.18** — the project runs TypeScript directly via native type
  stripping. There is no build step.
- **[Heimdall](https://github.com/Jon-Becker/heimdall-rs)** — the decompiler
  engine. `scripts/install-heimdall.sh` fetches a prebuilt Linux x86_64 binary;
  elsewhere, build it from source.
- **[Ollama](https://ollama.com)** — optional, only for the `--llm` pass.

```bash
git clone https://github.com/OWNER/REPO.git
cd REPO

npm install                    # typescript + @types/node, nothing else

scripts/install-heimdall.sh    # or place `heimdall` on your PATH yourself

# no RPC flag? public endpoints are used, but they are rate-limited.
export ETH_RPC_URL=https://ethereum-rpc.publicnode.com

./bin/evm-reverse 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 -o out/weth
```

Prefer not to clone? The only runtime dependency is the Heimdall binary; `src/`
is plain Node.

## CLI reference

```
./bin/evm-reverse <address|bytecode> [options]
```

| Option | Description |
| --- | --- |
| `-r, --rpc <url>` | Ethereum RPC endpoint. Also `ETH_RPC_URL`. Public fallbacks are used if omitted. |
| `-o, --out <dir>` | Output directory. Default `./reversed/<address>`. |
| `--no-sol` | ABI only; skip the Solidity body. |
| `--storage` | Scan storage slots into `storage.json` (standard `eth_getStorageAt`). |
| `--slots <n>` | How many slots to scan with `--storage`. Default 64. |
| `--include-proxy` | Also decompile the proxy shell itself, into `proxy/`. |
| `--llm` | Run the Ollama readability pass. |
| `--llm-model <m>` | Model for the pass. Default `qwen2.5:7b`. |
| `--llm-url <url>` | Ollama base URL. Default `http://127.0.0.1:11434`. |
| `--llm-key <key>` | Bearer token for an authenticated endpoint. Default `$EVM_REVERSE_OLLAMA_API_KEY`. |
| `--timeout <sec>` | Overall decompile timeout. Default 1200. |
| `--per-function <ms>` | Per-function symbolic-execution timeout. Lower it for large contracts. |
| `--hardfork <name>` | Hardfork for opcode recognition. Default `latest`. |
| `--print` | Print the Solidity to stdout. |
| `--json` | Print run metadata as JSON (includes the full `solidity` string). |

**Examples**

```bash
# A plain contract
./bin/evm-reverse 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 -o out/weth

# Behind a proxy: follows USDC's ZeppelinOS proxy to its implementation
./bin/evm-reverse 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 -o out/usdc --per-function 15000

# Decompile from raw bytecode instead of an address
./bin/evm-reverse 0x6080604052... -o out/raw

# Big contract, tight budget, plus a readability pass
./bin/evm-reverse 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2 \
  -o out/aave --per-function 20000 --storage --llm
```

## Output

```
<out>/
├── decompiled.sol   # Solidity with resolved names and an honest header
├── abi.json         # ABI with resolved function and event names
├── metadata.json    # address, chain, block, proxy info, resolution counts
├── storage.json     # only with --storage
└── proxy/           # only with --include-proxy: the proxy shell itself
```

`decompiled.sol` opens with a header recording exactly what was done:

```solidity
//  DECOMPILED CONTRACT — NOT ORIGINAL SOURCE
//
// Contract:          Decompiled_C02aaA39
// Address:           0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
// Chain ID:          1
// Block:             26199737
// Generated:         2026-01-01T00:00:00.000Z
// Proxy:            no
// RPC:               https://ethereum-rpc.publicnode.com
//
// Resolved:          11 function(s), 4 event(s)
// Unresolved:        0 function(s), 0 event(s)
```

`metadata.json` is the machine-readable version of the same facts, plus
`targetKind` (`address`, `implementation`, `proxy`, or `raw`).

## Local web UI

```bash
npm run serve        # http://127.0.0.1:8787
```

A dependency-free Node server (`src/server.ts`) serving `web/`. Paste an address,
choose options, watch progress stream in, then read the result across three tabs
— Solidity, ABI, Metadata — with syntax highlighting and copy/download buttons.

| Endpoint | Purpose |
| --- | --- |
| `GET /` | The UI |
| `GET /api/health?url=&key=` | Heimdall and LLM endpoint status, plus available models |
| `POST /api/reverse` | Runs the pipeline, streaming progress as NDJSON |

Jobs are serialized because the progress log sink is global — runs do not
interleave. Bind elsewhere with `HOST` / `PORT`:

```bash
HOST=0.0.0.0 PORT=8080 npm run serve
```

## LLM readability pass

Heimdall's output is faithful but machine-flavoured: `var_a`, `arg0`,
`storage_map_c`. `--llm` sends the body through an Ollama model to rename
identifiers and add comments.

```bash
# Local model
./bin/evm-reverse 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 -o out/ --llm

# Any Ollama-compatible endpoint, with a bearer token
./bin/evm-reverse 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 -o out/ --llm \
  --llm-url https://ollama.com --llm-key "$OLLAMA_API_KEY" --llm-model gpt-oss:120b
```

Or set it once in the environment — the CLI, web UI default, and OpenCode tool all
pick these up:

```bash
export EVM_REVERSE_OLLAMA_URL=http://127.0.0.1:11434
export EVM_REVERSE_OLLAMA_API_KEY=            # blank for local
export EVM_REVERSE_LLM_MODEL=qwen2.5:7b
```

The web UI also has **Ollama API URL** and **API key** fields, with a `↻` button
to re-query the endpoint and repopulate the model list.

### Why you can trust it

A generative pass that quietly changes behaviour would be worse than useless, so:

- **Chunking.** Bodies over 6000 chars are split at top-level function boundaries
  and cleaned one block at a time, with declarations supplied as context.
  Requests ask for a 16k context window.
- **Contract name restored** if the model renames it.
- **Invented revert strings stripped.** Heimdall drops revert messages, so any
  `require(x, "msg")` the model adds would change deployed behaviour. These are
  removed surgically (paren-aware), not by discarding the whole block.
- **Validation.** Blocks that come back malformed, truncated, or with *more*
  revert strings than the original are rejected and the original text is kept.
- **Labelled output.** The header records the model and points at the raw
  decompilation as the faithful reference.

`src/llm.ts` is the whole story, and `test/llm.test.ts` covers the guards.

> **Treat `--llm` output as a readability aid.** Comments can be plausible and
> wrong. For analysis, trust the run without `--llm`.

## OpenCode tool

`plugins/evm-reverse/` registers an `evm.reverse_contract` tool. OpenCode
typically runs on the host while the CLI and Heimdall live in WSL, so on Windows
the plugin shells out through `wsl bash`; the WSL home is discovered
automatically and can be overridden.

```bash
scripts/install-plugin.sh
# then restart OpenCode
```

| Input | Description |
| --- | --- |
| `address` | 0x address or raw bytecode (required) |
| `rpcUrl`, `outDir`, `storage`, `perFunctionMs`, `hardfork` | Same meaning as the CLI |
| `llm`, `llmModel`, `llmUrl`, `llmApiKey` | Same meaning as the CLI |

Environment overrides: `EVM_REVERSE_WSL_HOME`, `EVM_REVERSE_CLI`,
`EVM_REVERSE_OUTDIR`, `EVM_REVERSE_OPENCODE_DIR`.

## How it works

```
 address
    │
    ▼
┌──────────┐   eth_getCode, eth_chainId, eth_blockNumber
│  bytecode │──────────────────────────────────────────────▶ src/rpc.ts
└──────────┘
    │
    ▼
┌──────────┐   EIP-1967 / beacon / UUPS / ZeppelinOS / EIP-1167
│  proxy?   │──────────────────────────────────────────────▶ src/proxy.ts
└──────────┘   follow to the implementation
    │
    ▼
┌──────────┐   symbolic execution (external binary)
│ Heimdall  │──────────────────────────────────────────────▶ src/heimdall.ts
└──────────┘
    │  raw Solidity, placeholder names
    ▼
┌──────────┐   OpenChain batch + 4byte fallback, disk-cached
│ selectors │──────────────────────────────────────────────▶ src/selectors.ts
└──────────┘   event topic0 recovered from PUSH32 constants
    │
    ├─────────▶ storage scan (eth_getStorageAt) ───────────▶ src/storage.ts
    │
    ▼
┌──────────┐   name substitution, ABI, header
│   emit    │──────────────────────────────────────────────▶ src/emit.ts
└──────────┘
    │
    ├──▶ [optional] Ollama readability pass ───────────────▶ src/llm.ts
    │
    ▼
 decompiled.sol · abi.json · metadata.json
```

The pipeline itself is `src/pipeline.ts`; the CLI and web server are thin
shells around it.

Notable details:

- **Event resolution.** Heimdall emits `Event_ddf252ad()` with no parameters,
  and only the first 4 bytes of the topic are known. The full 32-byte topic0 is
  recovered by scanning `PUSH32` constants in the implementation's bytecode, which
  makes the lookup hit far more often.
- **Selector cache.** Resolved signatures are cached at
  `~/.cache/evm-reverse/signatures.json`, so repeat runs are fast offline.
- **Storage.** Standard `eth_getStorageAt` over fixed low slots. Heimdall's own
  dump needs `trace_replayBlockTransactions`, which ordinary RPC endpoints refuse.

## Proxy support

| Pattern | Detected via |
| --- | --- |
| EIP-1967 | implementation slot, plus the beacon slot |
| EIP-1967 beacon | beacon slot, then `implementation()` on the beacon |
| EIP-1822 / UUPS | proxiable slot |
| ZeppelinOS | implementation + admin slots |
| EIP-1167 minimal proxy | bytecode pattern match |
| EIP-897 / bare `implementation()` | static call (`5c60da1b`) |

## Verified results

| Contract | Address | Result |
| --- | --- | --- |
| Wrapped Ether | `0xC02aaA39…6Cc2` | 11/11 functions, 4/4 events; storage `0x0 = "Wrapped Ether"`, `0x2 = 18` |
| USDC (ZeppelinOS proxy) | `0xA0b86991…eB48` | follows to the implementation, 57/57 functions, 17/17 events |
| Aave V3 Pool (EIP-1967) | `0x87870Bca…A4E2` | follows to `0x728a138a…03cf` correctly |

Error paths are checked too: an EOA yields `has no bytecode`, an unknown flag
exits 1, and a malformed address in the web API returns 400.

## Limitations

- **Reconstruction, not source.** Names, comments, custom errors, and exact
  syntax are gone. `pragma solidity >=0.8.0` is cosmetic — the decompiler targets
  the EVM, not a compiler version.
- **Storage is shallow.** Only fixed low slots. Mapping and dynamic-array values
  sit at `keccak`-derived slots and are not enumerated. A full dump needs
  `trace_replayBlockTransactions`, which public RPCs do not expose.
- **Selector coverage is bounded** by public databases. Obscure or deliberately
  obfuscated selectors stay `Unresolved_*`.
- **Speed.** Symbolic execution is per function; large contracts take minutes.
  Use `--per-function` to bound it. The `--llm` pass on a CPU-bound 7B model runs
  roughly 20–60s per function block.
- **RPC quality matters.** Public endpoints rate-limit, and a few
  (`cloudflare-eth.com`, `rpc.ankr.com/eth`) return empty bytecode for some
  contracts. Use a keyed endpoint for anything serious.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `heimdall: command not found` | `scripts/install-heimdall.sh`, or put `heimdall` on `PATH`. |
| `has no bytecode` | The address is an EOA, self-destructed, or the RPC lied. Try another RPC. |
| Empty or truncated output | Raise `--per-function`, and/or pass a keyed RPC. |
| `ollama ✗` in the web UI | Start Ollama (`ollama serve`), or set the URL/key in the LLM panel. |
| `this model is not included in your free usage` | The model is cloud-routed and needs credits. Pick a local model. |
| Everything is `Unresolved_*` | No network to the signature databases, or genuinely obscure selectors. |

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # unit tests, offline and deterministic
scripts/smoke.sh    # end-to-end against mainnet (needs an RPC)
```

There is no build step and no runtime dependency; Node strips the types. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the layout and ground rules.

## License

[MIT](LICENSE).
