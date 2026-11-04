/**
 * The boundary every Jira tool's value crosses.
 *
 * DSH snapshots a tool's canonical value as JSON before the model sees it and
 * refuses a value JSON cannot carry. `undefined` has no JSON form: a property
 * set to `undefined` — an issue that has no assignee, a read that has no key —
 * makes the whole call fail with "value is not lossless JSON", and the model
 * receives that error instead of the answer it asked for.
 *
 * So an absent field is OMITTED, never set to `undefined`, and this is the one
 * place that happens: a tool registered through here cannot return a value the
 * Host would reject, whatever its body does.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  DefineToolOptions,
  ParameterSchemaSpec,
  ToolDefinition,
  ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'
import { lossless } from './lossless.js'

/**
 * Define one Jira tool whose canonical value is always lossless JSON.
 *
 * @param options - the tool, exactly as `defineTool` would take it.
 * @returns the registry-ready definition, with its execute wrapped.
 */
export function defineJiraTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>,
): ToolDefinition {
  const execute = options.execute
  return defineTool<S, O>({
    ...options,
    async execute(args, exec) {
      return lossless(await execute(args, exec))
    },
  })
}
