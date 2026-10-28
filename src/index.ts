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
import { JiraClient } from './jira-client.js'
import {
  handleListMyOpen,
  handleListWorklogWeek,
  handleBind,
  handleGetBinding,
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
import { appendWorklog } from './worklog-ledger.js'
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
      sessionId: { type: 'string', required: true },
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
    async execute(args, _exec) {
      const r = await handleGetBinding({ tasksDir: config.tasksDir }, { sessionId: args.sessionId })
      return { bound: r.bound, key: r.key, summary: r.summary, sessionId: r.sessionId }
    },
  })))

  ctx.effect(() => tools.register(defineTool({
    name: 'jira_bind',
    description: '将当前 DSH session 绑定到一个 Jira issue key',
    parameters: {
      sessionId: { type: 'string', required: true },
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
    async execute(args, _exec) {
      if (!creds.token) throw new Error('请先在 Settings 填 Jira credentials')
      const r = await handleBind({ jira: makeClient(), creds, tasksDir: config.tasksDir }, args)
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
      sessionId: { type: 'string', required: true },
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
    async execute(args, _exec) {
      const binding = await bindingFor(args.sessionId)
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
}
