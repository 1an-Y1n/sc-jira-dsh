/**
 * sc-jira HOST apply. Registers:
 *   - The plugin's own settings form (server/login/token/displayName/proxy;
 *     the token is secret), keyed by the profile entry id
 *   - 4 HTTP routes at /api/scjira/*  (status, config, issue, list-worklog-week)
 *   - 3 read-only tools (jira_list_my_open, jira_list_worklog_week, jira_issue)
 *
 * This plugin is READ-ONLY: it shows what Jira already knows. Nothing here
 * binds a session, records time, or writes to the tracker, so there is no
 * local state to keep and no hook to install — a read cannot go stale, and a
 * plugin that stores nothing cannot drift from the source of truth.
 *
 * All registrations wrap ctx.effect for automatic dispose. The credentials
 * are read live from the volatile Config values the Host holds, so a settings
 * write is the next request's truth — there is no second copy to keep in
 * step, and nothing to invalidate.
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
// These imports pull in each package's `declare module '@deepseek-ai/cordis'`
// augmentation so ctx.settings / ctx.tools / ctx.webServer become typed.
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import type { IncomingMessage, ServerResponse } from 'node:http'
import Schema from '@deepseek-ai/schemastery'
import type { ScjiraSettings } from './types.js'
import { JiraClient, formatDuration } from './jira-client.js'
import {
  handleListMyOpen,
  handleListWorklogWeek,
  handleIssue,
} from './handlers.js'
import { defineJiraTool } from './tool.js'

export const name = 'sc-jira'

/**
 * The plugin's configuration.
 *
 * The five credential fields are volatile: the Host holds their resolved
 * values live and the settings card writes through them without remounting the
 * plugin. `token` is secret, so it is redacted on the way to the client — the
 * client learns that a token is set, never what it is — and it carries no
 * default, so an unset token reads as absent rather than as an empty string.
 */
export const Config = Schema.object({
  server: Schema.string().default('https://jiraprod.sercomm.com').volatile(),
  login: Schema.string().default('A003688').volatile(),
  token: Schema.string().role('secret').volatile(),
  displayName: Schema.string().default('Ian Yin').volatile(),
  proxy: Schema.string().default('').volatile(),
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

/**
 * The loader entry that owns this plugin instance.
 *
 * The profile entry id IS the settings namespace: the Host keys every
 * settings form by the id the profile gave the entry, so the plugin cannot
 * choose one — it asks the loader for the id this entry carries.
 * `cordis-plugin-loader` is not a peer of this plugin, so the slice is
 * described here rather than imported.
 */
interface LoaderEntry {
  options?: { id?: string }
}

export function apply(ctx: Context, config: ScjiraConfig): void {
  // After the imports above, ctx.settings is typed as SettingsForms (from
  // dsh-settings' module augmentation). We still need a local webServer view
  // because cordis-web-server's .d.ts is not a peer dep of this plugin.
  const settings: SettingsForms = ctx.settings
  const webServer = (ctx as unknown as { webServer: WebServerHost }).webServer
  const tools = (ctx as unknown as { tools: { register(def: unknown): () => void } }).tools

  // 1. The settings namespace — the profile entry id.
  const entryId = (ctx.fiber as unknown as { entry?: LoaderEntry }).entry?.options?.id

  /**
   * The live Jira credentials.
   *
   * Every credential is a volatile Config value: the Host holds the resolved
   * value and the settings card writes through it. Reading through getters
   * keeps ONE copy of the truth — a value written in the settings card is the
   * value the next request sees, with no cache to invalidate.
   */
  const creds: ScjiraSettings = {
    get server() { return config.server.get() },
    get login() { return config.login.get() },
    get token() { return config.token.get() ?? '' },
    get displayName() { return config.displayName.get() },
    get proxy() { return config.proxy.get() },
  }

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

      // Settings write — accepts a partial update of the plugin's settings.
      if (route === 'config' && method === 'POST') {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', async () => {
          try {
            if (entryId === undefined) {
              res.writeHead(500, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: 'this plugin instance has no profile entry, so its settings namespace is unknown' }))
              return
            }
            const parsed = JSON.parse(body) as { server?: string; login?: string; displayName?: string; token?: string; proxy?: string }
            const ops: Array<{ op: 'set'; path: string[]; value: string }> = []
            if (parsed.server !== undefined) ops.push({ op: 'set', path: ['server'], value: parsed.server })
            if (parsed.login !== undefined) ops.push({ op: 'set', path: ['login'], value: parsed.login })
            if (parsed.displayName !== undefined) ops.push({ op: 'set', path: ['displayName'], value: parsed.displayName })
            if (parsed.proxy !== undefined) ops.push({ op: 'set', path: ['proxy'], value: parsed.proxy })
            // Only write token if user supplied one (preserves existing on empty)
            if (parsed.token) ops.push({ op: 'set', path: ['token'], value: parsed.token })
            await settings.mutate(entryId, ops)
            // Read the committed values back rather than echoing what was
            // asked for: the Host owns the result, and a value it refused
            // must not be reported to the client as saved.
            const saved = creds
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
        if (route === 'list-worklog-week' && method === 'GET') {
          const u = new URL(url, 'http://x')
          const r = await handleListWorklogWeek({ jira, creds }, { startDate: u.searchParams.get('startDate') ?? undefined })
          res.writeHead(r.ok ? 200 : 502, { 'content-type': 'application/json' })
          res.end(JSON.stringify(r))
          return
        }
        if (route === 'issue' && method === 'GET') {
          const u = new URL(url, 'http://x')
          const key = (u.searchParams.get('key') ?? '').trim()
          const r = await handleIssue({ jira, creds }, { key })
          res.writeHead(r.ok ? 200 : 400, { 'content-type': 'application/json' })
          res.end(JSON.stringify(r))
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

  // 4. Tools — the same three reads, callable from the agent.
  //
  // Every one of them is a plain read: no session is identified, nothing is
  // recorded, and nothing on the tracker changes. That is the whole surface.
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
}
