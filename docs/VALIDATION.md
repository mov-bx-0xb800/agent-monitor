# Validation

Automated checks use synthetic inputs and temporary directories. No personal installation status, live conversation identifiers or user cache contents belong in this document.

## Reproduce

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run format:check
npm run test:ui
npm run package
npm run package:source
```

See Renderer test setup below for browser selection. The renderer uses an installed Chrome by default; CI installs the pinned Playwright Chromium explicitly. No app server is needed. `.evidence/` contains disposable renderer outputs and is excluded from source and extension packages.

## What the checks establish

| Check                      | Evidence                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository check           | Allowlisted source inventory; no symlinks; common sensitive-data patterns; local Markdown links; approved raster files without identifying metadata |
| Node tests                 | Classifier cases and counterexamples, identity, lifecycle, bounded storage, raster extraction, contention, steering and settings behaviour          |
| Mocked editor-host tests   | Workspace isolation, startup placement, hidden watcher disposal, Main Window editor copy, exact-chat requests, setup routing and not-used agents    |
| Collector subprocess tests | Bounded command execution, host output contracts and parallel event retention within tested load                                                    |
| Renderer journeys          | Two views, chat strips, focus requests, image arrows/history, unseen-image count and outline, setup states, keyboard focus and CSP violations       |
| Accessibility and layout   | Two views in light/dark, setup dialog scan, narrow widths, editor-area layout, CSS zoom, forced colours and reduced motion                          |
| Packaging checks           | Explicit file set, scanned archive contents, no runtime dependencies or local cache inclusion                                                       |

Attention tests cover read/change weighting, graded confidence, repeated work, age decay, shifts to other areas, retention under busy minutes, exact version-1 migration, subagent capping, duplicate-call suppression, burst caps, subject breadth, multi-target attribution, lifecycle behaviour and metadata-budget compaction. These establish deterministic properties of a heuristic, not calibrated semantic accuracy. Scoring tests also cover kept progress (no loss with time, slow loss to other work, gradual build-up, side topics, recognition gaps) and migration of every earlier format. Custom-area tests cover the definition standard, weak and hostile definitions, glob safety, links and oversized files, the cache and the `check` command, and a host journey from review to enable, change, start and focus under workspace trust. The labelled corpus (`test/focus-corpus.js`, 278 synthetic tool calls across agents, languages, domains and project stakes, with expected sensitive-change markers) must pass in full; see [scoring](SCORING.md#evaluation) for how it was built and what it does not establish. Safety tests fuzz the collector with hostile payloads, plant credential canaries in prompts, commands, outputs and file contents, bound pattern-matching time on adversarial text and check that no files are written outside the cache. Automated accessibility checks do not establish complete screen-reader or native-host conformance. Contention tests do not guarantee lossless capture under arbitrary overload.

## Native acceptance remains separate

Focus-request regression checks cover acknowledgement instructions for all three adapters, protection against restarting cancelled work, exact-recipient and at-most-once delivery, and the queued idle-chat guidance at narrow widths. They verify the emitted instruction and interface, not whether an agent follows the instruction.

For each supported release target, record editor, agent and operating-system versions, then verify:

1. Installation and once-per-window startup; closing the view is respected.
2. Hook configuration preserves unrelated settings and the helper path survives extension updates.
3. Native trust is explicitly reviewed; a real tool event arrives for the correct workspace.
4. A supported image appears with the correct chat and recency state.
5. A focus request reaches exactly its selected chat, at most once; idle and ended chats behave as documented.
6. Pause, disconnect, cache removal and hidden-view resource cleanup work.
7. Main Window opens one editor-area copy, both copies update, and a reload restores it; opening an image shows the cached copy.
8. Keyboard, screen-reader, theme and native zoom behaviour is usable in that editor.

Native end-to-end acceptance for the full host/platform matrix is pending. Do not promote installation success, a mock host or a renderer screenshot to live capture proof. Any future acceptance record must use a disposable workspace and contain only de-identified results.

## Renderer test setup

These instructions are for contributors running automated interface tests. Agent Monitor users do not need a browser installation or these environment variables.

For rendered checks, use an installed Chrome:

```sh
npm run test:ui
```

Or install the pinned Playwright browser explicitly and select it:

```sh
npx playwright install chromium
PLAYWRIGHT_CHANNEL=chromium npm run test:ui
```

PowerShell equivalent for selecting that browser:

```powershell
$env:PLAYWRIGHT_CHANNEL = 'chromium'
npm run test:ui
```

Browser installation is a development download. The extension itself downloads no browser. UI tests close their browser in `finally`, use synthetic fixtures and start no app server. Screenshots are generated under `.evidence/`; updating the documented screenshots requires `UPDATE_SCREENSHOTS=1`.

## Experimental direct delivery

See [focus delivery](FOCUS-DELIVERY.md) for the native idle-chat verification, rejected initial payload, version gate and remaining host matrix. IPC fixtures test the local wire contract and cleanup; steering fixtures test the shared at-most-once claim. Native proof is limited to the documented macOS/Codex configuration.
