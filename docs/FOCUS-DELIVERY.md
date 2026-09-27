# Focus delivery

A click is the instruction. Agent Monitor never asks users to type a filler message.

## Provider behaviour

| Provider and state                                                 | Delivery                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Codex, idle local chat, verified macOS IDE version                 | One follow-up turn through the existing chat owner's local IPC connection. Experimental.   |
| Codex, Claude Code or Cursor, running chat                         | Queue for the next supported tool/prompt/stop hook in that exact chat.                     |
| Claude Code, idle macOS chat with a live native wake listener      | Wake the same session through its approved asyncRewake hook. Experimental.                 |
| Other idle chats, unsupported versions or missing routing metadata | **Queue for next turn**, explicitly labelled before queueing. This does not wake the chat. |

For a multi-chat selection, the native picker chooses one recipient. If that chat cannot receive an immediate request, the user chooses whether to queue it. Subagents never fall back to their parent. Queued requests can be cancelled. Once dispatch begins, delivery is at-most-once and cannot be recalled.

**Sending** means dispatch is in progress. **Accepted** requires an exact-owner turn receipt; it does not mean the agent completed the requested review. **Sent! Task is focusing here…** (“Sent to hook” before 0.14.0) means output was emitted to the provider hook; its tooltip gives the time and says the agent has not confirmed it. **Delivery unconfirmed** means the connection failed after the request was claimed; check the chat before sending again. There is no automatic retry or silent hook fallback after an uncertain direct send.

## Codex connection

The documented [app-server protocol](https://learn.chatgpt.com/docs/app-server) provides thread and turn operations. The IDE does not export its running app-server connection through its public extension commands. Instead, the installed IDE has a local IPC router that discovers the owning client and forwards a start-turn request to that client.

`src/codex-ipc.js` implements the minimal client: initialise, discover exact owner, start one turn, validate the receipt, close. It is restricted to macOS and Codex IDE `26.5917.51856`. This is an **internal compatibility interface**, not a vendor-supported public extension API. Other versions are disabled until reverified. No provider files or permission settings are patched.

The socket and parent directory must be private and owned by the current user. A connection lasts at most seven seconds, incoming frames are limited to 2 MiB and outgoing messages to 16 KiB. The host permits one in-flight connection. Deactivation aborts it. No server, daemon, extra agent process, transcript scan or polling loop is started. Unsolicited broadcasts are discarded.

Native chat identity comes from the provider hook and stays in private collector metadata; it is excluded from webview messages. The host rechecks trusted local workspace membership and atomically claims the request against current identity, status, pause state and subagent identity. The owner retains the chat's model and native permission settings. The text payload includes the IDE's required empty text-element and attachment collections; missing UI metadata can otherwise cause a rendering error even when the server accepts the turn.

## Claude Code and Cursor findings

The installed Claude Code IDE editor-open command accepts session and initial-prompt arguments, but an already open panel can ignore the prompt. Its local IDE MCP server offers editor operations, not exact-chat submission. Opening a panel is not a delivery receipt.

Claude's documented [`asyncRewake` hook](https://code.claude.com/docs/en/hooks) wakes an idle session when its background hook exits with code 2. Agent Monitor installs one optional macOS Stop listener using this contract. A short Node helper prepares a private FIFO; a sleeping Bash process waits for one explicit request ID. Node runs again only to validate, mark and emit that request. No model session, daemon or polling loop is created.

Listeners are limited to one per chat, twelve globally and one hour each. The native hook timeout is 3,610 seconds; Bash's read timeout is 3,600 seconds. Pause, disconnect and session end cancel ready listeners. The provider also owns their process lifetime. Startup uses five bounded lock attempts to tolerate the ordinary collector running concurrently. Subagent listeners are excluded. A later Stop can prepare another listener, including after a user-requested wake; this emits no instruction unless another explicit click arrives. Hook receipt shows **Sent! Task is focusing here…**, which is not proof of model acknowledgement. If there is no live listener, the interface offers the explicit queue fallback. Native hook trust and organisation policy still apply.

Both a disposable streaming CLI session and a disposable Claude IDE chat accepted a Performance request while idle and replied `FOCUS_RECEIVED` without an additional user message. The IDE test preserved its earlier `READY` exchange and existing permission mode. Cross-platform and other-version behaviour remain unverified. [Channels](https://code.claude.com/docs/en/channels) were also considered; they require explicit session startup and native allowlisting and are not used here.

[Cursor stop hooks](https://cursor.com/docs/hooks) return follow-ups when a running turn ends; this remains the implemented path for active Cursor chats. Further inspection found the native **Desktop Bridge**: an authenticated HTTP-over-local-socket endpoint exposes `listThreads` and `sendMessage` with exact thread IDs. Its renderer rejects draft and Claude Code threads. The bridge reports submission/queueing before the asynchronous model operation completes, so native rendering and subsequent activity still need verification.

The bridge starts only when Cursor's `desktop_bridge` rollout gate and the user's **Beta → Desktop Bridge → Allow CLI to access desktop agents** setting are enabled. Cursor requires restart after changing that setting. The inspected installation had the rollout gate disabled and no discovery socket. Agent Monitor does not edit that gate, extract private renderer tokens, patch provider files or restart active chats. Direct Cursor delivery therefore remains unavailable in this release. This is a concrete native availability restriction, not a missing target ID. Once the feature is available, validate the native bridge and preservation of existing drafts before enabling an adapter.

The common interaction and status rules apply across providers. Immediate idle delivery is implemented for the verified Codex configuration and Claude chats with a live wake listener; do not claim Cursor parity while its bridge cannot be exercised.

## Verification and remaining coverage

A disposable Codex chat in Cursor on macOS received a direct follow-up while idle and visibly replied `CONTINUED`, retaining its earlier `READY` exchange. A separate user chat stayed active during the test. The corrected payload rendered successfully. An earlier test with incomplete text metadata returned a receipt but caused a panel rendering failure; it was rejected as acceptance evidence and corrected before packaging.

Synthetic tests cover framing, exact recipient and receipt, inherited settings, timeout without retry, cancellation, duplicate claims, hook/direct races, stale dispatch, changed identities, pause and subagents. These do not prove native permission prompts, multiple editor workspaces, remote hosts, other extension versions or cross-platform behaviour. Active delivery continues to use hooks rather than an unverified steer payload. Keep this adapter experimental until the broader native-host matrix is covered.
