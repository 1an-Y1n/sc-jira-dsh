# sc-jira v3 — 设计方案：Session 绑定的上下文约束与自动工时

> **状态**：设计稿，待评审
> **前置**：[sc-jira v2 spec](../../../../dsh-src/.docs/sc-jira-v2-spec.md)、[2026-09-17-sc-jira-design.md](../superpowers/specs/2026-09-17-sc-jira-design.md)
> **日期**：2026-10-27

---

## 1. 背景：v2 的绑定功能只实现了 20%

v2 的「绑定 Session」只实现了**记录一条关联关系**，用户设想的三个目标均未达成：

| 目标 | v2 现状 | 缺口 |
|---|---|---|
| ① agent 上下文只处理该 ticket 相关内容 | ❌ 无 | 绑定写进 `meta.json` 后**没有任何代码读取它**来做约束；4 个工具中只有 `jira_get_binding` 被动查询，`jira_list_my_open` / `jira_list_worklog_week` 完全不看绑定 |
| ② 自动进行 worklog | ❌ 无 | `JiraClient` 只有 `issue()` / `worklogs()` / `search()`，**全是 GET**；没有 `POST /worklog`，没有任何触发器 |
| ③ session ↔ ticket 1:1 映射 | ⚠️ 部分 | `dshSessionId` 不可变 → ticket→session 唯一；但一个 session 可绑多个 ticket，`get_binding` 遍历目录命中第一个即返回 |

v2 的设计文档其实**已承认**这一点 —— `2026-09-17-sc-jira-design.md` §6「Out of scope (explicit)」：

> `log.jsonl` / `summary/0.json` writing — spec mentioned but no functional requirement; **skip for v0.1**

遗留的 `tasks/DZ300-1234/log.jsonl` 和 `summary/0.json` 就是那套自动记录机制的**格式样例**，从未被实现。

v2 spec §1 对原始目标的表述也只有「建立 1:1 映射」，**从没提过约束上下文和自动 worklog**。本方案补齐的正是这两项。

---

## 2. 目标与非目标

### 目标

- **G1 上下文收敛**：session 绑定 ticket 后，agent 的工具调用默认且**仅**作用于该 ticket；越界调用被显式拒绝并说明原因
- **G2 自动工时**：turn 结束后自动把该轮耗时写入 Jira worklog，无需人工干预
- **G3 双向 1:1**：绑定时双向校验，两个方向都不允许重复占用
- **G4 可审计**：每条自动工时可追溯到产生它的 turn；本地保留 session 日志与轮次摘要
- **G5 可关闭**：所有自动行为可单独开关，默认安全

### 非目标

- 不做多 Jira 实例 / 多用户
- 不做工时审批流
- 不做跨 session 的工时聚合（那是周报，已实现）
- 不改动 v2 已有工具的语义（只新增窄化视图 + 显式越界工具）

---

## 3. 关键事实（已验证，非推测）

### 3.1 DSH 侧

| 事实 | 来源 | 影响 |
|---|---|---|
| `Agent.id` **就是** `SessionId` | `packages/core/agent/src/types.ts:15` | 宿主侧可用 `exec.agent.id` 直接拿到 client 传的 sessionId，**两侧标识天然对齐** |
| `conversation.view` 的 `inject(sessionId)` 传同一标识 | `packages/client/ui-trajectory/src/client/index.ts:88` | 现有绑定键无需改动 |
| `tools/pre-execute` 是 waterfall，可 `deny` | `packages/core/tools/src/index.ts:146` | **G1 的实现点**：`{kind:'deny', reason}` |
| `tools/post-execute` 可返回 `additionalContexts` | `packages/core/tools/src/index.ts:169,600` | 可把绑定信息作为上下文回灌给模型 |
| `agent/pre-step` 可注入 `UserMessage[]` | `packages/core/agent/src/runtime-types.ts:320` | **G1 的实现点（备选）**：在每步前注入「当前 ticket」上下文 |
| `agent/turn-stopping` 是 serial 事件，turn 收尾时触发 | `packages/core/agent/src/runtime-types.ts:381` | **G2 的实现点**：自动工时的计时终点 |
| `tool/call` / `tool/result` 是持久事件 | `docs/architecture.md:107` | 可用于统计每轮的工具调用明细 |
| 事件按 agent 作用域过滤分发 | `dsh-scope` | 监听器可只关心自己负责的 session |

### 3.2 Jira 侧（**对生产实例实测**，非文档推断）

实测目标：`https://jiraprod.sercomm.com`

| 结论 | 实测结果 |
|---|---|
| 写入端点 | `POST /rest/api/2/issue/{key}/worklog` → **HTTP 201** ✅ |
| 时间字段 | **`timeSpent`**（Jira 时长字符串，如 `"1m"` / `"2h"`）—— `timeSpentSeconds` **不被接受**（400） |
| 起始时间 | `started` 接受 ISO 带偏移量（`"2026-10-26T09:00:00.000+0800"`），**回填历史时间有效** ✅ |
| 调整预估 | `adjustEstimate` 字段在此版本**不被接受**（400 unrecognized field）；`/adjustment` 端点**不存在**（404）→ v3 不做预估联动 |
| 服务器时区 | `Asia/Taipei` (+0800) —— 与 `Asia/Shanghai` **偏移量相同但 IANA 名不同**，跨时区比较需按偏移处理 |
| 删除 | `DELETE /rest/api/2/issue/{key}/worklog/{id}` → 204 ✅（用于回滚/去重） |

> 实测产生的探针数据均已删除（`DZ300-797` worklog 总数已归 0）。

---

## 4. 方案总览

```
┌─────────────────────────────────────────────────────────────┐
│  绑定层 BindingService（新增）                                │
│  双向索引 sessionId ⇄ key，meta.json schema v4                │
└───────────────┬─────────────────────────────────────────────┘
                │
    ┌───────────┴────────────┬─────────────────────┐
    │                        │                     │
┌───▼──────────────┐  ┌──────▼──────────────┐  ┌───▼─────────────┐
│ G1 上下文收敛      │  │ G2 自动工时          │  │ G3 1:1 校验      │
│ tools/pre-execute │  │ agent/turn-stopping │  │ bind 时双向检查   │
│  → deny 越界调用   │  │  → 计时 + POST 工时  │  │                  │
│ agent/pre-step    │  │ tool/call 统计明细   │  │                  │
│  → 注入 ticket ctx │  │                      │  │                  │
└───────────────────┘  └─────────────────────┘  └─────────────────┘
```

---

## 5. 数据模型：meta.json schema v4

沿用 v3 的目录布局 `{tasksDir}/{KEY}/meta.json`，升级字段：

```jsonc
{
  "schemaVersion": 4,
  "key": "DZ300-797",
  "status": "active",              // active | ended
  "startedAt": "2026-10-26T09:21:36.867Z",
  "endedAt": null,
  "dshSessionId": "session-abc",    // 保留：ticket → session（唯一）
  "issueSummary": { /* 同 v3 */ },
  "logCount": 0,
  "logBytes": 0,
  "summaryCount": 0,

  // ── v3 未实现、v4 落地的字段 ──
  "worklogs": [                    // 本地工时账本（与 Jira 侧对应）
    {
      "id": "wl-1",                 // 本地 id
      "jiraId": "102785",           // Jira worklog id（写入后回填）
      "turn": 3,                   // 产生它的 turn 号
      "step": 2,
      "seconds": 1800,
      "comment": "auto: turn 3",
      "startedAt": "2026-10-26T09:00:00.000+0800",
      "state": "synced"            // pending | synced | failed
    }
  ],
  "sessionLog": [                  // 对应遗留的 log.jsonl（v2 从未实现）
    { "ts": "...", "text": "...", "source": "command" }
  ],
  "summaries": [                   // 对应遗留的 summary/N.json
    { "turnSeq": 0, "writtenAt": "...", "body": { "text": "...", "highlights": [], "blockers": [] } }
  ],
  "autoWorklog": {
    "enabled": true,
    "mode": "turn",                // turn | step | off
    "minSeconds": 60,              // 低于此值不记，避免噪声
    "rounding": 60,                // 向上取整到分钟
    "maxSecondsPerTurn": 14400     // 单轮上限 4h，防止挂机刷时长
  }
}
```

**兼容策略**：读 v3 时若缺 v4 字段，按默认值补齐并写回（`schemaVersion` 升级为 4）。**不迁移**遗留的 v1 `meta.json`（`DZ300-1744`），继续按「schemaVersion 不匹配则忽略」处理 —— 与 v2 行为一致。

### 4.1 双向索引

`meta.json` 是唯一真相源，但 `get_binding` 需要「session → key」查询，v2 靠遍历目录（O(n)）。v3 增加一个**派生索引文件**：

```
{tasksDir}/.index.json     ← 派生，可随时从 meta.json 重建
{
  "schemaVersion": 1,
  "bySession": { "session-abc": "DZ300-797" },
  "byKey":     { "DZ300-797": "session-abc" }
}
```

- 写入时先改 `meta.json`，再原子更新 `.index.json`（写临时文件 + rename）
- 索引与 meta 不一致时，以 meta 为准并重建索引（自愈）
- `.index.json` 不参与 `readdir` 遍历（跳过 `.` 前缀）

---

## 6. G1：上下文收敛

### 6.1 两种模式

| 模式 | 行为 | 适用 |
|---|---|---|
| **`narrow`（默认）** | 绑定后，jira_* 工具**只能**作用于绑定的 ticket；越界 → `deny` | 「这个上下文只处理这个 ticket」的强语义 |
| **`advisory`（宽松）** | 工具仍可作用于任意 ticket，但每次调用**注入**当前绑定信息作为上下文 | 探索期，不想被硬拦 |

模式是 **session 级设置**，存于 settings 命名空间（新增 `scopeMode` 字段），默认 `narrow`。

### 6.2 实现：`tools/pre-execute` 拦截

```ts
ctx.on('tools/pre-execute', async (exec, next) => {
  if (!exec.agent) return next()                       // 无 agent（如 CLI 直调）→ 不管
  if (!isJiraTool(exec.name)) return next()

  const bound = bindings.bySession(exec.agent.id)
  if (!bound) return next()                            // 未绑定 → 保持 v2 行为，不拦

  const target = jiraTargetKey(exec.name, exec.arguments)
  if (target === null || target === bound.key) return next()

  // 越界
  if (mode === 'advisory') {
    // 不拦，但把「当前绑定」作为上下文附加 —— 由 post-execute 完成
    return next()
  }
  return {
    kind: 'deny',
    reason: `本 session 已绑定 ${bound.key}（${bound.summary}）。` +
            `工具 ${exec.name} 试图访问 ${target}，超出绑定范围。` +
            `如需处理其他 ticket，请新建 session 或先解绑。`,
  }
})
```

**`jiraTargetKey()` 的抽取规则**（每个工具能"指向"哪个 ticket）：

| 工具 | 目标 ticket | 越界判定 |
|---|---|---|
| `jira_list_my_open` | 无（全局列表） | **不拦** —— 它是「看我的任务」，不是「处理某 ticket」 |
| `jira_list_worklog_week` | 无（全局周报） | **不拦** |
| `jira_get_binding` | 无（查绑定） | 不拦 |
| `jira_bind` | `taskKey` | 绑定到别的 ticket → 拦 |
| `jira_issue`（新） | `key` | 拦 |
| `jira_log_worklog`（新） | `key` 或缺省=绑定项 | 拦 |
| `jira_comment`（新） | `key` | 拦 |

> 决策：**只读的全局视图不拦**。用户说的「只处理这个 ticket 相关的内容」指的是**写操作和单 ticket 操作**不该越界；让 agent 连「我的任务列表」都看不到反而有害（它需要上下文知道自己该做什么）。

### 6.3 实现：`agent/pre-step` 注入上下文

在每一步开始前，把当前绑定注入为上下文消息：

```ts
ctx.on('agent/pre-step', async (payload, next) => {
  const decision = await next()
  if (decision.kind !== 'enter') return decision

  const bound = bindings.bySession(payload.agent.id)
  if (!bound) return decision

  return {
    ...decision,
    messages: [
      ...decision.messages,
      {
        role: 'user',
        content: [{ type: 'text', text:
          `[Jira 上下文] 当前 session 绑定到 ${bound.key} — ${bound.summary}\n` +
          `状态: ${bound.statusName}  优先级: ${bound.priority}  负责人: ${bound.assignee}\n` +
          `本 session 的工作应限定在此 ticket 内。` }],
        source: 'agent.inject',   // ← 与 DSH 的合成注入同源，日志里可区分
      },
    ],
  }
})
```

注入是**每步一次**（不是每轮），保证长会话里上下文不会过时。成本约 100 token/步。

### 6.4 与 advisory 模式的上下文回灌

`advisory` 模式下，`tools/post-execute` 把绑定信息附加到结果里：

```ts
ctx.on('tools/post-execute', async (exec, result, next) => {
  const decision = await next()
  if (!isJiraTool(exec.name) || mode !== 'advisory') return decision
  const bound = bindings.bySession(exec.agent?.id)
  if (!bound || decision.kind !== 'accept') return decision
  return {
    ...decision,
    additionalContexts: [{
      role: 'user',
      content: [{ type: 'text', text: `[提示] 本 session 绑定到 ${bound.key}（${bound.summary}）` }],
    }],
  }
})
```

---

## 7. G2：自动工时

### 7.1 计时模型

**计时窗口 = 一个 turn 的墙钟时长**，从 agent 开始处理该 turn 到 `agent/turn-stopping` 触发。

```
turn 开始 ──────────────────────────── turn 结束
   │                                        │
   └────────── elapsed = end - start ──────┘
```

实现：在 `agent/pre-step` 首次进入时记录 `turnStart = Date.now()`（同一 turn 内只记一次）；在 `agent/turn-stopping` 计算差值。

> **为什么用 turn 而不是 step**：一个 turn 可能包含多个 step（模型调用 + 工具执行 + 继续），用户感知的一次「提问-回答」= 一个 turn。step 更细但会把工具执行时间算丢。

### 7.2 写入流程

```
agent/turn-stopping
  ↓
1. elapsed = now - turnStart
2. 若 elapsed < autoWorklog.minSeconds → 跳过（默认 60s）
3. 若 elapsed > autoWorklog.maxSecondsPerTurn → 截断（默认 4h）
4. seconds = ceil(elapsed / rounding) * rounding        （默认向上取整到分钟）
5. 查绑定 → 无绑定 → 跳过
6. 写本地账本 worklogs[]（state: pending）→ 落盘
7. POST /rest/api/2/issue/{key}/worklog
     body: { timeSpent: "<h>m <s>s", comment: "...", started: "<turnStart ISO +0800>" }
8. 成功 → 回填 jiraId, state: synced → 落盘
   失败 → state: failed, 记录错误 → 落盘（不打断 agent）
```

**失败绝不阻断 agent**。turn-stopping 是 serial 事件，异常会被框架捕获；我们**主动吞掉**错误，只记日志。

### 7.3 时间格式

- `timeSpent` 用 Jira 时长字符串：`<n>h <m>m`、`<m>m`、`<n>d`
- `started` 用 turn 开始时刻，格式 `YYYY-MM-DDTHH:mm:ss.SSS+0800`（**+0800 固定偏移**，因为 Jira 服务器时区是 Asia/Taipei，与 Asia/Shanghai 同偏移）
- 用 `+0800` 而非 `Z`：回填的历史时间按本地墙钟解释才对得上用户的一天

### 7.4 comment 内容

```
auto: turn 3 (5 tool calls) — DSH session <short-id>
```

让用户在 Jira 上能看出这条是自动记的、来自哪个 session。可配置为不含 session id。

### 7.5 去重与幂等

`agent/turn-stopping` 可能因重试/steering 触发多次。用 `(turn, step)` 做幂等键：

- 本地账本里已存在同 `turn` 且 `state != failed` 的记录 → 跳过
- `state == failed` → 允许重试（覆盖原记录）

### 7.6 用户可见性

自动工时**不能是黑箱**。绑定面板（子标签 3）增加：

- 本 session 已自动记工时：N 条，合计 Xh Ym
- 明细列表（turn 号、时长、状态 synced/failed）
- 「同步状态」徽标：pending 黄色 / synced 绿色 / failed 红色 + 错误信息
- 一个**「记一条工时」手动按钮**（补记漏掉的时长）

---

## 8. G3：双向 1:1

bind 时检查两个方向：

```
bind(sessionId, key):
  1. key 格式校验（KEY_RE）
  2. Jira 上确实存在（GET /issue/{key}）
  3. 双向检查：
     a. byKey[key] 存在且 != sessionId  → 拒绝：「该 ticket 已绑定到 session X」
     b. bySession[sessionId] 存在且 != key → 拒绝：「本 session 已绑定到 ticket Y，请先解绑」
  4. 写 meta.json + 重建索引
```

新增 **解绑** 能力（v2 没有）：

```
unbind(sessionId)  →  meta.json 标 status='ended'，从索引移除，保留历史
```

v2 的「dshSessionId 不可变」规则**放宽为「同一 ticket 的 session 绑定不可变，除非先解绑」** —— 因为不放宽的话，用户永远无法把一个 ticket 转给另一个 session，而这是真实需求（handoff）。

> 保留一条硬规则：**同一 session 不能同时绑多个 ticket**（v2 允许，是 bug）。

---

## 9. 新增工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `jira_issue` | `key` | 读单个 issue 详情（含描述全文、评论列表） |
| `jira_log_worklog` | `key?`, `seconds?`, `comment?` | 手动记工时；`key` 缺省=当前绑定；`seconds` 缺省=自上次记录以来的墙钟时长 |
| `jira_comment` | `key?`, `body` | 在 issue 上加评论 |
| `jira_unbind` | — | 解绑当前 session |
| `jira_current` | — | 返回当前 session 的绑定详情 + 已记工时 |

`jira_current` 是**给 agent 的自我感知工具** —— 让它随时知道「我在为哪个 ticket 工作、已经记了多少工时」。

---

## 10. 配置

settings 命名空间 `scjira` 新增：

```ts
{
  server, login, token, displayName, proxy,     // 现有
  scopeMode:  'narrow' | 'advisory',             // 默认 narrow
  autoWorklog: {
    enabled:  boolean,                          // 默认 true
    mode:     'turn' | 'step' | 'off',           // 默认 turn
    minSeconds: number,                         // 默认 60
    rounding:  number,                          // 默认 60
    maxSecondsPerTurn: number,                  // 默认 14400
    includeSessionId: boolean,                  // 默认 true（写进 comment）
  },
}
```

---

## 11. 实施顺序

| 阶段 | 内容 | 产出 | 估时 |
|---|---|---|---|
| **P1** | `JiraClient.addWorklog()` + `deleteWorklog()` + 时长格式化 | 能写工时 | 0.5 天 |
| **P2** | schema v4 + 双向索引 + 解绑 + `jira_current` | 绑定层完整 | 1 天 |
| **P3** | `tools/pre-execute` 窄化 + `agent/pre-step` 注入 | **G1 达成** | 1 天 |
| **P4** | turn 计时 + 自动写工时 + 幂等 | **G2 达成** | 1.5 天 |
| **P5** | UI：自动工时明细 + 同步状态 + 手动补记 | 可观测 | 1 天 |
| **P6** | `jira_issue` / `jira_comment` / `jira_log_worklog` | 工具完善 | 1 天 |

**里程碑**：P1+P2+P3 后，G1 与 G3 达成（约 2.5 天）；P1+P2+P4 后，G2 达成（约 3 天）。

---

## 12. 风险与取舍

| 风险 | 缓解 |
|---|---|
| `tools/pre-execute` 拦截影响非绑定 session | 只在 `bySession` 命中时启用；未绑定 session 行为完全不变 |
| turn 墙钟包含用户思考时间（模型思考时用户没在等） | `maxSecondsPerTurn` 截断；`minSeconds` 过滤；`rounding` 取整。**这是本方案最大的近似**，Jira 无法区分「思考」和「编码」 |
| 自动写工时污染 Jira 数据 | 默认开启但**完全可见可改**（UI 明细 + 可删除）；comment 明确标注 `auto:`；提供一键关闭 |
| `agent/pre-step` 注入增加 token 成本 | 每步 ~100 token；仅绑定 session 生效 |
| 双写（本地账本 + Jira）不一致 | 本地先落盘再写 Jira，失败标 `failed` 可重试；Jira 侧是唯一真相，本地只是缓存 |
| `dshSessionId` 不可变规则放宽引入误覆盖 | 改绑必须显式 `unbind`，且 UI 明示当前绑定对象 |
| 事件时序：turn-stopping 是否总触发 | v2 spec 已确认「turn 没有工具或 steering 后续时运行」；空 turn（用户发了消息模型没回）可能不触发 → 兜底用 `turn/end` 持久事件补一次 |

---

## 13. 需要确认的问题

1. **turn 墙钟 = 工时**，可接受吗？Jira 无法区分「读代码 30 分钟」和「盯着屏幕发呆 30 分钟」。备选：只统计**工具执行时间**（`tool/call`→`tool/result` 求和），更精确但会严重低估（大部分思考时间不涉及工具）。
2. **`narrow` 还是 `advisory` 默认？** `narrow` 语义强但可能误伤（比如 agent 想先查一下别的 issue 再回到主线）。
3. **自动工时默认开还是默认关？** 我倾向**默认开**（这正是用户的核心诉求），但配一个明显的开关。
4. **是否保留 `log.jsonl` / `summary/` 的目录形态？** v2 遗留数据是这个形态；改为 v4 里的数组字段更简单，但会丢失「按文件追加」的可读性。

---

## 附录 A：与遗留数据的关系

```
~/.dsh/profiles/web/scjira/tasks/
├── .index.json                    ← v3 新增（派生索引）
├── DZ300-1234/
│   ├── meta.json                  ← schemaVersion 1，v3 忽略（不迁移）
│   ├── log.jsonl                  ← v2 遗留样例，v3 不读
│   └── summary/0.json             ← v2 遗留样例，v3 不读
└── DZ300-1744/
    └── meta.json                  ← schemaVersion 1，v3 忽略
```

**不迁移遗留数据** —— 它们是 mock 数据（内容是"重启后内核 panic"这类与真实 issue 无关的样例），迁移反而会污染新账本。

## 附录 B：实测证据（本次设计验证）

对生产 Jira 实例 `jiraprod.sercomm.com` 的临时探针，**全部已回滚**：

| 探针 | 结果 |
|---|---|
| `POST /worklog` 空 body | 400「必须标示工作耗费的时间」→ 确认端点与必填字段 |
| `POST /worklog {"timeSpentSeconds":1}` | 400 → **确认该字段不被接受** |
| `POST /worklog {"timeSpent":"1m"}` | **201**，返回 `id:102783` |
| `POST /worklog {"timeSpent":"1m","adjustEstimate":"new"}` | 400 unrecognized field → **确认不做预估联动** |
| `POST /worklog {"timeSpent":"2m","started":"...+0800"}` | **201**，回填历史时间成功 |
| `PUT /issue/{key}/adjustment` | 404 → 端点不存在 |
| `DELETE /worklog/{id}` | 204 → 确认可回滚 |

最终校验：`DZ300-797` 的 worklog 总数 **0**，探针 comment 残留 **0**。
