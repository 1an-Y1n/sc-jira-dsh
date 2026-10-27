/**
 * sc-jira session scope.
 *
 * A session bound to a Jira issue carries that issue into the agent's
 * context: the model is told which issue it is working on, and — depending
 * on the scope mode — is warned or stopped when it reaches for a different
 * one.
 *
 * Two DSH seams carry this:
 *
 *   `agent/pre-step`      — injects the binding as context before every step,
 *                           so a long conversation never drifts to a stale
 *                           picture of what the session is about.
 *   `tools/post-execute`  — after a Jira tool ran, notes whether it reached
 *                           outside the bound issue.
 *
 * The mode decides what "reaching outside" means:
 *
 *   advisory — the call is allowed; a note is attached to the result so the
 *              model sees that it strayed.
 *   narrow   — the call is refused with a reason.
 *
 * Only the tools that NAME an issue are considered. The read-only views that
 * span the whole account (`jira_list_my_open`, `jira_list_worklog_week`) are
 * not: an agent that cannot see its own task list cannot know what it should
 * be doing.
 */
import type { ScopeMode } from './types.js'

/**
 * The issue a tool call points at, or null when the call is not
 * issue-specific.
 *
 * Kept as data rather than logic so the rule lives in one place: a new tool
 * declares which of its arguments names an issue, and the scope rules stay
 * unchanged.
 */
export interface ToolScope {
  /** Tool name as registered with the tools service. */
  name: string
  /** Argument naming the issue, when the tool has one. */
  issueArgument?: string
  /**
   * Whether the tool names a specific issue at all.
   *
   * A tool with no issue argument is account-wide and never out of scope.
   */
  issueSpecific: boolean
}

/**
 * The tools that carry an issue key.
 *
 * `jira_bind` names the issue it binds TO; the write tools name the issue
 * they act on. The read-only views are deliberately absent.
 */
export const SCOPED_TOOLS: ToolScope[] = [
  { name: 'jira_bind', issueArgument: 'taskKey', issueSpecific: true },
  { name: 'jira_issue', issueArgument: 'key', issueSpecific: true },
  { name: 'jira_log_worklog', issueArgument: 'key', issueSpecific: true },
  { name: 'jira_comment', issueArgument: 'key', issueSpecific: true },
  { name: 'jira_unbind', issueSpecific: false },
  { name: 'jira_current', issueSpecific: false },
  { name: 'jira_list_my_open', issueSpecific: false },
  { name: 'jira_list_worklog_week', issueSpecific: false },
  { name: 'jira_get_binding', issueSpecific: false },
  { name: 'jira_worklogs', issueArgument: 'key', issueSpecific: true },
  { name: 'jira_upload_worklogs', issueArgument: 'key', issueSpecific: true },
]

/** The scope rule for a tool name, or null when the tool is not a Jira tool. */
export function scopeFor(toolName: string): ToolScope | null {
  return SCOPED_TOOLS.find(t => t.name === toolName) ?? null
}

/** Whether a tool name belongs to this plugin. */
export function isJiraTool(toolName: string): boolean {
  return scopeFor(toolName) !== null
}

/**
 * The issue a call names, or null.
 *
 * A tool that takes an optional issue argument falls back to the bound
 * issue when the argument is absent — `jira_log_worklog` with no `key`
 * means "the issue this session is on", which is in scope by definition.
 */
export function targetIssue(toolName: string, args: unknown, boundKey: string | null): string | null {
  const scope = scopeFor(toolName)
  if (scope === null || !scope.issueSpecific) return null
  if (scope.issueArgument === undefined) return boundKey
  const value = readArgument(args, scope.issueArgument)
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return boundKey
}

/** Read one argument from a parsed argument bag. */
function readArgument(args: unknown, name: string): unknown {
  if (typeof args !== 'object' || args === null) return undefined
  return (args as Record<string, unknown>)[name]
}

/**
 * Whether a call reaches outside the bound issue.
 *
 * A session with no binding is never out of scope: binding is what creates
 * a scope, and an unbound session keeps the v2 behaviour of touching
 * anything.
 */
export function isOutOfScope(
  toolName: string,
  args: unknown,
  boundKey: string | null,
): { out: boolean; target: string | null } {
  if (boundKey === null) return { out: false, target: null }
  const target = targetIssue(toolName, args, boundKey)
  if (target === null) return { out: false, target: null }
  return { out: target !== boundKey, target }
}

/**
 * The context text injected before each step.
 *
 * One block, naming the issue and its state, so the model starts every step
 * knowing what the session is about.
 */
export function renderScopeContext(binding: {
  key: string
  summary: string
  statusName?: string
  priority?: string
  assignee?: string
  duedate?: string
  url?: string
}): string {
  const lines = [`[Jira 上下文] 本 session 绑定到 ${binding.key} — ${binding.summary}`]
  const facts: string[] = []
  if (binding.statusName) facts.push(`状态: ${binding.statusName}`)
  if (binding.priority) facts.push(`优先级: ${binding.priority}`)
  if (binding.assignee) facts.push(`负责人: ${binding.assignee}`)
  if (binding.duedate) facts.push(`截止: ${binding.duedate}`)
  if (facts.length > 0) lines.push(facts.join('  '))
  lines.push(`本 session 的工作应限定在此 issue 内。`)
  return lines.join('\n')
}

/**
 * The note attached to a result that reached outside the bound issue.
 */
export function renderScopeNotice(binding: { key: string; summary: string }, target: string): string {
  return (
    `[提示] 本 session 绑定到 ${binding.key}（${binding.summary}），` +
    `但本次调用访问了 ${target}。请确认这是否必要。`
  )
}

/**
 * The refusal text for the narrow mode.
 */
export function renderScopeRefusal(binding: { key: string; summary: string }, target: string): string {
  return (
    `本 session 已绑定 ${binding.key}（${binding.summary}）。` +
    `本次调用访问了 ${target}，超出绑定范围。` +
    `如需处理其他 issue，请先解绑或新建 session。`
  )
}

/** The mode a settings object selects, defaulting to advisory. */
export function resolveScopeMode(mode: unknown): ScopeMode {
  return mode === 'narrow' ? 'narrow' : 'advisory'
}
