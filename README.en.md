English | [中文](README.md)

# dsh-seance

Listen before you delete.

`dsh-seance` distills a small set of residual fragments from the logs of **already terminated** subagent sessions in the current project — failed tool calls, abnormal turn endings, the last pieces of an unfinished step, and the last user message — into a "ghost" that can only answer from those fragments. The ghost has no tools, cannot execute tasks, cannot write, and leaves no persistent records; it is destroyed when the conversation ends.

It is not a debugging tool, not an observability dashboard, and not a session cleaner.

The Séance is only about lighting a candle before the deletion.

## Entry point

The only command in the command palette: **`/dsh-seance.summon`**

The palette displays it as 「招魂」; you can also type `/dsh-seance.summon` directly.

Flow:

1. Query sessions under the current working directory with `ctx.sessionQuery.filterSessions`, keeping candidates with `live: false`, `parentSession != null`, and a readable log.
2. If there are no candidates, show "没有可招魂的残留会话" (no residual session to summon).
3. Otherwise, list each candidate in a transient dialog: the subagent title (or a truncated summary of the last `user/message`) and the end reason.
4. After a selection, extract fragments, create the ghost, and start a bounded conversation. Closing the dialog destroys the ghost.

The command is registered in the client command palette (`ctx.commandUi`, `action` kind), so it produces no host `command/run` / `command/done` log entries and never writes the command result into a session.

## Fragment extraction

Only the following are extracted:

| Fragment | Source |
|---|---|
| Failed tool calls | `tool/result` with `message.isError === true` or a `data.error` |
| Abnormal endings | `turn/end` whose `reason.kind` is `interrupted`, `aborted`, `blocked`, `error`, `max-tokens`, or `forked` |
| Last pieces of an unfinished step | `assistant/message` / `assistant/attempt` text after the last unclosed `step/start` through the end of the log |
| What it saw last | The `content` of the last `user/message`, truncated (framework-injected lines such as `Current runtime context.`, `<system-reminder>`, and time samples are skipped) |
| Position | One line about its place in the parent/child chain (parent session id prefix + depth) |

Explicitly excluded: the full conversation history, successful tool results, the full `system/message`, the complete tool schema in `request/header`, and any instruction that would let someone replay the task.

Hard budget: about **800 tokens** of fragments (roughly 3200 characters at 4 characters/token). When over budget, **later events win**; the last `user/message` gets a reserved allowance and is not pushed out by later errors. Fragments are ordered chronologically and become the ghost's initialization context.

## How the ghost is created and constrained

The ghost is **not** a persistent Agent session. In this build `ctx.subagents` only has named providers (spawn/fork); local children always go through `ctx.agents.create`, persist a child session, and append `subagent/catalog` to the parent — which directly conflicts with "the ghost writes no persistent storage and adds no persistent facts". The plugin therefore uses a narrower implementation for the same goal:

- Call `ctx.llm.stream()` directly, with a single user message containing **the fragments + the current question**.
- `system` is a very short echo prompt (no memory, no tools, cannot execute tasks; say "I don't know" when it does not remember).
- **No `tools`, no `toolHistory`, no `sessionId`** — no tool schema and no session write.
- Each question is an independent call; it carries no parent conversation, `AGENTS.md`, or any global context.
- Hard caps on both client and host: **at most 3 questions**; the 4th request is rejected by the host (not left to the model's self-discipline).

If the model still emits a `tool-call-delta`, the plugin aborts that answer immediately.

## Transport and persistence

- The client dialog talks to the host through a same-origin `POST /dsh-seance/api` (`x-dsh-seance: 1` header + `application/json`; cross-site requests are blocked by preflight).
- The host keeps the current ghost only in memory (fragments, question count, AbortController); it writes no files and no sessions.
- Ghost answers are rendered only in the transient dialog; closing the dialog removes the ghost and aborts in-flight requests.
- The summoned original session log is **read-only**: the plugin never cleans, modifies, or "repairs" it.

## Uninstall and cleanup

Everything registered at load time is owned by a Cordis effect:

- The HTTP route is disposed with the `webServer` scope.
- Unloading the plugin aborts all in-flight model requests and clears in-memory ghosts.
- The client command contribution and overlay entry are removed with the client plugin.
- No temporary files and no ghost session are created, so there is nothing extra to delete.

## Client UI dependencies

Only two minimal primitives are used, both noted here:

- `ctx.commandUi.register({ ui: { kind: 'action' } })` (from `@deepseek-ai/dsh-client-ui-commands`) — puts `dsh-seance.summon` in the command palette and opens the dialog directly;
- `ctx.slots.inject('shell.overlay', ...)` — a transient overlay rendered only while the dialog is open.

No sidebar, activity-bar icon, settings page, or resident webview is added; no UI service such as `@deepseek-ai/dsh-client-ui-model-selection` is used.

## Known limitations

- The ghost is one `ctx.llm.stream` completion, not an independent subagent instance; it has no independent session and no lifecycle of its own.
- The `ctx.subagents` + external-provider approach is paused: the built-in spawn goes through `ctx.agents.create`, persists a child session, and appends `subagent/catalog` to the parent — inherently persistence-oriented, conflicting with "the ghost writes no persistent storage".
- Only the command and dialog copy are Chinese; the plugin-list title/description ship en/zh metadata (`locale/en.json`, `locale/zh.json`).
- Web GUI only (it depends on the `shell.overlay` slot); headless/ACP have no command adapter.
- It relies on the current session's model route, or falls back to the default model; there is no separate model picker.
- Answers are not streamed: the full text is returned once generation completes.
- 800 tokens is an approximate budget (4 characters/token, 3200 characters).
- It can only summon child sessions in the current workspace (same cwd); cross-workspace summoning is not supported.
- It does not use spawn; the ghost's lack of tool permissions is structural (no `tools` in the request), not a configuration.

## Requirements

DeepSeek Harness `>=0.2.2-rc.1`; currently verified only on `0.2.2-rc.1`.

## Installation

### Install a local package from a Harness session (the verified path)

`plugin_manager` is an Agent tool inside a Harness session, not a shell command. In the session, call:

- `plugin_manager install_bundle`, with `target` set to the absolute path of the package directory (for example `/absolute/path/to/dsh-seance`).

After installation, `/dsh-seance.summon` appears in the command palette.

### Install from npm

```bash
npm install dsh-seance
```

`npm install` only adds the package to your dependencies; to enable it in the current profile, install the local package through the plugin manager in a Harness session:

- `plugin_manager install_bundle`, with `target` pointing to the absolute path of `node_modules/dsh-seance`.

### Uninstall

In a Harness session, call:

- `plugin_manager remove_bundle`, with `target` set to `dsh-seance`.
- To disable/enable the row separately: `plugin_manager set_plugin`, with `target` set to `include:dsh-seance`.

## Verification

Host-side, you can verify with a same-origin request (install and activate first):

```bash
curl -s -X POST http://127.0.0.1:<port>/dsh-seance/api \
  -H 'content-type: application/json' \
  -H 'x-dsh-seance: 1' \
  -d '{"op":"candidates","parentSessionId":"<current session id>"}'
```

Unit tests (fragment extraction + client render smoke):

```bash
npm test
```

## License

MIT — see [LICENSE](LICENSE).
