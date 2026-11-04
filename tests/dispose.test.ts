import { describe, it, expect } from 'vitest'
import { makeConfig } from './fakes.js'

// Provide minimal fakes for the 3 inject deps (settings, webServer, tools).
// Also fake ctx.effect so we can verify disposers are returned.

function makeContext() {
  const routes: any[] = []
  const tools = new Map<string, any>()
  const settingsMutations: Array<{ ns: string; ops: any[] }> = []
  const disposers: Array<() => void> = []

  const settings = {
    mutate: async (ns: string, ops: any[]) => { settingsMutations.push({ ns, ops }) },
    update: async () => {},
    replace: async () => {},
  }

  const webServer = {
    register: (route: any) => {
      routes.push(route)
      return () => {
        const i = routes.indexOf(route)
        if (i >= 0) routes.splice(i, 1)
      }
    },
  }

  const toolsService = {
    register: (tool: any) => {
      tools.set(tool.name, tool)
      return () => { tools.delete(tool.name) }
    },
  }

  const ctx: any = {
    settings,
    webServer,
    tools: toolsService,
    // The loader hands the plugin the profile entry it runs under, and the
    // entry id IS the settings namespace.
    fiber: { entry: { options: { id: 'sc-jira' } } },
    effect: (fn: () => any) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return d
    },
    on: () => () => {},
    // The plugin no longer subscribes to any host event and reads no optional
    // service: a read-only plugin has nothing to hook.
    get: () => undefined,
  }

  return { ctx, routes, tools, settingsMutations, disposers }
}

/** A request that delivers its body when the route handler asks for it. */
function makeRequest(method: string, url: string, body = '') {
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {}
  const req: any = {
    method,
    url,
    on(event: string, cb: (arg?: unknown) => void) {
      ;(listeners[event] ??= []).push(cb)
      return req
    },
  }
  const flush = async () => {
    for (const cb of listeners.data ?? []) cb(body)
    for (const cb of listeners.end ?? []) await cb()
  }
  return { req, flush }
}

/** A response that records what the route wrote. */
function makeResponse() {
  const res: any = {
    statusCode: 0,
    payload: '',
    headers: {} as Record<string, unknown>,
    writeHead(code: number, headers: Record<string, unknown>) {
      res.statusCode = code
      res.headers = headers
      return res
    },
    end(chunk?: string) {
      res.payload = chunk ?? ''
      return res
    },
  }
  return res
}

describe('host plugin dispose', () => {
  it('registers 1 route prefix + 3 tools on apply', async () => {
    const { ctx, routes, tools, disposers } = makeContext()
    const { apply } = await import('../src/index.js')
    apply(ctx, makeConfig())
    // One prefix carries every read route; the plugin has no second surface.
    expect(routes.length).toBe(1)
    expect(tools.size).toBe(3)
    // 3 tool registrations + 1 webServer registration
    expect(disposers.length).toBe(4)
  })

  it('all 3 expected tool names are registered', async () => {
    const { ctx, tools } = makeContext()
    const { apply } = await import('../src/index.js')
    apply(ctx, makeConfig())
    expect(tools.has('jira_list_my_open')).toBe(true)
    expect(tools.has('jira_list_worklog_week')).toBe(true)
    expect(tools.has('jira_issue')).toBe(true)
  })

  it('registers no hook and no command', async () => {
    const { ctx } = makeContext()
    const subscriptions: string[] = []
    ctx.on = (name: string) => { subscriptions.push(name); return () => {} }
    const { apply } = await import('../src/index.js')
    apply(ctx, makeConfig())
    expect(subscriptions).toEqual([])
  })

  it('route prefix is /api/scjira', async () => {
    const { ctx, routes } = makeContext()
    const { apply } = await import('../src/index.js')
    apply(ctx, makeConfig())
    expect(routes[0].path).toBe('/api/scjira')
    expect(routes[0].kind).toBe('prefix')
  })

  it('a read route refuses to run without a token instead of calling Jira', async () => {
    const { ctx, routes } = makeContext()
    const { apply } = await import('../src/index.js')
    // makeConfig's default has no token: the route must answer 503.
    apply(ctx, makeConfig())
    const { req, flush } = makeRequest('GET', '/api/scjira/issue?key=DZ300-1')
    const res = makeResponse()
    await routes[0].handler(req, res)
    await flush()
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.payload).ok).toBe(false)
  })
})

describe('settings namespace', () => {
  it('writes a settings change to the profile entry it runs under', async () => {
    const { ctx, routes, settingsMutations } = makeContext()
    const { apply } = await import('../src/index.js')
    apply(ctx, makeConfig())

    const { req, flush } = makeRequest('POST', '/api/scjira/config', JSON.stringify({
      server: 'https://jira.example.com',
      login: 'A003688',
    }))
    const res = makeResponse()
    await routes[0].handler(req, res)
    await flush()

    expect(settingsMutations).toHaveLength(1)
    // The namespace is the profile entry id, not a namespace the plugin chose.
    expect(settingsMutations[0].ns).toBe('sc-jira')
    expect(settingsMutations[0].ops).toEqual([
      { op: 'set', path: ['server'], value: 'https://jira.example.com' },
      { op: 'set', path: ['login'], value: 'A003688' },
    ])
    expect(res.statusCode).toBe(200)
  })

  it('leaves the token alone when the change carries none', async () => {
    const { ctx, routes, settingsMutations } = makeContext()
    const { apply } = await import('../src/index.js')
    apply(ctx, makeConfig())

    const { req, flush } = makeRequest('POST', '/api/scjira/config', JSON.stringify({
      displayName: 'Ian Yin',
    }))
    await routes[0].handler(req, makeResponse())
    await flush()

    expect(settingsMutations[0].ops.map((op: any) => op.path[0])).toEqual(['displayName'])
  })

  it('refuses the write when the plugin runs without a profile entry', async () => {
    const { ctx, routes, settingsMutations } = makeContext()
    ctx.fiber = { entry: undefined }
    const { apply } = await import('../src/index.js')
    apply(ctx, makeConfig())

    const { req, flush } = makeRequest('POST', '/api/scjira/config', JSON.stringify({ login: 'x' }))
    const res = makeResponse()
    await routes[0].handler(req, res)
    await flush()

    expect(settingsMutations).toHaveLength(0)
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.payload).ok).toBe(false)
  })
})
