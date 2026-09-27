# Architecture

```text
Codex / Claude / Cursor command hooks
            ↓ bounded stdin
Node collector → local state.json + hash-named raster copies
                              ↓ one visible-only filesystem watcher
                    editor webview view
                    Focus / Images (sidebar, and an optional editor tab)
```

The collector and editor communicate through bounded local files, not a socket. Activity, image-cache and steering writes use a short exclusive directory lock. Activity and steering metadata use atomic replacement; image bytes are written to bounded hash-named cache files. CLI collectors retry short contention up to six times, with a total wait below 625 ms. A fixed diagnostic file per adapter records receipt status or the latest failure; it does not retain the event payload. Diagnostics are best-effort bounded writes, independent of the activity lock. A stale lock is reclaimed only after 30 seconds and a check that its recorded process no longer exists. Collection remains bounded and best effort: contention beyond the retry window, deadlines and unsupported host events can leave gaps.

`src/classify.js` turns a hook event into observations with areas, confidences and reasons, using the vocabulary in `src/lexicon.js` and `src/taxonomy.json` and the command reader in `src/shell.js`. It ignores code bodies, general output and prompts. The command reader is bounded and quote-aware: it follows chains, pipes, `cd` and common wrappers, skips heredoc bodies and inline scripts, and uses quoted text only when it is one path-like word. It keeps only a recognised program and subcommand as a label. `src/images.js` recognises bounded static PNG/JPEG/WebP data and records the observing chat. Image identity includes workspace and content, keeping same-content images in different projects separate.

`src/collector.js` records observed lifecycle and tool events. Pre-tool events never collect images. A successful image result marks “viewed” or “referenced” for at most two minutes while that chat remains active. Later tool events and stopped turns clear the chat's current image. A highlight is an observable recency heuristic, not proof of continuous visual attention.

`src/extension.js` filters cache entries by the current local workspace, registers a native sidebar view, and opens it once on startup. It uses secondary-sidebar contributions in Cursor and VS Code 1.106+, with a primary-sidebar fallback for older compatible versions. An editor-area panel (`agentMonitor.editor`) is created only by **Main Window** or restored by its serializer; at most one exists. The sidebar view and panel are both “surfaces” of one controller: each has its own ready state and webview resource URIs, action results return to the surface that asked, and one host watcher runs while any surface is visible. Each surface's timers stop while it is hidden.

`src/setup.js` installs a standalone helper into stable application storage and merges owned hook handlers into agent settings. On activation the extension refreshes an already installed helper whose files differ from its bundled copy, writing the entry point last and leaving a newer version's helper alone; this never edits settings. It preserves unrelated configuration and refuses malformed JSON. An absolute Node executable and quoted arguments avoid dependence on the agent's working directory. Windows uses an encoded PowerShell command with literal path arguments. Native Windows execution remains an acceptance gap.

No retained hidden webview context, raw transcript reader, model classifier, token counter or telemetry client is included.

## Same-chat steering

`src/steering.js` shares the collector lock and keeps a separate bounded `steering.json`. A click identifies a known workspace session and a fixed category ID; multiple chats require an explicit target. Identity includes the agent, session and subagent ID. No active-chat guessing, clipboard injection, competing session or transcript read is used.

The matching `PostToolUse` / `UserPromptSubmit` hook returns `hookSpecificOutput.additionalContext`. The matching `Stop` hook can return `decision: block` with the explicit user request as its reason, continuing that turn. `stop_hook_active` prevents a continuation loop. Cursor uses `additional_context` on post-tool events and `followup_message` on a completed Stop, with `loop_count` and a one-follow-up limit. Ordinary events add no model-facing context; Cursor permission hooks return a pass-through response. The request is marked before output for at-most-once delivery: a crashed output pipe can lose it, and the UI must not imply an agent acknowledgement. There is no autonomous retry.

Ordinary hooks alone do not wake idle chats. The experimental Codex socket client and Claude native wake listener add bounded idle delivery; see [focus delivery](FOCUS-DELIVERY.md). At most four requests may wait per chat; at most 24 request records are retained. Pending requests expire after one hour; records expire after 24 hours. Completed history is evicted before pending requests. A paused collector does not deliver requests. Codex opens a seven-second connection only on a click. Claude uses at most twelve sleeping native hook processes, one per chat, for at most one hour. There is no polling or standalone daemon.

The collector stores at most 90 sanitised characters from the first useful user-prompt line for chat identification. Classification itself ignores prompt content. These local labels are not guaranteed to match native chat titles.

## Category boundaries and selections

`focus-areas.json` defines thirteen flat categories, six defaults and one short meaning per category. The same meaning is displayed in Focus and included in new steering requests. Areas are reached only through contexts, concerns and recognised check kinds, so the vocabulary has one source. Category matching keeps test execution separate from static checks and reliability concerns. Explicit file conventions can indicate tests; arbitrary `spec` tokens and text-file extensions cannot. Failed tool events do not become successful attention signals. Multi-target calls and chained commands classify each path or segment separately; bare command keywords and echo/print path mentions do not create category evidence. Inference remains incomplete and path-based, not a semantic judgement of quality. `attention.js` keeps per-minute aggregates for one hour, weights evidence by confidence, caps each minute and computes age-decayed scores. It is shared by collector and webview; see [scoring](SCORING.md).

The visible set is independent of observed activity. A native multi-select stores recognised area IDs in local workspace state for a chosen chat. Saves retain at most the twelve currently visible workspace chats. All chats starts with the six defaults and has a separate workspace layout; each individual chat restores its own selection and order. Quiet selections remain visible. Other areas stay under More areas with activity and pending indicators.

New steering rows carry revision 2. Existing rows without that revision retain the previous labels and prompt scope, including combined Testing & reliability. Renamed category IDs remain stable. No old queued request is silently narrowed into the new Testing category. This compatibility logic does not repeat delivered requests.

## Adapter contracts

`adapters.js` normalises Cursor conversation identity, event names and JSON tool results into the collector contract. Codex and Claude use their existing hook fields. Explicit subagent IDs separate children from parent chats. Unidentified Cursor child lifecycle events are rejected rather than merged into a parent. Codex patch commands and non-zero shell exit codes are handled explicitly.

Image collection accepts multiple supported images from an event. All tools require actual image data in a successful post-tool output. Input paths, output paths, symlinks and path strings nested in JSON are never opened. Legacy images without the tool-output source marker are hidden and cannot be opened; the next collection removes their validated hash-named cache copies. Source files are never removed. Parsing, image candidates, bytes, dimensions, cache size and process lifetime stay bounded.

## Source map

| Module                                                  | Responsibility                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `src/extension.js`                                      | Editor activation, workspace filtering, view lifecycle and user-action handlers |
| `src/webview.js`                                        | HTML shell and content security policy; embeds bundled assets                   |
| `media/view.js`, `media/view.css`                       | Rendering, interaction, accessibility and layout                                |
| `src/attention.js`                                      | Shared bounded history, scoring, category matching and recency decay            |
| `src/lexicon.js`, `src/shell.js`                        | Weighted path vocabulary; bounded shell command reader                          |
| `src/profile.js`                                        | Custom-area definition standard, checks, workspace profiles and `check` command |
| `media/model.js`                                        | Category aggregation and relative-time presentation                             |
| `src/setup.js`, `src/paths.js`                          | Hook installation, settings inspection, platform paths and helper location      |
| `src/adapters.js`                                       | Host event normalisation, identity and failure detection                        |
| `src/collector.js`                                      | Bounded CLI ingestion and lifecycle/event recording                             |
| `src/classify.js`, `src/topics.js`, `src/taxonomy.json` | Tool/path evidence and subject inference                                        |
| `src/focus-areas.json`                                  | Stable category IDs, descriptions and aggregation rules                         |
| `src/images.js`                                         | Raster validation, payload extraction, image identity and eviction              |
| `src/store.js`                                          | Cache contract, atomic writes, lock ownership and limits                        |
| `src/titles.js`                                         | Bounded lookup of each agent's own chat titles, kept in editor memory           |
| `src/chats.js`                                          | Folding subagents into their parent chat for display and scoring                |
| `src/steering.js`                                       | Exact-chat request queue, revision compatibility and host output                |
| `test/`                                                 | Synthetic fixtures, unit/host/collector tests and renderer journeys             |
| `scripts/`                                              | Repository checks and local distribution packaging                              |

## Local storage contracts

`state.json` version 1 contains a sessions object keyed by hashed identity and an images array. Each session's `attention` is version 2 (per-minute aggregates, see [scoring](SCORING.md)); version-1 samples are migrated on read. If a pathological cache would exceed its budget, the oldest chats shed detail first. Timestamps are Unix seconds. Image filenames are 24 hexadecimal characters plus a validated raster extension. `steering.json` retains bounded request records separately. `profiles.json` holds the effective profile of each open workspace folder (stakes and enabled, validated custom areas); only the extension writes it, and hooks validate it again before use, so hooks never read workspace files. Three `health-<adapter>.json` files store bounded diagnostics. Category selections use editor workspace state.

These files are implementation storage, not a stable external API. A storage change needs migration or an explicit compatibility boundary. Never rewrite an unreadable activity file merely to hide an error. Do not ship real cache files as fixtures.

The webview receives filtered state through editor messages and sends allowlisted user actions back. User text is rendered as text content; only bundled trusted SVG markup is used for icons. Image URLs are editor webview resource URIs. The webview has no general network origin, and scripts/styles use a nonce-based content security policy.

`focusLayouts` stores ordered primary/extra ID lists for up to twelve retained chats plus All chats. Existing `focusSelections` remain a fallback for older saved views. `chatNames` stores sanitised local name overrides for retained chats. `ignoredAgents` in editor global state stores only the adapter keys a person has marked as not used. Both are editor workspace state, do not modify collector identity, and send no steering requests. The collector additionally records first-observed time and whether an explicit subagent identity was supplied.

`src/codex-ipc.js` implements the version-gated owner bridge. `src/claude-wake.js` and `src/claude-wake.sh` implement the native hook listener, private FIFO leases and cancellation. They share the steering claim with ordinary hooks. Raw native routing IDs stay out of webview payloads.
