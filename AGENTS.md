# Repository guide for coding agents

Start with [README.md](README.md), [docs/README.md](docs/README.md), and the document matching the change. Read [CONTRIBUTING.md](CONTRIBUTING.md) before editing.

## Boundaries

- Work only on the requested task. Preserve unrelated changes; do not reset or overwrite a contributor's work.
- Do not add remotes, push, publish packages, upload artifacts or deploy without explicit authorisation. Local checks and packaging do not authorise publication.
- Use synthetic fixtures. Never copy credentials, agent settings, transcripts, user caches, identifying paths or screenshots of private work into this repository.
- Keep observations, classification, requests and verified outcomes distinct. Tool counts, paths, tokens and line counts do not prove quality, completion or compliance.
- Native workspace trust, hook trust and organisation policy remain authoritative. Do not bypass them.

## Implementation

- Keep collection local, bounded and fail-open. Add no daemon, model call, network service or runtime dependency without an explicit design decision.
- Preserve exact agent/session/subagent routing, request expiry and at-most-once delivery.
- Category IDs and descriptions live in `src/focus-areas.json`; the classification vocabulary, stakes packs and sensitive-change rules live in `src/taxonomy.json`; the custom-area standard lives in `src/profile.js` and `docs/CUSTOM-AREAS.md`; resource limits live in `src/store.js`. Vocabulary changes need positive and negative cases in `test/focus-corpus.js`. Update relevant documentation when contracts change.
- Format with `npm run format`. Run `npm run check`, `npm test` and `npm run format:check`; run renderer tests for interface changes and package checks for distribution changes.
- Record native-host and platform gaps rather than converting fixture results into support claims.

## Resource lifecycle

Reuse existing services when appropriate. Use one automation browser and one expensive verification workload at a time. Close browsers and task-owned processes on success, error and timeout. Hidden views must not retain active timers or cache watchers. Preserve unrelated editor, agent, database and application processes.
