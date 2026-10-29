/**
 * sc-jira HOST apply. Registers:
 *   - Settings namespace 'scjira' (server/login/token/displayName; token is secret)
 *   - 5 HTTP routes at /api/scjira/*
 *   - 4 defineTool mirror (jira_list_my_open, jira_list_worklog_week, jira_get_binding, jira_bind)
 *
 * All registrations wrap ctx.effect for automatic dispose.
 * Credentials are cached in a closure (settings.get() is sync but routes are
 * also sync return points — we must not await settings on every request).
 */
import type { Context } from '@deepseek-ai/cordis'
// These imports pull in each package's `declare module '@deepseek-ai/cordis'`
// augmentation so ctx.settings / ctx.tools / ctx.webServer become typed.
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
// A VALUE import, not a type-only one: `dsh-agent` carries the `declare
// module '@deepseek-ai/cordis'` augmentation that declares `agent/pre-step`
// on the Events map, and a type-only import is elided — the augmentation
// would never load and `ctx.on('agent/pre-step', …)` would not typecheck.
import '@deepseek-ai/dsh-agent'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { IncomingMessage, ServerResponse } from 'node:http'
import Schema from '@deepseek-ai/schemastery'
import type { ScjiraSettings } from './types.js'
import { DEFAULT_SCOPE_MODE } from './types.js'
import { JiraClient, formatDuration } from './jira-client.js'
import {
  handleListMyOpen,
  handleListWorklogWeek,
  handleBind,
  handleGetBinding,
  handleIssue,
  handleAddComment,
  handleUnbind,
} from './handlers.js'
import { readBindingDetailBySession } from './storage.js'
import {
  isJiraTool,
  isOutOfScope,
  renderScopeContext,
  renderScopeNotice,
  renderScopeRefusal,
  resolveScopeMode,
} from './scope.js'
import { TurnTimer, autoComment, localTimestamp, secondsToRecord } from './turn-timer.js'
import { appendWorklog, readLedger, summarizeLedger } from './worklog-ledger.js'
import {
  handleEditWorklog,
  handleListWorklogs,
  handleRepullWorklogs,
  handleUploadWorklogs,
} from './worklog-handlers.js'
import { appendSessionLog, describeToolCall, writeSummary } from './session-log.js'
import type { AutoWorklogConfig } from './types.js'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'sc-jira'

export const Config = Schema.object({
  tasksDir: Schema.string().default(
    join(homedir(), '.dsh', 'profiles', 'web', 'scjira', 'tasks'),
  ),
})

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

// Minimal settings scope we use
interface ScjiraSettingsScope<T> {
  get(): T
  watch(cb: (next: T) => void): () => void
}

/** A binding as the hooks need it: the issue, its facts, and its policy. */
interface CachedBinding {
  key: string
  summary: string
  issueSummary: Record<string, string>
  autoWorklog: AutoWorklogConfig
  /** When the binding started, in epoch milliseconds. */
  startedAtMs: number
}

export function apply(ctx: Context, config: { tasksDir: string }): void {
  // After the imports above, ctx.settings is typed as SettingsProvider (from
  // dsh-settings' module augmentation). We still need a local webServer view
  // because cordis-web-server's .d.ts is not a peer dep of this plugin.
  const settings = (ctx as Context & { settings: SettingsProvider }).settings
  const webServer = (ctx as unknown as { webServer: WebServerHost }).webServer
  const tools = (ctx as unknown as { tools: { register(def: unknown): () => void } }).tools

  // 1. Settings namespace
  const settingsSchema = Schema.object({
    server:      Schema.string().default('https://jiraprod.sercomm.com'),
    login:       Schema.string().default('A003688'),
    token:       Schema.string().role('secret').default(''),
    displayName: Schema.string().default('Ian Yin'),
    proxy:       Schema.string().default(''),
    scopeMode:   Schema.string().default(DEFAULT_SCOPE_MODE),
  })

  let creds: ScjiraSettings
  // Kept so the /config route can read the *committed* value back after a
  // write. `scope.watch` fires asynchronously, so the `creds` closure
  // variable may still hold the previous value at the moment we answer.
  let scope: ScjiraSettingsScope<ScjiraSettings>
  ctx.effect(() => {
    scope = settings.register('scjira' as never, settingsSchema) as ScjiraSettingsScope<ScjiraSettings>
    creds = scope.get()
    return scope.watch(next => {
      creds = next
      // Token/credential change: force rebuild on next makeClient()
      client = null
      clientFingerprint = ''
    })
  })

  // 2. JiraClient singleton — survives across HTTP requests. Rebuilt when
  // creds change (token rotation). No in-memory cache: every call hits Jira
  // so the panel always reflects current state.
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

  /**
   * The session a call belongs to.
   *
   * The explicit argument wins; otherwise the caller's own session is used.
   * A call with neither has no session, and every session-scoped tool says
   * so rather than guessing.
   */
  function sessionOf(
    args: unknown,
    exec: { agent?: { id: string } },
  ): string | null {
    if (typeof args === 'object' && args !== null) {
      const explicit = (args as { sessionId?: unknown }).sessionId
      if (typeof explicit === 'string' && explicit.trim() !== '') {
        return explicit.trim()
      }
    }
    const id = exec.agent?.id
    return typeof id === 'string' && id !== '' ? id : null
  }

  // 3. HTTP routes
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/api/scjira',
    handler: async (req, res) => {
      const url = req.url ?? ''
      const method = req.method ?? 'GET'
      const m = url.match(/^\/api\/scjira\/([\w-]+)/)
      const route = m?.[1]

      // Status check works without full creds
      if (route === 'status' && method === 'GET') {
        const configured = Boolean(creds.token)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          ok: true,
          configured,
          server: creds.server,
          login: creds.login,
          displayName: creds.displayName,
          proxy: creds.proxy,
        }))
        return
      }

      // Settings write — accepts partial update of scjira namespace
      if (route === 'config' && method === 'POST') {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body) as { server?: string; login?: string; displayName?: string; token?: string; proxy?: string }
            const ops: Array<{ op: 'set'; path: string[]; value: string }> = []
            if (parsed.server !== undefined) ops.push({ op: 'set', path: ['server'], value: parsed.server })
            if (parsed.login !== undefined) ops.push({ op: 'set', path: ['login'], value: parsed.login })
            if (parsed.displayName !== undefined) ops.push({ op: 'set', path: ['displayName'], value: parsed.displayName })
            if (parsed.proxy !== undefined) ops.push({ op: 'set', path: ['proxy'], value: parsed.proxy })
            // Only write token if user supplied one (preserves existing on empty)
            if (parsed.token) ops.push({ op: 'set', path: ['token'], value: parsed.token })
            await settings.mutate('scjira' as never, ops)
            // Read the committed value back from the scope rather than the
            // `creds` closure: `scope.watch` runs asynchronously, so `creds`
            // can still hold the pre-write value at this point and the client
            // would render stale values after a successful save.
            const saved = scope.get()
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({
              ok: true,
              server: saved.server,
              login: saved.login,
              displayName: saved.displayName,
              proxy: saved.proxy,
            }))
          } catch (err) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: (err as Error).message }))
          }
        })
        return
      }

      // All other routes require token
      if (!creds.token) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: '请先在 Settings 填 Jira credentials' }))
        return
      }

      try {
        const jira = makeClient()
        if (route === 'list-my-open' && method === 'GET') {
          const r = await handleListMyOpen({ jira, creds })
          res.writeHead(r.ok ? 200 : 502, { 'content-type': 'application/json' })
          res.end(JSON.stringify(r))
          return
        }
        // The command picker's route. Same data as list-my-open under the
        // name the picker uses — one endpoint, two callers.
        if (route === 'open-issues' && method === 'GET') {
          const r = await handleListMyOpen({ jira, creds })
          res.writeHead(r.ok ? 200 : 502, { 'content-type': 'application/json' })
          res.end(JSON.stringify(r))
          return
        }
        if (route === 'list-worklog-week' && method === 'GET') {
          const u = new URL(url, 'http://x')
          const r = await handleListWorklogWeek({ jira, creds }, { startDate: u.searchParams.get('startDate') ?? undefined })
          res.writeHead(r.ok ? 200 : 502, { 'content-type': 'application/json' })
          res.end(JSON.stringify(r))
          return
        }
        if (route === 'get-binding' && method === 'GET') {
          const u = new URL(url, 'http://x')
          const sid = u.searchParams.get('sessionId') ?? ''
          const r = await handleGetBinding({ tasksDir: config.tasksDir }, { sessionId: sid })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, ...r }))
          return
        }
        if (route === 'bind' && method === 'POST') {
          let body = ''
          req.on('data', c => { body += c })
          req.on('end', async () => {
            try {
              const parsed = JSON.parse(body) as { sessionId: string; taskKey: string }
              const r = await handleBind({ jira, creds, tasksDir: config.tasksDir }, parsed)
              // The binding just changed on disk; the cached view of it is stale.
              bindingCache.clear()
              res.writeHead(r.ok ? 200 : 400, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ...r, ok: r.ok }))
            } catch (err) {
              res.writeHead(400, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: (err as Error).message }))
            }
          })
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'route not found' }))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }))
      }
    },
  }))

  // 3b. Worklog ledger routes.
  //
  // The ledger lives on disk; these routes read it, edit it, and — when the
  // user asks — send the SELECTED entries to Jira. Nothing here uploads
  // without being told to: the upload is the review's outcome, not the
  // recorder's decision.
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/api/scjira/worklog',
    handler: async (req, res) => {
      const url = req.url ?? ''
      const method = req.method ?? 'GET'
      const u = new URL(url, 'http://x')
      const key = u.searchParams.get('key') ?? ''
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const deps = { jira: makeClient(), creds, tasksDir: config.tasksDir }

      if (method === 'GET' && u.pathname.endsWith('/worklog')) {
        const r = await handleListWorklogs(deps, { key })
        json(r.ok ? 200 : 400, r)
        return
      }

      if (method === 'POST' && u.pathname.endsWith('/worklog/edit')) {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body) as {
              key?: string; id?: string; seconds?: number; comment?: string; startedAt?: string
            }
            const r = await handleEditWorklog(deps, {
              key: parsed.key ?? key,
              id: parsed.id ?? '',
              edit: {
                seconds: parsed.seconds,
                comment: parsed.comment,
                startedAt: parsed.startedAt,
              },
            })
            json(r.ok ? 200 : 400, r)
          } catch (err) {
            json(400, { ok: false, error: (err as Error).message })
          }
        })
        return
      }

      if (method === 'POST' && u.pathname.endsWith('/worklog/upload')) {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body) as { key?: string; ids?: string[] }
            const r = await handleUploadWorklogs(deps, {
              key: parsed.key ?? key,
              ids: parsed.ids ?? [],
            })
            json(r.ok ? 200 : 400, r)
          } catch (err) {
            json(400, { ok: false, error: (err as Error).message })
          }
        })
        return
      }

      if (method === 'POST' && u.pathname.endsWith('/worklog/repull')) {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body) as { key?: string }
            const r = await handleRepullWorklogs(deps, { key: parsed.key ?? key })
            json(r.ok ? 200 : 400, r)
          } catch (err) {
            json(400, { ok: false, error: (err as Error).message })
          }
        })
        return
      }

      json(404, { ok: false, error: 'route not found' })
    },
  }))

  // 4. Tools (mirror of the 4 handlers, callable from agent)
  ctx.effect(() => tools.register(defineTool({
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
    async execute(_args, _exec) {
      if (!creds.token) throw new Error('请先在 Settings 填 Jira credentials')
      const r = await handleListMyOpen({ jira: makeClient(), creds })
      if (!r.ok) throw new Error(r.error)
      return { issues: r.issues, totalSpentSeconds: r.totalSpentSeconds, jql: r.jql }
    },
  })))

  ctx.effect(() => tools.register(defineTool({
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
        { type: 'text', text: `Week ${value.weekStart}..${value.weekEnd}: ${value.grandTotalSeconds}s total` },
      ],
    },
    async execute(args, _exec) {
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

  ctx.effect(() => tools.register(defineTool({
    name: 'jira_get_binding',
    description: '查询指定 DSH session 是否已绑定到 Jira issue',
    parameters: {
      sessionId: { type: 'string', description: '目标 session；缺省为调用方所在的 session' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          bound: { type: 'boolean' },
          key: { type: 'string' },
          summary: { type: 'string' },
          sessionId: { type: 'string' },
        },
        additionalProperties: true,
      } as any,
      render: (_args, value: any) => [
        { type: 'text', text: value.bound ? `Bound to ${value.key}: ${value.summary}` : 'Not bound' },
      ],
    },
    async execute(args, exec) {
      const sessionId = sessionOf(args, exec)
      if (sessionId === null) {
        return { bound: false, sessionId: '' }
      }
      const r = await handleGetBinding({ tasksDir: config.tasksDir }, { sessionId })
      return { bound: r.bound, key: r.key, summary: r.summary, sessionId: r.sessionId }
    },
  })))

  ctx.effect(() => tools.register(defineTool({
    name: 'jira_bind',
    description: '将当前 DSH session 绑定到一个 Jira issue key',
    parameters: {
      sessionId: { type: 'string', description: '目标 session；缺省为调用方所在的 session' },
      taskKey:   { type: 'string', required: true, description: 'e.g. DZ300-1826' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          key: { type: 'string' },
          sessionId: { type: 'string' },
          summary: { type: 'string' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      } as any,
      render: (_args, value: any) => [
        { type: 'text', text: value.ok ? `Bound to ${value.key}` : `Bind failed: ${value.error}` },
      ],
    },
    async execute(args, exec) {
      if (!creds.token) throw new Error('请先在 Settings 填 Jira credentials')
      const sessionId = sessionOf(args, exec)
      if (sessionId === null) {
        return { ok: false, error: '无法确定本 session' }
      }
      const r = await handleBind(
        { jira: makeClient(), creds, tasksDir: config.tasksDir },
        { sessionId, taskKey: args.taskKey },
      )
      // The binding just changed on disk; the cached view of it is stale.
      bindingCache.clear()
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, key: r.key, sessionId: r.sessionId, summary: r.summary }
    },
  })))

  // jira_summarize — the agent writes its own account of a turn.
  //
  // The host can see which tools ran; it cannot know what the agent was
  // trying to do or whether it got there. A host-written summary would be a
  // list of tool names. The agent's own summary is what the work actually
  // was, so the agent writes it — and a turn it did not summarize simply has
  // no summary file, which is more honest than a hollow one.
  ctx.effect(() => tools.register(defineTool({
    name: 'jira_summarize',
    description: '记录本轮工作的摘要（写入本 session 绑定 issue 的 summary/N.json）',
    parameters: {
      sessionId: { type: 'string', description: '目标 session；缺省为调用方所在的 session' },
      turn:      { type: 'number', required: true, description: '本轮 turn 序号' },
      text:      { type: 'string', required: true, description: '本轮做了什么、结论是什么' },
      highlights: { type: 'array', description: '本轮的关键进展（可选）' },
      blockers:  { type: 'array', description: '本轮遇到的阻碍（可选）' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          key: { type: 'string' },
          turnSeq: { type: 'number' },
          path: { type: 'string' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      } as any,
      render: (_args, value: any) => [
        { type: 'text', text: value.ok ? `Summary written for turn ${value.turnSeq} (${value.key})` : `Summarize failed: ${value.error}` },
      ],
    },
    async execute(args, exec) {
      const sessionId = sessionOf(args, exec)
      if (sessionId === null) {
        return { ok: false, error: '无法确定本 session' }
      }
      const binding = await bindingFor(sessionId)
      if (binding === null) {
        return { ok: false, error: '本 session 未绑定 Jira issue，无法写入摘要' }
      }
      const written = await writeSummary(config.tasksDir, binding.key, {
        turnSeq: args.turn,
        writtenAt: new Date().toISOString(),
        body: {
          text: args.text,
          highlights: Array.isArray(args.highlights) ? args.highlights.map(String) : [],
          blockers: Array.isArray(args.blockers) ? args.blockers.map(String) : [],
        },
      })
      return {
        ok: true,
        key: binding.key,
        turnSeq: written.turnSeq,
        path: `${config.tasksDir}/${binding.key}/summary/${written.turnSeq}.json`,
      }
    },
  })))

  // 4b. The tools the agent needs to work ON a ticket.
  //
  // The v2 tools could list and query. They could not read a ticket, record
  // time against it, comment on it, or see what the session was already
  // bound to. These close that gap.
  //
  // Every one of them resolves its session from the execution itself —
  // `exec.agent.id` IS the session id — so the model never has to know or
  // pass its own session id. An explicit `sessionId` argument still wins for
  // the rare caller that means a different session.
  //
  // The worklog tools write LOCALLY only. `jira_upload_worklogs` is the one
  // exception, and it is the exception by design: it exists so a person can
  // ask the agent to push an entry they have already reviewed. Nothing here
  // uploads on its own.

  /**
   * When each issue's ledger last recorded an entry.
   *
   * `jira_log_worklog` without an explicit duration measures the wall clock
   * since the last record — the time since the work actually started, not
   * since the process did. The automatic turn recorder feeds this map too,
   * so the two paths measure from the same point.
   */
  const lastRecordedAt = new Map<string, number>()

  ctx.effect(() => tools.register(defineTool({
    name: 'jira_issue',
    description: '读取一个 Jira issue 的详情（描述全文 + 评论列表）',
    parameters: {
      key: { type: 'string', description: 'issue key，如 DZ300-1826；缺省为当前 session 绑定的 issue' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          key: { type: 'string' },
          summary: { type: 'string' },
          description: { type: 'string' },
          statusName: { type: 'string' },
          priority: { type: 'string' },
          assignee: { type: 'string' },
          url: { type: 'string' },
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
    async execute(args, exec) {
      const sessionId = sessionOf(args, exec)
      const binding = sessionId === null ? null : await bindingFor(sessionId)
      const key = (args.key ?? '').trim() || binding?.key || ''
      if (key === '') {
        return { ok: false, error: '未指定 issue key，且本 session 未绑定 Jira issue' }
      }
      if (!creds.token) throw new Error('请先在 Settings 填 Jira credentials')
      const r = await handleIssue({ jira: makeClient(), creds }, { key })
      if (!r.ok) return { ok: false, error: r.error }
      return {
        ok: true,
        key: r.issue.key,
        summary: r.issue.summary,
        description: r.issue.description,
        statusName: r.issue.statusName,
        priority: r.issue.priority,
        assignee: r.issue.assignee,
        url: r.issue.url,
        comments: r.issue.comments,
      }
    },
  })))

  ctx.effect(() => tools.register(defineTool({
    name: 'jira_log_worklog',
    description: '在本地工时账本记一条工时（只写本地，不上传 Jira）',
    parameters: {
      key: { type: 'string', description: 'issue key；缺省为当前 session 绑定的 issue' },
      seconds: { type: 'number', description: '工时秒数；缺省为自上次记录以来的墙钟时长' },
      comment: { type: 'string', description: '工时说明' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          key: { type: 'string' },
          seconds: { type: 'number' },
          duration: { type: 'string' },
          comment: { type: 'string' },
          startedAt: { type: 'string' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      } as any,
      render: (_args, value: any) => [
        {
          type: 'text',
          text: value.ok === false
            ? `Log worklog failed: ${value.error}`
            : `Recorded ${value.duration} on ${value.key} (${value.id}) — local only`,
        },
      ],
    },
    async execute(args, exec) {
      const sessionId = sessionOf(args, exec)
      if (sessionId === null) {
        return { ok: false, error: '无法确定本 session' }
      }
      const binding = await bindingFor(sessionId)
      if (binding === null) {
        return { ok: false, error: '本 session 未绑定 Jira issue' }
      }
      const key = (args.key ?? '').trim() || binding.key

      // The duration is either what the caller measured, or the wall clock
      // since the last record. The policy's floor, rounding and ceiling apply
      // to the measured case; its on/off switch does not — the caller asked
      // for this entry to exist.
      let seconds = args.seconds
      let startedAtMs = Date.now()
      if (seconds === undefined) {
        const since = lastRecordedAt.get(key) ?? binding.startedAtMs
        const measured = secondsToRecord(Date.now() - since, binding.autoWorklog, { requireEnabled: false })
        if (measured === null) {
          return { ok: false, error: '距离上次记录的时间不足最短工时阈值' }
        }
        seconds = measured
        startedAtMs = since
      } else {
        startedAtMs = Date.now() - seconds * 1000
      }
      if (seconds <= 0) {
        return { ok: false, error: '工时必须大于 0 秒' }
      }

      const entry = await appendWorklog(config.tasksDir, key, {
        turn: null,
        step: null,
        seconds,
        comment: args.comment ?? `agent: manual log (session ${sessionId.slice(0, 12)})`,
        startedAt: localTimestamp(startedAtMs),
        createdAt: localTimestamp(Date.now()),
      })
      lastRecordedAt.set(key, Date.now())
      return {
        ok: true,
        id: entry.id,
        key,
        seconds: entry.seconds,
        duration: formatDuration(entry.seconds),
        comment: entry.comment,
        startedAt: entry.startedAt,
      }
    },
  })))

  ctx.effect(() => tools.register(defineTool({
    name: 'jira_worklogs',
    description: '读取本地工时账本（各条记录的时长、说明与上传状态）',
    parameters: {
      key: { type: 'string', description: 'issue key；缺省为当前 session 绑定的 issue' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          key: { type: 'string' },
          entries: { type: 'array' },
          totalSeconds: { type: 'number' },
          totalDuration: { type: 'string' },
          draftCount: { type: 'number' },
          syncedCount: { type: 'number' },
          failedCount: { type: 'number' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      } as any,
      render: (_args, value: any) => [
        {
          type: 'text',
          text: value.ok === false
            ? `Read worklogs failed: ${value.error}`
            : `${value.key}: ${value.entries?.length ?? 0} entries · ${value.totalDuration} · ${value.draftCount ?? 0} pending upload`,
        },
      ],
    },
    async execute(args, exec) {
      const sessionId = sessionOf(args, exec)
      const binding = sessionId === null ? null : await bindingFor(sessionId)
      const key = (args.key ?? '').trim() || binding?.key || ''
      if (key === '') {
        return { ok: false, error: '未指定 issue key，且本 session 未绑定 Jira issue' }
      }
      const entries = await readLedger(config.tasksDir, key)
      const totals = summarizeLedger(entries)
      return {
        ok: true,
        key,
        entries: entries.map(e => ({
          id: e.id,
          turn: e.turn,
          seconds: e.seconds,
          duration: formatDuration(e.seconds),
          comment: e.comment,
          startedAt: e.startedAt,
          state: e.state,
          jiraId: e.jiraId,
          error: e.error,
        })),
        totalSeconds: totals.totalSeconds,
        totalDuration: formatDuration(totals.totalSeconds),
        draftCount: totals.draftCount,
        syncedCount: totals.syncedCount,
        failedCount: totals.failedCount,
      }
    },
  })))

  ctx.effect(() => tools.register(defineTool({
    name: 'jira_upload_worklogs',
    description: '把本地工时账本中已选定的条目上传到 Jira（默认上传全部待传条目；不会上传已同步的条目）',
    parameters: {
      key: { type: 'string', description: 'issue key；缺省为当前 session 绑定的 issue' },
      ids: { type: 'array', description: '要上传的本地条目 id 列表（如 wl-01）；缺省为全部待传条目' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          key: { type: 'string' },
          uploaded: { type: 'array' },
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
            : `Uploaded ${value.syncedCount ?? 0} entries to ${value.key}`,
        },
      ],
    },
    async execute(args, exec) {
      const sessionId = sessionOf(args, exec)
      const binding = sessionId === null ? null : await bindingFor(sessionId)
      const key = (args.key ?? '').trim() || binding?.key || ''
      if (key === '') {
        return { ok: false, error: '未指定 issue key，且本 session 未绑定 Jira issue' }
      }
      if (!creds.token) throw new Error('请先在 Settings 填 Jira credentials')

      // No explicit selection means every pending entry. An explicit empty
      // list means nothing — the caller said zero, and "upload all" is not
      // something a tool may decide on its own.
      const entries = await readLedger(config.tasksDir, key)
      const ids = Array.isArray(args.ids)
        ? args.ids.map(String)
        : entries.filter(e => e.state !== 'synced').map(e => e.id)

      const r = await handleUploadWorklogs(
        { jira: makeClient(), creds, tasksDir: config.tasksDir },
        { key, ids },
      )
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, key, uploaded: r.uploaded, syncedCount: r.syncedCount }
    },
  })))

  ctx.effect(() => tools.register(defineTool({
    name: 'jira_comment',
    description: '在 Jira issue 上添加一条评论',
    parameters: {
      key: { type: 'string', description: 'issue key；缺省为当前 session 绑定的 issue' },
      body: { type: 'string', required: true, description: '评论正文' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          key: { type: 'string' },
          id: { type: 'string' },
          author: { type: 'string' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      } as any,
      render: (_args, value: any) => [
        {
          type: 'text',
          text: value.ok === false ? `Comment failed: ${value.error}` : `Comment added to ${value.key}`,
        },
      ],
    },
    async execute(args, exec) {
      const sessionId = sessionOf(args, exec)
      const binding = sessionId === null ? null : await bindingFor(sessionId)
      const key = (args.key ?? '').trim() || binding?.key || ''
      if (key === '') {
        return { ok: false, error: '未指定 issue key，且本 session 未绑定 Jira issue' }
      }
      if (!creds.token) throw new Error('请先在 Settings 填 Jira credentials')
      const r = await handleAddComment({ jira: makeClient() }, { key, body: args.body })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, key, id: r.comment.id, author: r.comment.author }
    },
  })))

  ctx.effect(() => tools.register(defineTool({
    name: 'jira_current',
    description: '查看当前 session 的 Jira 绑定详情与已记工时统计',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          bound: { type: 'boolean' },
          key: { type: 'string' },
          summary: { type: 'string' },
          statusName: { type: 'string' },
          priority: { type: 'string' },
          assignee: { type: 'string' },
          url: { type: 'string' },
          totalSeconds: { type: 'number' },
          totalDuration: { type: 'string' },
          draftCount: { type: 'number' },
          syncedCount: { type: 'number' },
          failedCount: { type: 'number' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      } as any,
      render: (_args, value: any) => [
        {
          type: 'text',
          text: value.ok === false || value.bound !== true
            ? 'This session is not bound to a Jira issue'
            : `Bound to ${value.key} — ${value.summary} · ${value.totalDuration} recorded (${value.draftCount ?? 0} pending upload)`,
        },
      ],
    },
    async execute(args, exec) {
      const sessionId = sessionOf(args, exec)
      if (sessionId === null) {
        return { ok: false, bound: false, error: '无法确定本 session' }
      }
      const binding = await bindingFor(sessionId)
      if (binding === null) {
        return { ok: true, bound: false }
      }
      const entries = await readLedger(config.tasksDir, binding.key)
      const totals = summarizeLedger(entries)
      return {
        ok: true,
        bound: true,
        key: binding.key,
        summary: binding.summary,
        statusName: binding.issueSummary.statusName,
        priority: binding.issueSummary.priority,
        assignee: binding.issueSummary.assignee,
        url: binding.issueSummary.url,
        totalSeconds: totals.totalSeconds,
        totalDuration: formatDuration(totals.totalSeconds),
        draftCount: totals.draftCount,
        syncedCount: totals.syncedCount,
        failedCount: totals.failedCount,
      }
    },
  })))

  ctx.effect(() => tools.register(defineTool({
    name: 'jira_unbind',
    description: '解除当前 session 与 Jira issue 的绑定（本地工时记录保留）',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          key: { type: 'string' },
          summary: { type: 'string' },
          error: { type: 'string' },
        },
        additionalProperties: true,
      } as any,
      render: (_args, value: any) => [
        {
          type: 'text',
          text: value.ok === false ? `Unbind failed: ${value.error}` : `Unbound from ${value.key}`,
        },
      ],
    },
    async execute(args, exec) {
      const sessionId = sessionOf(args, exec)
      if (sessionId === null) {
        return { ok: false, error: '无法确定本 session' }
      }
      const r = await handleUnbind({ tasksDir: config.tasksDir }, { sessionId })
      bindingCache.clear()
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, key: r.key, summary: r.summary }
    },
  })))

  // 5. Session scope — the binding carried into the agent's context.
  //
  // Two seams, both scoped to this plugin's fiber so they disappear with it:
  //
  //   agent/pre-step     — injects the binding before every step, so the
  //                        model always knows which issue the session is on.
  //   tools/post-execute — after a Jira tool ran, reports a call that
  //                        reached outside the bound issue. Advisory mode
  //                        attaches a note; narrow mode refuses the call.
  //
  // Both need the session's binding, which lives on disk. The lookup is
  // cached briefly so a step does not re-read the index on every call, but
  // the cache is short-lived: a binding can be made or ended from another
  // client, and a stale "no binding" answer would silently disable the
  // scope for that session until the process restarted.
  const BINDING_CACHE_TTL_MS = 2000
  const bindingCache = new Map<string, { at: number; value: CachedBinding | null }>()

  async function bindingFor(sessionId: string): Promise<CachedBinding | null> {
    const now = Date.now()
    const cached = bindingCache.get(sessionId)
    if (cached !== undefined && now - cached.at < BINDING_CACHE_TTL_MS) {
      return cached.value
    }
    const detail = await readBindingDetailBySession(config.tasksDir, sessionId)
    const value = detail === null
      ? null
      : {
          key: detail.key,
          summary: detail.summary,
          issueSummary: detail.issueSummary as unknown as Record<string, string>,
          autoWorklog: detail.autoWorklog,
          startedAtMs: Date.parse(detail.startedAt),
        }
    bindingCache.set(sessionId, { at: now, value })
    return value
  }

  // A binding change invalidates the cache: the next lookup re-reads the
  // index rather than serving the previous binding.
  ctx.effect(() => scope.watch(() => {
    bindingCache.clear()
  }))

  ctx.on('agent/pre-step', async (
    payload: { agent: { id: string } },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const binding = await bindingFor(payload.agent.id)
    if (binding === null) return decision
    const text = renderScopeContext({
      key: binding.key,
      summary: binding.summary,
      statusName: binding.issueSummary.statusName,
      priority: binding.issueSummary.priority,
      assignee: binding.issueSummary.assignee,
      duedate: binding.issueSummary.duedate,
    })
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name: 'scjira', text }] },
        }),
      ],
    }
  })

  ctx.on('tools/post-execute', async (
    exec: ToolExecution,
    _result: unknown,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> => {
    const decision = await next()
    if (!isJiraTool(exec.name)) return decision
    if (exec.agent === undefined) return decision
    const binding = await bindingFor(exec.agent.id)
    if (binding === null) return decision

    const { out, target } = isOutOfScope(exec.name, exec.arguments, binding.key)
    if (!out || target === null) return decision

    const mode = resolveScopeMode(creds.scopeMode)
    if (mode === 'narrow') {
      return {
        kind: 'block',
        feedback: [{ type: 'text', text: renderScopeRefusal(binding, target) }],
      }
    }
    // Advisory: the call stands, and the model is told it strayed.
    const text = renderScopeNotice(binding, target)
    const notice = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name: 'scjira', text }] },
    })
    return {
      ...decision,
      additionalContexts: [notice, ...(decision.additionalContexts ?? [])],
    }
  })

  // 6. Automatic worklog recording — LOCAL ONLY.
  //
  // A turn's wall-clock duration is recorded into the local ledger when the
  // turn closes. Nothing is sent to Jira: an entry stays a draft until a
  // person reviews it and uploads it. That is the whole point of the local
  // ledger — the time is captured automatically, but the record on the
  // tracker is a decision a human makes.
  //
  // The timer opens on the turn's first admitted step and closes at
  // `agent/turn-stopping`.
  const turnTimer = new TurnTimer()

  ctx.on('agent/pre-step', async (
    payload: { agent: { id: string }; turn: number },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> => {
    // Open the turn BEFORE delegating: the step's own work is part of the
    // turn's duration, and a rejected step still consumed time.
    turnTimer.start(payload.agent.id, payload.turn)
    return next()
  })

  ctx.on('agent/turn-stopping', async (payload: { agent: { id: string }; turn: number }) => {
    const span = turnTimer.end(payload.agent.id, payload.turn)
    if (span === null) return
    const binding = await bindingFor(payload.agent.id)
    if (binding === null) return
    const seconds = secondsToRecord(span.elapsedMs, binding.autoWorklog)
    if (seconds === null) return
    try {
      await appendWorklog(config.tasksDir, binding.key, {
        turn: payload.turn,
        step: null,
        seconds,
        comment: autoComment(payload.turn, payload.agent.id, binding.autoWorklog.includeSessionId),
        startedAt: localTimestamp(span.startedAt),
        createdAt: localTimestamp(span.endedAt),
      })
      // The next measured interval starts where this one ended, so the
      // automatic recorder and a manual `jira_log_worklog` measure from the
      // same point.
      lastRecordedAt.set(binding.key, span.endedAt)
    } catch {
      // Recording must never disturb the agent. A ledger write that fails is
      // a missing entry, not a broken turn.
    }
  })

  // 7. Activity log — what actually ran.
  //
  // The host writes this because it can observe the durable session events.
  // The summary of a turn is the agent's to write (see the jira_summarize
  // tool): only the agent knows what it was trying to do.
  ctx.on('session/event', (session: { id: string }, event: { type: string; data?: unknown }) => {
    if (event.type !== 'tool/call') return
    const data = event.data as { name?: string; arguments?: string } | undefined
    if (data?.name === undefined) return
    const toolName = data.name
    const toolArgs = data.arguments ?? ''
    void (async () => {
      const binding = await bindingFor(session.id)
      if (binding === null) return
      try {
        await appendSessionLog(config.tasksDir, binding.key, {
          ts: new Date().toISOString(),
          text: describeToolCall(toolName, toolArgs),
          source: 'command',
        })
      } catch {
        // A log write that fails must not disturb the session.
      }
    })()
  })

  // 8. Commands — the human entry points.
  //
  // A command runs against the agent WITHOUT creating a model message: the
  // user binds a ticket, reads the ledger, or ends a binding, and none of it
  // enters the conversation. That is the difference between a command and a
  // tool — a tool is something the model asks for, a command is something a
  // person asks for, and this session's binding is a person's decision.
  //
  // The commands service is optional. A host without it runs the plugin just
  // fine; it simply offers no slash commands.
  interface CommandOutcome {
    kind: 'success' | 'error'
    text?: string
  }
  interface CommandDefinition {
    name: string
    description: string
    input?: { hint: string }
    handler: (
      invocation: { agent: { id: string }; rawInput: string },
    ) => CommandOutcome | Promise<CommandOutcome>
  }
  const commands = ctx.get('commands') as {
    register(definition: CommandDefinition): () => void
  } | undefined

  if (commands !== undefined) {
    // /jira-bind [key] — bind this session to an issue.
    //
    // With a key it binds straight away. Without one it says what the
    // session is bound to, and the client decoration turns the bare
    // invocation into a picker of the open issues.
    ctx.effect(() => commands.register({
      name: 'jira-bind',
      description: '把当前 session 绑定到一个 Jira issue',
      input: { hint: '<issue-key>' },
      handler: async (invocation): Promise<CommandOutcome> => {
        const sessionId = invocation.agent.id
        const key = invocation.rawInput.trim()

        if (key === '') {
          const bound = await bindingFor(sessionId)
          return {
            kind: 'success',
            text: bound === null
              ? '请指定 Jira issue key（如 /jira-bind DZ300-1826），或从命令菜单中选择。'
              : `本 session 已绑定 ${bound.key}（${bound.summary}）。要换绑请先 /jira-unbind。`,
          }
        }

        if (!creds.token) {
          return { kind: 'error', text: '请先在 Settings 填 Jira credentials' }
        }
        try {
          const r = await handleBind(
            { jira: makeClient(), creds, tasksDir: config.tasksDir },
            { sessionId, taskKey: key },
          )
          bindingCache.clear()
          if (!r.ok) return { kind: 'error', text: r.error }
          return { kind: 'success', text: `已绑定到 ${r.key} — ${r.summary}` }
        } catch (err) {
          // A key already held by another session throws rather than
          // returning — the message says which session holds it.
          return { kind: 'error', text: (err as Error).message }
        }
      },
    }))

    // /jira-unbind — end the binding, keep the files.
    ctx.effect(() => commands.register({
      name: 'jira-unbind',
      description: '解除当前 session 与 Jira issue 的绑定（本地工时记录保留）',
      handler: async (invocation): Promise<CommandOutcome> => {
        const r = await handleUnbind({ tasksDir: config.tasksDir }, { sessionId: invocation.agent.id })
        bindingCache.clear()
        if (!r.ok) return { kind: 'error', text: r.error }
        return { kind: 'success', text: `已解绑 ${r.key} — ${r.summary}（本地工时记录保留）` }
      },
    }))

    // /jira-worklog — read the local ledger from the command line.
    //
    // The panel is where the upload happens; this is where the numbers are
    // readable without leaving the conversation.
    ctx.effect(() => commands.register({
      name: 'jira-worklog',
      description: '查看当前 session 绑定 issue 的本地工时账本',
      handler: async (invocation): Promise<CommandOutcome> => {
        const binding = await bindingFor(invocation.agent.id)
        if (binding === null) {
          return { kind: 'error', text: '本 session 未绑定 Jira issue' }
        }
        const entries = await readLedger(config.tasksDir, binding.key)
        const totals = summarizeLedger(entries)
        const lines = [
          `${binding.key} 本地工时账本：${totals.count} 条 · 合计 ${formatDuration(totals.totalSeconds)} · ` +
          `待传 ${totals.draftCount} · 已同步 ${totals.syncedCount} · 失败 ${totals.failedCount}`,
        ]
        for (const e of entries.slice(-10)) {
          const jira = e.jiraId !== null ? ` (jira ${e.jiraId})` : ''
          lines.push(`  ${e.startedAt}  ${formatDuration(e.seconds)}  ${e.state}${jira}  ${e.comment}`)
        }
        lines.push('上传需在「绑定 Session」面板勾选后确认。')
        return { kind: 'success', text: lines.join('\n') }
      },
    }))
  }
}
