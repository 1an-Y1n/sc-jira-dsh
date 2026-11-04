# sc-jira v4 — Worklog 重做：会话内记录 → 用户触发生成 → 上传

> **状态**：设计稿 v1，待评审后实施
> **前置**：[v3 session binding](../design/v3-session-binding.md)（已废弃）、[v2 spec](../specs/sc-jira-v2-spec.md)
> **日期**：2026-11-04
> **取代**：v3 的「自动记账 + 本地账本 + 审核上传」整套机制

---

## 1. 为什么重做

v3 的账本有三个毛病，都已确认：

1. **数字不可信**。turn 墙钟把等模型、等用户、人走开的时间都算进工时，只能靠 60s 下限 + 4h 上限 + 向上取整打补丁。
2. **中间层没人看**。账本、草稿态、上传面板、回拉，一整套状态机只为了「把时间写进 Jira」这一件事；而 Jira 本来就有 worklog。
3. **记录和事实脱节**。宿主机只知道「调用了 bash/read」，不知道这一轮到底做了什么；所以账本里的 comment 只能是 `auto: turn 3` 这种没有信息量的东西。

v4 换一个分工：

> **宿主负责「测量」，agent 负责「解释」，人负责「拍板」。**

- 宿主只测时间（turn 跨度），不做任何解释，也不往账本里塞条目；
- agent 在过程中把「做了什么 + 花了多久」写成**活动记录**——它知道自己在干嘛，宿主不知道；
- 用户在结束时触发 agent 把活动记录**汇总成一份 worklog 草稿**，review 后上传。

这样 v3 里最难解释的「自动记账」消失了：不再有「记了但没上传」的堆积，也不再有一堆 `auto: turn N`。

---

## 2. 目标与非目标

### 目标

- **G1 一个 session 绑一个 ticket**，绑定是这份 worklog 的归属，也是它的生命周期边界。
- **G2 agent 能记录**：过程中随时写一条活动（做了什么 + 耗时），耗时可以省略，由宿主按「距上次记录」补。
- **G3 宿主只测量**：每轮 turn 的起止入库，仅用于两件事——给活动补默认耗时、生成时提示「记录缺口」。
- **G4 用户触发生成**：agent 把活动汇总成 Jira 形状的草稿条目（时长 + 说明 + 起始时间），可以合并/改写/丢弃。
- **G5 审核后上传**：草稿在面板逐行勾选，只上传选中的；失败可重试；已同步的不可再生成覆盖。
- **G6 可追溯**：每条草稿条目记得它覆盖了哪些活动（`activityIds`），活动记得它来自哪个 turn。

### 非目标

- 不做跨 session 的工时聚合（周报是 Jira 侧的读，已经存在）。
- 不做「轮次摘要」文件（v3 的 `summary/N.json` 删除，活动记录即摘要）。
- 不做自动上传（上传永远是显式选择的结果）。
- 不做 Jira 侧的二次编辑同步（v3 的「从 Jira 重新拉取」不做；需要改就删了重记）。

---

## 3. 生命周期

```
                 bind(taskKey)
   unbound ─────────────────────────▶ bound
      ▲                                 │
      │                                 │ record_activity(summary, seconds?)
      │                                 │ （可多次，边做边记）
      │                                 ▼
      │                              recording
      │                                 │
      │                                 │ 用户说「生成 worklog」→ agent 调
      │                                 │ generate_worklog(entries?)
      │                                 ▼
      │                               draft ──── upload_worklog(ids) ────▶ uploaded
      │                                 │                                  │
      └──────────── unbind ─────────────┘                                  │
                       │                                                  │
                       └────────── 仍有 draft 时 unbind 被拒 ◀─────────────┘
```

三条硬规则：

1. **有未上传草稿时不能解绑**（先上传或丢弃），避免记录丢失。
2. **已同步的条目永不覆盖**；`generate` 只为「还没被任何已同步条目覆盖的活动」生成新条目。
3. **活动只能追加**，不提供删除（写错了就再写一条修正，生成时由 agent 合并——审计优先）。

---

## 4. 数据模型

### 4.1 一处状态：一个 session 一个文件

```
{storeDir}/{sessionId}.json          # 默认 storeDir = ~/.dsh/profiles/web/scjira/sessions
```

选 session 而不是 issue 作为键，理由：

- 绑定的单位就是 session（一个 session 就是一个 worklog 的产出方）；
- 每个文件只有一个写入者（宿主上该 session 的进程 / 面板 HTTP），不存在跨 session 争用；
- 同一个 ticket 被多个 session 做过时，各写各的，上传后都在 Jira 上，不需要跨 session 合并。

```jsonc
{
  "schemaVersion": 1,
  "sessionId": "session-dc7569f8-…",

  "binding": {                        // null = 未绑定
    "key": "DZ300-797",
    "summary": "[CAMP] Automatically save the logs during alignment",
    "statusName": "RD Develop",
    "url": "https://jiraprod.sercomm.com/browse/DZ300-797",
    "boundAt": "2026-11-04T03:10:11.212Z"
  },

  "activities": [                     // 追加，agent 写
    {
      "id": "act-03",
      "summary": "读寄存器转储，确认 panic 出在 local_irq_enable 路径",
      "startedAt": "2026-11-04T09:12:00.000+0800",
      "seconds": 1800,
      "turn": 3,
      "source": "agent"               // agent = 显式给了时长；derived = 宿主补的
    }
  ],

  "turns": [                          // 追加，宿主写，只为了测量与缺口提示
    { "turn": 3, "startedAt": "…", "endedAt": "…", "seconds": 2040 }
  ],

  "draft": {                          // null = 还没生成过
    "generatedAt": "2026-11-04T11:20:00.000Z",
    "entries": [
      {
        "id": "wl-01",
        "startedAt": "2026-11-04T09:12:00.000+0800",
        "seconds": 1800,
        "comment": "定位 panic 到 local_irq_enable 路径",
        "activityIds": ["act-03"],    // 这条覆盖了哪些活动
        "state": "draft",             // draft | synced | failed
        "jiraId": null,
        "syncedAt": null,
        "error": null
      }
    ]
  }
}
```

**为什么 activities 和 turns 分开**：一个是解释，一个是测量。合并会让「这个数字是哪来的」重新变得不可回答。生成时两者都读，缺口就是两条时间轴之差。

### 4.2 写入方式

- 单文件、读改写、`write tmp → rename`（原子）；进程内按 sessionId 加一把串行锁，防同一轮里两个工具调用交错写。
- 读失败（文件不存在）= 空文档，不报错。
- 文件损坏（JSON 解析失败）= 报错并**不覆盖**（避免把还能救的数据抹掉），由人决定删不删。

---

## 5. 时间模型

### 5.1 测量（宿主，自动）

`agent/turn-stopping` 时追加一条 `turns`：turn 号、首 step 准入时刻、结束时刻、跨度。只做记录，不产生任何工时。

### 5.2 记录（agent，显式）

`jira_record_activity({ summary, seconds?, startedAt? })`：

| 字段 | 省略时 |
|---|---|
| `summary` | 必填 |
| `seconds` | 宿主补：`now - since`，`since` = 上一条活动的结束时间，否则 `binding.boundAt` |
| `startedAt` | 宿主补：`now - seconds`（+0800） |

补出来的秒数过策略：

- 下限 `minSeconds`（默认 60）：不足则**拒绝**并告诉 agent「距上次记录不足 1 分钟，请给显式时长或继续工作」；
- 向上取整到 `rounding`（默认 60）；
- 单条封顶 `maxSecondsPerActivity`（默认 4h）；
- 显式给 `seconds` 时不套下限/取整，只做 `> 0` 与封顶校验——调用方自己量过的时间不该被改写。

策略放在配置里（不再藏在每个 meta.json 里，见 §9）。

### 5.3 时区

`startedAt` 一律 `+0800` 固定偏移（Jira 服务器 Asia/Taipei 同偏移）。Jira 上传用 `started` 带偏移，不用 UTC。

---

## 6. 工具与接口

### 6.1 工具（host，agent 可调）

| 工具 | 参数 | 作用 |
|---|---|---|
| `jira_bind` | `taskKey` | 绑定本 session。校验 key 存在；已绑定且无未上传草稿时允许换绑（旧绑定作废）；有未上传草稿时拒绝 |
| `jira_unbind` | — | 解绑。有未上传草稿时拒绝 |
| `jira_record_activity` | `summary`、`seconds?`、`startedAt?` | 写一条活动，返回本条 + 累计 |
| `jira_worklog_state` | — | 一次读全：绑定、活动、测量合计、已记录合计、缺口、草稿与各条状态 |
| `jira_generate_worklog` | `entries?` | 生成草稿（见 §6.2） |
| `jira_upload_worklog` | `ids` | 上传指定条目（必填，空数组=不上传，返回待传列表） |

保留既有三个只读工具：`jira_list_my_open`、`jira_list_worklog_week`、`jira_issue`。合计 9 个。

**为什么上传要 `ids` 必填**：v3 的教训是「一条命令全传」的默认路径会诱导人不看就传。空数组返回待传列表，等同于让调用方先看。

### 6.2 `generate_worklog` 的两种模式

**模式 A：不带 entries（默认，安全）**

宿主按活动逐条生成：一条活动 → 一条草稿，`comment = activity.summary`、`seconds/startedAt` 照抄、`activityIds = [该活动]`。确定性、不会凭空造时长。

**模式 B：带 entries（agent 提议）**

```jsonc
{ "entries": [
  { "seconds": 5400, "comment": "排查并修复 panic", "activityIds": ["act-03","act-04"] },
  { "seconds": 1800, "comment": "补单元测试" }        // 无 activityIds = 不由活动派生
] }
```

宿主校验并**存疑不拦**：

- 每条 `seconds > 0`、`startedAt` 可省略（宿主按 `activityIds` 里最早的活动推，或按顺序回推）；
- 合计与「未覆盖活动的记录合计」不一致时，不拒绝，但在返回值里给出 `deltaSeconds` 和一句话说明——让人在 review 时看到差；
- `activityIds` 指向不存在的活动 → 拒绝；
- 已被**已同步条目**覆盖的活动 → 拒绝（防止重复计费）。

### 6.3 生成后的状态

`draft.entries` 里 `state` 只有三种：`draft` / `synced` / `failed`。再生成时：

- 已 `synced` 的条目**原样保留**，不再参与生成；
- 已 `draft`/`failed` 且未被同步覆盖的条目被**替换**（同一批活动的草稿重生成，幂等）；
- 新增活动 → 追加新条目。

### 6.4 路由（面板用）

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/scjira/status` | GET | 凭据状态（既有） |
| `/api/scjira/config` | POST | 设置写入（既有） |
| `/api/scjira/list-worklog-week` | GET | 周报（既有） |
| `/api/scjira/issue` | GET | issue 详情（既有） |
| `/api/scjira/worklog?sessionId=` | GET | 读该 session 的 worklog 文档（绑定 + 活动 + 草稿） |
| `/api/scjira/worklog/edit` | POST | 改一条草稿（秒数/说明/起始时间） |
| `/api/scjira/worklog/upload` | POST | 上传选中条目（`ids` 必填） |
| `/api/scjira/worklog/discard` | POST | 丢弃草稿（仅 `draft`/`failed`，已同步的不动） |

面板与工具走**同一批 handler**，所以两侧看到的状态永远一致。

### 6.5 命令

| 命令 | 作用 |
|---|---|
| `/jira-bind <key>` | 绑定（不带 key 时报告当前绑定与记录计数） |
| `/jira-unbind` | 解绑 |
| `/jira-worklog` | 文本摘要：绑定、记录合计、缺口、草稿条数与待传数 |

命令**不生成、不上传**——这两步都要经过 agent 或面板，避免「一条命令全传」。

### 6.6 宿主钩子

| 钩子 | 做什么 |
|---|---|
| `agent/pre-step` | 已绑定时注入**一行**：`[Jira] 本 session 绑定 DZ300-797；已记录 2h15m / 3 条；未上传草稿 2 条`。不注入 issue 正文（正文用 `jira_issue` 读） |
| `agent/turn-stopping` | 追加 `turns` 一条（测量） |

不订阅 `tools/post-execute`：不再有 scope 越界的概念。

---

## 7. 面板

Jira 标签页 → 三个子标签：

```
[ 本次 Worklog ] [ Worklog 周报 ] [ Issue 详情 ]
```

「本次 Worklog」结构：

```
┌ 绑定 ────────────────────────────────────────────────┐
│ DZ300-797 · [CAMP] Automatically save the logs…      │
│ 已记录 2h15m / 4 条 · 宿主测量 2h48m · 缺口 33m        │
│ [解绑]                                                │
└──────────────────────────────────────────────────────┘
┌ 活动 ────────────────────────────────────────────────┐
│ 09:12  30m  读寄存器转储，确认 panic 出在 …      turn 3 │
│ 09:45  45m  定位到 driver/xen/balloon.c 嫌疑      turn 3 │
└──────────────────────────────────────────────────────┘
┌ 草稿 ────────────────────────────────────────────────┐
│ ☑ 09:12  1h15m  排查并修复 panic     draft            │
│ ☐ 10:30  30m    补单元测试           ✓ synced #102839 │
│ [上传选中的 1 条]  [编辑] [丢弃草稿]                    │
└──────────────────────────────────────────────────────┘
```

- 未绑定时整块显示「本 session 未绑定 ticket」，并给一句「在对话里说 `/jira-bind DZ300-xxxx` 或让我帮你绑」。
- 未生成草稿时，草稿区显示「记录完成后，在对话里让我生成 worklog」。
- 缺口 > 0 用弱色提示，不阻止上传。

---

## 8. 代码结构

```
src/
  types.ts             IssueSummary / WorklogEntry / DayTotal（保留）
                       Activity / DraftEntry / SessionDoc / WorklogPolicy（新增）
  session-store.ts     读改写 + 原子写 + 每 session 串行锁；空文档/损坏分开处理
  time-policy.ts       localTimestamp / instantOf / deriveSeconds / explicitSeconds / gapSeconds
  worklog.ts           纯逻辑：可计费活动、生成与合并、增量覆盖、汇总
  worklog-handlers.ts  IO：bind / unbind / record / state / generate / upload / edit / discard
  jira-client.ts       issue/worklogs/search/comments（保留）+ addWorklog（恢复写）
  handlers.ts          只读 handler（listMyOpen / listWorklogWeek / issue）
  tool.ts              defineJiraTool（lossless 边界）
  lossless.ts          保留
  index.ts             apply：Config（含 policy）、路由、9 个工具、2 个钩子、3 条命令
  client/
    index.ts           设置卡片 + 会话视图（3 个子标签，inject sessionId）
    ScjiraView.tsx     三个子标签的壳 + 周报 + Issue 详情
    WorklogPanel.tsx   绑定区 + 活动区 + 草稿区（新）
    theme.ts           主题 token、表格样式、fmtSeconds / fmtInstant / browseUrl（新）
    draft.ts           设置卡片的表单脏检查（保留）
```

删除（v3 遗留，已在上一次重构删除，不再回来）：`scope.ts`、`session-log.ts`、`storage.ts`、`turn-timer.ts`、`worklog-ledger.ts`、`worklog-handlers.ts`。

---

## 9. 配置

```ts
Config = {
  server, login, token, displayName, proxy,   // 既有
  storeDir:  string   = ~/.dsh/profiles/web/scjira/sessions
  worklog: {                                   // 策略进配置，不再藏在每个 meta.json
    minSeconds: 60,
    rounding: 60,
    maxSecondsPerActivity: 14400,
  }
}
```

v3 把 policy 写进每个 `meta.json`，却没有入口能改（`updateAutoWorklog` 无调用方），是个死旋钮。v4 把它放回配置，能在设置卡片里改。

---

## 10. 实施阶段

| 阶段 | 内容 | 产出 | 验收 | 估时 |
|---|---|---|---|---|
| **P1** | `types.ts` 扩展、`session-store.ts`、`time-policy.ts` | 数据层 | 原子写/并发写/损坏文件/空文件的测试；时间策略边界测试 | 0.5d |
| **P2** | `bind` / `unbind` / `worklog_state` + `agent/pre-step` 注入 | 能绑、能读 | 绑/换绑/解绑规则；未上传草稿时拒绝解绑；上下文注入只有一行 | 0.5d |
| **P3** | `record_activity` + `agent/turn-stopping` 测量 | 能记 | 省略秒数按「距上次」补；下限拒绝；封顶；两条时间轴都对 | 0.5d |
| **P4** | `worklog.ts` + `generate_worklog`（A/B 两模式） | 能生成 | 逐条生成的确定性；增量覆盖；已同步不覆盖；delta 提示；重复生成幂等 | 1d |
| **P5** | `JiraClient.addWorklog` + `upload_worklog` + 失败重试 | 能上传 | 成功回填 jiraId；失败留 error；只传选中；空 ids 返回待传列表 | 0.5d |
| **P6** | 面板三区 + 4 条路由 | 能看能审 | 勾选/编辑/上传/丢弃；未绑定与未生成的空态；状态徽标 | 1.5d |
| **P7** | 命令 3 条 + 客户端装饰（可选：`/jira-bind` 选择器） | 人的入口 | 命令不进模型上下文；结果在 UI 单独渲染 | 0.5d |
| **P8** | README/docs 重写、探针脚本更新、端到端验收 | 文档与验收 | 真机跑一遍「绑定→记录→生成→上传→Jira 上可见」 | 0.5d |

合计约 **5.5 人日**。P1–P5 可以先出 host 半边（工具可跑），P6 之后补界面。

### 端到端验收脚本（P8）

1. 新 session → `jira_bind('DZ300-797')`；
2. 做两件事，各记一条活动（一条给秒数、一条省略）；
3. 再跑一轮对话，检查 `turns` 里多了一条、缺口正确；
4. 说「生成 worklog」→ agent 调 `generate_worklog`，检查草稿条数与合计；
5. 手动改一条的说明 → 面板里重新读，确认落盘；
6. 勾选一条上传 → Jira 上看到 worklog（`timeSpent` 正确、`started` 时区正确）；
7. 解绑 → 被拒绝（还有一条草稿）；上传剩下那条 → 解绑成功；
8. 重启宿主 → 再读 `worklog_state`，状态完整。

---

## 11. 风险与取舍

| 风险 | 取舍 / 缓解 |
|---|---|
| agent 忘记记录，最后没有素材 | 生成时给出测量缺口；面板用弱色提示；不改回自动记账——宁可缺，不要凭空数字 |
| agent 虚报时长 | 模式 B 允许它提议，但 `delta` 必须暴露；`activityIds` 溯源；人在面板上拍板 |
| 一个 session 干了多个 ticket 的事 | 绑定只有一条；跨 ticket 的部分需要另开 session 或记到当前 ticket（advisory 时代的越界概念已删除） |
| 长会话文件变大 | 活动/测量都是追加；一个 session 通常几十条，百 KB 级；超出可加归档（后续） |
| 两个宿主同时写同一 session | 同一 session 只在一个宿主上 live（带 session.lock），写入串行锁兜底 |
| 上传后才发现数字错了 | Jira 侧可改/可删（v2 已验证 PUT/DELETE）；本地只记录 jiraId，不做二次同步 |

---

## 12. 待确认的决策

| # | 议题 | 我的建议 | 备选 |
|---|---|---|---|
| 1 | 状态按 session 还是按 ticket 存 | **按 session** | 按 ticket（跨 session 合并，但写入者不唯一） |
| 2 | 一轮没记录时是否补一条兜底活动 | **不补**，只在生成时提示缺口 | 补一条「未命名」草稿（回到 v3 的老问题） |
| 3 | 生成由谁触发 | **用户在对话里触发 agent** | 面板按钮直接机械生成 |
| 4 | 换绑策略 | **有未上传草稿时拒绝** | 允许换绑并把旧草稿冻结 |
| 5 | 上传入口 | **面板勾选为主，工具为辅（ids 必填）** | 只允许面板 |
| 6 | 策略放哪 | **配置（可在设置卡片改）** | 每个绑定单独存（v3 的死旋钮） |

确认后我按 P1 → P8 实施，每个阶段落一次提交并跑测试。
