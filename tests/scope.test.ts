import { describe, it, expect } from 'vitest'
import {
  SCOPED_TOOLS,
  isJiraTool,
  isOutOfScope,
  renderScopeContext,
  renderScopeNotice,
  renderScopeRefusal,
  resolveScopeMode,
  scopeFor,
  targetIssue,
} from '../src/scope.js'

describe('scopeFor', () => {
  it('knows the tools that carry an issue key', () => {
    expect(scopeFor('jira_issue')?.issueSpecific).toBe(true)
    expect(scopeFor('jira_issue')?.issueArgument).toBe('key')
    expect(scopeFor('jira_bind')?.issueArgument).toBe('taskKey')
  })

  it('knows the account-wide views', () => {
    expect(scopeFor('jira_list_my_open')?.issueSpecific).toBe(false)
    expect(scopeFor('jira_list_worklog_week')?.issueSpecific).toBe(false)
  })

  it('returns null for a tool that is not ours', () => {
    expect(scopeFor('bash')).toBeNull()
    expect(scopeFor('read')).toBeNull()
  })

  it('every declared tool has a unique name', () => {
    const names = SCOPED_TOOLS.map(t => t.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('isJiraTool', () => {
  it('recognizes our tools', () => {
    expect(isJiraTool('jira_list_my_open')).toBe(true)
    expect(isJiraTool('jira_bind')).toBe(true)
  })

  it('rejects foreign tools', () => {
    expect(isJiraTool('shell')).toBe(false)
    expect(isJiraTool('')).toBe(false)
  })
})

describe('targetIssue', () => {
  it('reads the issue from the named argument', () => {
    expect(targetIssue('jira_issue', { key: 'DZ300-1' }, 'DZ300-9')).toBe('DZ300-1')
  })

  it('trims the value', () => {
    expect(targetIssue('jira_issue', { key: '  DZ300-1  ' }, 'DZ300-9')).toBe('DZ300-1')
  })

  it('falls back to the bound issue when the argument is absent', () => {
    expect(targetIssue('jira_log_worklog', {}, 'DZ300-9')).toBe('DZ300-9')
  })

  it('falls back to the bound issue when the argument is empty', () => {
    expect(targetIssue('jira_log_worklog', { key: '  ' }, 'DZ300-9')).toBe('DZ300-9')
  })

  it('is null for an account-wide tool', () => {
    expect(targetIssue('jira_list_my_open', {}, 'DZ300-9')).toBeNull()
  })

  it('is null for a foreign tool', () => {
    expect(targetIssue('bash', { command: 'ls' }, 'DZ300-9')).toBeNull()
  })

  it('tolerates a non-object argument bag', () => {
    expect(targetIssue('jira_issue', undefined, 'DZ300-9')).toBe('DZ300-9')
    expect(targetIssue('jira_issue', 'oops', 'DZ300-9')).toBe('DZ300-9')
  })
})

describe('isOutOfScope', () => {
  it('an unbound session is never out of scope', () => {
    expect(isOutOfScope('jira_issue', { key: 'DZ300-1' }, null).out).toBe(false)
  })

  it('the bound issue is in scope', () => {
    expect(isOutOfScope('jira_issue', { key: 'DZ300-1' }, 'DZ300-1').out).toBe(false)
  })

  it('another issue is out of scope', () => {
    const r = isOutOfScope('jira_issue', { key: 'DZ300-2' }, 'DZ300-1')
    expect(r.out).toBe(true)
    expect(r.target).toBe('DZ300-2')
  })

  it('an account-wide view is never out of scope', () => {
    expect(isOutOfScope('jira_list_my_open', {}, 'DZ300-1').out).toBe(false)
    expect(isOutOfScope('jira_list_worklog_week', {}, 'DZ300-1').out).toBe(false)
  })

  it('a tool with no issue argument defaults to the bound issue', () => {
    expect(isOutOfScope('jira_log_worklog', {}, 'DZ300-1').out).toBe(false)
  })
})

describe('renderScopeContext', () => {
  it('names the issue and its summary', () => {
    const text = renderScopeContext({ key: 'DZ300-1', summary: 'Fix the thing' })
    expect(text).toContain('DZ300-1')
    expect(text).toContain('Fix the thing')
  })

  it('includes the state facts when present', () => {
    const text = renderScopeContext({
      key: 'DZ300-1',
      summary: 'Fix',
      statusName: 'RD Develop',
      priority: 'High',
      assignee: 'Ian Yin',
      duedate: '2026-10-30',
    })
    expect(text).toContain('RD Develop')
    expect(text).toContain('High')
    expect(text).toContain('Ian Yin')
    expect(text).toContain('2026-10-30')
  })

  it('omits absent facts rather than printing empty labels', () => {
    const text = renderScopeContext({ key: 'DZ300-1', summary: 'Fix' })
    expect(text).not.toContain('状态:')
    expect(text).not.toContain('优先级:')
  })

  it('tells the model the work is bounded by the issue', () => {
    expect(renderScopeContext({ key: 'DZ300-1', summary: 'Fix' })).toContain('限定')
  })
})

describe('renderScopeNotice', () => {
  it('names the bound issue and the one that was reached', () => {
    const text = renderScopeNotice({ key: 'DZ300-1', summary: 'Fix' }, 'DZ300-2')
    expect(text).toContain('DZ300-1')
    expect(text).toContain('DZ300-2')
  })

  it('asks the model to confirm rather than forbidding', () => {
    const text = renderScopeNotice({ key: 'DZ300-1', summary: 'Fix' }, 'DZ300-2')
    expect(text).toContain('请确认')
    expect(text).not.toContain('禁止')
  })
})

describe('renderScopeRefusal', () => {
  it('states the bound issue and the offending one', () => {
    const text = renderScopeRefusal({ key: 'DZ300-1', summary: 'Fix' }, 'DZ300-2')
    expect(text).toContain('DZ300-1')
    expect(text).toContain('DZ300-2')
  })

  it('tells the user how to proceed', () => {
    const text = renderScopeRefusal({ key: 'DZ300-1', summary: 'Fix' }, 'DZ300-2')
    expect(text).toContain('解绑')
  })
})

describe('resolveScopeMode', () => {
  it('defaults to advisory', () => {
    expect(resolveScopeMode(undefined)).toBe('advisory')
    expect(resolveScopeMode(null)).toBe('advisory')
    expect(resolveScopeMode('advisory')).toBe('advisory')
  })

  it('honours narrow', () => {
    expect(resolveScopeMode('narrow')).toBe('narrow')
  })

  it('falls back to advisory for an unknown value', () => {
    expect(resolveScopeMode('weird')).toBe('advisory')
  })
})
