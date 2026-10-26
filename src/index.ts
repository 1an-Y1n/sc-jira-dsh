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
import type { IncomingMessage, ServerResponse } from 'node:http'
import Schema from '@deepseek-ai/schemastery'
import type { ScjiraSettings } from './types.js'
import { JiraClient } from './jira-client.js'
import {
  handleListMyOpen,
  handleListWorklogWeek,
  handleBind,
  handleGetBinding,
} from './handlers.js'
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
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true, key: r.key, sessionId: r.sessionId, summary: r.summary }
    },
  })))
}
