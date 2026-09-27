'use strict';
const AGENTS = Object.freeze({ codex: 'Codex', claude: 'Claude', cursor: 'Cursor' });
const CURSOR_EVENTS = Object.freeze({
  sessionStart: 'SessionStart',
  sessionEnd: 'SessionEnd',
  beforeSubmitPrompt: 'UserPromptSubmit',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  postToolUseFailure: 'PostToolUseFailure',
  subagentStart: 'SubagentStart',
  subagentStop: 'SubagentStop',
  stop: 'Stop',
});
function parse(value) {
  if (typeof value === 'string' && value.length < 24 * 1024 * 1024 && /^[\s]*[\[{]/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {}
  }
  return value;
}
function normalize(raw, agent) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.hasOwn(AGENTS, agent))
    return null;
  if (agent !== 'cursor') return { ...raw, tool_response: parse(raw.tool_response) };
  // Event names come from the host; never resolve them through the object prototype.
  const event = Object.hasOwn(CURSOR_EVENTS, raw.hook_event_name)
    ? CURSOR_EVENTS[raw.hook_event_name]
    : null;
  if (!event) return null;
  const child = raw.subagent_id || raw.agent_id;
  // Never merge an unidentified child into its parent's row or steering target.
  if (event.startsWith('Subagent') && !child) return null;
  return {
    session_id: raw.parent_conversation_id || raw.conversation_id,
    cwd: raw.cwd || (raw.workspace_roots?.length === 1 ? raw.workspace_roots[0] : undefined),
    agent_id: child,
    agent_type: raw.subagent_type || raw.agent_type,
    hook_event_name: event,
    tool_name: raw.tool_name === 'Shell' ? 'Bash' : raw.tool_name,
    tool_input: parse(raw.tool_input),
    tool_response: parse(raw.tool_output),
    prompt: raw.prompt,
    stop_hook_active: !!raw.loop_count,
    status: raw.status,
    model: raw.model_id || raw.model,
    tool_use_id: raw.tool_use_id,
  };
}
function failed(event) {
  const out = event.tool_response;
  return (
    event.hook_event_name === 'PostToolUseFailure' ||
    out?.isError === true ||
    [out?.exit_code, out?.exitCode].some((n) => typeof n === 'number' && n !== 0)
  );
}
module.exports = { AGENTS, CURSOR_EVENTS, normalize, failed };
