import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeMetaWithBinding } from '../src/storage.js'
import { appendWorklog } from '../src/worklog-ledger.js'

/**
 * The three human commands.
 *
 * A command runs against the agent without creating a model message, so the
 * thing worth testing is what it says and what it does to the binding — not
 * the model.
 */
function makeContext(creds: Record<string, unknown> = {}) {
  const commands = new Map<string, any>()
  const routes: any[] = []
  const tools = new Map<string, any>()

  const settings = {
    register: (_ns: string, _schema: any) => ({
      get: () => ({
        server: 'https://jiratest.example.com',
        login: 'A003688',
        token: '',
        displayName: 'Ian Yin',
        proxy: '',
        scopeMode: 'advisory',
        ...creds,
      }),
      watch: (_cb: any) => () => {},
    }),
  }

  const commandsService = {
    register: (definition: any) => {
      commands.set(definition.name, definition)
      return () => { commands.delete(definition.name) }
    },
  }

  const ctx: any = {
    settings,
    webServer: { register: (route: any) => { routes.push(route); return () => {} } },
    tools: { register: (tool: any) => { tools.set(tool.name, tool); return () => {} } },
    effect: (fn: () => any) => fn(),
    on: () => () => {},
    get: (name: string) => (name === 'commands' ? commandsService : undefined),
  }

  return { ctx, commands, routes, tools }
}

async function applyPlugin(ctx: any, tasksDir: string) {
  const { apply } = await import('../src/index.js')
  apply(ctx, { tasksDir })
}

describe('/jira-bind', () => {
  it('without a key it asks for one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scjira-cmd-'))
    try {
      const { ctx, commands } = makeContext()
      await applyPlugin(ctx, dir)
      const r = await commands.get('jira-bind').handler({ agent: { id: 'agent-1' }, rawInput: '  ' })
      expect(r.kind).toBe('success')
      expect(r.text).toContain('请指定 Jira issue key')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('without a key on a bound session it names the binding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scjira-cmd-'))
    try {
      await writeMetaWithBinding(dir, {
        key: 'DZ300-797',
        sessionId: 'agent-1',
        issueSummary: { summary: 'The issue', statusName: 'Open' },
      })
      const { ctx, commands } = makeContext()
      await applyPlugin(ctx, dir)
      const r = await commands.get('jira-bind').handler({ agent: { id: 'agent-1' }, rawInput: '' })
      expect(r.kind).toBe('success')
      expect(r.text).toContain('DZ300-797')
      expect(r.text).toContain('/jira-unbind')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('with a key and no credentials it says so instead of calling Jira', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scjira-cmd-'))
    try {
      const { ctx, commands } = makeContext()
      await applyPlugin(ctx, dir)
      const r = await commands.get('jira-bind').handler({ agent: { id: 'agent-1' }, rawInput: 'DZ300-797' })
      expect(r.kind).toBe('error')
      expect(r.text).toContain('credentials')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('advertises an input hint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scjira-cmd-'))
    try {
      const { ctx, commands } = makeContext()
      await applyPlugin(ctx, dir)
      expect(commands.get('jira-bind').input.hint).toBe('<issue-key>')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('/jira-unbind', () => {
  it('ends the binding and keeps the ledger', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scjira-cmd-'))
    try {
      await writeMetaWithBinding(dir, {
        key: 'DZ300-797',
        sessionId: 'agent-1',
        issueSummary: { summary: 'The issue', statusName: 'Open' },
      })
      await appendWorklog(dir, 'DZ300-797', {
        seconds: 1800,
        comment: 'auto: turn 1',
        startedAt: '2026-10-28T09:00:00.000+0800',
        createdAt: '2026-10-28T10:00:00.000+0800',
      })
      const { ctx, commands } = makeContext()
      await applyPlugin(ctx, dir)
      const r = await commands.get('jira-unbind').handler({ agent: { id: 'agent-1' }, rawInput: '' })
      expect(r.kind).toBe('success')
      expect(r.text).toContain('DZ300-797')
      expect(r.text).toContain('保留')

      // The binding is gone; the recorded time is not.
      const { readBindingBySession } = await import('../src/storage.js')
      expect((await readBindingBySession(dir, 'agent-1')).bound).toBe(false)
      const { readLedger } = await import('../src/worklog-ledger.js')
      expect((await readLedger(dir, 'DZ300-797')).length).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports that nothing was bound', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scjira-cmd-'))
    try {
      const { ctx, commands } = makeContext()
      await applyPlugin(ctx, dir)
      const r = await commands.get('jira-unbind').handler({ agent: { id: 'agent-1' }, rawInput: '' })
      expect(r.kind).toBe('error')
      expect(r.text).toContain('not bound')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('/jira-worklog', () => {
  it('reads the local ledger of the bound issue', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scjira-cmd-'))
    try {
      await writeMetaWithBinding(dir, {
        key: 'DZ300-797',
        sessionId: 'agent-1',
        issueSummary: { summary: 'The issue', statusName: 'Open' },
      })
      await appendWorklog(dir, 'DZ300-797', {
        seconds: 3600,
        comment: 'auto: turn 3',
        startedAt: '2026-10-28T09:00:00.000+0800',
        createdAt: '2026-10-28T10:00:00.000+0800',
      })
      const { ctx, commands } = makeContext()
      await applyPlugin(ctx, dir)
      const r = await commands.get('jira-worklog').handler({ agent: { id: 'agent-1' }, rawInput: '' })
      expect(r.kind).toBe('success')
      expect(r.text).toContain('DZ300-797')
      expect(r.text).toContain('1h')
      expect(r.text).toContain('auto: turn 3')
      expect(r.text).toContain('待传 1')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('says so when the session is not bound', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scjira-cmd-'))
    try {
      const { ctx, commands } = makeContext()
      await applyPlugin(ctx, dir)
      const r = await commands.get('jira-worklog').handler({ agent: { id: 'agent-1' }, rawInput: '' })
      expect(r.kind).toBe('error')
      expect(r.text).toContain('未绑定')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
