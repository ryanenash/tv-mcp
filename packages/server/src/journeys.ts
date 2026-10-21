import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { goHome, waitForCondition } from './actions.js'
import { config, loadProfile } from './config.js'
import { loadDevices } from './devices.js'
import { ensureLaunched, RESOLVE_RETRY_MS, resolveSessions, waitForFreshPage } from './hub.js'
import { errorMessage, sleep } from './session.js'
import { DEFAULT_TIMEOUTS, failedStep, runLockstep, stepSchema } from './steps.js'

import type { NamedSession } from './hub.js'
import type { Step, Timeouts } from './steps.js'

const RESET_SETTLE_MS = 3000

const timeoutsSchema = z.object({
  step: z.number().int().min(1000).default(DEFAULT_TIMEOUTS.step),
  page: z.number().int().min(1000).default(DEFAULT_TIMEOUTS.page),
  content: z.number().int().min(1000).default(DEFAULT_TIMEOUTS.content),
})

const startSchema = z.object({
  /** Reload each device at its app root before starting. */
  reset: z.boolean().default(true),
  /** Ready when this matches; defaults to the profile's startSelector. */
  waitSelector: z.string().optional(),
  waitMs: z.number().int().min(1000).max(120000).optional(),
})

const journeySchema = z.object({
  name: z.string(),
  description: z.string(),
  start: startSchema.default({ reset: true }),
  intervalMs: z.number().int().min(0).default(300),
  timeouts: timeoutsSchema.default(DEFAULT_TIMEOUTS),
  steps: z.array(stepSchema).min(1).max(60),
  notes: z.array(z.string()).optional(),
})

export type Journey = z.infer<typeof journeySchema> & { steps: Step[]; timeouts: Timeouts }

export async function listJourneyFiles(): Promise<string[]> {
  try {
    return (await readdir(config.journeysDir)).filter((f) => f.endsWith('.json')).sort()
  } catch {
    return []
  }
}

export async function loadJourney(name: string): Promise<Journey> {
  const file = path.join(config.journeysDir, `${name.replace(/\.json$/, '')}.json`)
  try {
    return journeySchema.parse(JSON.parse(await readFile(file, 'utf8'))) as Journey
  } catch (error) {
    throw new Error(`${file}: ${errorMessage(error)}`)
  }
}

export async function loadAllJourneys(): Promise<Journey[]> {
  return Promise.all((await listJourneyFiles()).map((n) => loadJourney(n)))
}

export interface JourneyRunOptions {
  reset?: boolean
  stopAllOnMismatch: boolean
  signal?: AbortSignal
  launch: 'auto' | 'always' | 'never'
}

export interface DeviceSummary {
  result: 'PASS' | 'FAIL' | 'WITH ISSUE' | 'UNABLE'
  completed: string
  issues: number
  issueTags?: string[]
  journeyMs: number
  resetMs?: number
  endedOn: string | null
  failed?: ReturnType<typeof failedStep>
}

function fillVars(journey: Journey, vars?: Record<string, string>) {
  const fill = (value: string | undefined) =>
    value?.replace(/\$\{(\w+)\}/g, (_m, key: string) => {
      const v = vars?.[key] ?? process.env[`TVMCP_${key}`]
      if (v === undefined) throw new Error(`journey needs var ${key}: pass vars.${key} or set TVMCP_${key}`)
      return v
    })
  journey.steps = journey.steps.map((st) => ({
    ...st,
    typeText: fill(st.typeText),
    untilFocus: fill(st.untilFocus),
    expectFocus: fill(st.expectFocus),
    waitText: fill(st.waitText),
    navigate: fill(st.navigate),
  }))
}

/** Fill vars, launch/reset devices, run the steps in lockstep. Shared by run_journey and run_sanity. */
export async function runJourneyOnDevices(
  name: string,
  vars: Record<string, string> | undefined,
  selectors: Array<string | undefined>,
  opts: JourneyRunOptions,
) {
  const journey = await loadJourney(name)
  fillVars(journey, vars)
  const profile = await loadProfile()
  const launched = await ensureLaunched(selectors, opts.launch)
  const dropped: Record<string, string> = {}
  const resolveEach = async (wanted: Array<string | undefined>, retryMs: number) => {
    const out: NamedSession[] = []
    await Promise.all(
      wanted.map(async (selector) => {
        try {
          out.push((await resolveSessions([selector], retryMs))[0])
        } catch (error) {
          dropped[selector ?? 'default'] = errorMessage(error)
        }
      }),
    )
    return out
  }
  let sessions = await resolveEach(selectors, RESOLVE_RETRY_MS)
  const startedAt = Date.now()
  const resetMs: Record<string, number> = {}
  const startTimeout = journey.start.waitMs ?? journey.timeouts.page
  const startSelector = journey.start.waitSelector ?? profile.startSelector
  if (opts.reset ?? journey.start.reset) {
    await Promise.all(
      sessions.map(async ({ name: n, session }) => {
        const t0 = Date.now()
        try {
          try {
            await goHome(session)
          } catch (error) {
            console.error(`[tv-mcp] reset ${n}: ${errorMessage(error)}; reconnecting once`)
            session.stale = true
            await session.connect()
            await goHome(session)
          }
          await sleep(RESET_SETTLE_MS)
          await waitForFreshPage(session, startTimeout)
          const guardSelectors = profile.guards.map((g) => g.selector)
          const readySelector = [startSelector, ...guardSelectors].filter(Boolean).join(', ')
          if (readySelector) {
            const ready = await waitForCondition(session, { selector: readySelector }, startTimeout)
            for (const guard of profile.guards) {
              if ((await session.condition({ selector: guard.selector })).matched.includes('selector'))
                throw new Error(
                  `${n}: ${guard.name} dialog is up after reset${guard.storageKey ? ` (${guard.storageKey} not persisted from an earlier dismissal)` : ''}`,
                )
            }
            if (!ready) throw new Error(`${n}: start condition "${startSelector}" not met after reset`)
          }
          // Content can render before the focus engine places focus; keys pressed in that gap are dropped.
          const deadline = Date.now() + startTimeout
          let focused = false
          while (!focused && Date.now() < deadline) {
            focused = Boolean((await session.focusSummary().catch(() => null))?.focused)
            if (!focused) await sleep(250)
          }
          if (!focused) throw new Error(`${n}: no focused element after reset`)
          resetMs[n] = Date.now() - t0
        } catch (error) {
          dropped[n] = errorMessage(error)
        }
      }),
    )
    // Sessions may have reconnected; re-resolve by the same selectors.
    sessions = await resolveEach(
      selectors.filter((sel) => !((sel ?? 'default') in dropped)),
      startTimeout,
    )
  }
  const registry = await loadDevices()
  const run = await runLockstep(sessions, journey.steps, {
    intervalMs: journey.intervalMs,
    stopOnMismatch: true,
    stopAllOnMismatch: opts.stopAllOnMismatch,
    timeouts: journey.timeouts,
    timeoutScale: Object.fromEntries(sessions.map((x) => [x.name, registry[x.name]?.timeoutScale ?? 1])),
    maxHoldMs: Object.fromEntries(sessions.map((x) => [x.name, registry[x.name]?.maxHoldMs])),
    signal: opts.signal,
  })
  const slowest = [...run.stepTimings].sort((a, b) => b.ms - a.ms)[0]
  const summary: Record<string, DeviceSummary> = {}
  for (const [n, message] of Object.entries(dropped)) {
    summary[n] = { result: 'UNABLE', completed: `0/${journey.steps.length}`, issues: 0, journeyMs: 0, endedOn: message }
  }
  for (const [n, d] of Object.entries(run.devices)) {
    summary[n] = {
      result: !d.ok ? 'FAIL' : d.issues > 0 ? 'WITH ISSUE' : 'PASS',
      completed: `${d.completed}/${d.of}`,
      issues: d.issues,
      ...(d.issueTags.length > 0 ? { issueTags: d.issueTags } : {}),
      journeyMs: run.stepTimings.reduce((acc, st) => acc + (st.perDevice[n] ?? 0), 0),
      ...(resetMs[n] !== undefined ? { resetMs: resetMs[n] } : {}),
      endedOn: (d.trace[d.trace.length - 1] as { focused?: { label?: string } } | undefined)?.focused?.label ?? null,
      ...(d.ok ? {} : { failed: failedStep(d.trace) }),
    }
  }
  return {
    journey: journey.name,
    ok: run.ok && Object.keys(dropped).length === 0,
    totalMs: Date.now() - startedAt,
    journeyMs: run.totalMs,
    slowestStep: slowest ? { step: slowest.step, key: slowest.key, ms: slowest.ms } : null,
    ...(Object.keys(launched).length > 0 ? { launched } : {}),
    summary,
    stepTimings: run.stepTimings,
    devices: run.devices,
  }
}
