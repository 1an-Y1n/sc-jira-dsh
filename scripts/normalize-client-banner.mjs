/**
 * Wrap client/client.js in `window.__ModuleLoader__.load({ id, factory })`
 * so the dsh host browser runtime can register the bundle for plugin id
 * `@ian/sc-jira`. The host loader calls `factory(require)` once per bundle,
 * supplying a per-bundle `require` that resolves externalized modules
 * (react, dsh-client-*) against the host's frozen module table.
 *
 * The factory body must set up its own `module`/`exports` globals (they are
 * not injected) — we prepend the CJS prelude before the tsdown-produced CJS
 * body. tsdown's body also adds `Object.defineProperty(exports,
 * Symbol.toStringTag, ...)`; we drop the duplicate.
 */
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

const PKG_ID = '@ian/sc-jira'
const SRC = resolve(process.cwd(), 'client', 'client.cjs')
const SRC_DTS = resolve(process.cwd(), 'client', 'client.d.cts')
const OUT = resolve(process.cwd(), 'client', 'client.js')

const raw = await readFile(SRC, 'utf8')

// Drop the trailing `Object.defineProperty(exports, Symbol.toStringTag, ...)`
// tsdown always emits at the top of CJS bundles — we set it in the prelude.
const inner = raw.replace(/^Object\.defineProperty\(exports, Symbol\.toStringTag.*\n/m, '')

const prelude = `\tvar module = { exports: {} };\n\tvar exports = module.exports;\n\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n`

const wrapped = `window.__ModuleLoader__.load({ id: "${PKG_ID}", factory: (require) => {\n${prelude}${inner}\nreturn module.exports;\n} });\n`

await writeFile(OUT, wrapped, 'utf8')
await unlink(SRC).catch(() => {})
await unlink(SRC_DTS).catch(() => {})
console.log(`[normalize-client-banner] wrapped ${SRC} → ${OUT} (${raw.length} → ${wrapped.length} bytes)`)
