import { describe, it, expect } from 'vitest'

// Provide minimal fakes for the 3 inject deps (settings, webServer, tools)
// plus the optional commands service the host reads through ctx.get.
// Also fake ctx.effect so we can verify disposers are returned.
function makeContext() {
  const routes: any[] = []
  const tools = new Map<string, any>()
  const commands = new Map<string, any>()
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

  const commandsService = {
    register: (definition: any) => {
      commands.set(definition.name, definition)
      return () => { commands.delete(definition.name) }
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
    // The commands service is optional: the plugin reads it through ctx.get.
    get: (name: string) => (name === 'commands' ? commandsService : undefined),
  }

  return { ctx, routes, tools, commands, settingsRegs, disposers }
}

describe('host plugin dispose', () => {
  it('registers 1 settings namespace + 2 route prefixes + 12 tools on apply', async () => {
    const { ctx, routes, tools, settingsRegs, disposers } = makeContext()
    const { apply } = await import('../src/index.js')
    apply(ctx, { tasksDir: '/tmp/scjira-dispose-test' })
    expect(settingsRegs.has('scjira')).toBe(true)
    expect(settingsRegs.size).toBe(1)
    // Two prefixes: the main /api/scjira routes and the worklog ledger's.
    expect(routes.length).toBe(2)
    expect(tools.size).toBe(12)
    // 12 tool registrations + 3 command registrations + 2 webServer registrations
    // + 1 settings registration → all in effects → at least 18 should be tracked
    expect(disposers.length).toBeGreaterThanOrEqual(18)
  })

  it('all 12 expected tool names are registered', async () => {
    const { ctx, tools } = makeContext()
    const { apply } = await import('../src/index.js')
    apply(ctx, { tasksDir: '/tmp/scjira-dispose-test' })
    expect(tools.has('jira_list_my_open')).toBe(true)
    expect(tools.has('jira_list_worklog_week')).toBe(true)
    expect(tools.has('jira_get_binding')).toBe(true)
    expect(tools.has('jira_bind')).toBe(true)
    expect(tools.has('jira_summarize')).toBe(true)
    expect(tools.has('jira_issue')).toBe(true)
    expect(tools.has('jira_log_worklog')).toBe(true)
    expect(tools.has('jira_worklogs')).toBe(true)
    expect(tools.has('jira_upload_worklogs')).toBe(true)
    expect(tools.has('jira_comment')).toBe(true)
    expect(tools.has('jira_current')).toBe(true)
    expect(tools.has('jira_unbind')).toBe(true)
  })

  it('registers the three human commands', async () => {
    const { ctx, commands } = makeContext()
    const { apply } = await import('../src/index.js')
    apply(ctx, { tasksDir: '/tmp/scjira-dispose-test' })
    expect(commands.has('jira-bind')).toBe(true)
    expect(commands.has('jira-unbind')).toBe(true)
    expect(commands.has('jira-worklog')).toBe(true)
  })

  it('runs without a commands service', async () => {
    // The commands service is optional: a host without it still runs the
    // plugin, it simply offers no slash commands.
    const { ctx, routes, tools } = makeContext()
    ctx.get = () => undefined
    const { apply } = await import('../src/index.js')
    apply(ctx, { tasksDir: '/tmp/scjira-dispose-test' })
    expect(routes.length).toBe(2)
    expect(tools.size).toBe(12)
  })

  it('route prefix is /api/scjira', async () => {
    const { ctx, routes } = makeContext()
    const { apply } = await import('../src/index.js')
    apply(ctx, { tasksDir: '/tmp/scjira-dispose-test' })
    expect(routes[0].path).toBe('/api/scjira')
    expect(routes[0].kind).toBe('prefix')
  })
})