import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { config } from './config.js'
import { resolveSession, resolveSessions } from './hub.js'
import { listJourneyFiles, runJourneyOnDevices } from './journeys.js'
import { errorMessage } from './session.js'
import { throwIfCancelled } from './steps.js'

const itemSchema = z.object({
  id: z.number().int(),
  item: z.string(),
  journeys: z.array(z.string()).default([]),
  /** Platforms (detectPlatform names) where the item is N/A; "all" for every platform. */
  na: z.array(z.string()).default([]),
  /** The item is not testable on this setup. */
  unable: z.boolean().default(false),
  /** Soft-step tags this row owns; with it set, other issues of a shared journey do not touch the row. */
  issueTags: z.array(z.string()).optional(),
  /** A FAIL here leaves the device in a state no later row can run from; those rows become UNABLE. */
  abortOnFail: z.boolean().default(false),
  comment: z.string().optional(),
})

const checklistSchema = z.object({
  name: z.string(),
  description: z.string(),
  vars: z.array(z.string()).default([]),
  items: z.array(itemSchema).min(1),
})

export type SanityChecklist = z.infer<typeof checklistSchema>
export type CellStatus = 'PASS' | 'FAIL' | 'WITH ISSUE' | 'N/A' | 'UNABLE' | 'NOT AUTOMATED'

export interface JourneyResult {
  name: string
  result: 'PASS' | 'FAIL' | 'WITH ISSUE' | 'UNABLE'
  completed?: string
  journeyMs?: number
  endedOn?: string | null
  failed?: {
    step: number
    key: string
    expected?: unknown
    focused?: string | null
    missingStorageKeys?: string[]
    error?: string
  }
  /** Per-step trace, kept only for journeys that did not pass. */
  trace?: unknown[]
  /** Result copied from an earlier row that ran the same journey. */
  reused?: boolean
  issueTags?: string[]
}

export interface SanityCell {
  status: CellStatus
  comment?: string
  journeys?: JourneyResult[]
}

export interface SanityReport {
  checklist: string
  startedAt: string
  totalMs: number
  devices: Record<string, { platform: string; reachable: boolean }>
  rows: Array<{ id: number; item: string; cells: Record<string, SanityCell>; comment?: string }>
}

export async function listChecklists(): Promise<string[]> {
  try {
    return (await readdir(config.sanityDir)).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
  } catch {
    return []
  }
}

export async function loadChecklist(name: string): Promise<SanityChecklist> {
  const file = path.join(config.sanityDir, `${name.replace(/\.json$/, '')}.json`)
  try {
    return checklistSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    throw new Error(`${file}: ${errorMessage(error)}`)
  }
}

/** Combine one item's journey results on one device into a cell. */
export function combineCell(results: JourneyResult[], ownedTags?: string[]): CellStatus {
  if (results.some((r) => r.result === 'UNABLE')) return 'UNABLE'
  if (results.some((r) => r.result === 'FAIL')) return 'FAIL'
  const owns = (r: JourneyResult) => ownedTags === undefined || (r.issueTags ?? []).some((t) => ownedTags.includes(t))
  if (results.some((r) => r.result === 'WITH ISSUE' && owns(r))) return 'WITH ISSUE'
  return 'PASS'
}

export function renderMarkdown(report: SanityReport): string {
  const names = Object.keys(report.devices)
  const header = ['#', 'Item', ...names.map((n) => `${n} (${report.devices[n].platform})`), 'Comments']
  const lines = [
    `# Sanity check | ${report.checklist}`,
    '',
    `Started ${report.startedAt}, ${Math.round(report.totalMs / 1000)} s.`,
    '',
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ]
  for (const row of report.rows) {
    const cells = names.map((n) => row.cells[n]?.status ?? '')
    const failures = names.flatMap((n) =>
      (row.cells[n]?.journeys ?? [])
        .filter((j) => j.failed)
        .map(
          (j) =>
            `${n}: ${j.name} step ${j.failed!.step} ${j.failed!.key} (${JSON.stringify(j.failed!.expected ?? {})}) on "${j.failed!.focused ?? ''}"`,
        ),
    )
    const comments = [row.comment, ...names.map((n) => row.cells[n]?.comment).filter(Boolean), ...failures].filter(
      Boolean,
    )
    lines.push(`| ${row.id} | ${row.item} | ${cells.join(' | ')} | ${[...new Set(comments)].join('; ')} |`)
  }
  const unreachable = names.filter((n) => !report.devices[n].reachable)
  if (unreachable.length > 0) lines.push('', `Unreachable devices: ${unreachable.join(', ')}.`)
  return lines.join('\n') + '\n'
}

interface SanityProgress {
  checklist: string
  startedAt: string
  devices: string[]
  current?: { row: number; item: string; journey: string; devices: string[]; startedAt: string }
  rows: Array<{ id: number; item: string; cells: Record<string, CellStatus> }>
  done: boolean
  files?: { json: string; markdown: string }
}

const progressFile = () => path.join(config.reportsDir, 'progress.json')

/** Live view of a run for anyone tailing reports/progress.json. */
async function writeProgress(progress: SanityProgress): Promise<void> {
  await mkdir(config.reportsDir, { recursive: true })
  await writeFile(progressFile(), JSON.stringify({ updatedAt: new Date().toISOString(), ...progress }, null, 2))
}

async function writeReport(report: SanityReport): Promise<{ json: string; markdown: string }> {
  await mkdir(config.reportsDir, { recursive: true })
  const base = path.join(config.reportsDir, `${report.startedAt.replace(/[:.]/g, '-')}-${report.checklist}`)
  await writeFile(`${base}.json`, JSON.stringify(report, null, 2))
  await writeFile(`${base}.md`, renderMarkdown(report))
  return { json: `${base}.json`, markdown: `${base}.md` }
}

const statusRows = (rows: SanityReport['rows']) =>
  rows.map((r) => ({
    id: r.id,
    item: r.item,
    cells: Object.fromEntries(Object.entries(r.cells).map(([d, c]) => [d, c.status])),
  }))

export interface SanityOptions {
  checklist: string
  devices: string[]
  vars?: Record<string, string>
  items?: number[]
  launch: 'auto' | 'always' | 'never'
  signal?: AbortSignal
}

/** Every item on every device: items in order, devices in lockstep per journey, reset between journeys. */
export async function runSanity(opts: SanityOptions) {
  const checklist = await loadChecklist(opts.checklist)
  const startedAt = new Date()
  const available = new Set((await listJourneyFiles()).map((f) => f.replace(/\.json$/, '')))
  const deviceInfo: SanityReport['devices'] = {}
  for (const name of opts.devices) {
    try {
      deviceInfo[name] = { platform: (await resolveSession(name)).info.platform, reachable: true }
    } catch {
      deviceInfo[name] = { platform: 'unknown', reachable: false }
    }
  }
  const rows: SanityReport['rows'] = []
  const progress = (current?: { row: number; item: string; journey: string; devices: string[] }) =>
    writeProgress({
      checklist: checklist.name,
      startedAt: startedAt.toISOString(),
      devices: opts.devices,
      ...(current ? { current: { ...current, startedAt: new Date().toISOString() } } : {}),
      rows: statusRows(rows),
      done: false,
    }).catch(() => undefined)
  const blockedBy: Record<string, number> = {}
  const earlier = new Map<string, Record<string, JourneyResult>>()
  for (const item of checklist.items) {
    if (opts.items && !opts.items.includes(item.id)) continue
    const cells: Record<string, SanityCell> = {}
    const todo = opts.devices.filter((d) => {
      if (item.na.includes('all') || item.na.includes(deviceInfo[d].platform)) {
        cells[d] = { status: 'N/A' }
        return false
      }
      if (item.unable) {
        cells[d] = { status: 'UNABLE' }
        return false
      }
      if (!deviceInfo[d].reachable) {
        cells[d] = { status: 'UNABLE', comment: 'device not reachable' }
        return false
      }
      return true
    })
    const missing = item.journeys.filter((j) => !available.has(j))
    if (item.journeys.length === 0 || missing.length > 0) {
      for (const d of todo)
        cells[d] = {
          status: 'NOT AUTOMATED',
          comment: missing.length > 0 ? `missing journey: ${missing.join(', ')}` : undefined,
        }
      rows.push({ id: item.id, item: item.item, cells, comment: item.comment })
      continue
    }
    const perDevice: Record<string, JourneyResult[]> = Object.fromEntries(todo.map((d) => [d, []]))
    for (const d of todo) {
      if (blockedBy[d] !== undefined)
        cells[d] = { status: 'UNABLE', comment: `blocked: row ${blockedBy[d]} failed and left the device unusable` }
    }
    const usedInRow = new Set<string>()
    for (const journeyName of item.journeys) {
      const active = todo.filter((d) => blockedBy[d] === undefined && !perDevice[d].some((r) => r.result !== 'PASS'))
      if (active.length === 0) break
      // A journey that already ran in an earlier row is reused, unless this row runs it twice on purpose.
      const cached = usedInRow.has(journeyName) ? undefined : earlier.get(journeyName)
      usedInRow.add(journeyName)
      const toRun = active.filter((d) => {
        const hit = cached?.[d]
        if (hit) perDevice[d].push({ ...hit, reused: true })
        return !hit
      })
      if (toRun.length === 0) continue
      const present: string[] = []
      for (const d of toRun) {
        try {
          await resolveSessions([d])
          present.push(d)
        } catch (error) {
          perDevice[d].push({ name: journeyName, result: 'UNABLE', endedOn: errorMessage(error) })
        }
      }
      if (present.length === 0) continue
      try {
        throwIfCancelled(opts.signal)
        await progress({ row: item.id, item: item.item, journey: journeyName, devices: present })
        const run = await runJourneyOnDevices(journeyName, opts.vars, present, {
          stopAllOnMismatch: false,
          launch: opts.launch,
          signal: opts.signal,
        })
        for (const d of present) {
          const sum = run.summary[d]
          const result: JourneyResult = sum
            ? {
                name: journeyName,
                result: sum.result,
                completed: sum.completed,
                journeyMs: sum.journeyMs,
                endedOn: sum.endedOn,
                ...(sum.failed ? { failed: sum.failed } : {}),
                ...(sum.issueTags ? { issueTags: sum.issueTags } : {}),
                ...(sum.result !== 'PASS' && run.devices[d] ? { trace: run.devices[d].trace } : {}),
              }
            : { name: journeyName, result: 'UNABLE' }
          perDevice[d].push(result)
          earlier.set(journeyName, { ...(earlier.get(journeyName) ?? {}), [d]: result })
        }
      } catch (error) {
        for (const d of present)
          perDevice[d].push({ name: journeyName, result: 'UNABLE', endedOn: errorMessage(error) })
      }
    }
    for (const d of todo) {
      if (blockedBy[d] !== undefined) continue
      const results = perDevice[d]
      const status = combineCell(results, item.issueTags)
      if (item.abortOnFail && (status === 'FAIL' || status === 'UNABLE')) blockedBy[d] = item.id
      const failed = results.find((r) => r.result !== 'PASS')
      cells[d] = {
        status,
        journeys: results,
        ...(failed
          ? { comment: `${failed.name}: ${failed.result}${failed.completed ? ` at ${failed.completed}` : ''}` }
          : {}),
      }
    }
    rows.push({ id: item.id, item: item.item, cells, comment: item.comment })
    await progress()
  }
  const report: SanityReport = {
    checklist: checklist.name,
    startedAt: startedAt.toISOString(),
    totalMs: Date.now() - startedAt.getTime(),
    devices: deviceInfo,
    rows,
  }
  const files = await writeReport(report)
  await writeProgress({
    checklist: checklist.name,
    startedAt: report.startedAt,
    devices: opts.devices,
    rows: statusRows(rows),
    done: true,
    files,
  }).catch(() => undefined)
  const matrix = Object.fromEntries(
    rows.map((r) => [`${r.id}. ${r.item}`, Object.fromEntries(Object.entries(r.cells).map(([d, c]) => [d, c.status]))]),
  )
  return { checklist: checklist.name, totalMs: report.totalMs, devices: deviceInfo, matrix, files, rows }
}
