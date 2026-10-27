# sc-jira v2 — 设计规格（Specification Document）

> 这是从这次 DSH 会话中沉淀下来的设计规格。**不是代码**。DSH 重新启动后，scjira-7 的 runtime plugin 已丢失，disk 上的源码也已丢失（workspace 的非 git tracked 内容被清掉）。这份文档记录了**当前最后一次活跃版本（scjira-7/pkg-10）**的完整规格，用于将来重写或迁移。

---

## 1. 概念

scjira v2 是 DSH 的一个 dynamic Cordis plugin，目标：

- 在 DSH web UI 的 "对话 / 轨迹 / **sc-jira**" 三个 tab 中加一个 **sc-jira** tab
- 让用户能在 tab 里查看**自己（Ian Yin / A003688）**的 Jira 数据
- 让用户能把**当前 DSH session** 绑定到一个**Jira issue**，建立 1:1 映射

---

## 2. 当前部署状态（已丢失）

| 字段 | 最后已知值 |
|---|---|
| Plugin ID | **scjira-7** |
| Package ID | **pkg-10** |
| State | `running`（DSH 重启后变为 `lost`） |
| Run ID | `run-16`（最后一次激活） |
| Host handlers | 4 个：`scjira.list_my_open`, `scjira.list_worklog_week`, `scjira.get_binding`, `scjira.bind` |
| Client tabs | 3 个：我的未完成 / Worklog 周报 / 绑定 Session |
| Storage | `~/.dsh/profiles/web/scjira/`（DSH 重启**保留**——这不在 workspace 里） |

---

## 3. 架构

```
DSH workspace root (ephemeral on restart)
└── .docs/sc-jira-v2/          ← 完全 ephemeral（git untracked，被 DSH 重启清掉）
    ├── design.md
    ├── STATUS.md
    └── pkg-61-{host,client}.js # source of truth (已 lost)

DSH home (persistent across restarts)
└── .dsh/profiles/web/scjira/  # plugin runtime data
    └── tasks/
        ├── DZ300-1234/        # mock data from pkg-43 era
        │   ├── meta.json        # {schemaVersion: 3, dshSessionId: <agent.id>, ...}
        │   ├── log.jsonl
        │   └── summary/0.json
        └── DZ300-1744/        # older mock data
```

---

## 4. 数据流

### 4.1 Host 半（Node vm sandbox）

**Jira 凭证**（硬编码 — 技术债，迁移到 settings 后应移除）：

> ⚠️ **2026-10-27 归档时已脱敏**：下文 `token` 字段原本包含真实的 Jira API token，
> 已被 GitHub push protection 拦截并在此替换为占位符。历史值已作废，
> 现行凭证保存在 `~/.dsh/settings.yaml` 的 `scjira.token`（`role('secret')`）。

```javascript
const HARDCODED = {
  server: 'https://jiraprod.sercomm.com',
  login: 'A003688',
  displayName: 'Ian Yin',
  token: '<REDACTED — 已作废，见上方说明>',
}

const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/  // e.g. DZ300-1234
const STORAGE_SEGMENTS = ['profiles', 'web', 'scjira']
```

**HTTP client**: 通过 `ctx.subprocess.spawn(['curl', ...])` 调用 Jira REST API（DSH sandbox 禁用了 `fetch`，只能用 curl）。

每个 handler 调：
- `client.issue(key)` → `GET /rest/api/2/issue/{key}`
- `client.worklogs(key, { startAt, maxResults })` → `GET /rest/api/2/issue/{key}/worklog?startAt=...&maxResults=...`
- `client.search({ jql, maxResults, fields })` → `GET /rest/api/2/search?jql=...`

### 4.2 4 个 Host Handlers

#### `scjira.list_my_open()`

```javascript
JQL: assignee = "A003688" AND resolution = Unresolved ORDER BY duedate ASC, priority DESC
fields: summary,description,status,priority,assignee,reporter,duedate,
        created,updated,resolution,timetracking,worklog
maxResults: 50
返回:
{ ok: true, issues: [IssueSummary], totalSpentSeconds: number, jql: string }
```

#### `scjira.list_worklog_week({ startDate?: string })`

```javascript
const start = mondayOf(startDate)            // UTC 周一
const end = addDaysUtc(start, 7)
const jql = `worklogDate >= "${start}" AND worklogDate < "${end}" AND worklogAuthor = currentUser() ORDER BY updated DESC`

// 关键 bug fix: 不要用 /search 的 fields.worklog（被 maxResults=100 静默截断）
// 改用 /issue/{key}/worklog 端点，pageSize=1000，分页拉满
const issueKeys = await client.search({ jql, maxResults: 100, fields: 'summary,status' })
const worklogs = []
for (const raw of issueKeys) {
  const all = await fetchAllWorklogs(raw.key)
  for (const w of all) {
    if (w.author !== HARDCODED.login && w.author !== HARDCODED.displayName) continue
    const startedAt = w.started.slice(0, 10)
    if (startedAt >= start && startedAt < end) {
      dailyTotals[startedAt].seconds += w.timeSpentSeconds
      dailyTotals[startedAt].entries.push({ issueKey, issueSummary, started, timeSpentSeconds, comment, author })
      grandTotalSeconds += w.timeSpentSeconds
    }
  }
}
返回:
{
  ok: true,
  weekStart, weekEnd,
  dayLabels: [{ date, label: 'Mon'|'Tue'|..., seconds }],
  dailyTotals: { 'YYYY-MM-DD': { seconds, entries: [...] } },
  grandTotalSeconds, jql
}
```

#### `scjira.get_binding({ sessionId })`

```javascript
const tasksDir = `${dshHome}/profiles/web/scjira/tasks`
const entries = fs.listDir(tasksDir)
for (const entry of entries) {
  if (entry.type !== 'directory') continue
  const meta = JSON.parse(fs.readText(`${tasksDir}/${entry.name}/meta.json`))
  if (meta.dshSessionId === sessionId) {
    return { bound: true, key: meta.key, summary: meta.issueSummary?.summary || '', sessionId }
  }
}
return { bound: false }
```

#### `scjira.bind({ sessionId, taskKey })`

```javascript
if (!KEY_RE.test(taskKey)) return { ok: false, error: '...' }
const env = await client.issue(taskKey, {})      // 验证 Jira 上存在
if (!env.ok) return { ok: false, error: 'Jira rejected ' + taskKey }

// writeMetaWithBinding throws if existing.dshSessionId !== sessionId（immutable）
const meta = {
  schemaVersion: 3,
  key: taskKey,
  dshSessionId: sessionId,
  status: 'active',
  startedAt: new Date().toISOString(),
  issueSummary: { summary: env.body.fields.summary, ... },
  ...
}
fs.writeText(`${storageRoot}/tasks/${taskKey}/meta.json`, JSON.stringify(meta))
返回: { ok: true, key, sessionId, summary }
```

### 4.3 Client 半（Browser sandbox）

**3 个 tabs**，通过 `PanelToggle` 切换：

| Tab | 数据来源 | UI |
|---|---|---|
| **我的未完成** | `host.call('scjira.list_my_open')` | 一行一个 task：key badge + status pill + summary + description (markdown) + due chip + time chip |
| **Worklog 周报** | `host.call('scjira.list_worklog_week')` | 顶部 7 根柱状图（Mon-Sun，UTC 周）+ 详情列表 |
| **绑定 Session** | 下拉选 `list_my_open` 的 issues 或手填 key + Bind 按钮 | 状态卡片（绿/灰）+ dropdown + manual input + submit |

**Locale**: zh-CN (默认) + en-US，namespace `scjira`，通过 `ctx.locale.register('scjira', { zh, en })`。

**useSessions hook**: 从 standard hooks 拿 current sessionId（来自 props）。

**Idempotent locale.register**: try/catch 后用单 locale 重试（已修复 "already has locale" 错误）。

---

## 5. 数据形状

### 5.1 IssueSummary

```typescript
interface IssueSummary {
  key: string                          // 'DZ300-1826'
  id: string                           // Jira internal id
  summary: string                      // issue title
  description: string                   // HTML stripped
  statusName: string                   // 'In Progress', 'Open', etc.
  priority: string
  assignee: string                     // display name
  reporter: string
  duedate: string                      // 'YYYY-MM-DD' or ''
  created: string                      // ISO
  updated: string                      // ISO
  resolution: string                   // 'Done', 'Unresolved', etc.
  timeSpentSeconds: number
  originalEstimateSeconds: number
  remainingEstimateSeconds: number
  url: string                          // Jira browse URL
  worklogs: WorklogEntry[]             // 来自 fields.worklog（在 list_worklog_week 不依赖这个字段）
}

interface WorklogEntry {
  id: string
  author: string                       // displayName || name
  started: string                      // ISO with timezone
  timeSpentSeconds: number
  comment: string
}
```

### 5.2 meta.json schema v3

```json
{
  "schemaVersion": 3,
  "key": "DZ300-1826",
  "status": "active",
  "startedAt": "2026-09-11T17:47:00.000Z",
  "endedAt": null,
  "dshSessionId": "<current DSH agent.id>",
  "issueSummary": {
    "key": "DZ300-1826",
    "summary": "[IT] CAMP-00.04.004MR3",
    "statusName": "...",
    ...
  },
  "logCount": 0,
  "logBytes": 0,
  "summaryCount": 0
}
```

**`dshSessionId` 不可变性**：第一次写入后，任何后续 bind() 若 sessionId 不同则抛错。这是有意为之——防止误覆盖。

---

## 6. 已确认的 Bugs（不再发生需要 fix，但记录）

### 6.1 Bug 1: JQL `worklogAuthor` 不过滤 issue 内 worklog 数组

**症状**: 跨作者 entry 漏算入 user 的 daily totals（例：Joy Yu 在 DZ300-1659 上的 "Complete Devin and GitHub Copilot" entry 出现在 Ian Yin 的周报里）。

**修复**: 在 host `list_worklog_week` handler 内，对每条 worklog 加 `w.author === HARDCODED.login || w.author === HARDCODED.displayName` 过滤。

### 6.2 Bug 2: `displayName` vs `login` 不匹配

**症状**: 第一次修复用了 `w.author !== HARDCODED.login`，但 `w.author` 已经被 `summarizeSearchIssue` 转成 `displayName || name`，所以 Ian Yin自己也被过滤了。

**修复**: 接受两种匹配 `w.author !== HARDCODED.login && w.author !== HARDCODED.displayName`。

### 6.3 Bug 3: `/search?fields=worklog` 静默截断

**症状**: 当 issue 总 worklog 数 > 100（默认 maxResults），`fields.worklog` 数组被截断，导致用户在 DZ300-1659 (133 worklogs) 上的 9/15 SPEAR Training entry 完全丢失。

**修复**: 改用 `/rest/api/2/issue/{key}/worklog` 端点，pageSize=1000，分页拉满。

### 6.4 Bug 4: 未定义函数 `isJiraKey`

**症状**: `ReferenceError: isJiraKey is not defined` 在 host handler 内调用 `client.worklogs()` 时。

**原因**: `client.issue` 和 `client.worklogs` 内引用 `isJiraKey()`，但从未定义。之前未触发是因为只有 `scjira.bind` 调 `client.issue`，而 bind 未被 exercise。

**修复**: 全部替换为 `KEY_RE.test(key)`。

### 6.5 Bug 5: pkg-38 locale "already has locale"

**症状**: client apply 重跑时 `ctx.locale.register('scjira', { zh, en })` throw。

**修复**: try/catch 后回退到单 locale 注册。

### 6.6 Bug 6: pkg-37+pkg-39 split 把 host 停掉

**症状**: pkg-37 (host) + pkg-39 (client) 分别 define+run 后, update to pkg-39 时把 pkg-37 host 停掉, client.host.call 报 "not registered"。

**修复**: 把 host + client 合在同一个 Package (pkg-40+)。

---

## 7. DSH 兼容性约束（来自 packages/AGENTS.md）

如果将来要重写为标准 DSH static package:

| 约束 | 适用 |
|---|---|
| 命名 `@deepseek-ai/dsh-<area>-<name>` | 实验性走 `packages/experimental/scjira/`，命名 `@deepseek-ai/dsh-experimental-scjira` |
| Plugin exports: function form | `export const name / inject / Config / apply`，无 default export |
| `ctx.get` 用于 optional services，`ctx.<name>` 只用于 declared inject | 严格遵守 |
| Real-composition test 必需 | 通过 Loader boot test-only cordis.yml |
| Apply bounds to complete result | 给 maxResults, fetch timeout, file size 等加 min/max 校验 |
| No hardcoded tunables in plugins | token, server URL 应该走 Config，不再 HARDCODED 硬编码 |
| README: Model Experience + Known Limitations | 标准格式 |
| tsconfig: 双面 (host + client) | `tsconfig.host.json` + `tsconfig.client.json` + solution-only root |

---

## 8. 重写路径（将来如果真做）

### 8.1 Dynamic Cordis Plugin 现状 (推荐保持现状)

**优点**:
- 已有 working 代码
- 部署快（5-10 分钟）
- UX 完全符合预期

**缺点**:
- DSH 重启 → plugin 丢失
- workspace 清掉 → source 也丢
- 没法分享

### 8.2 Static DSH Package (需要 ~2 天工程)

如果走这条路：

| 步骤 | 工作量 |
|---|---|
| 创建 `packages/experimental/scjira/` 骨架（package.json + tsconfig + cordis.yml） | 30 min |
| 把 `pkg-61-host.js` 转 TS（src/host/）| 1 hr |
| 编写 ScjiraService 注册逻辑 | 1 hr |
| 把 `pkg-61-client.js` 转 TS（src/client/）| 1 hr |
| client 重构：删除 UI tab，改用 `ctx.get('scjira').listMyOpen()` | 30 min |
| cordis.yml 装载入口 | 30 min |
| 验证 `ctx.get('scjira')` 跨 sandbox 是否可行（**已知答案: NO**） | — |
| tests: host.test.ts REAL-composition | 1 hr |
| tests: hmr-safety.test.ts | 30 min |
| README | 30 min |
| pnpm install + build | 30 min |

**结论**: dynamic → static 不是"转化"，是**100% 重写**。且因为 client→host 即时 RPC (host.call) 是 dynamic Cordis plugin 独有机制，static package **不支持这个 UX 模式**。

**可能的妥协**: 删掉 client UI tab，改成 agent 主动调 tool 的 UX（不再是"点击 tab 立刻拉数据"，而是"agent 在 loop 里取数据"）。能 `dsh plugin add github:you/scjira`，但 UX 完全变。

---

## 9. 网络上同类工具

### ruflo (https://github.com/ruvnet/ruflo, 72k stars)

**形态**: 标准 npm package，走 DSH static package 路径。
- `v3/@claude-flow/codex/package.json` 等多个子包
- TypeScript → `dist/index.js`
- 发布到 npm: `claude-flow` v3.42.0
- 通过 `dsh plugin add @claude-flow/codex` 安装

**对比 ruflo vs scjira**:

| | ruflo | scjira |
|---|---|---|
| 形态 | npm package | runtime `.js` 文件 |
| 安装 | `dsh plugin add` | `cordis_define` |
| 持久 | ✅ 永久 | ❌ ephemeral |
| 分发 | npm registry | 仅你自己 workspace |

---

## 10. 历史部署日志

| 日期 | Plugin | Package | 事件 |
|---|---|---|---|
| 2026-09-11 | scjira-1 | pkg-1 | 初次 define + run, 用户批准 client |
| 2026-09-11..14 | scjira-1..6 | — | 反复 DSH 重启 + 重 define, scjira-5..6 实际不存在（subagent 误报告）|
| 2026-09-14 | scjira-6 | pkg-7 | 重新激活, BindPanel tab 因实现不完整被移除 |
| 2026-09-15 | scjira-6 | pkg-8 | 加 `/issue/{key}/worklog` 分页, 修复 DZ300-1659 worklog 静默丢失 bug |
| 2026-09-15 | scjira-6 | pkg-9 | 修 `isJiraKey` 未定义 ReferenceError |
| 2026-09-16 | scjira-6 | pkg-10 | 重写 client 加完整 BindPanel 实现, 3 tabs 恢复 |
| 2026-09-16 | scjira-7 | pkg-1 → pkg-10 | DSH 重启 → scjira-6 lost, 重新 define scjira-7, 重新激活到 pkg-10 |
| 2026-09-17 | scjira-7 | pkg-10 | workspace `.docs/sc-jira-v2/` 被清掉, disk source 丢失, runtime 仍 running |
| 2026-09-17 | — | — | DSH 重启 → scjira-7 lost, **disk + runtime 都丢了** |

---

## 11. 下次如果重做

最小可恢复路径:
1. 把这份文档 push 到 git repo
2. 任何时候 DSH 重启，从这份文档的 §4 spec 反推出完整 source
3. workspace 清掉时，scjira source 在 git 里仍有 backup

最务实路径:
- 接受 dynamic plugin 现状（它本来就是 DSH 给个人用户的合法通道）
- workspace 清掉时，所有"我的工作"应该 git commit 到 `.docs/sc-jira-v2/`
- 写个脚本，DSH 启动时自动检测 + 重 define（但这要求 DSH 有 startup hook——目前**没有** generic startup hook 机制）

---

## 12. 联系人 / 上下文

- 会话 ID: 持续 DSH session
- 用户: Ian Yin (A003688)
- Jira 实例: `https://jiraprod.sercomm.com`
- Bearer token: 已 hardcoded (见 §4.1) — 应在重写时迁移到 settings
- 时区: Asia/Taipei (+0800)

---

**写于 2026-09-17 DSH session 末尾。DSH workspace 已清理，scjira-7 已丢失。本文档是唯一残留的 source-of-truth 记录。**
