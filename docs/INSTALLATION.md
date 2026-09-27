# Install and connect

Install a locally built VSIX using your editor's **Extensions: Install from VSIX…** command. Agent Monitor opens on startup and shows **Set up** when configuration or tool receipt is missing. The plug icon at the top of the view opens the same setup panel. An agent you do not use can be marked **I don’t use …** so it stops appearing in setup warnings; its hooks are not changed. No marketplace listing is available yet.

The helper requires Node.js 20+. If discovery fails, set `agentMonitor.nodePath` to the absolute Node executable, then connect again. This setting is machine-scoped. A trusted, local workspace is required to change hook settings.

## Locations

| System  | Agent Monitor data                                                  |
| ------- | ------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/agent-monitor/`                      |
| Linux   | `$XDG_DATA_HOME/agent-monitor/`, or `~/.local/share/agent-monitor/` |
| Windows | `%LOCALAPPDATA%\agent-monitor\`                                     |

The directory contains `runtime/` for helper scripts and `cache/` for images, state and pause flags. Codex configuration is `$CODEX_HOME/hooks.json`, default `~/.codex/hooks.json`. Cursor configuration is `~/.cursor/hooks.json`. Claude configuration is `$CLAUDE_CONFIG_DIR/settings.json`, default `~/.claude/settings.json`.

## Events not appearing

Select **Set up** or the plug icon. “Configured · no tool events” means configuration exists; it is not proof an agent has delivered an event. Start a fresh session, ensure the session's working directory is inside an open local workspace, and review Codex’s `/hooks` trust prompts. The **Open Codex** or **Open Claude Code** button opens an editor terminal; the adjacent copy icon copies `/hooks`. Claude Code’s disabled-hook setting is detected and linked to its settings file. Organisation policy or agent hook coverage may prevent delivery. The extension does not bypass either.

After the extension updates, it refreshes an already connected helper when an editor starts, so collection improvements apply without reconnecting. The hook commands are unchanged, so no new trust review is triggered by the refresh itself. A hook definition change may require fresh trust. A changed Node installation may require updating Node Path and reconnecting. The collector does not read old transcripts to fabricate missing activity.

## Startup and removal

`agentMonitor.motion` defaults to `true`; turn it off to show every change instantly. The editor’s Reduce Motion setting and the operating system’s reduced-motion preference also turn motion off.

`agentMonitor.openOnStartup` defaults to `true`. The panel opens once per editor-window activation. Closing it is respected until the next startup. Use **Agent Monitor: Open** to open it manually.

Use **Agent Monitor: Disconnect Agents** before uninstalling. This removes only Agent Monitor's handlers. Existing sessions may retain loaded hooks until they end. The helper and cache remain in application storage, so a retained hook does not point to an uninstalled extension directory. After ending those sessions, remove the Agent Monitor directory if you want to erase cached content and helpers.

Setup rows separate lifecycle-only receipt from actual tool activity. The warning remains until a tool event after configuration has arrived for each configured agent in this workspace. A recent collection failure is shown beside its adapter. The monitor cannot activate host hooks that are disabled by policy or awaiting native trust review. See [coverage](COVERAGE.md).
