import { describe, it, expect } from 'vitest'

// Provide minimal fakes for the 3 inject deps (settings, webServer, tools).
// Also fake ctx.effect so we can verify disposers are returned.
function makeContext() {
  const routes: any[] = []
  const tools = new Map<string, any>()
  const settingsRegs = new Map<string, any>()
  const disposers: Array<() => void> = []

  const settings = {
    register: (ns: string, _schema: any) => {
      const scope = {
        get: () => ({ server: 's', login: 'l', token: '', displayName: 'd' }),
        watch: (_cb: any) => () => {},
        update: async () => {},
        replace: async () => {},
        mutate: async () => {},
      }
      settingsRegs.set(ns, scope)
      return scope
    },
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
    effect: (fn: () => any) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return d
    },
    on: () => () => {},
    register: (key: string, svc: any) => { (ctx as any)[key] = svc },
  }

  return { ctx, routes, tools, settingsRegs, disposers }
}

describe('host plugin dispose', () => {
  it('registers 1 settings namespace + 1 route prefix + 5 tools on apply', async () => {
    const { ctx, routes, tools, settingsRegs, disposers } = makeContext()
    const { apply } = await import('../src/index.js')
    apply(ctx, { tasksDir: '/tmp/scjira-dispose-test' })
    expect(settingsRegs.has('scjira')).toBe(true)
    expect(settingsRegs.size).toBe(1)
    expect(routes.length).toBe(1)
    expect(tools.size).toBe(5)
    // 5 tool registrations + 1 webServer registration + 1 settings registration
    // → all in effects → at least 7 should be tracked
    expect(disposers.length).toBeGreaterThanOrEqual(7)
  })

  it('all 5 expected tool names are registered', async () => {
    const { ctx, tools } = makeContext()
    const { apply } = await import('../src/index.js')
    apply(ctx, { tasksDir: '/tmp/scjira-dispose-test' })
    expect(tools.has('jira_list_my_open')).toBe(true)
    expect(tools.has('jira_list_worklog_week')).toBe(true)
    expect(tools.has('jira_get_binding')).toBe(true)
    expect(tools.has('jira_bind')).toBe(true)
    expect(tools.has('jira_summarize')).toBe(true)
  })

  it('route prefix is /api/scjira', async () => {
    const { ctx, routes } = makeContext()
    const { apply } = await import('../src/index.js')
    apply(ctx, { tasksDir: '/tmp/scjira-dispose-test' })
    expect(routes[0].path).toBe('/api/scjira')
    expect(routes[0].kind).toBe('prefix')
  })
})