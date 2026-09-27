# Focus scoring

A focus score shows **how much observed work a chat has put into an area**. It builds up as the chat inspects, changes and checks work in that area, it is kept while the chat is idle or old, and it shifts only slowly as the chat moves on to other work. It is a local, deterministic heuristic, not a measurement of model reasoning, elapsed labour, completion, correctness or productivity. The UI shows a score out of 100 and a separate subject count. More subjects means wider observed work, not a higher score or more complete task coverage. In All chats, a tile shows the strongest individual score; adding identical agents cannot raise it.

No model, embedding, network service or transcript reading is involved. Classification is a table lookup over tool names, workspace paths and recognised commands; scoring is arithmetic over a few kept totals per area.

## What is observed

Only completed tool calls enter scoring. Each call becomes one or more **observations**: an action, a subject, and the areas it relates to with a confidence and a short reason.

| Action                                    | Examples                                                                   | Weight |
| ----------------------------------------- | -------------------------------------------------------------------------- | -----: |
| Inspected                                 | Read, Grep, Glob, `cat`, `rg`, `git diff`, Cursor `read_file`              |      1 |
| Changed                                   | Edit, Write, apply_patch, NotebookEdit, `sed -i`, `mv`, heredoc writes     |      2 |
| Check run or Check failed                 | recognised test, static, benchmark, security, build, accessibility or docs |      2 |
| Command run, Tool used                    | other commands and tools                                                   |    0.5 |
| Tool failed (not a recognised check)      | failed edits, reads and commands                                           |    0.5 |
| Planned, coordination, prompts, lifecycle | plans, subagent launches, questions, output polling, session events        |      0 |

**Shell commands** are read segment by segment by [`src/shell.js`](../src/shell.js). `cd web && npm test 2>&1 | tail -40` is one test run in `web`; `npm test && cat src/a.ts` is a test run plus a separate read, so the check is never attributed to the unrelated file. The reader unwraps `bash -lc`, `timeout`, `env`, `npx`, `uv run`, `bundle exec` and similar wrappers, follows `cd`, `git -C` and runner working-directory flags, skips heredoc bodies and output filters after a pipe, and treats a redirection as a write only for commands that emit text into it. Checks are recognised across package-manager scripts (`npm run test:unit`, `pnpm --filter web lint`), task runners (Make, Just, Gradle, Maven, Nx, Turbo, Bazel) and direct tools (pytest, cargo, go, dotnet, tsc, eslint, ruff, semgrep, npm audit, hyperfine, k6, Lighthouse, pa11y and others). Quoted text is used only when it is a single path-like word; inline scripts (`python -c`, `node -e`) are never parsed.

A **check that reports failure** (non-zero exit or a failure hook) is still observed attention to what it checks: it is recorded as _Check failed_, earns check weight and shows “checks reported failures”. A failed edit, read or unrecognised command earns no area credit.

## Areas and confidence

[`src/taxonomy.json`](../src/taxonomy.json) holds the vocabulary: nine work contexts (such as interface, data, infrastructure) and sixteen concerns (such as security, testing, documentation), each with weighted terms, phrases, known file names, extensions and a few path patterns. [`src/focus-areas.json`](../src/focus-areas.json) maps contexts, concerns and check kinds to the thirteen areas.

- Paths are split into words across folders, separators and camelCase (`useAuth` → use, auth; `app/(auth)/…` → auth). Mixed-case names such as OAuth and GraphQL stay whole. Phrases (“rate limit”, “screen reader”, “data retention”) match across adjacent words.
- Each term has a strength from 0.35 to 0.95. A word found inside a compound name counts 85% of its strength. Distinct terms for the same context or concern combine as a noisy-OR, capped at 0.9, so corroboration raises confidence without claiming certainty.
- Ambiguous words carry low strength and **vetoes**: “token” is not security next to “design” or “lexer”; “session” is not security next to “chat”; `requirements.txt` is not product requirements; `DataTable.tsx` is interface work, not data work.
- A context must reach 0.5 to name the work; a concern needs 0.4. Plain source files with no other signal fall back to Functionality at 0.6; test files do not.
- A recognised check is direct evidence for its area at confidence 1. Tool and script names count 80% of a path match.
- Paths are resolved against the workspace and the command’s working directory. Generated and dependency folders (`node_modules`, `dist`, `coverage`, `vendor`, `.next` and similar) are ignored. Outside the workspace, only the file name is classified, so folder names elsewhere on disk never create claims.
- An observation credits at most its six strongest areas.

Each area on an observation keeps a short reason, such as “auth” in path, `.tsx file`, known file “Dockerfile” or recognised test run. The evidence panel shows it.

## Formula, version 3: kept progress

Version 2 estimated recent attention: weight halved every ten minutes and scores reached zero an hour after the last observation, so an older chat showed nothing. Version 3 keeps each chat's progress instead.

The implementation is [`src/attention.js`](../src/attention.js), shared by the collector and webview.

1. Suppress repeated provider tool-call IDs within the last 32 hashes. Within one minute, count one observation per subject, action and area set.
2. Add each observation to its minute: its action weight to the minute's work, and weight × confidence to each related area. Work that no area recognises counts a quarter towards the minute's work, so gaps in recognition barely dilute recognised work.
3. When a minute ends, cap it at a total of 2 (a hundred-file burst cannot outweigh one change). Kept evidence for every area then fades by `2 ^ (−minuteWork / 1600)` before the minute's own evidence is added. Nothing fades while the chat is idle.
4. Let `M` be the area's kept evidence and `S = M / W` its share of the chat's kept work.
5. Score = `round(100 × (1 − e^(−M / 20)) × (0.8 + 0.2 × √S))`.

`M` grows with sustained work and saturates gradually, so one change is small and forty are high, but nothing jumps to 100. Evidence fades only as the chat does other work, and slowly: about 1,600 work units elsewhere halve it (roughly thirteen hours of full-time work, since a change is 2). The share term separates a chat's main focus from side topics but can lower a score by at most 20%. Security and Performance can overlap, so category scores are not parts of a pie and must not be added together.

Synthetic examples, one observation per minute, with no competing work unless stated:

| Observations                                                          | Security score |
| --------------------------------------------------------------------- | -------------: |
| One read of `server/auth/session.ts`                                  |              4 |
| One change                                                            |              9 |
| One `npm audit` run (recognised check)                                |             10 |
| Five changes                                                          |             36 |
| Ten changes                                                           |             59 |
| Twenty changes                                                        |             82 |
| Twenty changes, viewed thirty days later                              |             82 |
| Forty changes                                                         |             96 |
| Forty changes, then an hour of documentation work                     |             89 |
| Forty changes, then eight hours of documentation work                 |             77 |
| Five security changes during an hour of interface work (a side topic) |             31 |

In the last example, the interface work scores 98. These examples validate behaviour, not calibrated accuracy.

Subagents fold into their parent chat: their work and evidence add to the chat's.

## Colour and history

Chat tint uses the last observed active event, with a ten-minute half-life. A Stop or SessionEnd event does not refresh or remove the tint. An area's meter length is its score; the meter's colour strength shows how recent its evidence is, fading to a muted (never invisible) colour after an hour. The visible-only 15-second refresh updates colours; no extra interval, animation or watcher is added.

A completed or idle chat keeps its scores. Colour does not mean a task or category is done. The three most recent distinct pieces of evidence for an area remain inspectable within the 24-hour chat lifetime.

## Project stakes and sensitive changes

Each workspace has **stakes**: Standard, Production or Critical. They are set in Focus, or suggested by an enabled `.agent-monitor/focus.json`, and apply to new activity.

- **Standard** uses the built-in vocabulary only.
- **Production** adds release-safety and integrity vocabulary (ledgers, reconciliation, rollbacks, tenant isolation, idempotency keys) and marks changes to database migrations and schemas, authentication and access control, secrets, deployment configuration and payments as **sensitive**.
- **Critical** adds safety, industrial-control, healthcare-data, regulatory, cryptographic and formal-verification vocabulary; safety logic counts as Reliability. It also marks changes to cryptography and key management, safety and control logic, concurrency and transactions, audit logging, retention and deletion, dependencies and the build or release pipeline.

A sensitive change needs a **changed** workspace file whose own folder or file name gives strong, whole-word evidence (0.8 or more) of that kind. Tests, documentation and reads are never marked, and each marker appears only on the areas it concerns (a migration on Data, a secret on Security). Stakes add vocabulary and markers and tell agents the project's stakes in Focus here requests; they never raise a score on their own. Every stakes term has vetoes for its common false friends: `grid` next to CSS or components, `phi` in maths code, `overflow` in styles, checkout buttons as opposed to payments.

## Custom areas

A workspace can define up to eight project-specific areas in `.agent-monitor/focus.json`, drafted by the developer's own agent from [the guide](CUSTOM-AREAS.md). Custom areas use the same matching and scoring as built-in areas, with globs, terms, file names and script names, and count separately from built-in areas (up to three per observation). A definition must pass its own examples and a breadth check against common project files, and it takes effect only after someone enables that exact content in the editor. The extension then copies it into the collector's cache.

## Storage and compatibility

Version-3 progress is `{ version: 3, work, areas: [[key, evidence, actionBits, lastSeen]…], open: [minute, work, lastSecond, [[key, weight, actionBits]…]], subjects: [[subjectHash, lastSeen, areaBits, customNames?]…], recent }`. Built-in areas use the append-only bit positions of `IDS` in `attention.js`; custom areas use their names, prefixed `x:`. It is a few hundred bytes per chat. Version-2 minute buckets and version-1 samples are replayed into version 3 on read, keeping their evidence however old. A chat whose older history had already expired recovers its retained evidence points, each counted once. If a pathological cache would exceed the 256 KiB metadata budget, the oldest chats shed evidence detail first; kept progress itself is never shed.

## Evaluation

`test/focus-corpus.js` (in the source repository) holds 278 labelled synthetic tool calls, including cases at each project stakes with expected sensitive-change markers, across Claude Code, Codex, Cursor and MCP tools, many languages and project types. Each states the expected action, check and the areas that must and must not be signalled; the test suite requires all of them to pass. On the 172 cases written alongside the vocabulary, version 1 was fully correct on 45.9% and version 2 on 100%. On 76 further cases written afterwards and scored once before any change, version 1 was fully correct on 40.8% and version 2 on 97.4% (area recall 50.0% versus 98.6%, with no false areas); the two misses were then fixed and the cases added to the corpus.

These are results on synthetic cases written by the maintainers, not a measurement of accuracy on real work. Before claiming calibrated accuracy, evaluate against a consented, labelled corpus of real sessions across agents, languages and task types, and report false positives, false negatives and sensitivity to the weights.

## Research boundary

The [SPACE research](https://www.microsoft.com/en-us/research/publication/the-space-of-developer-productivity-theres-more-to-it-than-you-think/) distinguishes activity from broader developer productivity. [OpenTelemetry's agent conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md) distinguish agent invocations, plans, tool executions and conversation identity. These inform the separation of observed actions, plans, identity and outcomes here. Neither source specifies or validates this scoring formula, and no OpenTelemetry runtime is installed.
