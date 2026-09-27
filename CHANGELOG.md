# Changelog

## 0.14.0 — development preview

- Added an original AI-generated extension icon, a matching sidebar mark and a clearer product description covering agent activity, evidence, images and per-chat focus requests.
- Only the picture opens an image tab. The frame around it no longer does, and the round arrows have larger hit areas, so near misses step through images instead of opening a tab.
- Tightened the geometry: one 12px inset inside every surface, glyphs aligned to text edges, and spacing on a 4/8/12/16px scale. Tiles in a row share row lines, so names, meters, states and buttons stay level; the score sits at the end of its meter and every meter ends at the same point. Chat cards align both text lines to one edge.
- Added short, one-shot motion: a sliding tab underline, views and evidence that lift in, meters that fill for a chosen chat and move only when a score changes, one ping when a chat becomes active, direction-aware image slides, a popping unseen count, a fading red outline and a fading dialog. Nothing loops or replays on refresh.
- Added `agentMonitor.motion` to turn motion off. The editor’s Reduce Motion setting and the operating system preference also turn it off.
- Focus classification now reads chained and piped shell commands segment by segment (`cd web && npm test | tail`), unwraps common wrappers, skips heredoc bodies and recognises test, static, benchmark, security, build, accessibility and documentation checks across ecosystems. Cursor, Codex and MCP file tools count as reads and changes.
- A weighted vocabulary replaces fixed patterns: camelCase and route-group paths are understood, ambiguous words need context, and each area on an observation has a confidence and a short reason shown in the evidence panel. On a labelled synthetic corpus the share of fully correct classifications rose from 44% to 100%; held-out cases went from 41% to 97% before their misses were fixed.
- Focus history keeps per-minute aggregates for the whole hour, so busy minutes no longer erase earlier focus. Older caches migrate with identical scores. Test runs that report failures count as testing attention and are labelled as such.
- An already connected helper is refreshed when the extension starts, so collection fixes apply without reconnecting. Settings and hook commands are not changed.
- Fixed a crash that dropped events for files named after built-in object properties, such as `constructor.js`.
- Stricter privacy: command labels keep only recognised programs and subcommands; redaction covers more credential shapes; paths outside the workspace are classified by file name only; the cache sheds the oldest detail instead of failing when full.
- Added adversarial, privacy-canary and pattern-timing tests for collection.
- Every image an agent receives is kept at original quality: large and animated PNG, JPEG and WebP, plus GIF, BMP, AVIF and small images, which were previously skipped. Very large or animated images show a still, reduced preview with **View clearer image**, which opens the original full size.
- A delivered Focus here request now reads “Sent! Task is focusing here…”; its tooltip gives the time and notes that the agent has not confirmed it. Queuing a request no longer shows a banner; the tile shows the queued request.
- Fixed images missing from Images for Claude Code and Codex. Claude Code's Read returns images in a shape the helper did not recognise. Codex hooks replace image data with a placeholder, so after a successful `view_image` the helper now reads the one image file it named: never through a link, device or pipe, within the size limit, and kept only if it decodes as an image. Images from other Codex tools still cannot be shown.

- Focus scores are kept progress: they build up gradually as a chat works on an area, stay when the chat is idle or old, and fade only slowly as it works elsewhere (an hour of other work costs about 7 points of 96). Previously they reached zero an hour after the last observation. Work nothing recognises barely dilutes recognised work, and older chats recover their retained evidence.
- Added **Project stakes** (Standard, Production, Critical). Higher stakes add vetted vocabulary for production and critical systems, mark sensitive changes (such as migrations, access control, secrets, deployment, payments, cryptography, safety logic and dependencies) only on the areas they concern, and tell agents the stakes in Focus here requests.
- Added custom Focus Areas. **Create your own Focus Area**, at the end of More areas, opens a short form inside the card (name, optional details, optional kind of product, who sets it up), then Claude Code, Codex, Cursor Agent or any AI assistant sets it up from this repository using a shipped guide and check. The card then says in plain words what is ready and what needs a fix, with **Approve** and **Copy fix request**. An area must pass its own examples and a breadth check, and counts only after you approve that exact content from a trusted workspace.

## 0.13.0 — development preview

- Redesigned the interface around the editor’s own conventions: theme button, badge and list styles, flat surfaces instead of nested cards, and no decorative accent bars. Colour carries data only: category meters, green activity, the focus colour for selection and red for unseen images.
- Two views, **Focus** and **Images**, as full-width tabs with icons. Both start with a strip of chat cards (provider, state, age and a two-line title). Focus always shows one chat, starting with the most recent; Images adds All chats, keeps its own selection and orders chats by image activity.
- Chats use the agent’s own title where it keeps one locally (Codex thread names, Claude Code chat titles), with bounded reads that parse only title records. Cursor chats keep the first-prompt label.
- Subagents are no longer listed as chats. Their work is folded into their parent chat, so it counts towards that chat’s scores, evidence, activity and images; a working subagent keeps the chat Active.
- Area tiles show the score with a meter whose length is the score and whose strength fades with age, replacing tinted tiles and “/100”. Focus here is a wide, neutral button; Cancel sits beside a queued request. Tiles go two across only when there is room.
- Images: thumbnail history above a large preview with round, outlined previous/next controls on its edges; open any image in an editor tab. Follow latest changes only through its checkbox. The tab’s image total is replaced by a red count of images used since you last looked, which briefly outlines them when you open the view.
- Added **Main Window**, which opens one copy of the monitor in the main editor area and is restored after reload. The sidebar and editor copies share one watcher.
- Added **I don’t use …** for each agent in setup and in a single-agent warning. Marked agents never trigger the setup warning; hooks are not changed.
- Ages are coarse (“just now”, “5 min ago”) instead of ticking each second.
- Fixed provider marks triggering a content-security-policy violation on every render, and the setup warning staying visible behind the setup dialog.
- No new runtime dependency, network access, model call or background process.

## 0.12.2 — development preview

- Experimental exact-chat continuation for idle Codex IDE chats on the verified macOS extension version. Preserves native settings and checks an exact-owner turn receipt.
- Separate Sending, Accepted and Delivery unconfirmed states; shared atomic claims prevent hook/direct duplicate delivery. No retry, daemon or persistent connection.
- Claude idle delivery uses a bounded native asyncRewake listener: one sleeping shell per chat, twelve maximum, one-hour expiry and no polling. Verified in a disposable IDE chat.
- Cursor’s native Desktop Bridge was identified but its rollout gate is disabled in the tested installation. Unsupported idle chats explicitly offer Queue for next turn, without asking for filler messages.
- Native routing IDs remain in private bounded metadata and are removed from sidebar payloads.

## 0.12.1 — development preview

- Focus requests now ask the agent to acknowledge receipt visibly and state its next relevant check. With no active task, the agent is asked what to review rather than resuming cancelled work.
- Queued tiles explain that an idle chat needs a message. The sent state reads “Sent to hook” to distinguish emission from agent acknowledgement or completed work.
- No new background process, automatic retry or idle-chat launch.

## 0.12.0 — development preview

- Replaced the Focus chat dropdown with a manually scrolling card strip, provider marks, area chips and observed activity/age. Added keyboard navigation and preserved scroll/selection across refreshes.
- Simplified Overview to compact chat cards with clickable focus-area chips and inline metadata; removed tool details and metadata dropdowns.
- Put chat names in distinct containers inside focus tiles.
- Added research for deterministic recommendations; no recommendation engine or automatic suggestion behaviour implemented.

## 0.11.0 — development preview

- Added stronger, age-fading colours to chat cards and focus tiles, retained after a turn ends.
- Replaced active-chat counts with bounded 0–100 attention scores and separate subject breadth. Scores use action weights, per-minute caps, decay and competing work; All chats shows the strongest individual score.
- Retained compact observation history and hashed call IDs to suppress duplicate delivery.
- Classified multi-file tool targets separately and rejected bare shell keywords/echoed paths as category evidence.
- Added scoring documentation and regression cases; no model calls, network service, runtime dependency or new timer.

## 0.10.0 — development preview

- Replaced flat task rows with bounded chat cards, bundled provider marks and a separate latest-activity panel.
- Arranged expanded details in a compact metadata grid, with image/request counts and local renaming. Cards use available width and preserve narrow-sidebar reflow.
- No runtime dependencies, network requests or background work added.

## 0.9.1 — development preview

- Show area handles only on tile hover or keyboard focus.

## 0.9.0 — development preview

- Added draggable area handles and a keyboard-accessible move menu, with separate layouts per chat and All chats.
- Renamed the overview to Tasks (chats), added local chat names and expandable observation details, and removed project/hash fallback names.
- Moved utilities above the tabs and strengthened setup-warning contrast and weight.
- Moved browser-test setup into contributor validation documentation.

## 0.8.1 — development preview

- Reorganised documentation around installation, behaviour, architecture, adapters and contribution.
- Removed environment-specific notes and prototype-only hook migration.
- Added source/archive hygiene checks, source packaging and consistent code formatting.
- Kept native acceptance and distribution configuration explicit.

## 0.8.0 — development preview

- Added a setup warning and per-agent connection, repair, hook-review and settings actions.
- Distinguished installed hooks, missing tool receipt, disabled Claude hooks and unreadable settings.
- Added labelled Codicons controls; replaced the settings disclosure with an Agents button and compact utility toolbar.
- Moved category evidence directly below the selected row and reduced repeated tile content.
- Corrected thumbnail timestamp layout and hid image controls for empty history.
- Added modal focus recovery, narrow-dialog checks and host tests for setup terminal reuse and trust boundaries.
- No runtime dependencies or background services added.

## 0.7.0 — development preview

- Removed promotional copy, repeated headings, permanent instructions and the duplicate overview image.
- Kept the category grid, with compact controls, shorter meanings and evidence on demand.
- Made Overview threads open their scoped Focus view; all retained threads are listed.
- Moved connections, settings and help into one disclosure accessible from every tab.
- Added dismissible notices, visible pause recovery, distinct setup/error states and missing-image dismissal.
- Corrected per-thread image ages and preserved the selected scope when a thread disappears.
- Added a Cursor Agent adapter, subagent lifecycle tracking, multiple-image capture, wrapper output support, collector diagnostics and bounded contention retries.
- Corrected Codex command-form patch classification and failed-command states.
- Added thumbnail ages and keyboard focus recovery; age updates reuse existing image elements.
- Added light/dark accessibility scans and narrow/zoomed renderer checks. No runtime dependencies added.

## 0.6.0 — development preview

- Renamed Backend & logic to Functionality and Architecture to Code quality; separated Testing from Reliability.
- Added shared, short category meanings to the interface and new steering requests.
- Added per-thread Choose areas with stable ordering and quiet categories kept visible.
- Tightened test, static-check, analytics, documentation, privacy and performance signals; excluded failed tools from successful attention signals.
- Preserved the original scope of existing queued requests through the category update.
- Added regression cases for misleading classifications and selection persistence, plus keyboard and narrow-layout checks.

## 0.5.0 — development preview

- Formalised Agent Monitor as an independent VS Code-compatible desktop extension.
- Added automatic once-per-window startup and an opt-out.
- Introduced Overview, Focus and Images tabs.
- Added familiar, overlapping focus categories with evidence-driven attention and exact-thread Focus here requests.
- Added cancellable, expiring steering through existing agent hooks, with at-most-once delivery and Stop-loop protection.
- Added a main image preview, thumbnail strip, manual browsing, follow-latest control and relative timestamps.
- Linked recent image highlights to observed thread activity and lifecycle.
- Added a bounded Node collector.
- Added agent connection/disconnection, settings preservation, platform-aware storage, tests and installable packaging.
- Kept all runtime activity local; no publication or telemetry integration.
