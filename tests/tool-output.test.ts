import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { writeMetaWithBinding } from '../src/storage.js'
import { lossless } from '../src/lossless.js'
import { makeConfig } from './fakes.js'

/**
 * The tool output contract.
 *
 * DSH snapshots a tool's canonical value as JSON before the model sees it,
 * and refuses a value JSON cannot carry. `undefined` has no JSON form, so a
 * property set to `undefined` fails the whole call with "value is not
 * lossless JSON" — the model gets that error instead of the answer, and the
 * work the tool did is thrown away.
 *
 * These tests hold the plugin to that contract the way the Host does: the
 * value must carry no `undefined` anywhere, and it must satisfy the schema
 * the tool declares.
 */

/** Every path in the value that JSON cannot carry. */
function undefinedPaths(value: unknown, path = '$'): string[] {
  if (value === undefined) return [path]
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => undefinedPaths(item, `${path}[${index}]`))
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => undefinedPaths(item, `${path}.${key}`))
  }
  return []
}

/** A Host that records the tools the plugin registers. */
function makeContext() {
  const tools = new Map<string, any>()
  const ctx: any = {
    settings: { mutate: async () => {}, update: async () => {}, replace: async () => {} },
    webServer: { register: () => () => {} },
    tools: { register: (tool: any) => { tools.set(tool.name, tool); return () => {} } },
    fiber: { entry: { options: { id: 'sc-jira' } } },
    effect: (fn: () => any) => fn(),
    on: () => () => {},
    get: () => undefined,
  }
  return { ctx, tools }
}

async function applyPlugin(ctx: any, tasksDir: string) {
  const { apply } = await import('../src/index.js')
  apply(ctx, makeConfig(tasksDir))
}

describe('lossless', () => {
  it('drops an undefined-valued property', () => {
    const value = lossless({ a: 1, b: undefined, c: 'x' })
    expect(Object.hasOwn(value, 'b')).toBe(false)
    expect(value).toEqual({ a: 1, c: 'x' })
  })

  it('keeps a null, which JSON does carry', () => {
    const value = lossless({ a: null })
    expect(value).toEqual({ a: null })
  })

  it('drops undefined inside nested objects and arrays', () => {
    const value = lossless({ rows: [{ id: 'wl-1', jiraId: undefined }] })
    expect(value).toEqual({ rows: [{ id: 'wl-1' }] })
  })

  it('turns an undefined array element into null, as JSON would', () => {
    expect(lossless([1, undefined, 3])).toEqual([1, null, 3])
  })

  it('leaves a class instance alone', () => {
    const when = new Date('2026-10-28T09:00:00.000Z')
    expect(lossless({ when }).when).toBe(when)
  })
})

describe('the session-identification tools', () => {
  it('jira_get_binding answers for an unbound session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scjira-out-'))
    try {
      const { ctx, tools } = makeContext()
      await applyPlugin(ctx, dir)
      const tool = tools.get('jira_get_binding')
      const value = await tool.execute({}, { agent: { id: 'session-unbound' } })
      expect(value.bound).toBe(false)
      expect(value.sessionId).toBe('session-unbound')
      // The key and the summary are absent, not undefined.
      expect(Object.hasOwn(value, 'key')).toBe(false)
      expect(undefinedPaths(value)).toEqual([])
      expect(validateJsonSchemaValue(tool.output.schema, value, 'value')).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('jira_current answers for a bound session whose binding has no assignee', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scjira-out-'))
    try {
      // A binding written before the assignee was stored.
      await writeMetaWithBinding(dir, {
        key: 'DZ300-797',
        sessionId: 'session-bound',
        issueSummary: { summary: 'The issue', statusName: 'Open' } as any,
      })
      const { ctx, tools } = makeContext()
      await applyPlugin(ctx, dir)
      const tool = tools.get('jira_current')
      const value = await tool.execute({}, { agent: { id: 'session-bound' } })
      expect(value.bound).toBe(true)
      expect(value.key).toBe('DZ300-797')
      // The assignee is unknown, and unknown is an absent field.
      expect(Object.hasOwn(value, 'assignee')).toBe(false)
      expect(undefinedPaths(value)).toEqual([])
      expect(validateJsonSchemaValue(tool.output.schema, value, 'value')).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('jira_current reports the assignee when the binding knows it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scjira-out-'))
    try {
      await writeMetaWithBinding(dir, {
        key: 'DZ300-797',
        sessionId: 'session-bound',
        issueSummary: {
          key: 'DZ300-797',
          summary: 'The issue',
          statusName: 'Open',
          priority: 'Medium',
          duedate: '',
          url: 'https://jiratest.example.com/browse/DZ300-797',
          assignee: 'Ian Yin',
        },
      })
      const { ctx, tools } = makeContext()
      await applyPlugin(ctx, dir)
      const tool = tools.get('jira_current')
      const value = await tool.execute({}, { agent: { id: 'session-bound' } })
      expect(value.assignee).toBe('Ian Yin')
      expect(undefinedPaths(value)).toEqual([])
      expect(validateJsonSchemaValue(tool.output.schema, value, 'value')).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('every tool that runs without Jira returns a lossless value', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scjira-out-'))
    try {
      await writeMetaWithBinding(dir, {
        key: 'DZ300-797',
        sessionId: 'session-bound',
        issueSummary: { summary: 'The issue', statusName: 'Open' } as any,
      })
      const { ctx, tools } = makeContext()
      await applyPlugin(ctx, dir)
      const exec = { agent: { id: 'session-bound' } }
      const cases: Array<[string, any]> = [
        ['jira_get_binding', {}],
        ['jira_current', {}],
        ['jira_worklogs', {}],
        ['jira_log_worklog', { seconds: 60, comment: 'test' }],
        ['jira_summarize', { turn: 1, text: 'did the thing' }],
      ]
      for (const [name, args] of cases) {
        const tool = tools.get(name)
        const value = await tool.execute(args, exec)
        expect(undefinedPaths(value), `${name} must not carry undefined`).toEqual([])
        expect(validateJsonSchemaValue(tool.output.schema, value, 'value'), name).toEqual([])
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
