/**
 * sc-jira HOST apply. Registers:
 *   - The plugin's own settings form (credentials + the worklog policy),
 *     keyed by the profile entry id
 *   - 9 HTTP routes at /api/scjira/*: four reads (status, config, issue,
 *     list-worklog-week) and five worklog operations (state, edit, activity,
 *     upload, discard)
 *   - 9 tools: 3 reads and 6 worklog operations
 *   - 2 hooks: a one-line reminder before each step, the turn clock at the
 *     end of each turn
 *   - 3 human commands
 *
 * The worklog flow is bind → record → generate → upload (see
 * docs/design/v4-worklog-redesign.md). The host measures time; the agent says
 * what was done; the human decides what reaches Jira.
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
// These imports pull in each package's `declare module '@deepseek-ai/cordis'`
// augmentation so ctx.settings / ctx.tools / ctx.webServer become typed.
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import type { IncomingMessage, ServerResponse } from 'node:http'
import Schema from '@deepseek-ai/schemastery'
// A VALUE import, not a type-only one: `dsh-agent` carries the augmentation
// that declares `agent/pre-step` and `agent/turn-stopping` on the Events map.
import '@deepseek-ai/dsh-agent'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ScjiraSettings, WorklogPolicy } from './types.js'
import { DEFAULT_WORKLOG_POLICY } from './types.js'
import { JiraClient, formatDuration } from './jira-client.js'
import { handleIssue, handleListMyOpen, handleListWorklogWeek } from './handlers.js'
import {
  handleBind,
  handleDeleteActivity,
  handleDiscardWorklog,
  handleEditActivity,
  handleEditDraft,
  handleGenerateWorklog,
  handleRecordActivity,
  handleUnbind,
  handleUploadWorklog,
  handleWorklogState,
  type WorklogDeps,
} from './worklog-handlers.js'
import { readDocCached, updateDocAndInvalidate } from './session-store.js'
import { summarizeDoc } from './worklog.js'
import { localTimestamp } from './time-policy.js'
import { defineJiraTool } from './tool.js'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'sc-jira'

/**
 * The source of the message this plugin contributes to the model's context.
 *
 * The harness has no shared "plugin" source kind: the vocabulary is
 * merge-extensible, each producer declares its own. sc-jira contributes one
 * message — the bound-issue reminder — in `snapshot` form: a later snapshot
 * from this producer supersedes an earlier one, so a long conversation never
 * accumulates stale reminders.
 */
export interface ScjiraSource {
  readonly kind: 'sc-jira'
  readonly form: 'snapshot'
  readonly sections: readonly { readonly name: string; readonly text: string }[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'sc-jira': ScjiraSource
  }
}

/**
 * The plugin's configuration.
 *
 * The five credential fields are volatile: the Host holds their resolved
 * values live and the settings card writes through them without remounting the
 * plugin. `token` is secret, so it is redacted on the way to the client.
 *
 * `storeDir` and `worklog` are ordinary config: the policy is configuration,
 * not per-binding state (v3 stored it inside every binding and never offered a
 * way to change it).
 */
export const Config = Schema.object({
  server: Schema.string().default('https://jiraprod.sercomm.com').volatile(),
  login: Schema.string().default('A003688').volatile(),
  token: Schema.string().role('secret').volatile(),
  displayName: Schema.string().default('Ian Yin').volatile(),
  proxy: Schema.string().default('').volatile(),
  storeDir: Schema.string().default(
    join(homedir(), '.dsh', 'profiles', 'web', 'scjira', 'sessions'),
  ),
  worklog: Schema.object({
    minSeconds: Schema.number().default(DEFAULT_WORKLOG_POLICY.minSeconds),
    rounding: Schema.number().default(DEFAULT_WORKLOG_POLICY.rounding),
    maxSecondsPerActivity: Schema.number().default(DEFAULT_WORKLOG_POLICY.maxSecondsPerActivity),
  }).default(DEFAULT_WORKLOG_POLICY),
})

/**
 * The plugin's resolved configuration.
 *
 * A volatile field arrives as a live reference rather than as a value:
 * `get()` returns what the Host currently holds, so a settings write is
 * visible to the next read without a remount.
 */
export interface ScjiraConfig {
  server: Volatile<string>
  login: Volatile<string>
  token: Volatile<string | undefined>
  displayName: Volatile<string>
  proxy: Volatile<string>
  storeDir: string
  worklog: WorklogPolicy
}

export const inject = ['settings', 'webServer', 'tools'] as const

// Local shape we need beyond what the augmentation supplies (webServer is
// composed from cordis-web-server, whose types are not pulled into this
// package). All other services use the augmented Context type directly.
interface WebServerHost {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The loader entry that owns this plugin instance. */
interface LoaderEntry {
  options?: { id?: string }
}

/** Clamp a configured policy into something the arithmetic can trust. */
function policyOf(raw: Partial<WorklogPolicy> | undefined): WorklogPolicy {
  const minSeconds = Math.max(0, Math.round(raw?.minSeconds ?? DEFAULT_WORKLOG_POLICY.minSeconds))
  const rounding = Math.max(1, Math.round(raw?.rounding ?? DEFAULT_WORKLOG_POLICY.rounding))
  const maxSecondsPerActivity = Math.max(
    Math.max(minSeconds, rounding),
    Math.round(raw?.maxSecondsPerActivity ?? DEFAULT_WORKLOG_POLICY.maxSecondsPerActivity),
  )
  return { minSeconds, rounding, maxSecondsPerActivity }
}

export function apply(ctx: Context, config: ScjiraConfig): void {
  const settings: SettingsForms = ctx.settings
  const webServer = (ctx as unknown as { webServer: WebServerHost }).webServer
  const tools = (ctx as unknown as { tools: { register(def: unknown): () => void } }).tools

  // 1. The settings namespace — the profile entry id.
  const entryId = (ctx.fiber as unknown as { entry?: LoaderEntry }).entry?.options?.id

  /** The live Jira credentials. */
  const creds: ScjiraSettings = {
    get server() { return config.server.get() },
    get login() { return config.login.get() },
    get token() { return config.token.get() ?? '' },
    get displayName() { return config.displayName.get() },
    get proxy() { return config.proxy.get() },
  }

  const policy = policyOf(config.worklog)

  // 2. JiraClient singleton — rebuilt when creds change (token rotation).
  let client: JiraClient | null = null
  let clientFingerprint = ''
  function makeClient(): JiraClient {
    const fp = `${creds.server}|${creds.login}|${creds.token}|${creds.proxy}`
    if (!client || clientFingerprint !== fp) {
      client = new JiraClient(creds)
      clientFingerprint = fp
    }
    return client
  }

  function worklogDeps(): WorklogDeps {
    return { storeDir: config.storeDir, policy, jira: makeClient(), server: creds.server }
  }

  /** The session a tool call belongs to. `exec.agent.id` IS the SessionId. */
  function sessionOf(exec: { agent?: { id: string } }): string | null {
    const id = exec.agent?.id
    return typeof id === 'string' && id !== '' ? id : null
  }

  // The turn the agent is inside, per session: an activity is stamped with it
  // so a record can be traced back to the turn that produced it.
  const currentTurn = new Map<string, number>()
  const turnStarts = new Map<string, { turn: number; startedAt: number }>()

  // 3. HTTP routes
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/api/scjira',
    handler: async (req, res) => {
      const url = req.url ?? ''
      const method = req.method ?? 'GET'
      const pathname = new URL(url, 'http://x').pathname
      const m = url.match(/^\/api\/scjira\/([\w-]+)/)
      const route = m?.[1]
      const query = new URL(url, 'http://x').searchParams
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const readBody = async (): Promise<Record<string, unknown>> => {
        let raw = ''
        for await (const chunk of req) raw += chunk
        return raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>
      }

      // Status check works without full creds
      if (route === 'status' && method === 'GET') {
        json(200, {
          ok: true,
          configured: Boolean(creds.token),
          server: creds.server,
          login: creds.login,
          displayName: creds.displayName,
          proxy: creds.proxy,
        })
        return
      }

      // Settings write — accepts a partial update of the plugin's settings.
      if (route === 'config' && method === 'POST') {
        try {
          if (entryId === undefined) {
            json(500, { ok: false, error: 'this plugin instance has no profile entry, so its settings namespace is unknown' })
            return
          }
          const parsed = await readBody() as { server?: string; login?: string; displayName?: string; token?: string; proxy?: string }
          const ops: Array<{ op: 'set'; path: string[]; value: string }> = []
          if (parsed.server !== undefined) ops.push({ op: 'set', path: ['server'], value: parsed.server })
          if (parsed.login !== undefined) ops.push({ op: 'set', path: ['login'], value: parsed.login })
          if (parsed.displayName !== undefined) ops.push({ op: 'set', path: ['displayName'], value: parsed.displayName })
          if (parsed.proxy !== undefined) ops.push({ op: 'set', path: ['proxy'], value: parsed.proxy })
          if (parsed.token) ops.push({ op: 'set', path: ['token'], value: parsed.token })
          await settings.mutate(entryId, ops)
          // Read the committed values back rather than echoing what was asked
          // for: the Host owns the result.
          json(200, {
            ok: true,
            server: creds.server,
            login: creds.login,
            displayName: creds.displayName,
            proxy: creds.proxy,
          })
        } catch (err) {
          json(400, { ok: false, error: (err as Error).message })
        }
        return
      }

      // --- worklog routes. They read and write the local document only,
      // except upload, which is the one Jira write in this plugin.
      if (route === 'worklog') {
        try {
          if (method === 'GET' && pathname.endsWith('/worklog')) {
            const sessionId = query.get('sessionId') ?? ''
            if (sessionId === '') { json(400, { ok: false, error: 'sessionId is required' }); return }
            json(200, { ok: true, ...(await handleWorklogState({ storeDir: config.storeDir, policy, jira: makeClient(), server: creds.server }, { sessionId })) })
            return
          }
          if (method === 'POST' && pathname.endsWith('/worklog/edit')) {
            const body = await readBody()
            const sessionId = String(body.sessionId ?? '')
            if (sessionId === '') { json(400, { ok: false, error: 'sessionId is required' }); return }
            const r = await handleEditDraft({ storeDir: config.storeDir, policy, jira: makeClient(), server: creds.server }, {
              sessionId,
              id: String(body.id ?? ''),
              seconds: typeof body.seconds === 'number' ? body.seconds : undefined,
              comment: typeof body.comment === 'string' ? body.comment : undefined,
              startedAt: typeof body.startedAt === 'string' ? body.startedAt : undefined,
            })
            json(r.ok ? 200 : 400, r)
            return
          }
          if (method === 'POST' && pathname.endsWith('/worklog/activity')) {
            const body = await readBody()
            const sessionId = String(body.sessionId ?? '')
            if (sessionId === '') { json(400, { ok: false, error: 'sessionId is required' }); return }
            const depsForRoute = { storeDir: config.storeDir, policy, jira: makeClient(), server: creds.server }
            if (body.delete === true) {
              const r = await handleDeleteActivity(depsForRoute, { sessionId, id: String(body.id ?? '') })
              json(r.ok ? 200 : 400, r)
              return
            }
            const r = await handleEditActivity(depsForRoute, {
              sessionId,
              id: String(body.id ?? ''),
              summary: typeof body.summary === 'string' ? body.summary : undefined,
              seconds: typeof body.seconds === 'number' ? body.seconds : undefined,
              startedAt: typeof body.startedAt === 'string' ? body.startedAt : undefined,
            })
            json(r.ok ? 200 : 400, r)
            return
          }
          if (method === 'POST' && pathname.endsWith('/worklog/discard')) {
            const body = await readBody()
            const sessionId = String(body.sessionId ?? '')
            if (sessionId === '') { json(400, { ok: false, error: 'sessionId is required' }); return }
            const r = await handleDiscardWorklog({ storeDir: config.storeDir, policy, jira: makeClient(), server: creds.server }, { sessionId })
            json(r.ok ? 200 : 400, r)
            return
          }
          if (method === 'POST' && pathname.endsWith('/worklog/upload')) {
            const body = await readBody()
            const sessionId = String(body.sessionId ?? '')
            const ids = Array.isArray(body.ids) ? body.ids.map(String) : []
            if (sessionId === '') { json(400, { ok: false, error: 'sessionId is required' }); return }
            if (!creds.token) { json(503, { ok: false, error: '请先在 Settings 填 Jira credentials' }); return }
            const r = await handleUploadWorklog({ storeDir: config.storeDir, policy, jira: makeClient(), server: creds.server }, { sessionId, ids })
            json(r.ok ? 200 : 400, r)
            return
          }
          json(404, { ok: false, error: 'route not found' })
          return
        } catch (err) {
          json(500, { ok: false, error: (err as Error).message })
          return
        }
      }

      // All remaining routes read Jira and need a token.
      if (!creds.token) {
        json(503, { ok: false, error: '请先在 Settings 填 Jira credentials' })
        return
      }

      try {
        const jira = makeClient()
        if (route === 'list-worklog-week' && method === 'GET') {
          const r = await handleListWorklogWeek({ jira, creds }, { startDate: query.get('startDate') ?? undefined })
          json(r.ok ? 200 : 502, r)
          return
        }
        if (route === 'issue' && method === 'GET') {
          const r = await handleIssue({ jira, creds }, { key: (query.get('key') ?? '').trim() })
          json(r.ok ? 200 : 400, r)
          return
        }
        json(404, { ok: false, error: 'route not found' })
      } catch (err) {
        json(500, { ok: false, error: (err as Error).message })
      }
    },
  }))

  // 4. Read tools — what Jira already knows.
  ctx.effect(() => tools.register(defineJiraTool({
    name: 'jira_list_my_open',
    description: '列出分配给当前用户的未完成 Jira issues',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          issues: { type: 'array' },
          totalSpentSeconds: { type: 'number' },
          jql: { type: 'string' },
        },
        additionalProperties: true,
      } as any,
      render: (_args, value: any) => [
        { type: 'text', text: `Found ${value.issues?.length ?? 0} issues (total spent: ${value.totalSpentSeconds}s)` },
      ],
    },
    async execute() {
      if (!creds.token) throw new Error('请先在 Settings 填 Jira credentials')
      const r = await handleListMyOpen({ jira: makeClient(), creds })
      if (!r.ok) throw new Error(r.error)
      return { issues: r.issues, totalSpentSeconds: r.totalSpentSeconds, jql: r.jql }
    },
  })))

  ctx.effect(() => tools.register(defineJiraTool({
    name: 'jira_list_worklog_week',
    description: '列出当前用户在指定周（默认本周）的 worklog',
    parameters: {
      startDate: { type: 'string', description: 'ISO YYYY-MM-DD (optional, defaults to current week Monday)' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          weekStart: { type: 'string' },
          weekEnd: { type: 'string' },
          dayLabels: { type: 'array' },
          dailyTotals: { type: 'object', additionalProperties: true },
          grandTotalSeconds: { type: 'number' },
          jql: { type: 'string' },
        },
        additionalProperties: true,
      } as any,
      render: (_args, value: any) => [
        { type: 'text', text: `Week ${value.weekStart}..${value.weekEnd}: ${formatDuration(value.grandTotalSeconds ?? 0)} total` },
      ],
    },
    async execute(args) {
      if (!creds.token) throw new Error('请先在 Settings 填 Jira credentials')
      const r = await handleListWorklogWeek({ jira: makeClient(), creds }, { startDate: args.startDate })
      if (!r.ok) throw new Error(r.error ?? 'failed')
      return {
        weekStart: r.weekStart,
        weekEnd: r.weekEnd,
        dayLabels: r.dayLabels,
        dailyTotals: r.dailyTotals,
        grandTotalSeconds: r.grandTotalSeconds,
        jql: r.jql,
      }
    },
  })))

  ctx.effect(() => tools.register(defineJiraTool({
    name: 'jira_issue',
    description: '读取一个 Jira issue 的详情（描述全文 + 评论列表）',
    parameters: {
      key: { type: 'string', required: true, description: 'issue key，如 DZ300-1826' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          key: { type: 'string' },
          summary: { type: 'string' },
          statusName: { type: 'string' },
          priority: { type: 'string' },
          assignee: { type: 'string' },
          url: { type: 'string' },
          description: { type: 'string' },
          comments: { type: 'array' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      } as any,
      render: (_args, value: any) => [
        {
          type: 'text',
          text: value.ok === false
            ? `Jira issue failed: ${value.error}`
            : `${value.key} — ${value.summary} (${value.comments?.length ?? 0} comments)`,
        },
      ],
    },
    async execute(args) {
      if (!creds.token) throw new Error('请先在 Settings 填 Jira credentials')
      const r = await handleIssue({ jira: makeClient(), creds }, { key: (args.key ?? '').trim() })
      if (!r.ok) return { ok: false, error: r.error }
      return {
        ok: true,
        key: r.issue.key,
        summary: r.issue.summary,
        statusName: r.issue.statusName,
        priority: r.issue.priority,
        assignee: r.issue.assignee,
        url: r.issue.url,
        description: r.issue.description,
        comments: r.issue.comments,
      }
    },
  })))

  // 5. Worklog tools — bind → record → generate → upload.
  ctx.effect(() => tools.register(defineJiraTool({
    name: 'jira_bind',
    description: '把本 session 绑定到一个 Jira issue（一个 session 只绑一个）',
    parameters: {
      taskKey: { type: 'string', required: true, description: 'e.g. DZ300-1826' },
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, key: { type: 'string' }, summary: { type: 'string' }, error: { type: 'string' } },
        additionalProperties: true,
      } as any,
      render: (_args, value: any) => [
        { type: 'text', text: value.ok ? `Bound to ${value.key}` : `Bind failed: ${value.error}` },
      ],
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      if (sessionId === null) return { ok: false, error: '无法确定本 session' }
      const r = await handleBind(worklogDeps(), { sessionId, taskKey: args.taskKey })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, key: r.key, summary: r.summary }
    },
  })))

  ctx.effect(() => tools.register(defineJiraTool({
    name: 'jira_unbind',
    description: '解除本 session 的绑定（记录需要先上传完）',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, key: { type: 'string' }, error: { type: 'string' } },
        additionalProperties: true,
      } as any,
      render: (_args, value: any) => [
        { type: 'text', text: value.ok ? `Unbound from ${value.key}` : `Unbind failed: ${value.error}` },
      ],
    },
    async execute(_args, exec) {
      const sessionId = sessionOf(exec)
      if (sessionId === null) return { ok: false, error: '无法确定本 session' }
      const r = await handleUnbind(worklogDeps(), { sessionId })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, key: r.key }
    },
  })))

  ctx.effect(() => tools.register(defineJiraTool({
    name: 'jira_record_activity',
    description:
      '记录一段工作：一句话说明做了什么，以及花了多久。seconds 可省略——省略时按距上次记录的时间自动测量' +
      `（下限 ${formatDuration(policy.minSeconds)}，单条封顶 ${formatDuration(policy.maxSecondsPerActivity)}）。`,
    parameters: {
      summary: { type: 'string', required: true, description: '一句话说明这段工作做了什么' },
      seconds: { type: 'number', description: '这段工作的秒数；省略则按墙钟自动测量' },
      startedAt: { type: 'string', description: '起始时间（带偏移的 ISO，如 2026-11-04T09:00:00.000+0800）；省略则按 seconds 回推' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          summary: { type: 'string' },
          seconds: { type: 'number' },
          duration: { type: 'string' },
          source: { type: 'string' },
          activityCount: { type: 'number' },
          recordedSeconds: { type: 'number' },
          recordedDuration: { type: 'string' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      } as any,
      render: (_args, value: any) => [
        {
          type: 'text',
          text: value.ok === false
            ? `Record failed: ${value.error}`
            : `Recorded ${value.duration} (${value.id}) — total ${value.recordedDuration} / ${value.activityCount} records`,
        },
      ],
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      if (sessionId === null) return { ok: false, error: '无法确定本 session' }
      const r = await handleRecordActivity(worklogDeps(), {
        sessionId,
        summary: args.summary,
        seconds: args.seconds,
        startedAt: args.startedAt,
        turn: currentTurn.get(sessionId) ?? null,
      })
      if (!r.ok) return { ok: false, error: r.error }
      return {
        ok: true,
        id: r.activity.id,
        summary: r.activity.summary,
        seconds: r.activity.seconds,
        duration: formatDuration(r.activity.seconds),
        source: r.activity.source,
        activityCount: r.totals.activityCount,
        recordedSeconds: r.totals.recordedSeconds,
        recordedDuration: formatDuration(r.totals.recordedSeconds),
      }
    },
  })))

  ctx.effect(() => tools.register(defineJiraTool({
    name: 'jira_worklog_state',
    description: '读取本 session 的 worklog 状态：绑定、已记录活动、测量合计、缺口、草稿与待传条目',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          bound: { type: 'boolean' },
          key: { type: 'string' },
          summary: { type: 'string' },
          activityCount: { type: 'number' },
          recordedSeconds: { type: 'number' },
          measuredSeconds: { type: 'number' },
          gapSeconds: { type: 'number' },
          uncoveredCount: { type: 'number' },
          draftCount: { type: 'number' },
          pendingCount: { type: 'number' },
          syncedCount: { type: 'number' },
          failedCount: { type: 'number' },
          settled: { type: 'boolean' },
          activities: { type: 'array' },
          draft: { type: 'array' },
          uncoveredIds: { type: 'array' },
          generatedAt: { type: 'string' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      } as any,
      render: (_args, value: any) => [
        {
          type: 'text',
          text: value.bound !== true
            ? 'This session is not bound to a Jira issue'
            : `${value.key} — recorded ${formatDuration(value.recordedSeconds)} / ${value.activityCount} records; ` +
              `measured ${formatDuration(value.measuredSeconds)}; gap ${formatDuration(Math.abs(value.gapSeconds))}; ` +
              `pending upload ${value.pendingCount}`,
        },
      ],
    },
    async execute(_args, exec) {
      const sessionId = sessionOf(exec)
      if (sessionId === null) return { ok: false, error: '无法确定本 session' }
      const state = await handleWorklogState(worklogDeps(), { sessionId })
      return { ok: true, ...state }
    },
  })))

  ctx.effect(() => tools.register(defineJiraTool({
    name: 'jira_generate_worklog',
    description:
      '把已记录且还没上传的活动汇总成 worklog 草稿。不传 entries 时按活动逐条生成（确定性）；' +
      '传 entries 时按给定的合并/改写生成，但每条未上传的活动必须且只能被覆盖一次，' +
      '合计与记录的差额会在 deltaSeconds 里返回。',
    parameters: {
      entries: {
        type: 'array',
        description: '可选的条目提议：[{ seconds, comment, startedAt?, activityIds? }]；省略则逐条生成',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          added: { type: 'number' },
          covered: { type: 'number' },
          recordedSeconds: { type: 'number' },
          proposedSeconds: { type: 'number' },
          deltaSeconds: { type: 'number' },
          draft: { type: 'array' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      } as any,
      render: (_args, value: any) => [
        {
          type: 'text',
          text: value.ok === false
            ? `Generate failed: ${value.error}`
            : `Draft has ${value.draft?.length ?? 0} entries — ${formatDuration(value.proposedSeconds)} vs recorded ${formatDuration(value.recordedSeconds)}` +
              (value.deltaSeconds === 0 ? '' : ` (delta ${formatDuration(Math.abs(value.deltaSeconds))})`),
        },
      ],
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      if (sessionId === null) return { ok: false, error: '无法确定本 session' }
      const raw = args.entries
      const proposal = Array.isArray(raw)
        ? raw.map((entry: any) => ({
            seconds: Number(entry?.seconds),
            comment: String(entry?.comment ?? ''),
            startedAt: typeof entry?.startedAt === 'string' ? entry.startedAt : undefined,
            activityIds: Array.isArray(entry?.activityIds) ? entry.activityIds.map(String) : undefined,
          }))
        : null
      const r = await handleGenerateWorklog(worklogDeps(), { sessionId, entries: proposal })
      if (!r.ok) return { ok: false, error: r.error }
      return {
        ok: true,
        added: r.added,
        covered: r.covered,
        recordedSeconds: r.recordedSeconds,
        proposedSeconds: r.proposedSeconds,
        deltaSeconds: r.deltaSeconds,
        draft: r.draft,
      }
    },
  })))

  ctx.effect(() => tools.register(defineJiraTool({
    name: 'jira_upload_worklog',
    description:
      '把指定的草稿条目上传到 Jira（ids 必填；空数组不上传任何东西，只返回当前待传清单）。' +
      '上传是显式动作：由人决定传哪几条。',
    parameters: {
      ids: { type: 'array', required: true, description: '要上传的条目 id，如 ["wl-01"]；空数组 = 只查待传' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          uploaded: { type: 'array' },
          pending: { type: 'array' },
          syncedCount: { type: 'number' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      } as any,
      render: (_args, value: any) => [
        {
          type: 'text',
          text: value.ok === false
            ? `Upload failed: ${value.error}`
            : `Uploaded ${(value.uploaded ?? []).filter((item: any) => item.ok).length}/${(value.uploaded ?? []).length} — now synced ${value.syncedCount}`,
        },
      ],
    },
    async execute(args, exec) {
      if (!creds.token) throw new Error('请先在 Settings 填 Jira credentials')
      const sessionId = sessionOf(exec)
      if (sessionId === null) return { ok: false, error: '无法确定本 session' }
      const r = await handleUploadWorklog(worklogDeps(), { sessionId, ids: Array.isArray(args.ids) ? args.ids.map(String) : [] })
      if (!r.ok) return { ok: false, error: r.error }
      return {
        ok: true,
        uploaded: r.uploaded,
        pending: r.pending.map(entry => entry.id),
        syncedCount: r.state.syncedCount,
      }
    },
  })))

  // 6. Hooks: measure the turn, and remind the agent what is recorded.
  //
  // The reminder is one line: the binding, what is recorded, and what still
  // has to happen. It is injected in `snapshot` form, so it never accumulates.
  ctx.on('agent/pre-step', async (payload: { agent: { id: string }; turn: number }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
    // Open the turn BEFORE delegating: a rejected step still consumed time.
    const existing = turnStarts.get(payload.agent.id)
    if (existing === undefined || existing.turn !== payload.turn) {
      turnStarts.set(payload.agent.id, { turn: payload.turn, startedAt: Date.now() })
    }
    currentTurn.set(payload.agent.id, payload.turn)

    const decision = await next()
    if (decision.kind !== 'enter') return decision

    let doc
    try {
      doc = await readDocCached(config.storeDir, payload.agent.id)
    } catch {
      // An unreadable document must not stop the agent; the tools will report it.
      return decision
    }
    if (doc.binding === null) return decision

    const state = summarizeDoc(doc)
    const bits = [
      `[Jira] 本 session 绑定 ${doc.binding.key}`,
      `已记录 ${formatDuration(state.recordedSeconds)} / ${state.activityCount} 条`,
    ]
    if (state.activityCount === 0) bits.push('还没有记录工作：做完一段后调 jira_record_activity 记一条')
    else if (state.unrecordedCount > 0) bits.push(`未生成草稿 ${state.unrecordedCount} 条`)
    if (state.pendingCount > 0) bits.push(`未上传 ${state.pendingCount} 条`)
    const text = bits.join('；')

    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'sc-jira', form: 'snapshot', sections: [{ name: 'scjira', text }] },
        }),
      ],
    }
  })

  ctx.on('agent/turn-stopping', async (payload: { agent: { id: string }; turn: number }) => {
    const open = turnStarts.get(payload.agent.id)
    currentTurn.delete(payload.agent.id)
    if (open === undefined || open.turn !== payload.turn) return
    turnStarts.delete(payload.agent.id)
    const endedAt = Date.now()
    const seconds = Math.max(0, Math.round((endedAt - open.startedAt) / 1000))
    try {
      await updateDocAndInvalidate(config.storeDir, payload.agent.id, current => {
        if (current.binding === null) return { next: null, result: null }
        if (current.turns.some(turn => turn.turn === payload.turn)) return { next: null, result: null }
        return {
          next: {
            ...current,
            turns: [
              ...current.turns,
              {
                turn: payload.turn,
                startedAt: localTimestamp(open.startedAt),
                endedAt: localTimestamp(endedAt),
                seconds,
              },
            ],
          },
          result: null,
        }
      })
    } catch {
      // Measurement must never disturb the agent.
    }
  })

  // 7. Commands — the human entry points. They do not generate or upload:
  // those steps go through the agent or the panel.
  interface CommandOutcome { kind: 'success' | 'error'; text?: string }
  interface CommandDefinition {
    name: string
    description: string
    input?: { hint: string }
    handler: (invocation: { agent: { id: string }; rawInput: string }) => CommandOutcome | Promise<CommandOutcome>
  }
  const commands = ctx.get('commands') as { register(definition: CommandDefinition): () => void } | undefined

  if (commands !== undefined) {
    ctx.effect(() => commands.register({
      name: 'jira-bind',
      description: '把当前 session 绑定到一个 Jira issue',
      input: { hint: '<issue-key>' },
      handler: async (invocation): Promise<CommandOutcome> => {
        const key = invocation.rawInput.trim()
        if (key === '') {
          const state = await handleWorklogState(worklogDeps(), { sessionId: invocation.agent.id })
          return {
            kind: 'success',
            text: state.bound
              ? `本 session 已绑定 ${state.key} — ${state.summary}（已记录 ${formatDuration(state.recordedSeconds)} / ${state.activityCount} 条）`
              : '请指定 Jira issue key（如 /jira-bind DZ300-1826）',
          }
        }
        const r = await handleBind(worklogDeps(), { sessionId: invocation.agent.id, taskKey: key })
        return r.ok
          ? { kind: 'success', text: `已绑定到 ${r.key} — ${r.summary}` }
          : { kind: 'error', text: r.error }
      },
    }))

    ctx.effect(() => commands.register({
      name: 'jira-unbind',
      description: '解除当前 session 的 Jira 绑定（记录需先上传完）',
      handler: async (invocation): Promise<CommandOutcome> => {
        const r = await handleUnbind(worklogDeps(), { sessionId: invocation.agent.id })
        return r.ok
          ? { kind: 'success', text: `已解绑 ${r.key}` }
          : { kind: 'error', text: r.error }
      },
    }))

    ctx.effect(() => commands.register({
      name: 'jira-worklog',
      description: '查看当前 session 的 worklog 状态（记录、缺口、草稿、待传）',
      handler: async (invocation): Promise<CommandOutcome> => {
        const state = await handleWorklogState(worklogDeps(), { sessionId: invocation.agent.id })
        if (!state.bound) return { kind: 'error', text: '本 session 未绑定 Jira issue' }
        const lines = [
          `${state.key} — 已记录 ${formatDuration(state.recordedSeconds)} / ${state.activityCount} 条`,
          `宿主测量 ${formatDuration(state.measuredSeconds)}，缺口 ${formatDuration(Math.abs(state.gapSeconds))}`,
          state.draftCount === 0
            ? '还没有生成草稿——记录完成后在对话里让我生成 worklog'
            : `草稿 ${state.draftCount} 条（待传 ${state.pendingCount}、已同步 ${state.syncedCount}）`,
        ]
        for (const activity of state.activities.slice(-5)) {
          lines.push(`  ${activity.startedAt}  ${formatDuration(activity.seconds)}  ${activity.summary}`)
        }
        return { kind: 'success', text: lines.join('\n') }
      },
    }))
  }
}
