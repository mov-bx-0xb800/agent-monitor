# Collection coverage

Status: local preview. Installed configuration, native trust, event delivery, classification and steering acceptance are separate checks.

| Adapter      | Observed inputs                                                                   | Steering output                                                                       |
| ------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Codex        | Local session, prompt, tool, subagent, stop and interrupt hooks                   | Additional context at a supported tool/prompt hook; one explicit continuation at Stop |
| Claude Code  | Session, prompt, tool success/failure, subagent and stop hooks                    | Additional context at a supported tool/prompt hook; one explicit continuation at Stop |
| Cursor Agent | Session, prompt, generic tool success/failure, identified subagent and stop hooks | Additional context after a tool; one follow-up after a completed Stop                 |

These contracts have synthetic collector and subprocess tests. Live end-to-end receipt and steering acceptance must be established separately for each installed host/version. Adding a new adapter is required for another runtime; installing this extension does not expose every AI application.

Codex requires review of non-managed hook definitions. Its code-mode nested tools use the local hook path, but hosted tools such as web search and some specialised paths do not. See [Codex hooks](https://learn.chatgpt.com/docs/hooks).

Claude child tool events identify the subagent. Agent policies can restrict hook execution. See [Claude Code hooks](https://code.claude.com/docs/en/hooks).

Tool names are normalised across hosts: Claude Code (Read, Edit, Write, MultiEdit, NotebookEdit, Grep, Glob, Bash), Codex (apply_patch, shell, exec_command, view_image, update_plan), Cursor (read_file, edit_file, search_replace, delete_file, list_dir, grep, codebase_search, run_terminal_cmd) and file-oriented MCP tools. Coordination tools such as subagent launches, questions and output polling are not counted as work. Unrecognised tools are recorded as generic activity, classified only by their name. Cursor generic tool hooks provide JSON tool results. Agent hooks are separate from Tab completions and cloud execution; neither is supported by this local preview. A child event without a usable identity is rejected. See [Cursor hooks](https://prod.cursor.com/docs/hooks).

## Image coverage

- Structured image bytes from successful post-tool results, including MCP and wrapper outputs. Path-only image results and pre-tool events are intentionally excluded.
- PNG, JPEG, WebP, GIF, BMP and AVIF, including animated and very small images. Up to 20 candidates per event; byte and cache limits apply. Formats an editor cannot display (such as TIFF and HEIC) and vector images are not captured.
- A script that merely mentions a path, an HTTP image URL, a hosted result without pixels, an unsupported format or an oversized payload is not a captured view.
- Images from one event retain their chat association. Later activity clears the recent-use marker, not the cached image.

## Failure visibility and limits

Connections show configuration, lifecycle-only receipt or the last tool event. A recent diagnostic warning identifies rejected input, a cache error, timeout or lock contention beyond the bounded retry window. An image-view event without a supported image payload is labelled as not captured. These are observations, not a guarantee that the host emitted every event.

No transcript tailer, continuous process scanner, background server, model classifier or automatic steering loop is used. Limits deliberately take precedence over retaining every event under overload. Three bounded diagnostic files record the latest failure without recording private event bodies. Native host policy/trust can prevent the collector from running at all; then only the absence of events is observable.
