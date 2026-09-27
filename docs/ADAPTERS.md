# Adding an agent adapter

An adapter receives documented local command-hook events and maps them to Agent Monitor's bounded collector contract. It must not inspect another application's private databases, tail transcripts, scrape hidden reasoning or launch a competing conversation.

## Before implementing

Verify the target host's current hook documentation and version. Record the supported event names, timeout behaviour, identity fields, tool result shape, error representation, trust requirements and output contract. If the host cannot provide stable chat identity, do not offer steering for it.

The existing adapters use these primary references:

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Cursor hooks](https://prod.cursor.com/docs/hooks)

Treat external contracts as version-sensitive. A documented hook does not establish that every hosted tool emits it.

## Normalised event example

This is a synthetic collector input, not a payload to send to a live agent:

```json
{
  "session_id": "example-session",
  "cwd": "/work/example",
  "hook_event_name": "PostToolUse",
  "tool_name": "Read",
  "tool_input": { "file_path": "/work/example/src/auth/session.ts" },
  "tool_response": { "exit_code": 0 }
}
```

`session_id` and `cwd` establish the session. A supported `agent_id` / subagent identity separates children. `tool_input` and `tool_response` are transient parsing inputs; general event bodies are not stored. See `src/adapters.js` for actual mappings and `src/classify.js` for identity construction.

## Integration points

1. Add the adapter name and normalisation in `src/adapters.js`. Recognise failure results and preserve stable identity across turns.
2. Add platform configuration paths in `src/paths.js` and owned hook definitions in `src/setup.js`. Preserve unrelated settings; reject malformed or unsupported schemas.
3. Map supported lifecycle and tool events to the collector. Do not invent missing events or merge unidentified children into parents.
4. Implement steering only with a documented host output contract in `src/steering.js`. Preserve exact targeting, mark-before-output delivery, expiry and stop-loop protection.
5. Add the adapter's setup state and actions in the host/webview. Installed, trusted and receiving are distinct states. Never automate native trust.
6. Update coverage, specification and installation documentation with supported versions and known gaps.

Adding an adapter may require revisiting the fixed diagnostic-file and setup-list bounds. Do not add an unbounded per-session spool or process scanner.

## Required evidence

Use temporary directories and synthetic fixtures. Cover session start/stop, prompt/tool identity across turns, children, failed tools, malformed/oversized input, pause, image formats and unsupported outputs, settings preservation/disconnection, and exact-recipient steering. Prove ordinary events do not emit unsolicited context. If permission responses are mandatory, test those while paused and on failure too.

Then test the real host in a disposable workspace: install hooks, complete native trust, start a session, inspect a supported raster, change a source file, send one focus request and end the turn. Confirm received metadata and output in that exact chat. Record host/editor/OS versions and gaps, without copying real settings, identifiers or transcripts into the repository.

Fixture tests are necessary regression checks. They are not native-host acceptance.
