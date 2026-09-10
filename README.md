# DeepSeek Harness Terminal

English | [中文](README.zh.md)

![DeepSeek Harness Terminal (dsht)](dsht.png)

## Summary

Choose a workspace and session, chat with a running DeepSeek Harness host, and inspect session history from your terminal. This is an independent Node.js repository: it has its own Git history, dependencies, and tests, and imports no Harness packages.

Main features:

- Workspace and session pickers, direct switching with `/ws` and `/s`, and explicit session creation.
- Streaming replies, reasoning, compact tool names and success/failure status, and paged conversation history.
- Queued prompts, steering, turn cancellation, approvals, and free-text question answers.
- Cookie persistence per host, automatic reconnect, and snapshot replacement.
- JSON or tab-separated workspace/session lists for scripts, plus a reusable HTTP client.
- Session and daily CNY cost estimates, versioned peak/off-peak prices, and `/cost` summaries.

## Contents

- [Start](#start)
- [List workspaces and sessions](#list-workspaces-and-sessions)
- [Conversation controls](#conversation-controls)
- [Live status](#live-status)
- [Cost estimates](#cost-estimates)
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
npx dsht
npx dsht list workspaces --json
npx dsht list sessions --json
```

Use the same `DSH_URL` and first-login `DSH_TOKEN` environment variables. To install the command globally, use `npm install -g dsht`, then run `dsht`. Registry commands require a published package; the source commands above work from this checkout.

Select a workspace with ↑/↓ and Enter, then select a session or **New session**. **All sessions** also exposes sessions outside registered workspaces. **Add workspace** accepts an existing absolute directory on the host, which may differ from your local filesystem. Creating a session requires a selected workspace.

On first login, authentication exchanges `DSH_TOKEN` at `GET /` and saves the cookie per HTTP origin. Later starts, including list commands, reuse that cookie without a token. The store uses `$XDG_STATE_HOME/dsht/auth`, or `~/.local/state/dsht/auth` when unset; `--auth-dir` or `DSHT_AUTH_DIR` overrides it. POSIX directories use 0700 and cookie files use 0600; Windows uses the account directory’s inherited access controls. Launch tokens are never saved.

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

Enter submits a prompt. Ctrl+C requests cancellation while the selected session is running and exits only when it is idle; repeated keys share an in-flight cancellation. Cancellation waits for a pending prompt admission, and failures keep the client open. Esc sends an explicit cancellation from the conversation even when the cached running flag is idle; open menus also cancel a known running agent while closing. Active local history/search/cost loads are cancelled first. Page Up/Down scroll the retained transcript; `/older` loads an earlier page. `/quit` exits directly without cancelling remote work. Cancellation leaves pending queue items intact.

The mouse wheel and Page Up/Down scroll conversation history; scrolling to the top automatically requests an older page. New output preserves a scrolled reading position. `/jump last` resumes following the newest output. Mouse reporting is enabled while the TUI is mounted and disabled on exit; the terminal must support SGR mouse reports. Esc or Ctrl+C cancels a history load or search before interrupting the remote agent.

`/search` matches literal text case-insensitively in displayed messages, including older pages; hidden tool bodies are excluded. `/history` only lists loaded records. Record sequences are the numbers shown by these pickers. `/ssearch` and `/wsearch` call `session/search`, which searches current user/assistant message content and returns at most 20 sessions, snippets, and a truncation flag; it exposes neither a result cursor nor matching record sequences. Workspace filtering happens after that global limit, so a truncated workspace result can omit matches. The UI warns when results are incomplete; refine the query. Selecting a session loads its history and offers matching messages for the jump. These operations use HTTP and never scan the host configuration directory.

The single-line composer supports Readline-style editing. Words are whitespace-delimited; cursor movement and character deletion preserve composed Unicode characters. Multiline pasted text becomes one line with spaces. Ctrl+D on empty input does not exit; Ctrl+C keeps its stop/exit behavior. Other unhandled modifier shortcuts do not insert their control characters. Both BS and DEL terminal backspace encodings delete backward; the dedicated Delete key (CSI 3~) deletes forward.

| Key | Edit |
| --- | --- |
| Ctrl+A / Ctrl+E, Home / End | Move to start / end |
| Ctrl+B / Ctrl+F, ← / → | Move one character |
| Alt+B / Alt+F, Ctrl+← / Ctrl+→ | Move one word |
| Ctrl+K / Ctrl+U | Delete from cursor to end / from start to cursor |
| Ctrl+W, Alt+Backspace | Delete the preceding word |
| Alt+D | Delete the following word |
| Ctrl+Y | Restore the most recently killed text at the cursor |
| Ctrl+H / Backspace, Ctrl+D / Delete | Delete the preceding / following character |

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
| `/history [text]` | List loaded records, optionally filtered; Enter jumps to the selected record |
| `/jump <seq\|first\|last>` | Jump to a visible record sequence, oldest history, or latest output |
| `/search <text>` | Load and search the current session history; choose a matching message to jump |
| `/ssearch <text>` | Search host results within the selected workspace |
| `/wsearch <text>` | Search sessions across all workspaces visible to the host |
| `/allow`, `/deny` | Answer the displayed approval; allow applies once |
| `/status` | Expand or collapse full footer details |
| `/cost` | Toggle session/today/three-day estimates and refresh usage |
| `/help`, `/quit` | Show command hints or exit |

Slash commands work in both pickers and the conversation composer. Typing `/` displays matching commands. The long forms `/workspace`, `/workspaces`, `/session`, and `/sessions` remain aliases. Names may contain spaces; quotes around the complete target are optional. The unquoted target `all` is reserved for `/s all`; use `/s "all"` or an ID to open a session titled `all`. Ambiguous targets require a full ID. Switching a workspace opens its sessions and detaches the old transcript; switching sessions updates the workspace label. Neither operation cancels a remote agent.

Type `@` at the end of the draft to search files and directories in the selected session’s working directory **on the host**. Use ↑/↓ to select and Tab or Enter to insert; selecting a directory continues completion inside it. Paths with spaces use `@"path with spaces"`. Escape closes the menu and requests cancellation when the agent is running; after closing it, Enter sends the literal draft, including an unmatched path. Lookup failures remain visible and do not submit the draft. Completion operates on the trailing reference, not the cursor position inside existing text.

A file reference sends only `@path` in a text block. Harness instructs the model to read the referenced file or list the directory when needed; the TUI does not read local files, upload bytes, or expand contents into the prompt. Referencing an image path does not attach image data. Local attachments, image uploads/previews, and `@` session references are not implemented.

User questions accept typed free-text answers one question at a time. Other sessions' interactions and unrecognized waterfalls delegate with `next`. Failed submissions retain their input; an interrupted HTTP response can leave delivery uncertain, so check the transcript before manually resending. The client never retries a mutation automatically.

The conversation header shows the latest session title, falling back to the ID; `/status` retains the complete session ID. The cancellation acknowledgement stays visible through incoming history until the host reports idle; acceptance does not mean a tool process has already exited.

## Live status

The footer defaults to one borderless line showing activity, model, workspace, context occupancy, and total tokens; wider terminals also show input/output, cache, queue, and job counts. Long names shorten by terminal display width, and narrow terminals omit lower-priority fields first. `/status` toggles full multiline details with the complete path, provider/model, reasoning effort, and usage buckets. `!` flags a metrics or model catalog error whose reason appears in the details. During a run it distinguishes the last-used model from a different next-request selection; a fresh session uses the host catalog default. Model catalog changes refresh on host settings, credential, and adapter notifications.

Working time uses the retained `turn/start` timestamp. If that timestamp is unavailable, `(observed)` means time since this client observed the run; reconnecting can reset this fallback. The clock stops when the host reports idle. The status includes model generation, tool execution, and approval waits, not just streamed text. Offline status is explicitly marked as last known.

Context occupancy is marked `~`: Harness combines provider usage with estimated surface changes and the latest route capacity. Token totals come from the complete session’s `tokenUsage` projection, with separate uncached input, output, cache-read, and cache-write buckets; reasoning is already included in output. Totals update when the host publishes usage, not on every streamed character. Missing measurements display `unknown` or `?`. Control-stream baselines replace state on reconnect, and per-key watermarks prevent an older follow snapshot from overwriting newer metrics.

Tool-only rows omit the separate role heading: `⚙` identifies a call, `✓` a successful result, and `✗` a failed result. Once complete arguments are available, each row shows the tool name and operation description, falling back to its command, path, or query. Results reuse the matching call summary when retained history contains it. Each operation occupies at most one terminal row, with whitespace flattened and long text ellipsized by display width. Other arguments, nested results, and tool output remain hidden. Assistant prose and explicit approval requests remain visible so the user can understand the response and decide whether to approve an action.

## Cost estimates

`/cost` shows the selected session, today, and today plus the preceding two calendar days. Dates use Asia/Shanghai; the three-day view is not a rolling 72-hour window. The status bar reserves `S:` for session cost and `D:` for today. `~` marks an estimate, and `*` marks unpriced requests or incomplete coverage. Each host origin has a separate ledger. Totals cover HTTP-visible sessions and previously cached sessions; they are not account-wide provider bills.

The client reads complete histories in the background on connection, every 60 seconds, at turn completion, and when opening `/cost`. Idle sessions with unchanged host update timestamps are skipped. No model requests are made by billing. Esc or Ctrl+C cancels an explicit refresh. The ledger counts disjoint uncached input, cache read/write and output buckets; reasoning is already part of output. Retries count separately, replacement samples update their attempt, and fork-inherited history is excluded. Missing timestamps, inconsistent usage and unknown prices remain unpriced. Failed scans retain labelled partial cached totals.

The bundled CNY rates were checked against the [official pricing page](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) on 2026-09-10. Beijing weekday peak windows are 09:00–12:00 and 14:00–18:00; other times use half-price rates. Flash peak input/cache-hit/output rates are ¥3/¥0.10/¥9 per million tokens; Pro rates are ¥9/¥0.30/¥27. Separate cache writes use the uncached-input rate. An exact configured model price takes priority; otherwise `deepseek-official` names containing `pro` (case-insensitive) use Pro and all other names use Flash, including temporary model aliases. Other providers require explicit entries.

The default price validity starts at Beijing midnight on the verification date; this is a local estimate policy, not a claim about the official effective date. Earlier usage needs historical price entries. The recorded assistant settlement timestamp selects the rate; requests spanning a tariff boundary may differ from the invoice because the official page does not specify their attribution. Images use provider-reported tokens. Cached priced requests retain their price version when configuration changes; previously unpriced requests can be priced on a later scan.

On first interactive launch, the client creates `~/.config/dsht/prices.json` (or `$XDG_CONFIG_HOME/dsht/prices.json`). `DSHT_CONFIG_DIR` overrides that directory. The JSON array contains price versions with `id`, `provider`, `model`, `currency: "CNY"`, `source`, inclusive `from`, optional exclusive `until`, `timezone`, weekday numbers (`0` Sunday), minute-of-day `windows`, and `peak`/`offPeak` rates named `input`, `cacheRead`, `cacheWrite`, `output`, per million tokens. To update prices, close the old interval with `until` and append a new version with a unique ID and matching `from`; overlapping intervals are rejected. Restart to load configuration changes. Price discovery is manual; the TUI does not scrape prices during startup.

Usage files live under `~/.local/state/dsht/cost/<origin-hash>/` (respecting `XDG_STATE_HOME`, or `DSHT_STATE_DIR` for the application state root). They contain only session IDs, timestamps, model identities, token counts, selected price versions and estimates. They exclude prompts, tool bodies, credentials and cookies. Writes use private temporary files and atomic replacement; opening-cut filenames prevent older concurrent scans from displacing a newer cached cut. The cache survives restart and does not need access to the host configuration directory.

## Client API

Installed packages export `Client` from `dsht` and `login`/`CookieStore` from `dsht/auth`, with TypeScript declarations. Source consumers can import from `src/client.ts` with a TypeScript loader, or from `dist/client.js` after building. `authenticate(token)` exchanges credentials; `connect()` opens one multiplexed socket; `listWorkspaces()` and `listSessions(workspaceId?)` return promises of server rows. `call(endpoint, args, signal?)` preserves host errors as `RemoteError` with `code` and `details`. Always await `close()` in `finally`. Library consumers opt into persistence with `login(client, token, new CookieStore())` from `src/auth.ts`; `Client.authenticate()` itself only retains credentials in memory.

Session and workspace command methods use `{ request: { ... } }` inside `args`; session listing uses `{ _request: {} }`. `$events/result` uses its named arguments directly. Follow snapshots replace retained state after reconnect; durable messages and transient assistant text remain separate. The reader accepts both `event` records and older `chunks` wrappers containing `chunkrow/text-chunks`, `chunkrow/reasoning-chunks`, or `chunkrow/tool-call-chunks`. Hosts without `assistantStream` expose live text through logged chunks; the TUI reconstructs only the unfinished attempt and preserves each packed record’s starting sequence for pagination.

## Publishing to npm

This repository publishes one unscoped public package, `dsht`, from the `mushuanli/dsht` repository. `package.json` is the authority for the fields below.

| Field | Value |
| --- | --- |
| Name and version | `dsht` `0.1.0` |
| Executable | `dsht`, or `npx dsht` without installing |
| Library entries | `dsht` and `dsht/auth` |
| Author | lizlok@gmail.com |
| License | MIT, with the license text in `LICENSE` |
| Repository and issues | [mushuanli/dsht](https://github.com/mushuanli/dsht) |
| Node.js | 22.19 or newer |
| Registry access | public, unscoped |
| Published files | `dist/`, both READMEs, their pairing record, the screenshot, and the license |

Descriptions, keywords, and dependencies live in `package.json`. The following commands are maintainer actions; creating a local package does not publish it.

```sh
npm run test:package
npm login
npm publish --access public
```

`test:package` builds a tarball and runs its CLI through an isolated, offline npm-exec installation using the dependency cache populated by installation, and rejects any packed path outside the published set above. `prepublishOnly` checks types and tests; `prepack` compiles JavaScript and declarations. Source tests, recordings, and local authentication files are excluded.

`publishConfig.access` is `public`, so the unscoped name needs no extra flag. Interactive publishing requires npm account authentication and its publishing verification. See the official [publishing guide](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/) and [npx documentation](https://docs.npmjs.com/cli/npm-exec/). For later releases, increment the package version before publishing. Registry publication is not part of the local validation performed for this repository.

## Development and limitations

```sh
npm test
npm run build
npm run bench:input
node dist/cli.js --help
```

Tests use isolated HTTP/WebSocket hosts, drive the real Ink picker and composer, run the CLI in subprocesses, and project copied Harness v2 workspace-edit and v0 packed-chunk recordings. The repository needs no model credentials for these checks. The recording and expected transcript live under `tests/`; they do not depend on a parent checkout. Live model-provider behavior is not covered by these tests.

Typing reuses history projection and wrapping until the transcript revision or terminal width changes; host updates and older pages invalidate that reuse. `bench:input` measures local input-to-render work with 20 and 500 synthetic messages, 30 measured keystrokes after warmup, and history projection read counts. It excludes network/model time and is a diagnostic, not a machine-independent latency threshold.

The interface presents plain text, reasoning, tool calls, and tool results. Rich plugin cards, file upload, subagent navigation, model selection, and queue editing are not implemented. Reconnect uses bounded exponential backoff with jitter and replaces snapshots; list commands fail directly instead of retrying. Updating pre-stable host APIs requires updating the local wire adapter and tests.
