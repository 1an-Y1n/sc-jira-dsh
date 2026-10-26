# @ian/sc-jira

DSH static plugin. Adds Jira integration:

- **Settings card** (`设置 → Jira`): fill server / login / API token / display name / proxy
- **Conversation view** (tab next to Trajectory): 3 sub-tabs — 我的未完成 / Worklog 周报 / 绑定 Session
- **Tools exposed to agent**: `jira_list_my_open`, `jira_list_worklog_week(startDate?)`, `jira_get_binding(sessionId)`, `jira_bind(sessionId, taskKey)`
- **HTTP routes** (all under `/api/scjira/*`): `status`, `config`, `list-my-open`, `list-worklog-week`, `get-binding`, `bind`

The original spec called for 3 right-sidebar sub-tabs, but `@deepseek-ai/dsh-client-ui-sidebar-right` is **not bundled** in the default dsh web profile — `ctx.sidebarRightTabs` never resolves. The plugin therefore mounts a `conversation.view` entry (the tab next to Trajectory) that carries the same 3 sub-tabs, plus a `settings.section` card for the credentials.

## Architecture

- **Host** (`src/index.ts`): registers the `scjira` settings namespace + 6 HTTP routes + 4 tools, all wrapped in `ctx.effect()` for dispose
- **Timezone** (`src/timezone.ts`): shared calendar-day/week arithmetic in `Asia/Shanghai`, used by both host and client
- **Storage** (`src/storage.ts`): schema-versioned `meta.json` (schemaVersion=3) + token persisted with `role('secret')` via `@deepseek-ai/schemastery`
- **JiraClient** (`src/jira-client.ts`): calls Jira REST via `ctx.subprocess.spawn('curl', ...)` (DSH Node sandbox disables `fetch`)
- **Handlers** (`src/handlers.ts`): 4 pure functions (listMyOpen, listWorklogWeek, getBinding, bind) + a paginating `searchAllIssues` helper
- **Client** (`src/client/`): locale dictionary + Settings card UI + conversation view (3 sub-tab panels)

## Install

> **Want it live without restarting?** Installing through the **plugin market** hot-mounts the
> plugin into the running host — see [Installing without a restart](#installing-without-a-restart-via-the-plugin-market).

### From GitHub (recommended for other users)

```bash
dsh plugin --profile web add github:1an-Y1n/sc-jira-dsh
```

A git install fetches **sources, not built artifacts** — nothing runs your `build` script
automatically, so this package ships a `prepare` script that pnpm runs after the install.
The build is self-contained: it needs only this directory, no sibling monorepo checkout.

pnpm ≥10 refuses to run a git dependency's `prepare` script until it is explicitly allowed,
so the **first** `add` fails. Copy the key pnpm prints into the profile's
`pnpm-workspace.yaml` — the key names the exact tarball and commit, so it changes when the
commit changes:

```yaml
# ~/.dsh/profiles/web/pnpm-workspace.yaml
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

allowBuilds:
  '@ian/sc-jira@https://codeload.github.com/1an-Y1n/sc-jira-dsh/tar.gz/<commit-sha>': true
```

then re-run the `add`. The build then runs automatically and the install completes.

> Allowing a build is **permission to execute the package's code on your machine at install
> time**, outside any sandbox the agent runs under. Only allow packages whose source you
> trust. To pin an exact revision, use `github:1an-Y1n/sc-jira-dsh#<sha>` so a later push
> cannot silently change what runs.

Only `esbuild` needs a build allowance, and it comes in as a transitive dependency of
**vitest** — the test runner, not the build. The client bundle is built by `rolldown`, which
ships prebuilt native bindings and needs no allowance.

### Requirements

The plugin injects `settings`, `webServer` and `tools`, so the profile must mount the web
app bundle:

```yaml
dsh:
  profile:
    bundles:
      - '@deepseek-ai/dsh-base'
      - '@deepseek-ai/dsh-web-app'
      - '@ian/sc-jira'
```

Without `dsh-web-app` the entry stays `pending (waiting for service: webServer)` and the
profile refuses to boot.

### Installing without a restart (via the plugin market)

`dsh plugin add` changes the profile manifest on disk; a running DSH keeps the bundle set it
started with, so a plain install needs a restart.

The **plugin market** (`dshmarket`) can do better: it mounts a freshly installed plugin into
the *running* composition through a market-owned Include subtree, so the plugin is live
immediately — no restart. `sc-jira` is compatible with that path.

The compatibility requirement is narrow: the bundle patch must contain **only plain
`id`/`name` insert rows** — no `config` blocks, no `disables`, no `!!js` expressions. The
market's parser rejects anything else and falls back to a restart. This package's patch
already satisfies it:

```yaml
- insert:
    - id: sc-jira
      name: '@ian/sc-jira'
```

Verified against the installed market's own parser (`parseSimplePatch` returns
`[{ id: 'sc-jira', name: '@ian/sc-jira' }]`) and by a live hot-mount: with the plugin
deliberately kept out of `dsh.profile.bundles`, `POST /dsh-market/toggle` returned
`"state": "live"`, `"hot": true`, `"restart": false`, and the routes went from `404` to
`200` on the same process.

Two caveats worth knowing:

- The market's hot-mount writes a **temporary** row under `<profile>/.dsh-market/`, wiped on
  every boot. Durable state stays with `dsh.profile.bundles`, reconciled by the `dsh` CLI at
  install time — so the next boot loads the plugin through the normal bundle layer.
- A hot mount is **process-local**. The plugin's own state (the `scjira` settings namespace,
  the `meta.json` bindings) lives outside the process and survives either way.

If the hot mount cannot complete — the plugin takes longer than 10s to activate, the include
plugin is unavailable, or the patch grows a config row — the market falls back to restarting
the host itself and says so.

### From a local checkout

```bash
git clone git@github.com:1an-Y1n/sc-jira-dsh.git
cd sc-jira-dsh
pnpm install                       # pnpm-workspace.yaml must have allowBuilds.esbuild: true
pnpm run build                     # tsc + tsdown client bundle + CJS-prelude wrap
dsh plugin --profile web add "$(pwd)"
```

Either way, restart dsh web afterwards
(`pkill -f 'dsh web'; setsid dsh web > /tmp/dsh-web-out.log 2> /tmp/dsh-web-err.log < /dev/null &; disown`),
then open **Settings → Jira** and fill in your credentials.

### Uninstall

```bash
dsh plugin --profile web remove @ian/sc-jira
```

## Configure

Credentials live in the `scjira` settings namespace (server / login / API token / display name /
proxy) and are entered in **Settings → Jira**. The token is stored with `role('secret')` and is
never echoed back by the API.

## Tests

```bash
pnpm run typecheck          # static — tsc on host + client
pnpm run lint               # static — oxlint
pnpm run test               # unit  — vitest (64 tests across 5 files)
node scripts/probe.mjs      # browser — Playwright smoke test
```

## Routes

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/api/scjira/status`             | Plugin health + credential presence (never returns token) |
| POST   | `/api/scjira/config`             | Partial update of the `scjira` settings namespace |
| GET    | `/api/scjira/list-my-open`       | Issues assigned to configured user (paginated) |
| GET    | `/api/scjira/list-worklog-week`  | Weekly worklog totals (`?startDate=YYYY-MM-DD`, defaults to this week) |
| GET    | `/api/scjira/get-binding`        | Current session → Jira issue binding (`?sessionId=`) |
| POST   | `/api/scjira/bind`               | Bind a session to a Jira issue |

All routes except `status` and `config` return 503 with `{ok:false, error:"请先在 Settings 填 Jira credentials"}` if credentials are missing — never 500, never crash.

## Jira REST API version

This plugin targets **Jira Server** (e.g. `jiraprod.sercomm.com`), which serves `/rest/api/2/`.
Jira Cloud's `/rest/api/3/` returns a different `description` shape (Atlassian Document Format
instead of a plain string), which this client's field mapping does not handle.

The version lives in one place — `API_VERSION` in `src/jira-client.ts` — and every endpoint is
built through the `apiUrl()` helper, so there is no second copy of the path to keep in sync.

## Known bug fixes (from scjira v2 spec §6)

Regression coverage in `tests/jira-client.test.ts`, `tests/handlers.test.ts` and `tests/timezone.test.ts`:

1. **bug-2** token-leakage: never echo token in `/status`, Settings card, or logs
2. **bug-3** timezone: calendar days and week boundaries resolve in `Asia/Shanghai`, not UTC.
   The naive `new Date().toISOString().slice(0, 10)` returns the UTC date, which is off by one
   between 00:00 and 08:00 local time — landing on the wrong day *and* the wrong week.
3. **bug-4** JQL escaping: issue keys passed through `issuetype` filter, not interpolated
4. **bug-5** worklog pagination: paginate via `startAt`, not truncate at 50
5. **bug-6** cookie-based auth: prefer `Authorization: Basic` over cookie reuse
6. **meta.json schemaVersion**: every write bumps `schemaVersion`, refuses to read mismatched

### Fixes added after the initial release

| Area | Problem | Fix |
|------|---------|-----|
| `src/timezone.ts` | Host and client each duplicated UTC date arithmetic; `today` was the UTC date, so the week view was wrong 8 hours a day | One shared, dependency-free helper module; both sides use it |
| `src/handlers.ts` | `handleListMyOpen` fetched a single page of 50 — issues beyond that were silently dropped | `searchAllIssues()` follows every page (`SEARCH_PAGE_SIZE = 100`, the Jira Server cap) |
| `src/handlers.ts` | `handleListWorklogWeek` also fetched a single page of 100 | Same paginating helper |
| `src/index.ts` | `POST /config` answered with the `creds` closure variable, but `scope.watch` fires **asynchronously** — the response could echo pre-write values | Read the committed value back from the scope |
| `src/jira-client.ts` | Three hardcoded `/rest/api/2/` path literals | Single `API_VERSION` constant + `apiUrl()` helper |
| `src/jira-client.ts` | `search()` had no `startAt` parameter, so pagination was impossible | `startAt` option; omitted when 0 |

## Files

```
sc-jira-dsh/
├── package.json                       # @ian/sc-jira 0.1.0
├── cordis.patch.yml                   # bundle declaration
├── LICENSE                            # MIT
├── tsconfig.json / tsconfig.client.json
├── tsdown.config.ts                   # CJS bundle + externals
├── pnpm-workspace.yaml                # allowBuilds.esbuild: true
├── src/
│   ├── index.ts                       # host apply (apply(ctx) function form)
│   ├── handlers.ts                    # 4 pure handlers + paginating search helper
│   ├── jira-client.ts                 # Jira REST v2 via curl
│   ├── timezone.ts                    # Asia/Shanghai day/week helpers (host + client)
│   ├── storage.ts                     # meta.json + Schemastery schema (role('secret'))
│   ├── types.ts                       # shared types
│   └── client/
│       ├── index.ts                   # client apply: locale + settings.section + conversation.view
│       ├── ScjiraSettingsCard.tsx     # credentials form
│       ├── ScjiraView.tsx             # conversation view: 3 sub-tab panels
│       ├── locales.ts                 # zh + en dictionaries
│       └── globals.d.ts               # ambient slots/locale types
├── tests/                             # 64 vitest tests
├── scripts/
│   ├── probe.mjs                      # Playwright smoke
│   ├── probe-themes.mjs               # theme token probe
│   ├── inspect-bg.mjs                 # CSS variable probe
│   ├── chrome.mjs                     # shared Chrome resolution for the probes
│   └── normalize-client-banner.mjs    # CJS prelude wrap
└── README.md                          # this file
```
