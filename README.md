# DeepSeek Harness Terminal

English | [中文](README.zh.md)

![DeepSeek Harness Terminal (dsht)](dsht.png)

> **dsht — Control DeepSeek Harness from any terminal, anywhere.**

## Summary

`dsht` is a lightweight DeepSeek Harness TUI client designed for remote use.

Its goal is to fit DeepSeek Harness naturally into the terminal and SSH workflows a developer already has: Harness keeps running on a remote workstation or server while you reconnect from a laptop, tablet, or phone to check status, send a message, steer a task, answer an approval, answer a question, cancel a turn, or switch sessions.

A typical setup:

```text
phone / tablet / laptop
        │
        │ SSH
        ▼
   jump host / bastion
        │
        │ SSH
        ▼
   development host
        │
        ├── dsht
        │     │
        │     ▼
        │   dsh web
        │     │
        │     ▼
        └── DeepSeek Harness
```

`dsht` **is not an SSH client**. It runs in an ordinary terminal, so it works directly inside SSH, nested SSH, ProxyJump/bastion, tmux, and similar remote terminal environments. Whenever your terminal can reach the host running `dsht`, you keep controlling the same DeepSeek Harness sessions.

Besides remote control, `dsht` tracks usage for cost control: it records token usage per request, separates uncached input, cache read, cache write, and output, and combines the model, the settlement time, peak/off-peak rates, and versioned price tables into a CNY estimate for the current session, today, and the last three calendar days.

Main features:

- **Remote-first**: built for SSH, nested SSH, bastion hosts, ProxyJump, and tmux.
- **Phone-friendly**: one working mobile SSH client is enough to keep controlling a remote Harness away from your desk.
- Workspace and session pickers, direct switching with `/ws` and `/s`, and explicit session creation.
- Streaming replies, reasoning, compact tool names, success/failure status, and paged conversation history.
- Queued prompts, steering, turn cancellation, approvals, and free-text question answers.
- Cookie persistence per host, automatic reconnect, and snapshot replacement, so control survives a dropped connection.
- JSON or tab-separated workspace/session lists for scripts, plus a reusable HTTP client.
- **Cost-aware**: session, today, and three-day CNY estimates with versioned peak/off-peak prices and `/cost` summaries.

## Why use dsht?

### Built for remote control

DeepSeek Harness usually runs on a development workstation or server with more performance and a more complete environment, while the person is not always sitting at that machine.

`dsht` keeps the control interface in a plain terminal, so the remote server needs no desktop environment and a phone needs no full development setup. Leave Harness working on the development host and, when you need to look or intervene, enter that host over the SSH path you already have and run `dsht`.

The simplest form:

```text
laptop ───────── SSH ────────> development host ──> dsht
```

Through a jump host:

```text
phone ── SSH ──> jump host ── SSH ──> development host ──> dsht
```

This makes "control Harness from the phone in your hand" a practical workflow: no remote desktop, and no need to expose the Harness web service on the public internet.

> SSH tunnels, ProxyJump, bastion hosts, and access control stay the responsibility of your existing SSH environment; `dsht` focuses on terminal interaction with DeepSeek Harness.

### Keep controlling tasks from a phone

Mobile sessions are poor for long editing work but well suited to control and decisions.

After SSHing from a phone into the remote terminal running `dsht`, you can:

- watch running tasks and live output;
- read assistant replies, reasoning, and tool status;
- send a new prompt or a `/steer` instruction;
- approve with `/allow` or reject with `/deny`;
- answer questions Harness asks;
- stop the current turn with `/cancel`;
- switch workspaces and sessions;
- search history;
- check the current task and recent cost with `/cost`.

Leaving your desk therefore does not mean losing control of a long-running Harness task.

### More than a log viewer

`dsht` is an interactive control surface for a running DeepSeek Harness, not a read-only log tool.

It can send input, handle approvals and questions, steer a running task, cancel a turn, switch sessions, and reconnect after the network returns. Execution state stays on the host; the client only presents and controls it through the terminal.

### Cost awareness

Long AI coding tasks keep consuming tokens, and a token total alone says little about what they cost.

`dsht` stores usage per request and combines it with the request settlement time, the model identity, and the matching price version. Its totals separate:

```text
uncached input
cache read
cache write
output
```

`/cost` shows:

```text
current session
today
today + the previous two calendar days
```

The status bar also keeps showing session cost `S:` and today's cost `D:`, so cost changes surface while a task runs instead of only after the invoice arrives.

That gives `dsht` two roles at once:

1. **a remote terminal control surface for DeepSeek Harness**
2. **a cost monitor for the work as it happens**

## Contents

- [Why use dsht?](#why-use-dsht)
- [Start](#start)
- [Remote SSH workflows](#remote-ssh-workflows)
- [List workspaces and sessions](#list-workspaces-and-sessions)
- [Conversation controls](#conversation-controls)
- [Live status](#live-status)
- [Cost estimates](#cost-estimates)
- [Client API](#client-api)
- [Publishing to npm](#publishing-to-npm)
- [Development and limitations](#development-and-limitations)

## Start

Use Node.js 22.19 or newer and an existing `dsh web` server; the server is a separate prerequisite and is not launched by this client. The default host is the local `http://127.0.0.1:3080`:

```sh
npx @itookit/dsht
```

A token is needed only on the first run and after the saved cookie expires. Export it on its own, or export the complete URL printed by `dsh web` and let the client split off its `?token=` parameter:

```sh
export DSH_TOKEN=<token> && npx @itookit/dsht
export DSH_URL='http://127.0.0.1:3080/?token=<token>' && npx @itookit/dsht
```

`DSH_TOKEN` takes precedence when both are set, and `--url` overrides `DSH_URL` for one run. The token is never written to disk; only the resulting cookie is. Both exports above land in your shell history, so use `read -rs -p 'Host token: ' DSH_TOKEN` where that matters. Another host needs its own origin in `DSH_URL`.

`npx @itookit/dsht list workspaces --json` and `npx @itookit/dsht list sessions --json` print workspace and session lists for scripts, and `npm install -g @itookit/dsht` installs the `dsht` command. These registry commands require the package to be published.

From a source checkout, install the dependencies and run the TypeScript entry:

```sh
npm ci --ignore-scripts
npm start
```

Both paths read the same `DSH_URL` and `DSH_TOKEN` variables.

Select a workspace with ↑/↓ and Enter, then select a session or **New session**. **All sessions** also exposes sessions outside registered workspaces. **Add workspace** accepts an existing absolute directory on the host, which may differ from your local filesystem. Creating a session requires a selected workspace.

On first login, authentication exchanges the token at `GET /` and saves the cookie per HTTP origin. Later starts, including list commands, reuse that cookie without a token. The store uses `$XDG_STATE_HOME/dsht/auth`, or `~/.local/state/dsht/auth` when unset; `--auth-dir` or `DSHT_AUTH_DIR` overrides it. POSIX directories use 0700 and cookie files use 0600; Windows uses the account directory's inherited access controls. Launch tokens are never saved.

The host determines cookie expiration. An expired or rejected cookie requires a token again; a supplied token refreshes authentication automatically after HTTP 401. Network failures and HTTP 403 do not trigger token exchange. Corrupt or insecure cookie files fail explicitly. The base URL must be an origin without a path or extra query parameters, and the host must allow its hostname.

## Remote SSH workflows

`dsht` is at its best combined with existing SSH infrastructure. It requires neither a DeepSeek Harness exposed to the public internet nor a client device that can reach `dsh web` directly.

### SSH straight to the development host

When the development host accepts SSH directly:

```text
Laptop / Phone
      │
      │ SSH
      ▼
Development Host
      │
      ├── dsht
      └── dsh web
```

Log in to the remote host and run:

```sh
dsht
```

Or without a global install:

```sh
npx @itookit/dsht
```

### Through a jump host

When the development host is reachable only through a jump host:

```text
Phone
  │
  │ SSH
  ▼
Jump Host
  │
  │ SSH / ProxyJump
  ▼
Development Host
  │
  ├── dsht
  └── dsh web
```

With an existing OpenSSH `ProxyJump` configuration, SSH to the target development host as usual and run:

```sh
dsht
```

`dsht` does not need to understand that SSH path; from its point of view it simply runs in a terminal that can reach `dsh web`.

### With tmux

On a remote host, `dsht` can live in a tmux session so that a dropped network still leaves the same terminal environment behind:

```sh
tmux new -s dsht
dsht
```

Then, after logging in again:

```sh
tmux attach -t dsht
```

Even without tmux the Harness session state stays on the server, and a restarted `dsht` can select the same workspace and session again. The value of tmux is keeping the local terminal layout and the running TUI process.

### Phone access

Any mobile terminal that can use SSH is a usable entry point:

```text
Mobile SSH Client
       │
       ▼
   Jump Host
       │
       ▼
Development Host
       │
       ▼
      dsht
```

The experience depends on how well the mobile terminal supports ANSI, Unicode, arrow keys, and SGR mouse reports. Even with limited touch mouse support, the core operations remain available through the keyboard and slash commands.

## List workspaces and sessions

```sh
npx @itookit/dsht list workspaces --json
npx @itookit/dsht list sessions --json
npx @itookit/dsht list sessions --workspace WORKSPACE_ID --json
```

From a source checkout, run the same commands through npm or through the source entry; the direct entry avoids npm's script banners:

```sh
npm start -- list workspaces --json
npm start -- list sessions --json
node --import tsx src/cli.tsx list workspaces --json
node --import tsx src/cli.tsx list sessions --json
```

JSON output is `{ "items": [...] }`; omit `--json` for tab-separated output. Workspace filtering uses the host's `sessionIds` membership. The workspace list consumes and cancels the first `workspace/follow` baseline; it does not call a nonexistent `workspace/list` endpoint.

## Conversation controls

Enter submits a prompt. Ctrl+C clears a non-empty draft first; otherwise it requests cancellation while the selected session is running and exits only when it is idle; repeated keys share an in-flight cancellation. Cancellation waits for a pending prompt admission, and failures keep the client open. Esc sends an explicit cancellation from the conversation even when the cached running flag is idle; open menus also cancel a known running agent while closing. Active local history/search/cost loads are cancelled first. Page Up/Down scroll the retained transcript; `/older` loads an earlier page. Every exit path, including `/quit` and SIGTERM, stops the selected turn before the connection closes, so quitting does not leave the agent running; an idle session is left untouched. Cancellation leaves pending queue items intact.

The mouse wheel and Page Up/Down scroll conversation history; scrolling to the top automatically requests an older page. New output preserves a scrolled reading position; scrolling back down resumes following the newest output. Mouse reporting is enabled while the TUI is mounted and disabled on exit; the terminal must support SGR mouse reports. Esc or Ctrl+C cancels a history load or search before interrupting the remote agent.

`/search` matches literal text case-insensitively in conversation messages, including older pages; tool-only rows are excluded. `/history` lists your own prompts from the loaded pages. Record sequences are the numbers shown by these pickers. `/ssearch` and `/wsearch` call `session/search`, which searches current user/assistant message content and returns at most 20 sessions, snippets, and a truncation flag; it exposes neither a result cursor nor matching record sequences. Workspace filtering happens after that global limit, so a truncated workspace result can omit matches. The UI warns when results are incomplete; refine the query. Selecting a session loads its history and offers matching messages for the jump. These operations use HTTP and never scan the host configuration directory.

Tab completes the leading slash command, extending an ambiguous draft to the shared prefix. The single-line composer supports Readline-style editing. Words are whitespace-delimited; cursor movement and character deletion preserve composed Unicode characters. Multiline pasted text becomes one line with spaces. Ctrl+D on empty input does not exit; Ctrl+C clears a non-empty draft before it stops or exits. Other unhandled modifier shortcuts do not insert their control characters. Both BS and DEL terminal backspace encodings delete backward; the dedicated Delete key (CSI 3~) deletes forward.

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
| `/history [text]` | List your own prompts, optionally filtered; Enter jumps to the selected record |
| `/search <text>` | Load and search the current session history; choose a matching message to jump |
| `/ssearch <text>` | Search host results within the selected workspace |
| `/wsearch <text>` | Search sessions across all workspaces visible to the host |
| `/allow`, `/deny` | Answer the displayed approval; allow applies once |
| `/status` | Expand or collapse full footer details |
| `/cost` | Toggle session/today/three-day estimates and refresh usage |
| `/help`, `/quit` | Show command hints or exit |

Slash commands work in both pickers and the conversation composer. Typing `/` displays matching commands. The `/help`, `/cost`, and `/status` panels are temporary: the next command, Esc, or ten seconds closes whichever one is open, and Esc leaves the draft in place. The long forms `/workspace`, `/workspaces`, `/session`, and `/sessions` remain aliases. Names may contain spaces; quotes around the complete target are optional. The unquoted target `all` is reserved for `/s all`; use `/s "all"` or an ID to open a session titled `all`. Ambiguous targets require a full ID. Switching a workspace opens its sessions and detaches the old transcript; switching sessions updates the workspace label. Neither operation cancels a remote agent.

Type `@` at the end of the draft to search files and directories in the selected session's working directory **on the host**. Use ↑/↓ to select and Tab or Enter to insert; selecting a directory continues completion inside it. Paths with spaces use `@"path with spaces"`. Escape closes the menu and requests cancellation when the agent is running; after closing it, Enter sends the literal draft, including an unmatched path. Lookup failures remain visible and do not submit the draft. Completion operates on the trailing reference, not the cursor position inside existing text.

A file reference sends only `@path` in a text block. Harness instructs the model to read the referenced file or list the directory when needed; the TUI does not read local files, upload bytes, or expand contents into the prompt. Referencing an image path does not attach image data. Local attachments, image uploads/previews, and `@` session references are not implemented.

User questions accept typed free-text answers one question at a time. Other sessions' interactions and unrecognized waterfalls delegate with `next`. Failed submissions retain their input; an interrupted HTTP response can leave delivery uncertain, so check the transcript before manually resending. The client never retries a mutation automatically.

The conversation header shows the latest session title, falling back to the ID; `/status` retains the complete session ID. The cancellation acknowledgement stays visible through incoming history until the host reports idle; acceptance does not mean a tool process has already exited.

## Live status

The footer defaults to one borderless line showing activity, model, workspace, context occupancy, and total tokens; wider terminals also show input/output, cache, queue, and job counts. Long names shorten by terminal display width, and narrow terminals omit lower-priority fields first. `/status` toggles full multiline details with the complete path, provider/model, reasoning effort, and usage buckets. `!` flags a metrics or model catalog error, or incomplete cost coverage; the reason appears in the details. During a run it distinguishes the last-used model from a different next-request selection; a fresh session uses the host catalog default. Model catalog changes refresh on host settings, credential, and adapter notifications.

Working time uses the retained `turn/start` timestamp. If that timestamp is unavailable, `(observed)` means time since this client observed the run; reconnecting can reset this fallback. The clock stops when the host reports idle. The status includes model generation, tool execution, and approval waits, not just streamed text. Offline status is explicitly marked as last known.

Context occupancy is marked `~`: Harness combines provider usage with estimated surface changes and the latest route capacity. Token totals come from the complete session's `tokenUsage` projection, with separate uncached input, output, cache-read, and cache-write buckets; reasoning is already included in output. Totals update when the host publishes usage, not on every streamed character. Missing measurements display `unknown` or `?`. Control-stream baselines replace state on reconnect, and per-key watermarks prevent an older follow snapshot from overwriting newer metrics.

Tool-only rows omit the separate role heading: `⚙` identifies a call, `✓` a successful result, and `✗` a failed result. Once complete arguments are available, each row shows the tool name and operation description, falling back to its command, path, or query. Results reuse the matching call summary when retained history contains it. Each operation occupies at most one terminal row, with whitespace flattened and long text ellipsized by display width. Other arguments, nested results, and tool output remain hidden. Assistant prose and explicit approval requests remain visible so the user can understand the response and decide whether to approve an action.

## Cost estimates

`dsht` does not just show token counts: it turns Harness-visible per-request usage into a traceable CNY estimate. It separates uncached input, cache read, cache write, and output, and combines the model, the request settlement time, the price version, and the peak/off-peak window, so the cost of the current session and of the recent past stays visible while work is running.

> These figures are a high-precision estimate from Harness-visible usage and local price configuration, for cost monitoring and control. They are not a provider account bill, and the provider invoice remains authoritative.

`/cost` shows the selected session, today, and today plus the preceding two calendar days. Dates use Asia/Shanghai; the three-day view is not a rolling 72-hour window. The status bar reserves `S:` for session cost and `D:` for today. `~` marks an estimate; `*` marks a subtotal that is not exact, because a request carries no timestamp, no price covers it, or a calendar range cannot place it. Incomplete coverage is reported separately: charges cached by an earlier run count as complete, while an empty or failed scan raises the bar's `!` prefix and a reason in `/status`. Each host origin has a separate ledger. Totals cover HTTP-visible sessions and previously cached sessions; they are not account-wide provider bills.

The client reads complete histories in the background on connection, every 60 seconds, at turn completion, and when opening `/cost`. Idle sessions with unchanged host update timestamps are skipped. No model requests are made by billing. Esc or Ctrl+C cancels an explicit refresh. The ledger counts disjoint uncached input, cache read/write and output buckets; reasoning is already part of output. Retries count separately, replacement samples update their attempt, and fork-inherited history is excluded. A request without a settlement timestamp still contributes a floor amount, priced at the cheapest rate of its model family and reported as estimated. Inconsistent usage, and prices that no model or provider entry covers, remain unpriced; the model-name family decides Pro against Flash, while an unlisted provider is never billed from the official table. Every listed session is read independently, so one unreachable or rejected session is reported as a failure count instead of stopping the scan, and a subagent child is read under its durable parent address. Failed scans retain labelled partial cached totals.

The bundled CNY rates were checked against the [official pricing page](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) on 2026-09-10. Beijing weekday peak windows are 09:00–12:00 and 14:00–18:00; other times use half-price rates. Flash peak cache-miss-input/cache-hit-input/output rates are ¥2/¥0.04/¥8 per million tokens and Pro rates are ¥9/¥0.30/¥27; the current model name is `deepseek-flash`, and older Flash names keep those same rates. The provider has announced that from 2026-09-14T12:00+08:00 it serves `deepseek-v4-pro` from Flash and bills it at Flash rates, which the bundled entry records so that date does not overstate Pro usage. Separate cache writes use the uncached-input rate. An exact configured model price takes priority; otherwise `deepseek-official` names containing `pro` (case-insensitive) use Pro and all other names use Flash, including temporary model aliases. Other providers require explicit entries.

The default price validity starts at Beijing midnight on the verification date; this is a local estimate policy, not a claim about the official effective date. Earlier usage needs historical price entries. The recorded assistant settlement timestamp selects the rate; requests spanning a tariff boundary may differ from the invoice because the official page does not specify their attribution. Images use provider-reported tokens. Every scan reprices stored requests from the current configuration, so correcting a price version also corrects earlier totals; a request that no entry covered is priced once an entry covers its settlement date.

On first interactive launch, the client creates `~/.config/dsht/prices.json` (or `$XDG_CONFIG_HOME/dsht/prices.json`). `DSHT_CONFIG_DIR` overrides that directory. The JSON array contains price versions with `id`, `provider`, `model`, `currency: "CNY"`, `source`, inclusive `from`, optional exclusive `until`, `timezone`, weekday numbers (`0` Sunday), minute-of-day `windows`, and `peak`/`offPeak` rates named `input`, `cacheRead`, `cacheWrite`, `output`, per million tokens. To update prices, close the old interval with `until` and append a new version with a unique ID and matching `from`; overlapping intervals are rejected. Restart to load configuration changes. Price discovery is manual; the TUI does not scrape prices during startup.

Usage files live under `~/.local/state/dsht/cost/<origin-hash>/` (respecting `XDG_STATE_HOME`, or `DSHT_STATE_DIR` for the application state root). They contain only session IDs, timestamps, model identities, token counts, selected price versions and estimates. They exclude prompts, tool bodies, credentials and cookies. The price file is configuration and these usage files are state, so only the former belongs in a settings backup. Writes use private temporary files and atomic replacement; opening-cut filenames prevent older concurrent scans from displacing a newer cached cut. The cache survives restart and does not need access to the host configuration directory. It stores each request rather than a running total, and the skip bookkeeping lives in memory only, so the first scan after a restart re-reads every session and reprices whatever accrued while the client was closed using each request's own settlement time.

## Client API

Installed packages export `Client` from `@itookit/dsht` and `login`/`CookieStore` from `@itookit/dsht/auth`, with TypeScript declarations. Source consumers can import from `src/client.ts` with a TypeScript loader, or from `dist/client.js` after building. `authenticate(token)` exchanges credentials; `connect()` opens one multiplexed socket; `listWorkspaces()` and `listSessions(workspaceId?)` return promises of server rows. `call(endpoint, args, signal?)` preserves host errors as `RemoteError` with `code` and `details`. Always await `close()` in `finally`. Library consumers opt into persistence with `login(client, token, new CookieStore())` from `src/auth.ts`; `Client.authenticate()` itself only retains credentials in memory.

Session and workspace command methods use `{ request: { ... } }` inside `args`; session listing uses `{ _request: {} }`. `$events/result` uses its named arguments directly. Follow snapshots replace retained state after reconnect; durable messages and transient assistant text remain separate. The reader accepts both `event` records and older `chunks` wrappers containing `chunkrow/text-chunks`, `chunkrow/reasoning-chunks`, or `chunkrow/tool-call-chunks`. Hosts without `assistantStream` expose live text through logged chunks; the TUI reconstructs only the unfinished attempt and preserves each packed record's starting sequence for pagination.

## Publishing to npm

This repository publishes one public package, `@itookit/dsht`, from the `mushuanli/dsht` repository. The scope is required because npm rejects the unscoped `dsht` as too similar to existing short names such as `dot` and `st`. `package.json` is the authority for the fields below.

| Field | Value |
| --- | --- |
| Name and version | `@itookit/dsht` `0.2.2` |
| Executable | `dsht`, or `npx @itookit/dsht` without installing |
| Library entries | `@itookit/dsht` and `@itookit/dsht/auth` |
| Author | lizlok@gmail.com |
| License | MIT, with the license text in `LICENSE` |
| Repository and issues | [mushuanli/dsht](https://github.com/mushuanli/dsht) |
| Node.js | 22.19 or newer |
| Registry access | public, under the `@itookit` scope |
| Published files | `dist/`, both READMEs, their pairing record, the screenshot, and the license |

Descriptions, keywords, and dependencies live in `package.json`. The following commands are maintainer actions; creating a local package does not publish it.

```sh
npm run test:package
npm login
npm publish --access public
```

`test:package` builds a tarball and runs its CLI through an isolated, offline npm-exec installation using the dependency cache populated by installation, and rejects any packed path outside the published set above. `prepublishOnly` checks types and tests; `prepack` compiles JavaScript and declarations. Source tests, recordings, and local authentication files are excluded.

`publishConfig.access` is `public`, which a scoped package needs to be installable without a paid plan; the flag is therefore part of the package rather than of the publish command. An account with two-factor authentication publishes with a live code, `npm publish --otp=<code>`; the code is checked at the final request, after the typecheck, suite, and build have already run.

Later releases run in `.github/workflows/publish.yml`, which publishes from a version tag with [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) and provenance, so no publish token is stored. Configure it once at `npmjs.com` → `@itookit/dsht` → Settings → Trusted Publisher → GitHub Actions with organization or user `mushuanli`, repository `dsht`, workflow filename `publish.yml`, and allowed action `npm publish`. Trusted publishing cannot create a package, so the earliest versions were published by hand; a later release pushes the matching tag, for example `npm version 0.2.3 && git push --follow-tags`.

The workflow packs without publishing when started manually, and refuses a tag that disagrees with `package.json`. See the official [scoped publishing guide](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/) and [npx documentation](https://docs.npmjs.com/cli/npm-exec/). Registry publication is not part of the local validation performed for this repository.

## Development and limitations

```sh
npm test
npm run test:terminal
npm run build
npm run bench:input
node dist/cli.js --help
```

Tests use isolated HTTP/WebSocket hosts, drive the real Ink picker and composer, run the CLI in subprocesses, and project copied Harness v2 workspace-edit and v0 packed-chunk recordings. The repository needs no model credentials for these checks. The recording and expected transcript live under `tests/`; they do not depend on a parent checkout. Live model-provider behavior is not covered by these tests.

`npm test` renders frames without styling, because the assertions and the recorded expectations in `tests/expected/` describe text. A test runner started from a terminal exports `FORCE_COLOR=1` to each test file, which makes Ink interleave SGR escapes between a prompt and its text; `npm run test:terminal` reproduces that environment on any host, and `prepublishOnly` runs it so a publish from a terminal validates what a terminal actually renders.

Typing reuses history projection and wrapping until the transcript revision or terminal width changes; host updates and older pages invalidate that reuse. `bench:input` measures local input-to-render work with 20 and 500 synthetic messages, 30 measured keystrokes after warmup, and history projection read counts. It excludes network/model time and is a diagnostic, not a machine-independent latency threshold.

The interface presents plain text, reasoning, tool calls, and tool results. Rich plugin cards, file upload, subagent navigation, model selection, and queue editing are not implemented. Reconnect uses bounded exponential backoff with jitter and replaces snapshots; list commands fail directly instead of retrying. Updating pre-stable host APIs requires updating the local wire adapter and tests.
