# Feature: model-usage-ledger

Per-model-call usage ledger written by the gentle-dot daemon, modeled on the
pi-claude-bridge logging pattern the user uses in Gentle Shell.

## Specs

- S1: "Implementar loggeo de llamadas" — registro por llamada (modelo, tokens, latencia) en el daemon + vista en la UI. (User selected this option for gentle-dot on 2026-11-09.)
- S2: "recuerda que en gentle shell estamos usando nan por un bridge" — NaN is consumed via a bridge in Gentle Shell; the ledger must work with bridge-proxied calls (provider/model as reported by the engine message).
- S3: "mira como hicimos con el bridge de claude bridge en pi, para que sea algo similar" — the implementation must mirror the @vanillagreen/pi-claude-bridge logging approach (file format, fields, user-facing surfacing) wherever it applies to a daemon-side ledger.

## Design (final, T1 closed 2026-11-09)

- Ledger record fields: `ts, sessionId, provider, model, thinkingLevel, input, output, cacheRead, cacheWrite, totalTokens, cost, durationMs, stopReason, errorMessage?` — claude-bridge's per-call fields (in/out/cacheRead/cacheWrite/total/model, assistant-stream.ts:27-31) plus duration/thinking/session/cost it lacks.
- Format: JSONL at `<dataDir>/usage/model-calls.jsonl` (bridge precedent: structured diag entries as JSON lines, debug.ts:146-152). NOT under `sessions/`.
- Hardening: 0600 file / 0700 dir with permission repair (debug.ts:26-38); atomic temp+rename and lock per pi-quota-status storage.ts pattern; size rotation 5 MB -> `.old` (bridge has NO rotation — deliberate improvement).
- Always on; disabled only via env `GENTLE_DOT_USAGE_LEDGER=0`.
- Duration measured daemon-side message_start->message_end with duplicate-start guard.
- Surfacing: `usage_list`/`usage` protocol + UsagePanel (equivalent of a /usage dump, which the bridge lacks); snapshot pushed on connect like context_usage.

## Tasks

- T1 [S3] Finalize design after pi-claude-bridge pattern report (fields, file format, surfacing). — inline
- T2 [S1] `src/usage-ledger.ts`: append per-call records (provider, model, thinking, tokens in/out/cache, cost, duration, sessionId, timestamp), rotation/size cap, 0600. Route: worker. Commit: yes.
- T3 [S1,S2] Wire ledger into bridge `onMessageStart`/`onMessageEnd` (duration, dedup guard). Route: worker. Commit: yes.
- T4 [S1] Protocol: `usage_list`/`usage` messages + validators. Route: worker. Commit: yes.
- T5 [S1] `usagePayload()` in bridge; push snapshot on connect (pattern: context_usage). Route: worker. Commit: yes.
- T6 [S1] UI `UsagePanel.tsx` + store slice + header entry point. Route: worker. Commit: yes.
- T7 [S1] Fixture: fake-agent `usage` on assistant messages + `get_session_stats`; tests `usage-ledger.test.ts` + gateway `usage_list`. Route: worker. Commit: yes.
- T8 [S1] Verify: full `pnpm test`, spec-by-spec verdict. Route: inline/verify.

## Log

- L1: User asked (2026-11-09): "revisa y explora como usar el gentle:profile nan_balanced pi en gentle dot y que sea seleccionable los modelos nan y su loggeo y autenticacion de las app gentle dot". Exploration done; user chose "Implementar loggeo de llamadas".
- L2: User: "recuerda que en gentle shell estamos usando nan por un bridge".
- L3: User: "mira como hicimos con el bridge de claude bridge en pi, para que sea algo similar".
- L4: Implemented 2026-11-09. Commits: b53c873 (protocol), a2cdc82 (UsageLedger), 2848441 (bridge wiring + fixture + gateway tests), 31c2139 (UsagePanel UI), b8df1cf (pre-existing TS2532 fix). Verification: full vitest run 1045 passed (91 files), daemon 666, ui 288; tsc clean for protocol/daemon/ui.
