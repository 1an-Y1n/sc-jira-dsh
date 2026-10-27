# sc-jira plugin — design spec

**Date**: 2026-09-17
**Status**: draft, awaiting user review
**Source spec**: `/home/ian/0_study/DSH/dsh-src/.docs/sc-jira-v2-spec.md`
**Target**: `plugins/sc-jira/` in `dsh-plugin-dev`
**Author**: Claude (brainstorming session)

---

## 0. Context

scjira v2 (scjira-7/pkg-10) is a dynamic Cordis plugin that adds a 3-tab Jira sidebar to the DSH web UI and binds DSH sessions to Jira issues. It was lost on 2026-09-17 when both DSH workspace and runtime state were cleared.

The source spec explicitly recommended the **dynamic-plugin form** and dismissed the static-package rewrite as "100% 重写" — primarily because the client→host immediate-RPC (`host.call`) UX has no static equivalent. User has overruled this: **functional requirements must be preserved**, and we must find a way to deliver them in a static package.

This spec describes that way.

---

## 1. Architecture — 3-layer dual-plane plugin

```
plugins/sc-jira/
├── package.json              # dsh.bundle + dsh.client.platform: web
├── cordis.patch.yml          # bundle registration
├── tsconfig.json             # host TS
├── tsconfig.client.json      # client TS (react)
├── src/
│   ├── index.ts              # HOST apply: settings + HTTP routes + 4 tools
│   ├── types.ts              # IssueSummary, WorklogEntry, DayTotal, ScjiraSettings
│   ├── jira-client.ts        # Jira REST wrapper (spawn curl)
│   ├── handlers.ts           # 4 pure handlers, accept JiraClient + fs + creds
│   ├── storage.ts            # meta.json read/write (schemaVersion 3)
│   └── client/
│       ├── index.ts          # CLIENT apply: sidebar tab + settings section + locale
│       ├── ScjiraTab.tsx     # 3 sub-tab container
│       ├── ListMyOpenPanel.tsx
│       ├── WorklogWeekPanel.tsx
│       ├── BindPanel.tsx
│       ├── ScjiraSettingsCard.tsx
│       └── locales.ts        # zh-CN + en-US
└── tests/
    ├── handlers.test.ts
    ├── storage.test.ts
    ├── jira-client.test.ts
    ├── settings.test.ts
    ├── dispose.test.ts
    └── bugs.test.ts          # spec §6 regression tests
```

### Data flow

1. **Settings** — User fills `server/login/token/displayName` in the Settings panel card. `token` is `role('secret')` (write-only on wire).
2. **Host boot** — `apply()` registers the `scjira` settings namespace. The current resolved value is cached in a closure (since HTTP routes are synchronous return points).
3. **Client UI** — User opens the right-sidebar sc-jira tab. Tab body fetches `/api/scjira/list-my-open` (and 3 others). Host routes call `JiraClient` → Jira REST → return JSON.
4. **Tools mirror** — Same 4 handlers are also `defineTool`-registered as `jira_list_my_open` etc. so the agent can call them in loop.
5. **Binding persistence** — `bind` writes `~/.dsh/profiles/web/scjira/tasks/{KEY}/meta.json` (schemaVersion 3). `getBinding` scans that directory.

### Key conventions

- HTTP prefix: `/api/scjira/*` via `ctx.webServer.register`
- Sidebar tab kind: `'scjira'`; 3 sub-tabs are internal (PanelToggle pattern from spec §4.3)
- Settings namespace: `'scjira'`
- Locale namespace: `'scjira'` (zh-CN + en-US)
- Peer deps: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-settings`, `@deepseek-ai/dsh-client-ui-primitives`, `react`

---

## 2. Data shapes & storage

### 2.1 Runtime types (`src/types.ts`)

```typescript
export interface IssueSummary {
  key: string; id: string; summary: string; description: string;
  statusName: string; priority: string;
  assignee: string; reporter: string;
  duedate: string;            // 'YYYY-MM-DD' or ''
  created: string; updated: string;
  resolution: string;
  timeSpentSeconds: number;
  originalEstimateSeconds: number;
  remainingEstimateSeconds: number;
  url: string;
  worklogs: WorklogEntry[];
}

export interface WorklogEntry {
  id: string; author: string;
  started: string; timeSpentSeconds: number; comment: string;
}

export interface DayTotal {
  seconds: number;
  entries: Array<{
    issueKey: string; issueSummary: string; started: string;
    timeSpentSeconds: number; comment: string; author: string;
  }>;
}

export interface ScjiraSettings {
  server: string       // default 'https://jiraprod.sercomm.com'
  login: string        // default 'A003688'
  token: string        // role('secret'), default ''
  displayName: string  // default 'Ian Yin'
}
```

### 2.2 `meta.json` schema v3 (binding persistence)

Path: `~/.dsh/profiles/web/scjira/tasks/{KEY}/meta.json`

```json
{
  "schemaVersion": 3,
  "key": "DZ300-1826",
  "status": "active",
  "startedAt": "2026-09-11T17:47:00.000Z",
  "endedAt": null,
  "dshSessionId": "<agent.id>",
  "issueSummary": { /* IssueSummary 关键字段 */ },
  "logCount": 0, "logBytes": 0, "summaryCount": 0
}
```

**`dshSessionId` immutability**: subsequent `bind` with same `KEY` but different `sessionId` throws. Prevents silent overwrite.

### 2.3 HTTP route contracts

| Method | Path | Req | Resp 200 | Resp err |
|---|---|---|---|---|
| GET | `/api/scjira/status` | – | `{ ok, configured, server, login, displayName }` | – |
| GET | `/api/scjira/list-my-open` | – | `{ ok, issues, totalSpentSeconds, jql }` | `{ ok:false, error }` |
| GET | `/api/scjira/list-worklog-week?startDate=` | – | `{ ok, weekStart, weekEnd, dayLabels, dailyTotals, grandTotalSeconds, jql }` | `{ ok:false, error }` |
| GET | `/api/scjira/get-binding?sessionId=` | – | `{ ok, bound, key?, summary?, sessionId? }` | – |
| POST | `/api/scjira/bind` | `{ sessionId, taskKey }` | `{ ok, key, sessionId, summary }` | `{ ok:false, error }` |

### 2.4 Tools (mirror of 4 handlers, for agent use)

| Tool | Args | Output schema |
|---|---|---|
| `jira_list_my_open` | – | `{ issues: IssueSummary[]; totalSpentSeconds: number; jql: string }` |
| `jira_list_worklog_week` | `{ startDate?: string }` | `{ weekStart, weekEnd, dayLabels: [{date,label,seconds}], dailyTotals, grandTotalSeconds, jql }` |
| `jira_get_binding` | `{ sessionId: string }` | `{ bound: boolean; key?: string; summary?: string; sessionId: string }` |
| `jira_bind` | `{ sessionId: string; taskKey: string }` | `{ ok: boolean; key?: string; sessionId?: string; summary?: string; error?: string }` |

All four `defineTool`s honor `exec.signal` and project canonical values, not pre-rendered prose.

---

## 3. Error handling & Jira HTTP client

### 3.1 `src/jira-client.ts` — `JiraClient` class

```typescript
export class JiraClient {
  constructor(private creds: ScjiraSettings) {}

  async issue(key: string, signal?: AbortSignal): Promise<JiraResult<JiraIssue>>
  async worklogs(key: string, opts: { startAt?: number; maxResults?: number; signal?: AbortSignal }): Promise<JiraResult<JiraWorklogPage>>
  async search(opts: { jql: string; maxResults?: number; fields?: string; signal?: AbortSignal }): Promise<JiraResult<JiraSearchPage>>
}
```

- Calls Jira REST via `ctx.subprocess.spawn(['curl', ...])` (DSH Node sandbox disables `fetch`)
- Default timeout 30s; cancelled via `AbortSignal`
- Auth header: `Authorization: Basic <base64(login:token)>` (Jira server-style auth)
- Returns `{ ok: true, body }` or `{ ok: false, error: 'auth' | 'http' | 'network' | 'parse', detail? }`

### 3.2 Error → user message map

| Source | Response message |
|---|---|
| Settings not configured | `'请先在 Settings 填 Jira credentials'` |
| Jira 401/403 | `'Jira 认证失败 — 检查 token'` |
| Jira 5xx | `'Jira 服务异常 (5xx)，稍后重试'` |
| `taskKey` fails `KEY_RE` | `'taskKey 格式错误：应为 PROJECT-123'` |
| `bind` second-time mismatch | `'{KEY} 已绑定到别的 session'` |
| JQL returns 0 issues | Normal empty array, not an error |

### 3.3 Spec §6 bug fixes (regression-required)

| Bug | Fix in code |
|---|---|
| §6.1 JQL worklogAuthor not filtering | Every worklog in `listWorklogWeek` must author-match before inclusion |
| §6.2 displayName vs login | Match against BOTH `login` and `displayName` |
| §6.3 `/search?fields=worklog` silent truncation | Use `/issue/{key}/worklog` endpoint, pageSize=1000, paginate fully |
| §6.4 Undefined `isJiraKey` | Use `KEY_RE.test(key)` everywhere, never define helper functions and forget to call them |
| §6.5 locale "already has locale" | try/catch wrap `ctx.locale.register`, fall back to single-locale |
| §6.6 host/client split killing host | Single plugin hosts both (our design naturally avoids) |

### 3.4 Self-cleanup (CLAUDE.md #4)

- All `ctx.webServer.register`, `ctx.sidebarRightTabs.register`, `ctx.slots.inject`, `ctx.settings.register`, `ctx.tools.register` wrapped in `ctx.effect(...)`
- `fs/promises` IO is auto-cleaned (no file handle leaks)
- No `setInterval` / persistent background timers

### 3.5 Cancellation

- **Tools**: pass `exec.signal` straight to `JiraClient.method`
- **HTTP routes**: `AbortController` + 30s timeout wrapper; `req.on('aborted')` triggers `controller.abort()`

---

## 4. Settings + Sidebar tab integration

### 4.1 Host: settings registration (`src/index.ts`)

```typescript
import Schema from '@deepseek-ai/schemastery'

export const Config = Schema.object({
  server:      Schema.string().default('https://jiraprod.sercomm.com'),
  login:       Schema.string().default('A003688'),
  token:       Schema.string().role('secret').default(''),
  displayName: Schema.string().default('Ian Yin'),
})

// Host injects ONLY host-side services (no slots/sidebarRightTabs — those are browser-only)
export const inject = ['settings', 'webServer', 'tools']

export function apply(ctx: Context) {
  const scjira = ctx.settings.register('scjira', Config)

  let creds: ScjiraSettings = scjira.get()
  ctx.effect(() => scjira.watch(next => { creds = next }))

  // 4 HTTP routes + 4 tools, both reading creds from closure cache
  // ...
}
```

`scjira.get()` is sync; routes are sync return points, so we MUST cache creds in closure (not await settings on every request). Client-side does NOT need to inject `settings`; it talks to host settings via `ctx.remote.settings.*` (API Gateway-generated Remote).

### 4.2 Client: settings card + sidebar tab (`src/client/index.ts`)

```typescript
export const inject = ['slots']

export function apply(ctx: Context) {
  // Settings card
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'scjira', order: 100 },
      ScjiraSettingsCard,
    ),
  )

  // Locale (idempotent)
  try {
    ctx.locale.register('scjira', { zh: zhCN, en: enUS })
  } catch {
    ctx.locale.register('scjira', { zh: zhCN })
  }

  // Sidebar tab type
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: '@ian/sc-jira',
    kind: 'scjira',
    title: () => 'sc-jira',
    guide: { order: 200, title: () => 'sc-jira', description: () => 'Jira & worklog & binding' },
  }))

  // Sidebar tab body
  ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: '@ian/sc-jira' },
      ScjiraTab,
    ),
  )
}
```

### 4.3 `ScjiraTab.tsx` — 3 sub-tabs

3 sub-tabs are **internal** to the scjira tab body (matches spec §4.3 PanelToggle pattern). Use local React state, no external component lib.

```tsx
function ScjiraTab({ t }: PropsRuntime<'sidebar.right.pane.tab'>) {
  const [active, setActive] = useState<'open' | 'worklog' | 'bind'>('open')
  return (
    <div className="scjira-tab">
      <nav className="scjira-subtab-bar">
        <button data-active={active==='open'}    onClick={()=>setActive('open')}>{t('tab.open')}</button>
        <button data-active={active==='worklog'} onClick={()=>setActive('worklog')}>{t('tab.worklog')}</button>
        <button data-active={active==='bind'}    onClick={()=>setActive('bind')}>{t('tab.bind')}</button>
      </nav>
      {active === 'open'    && <ListMyOpenPanel />}
      {active === 'worklog' && <WorklogWeekPanel />}
      {active === 'bind'    && <BindPanel />}
    </div>
  )
}
```

### 4.4 Client fetch pattern

- Browser → host HTTP routes via `window.fetch('/api/scjira/list-my-open')`
- Auth + Origin handled by dsh Connection (already proven in dshmarket)
- No separate Remote namespace — fetch + JSON parse keeps it simple, avoids Typert generation chain
- Settings card uses `ctx.remote.settings.describe()` for redacted descriptor + `ctx.remote.settings.update(ns, patch, revision)` to write

### 4.5 Locale keys

Namespace: `'scjira'`. Languages: zh-CN + en-US.

| Key | zh-CN | en-US |
|---|---|---|
| `tab.open` | 我的未完成 | My Open |
| `tab.worklog` | Worklog 周报 | Worklog Week |
| `tab.bind` | 绑定 Session | Bind Session |
| `status.empty` | 暂无数据 | No data |
| `bind.btn` | 绑定 | Bind |
| `bind.placeholder` | 输入 Jira key | Enter Jira key |
| `error.network` | 网络异常 | Network error |
| `settings.title` | sc-jira 配置 | sc-jira settings |

### 4.6 `cordis.patch.yml`

```yaml
- insert:
    - id: sc-jira
      name: '@ian/sc-jira'
```

### 4.7 `package.json`

```json
{
  "name": "@ian/sc-jira",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "files": ["lib", "client", "cordis.patch.yml"],
  "scripts": {
    "typecheck": "tsc --noEmit && tsc -p tsconfig.client.json --noEmit",
    "build": "tsc && npm run build:client",
    "build:client": "tsdown",
    "test": "vitest run",
    "lint": "oxlint src"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.1.0-rc.7",
    "@deepseek-ai/dsh-settings": "^0.1.0-rc.7",
    "@deepseek-ai/dsh-client-locale": "^0.1.0-rc.7",
    "@deepseek-ai/dsh-client-ui-sidebar-right": "^0.1.0-rc.7",
    "@deepseek-ai/dsh-client-ui-settings": "^0.1.0-rc.7",
    "@deepseek-ai/dsh-client-ui-primitives": "^0.1.0-rc.6",
    "react": "^18.0.0",
    "typescript": "^5.4.0",
    "vitest": "^2.0.0",
    "playwright": "1.63.0",
    "tsdown": "^0.6.0"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-sidebar-right",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-primitives"
      ]
    }
  }
}
```

---

## 5. Testing strategy

### 5.1 Static layer (must pass first)

```bash
cd plugins/sc-jira
pnpm run typecheck    # tsc --noEmit (host) + tsc -p tsconfig.client.json --noEmit (client)
pnpm run lint         # oxlint
```

### 5.2 Unit layer (vitest)

Six test files:

| File | Coverage |
|---|---|
| `handlers.test.ts` | 4 pure handlers with fake `JiraClient` + fake fs |
| `storage.test.ts` | meta.json read/write, schemaVersion validation, dshSessionId immutability |
| `jira-client.test.ts` | `spawn` mocked; covers 401/500/4xx/timeout/ok (no real network) |
| `settings.test.ts` | namespace registration, watch callback, `role('secret')` not in describe |
| `dispose.test.ts` | `apply → assert registrations exist → dispose → assert all cleared` |
| `bugs.test.ts` | spec §6 regression tests (6 cases) |

**`dispose.test.ts`** (CLAUDE.md §5.2 emphasized):

```typescript
test('apply dispose clears all registrations', async () => {
  const ctx = new Context()
  // fake settings, webServer, tools, sidebarRightTabs, slots
  // ...
  const fiber = ctx.plugin(apply)
  await fiber.start()
  expect(webServer.routes.length).toBeGreaterThan(0)
  expect(tools.list().length).toBe(4)
  await fiber.dispose()
  expect(webServer.routes.length).toBe(0)
  expect(tools.list().length).toBe(0)
})
```

**Mock strategy**: `vi.mock('node:child_process')` for spawn; no real network.

**tsconfig paths**: `vitest.config.ts` aliases to `src/`, NOT `lib/` (CLAUDE.md §5.2 hard rule — avoid double-singleton).

### 5.3 HTTP contract layer (curl)

```bash
# status check (works without config)
curl -sf http://127.0.0.1:3080/api/scjira/status | jq .

# 4 handlers (return 503 if settings unconfigured)
curl -sf http://127.0.0.1:3080/api/scjira/list-my-open | jq .
curl -sf 'http://127.0.0.1:3080/api/scjira/list-worklog-week?startDate=2026-09-14' | jq .
curl -sf 'http://127.0.0.1:3080/api/scjira/get-binding?sessionId=test-1' | jq .
curl -sf -X POST -H 'Content-Type: application/json' \
     -d '{"sessionId":"test-1","taskKey":"DZ300-1826"}' \
     http://127.0.0.1:3080/api/scjira/bind | jq .
```

### 5.4 Browser layer (Playwright probe)

Fork `plugins/hello-dsh/scripts/probe.mjs`, change 5 places:
1. `BASE`, `OUT_DIR`
2. `SESSION` candidate selector
3. After loading session: click sidebar `+` to open add-tab popover
4. Assert `'sc-jira'` text appears in popover
5. Click sc-jira entry → wait for 3 sub-tab buttons → assert `'我的未完成'` text

Console / pageerror monitoring preserved. Exit code: PASS=0, FAIL=2.

### 5.5 Spec §6 regression tests (`bugs.test.ts`)

| Test | Simulates | Asserts |
|---|---|---|
| `bug-1-worklog-author-filter` | cross-author worklog mixed in | filtered out before dayTotal |
| `bug-2-displayname-vs-login` | `author='Ian Yin'` (displayName) | matches via displayName branch |
| `bug-3-worklog-truncation` | issue with 133 worklogs | all retrieved via `/issue/{key}/worklog` pagination |
| `bug-4-key-re` | `client.issue('not-a-key')` | early returns `{ ok:false }`, no network call |
| `bug-5-locale-re-register` | `apply` called twice | second call doesn't throw |
| `bug-6-host-client-coupling` | single plugin hosts both | both cleaned on dispose |

### 5.6 Self-test loop (CLAUDE.md §5.5)

```
改 → static → unit → HTTP → browser
失败 → console / pageerror / DOM 文本 + 截图路径 喂回 Agent
```

---

## 6. Out of scope (explicit)

- Renaming spec terminology (e.g., `dshSessionId`, `key`, `summary`) — kept verbatim
- `log.jsonl` / `summary/0.json` writing — spec mentioned but no functional requirement; skip for v0.1
- Multiple Jira instances / multi-user support
- Token rotation flow (settings replacement IS supported, no special UX)
- i18n beyond zh-CN + en-US
- Mobile / electron UI surfaces (web only per dsh.client.platform)
- Persisting full `issueSummary` on bind — spec did, but only summary string is needed for `getBinding` return; keep minimal subset

---

## 7. Open questions resolved

| Question | Resolution |
|---|---|
| Static package can deliver 3-tab UI? | Yes, via `ctx.sidebarRightTabs.register` + `ctx.slots.inject('sidebar.right.pane.tab', ...)` |
| Credentials injection? | `ctx.settings.register('scjira', schema)` with `role('secret')` on token |
| Bind storage location? | `~/.dsh/profiles/web/scjira/tasks/{KEY}/meta.json` (spec path, persistent across DSH restart) |
| Tools AND UI? | Both. UI for direct viewing, tools for agent loop |
| Single-plugin vs split? | Single plugin hosts both host+client (avoids spec §6.6 bug) |

---

## 8. Success criteria

1. `pnpm run typecheck && pnpm run lint` exits 0
2. `pnpm run test` passes 6 files, including 6 spec §6 regression tests
3. `curl /api/scjira/status` returns `{ ok:true }` when settings configured
4. `node scripts/probe.mjs` exits 0; screenshot shows scjira sidebar tab with 3 sub-tab buttons
5. Agent can call `jira_list_my_open` tool from any session and receive `IssueSummary[]`
6. `bind` action persists meta.json that survives DSH restart
7. Disposing plugin fiber removes all 4 routes, 4 tools, 1 sidebar tab, 1 settings card

---

## 9. Implementation order

1. Scaffold `plugins/sc-jira/` + `package.json` + `cordis.patch.yml` + tsconfig
2. `src/types.ts` (IssueSummary, WorklogEntry, ScjiraSettings)
3. `src/storage.ts` (meta.json IO + schemaVersion check)
4. `src/jira-client.ts` (JiraClient with spawn curl)
5. `src/handlers.ts` (4 pure handlers)
6. `src/index.ts` (host apply: settings + 4 routes + 4 tools)
7. `src/client/index.ts` (settings card + locale + sidebar tab)
8. `src/client/ScjiraTab.tsx` + 3 sub-tab panels + SettingsCard
9. 6 test files + `vitest.config.ts` with `src/` alias
10. `scripts/probe.mjs` forked from hello-dsh
11. `pnpm install` + `pnpm run build` + install into profile
12. Run 4-layer test pyramid, fix any failures
13. Report: peer packages installed, routes/tabs/tools registered, test results

---

**End of spec.** Awaiting user review before invoking writing-plans skill.
