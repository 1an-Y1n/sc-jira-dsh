/**
 * Lossless JSON for tool results.
 *
 * DSH snapshots a tool's canonical value as JSON before the model ever sees
 * it, and refuses a value JSON cannot carry. `undefined` has no JSON form:
 * a property set to `undefined` makes the whole call fail with "value is not
 * lossless JSON", and the model receives an error instead of the answer it
 * asked for.
 *
 * That failure is silent from the plugin's side — the tool ran, the work
 * was done, and the result was thrown away on the way out. An absent field
 * is therefore OMITTED, never set to `undefined`.
 *
 * This helper makes that mechanical: it drops the undefined-valued
 * properties of a plain object, and of the plain objects inside arrays.
 * Everything else — strings, numbers, booleans, null, class instances — is
 * left exactly as it was.
 */

/** Whether a value is a plain object (not an array, not a class instance). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Copy one value without its undefined-valued properties.
 *
 * An array element that is `undefined` becomes `null`, which is what JSON
 * would have made of it anyway.
 */
function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => (item === undefined ? null : strip(item)))
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    out[key] = strip(item)
  }
  return out
}

/**
 * Make a tool's canonical value lossless JSON.
 *
 * @param value - the value a tool is about to return.
 * @returns the same value, minus every undefined-valued property.
 */
export function lossless<T>(value: T): T {
  return strip(value) as T
}
