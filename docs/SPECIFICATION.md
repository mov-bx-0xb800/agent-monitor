# Behaviour specification

This document describes the implemented development-preview contract. A supported adapter means its event mapping exists and is fixture-tested, not that every host/version has passed native acceptance. See [coverage](COVERAGE.md) and [validation](VALIDATION.md).

## Workspace and view lifecycle

- Show only sessions and images belonging to an open local workspace. Match path boundaries, not textual prefixes.
- Register a secondary-sidebar view where supported, with an activity-bar fallback. Never create an image editor tab per event.
- **Main Window** opens one editor-area copy of the monitor on request and reveals it if it is already open; it is restored after a window reload. Nothing opens it automatically. The sidebar and editor copies share one cache watcher, which runs only while at least one copy is visible.
- Open once per editor-window activation when `agentMonitor.openOnStartup` is enabled. Incoming events must not reopen a closed view or steal chat focus.
- Stop the cache watcher, relative-time timer and image-highlight timer while hidden. Do not retain hidden webview context.
- Motion is on unless `agentMonitor.motion` is off, the editor's `workbench.reduceMotion` is `on`, or the operating system asks for reduced motion; setting changes apply without reloading. Entrance motion follows only a person's own actions; data refreshes and timers never replay it, and no animation loops.
- Keep a missing selected chat selected and explain that it is unavailable; never silently switch to all chats.
- Remote and untrusted workspaces have explicit unsupported or recovery states. Connecting and steering require a trusted local workspace.

## Agent setup

Each adapter has independent configuration and receipt state. Required baseline hooks are session start, post-tool use and stop. Partial configuration offers repair; malformed settings are not overwritten. Claude's disabled-hook setting is reported separately.

A configured agent needs a tool event in the current workspace after the configuration file's modification time to show tool receipt. Lifecycle events alone do not satisfy that condition. The setup warning is suppressed while paused or the workspace/cache is unavailable. A quiet configured agent may therefore still need a first tool event in this workspace.

An agent that is not receiving activity can be marked **I don’t use …**. This is a per-user editor preference: it hides that agent from setup warnings and changes no hooks or agent settings. It can be undone in setup, and an agent that later delivers tool activity is shown normally. When every agent is receiving activity or marked as not used, no setup warning appears.

Connect preserves unrelated settings and creates an adjacent backup before changing them. Setup terminal actions reuse their existing live terminal. Native hook trust is reviewed in the agent; Agent Monitor never grants trust itself.

## Chat identity and observations

Identity includes the agent, session and available subagent identity. One child's lifecycle must not end its parent or receive its parent's focus request. Reject child events without a usable identity when the adapter cannot distinguish them safely.

Retain observed lifecycle, tool stage, bounded evidence and image references. Do not treat a failed tool as successful work; a recognised check that reports failure is recorded as a failed check, not as success. Planned work and coordination tools (subagent launch, questions, output polling) remain distinct from observed work. Classification uses tool names, workspace paths and recognised commands, not private reasoning, full transcripts, tool output or arbitrary code-body text.

A chat title is, in order: a local rename; the agent's own title where it keeps one locally (Codex's `session_index.jsonl` thread name, or Claude Code's `ai-title`/`custom-title` session records); otherwise a bounded, sanitised first useful prompt line; otherwise Untitled chat. Title lookups are bounded (a 4 MiB index tail; for Claude Code, at most the last and first 1 MiB of the session file, rechecked no more than every 15 seconds), parse only title records, sanitise to 90 characters and keep the title in editor memory only. Subagents never take their parent's title. See [privacy](PRIVACY.md).

## Focus

The source of truth is [`src/focus-areas.json`](../src/focus-areas.json): thirteen flat, overlapping categories, with six defaults. The visible order is stable unless the developer changes it. Per-chat Choose areas persists selected IDs without sending a request. Quiet selected tiles remain visible; other areas stay under More areas. A previously saved All chats layout is kept but no longer shown, because Focus always shows one chat.

A 0–100 score shows the observed work a chat has put into an area, weighted by action type and confidence. It builds up gradually, is kept while the chat is idle or old, and fades only slowly as the chat works in other areas; time alone never lowers it. Breadth is a separate count of inferred subjects. Scores are per chat, including its folded subagents, and are never summed across chats. A meter's colour shows how recent its evidence is and fades to a muted colour after an hour; its length is the score. See [scoring](SCORING.md) for the exact formula, caps, migration and limitations. Scores do not certify coverage, completion or quality. Each observation relates to areas with a confidence and a short reason; clear signals and recognised checks count more than ambiguous names. Category evidence shows up to three recent items with their stage and reason. Lack of a signal is not proof that the agent neglected the task. The developer decides whether an area needs more attention.

### Project stakes, sensitive changes and custom areas

Each workspace has stakes: Standard, Production or Critical. The segmented control above the areas sets them for the editor window; an enabled `.agent-monitor/focus.json` may suggest a project default, and a person's choice wins. Stakes apply to new activity. They add vocabulary for production and critical systems and mark sensitive changes, which need a changed, non-test, non-document workspace file with strong path evidence of that kind and appear only on the areas they concern. Stakes never raise a score on their own. Focus here requests carry the stakes, and at Critical ask the agent to prefer small, reversible changes and to state evidence and residual risk. Requests never gain permissions.

The last item under More areas, **Create your own Focus Area**, creates a custom area. **Start now** opens a form inside the card, never an editor prompt: a name, optional details, an optional kind of product (General software by default), the project when several folders are open, and who sets it up (Claude Code, Codex or Cursor Agent in a terminal, or **Copy instructions** for any other AI assistant; the chat's own agent or the last choice is preselected). The form stays in place while activity updates. **Create Focus Area** checks the name in place; the host checks every field again, and a problem it finds is shown in the form with everything typed kept. Escape or **Cancel** closes it. It copies the drafting guide to `.agent-monitor/GUIDE.md` unless a file someone else wrote is already there, and it sends no request by itself: the chosen agent reads the repository and writes `.agent-monitor/focus.json`, validating it with the bundled check. The same card then says in plain words whether each area is ready or needs a fix and offers **Approve**, **Copy fix request** (the check's findings and command, ready to paste back to the agent), **View details**, **Edit file** and **Not now**. Only ready areas are approved, only for that exact file content, and only from a trusted local workspace. Any later edit needs review again. Enabled areas join the main grid, score like built-in areas, can be arranged and chosen, and can receive Focus here with their label and description quoted as the user's own definition. **Stop tracking** withdraws them without changing the file. See [custom areas](CUSTOM-AREAS.md).

### Focus request lifecycle

| State                        | Meaning                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Queued                       | Awaiting a supported hook for the exact agent/session/subagent                                             |
| Sent! Task is focusing here… | Marked delivered before hook output; not an agent acknowledgement (the tooltip says so and gives the time) |
| Cancelled                    | Cancelled before delivery                                                                                  |
| Expired                      | Undelivered for more than one hour                                                                         |

A click resolves one known chat in the workspace. With multiple candidates, require a recipient choice; never broadcast. The instruction includes the category meaning and asks the agent to acknowledge the request in its next visible response, state a relevant check, use its existing context, preserve other requirements and verify relevant changes. With no active task, it asks the agent to confirm receipt and ask what to review; cancelled or reverted work must not restart. Acknowledgement is requested, not enforced or detected by the monitor. It does not grant authority to publish, deploy or perform destructive work.

Running chats receive requests at the next supported tool, prompt or stop hook. For a compatible idle Codex IDE chat, the experimental local adapter starts one follow-up with inherited native settings and requires an exact-owner receipt. Claude idle chats with a live native wake listener receive the request through asyncRewake. Other idle chats expose **Queue for next turn**; this does not wake the agent. At Stop, an explicit queued request may continue a turn once with loop protection. Direct and hook delivery share an atomic claim. Unknown outcomes are never retried automatically. Pause blocks delivery. Existing request revisions retain their original scope. See [focus delivery](FOCUS-DELIVERY.md) for compatibility and native verification limits.

## Images

Capture supported image bytes from successful post-tool structured outputs, including MCP/wrapper outputs. Never open paths supplied in tool input or output, including JSON strings and symlinks. Pre-tool, failed and path-only results do not add images. Hide legacy cache entries without tool-output provenance and remove their cache copies on the next collection. Do not fetch HTTP image URLs.

Keep every PNG, JPEG, WebP, GIF, BMP and AVIF image a successful tool returned, at original quality and any size, including animated and very small images, up to 24 MiB each. Show an image directly when it is at most 16 million pixels, 12 MiB and static. Otherwise show a still preview drawn by the view at about 1.5 million pixels, or, above 64 million pixels, a placeholder that decodes nothing. Either way, **View clearer image** opens the original in an editor tab. Header values beyond one million pixels per side are treated as corrupt. Unsupported image-view payloads can produce a not-captured status; this does not prove the host emitted all views.

Show the horizontal thumbnail history above one main image, which has previous/next controls on its left and right edges. Follow latest changes only through its checkbox: browsing leaves it on, and while it is on a newly used image (a different newest image) replaces the view. With it off, new events never replace the viewed image. Relative timestamps are scoped to the chosen chat's observation. Missing cached files remain dismissible. Only the picture itself (or its open control) opens the validated cached copy from this workspace in an editor tab; clicks on the surrounding frame do nothing, and it never opens an arbitrary path.

Images has its own chat selection. Its strip offers All chats and lists only chats that have used a retained image, most recent image use first, plus a selected chat that has none. The tab shows no image total. A red count shows images whose latest use is newer than the last time Images was visible; the first load counts existing images as seen. Opening Images clears the count and outlines those images for three seconds, switching the image selection to All chats if any would otherwise be hidden. The seen marker is per view state and is not shared with agents.

Recent-use markers expire: viewed/referenced after two minutes, and sooner when a subsequent tool moves on or the turn ends. Markers describe observation recency, not continuous model attention.

Dismissal removes the cache copy, not the source. Viewing the source again may add it back. Images otherwise remain until eviction by the global limits.

## Resource limits

| Resource                    | Bound                                      |
| --------------------------- | ------------------------------------------ |
| Retained chats              | 12, with 24-hour metadata lifetime         |
| Focus progress per chat     | One total per area and 32 subjects, kept   |
| Custom areas per folder     | 8, each with bounded signals and examples  |
| Cached workspace profiles   | 12, 256 KiB                                |
| Deduplicated call IDs       | Last 32 hashes per chat                    |
| Evidence per chat           | 16 entries                                 |
| Activity metadata           | 256 KiB                                    |
| Stored images               | 20                                         |
| Per-image bytes             | 24 MiB, any dimensions                     |
| Total image bytes           | 64 MiB                                     |
| Shown directly              | 16 million pixels and 12 MiB, static       |
| Previewed (reduced, still)  | Up to 64 million pixels; placeholder above |
| Image candidates per event  | 20                                         |
| Hook stdin                  | 24 MiB                                     |
| Collector lifetime deadline | 2.5 seconds                                |
| Contention retries          | Six, below 625 ms total wait               |
| Pending requests            | Four per chat                              |
| Retained request records    | 24; records retained up to 24 hours        |
| Pending request lifetime    | One hour                                   |

The collector uses bounded parsing and returns without blocking the agent on collection errors. Limits take precedence over retaining every event. One fixed diagnostic file per adapter records receipt/failure status without raw event bodies. The UI uses a visible-only timer for age text and periodic recency updates, plus one debounced filesystem watcher.

## Non-goals

No transcript tailing or content reading (the only session-file reads are the bounded title-record lookups above), hidden-reasoning capture, token/productivity scoring, autonomous steering, remote relay, hosted-tool interception, model classifier, compliance certification or unlimited retention. Additional runtime support requires an explicit adapter and its own acceptance evidence.

## Chat presentation and area arrangement

Chats means individual agent conversations/sessions, not projects. Distinct session IDs remain separate even in one workspace. Identified subagents are not listed: each is folded into the retained chat with the same agent and native session ID, so its attention samples, evidence, activity, current image and image use count towards that chat, and its image viewers and requests display on that chat. A working subagent keeps its chat Active. A subagent whose parent is not retained stays listed as a subtask so its evidence is not lost. The existing 12-session / 24-hour retention limit still applies, counting subagents; the view is not an unlimited chat archive.

Focus and Images each select scope through a strip of chat cards with a provider mark, agent, age and a title of up to two lines. Focus always has one chat selected, starting with the most recent; there is no All chats view in Focus. Images offers All chats. There is no separate overview list and no chat dropdown. Scrolling does not change selection. Left/Right/Home/End move focus; Enter/Space select. Preserve selection, focus and scroll through data refreshes. Keep a missing selected chat explicit while other chats exist; with no chats at all, show the empty or setup state. Opening Images to show newly used images may switch its selection to All chats. The selected chat's Focus header shows its activity state, last and first-observed ages, subtask, queued-request and image counts, its folder when chats span more than one, and a rename action.

Active is inferred from a recent event and absence of an end event; it is not a runtime heartbeat. First seen is the collector's first observation, not host creation time or execution duration. Native titles are not consistently supplied by hooks. A local Rename chat override (90 sanitised characters) is kept in workspace state and does not rename the host conversation or send context to the agent.

A six-dot handle can be dragged before another area or dropped onto Focused areas / More areas. Clicking or keyboard-activating it opens a native move menu with position and group choices. Layouts store only the thirteen known IDs, partitioned without duplicates. Each chat has an independent layout. Arranging areas changes presentation only; Focus here remains the separate steering action.
