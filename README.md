# DeepSeek Harness HTTP TUI

English | [中文](README.zh.md)

## Summary

Choose a workspace and session, chat with a running DeepSeek Harness host, and inspect session history from your terminal. This is an independent Node.js repository: it has its own Git history, dependencies, and tests, and imports no Harness packages.

## Contents

- [Start](#start)
- [List workspaces and sessions](#list-workspaces-and-sessions)
- [Conversation controls](#conversation-controls)
- [Client API](#client-api)
- [Development and limitations](#development-and-limitations)

## Start

Use Node.js 22.19 or newer and an existing `dsh web` server. Copy the token from the URL printed by that server; the server is a separate prerequisite and is not launched by this client.

```sh
npm ci --ignore-scripts
export DSH_URL=http://127.0.0.1:3080
read -rs -p 'Host token: ' DSH_TOKEN; export DSH_TOKEN; echo
npm start
```

Select a workspace with ↑/↓ and Enter, then select a session or **New session**. **All sessions** also exposes sessions outside registered workspaces. **Add workspace** accepts an existing absolute directory on the host, which may differ from your local filesystem. Creating a session requires a selected workspace.

Authentication exchanges `DSH_TOKEN` at `GET /` for an in-memory cookie. The base URL must be an origin without a path or query. The host must allow the requested hostname; HTTP 401 indicates failed authentication and 403 indicates a host/origin trust failure. No token or cookie is written to disk.

## List workspaces and sessions

```sh
npm start -- list workspaces --json
npm start -- list sessions --json
npm start -- list sessions --workspace WORKSPACE_ID --json
```

For scripts, invoke the source entry directly to avoid npm's script banners:

```sh
node --import tsx src/cli.tsx list workspaces --json
node --import tsx src/cli.tsx list sessions --json
```

JSON output is `{ "items": [...] }`; omit `--json` for tab-separated output. Workspace filtering uses the host's `sessionIds` membership. The workspace list consumes and cancels the first `workspace/follow` baseline; it does not call a nonexistent `workspace/list` endpoint.

## Conversation controls

Enter submits a prompt. Escape requests cancellation of the active turn. Page Up/Down scroll the retained transcript; `/older` loads an earlier page. Ctrl+C exits the client without cancelling the remote agent.

| Command | Action |
| --- | --- |
| `/sessions`, `/workspaces` | Refresh lists and open a picker |
| `/new` | Create a session in the selected workspace |
| `/cancel` | Cancel the active turn; leave pending queue items intact |
| `/steer TEXT` | Submit steering input |
| `/older` | Load older history |
| `/allow`, `/deny` | Answer the displayed approval; allow applies once |
| `/help`, `/quit` | Show command hints or exit |

User questions accept typed free-text answers one question at a time. Other sessions' interactions and unrecognized waterfalls delegate with `next`. Failed submissions retain their input; an interrupted HTTP response can leave delivery uncertain, so check the transcript before manually resending. The client never retries a mutation automatically.

## Client API

Import `Client` from `src/client.ts` with a TypeScript loader, or from `dist/client.js` after building. `authenticate(token)` exchanges credentials; `connect()` opens one multiplexed socket; `listWorkspaces()` and `listSessions(workspaceId?)` return promises of server rows. `call(endpoint, args)` preserves host errors as `RemoteError` with `code` and `details`. Always await `close()` in `finally`.

Session and workspace command methods use `{ request: { ... } }` inside `args`; session listing uses `{ _request: {} }`. `$events/result` uses its named arguments directly. Follow snapshots replace retained state after reconnect; durable messages and transient assistant text remain separate.

## Development and limitations

```sh
npm test
npm run build
node dist/cli.js --help
```

Tests use isolated HTTP/WebSocket hosts, drive the real Ink picker and composer, run the CLI in subprocesses, and project a copied Harness v2 workspace-edit recording. The repository needs no model credentials for these checks. The recording and expected transcript live under `tests/`; they do not depend on a parent checkout. Live model-provider behavior is not covered by these tests.

The interface presents plain text, reasoning, tool calls, and tool results. Rich plugin cards, file upload, subagent navigation, model selection, persistent authentication, and queue editing are not implemented. Reconnect uses bounded exponential backoff with jitter and replaces snapshots; list commands fail directly instead of retrying. Updating pre-stable host APIs requires updating the local wire adapter and tests.
