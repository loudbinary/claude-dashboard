# claude-dashboard

A local dashboard for Claude Code sessions. It shows what you last sent each session, uses color to flag the ones
waiting on you, lets you rename sessions and drill into their notes, and has configurable buttons that act on the URL
in your clipboard (review a PR in a new session, watch a pipeline until it needs approval).

![Dashboard](docs/screenshot.png)

Stack: Bun server with SQLite and a WebSocket stream, Vue 3 client. The design follows the hooks -> HTTP -> SQLite ->
WebSocket -> UI approach of [disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability);
no code is taken from that project. Its event envelope (`POST /events`) is accepted as well as raw hook JSON.

## Setup on a new machine

Requires [Bun](https://bun.sh) and the `claude` CLI on PATH.

```sh
git clone git@github.com:loudbinary/claude-dashboard.git
cd claude-dashboard
bun run setup                               # install server and client dependencies
cp config.local.example.yaml config.local.yaml   # optional per-machine overrides
bun run build                               # build the client once
bun run start                               # http://127.0.0.1:4000
```

For development run `bun run server` and `bun run client` in two terminals and open http://localhost:5173.

### 1. Point it at your workspace

Sessions started from the dashboard run in `claude.default_cwd`. Set it to your workspace folder in `config.local.yaml`
(or set the `CLAUDE_DASHBOARD_CWD` environment variable) so they load that workspace's `CLAUDE.md`, `.claude` settings,
already-granted permissions, MCP servers and plugins, the same as a terminal session started there. The default (`.`)
is the dashboard's own folder, which has none of that; the server prints the folder it will use at startup.

```yaml
claude:
  default_cwd: C:/path/to/your/workspace
```

The dashboard does not override permissions unless you set `permission_mode` or `allowed_tools` in the config.

### 2. Send Claude Code events to the dashboard

Merge `hooks/settings.example.json` into `~/.claude/settings.json` (all projects) or a project's
`.claude/settings.json`. If you change `server.port`, change the URLs to match.

### 3. Set tokens

Tokens are read from environment variables named in `config.yaml`; they are never written to a file.

| Provider | Variable | Needs |
|---|---|---|
| Azure DevOps | `AZDO_PAT` | Build (Read) |
| GitHub | `GITHUB_TOKEN` | `actions:read` on the repos you watch |
| PagerDuty | `PAGERDUTY_TOKEN` | Read-only REST API key or user token |

## Configuration

`config.yaml` holds shared defaults and is checked in. `config.local.yaml` is git-ignored and deep-merged over it, so
each machine overrides only what differs (port, database path, working folder, which providers are enabled).
`CLAUDE_DASHBOARD_CONFIG` points at a different config file; `CLAUDE_DASHBOARD_PORT` overrides the port.

### Buttons

Buttons are entries under `actions:` in the config. No code change is needed to add one.

```yaml
actions:
  - key: review_pr          # unique id
    label: Review PR        # button text
    kind: session           # session = start a Claude session, watch = poll a pipeline run
    accepts: pr             # pr | run | incident: the kind of URL expected
    name: "PR review: {title}"
    prompt: "Review the pull request at {url}. ..."
    permission_mode:        # empty = use the workspace's Claude settings
    allowed_tools: []       # e.g. ["Read", "Bash(gh pr:*)", "Bash(az repos:*)"]
```

A click reads the clipboard (the browser asks for permission once) or the URL box if you typed one. `{url}`, `{title}`
and `{provider}` are filled into `prompt` and `name`. `{details}` is filled with data the provider prefetches; for a
PagerDuty incident that is the incident, up to 10 alerts with their payloads, and its timeline, so the
"Analyze PagerDuty Incident" session starts with the alert content without needing PagerDuty access itself.
Recognized URLs:

| | Pull request | Pipeline run |
|---|---|---|
| Azure DevOps | `dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}` | `dev.azure.com/{org}/{project}/_build/results?buildId={id}` |
| GitHub | `github.com/{owner}/{repo}/pull/{n}` | `github.com/{owner}/{repo}/actions/runs/{id}` |

PagerDuty incidents: `{subdomain}.pagerduty.com/incidents/{id}` (any trailing path, such as `/timeline`).

Sessions started by a button run headless (`claude -p`), so they cannot stop to ask for permission. Give the review
action the tools it needs through `allowed_tools`; the session needs `gh` or `az` signed in to read a private PR.

### Status colors

Set under `ui.status`. States with `attention: true` sort to the top, tint the row and pulse.

| State | Default | Set when |
|---|---|---|
| Needs permission | red | Notification hook, `permission_prompt` |
| Waiting for your reply | amber | Stop hook, or Notification `idle_prompt` |
| Awaiting approval | purple | a watched run has a stage or environment waiting for approval |
| Failed | dark red | a watched run failed, or a launched session errored |
| Working / Watching | blue | prompt submitted or tool running; run in progress |
| Done / Succeeded | green | session ended; run succeeded |
| Inactive / Canceled | gray | no events for `ui.inactive_after_minutes`; run canceled |

## How it behaves

- **New session**: starts a Claude CLI session (`claude -p`) in the folder you choose. Start sessions here rather than
  in a terminal and every one of them can be followed and answered from the dashboard. They run headless, so they
  cannot stop to ask for permission: what the workspace's Claude settings already allow works, anything else is
  denied. `claude.new_session` in the config can widen that.
- **Resume session**: asks for a session name or id and continues it with `claude -p --resume`. Names of sessions
  already in the dashboard are matched first; any other value is passed to the Claude CLI, which accepts a session id
  or the session's own title. A resumed terminal session becomes answerable from the dashboard. Close it in the
  terminal first so two processes are not writing to the same session.
- **Seen**: a session or pipeline that needs you is vivid (and pulses) until you have seen it. Opening a session, clicking
  a pipeline row, the ✓ button, dismissing its popup, or "Mark all seen" marks it seen. A seen item stays at the top
  of the list in the muted `ui.seen_color` with a ✓ on its chip, the header count turns muted when nothing new is
  left, and no popup (in the page or a Windows toast) is raised for it again, including after a page refresh or a
  server restart. A toast already on screen is withdrawn. It becomes vivid again, with a new popup, only when its
  state changes, for example Claude finishes another turn and is waiting on you again.
  Popups for pipelines stay until you dismiss them; dismissing one marks the pipeline seen.
- **Rename**: click the pencil or edit the title in the detail panel. Names are stored in the dashboard database only.
- **Right-click a session row**: Rename, Mark seen, or Remove from dashboard. Remove deletes only the dashboard's
  record; the Claude session and transcript are untouched, and a terminal session still running reappears on its
  next hook event.
- **Reply**: sessions started from the dashboard can be answered in the detail panel (resumed by session id).
  Sessions running in a terminal are observed only; reply in the terminal.
- **Session notes**: read from the transcript file Claude Code reports, so they appear only on the machine that ran the session.
- **Pipeline watch**: polled every `watch.poll_interval_seconds`; stops when the run finishes. Nothing is approved for you.
- **Local only**: the server binds to 127.0.0.1 and refuses POSTs from web pages on other origins.

## Layout

```
config.yaml                 shared settings, buttons, colors
hooks/settings.example.json Claude Code hook config
apps/server/src/            app.ts (routes) state.ts (status rules) db.ts launcher.ts watcher.ts providers/
apps/server/test/           bun test
apps/client/src/            App.vue, components/, api.ts
```

## Status of this scaffold

Covered by tests (`bun run test`): config merge, status rules, URL parsing, approval detection against sample API
responses, routes, rename, reply rules, origin checks. The launcher has been run against the real `claude` CLI for
start, stream parsing, failure handling and resume, but only on a machine where the CLI was not signed in, so a
successful reply has not been seen yet. Not yet exercised against live systems: the HTTP hooks coming from a real
Claude Code session, and live Azure DevOps and GitHub API calls.
