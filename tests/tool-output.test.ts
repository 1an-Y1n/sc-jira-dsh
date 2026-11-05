import { describe, it, expect } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { lossless } from '../src/lossless.js'
import { defineJiraTool } from '../src/tool.js'
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

describe('lossless', () => {
  it('drops an undefined-valued property', () => {
    const value = lossless({ a: 1, b: undefined, c: 'x' })
    expect(Object.hasOwn(value, 'b')).toBe(false)
    expect(value).toEqual({ a: 1, c: 'x' })
  })

  it('keeps a null, which JSON does carry', () => {
    expect(lossless({ a: null })).toEqual({ a: null })
  })

  it('drops undefined inside nested objects and arrays', () => {
    expect(lossless({ rows: [{ id: 'wl-1', jiraId: undefined }] })).toEqual({ rows: [{ id: 'wl-1' }] })
  })

  it('turns an undefined array element into null, as JSON would', () => {
    expect(lossless([1, undefined, 3])).toEqual([1, null, 3])
  })

  it('leaves a class instance alone', () => {
    const when = new Date('2026-10-28T09:00:00.000Z')
    expect(lossless({ when }).when).toBe(when)
  })
})

describe('defineJiraTool', () => {
  it('strips an undefined field from what the tool returns', async () => {
    const tool = defineJiraTool({
      name: 'probe',
      description: 'probe',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          properties: { key: { type: 'string' }, count: { type: 'number' } },
          additionalProperties: true,
        } as any,
        render: () => [{ type: 'text', text: 'ok' }],
      },
      async execute() {
        // The shape a binding/issue read produces when a field is unknown.
        return { key: undefined, count: 2 } as any
      },
    })

    const value = await tool.execute({}, {} as any)
    expect(Object.hasOwn(value as object, 'key')).toBe(false)
    expect(undefinedPaths(value)).toEqual([])
    expect(validateJsonSchemaValue((tool.output.schema as any), value, 'value')).toEqual([])
  })

  it('leaves a defined value untouched', async () => {
    const tool = defineJiraTool({
      name: 'probe',
      description: 'probe',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true } as any,
        render: () => [{ type: 'text', text: 'ok' }],
      },
      async execute() {
        return { key: 'DZ300-797', comments: [] } as any
      },
    })
    expect(await tool.execute({}, {} as any)).toEqual({ key: 'DZ300-797', comments: [] })
  })
})

describe('the registered tools', () => {
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

  it('are the nine expected tools and no others', async () => {
    const { ctx, tools } = makeContext()
    const { apply } = await import('../src/index.js')
    apply(ctx, makeConfig())

    expect([...tools.keys()].sort()).toEqual([
      'jira_bind',
      'jira_generate_worklog',
      'jira_issue',
      'jira_list_my_open',
      'jira_list_worklog_week',
      'jira_record_activity',
      'jira_unbind',
      'jira_upload_worklog',
      'jira_worklog_state',
    ])
    // The v3 surface is gone: no scope query, no ledger read, no summary,
    // and no second way to write a comment.
    for (const name of ['jira_get_binding', 'jira_current', 'jira_comment',
      'jira_log_worklog', 'jira_worklogs', 'jira_upload_worklogs', 'jira_summarize']) {
      expect(tools.has(name)).toBe(false)
    }
  })

  it('returns a state the schema accepts, bound or not', async () => {
    // The state read is the one the agent asks for most, and it has the most
    // nullable fields: an unbound session has no key, and a session with no
    // draft has no generation time. A schema that says `string` where the
    // value is null fails the WHOLE call — the model gets an error instead of
    // the state, and never learns what is missing.
    const { ctx, tools } = makeContext()
    const { apply } = await import('../src/index.js')
    apply(ctx, makeConfig())

    const tool = tools.get('jira_worklog_state')
    const exec = { agent: { id: 'session-unbound' }, sessionId: 'session-unbound' } as any

    const unbound = await tool.execute({}, exec)
    expect(validateJsonSchemaValue((tool.output.schema as any), unbound, 'value')).toEqual([])
    expect(unbound.bound).toBe(false)
    expect(unbound.key).toBeNull()
    expect(unbound.generatedAt).toBeNull()

    const bound = await tool.execute({}, { ...exec, agent: { id: 'session-bound' } })
    expect(validateJsonSchemaValue((tool.output.schema as any), bound, 'value')).toEqual([])
  })

  it('refuse to call Jira without credentials instead of returning a broken value', async () => {
    const { ctx, tools } = makeContext()
    const { apply } = await import('../src/index.js')
    // makeConfig's default carries no token.
    apply(ctx, makeConfig())
    for (const [name, args] of [['jira_list_my_open', {}], ['jira_list_worklog_week', {}], ['jira_issue', { key: 'DZ300-1' }]] as const) {
      await expect(tools.get(name).execute(args, {} as any)).rejects.toThrow('credentials')
    }
  })
})
