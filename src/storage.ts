/**
 * sc-jira meta.json storage. schemaVersion 3 is the only accepted version.
 *
 * Layout: {tasksDir}/{KEY}/meta.json
 *   - one directory per bound Jira issue key
 *   - exactly one meta.json per directory
 *   - dshSessionId is immutable: rebind to different session throws
 */
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { MetaJsonV3 } from './types.js'

const SUPPORTED_SCHEMA = 3 as const

export interface WriteBindingInput {
  key: string
  sessionId: string
  issueSummary: MetaJsonV3['issueSummary']
}

export async function writeMetaWithBinding(
  tasksDir: string,
  input: WriteBindingInput,
): Promise<void> {
  const dir = join(tasksDir, input.key)
  await mkdir(dir, { recursive: true })
  const metaPath = join(dir, 'meta.json')

  let existing: MetaJsonV3 | null = null
  try {
    const raw = await readFile(metaPath, 'utf8')
    const parsed = JSON.parse(raw) as MetaJsonV3
    if (parsed.schemaVersion === SUPPORTED_SCHEMA) existing = parsed
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  if (existing && existing.dshSessionId !== input.sessionId) {
    throw new Error(
      `${input.key} already bound to another session (${existing.dshSessionId}); dshSessionId is immutable`,
    )
  }

  const next: MetaJsonV3 = existing
    ? { ...existing, issueSummary: input.issueSummary }
    : {
        schemaVersion: SUPPORTED_SCHEMA,
        key: input.key,
        status: 'active',
        startedAt: new Date().toISOString(),
        endedAt: null,
        dshSessionId: input.sessionId,
        issueSummary: input.issueSummary,
        logCount: 0,
        logBytes: 0,
        summaryCount: 0,
      }

  await writeFile(metaPath, JSON.stringify(next, null, 2))
}

export interface BindingResult {
  bound: boolean
  key?: string
  summary?: string
  sessionId: string
}

export async function readBindingBySession(
  tasksDir: string,
  sessionId: string,
): Promise<BindingResult> {
  let entries: Array<{ name: string; isDirectory: boolean }> = []
  try {
    const names = await readdir(tasksDir)
    const candidates = await Promise.all(
      names.map(async name => {
        try {
          await readFile(join(tasksDir, name, 'meta.json'), 'utf8')
          return { name, isDirectory: true }
        } catch {
          return null
        }
      }),
    )
    entries = candidates.filter((x): x is { name: string; isDirectory: boolean } => x !== null)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { bound: false, sessionId }
    throw err
  }

  for (const entry of entries) {
    if (!entry.isDirectory) continue
    try {
      const raw = await readFile(join(tasksDir, entry.name, 'meta.json'), 'utf8')
      const parsed = JSON.parse(raw) as MetaJsonV3
      if (parsed.schemaVersion !== SUPPORTED_SCHEMA) continue
      if (parsed.dshSessionId === sessionId) {
        return {
          bound: true,
          key: parsed.key,
          summary: parsed.issueSummary.summary,
          sessionId,
        }
      }
    } catch {
      continue
    }
  }

  return { bound: false, sessionId }
}

export async function listBindings(tasksDir: string): Promise<string[]> {
  try {
    const names = await readdir(tasksDir, { withFileTypes: true })
    const keys: string[] = []
    for (const e of names) {
      if (!e.isDirectory()) continue
      try {
        const raw = await readFile(join(tasksDir, e.name, 'meta.json'), 'utf8')
        const parsed = JSON.parse(raw) as MetaJsonV3
        if (parsed.schemaVersion === SUPPORTED_SCHEMA) keys.push(parsed.key)
      } catch {
        continue
      }
    }
    return keys.sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}