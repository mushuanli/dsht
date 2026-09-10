# DeepSeek Harness HTTP TUI

English | [中文](README.zh.md)

## Summary

Choose a workspace and session, chat with a running DeepSeek Harness host, and inspect session history from your terminal. This is an independent Node.js repository: it has its own Git history, dependencies, and tests, and imports no Harness packages.

Main features:

- Workspace and session pickers, direct switching with `/ws` and `/s`, and explicit session creation.
- Streaming replies, reasoning, tool calls/results, and paged conversation history.
- Queued prompts, steering, turn cancellation, approvals, and free-text question answers.
- Cookie persistence per host, automatic reconnect, and snapshot replacement.
- JSON or tab-separated workspace/session lists for scripts, plus a reusable HTTP client.

## Contents

- [Start](#start)
- [List workspaces and sessions](#list-workspaces-and-sessions)
- [Conversation controls](#conversation-controls)
- [Client API](#client-api)
- [Publishing to npm](#publishing-to-npm)
- [Development and limitations](#development-and-limitations)

## Start

Use Node.js 22.19 or newer and an existing `dsh web` server. Copy the token from the URL printed by that server; the server is a separate prerequisite and is not launched by this client.

```sh
npm ci --ignore-scripts
export DSH_URL=http://127.0.0.1:3080
read -rs -p 'Host token: ' DSH_TOKEN; export DSH_TOKEN; echo
npm start
```

After this package is published to npm, run it without cloning or building:

```sh
npx dsh-http-tui
npx dsh-http-tui list workspaces --json
npx dsh-http-tui list sessions --json
```

Use the same `DSH_URL` and first-login `DSH_TOKEN` environment variables. To install the command globally, use `npm install -g dsh-http-tui`, then run `dsh-tui`. Registry commands require a published package; the source commands above work from this checkout.

Select a workspace with ↑/↓ and Enter, then select a session or **New session**. **All sessions** also exposes sessions outside registered workspaces. **Add workspace** accepts an existing absolute directory on the host, which may differ from your local filesystem. Creating a session requires a selected workspace.

On first login, authentication exchanges `DSH_TOKEN` at `GET /` and saves the cookie per HTTP origin. Later starts, including list commands, reuse that cookie without a token. The store uses `$XDG_STATE_HOME/dsh-http-tui/auth`, or `~/.local/state/dsh-http-tui/auth` when unset; `--auth-dir` or `DSH_TUI_AUTH_DIR` overrides it. POSIX directories use 0700 and cookie files use 0600; Windows uses the account directory’s inherited access controls. Launch tokens are never saved.

The host determines cookie expiration. An expired or rejected cookie requires `DSH_TOKEN` again; a supplied token refreshes authentication automatically after HTTP 401. Network failures and HTTP 403 do not trigger token exchange. Corrupt or insecure cookie files fail explicitly. The base URL must be an origin without a path or query, and the host must allow its hostname.

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
| `/ws` | Show all workspaces; choosing one opens its session list |
| `/ws TARGET` | Select a workspace by ID, exact name/path, or unique ID prefix |
| `/s` | Show sessions in the current workspace; choose a workspace first if none is selected |
| `/s TARGET` | Open a session by ID, exact title, or unique ID prefix across workspaces |
| `/s all` | Show sessions from every workspace |
| `/new` | Create a session in the selected workspace |
| `/cancel` | Cancel the active turn; leave pending queue items intact |
| `/steer TEXT` | Submit steering input |
| `/older` | Load older history |
| `/allow`, `/deny` | Answer the displayed approval; allow applies once |
| `/help`, `/quit` | Show command hints or exit |

Slash commands work in both pickers and the conversation composer. Typing `/` displays matching commands. The long forms `/workspace`, `/workspaces`, `/session`, and `/sessions` remain aliases. Names may contain spaces; quotes around the complete target are optional. The unquoted target `all` is reserved for `/s all`; use `/s "all"` or an ID to open a session titled `all`. Ambiguous targets require a full ID. Switching a workspace opens its sessions and detaches the old transcript; switching sessions updates the workspace label. Neither operation cancels a remote agent.

User questions accept typed free-text answers one question at a time. Other sessions' interactions and unrecognized waterfalls delegate with `next`. Failed submissions retain their input; an interrupted HTTP response can leave delivery uncertain, so check the transcript before manually resending. The client never retries a mutation automatically.

## Client API

Installed packages export `Client` from `dsh-http-tui` and `login`/`CookieStore` from `dsh-http-tui/auth`, with TypeScript declarations. Source consumers can import from `src/client.ts` with a TypeScript loader, or from `dist/client.js` after building. `authenticate(token)` exchanges credentials; `connect()` opens one multiplexed socket; `listWorkspaces()` and `listSessions(workspaceId?)` return promises of server rows. `call(endpoint, args)` preserves host errors as `RemoteError` with `code` and `details`. Always await `close()` in `finally`. Library consumers opt into persistence with `login(client, token, new CookieStore())` from `src/auth.ts`; `Client.authenticate()` itself only retains credentials in memory.

Session and workspace command methods use `{ request: { ... } }` inside `args`; session listing uses `{ _request: {} }`. `$events/result` uses its named arguments directly. Follow snapshots replace retained state after reconnect; durable messages and transient assistant text remain separate. The reader accepts both `event` records and older `chunks` wrappers containing `chunkrow/text-chunks`, `chunkrow/reasoning-chunks`, or `chunkrow/tool-call-chunks`. Hosts without `assistantStream` expose live text through logged chunks; the TUI reconstructs only the unfinished attempt and preserves each packed record’s starting sequence for pagination.

## Publishing to npm

The package name is `dsh-http-tui`; its executable is `dsh-tui`. Before publishing, ensure your npm account can publish this name, or change it to your own scope. Select an appropriate license before distributing the code. The following commands are maintainer actions; creating a local package does not publish it.

```sh
npm run test:package
npm login
npm publish --access public
```

`test:package` builds a tarball and runs its CLI through an isolated, offline npm-exec installation using the dependency cache populated by installation. `prepublishOnly` checks types and tests; `prepack` compiles JavaScript and declarations. The package includes `dist/`, the two READMEs, and their pairing record; source tests, recordings, and local authentication files are excluded.

Interactive publishing requires npm account authentication and its publishing verification. See the official [publishing guide](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/) and [npx documentation](https://docs.npmjs.com/cli/npm-exec/). For later releases, increment the package version before publishing. Registry publication is not part of the local validation performed for this repository.

## Development and limitations

```sh
npm test
npm run build
node dist/cli.js --help
```

Tests use isolated HTTP/WebSocket hosts, drive the real Ink picker and composer, run the CLI in subprocesses, and project copied Harness v2 workspace-edit and v0 packed-chunk recordings. The repository needs no model credentials for these checks. The recording and expected transcript live under `tests/`; they do not depend on a parent checkout. Live model-provider behavior is not covered by these tests.

The interface presents plain text, reasoning, tool calls, and tool results. Rich plugin cards, file upload, subagent navigation, model selection, and queue editing are not implemented. Reconnect uses bounded exponential backoff with jitter and replaces snapshots; list commands fail directly instead of retrying. Updating pre-stable host APIs requires updating the local wire adapter and tests.
