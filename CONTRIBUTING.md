# Contributing

Thanks for taking a look. This is a small tool, so the process is light.

## Setup

```bash
git clone <your-fork>
cd evm-reverse
npm install                 # only typescript + @types/node

scripts/install-heimdall.sh # the decompiler engine
```

Requires **Node >= 22.18** — the project runs TypeScript directly via native type
stripping, with no build step.

## Checks

```bash
npm run typecheck   # tsc --noEmit
npm test            # unit tests (node:test) — no network needed
scripts/smoke.sh    # end-to-end: decompiles WETH from mainnet (needs an RPC)
```

`npm test` must stay offline and deterministic. Anything that needs an RPC or a
model belongs in `scripts/smoke.sh` or a manual check.

## Layout

| Path | What lives there |
| --- | --- |
| `src/rpc.ts` | JSON-RPC client and public fallbacks |
| `src/proxy.ts` | Proxy detection and following |
| `src/bytecode.ts` | Address / bytecode normalisation |
| `src/heimdall.ts` | Spawns and parses the Heimdall binary |
| `src/selectors.ts` | Selector and event resolution, disk cache |
| `src/storage.ts` | Slot scanning |
| `src/llm.ts` | Ollama readability pass, chunking, safety guards |
| `src/emit.ts` | Name substitution, ABI, header, output assembly |
| `src/pipeline.ts` | Orchestration |
| `src/cli.ts` | CLI entrypoint |
| `src/server.ts` + `web/` | Local web UI |
| `plugins/evm-reverse/` | OpenCode tool |

## Ground rules

- **Correctness over completeness.** When in doubt, emit something honest and
  marked unresolved rather than guessing a name.
- **No runtime dependencies.** The tool deliberately depends on nothing but Node
  and the Heimdall binary. Please don't add a framework.
- **Match the surrounding style.** Two-space indent, explicit types on exported
  functions, comments that explain *why*.
- **The LLM pass must never silently change behaviour.** Any new prompt or
  transformation needs a corresponding guard in `src/llm.ts` and a test in
  `test/llm.test.ts`.

## Reporting issues

Include the address, the chain, the RPC you used, and the full stderr output.
Unresolved selectors and odd decompilations are expected — that's the nature of
the problem — but crashes and wrong proxy identification are real bugs.
