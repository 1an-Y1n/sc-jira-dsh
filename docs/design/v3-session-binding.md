# sc-jira v3 — 设计方案：Session 绑定的上下文约束与自动工时

> **状态**：设计稿 v2（已并入评审意见），待实施
> **前置**：[v2 spec](../specs/sc-jira-v2-spec.md)、[2026-09-17 设计稿](../specs/2026-09-17-sc-jira-design.md)
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

---

## 2. 已确认的决策

| # | 议题 | 决策 |
|---|---|---|
| 1 | turn 墙钟作为工时 | ✅ **接受**。但 Jira worklog UI 需支持**修改工时时间** → 见 §8.4（`PUT /worklog/{id}` 已实测可用） |
| 2 | 上下文收敛模式默认 | ✅ **`advisory`**（不硬拦，改为注入提示） |
| 3 | 自动工时默认开关 | ✅ **默认开** |
| 4 | 日志文件形态 | ✅ **保留文件形态**（`log.jsonl` / `summary/N.json`），不改成数组字段 |
| a | 工时更新时机 | ✅ **本地优先**：随 session 推进实时更新本地账本，**不自动上传**；用户在 worklog 页面 review 后**手动触发上传** |
| b | 绑定入口 | ✅ 提供 **`/jira-bind` 命令** |

> **决策 a 改变了架构重心**：v3 的自动工时不再是「turn 结束时直接写 Jira」，而是
> **「本地实时记账 → 人工 review → 手动批量上传」**。Jira 写入从「副作用」降级为「显式动作」。
> 这同时消除了「自动写脏数据」的最大风险，也符合决策 1 的「需要能改」。

---

## 3. 目标与非目标

### 目标

- **G1 上下文收敛（advisory）**：绑定后 agent 每步都知道当前 ticket 是哪个、边界在哪；越界操作**提示但不阻断**
- **G2 本地优先的自动记账**：随 session 推进实时记录工时到**本地文件**；用户 review 后手动上传
- **G3 工时可编辑**：本地和 Jira 两侧都能改工时时长与起始时间
- **G4 双向 1:1**：绑定时双向校验，两个方向都不允许重复占用
- **G5 可审计**：每条工时可追溯到产生它的 turn；`log.jsonl` + `summary/N.json` 落地
- **G6 命令入口**：`/jira-bind` 完成绑定，附带 `/jira-worklog` 查看与上传

### 非目标

- 不做多 Jira 实例 / 多用户
- 不做工时审批流
- 不做跨 session 的工时聚合（周报已实现）
- 不改动 v2 已有工具的语义（只新增窄化视图 + 显式越界工具）

---

## 4. 关键事实（已验证，非推测）

### 4.1 DSH 侧

| 事实 | 来源 | 影响 |
|---|---|---|
| `Agent.id` **就是** `SessionId` | `packages/core/agent/src/types.ts:15` | 宿主侧可用 `exec.agent.id` 直接拿到 client 传的 sessionId，**两侧标识天然对齐** |
| `conversation.view` 的 `inject(sessionId)` 传同一标识 | `packages/client/ui-trajectory/src/client/index.ts:88` | 现有绑定键无需改动 |
| `tools/pre-execute` 是 waterfall，可 `deny` | `packages/core/tools/src/index.ts:146` | `narrow` 模式的实现点（`advisory` 不需要） |
| `tools/post-execute` 可返回 `additionalContexts` | `packages/core/tools/src/index.ts:169,600` | **advisory 模式的实现点**：把绑定信息回灌给模型 |
| `agent/pre-step` 可注入 `UserMessage[]` | `packages/core/agent/src/runtime-types.ts:320` | **advisory 模式的实现点**：每步注入 ticket 上下文 |
| `agent/turn-stopping` 是 serial 事件，turn 收尾时触发 | `packages/core/agent/src/runtime-types.ts:381` | **本地记账的写入时机** |
| `ctx.commands.register()` 注册宿主命令 | `packages/interaction/commands/README.md` | **`/jira-bind` 的实现点** |
| `ctx.commandUi` 注册客户端命令/装饰 | `packages/client/ui-commands/src/client/contract.ts:38,68` | `/jira-bind` 的**弹出选择器**实现点 |
| `dsh-commands` 在 base bundle、`dsh-client-ui-commands` 在 web-app bundle | in-box `cordis.patch.yml` | **开箱可用，无需额外安装** |
| `tool/call` / `tool/result` 是持久事件 | `docs/architecture.md:107` | 统计每轮工具调用明细 |

### 4.2 Jira 侧（**对生产实例实测**，探针全部已回滚）

| 结论 | 实测结果 |
|---|---|
| 创建工时 | `POST /rest/api/2/issue/{key}/worklog` → **HTTP 201** ✅ |
| **修改工时** | `PUT /rest/api/2/issue/{key}/worklog/{id}` → **HTTP 200** ✅，`timeSpent` 与 `started` **均可改**（实测 30m→1h 30m、09:00→14:30） |
| 删除工时 | `DELETE /rest/api/2/issue/{key}/worklog/{id}` → 204 ✅ |
| 时间字段 | **`timeSpent`**（Jira 时长字符串，如 `"1m"` / `"1h 30m"`）—— `timeSpentSeconds` **不被接受**（400） |
| 起始时间 | `started` 接受 ISO 带偏移量，**回填历史时间有效** ✅ |
| 调整预估 | `adjustEstimate` **不被接受**（400）；`/adjustment` 端点**不存在**（404）→ v3 不做预估联动 |
| 服务器时区 | `Asia/Taipei` (+0800) —— 与 `Asia/Shanghai` **偏移量相同但 IANA 名不同** |

---

## 5. 架构总览（本地优先）

```
┌──────────────────────────────────────────────────────────────┐
│  绑定层 BindingService                                        │
│  双向索引 sessionId ⇄ key；meta.json v4                       │
└───────────┬──────────────────────────────────────────────────┘
            │
  ┌─────────┴──────────┬──────────────────────┐
  │                    │                      │
┌─▼────────────────┐ ┌─▼──────────────────┐  ┌─▼────────────────┐
│ G1 上下文（advisory）│ │ G2 本地优先记账     │  │ G3 工时可编辑     │
│ agent/pre-step      │ │ turn 结束 → 写本地  │  │ 本地编辑 → 落盘   │
│  → 注入 ticket 上下文│ │  worklog.jsonl     │  │ 上传后 → PUT Jira │
│ tools/post-execute  │ │ 不上传！            │  │ Jira 侧编辑 → 回读 │
│  → 越界时附加提示    │ │ 用户 review 后手动  │  │                   │
└────────────────────┘ └────────────────────┘  └───────────────────┘
            │
  ┌─────────▼──────────┐
  │ G6 /jira-bind      │  ← 客户端 popupSelect 选 ticket
  │ ctx.commands       │     宿主 handler 执行绑定
  │ ctx.commandUi      │
  └────────────────────┘
```

**关键变化**：Jira 写入不再是自动副作用，而是**用户显式触发的批量上传**。

---

## 6. 数据模型

### 6.1 目录布局（保留 v2 的文件形态）

```
{tasksDir}/{KEY}/
├── meta.json           ← schemaVersion 4（绑定状态 + 索引元数据）
├── worklog.jsonl       ← 【新增】本地工时账本，每行一条
├── log.jsonl           ← 【启用】session 活动日志
└── summary/
    ├── 0.json          ← 【启用】第 0 轮摘要
    └── 1.json          ← 【启用】第 1 轮摘要
{tsasksDir}/.index.json ← 派生双向索引
```

### 6.2 `worklog.jsonl` —— 本地工时账本

每行一条 JSON，追加写入（`O_APPEND`，天然并发安全）：

```jsonc
// 第 1 行
{"id":"wl-01","turn":3,"step":2,"seconds":1800,"comment":"auto: turn 3","startedAt":"2026-10-26T09:00:00.000+0800","state":"draft","jiraId":null,"createdAt":"2026-10-26T10:12:00.000+0800"}
// 第 2 行（用户改过时长）
{"id":"wl-02","turn":4,"seconds":3600,"comment":"手动补记","startedAt":"2026-10-26T11:00:00.000+0800","state":"draft","jiraId":null,"createdAt":"2026-10-26T12:00:00.000+0800"}
// 第 3 行（已上传）
{"id":"wl-03","turn":5,"seconds":2700,"comment":"auto: turn 5","startedAt":"2026-10-26T13:00:00.000+0800","state":"synced","jiraId":"102839","createdAt":"2026-10-26T14:00:00.000+0800","syncedAt":"2026-10-26T14:30:00.000+0800"}
```

| 字段 | 含义 |
|---|---|
| `id` | 本地 id（`wl-NN`，单调递增） |
| `turn` / `step` | 产生它的 turn / step 号（可追溯） |
| `seconds` | 工时秒数 —— **可编辑**（决策 1） |
| `comment` | 工时说明 —— 可编辑 |
| `startedAt` | 起始时间（含 +0800 偏移）—— **可编辑** |
| `state` | `draft`（本地待上传） / `synced`（已上传） / `failed`（上传失败） |
| `jiraId` | Jira worklog id（上传后回填） |
| `createdAt` / `syncedAt` | 记账时间 / 上传时间 |

**编辑语义**：本地编辑时，若该行 `state == synced`，**同时**通过 `PUT /worklog/{jiraId}` 更新 Jira 侧；若 `state == draft`，只改本地。

**上传语义**：`state == draft` 的行批量 POST 到 Jira，成功后回填 `jiraId` 并置 `synced`。

> 文件用 `jsonl` 而非数组字段，是为了**追加写**（O_APPEND 原子追加，不必读改写整个文件），
> 同时保留人工可读性 —— 这正是决策 4 的理由。

### 6.3 `meta.json` schema v4

```jsonc
{
  "schemaVersion": 4,
  "key": "DZ300-797",
  "status": "active",              // active | ended
  "startedAt": "2026-10-26T09:21:36.867Z",
  "endedAt": null,
  "dshSessionId": "session-abc",
  "issueSummary": { /* 同 v3 */ },
  "logCount": 0,                   // ← 现在真的会被更新（log.jsonl 行数）
  "logBytes": 0,                   // ← 同上
  "summaryCount": 0,               // ← 同上（summary/ 下文件数）
  "autoWorklog": {
    "enabled": true,               // ← 决策 3：默认开
    "minSeconds": 60,
    "rounding": 60,
    "maxSecondsPerTurn": 14400
  }
}
```

**兼容策略**：读 v3 时缺 v4 字段按默认值补齐并写回（`schemaVersion` 升 4）。
**不迁移**遗留的 v1 `meta.json`（`DZ300-1744`）—— 与 v2 行为一致（版本不匹配则忽略）。

### 6.4 `log.jsonl` / `summary/N.json`（启用 v2 遗留的格式）

沿用遗留样例的字段，不重新设计：

```jsonc
// log.jsonl —— 每行一条 session 活动
{"ts":"2026-10-26T03:35:00.000Z","text":"重启后内核 panic，开始看寄存器","source":"command"}

// summary/0.json —— 每轮一份摘要
{
  "schemaVersion": 1,
  "key": "DZ300-797",
  "turnSeq": 0,
  "writtenAt": "2026-10-26T04:00:00.000Z",
  "body": {
    "text": "读了寄存器转储，确认 panic 出在 local_irq_enable 路径",
    "highlights": ["定位到 driver/xen/balloon.c 嫌疑"],
    "blockers": []
  }
}
```

**写入时机**：`summary/N.json` 在 turn 结束时写（`turnSeq` = turn 号）；
`log.jsonl` 在工具执行时追加（`source: "command"`）。摘要内容由 agent 自己产出 ——
通过 `tools/post-execute` 收集该轮的工具调用摘要，或让 agent 在 turn 结束时调
`jira_summarize` 工具写入。**后者更准确**（agent 知道自己在做什么），作为主路径。

### 6.5 双向索引 `.index.json`

```jsonc
{
  "schemaVersion": 1,
  "bySession": { "session-abc": "DZ300-797" },
  "byKey":     { "DZ300-797": "session-abc" }
}
```

派生文件，以 `meta.json` 为准；不一致时自动重建（自愈）。跳过 `.` 前缀目录。

---

## 7. G1：上下文收敛（advisory 模式）

### 7.1 语义

`advisory` = **不阻断，只提示**。

- 绑定后，每步都向模型注入当前 ticket 的上下文
- agent 若访问了别的 ticket，**不 deny**，但在结果里附加一条提示
- 用户可在设置里切到 `narrow` 获得硬拦截

### 7.2 注入上下文（`agent/pre-step`）

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
          `[Jira 上下文] 本 session 绑定到 ${bound.key} — ${bound.summary}\n` +
          `状态: ${bound.statusName}  优先级: ${bound.priority}  负责人: ${bound.assignee}\n` +
          `本 session 的工作应限定在此 ticket 内。` }],
        source: 'agent.inject',
      },
    ],
  }
})
```

每步一次（约 100 token），保证长会话里上下文不过时。

### 7.3 越界提示（`tools/post-execute`）

```ts
ctx.on('tools/post-execute', async (exec, result, next) => {
  const decision = await next()
  if (!isJiraTool(exec.name)) return decision

  const bound = bindings.bySession(exec.agent?.id)
  if (!bound) return decision

  const target = jiraTargetKey(exec.name, exec.arguments)
  if (target === null || target === bound.key) return decision   // 未绑定或未越界

  if (mode === 'narrow') {
    return { kind: 'block', feedback: [{ type: 'text', text: narrowRefusal(bound, target) }] }
  }
  // advisory：附加提示，不阻断
  return {
    ...decision,
    additionalContexts: [{
      role: 'user',
      content: [{ type: 'text', text:
        `[提示] 本 session 绑定到 ${bound.key}（${bound.summary}），` +
        `但 ${exec.name} 访问了 ${target}。请确认这是否必要。` }],
    }],
  }
})
```

> advisory 模式下 `decision.kind` 可能是 `block`（被别的 hook 拦了），此时不覆盖，
> 只在 `accept` 时附加 `additionalContexts`。

### 7.4 哪些工具算「指向某个 ticket」

| 工具 | 目标 ticket | advisory 越界提示 |
|---|---|---|
| `jira_list_my_open` | 无（全局列表） | 不提示 |
| `jira_list_worklog_week` | 无（全局周报） | 不提示 |
| `jira_get_binding` / `jira_current` | 无（查绑定） | 不提示 |
| `jira_bind` | `taskKey` | 提示 |
| `jira_issue`（新） | `key` | 提示 |
| `jira_log_worklog`（新） | `key` 或缺省=绑定项 | 提示 |
| `jira_comment`（新） | `key` | 提示 |

**决策**：只读的全局视图不提示。agent 需要看到「我该做什么」。

---

## 8. G2：本地优先的自动记账

### 8.1 记账时机

**turn 结束时**写一条本地 `worklog.jsonl`：

```
agent/turn-stopping
  ↓
1. elapsed = now - turnStart          （turn 墙钟）
2. elapsed < minSeconds (60s)  → 跳过
3. elapsed > maxSecondsPerTurn (4h) → 截断
4. seconds = ceil(elapsed / 60) * 60  （向上取整到分钟）
5. 查绑定 → 无绑定 → 跳过
6. 追加一行到 worklog.jsonl，state = "draft"     ← 【本地写完就结束，不上传】
```

**绝不写 Jira。** 上传由用户显式触发（§8.3）。

### 8.2 计时窗口

```
turn 开始 ──────────────────────────── turn 结束
   │                                        │
   └────────── elapsed = end - start ──────┘
```

turn 开始时刻在 `agent/pre-step` 首次进入时记录（同一 turn 只记一次）。
用 turn 而非 step：一次「提问-回答」= 一个 turn，step 更细但会把模型思考时间算丢。

### 8.3 手动上传（review → upload）

**UI（绑定子标签新增「工时账本」区）**：

```
┌─ Worklog 账本 ──────────────────────────────┐
│  本地 6 条 · 合计 12h 30m · 已同步 2 条       │
│                                               │
│  ┌ 2026-10-26 09:00  1h 30m  [编辑]  draft   │
│  │ turn 3 · auto: turn 3                      │
│  └───────────────────────────────────────────� │
│  ┌ 2026-10-26 11:00  1h 00m  [编辑]  draft   │
│  │ turn 4 · 手动补记                          │
│  └───────────────────────────────────────────� │
│  ┌ 2026-10-26 13:00  45m     [编辑]  ✓ synced │
│  │ turn 5 · jira #102839                     │
│  └───────────────────────────────────────────� │
│                                               │
│  [ 上传 4 条未同步工时 ]      [同步全部]      │
└───────────────────────────────────────────────┘
```

- **编辑**：弹出表单改 `seconds` / `startedAt` / `comment`
  - `draft` 行 → 只改本地
  - `synced` 行 → 改本地 **并** `PUT /worklog/{jiraId}` 同步 Jira
- **上传**：`state == draft` 的行批量 POST → 成功后回填 `jiraId`、置 `synced`
- **同步全部**：把所有 draft 行上传
- 每行显示状态徽标：draft 灰 / synced 绿 / failed 红 + 错误信息

**工具侧**同样提供（供 agent 主动上报）：

| 工具 | 参数 | 说明 |
|---|---|---|
| `jira_log_worklog` | `key?`, `seconds?`, `comment?` | 记一条工时到**本地**；`key` 缺省=当前绑定；`seconds` 缺省=自上次记录以来的墙钟时长 |
| `jira_worklogs` | `key?` | 读**本地**账本 + 已同步状态 |
| `jira_upload_worklogs` | `key?` | 手动触发上传本地 draft 行 |
| `jira_summarize` | `text`, `highlights?`, `blockers?` | 写入 `summary/N.json` |

> **注意**：`jira_log_worklog` 也只写本地。agent 不能自主上传 —— 上传是**人的决定**。

### 8.4 Jira 侧工时编辑（决策 1）

用户也可以直接在 Jira 的 worklog UI 里改 —— 那是 Jira 自己的功能，v3 不干涉。

但 v3 需要**感知** Jira 侧的改动，否则本地账本会与 Jira 漂移。方案：

- 绑定面板提供「**从 Jira 重新拉取**」按钮 → 读 `GET /issue/{key}/worklog`，
  按 `started` + `seconds` 匹配本地行，更新 `state` / `jiraId`
- 不自动同步（避免反复请求 Jira）；用户点一次即可

匹配规则：以 `startedAt`（±60s 容差）+ `seconds` 为主键匹配本地 `synced` 行；
匹配上 → 更新 `comment` / `seconds`；匹配不上 → 新增一行 `state: synced, source: jira`。

---

## 9. G3：双向 1:1 与解绑

```
bind(sessionId, key):
  1. key 格式校验（KEY_RE）
  2. Jira 上确实存在（GET /issue/{key}）
  3. 双向检查：
     a. byKey[key] 存在且 != sessionId  → 拒绝：「该 ticket 已绑定到 session X」
     b. bySession[sessionId] 存在且 != key → 拒绝：「本 session 已绑定到 ticket Y，请先解绑」
  4. 写 meta.json + 重建索引
```

新增 `unbind(sessionId)`：meta.json 标 `status='ended'`，从索引移除，**保留** `worklog.jsonl` 历史。

v2 的「dshSessionId 不可变」放宽为「必须先解绑才能转给别的 session」—— handoff 是真实需求。
**同一 session 不能同时绑多个 ticket**（v2 允许，是 bug）。

---

## 10. G6：`/jira-bind` 命令

### 10.1 宿主侧命令

```ts
ctx.effect(() => ctx.commands.register({
  definitionId: CommandDefinitionId('@ian/sc-jira'),
  name: 'jira-bind',
  description: 'Bind this session to a Jira issue',
  input: { hint: '<issue-key>' },
  handler: async ({ agent, rawInput }): Promise<CommandResult> => {
    const sessionId = agent.id

    // 带 key 直接绑
    const key = rawInput.trim()
    if (key) {
      const r = await bindSession(sessionId, key)
      return r.ok
        ? { kind: 'success', text: `已绑定到 ${r.key} — ${r.summary}` }
        : { kind: 'error', text: r.error }
    }

    // 不带 key → 返回候选列表，让客户端 popup 处理
    const bound = bindings.bySession(sessionId)
    return {
      kind: 'success',
      text: bound
        ? `本 session 已绑定 ${bound.key}（${bound.summary}）。要换绑请先 /jira-unbind。`
        : '请指定 Jira issue key，或从 /jira-bind 菜单中选择。',
    }
  },
}))
```

命令**不产生模型消息**（`dsh-commands` 的语义），结果在 UI 里单独渲染。

### 10.2 客户端弹出选择器

```ts
ctx.commandUi.register({
  name: 'jira-bind',
  label: () => t('cmd.bind.label'),        // '绑定 Jira Issue'
  description: () => t('cmd.bind.desc'),
  icon: TicketIcon,
  available: () => true,
  ui: {
    kind: 'popupSelect',
    async options(session) {
      const open = await fetchJson(`/api/scjira/open-issues`)
      return open.issues.map(i => ({
        id: i.key,
        label: `${i.key} — ${i.summary}`,
        detail: i.statusName,
        active: (await currentBinding())?.key === i.key,
      }))
    },
    async onSelect(option, session) {
      await fetchJson('/api/scjira/bind', {
        method: 'POST',
        body: JSON.stringify({ sessionId: session.sessionId, taskKey: option.id }),
      })
    },
  },
})
```

- 选项来自 `GET /api/scjira/open-issues`（新增路由：我的未完成 issue 列表）
- 选中后调用 bind 路由
- 已绑定的项用 `active: true` 标记

**同时提供 `/jira-unbind` 和 `/jira-worklog`**（后者打开工时账本面板）。

### 10.3 为什么用命令而不是只用 UI 按钮

- 命令可**带参数**：`/jira-bind DZ300-797` 一步到位
- 命令**不进入模型上下文**（`dsh-commands` 的 `recordInput` 语义），不会污染对话
- 命令结果在 session log 里有记录，可追溯

---

## 11. 新增工具汇总

| 工具 | 参数 | 说明 |
|---|---|---|
| `jira_issue` | `key` | 读单个 issue 详情（描述全文 + 评论） |
| `jira_log_worklog` | `key?`, `seconds?`, `comment?` | **本地**记一条工时 |
| `jira_worklogs` | `key?` | 读本地账本 + 同步状态 |
| `jira_upload_worklogs` | `key?` | 手动触发上传 |
| `jira_summarize` | `text`, `highlights?`, `blockers?` | 写 `summary/N.json` |
| `jira_comment` | `key?`, `body` | 在 issue 上加评论 |
| `jira_current` | — | 当前绑定详情 + 已记工时统计 |
| `jira_unbind` | — | 解绑 |

**保留** v2 的 4 个：`jira_list_my_open` / `jira_list_worklog_week` / `jira_get_binding` / `jira_bind`
（`jira_bind` 语义不变，仍然写绑定，只是不上传工时）。

---

## 12. 配置

```ts
{
  server, login, token, displayName, proxy,     // 现有
  scopeMode:  'advisory' | 'narrow',            // ← 决策 2：默认 advisory
  autoWorklog: {
    enabled:  true,                             // ← 决策 3：默认开
    minSeconds: 60,
    rounding: 60,
    maxSecondsPerTurn: 14400,
    includeSessionId: true,
  },
}
```

---

## 13. 实施顺序

| 阶段 | 内容 | 产出 | 估时 |
|---|---|---|---|
| **P1** | `JiraClient.addWorklog()` / `updateWorklog()` / `deleteWorklog()` + 时长格式化 | 能读写 Jira 工时 | 0.5 天 |
| **P2** | 本地账本：`worklog.jsonl` 追加/编辑/读取 + `meta.json` v4 + 双向索引 | 本地账本层 | 1 天 |
| **P3** | `agent/pre-step` 注入 + `tools/post-execute` 提示（advisory） | **G1 达成** | 1 天 |
| **P4** | turn 计时 + 本地记账 + `log.jsonl` + `summary/N.json` | **G2 达成（本地部分）** | 1.5 天 |
| **P5** | UI 工时账本面板（review / 编辑 / 上传 / 从 Jira 重拉） | **G2 达成（上传部分）+ G3** | 1.5 天 |
| **P6** | `/jira-bind` `/jira-unbind` `/jira-worklog` 命令 + 客户端 popup | **G6 达成** | 1 天 |
| **P7** | 新工具（`jira_issue`/`jira_log_worklog`/`jira_upload_worklogs`/`jira_summarize`/`jira_comment`/`jira_current`/`jira_unbind`） | 工具完善 | 1 天 |

**里程碑**：P1+P2+P3 → G1（~2.5 天）；P1+P2+P4+P5 → G2+G3（~4.5 天）；+P6 → G6（~5.5 天）。

---

## 14. 风险与取舍

| 风险 | 缓解 |
|---|---|
| turn 墙钟包含「用户没在等」的时间 | `maxSecondsPerTurn` 截断、`minSeconds` 过滤、向上取整。**这是最大的近似**；本地可编辑，用户 review 时直接改 |
| 本地账本与 Jira 漂移 | 上传是显式动作；提供「从 Jira 重拉」手动同步；每行显示 synced/draft/failed 状态 |
| 本地账本无限增长 | 每行约 200 字节；一个 session 通常几十条。可加「按月归档」命令（后续） |
| `agent/pre-step` 注入增加 token 成本 | 每步约 100 token；仅绑定 session 生效 |
| advisory 不强制，agent 可能跑偏 | 默认 advisory 是用户的选择；设置里可切 narrow 硬拦；提示文案明确指出越界 |
| `dshSessionId` 不可变规则放宽引入误覆盖 | 改绑必须显式 `unbind`，UI 明示当前绑定对象 |
| 双写（本地 + Jira）不一致 | 本地先写，Jira 侧失败标 `failed` 可重试；Jira 是最终真相，本地是账本 |
| `/jira-bind` 与市场热挂载的交互 | 命令注册走 `ctx.commands`，与 bundle 层无关；热挂载时命令行注册在 `ctx.effect()` 内，随卸载清理 |

---

## 15. 仍需确认

1. **上传粒度**：一次上传全部 draft 行，还是让用户勾选？（当前设计：全部 + 逐条编辑）
2. **`summary/N.json` 的内容由谁产出**：agent 调 `jira_summarize`（准确但依赖 agent 自觉），
   还是宿主从工具调用自动总结（省事但质量差）？当前设计：主路径是 agent 主动调。
3. **是否需要 `/jira-worklog` 直接上传的命令**（不走 UI 面板）？当前设计提供
   `jira_upload_worklogs` 工具，但没做 `/jira-upload` 命令。

---

## 附录 A：与遗留数据的关系

```
~/.dsh/profiles/web/scjira/tasks/
├── .index.json                    ← v3 新增（派生索引）
├── DZ300-1234/
│   ├── meta.json                  ← schemaVersion 1，v3 忽略（不迁移）
│   ├── log.jsonl                  ← v2 遗留样例，v3 沿用其格式
│   └── summary/0.json             ← v2 遗留样例，v3 沿用其格式
└── DZ300-1744/
    └── meta.json                  ← schemaVersion 1，v3 忽略
```

**不迁移遗留数据** —— 它们是 mock 数据（内容是「重启后内核 panic」这类与真实 issue 无关的样例），
迁移反而会污染新账本。`log.jsonl` / `summary/` 的**格式**沿用，但**内容不继承**。

## 附录 B：实测证据

对生产 Jira 实例 `jiraprod.sercomm.com` 的临时探针，**全部已回滚**：

| 探针 | 结果 |
|---|---|
| `POST /worklog` 空 body | 400「必须标示工作耗费的时间」 |
| `POST /worklog {"timeSpentSeconds":1}` | 400 → **确认该字段不被接受** |
| `POST /worklog {"timeSpent":"1m"}` | **201**，`id:102783` |
| `POST /worklog {"timeSpent":"1m","adjustEstimate":"new"}` | 400 unrecognized field → **不做预估联动** |
| `POST /worklog {"timeSpent":"2m","started":"...+0800"}` | **201**，回填历史时间成功 |
| `PUT /worklog/{id}` 改 timeSpent + started | **200**，`30m→1h 30m`、`09:00→14:30` → **工时可编辑** |
| `PUT /issue/{key}/adjustment` | 404 → 端点不存在 |
| `DELETE /worklog/{id}` | 204 → 可回滚 |

最终校验：`DZ300-797` 的 worklog 总数 **0**，探针 comment 残留 **0**。

## 附录 C：v2 → v3 变更摘要

| 项 | v2 | v3 |
|---|---|---|
| 绑定是否约束 agent | 否 | **是**（advisory 注入 + 越界提示） |
| 工时写入 Jira | 不可能 | **仅手动触发上传** |
| 工时存储 | 无 | `worklog.jsonl`（本地，可编辑） |
| `log.jsonl` / `summary/` | 字段占位，从不写 | **真实启用** |
| `logCount`/`logBytes`/`summaryCount` | 永远 0 | **真实更新** |
| 1:1 | 允许一个 session 绑多个 | **双向互斥** |
| 解绑 | 无 | **`/jira-unbind`** |
| 工时修改 | 不可能 | **本地可编辑 + Jira PUT 同步** |
| 绑定入口 | 只有 UI 按钮 | **UI + `/jira-bind` 命令** |
| scope 模式 | — | advisory（默认）/ narrow |
