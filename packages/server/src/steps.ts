import { UNIVERSAL_KEYS } from '@tv-mcp/protocol'
import { z } from 'zod'

import {
  ARROW_KEYS,
  fileAppUrl,
  HIDDEN_PAGE_WARNING,
  goHome,
  pressAndSettle,
  scrubToEnd,
  typeOnKeyboard,
  WAIT_POLL_MS,
  waitForFocusedElement,
} from './actions.js'
import { loadProfile } from './config.js'
import { waitForFreshPage } from './hub.js'
import { errorMessage, sleep } from './session.js'

import type { AppProfile, DialogGuard, FocusSummary, UniversalKey } from '@tv-mcp/protocol'
import type { NamedSession } from './hub.js'
import type { DeviceSession } from './session.js'

const RESET_SETTLE_MS = 3000
// Focus often lands a beat after a page's url changes; give expectFocus a short grace poll.
const EXPECT_GRACE_MS = 1500

export const stepSchema = z.object({
  key: z
    .enum(UNIVERSAL_KEYS)
    .optional()
    .describe(
      'Remote key to press. Omit with typeText, or omit both for a verify-only step (waits/expectations only).',
    ),
  typeText: z
    .string()
    .optional()
    .describe(
      'Type this on the focused on-screen keyboard instead of pressing a key. ${VAR} placeholders are filled from run_journey vars or TVMCP_<VAR> env.',
    ),
  clearStorage: z
    .boolean()
    .optional()
    .describe('Instead of a key: wipe cookies/storage and reload, the first-launch state.'),
  navigate: z
    .string()
    .optional()
    .describe(
      'Instead of a key: load this url (a path such as "/" resolves against the app origin) and wait for the fresh page.',
    ),
  submitKey: z
    .string()
    .optional()
    .describe('With typeText: label of a keyboard key to press afterwards (e.g. "Next").'),
  times: z.number().int().min(1).max(50).default(1),
  holdMs: z.number().int().min(0).default(0),
  settleMs: z.number().int().min(0).optional(),
  waitUrl: z.string().optional().describe('After the step, poll until the url contains this.'),
  waitText: z.string().optional().describe('After the step, poll until the page text contains this.'),
  waitSelector: z.string().optional().describe('After the step, poll until this CSS selector matches.'),
  waitGone: z
    .string()
    .optional()
    .describe('After the step, poll until no visible element matches this CSS selector (a loading overlay has gone).'),
  waitVideo: z.boolean().optional().describe('After the step, poll until a <video> is playing with data.'),
  waitVideoNearEnd: z
    .number()
    .min(1)
    .optional()
    .describe('After the step, poll until a content-length <video> is playing with at most this many seconds left.'),
  waitAd: z
    .boolean()
    .optional()
    .describe('After the step, poll until an ad (short video, or the profile ad marker) plays.'),
  waitContent: z.boolean().optional().describe('After the step, poll until content (a content-length video) plays.'),
  waitVideoAdvance: z
    .number()
    .min(1)
    .optional()
    .describe('After the step, poll until the content position advanced this many seconds (device clock dwell).'),
  expectVideoDelta: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe('After the step, the content position must have moved by [min, max] seconds (seek checks).'),
  expectStorageKeys: z
    .array(z.string())
    .optional()
    .describe('After the step, every one of these localStorage keys or cookie names must exist.'),
  expectFocusChange: z
    .boolean()
    .optional()
    .describe('After the step, the focused element id must differ from before the step.'),
  scrubToEnd: z
    .number()
    .min(5)
    .max(600)
    .optional()
    .describe(
      'Instead of a key: wait for content to play, scrub forward until about this many seconds remain, then wait ' +
        'until playback is inside that window (waitMs caps the whole thing).',
    ),
  waitMs: z
    .number()
    .int()
    .min(100)
    .max(600_000)
    .optional()
    .describe('Timeout override for this step; otherwise the journey timeouts apply, scaled by the device.'),
  expectFocus: z.string().optional().describe('After the step (and any wait), focused label must contain this.'),
  expectUrl: z.string().optional().describe('After the step (and any wait), url must contain this.'),
  expectDialog: z
    .string()
    .optional()
    .describe('Name of a profile guard dialog this step expects to be up (typically because it dismisses it).'),
  ifFocus: z.string().optional().describe('Run only when the focused label contains this; otherwise skip.'),
  ifSelector: z.string().optional().describe('Run only when this CSS selector matches; otherwise skip.'),
  ifVideoPaused: z.boolean().optional().describe('Run only when a content-length video exists and is paused.'),
  untilFocus: z
    .string()
    .optional()
    .describe(
      'Press the key repeatedly (up to maxPresses) until the focused label contains this. Absorbs dropped keys and ' +
        'menus whose length varies. Implies expectFocus.',
    ),
  maxPresses: z.number().int().min(1).max(30).default(10).describe('Cap for untilFocus.'),
  soft: z
    .boolean()
    .default(false)
    .describe('A failed soft step is recorded as an issue but does not stop the device (sanity: WITH ISSUE).'),
  tag: z
    .string()
    .optional()
    .describe("Name for a soft step's issue, so sanity rows can claim only the issues they own."),
})
export type Step = z.infer<typeof stepSchema>

export interface Timeouts {
  step: number
  page: number
  content: number
}
export const DEFAULT_TIMEOUTS: Timeouts = { step: 15_000, page: 45_000, content: 240_000 }

export interface StepContext {
  intervalMs: number
  timeouts: Timeouts
  timeoutScale: number
  maxHoldMs?: number
  signal?: AbortSignal
}

/** Cancellation from the MCP client (a stopped background task) must stop device activity too. */
export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('cancelled by the client')
}

/** Only waits that can sit through an ad break get the (unscaled) content budget. */
function stepTimeout(step: Step, ctx: StepContext): number {
  const contentWait =
    step.waitVideoNearEnd !== undefined || step.waitAd || step.waitContent || step.scrubToEnd !== undefined
  const pageWait =
    step.waitVideo ||
    step.waitVideoAdvance !== undefined ||
    step.navigate !== undefined ||
    step.clearStorage ||
    step.waitUrl ||
    step.waitSelector ||
    step.waitGone ||
    step.waitText
  if (step.waitMs !== undefined) return Math.round(step.waitMs * ctx.timeoutScale)
  if (contentWait) return ctx.timeouts.content
  return Math.round((pageWait ? ctx.timeouts.page : ctx.timeouts.step) * ctx.timeoutScale)
}

export const stepLabel = (step: Step) =>
  step.key ??
  (step.typeText !== undefined
    ? 'type'
    : step.scrubToEnd !== undefined
      ? 'scrub'
      : step.navigate !== undefined
        ? 'navigate'
        : step.clearStorage
          ? 'clearStorage'
          : 'verify')

/** A step expects a guarded dialog when it names it, or one of its expectations names the selector or matches the hint. */
function stepExpects(step: Step, guard: DialogGuard): boolean {
  if (step.expectDialog === guard.name) return true
  const hint = guard.hint ? new RegExp(guard.hint, 'i') : null
  return [step.waitSelector, step.ifSelector, step.expectFocus, step.untilFocus, step.ifFocus].some(
    (v) => typeof v === 'string' && (v.includes(guard.selector) || (hint !== null && hint.test(v))),
  )
}

const guardUp = async (session: DeviceSession, guard: DialogGuard) =>
  (await session.condition({ selector: guard.selector })).matched.includes('selector')

/**
 * The first guarded dialog that is up although the step does not expect it. Guards with `dismissKeys` are closed
 * with those keys instead and reported in `dismissed`; one that stays up is returned like any other.
 */
async function unexpectedDialog(
  session: DeviceSession,
  step: Step,
  guards: DialogGuard[],
  intervalMs: number,
  dismissed: string[],
): Promise<string | null> {
  for (const guard of guards) {
    if (stepExpects(step, guard) || !(await guardUp(session, guard))) continue
    if (!guard.dismissKeys?.length) return guard.name
    for (const key of guard.dismissKeys) {
      if (!(await guardUp(session, guard))) break
      await pressAndSettle(session, key as UniversalKey, { times: 1, holdMs: 0, intervalMs })
      await sleep(intervalMs)
    }
    if (await guardUp(session, guard)) return guard.name
    dismissed.push(guard.name)
  }
  return null
}

const contentTime = (profile: AppProfile, s?: FocusSummary) =>
  s?.videos.find((v) => v.duration === null || v.duration >= profile.player.contentMinDurationS)?.currentTime ?? null

/** One step on one device: press (or press-until), wait, then check expectations. */
export async function runStep(session: DeviceSession, step: Step, ctx: StepContext) {
  const profile = await loadProfile()
  const intervalMs = ctx.intervalMs
  const timeoutMs = stepTimeout(step, ctx)
  const label = step.key ?? (step.typeText !== undefined ? `type:${step.typeText}` : stepLabel(step))
  const dismissed: string[] = []
  // Popups can also land mid-step (after a page load); those with dismissKeys are closed while waiting too.
  const popups = profile.guards.filter((g) => g.dismissKeys?.length)
  const interrupt = await unexpectedDialog(session, step, profile.guards, intervalMs, dismissed)
  if (interrupt) {
    const now = await session.focusSummary()
    return {
      ok: false,
      entry: {
        key: label,
        presses: 0,
        focused: now.focused,
        url: now.url,
        ok: false,
        expected: { noDialog: interrupt },
        error: `${interrupt} dialog appeared where no journey step expects it`,
        ...(dismissed.length ? { dismissed } : {}),
        ...(now.hidden ? { warning: HIDDEN_PAGE_WARNING } : {}),
      },
    }
  }
  const target = step.untilFocus ?? step.expectFocus
  const focusMatches = (l: string) => !target || l.toLowerCase().includes(target.toLowerCase())
  if (step.ifFocus || step.ifSelector || step.ifVideoPaused) {
    const now = await session.condition({
      selector: step.ifSelector,
      focusedLabel: step.ifFocus,
      videoPaused: step.ifVideoPaused,
    })
    const focusOk = !step.ifFocus || now.matched.includes('focusedLabel')
    const selectorOk = !step.ifSelector || now.matched.includes('selector')
    const pausedOk = !step.ifVideoPaused || now.matched.includes('videoPaused')
    if (!focusOk || !selectorOk || !pausedOk) {
      const reason = !focusOk
        ? `focus is not "${step.ifFocus}"`
        : !selectorOk
          ? `no match for ${step.ifSelector}`
          : 'video is not paused'
      return { ok: true, entry: { key: label, skipped: reason, focused: now.focused, url: now.url, ok: true } }
    }
  }

  const needBefore =
    step.expectVideoDelta !== undefined || step.expectFocusChange || step.waitVideoAdvance !== undefined
  const before = needBefore ? await session.focusSummary() : undefined
  let result: { after: FocusSummary; busyWaitMs?: number; busyTimedOut?: string }
  let presses = 0
  let scrub: Awaited<ReturnType<typeof scrubToEnd>> | undefined
  if (step.scrubToEnd !== undefined) {
    scrub = await scrubToEnd(session, profile, step.scrubToEnd, timeoutMs, ctx.maxHoldMs)
    result = { after: await session.focusSummary() }
    presses = scrub.presses
  } else if (step.clearStorage) {
    await session.clearStorage(true)
    await sleep(RESET_SETTLE_MS)
    await waitForFreshPage(session, timeoutMs)
    result = { after: await session.focusSummary() }
  } else if (step.navigate !== undefined) {
    if (step.navigate === '/') await goHome(session)
    else await session.navigate(fileAppUrl(new URL(step.navigate, session.info.url).href))
    await sleep(RESET_SETTLE_MS)
    await waitForFreshPage(session, timeoutMs)
    result = { after: await session.focusSummary() }
  } else if (step.typeText !== undefined) {
    const typed = await typeOnKeyboard(session, step.typeText, step.submitKey)
    result = { after: typed.after }
    presses = typed.trace.length
  } else if (!step.key) {
    if (step.settleMs) await sleep(step.settleMs)
    result = { after: await session.focusSummary() }
  } else if (step.untilFocus) {
    const key = step.key
    result = { after: await waitForFocusedElement(session, await session.focusSummary(), timeoutMs) }
    while (!focusMatches(result.after.focused?.label ?? '') && presses < step.maxPresses) {
      if (presses > 0) await sleep(intervalMs)
      result = await pressAndSettle(session, key, {
        times: 1,
        holdMs: step.holdMs,
        intervalMs,
        settleMs: step.settleMs ?? (ARROW_KEYS.has(key) ? timeoutMs : undefined),
      })
      result.after = await waitForFocusedElement(session, result.after, timeoutMs)
      presses++
    }
  } else {
    result = await pressAndSettle(session, step.key, {
      times: step.times,
      holdMs: step.holdMs,
      intervalMs,
      settleMs: step.settleMs,
    })
    presses = step.times
    if (target) result.after = await waitForFocusedElement(session, result.after, timeoutMs)
  }

  let waited: string[] | undefined
  let waitOk = true
  const hasWait = Boolean(
    step.waitUrl ||
    step.waitText ||
    step.waitSelector ||
    step.waitGone ||
    step.waitVideo ||
    step.waitVideoNearEnd !== undefined ||
    step.waitAd ||
    step.waitContent,
  )
  if (hasWait) {
    const deadline = Date.now() + timeoutMs
    let last = { matched: [] as string[] }
    while (Date.now() < deadline) {
      await unexpectedDialog(session, step, popups, intervalMs, dismissed)
      last = await session.condition({
        urlIncludes: step.waitUrl,
        text: step.waitText,
        selector: step.waitSelector,
        gone: step.waitGone,
        videoPlaying: step.waitVideo,
        videoNearEnd: step.waitVideoNearEnd,
        adPlaying: step.waitAd,
        contentPlaying: step.waitContent || step.waitAd,
      })
      if (last.matched.length > 0) break
      throwIfCancelled(ctx.signal)
      await sleep(WAIT_POLL_MS)
    }
    waited = last.matched
    waitOk = step.waitAd && !step.waitContent ? waited.includes('adPlaying') : waited.length > 0
    result.after = await session.focusSummary()
  }
  let videoAdvance: number | null = null
  if (step.waitVideoAdvance !== undefined) {
    const t0 = contentTime(profile, before)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      result.after = await session.focusSummary()
      const t1 = contentTime(profile, result.after)
      videoAdvance = t0 !== null && t1 !== null ? Math.round(t1 - t0) : null
      if (videoAdvance !== null && videoAdvance >= step.waitVideoAdvance) break
      throwIfCancelled(ctx.signal)
      if (Date.now() >= deadline) {
        waitOk = false
        break
      }
      await sleep(WAIT_POLL_MS)
    }
  }
  if (popups.length) {
    const closedBefore = dismissed.length
    await unexpectedDialog(session, step, popups, intervalMs, dismissed)
    if (dismissed.length > closedBefore) result.after = await session.focusSummary()
  }
  let focusOk = focusMatches(result.after.focused?.label ?? '')
  if (!focusOk && !step.untilFocus) {
    const graceDeadline = Date.now() + EXPECT_GRACE_MS
    while (!focusOk && Date.now() < graceDeadline) {
      await sleep(WAIT_POLL_MS)
      result.after = await session.focusSummary()
      focusOk = focusMatches(result.after.focused?.label ?? '')
    }
  }
  const urlOk = !step.expectUrl || result.after.url.includes(step.expectUrl)
  const scrubOk = !scrub || scrub.landed
  let videoDelta: number | null = null
  let deltaOk = true
  if (step.expectVideoDelta) {
    // The seek lands a moment after the press; give it a short grace poll.
    const [min, max] = step.expectVideoDelta
    const t0 = contentTime(profile, before)
    const graceDeadline = Date.now() + EXPECT_GRACE_MS * 2
    for (;;) {
      const t1 = contentTime(profile, result.after)
      videoDelta = t0 !== null && t1 !== null ? Math.round(t1 - t0) : null
      deltaOk = videoDelta !== null && videoDelta >= min && videoDelta <= max
      if (deltaOk || Date.now() >= graceDeadline) break
      await sleep(WAIT_POLL_MS)
      result.after = await session.focusSummary()
    }
  }
  const focusChangeOk = !step.expectFocusChange || (before?.focused?.id ?? null) !== (result.after.focused?.id ?? null)
  let missingKeys: string[] = []
  if (step.expectStorageKeys?.length) {
    const present = await session.storageKeys()
    missingKeys = step.expectStorageKeys.filter((k) => !present.includes(k))
  }
  const ok = waitOk && focusOk && urlOk && scrubOk && deltaOk && focusChangeOk && missingKeys.length === 0
  return {
    ok,
    entry: {
      key: label,
      presses,
      ...(scrub ? { scrub } : {}),
      ...(videoDelta !== null ? { videoDelta } : {}),
      ...(videoAdvance !== null ? { videoAdvance } : {}),
      ...(missingKeys.length > 0 ? { missingStorageKeys: missingKeys } : {}),
      ...(waited ? { waited } : {}),
      ...(dismissed.length ? { dismissed } : {}),
      ...(result.busyWaitMs ? { busyWaitMs: result.busyWaitMs } : {}),
      ...(result.busyTimedOut ? { busyTimedOut: result.busyTimedOut } : {}),
      ...(result.after.hidden ? { warning: HIDDEN_PAGE_WARNING } : {}),
      focused: result.after.focused,
      url: result.after.url,
      dialogs: result.after.dialogs,
      ok,
      ...(ok
        ? {}
        : {
            expected: {
              ...(hasWait && !waitOk
                ? {
                    wait: {
                      url: step.waitUrl,
                      text: step.waitText,
                      selector: step.waitSelector,
                      gone: step.waitGone,
                      video: step.waitVideo,
                      videoNearEnd: step.waitVideoNearEnd,
                    },
                  }
                : {}),
              ...(step.waitVideoAdvance !== undefined && !waitOk ? { videoAdvance: step.waitVideoAdvance } : {}),
              ...(target ? { focus: target } : {}),
              ...(step.expectUrl ? { url: step.expectUrl } : {}),
              ...(step.expectVideoDelta ? { videoDelta: step.expectVideoDelta } : {}),
              ...(step.expectFocusChange ? { focusChange: true } : {}),
            },
          }),
    },
  }
}

export interface LockstepOptions {
  intervalMs: number
  stopOnMismatch: boolean
  stopAllOnMismatch: boolean
  signal?: AbortSignal
  timeouts?: Timeouts
  timeoutScale?: Record<string, number>
  maxHoldMs?: Record<string, number | undefined>
}

export interface DeviceRun {
  ok: boolean
  issues: number
  issueTags: string[]
  completed: number
  of: number
  trace: unknown[]
}

export interface LockstepResult {
  ok: boolean
  totalMs: number
  devices: Record<string, DeviceRun>
  stepTimings: Array<{ step: number; key: string; ms: number; perDevice: Record<string, number> }>
}

/** Run one plan on every session with a barrier after each step. */
export async function runLockstep(
  sessions: NamedSession[],
  steps: Step[],
  opts: LockstepOptions,
): Promise<LockstepResult> {
  const traces = new Map(
    sessions.map((s) => [
      s.name,
      { ok: true, issues: 0, issueTags: [] as string[], completed: 0, stopped: false, trace: [] as unknown[] },
    ]),
  )
  const stepTimings: LockstepResult['stepTimings'] = []
  const startedAt = Date.now()
  for (const [index, step] of steps.entries()) {
    throwIfCancelled(opts.signal)
    const active = sessions.filter((s) => !traces.get(s.name)!.stopped)
    if (active.length === 0) break
    const stepStart = Date.now()
    const perDevice: Record<string, number> = {}
    await Promise.all(
      active.map(async ({ name, session }) => {
        const t0 = Date.now()
        const state = traces.get(name)!
        try {
          const outcome = await runStep(session, step, {
            intervalMs: opts.intervalMs,
            timeouts: opts.timeouts ?? DEFAULT_TIMEOUTS,
            timeoutScale: opts.timeoutScale?.[name] ?? 1,
            maxHoldMs: opts.maxHoldMs?.[name],
            signal: opts.signal,
          })
          state.completed++
          if (!outcome.ok && step.soft) {
            state.issues++
            state.issueTags.push(step.tag ?? stepLabel(step))
            state.trace.push({ ...outcome.entry, soft: true })
          } else {
            state.trace.push(outcome.entry)
            if (!outcome.ok) {
              state.ok = false
              if (opts.stopOnMismatch) state.stopped = true
            }
          }
        } catch (error) {
          state.ok = false
          state.stopped = true
          state.trace.push({ key: stepLabel(step), ok: false, error: errorMessage(error) })
        }
        perDevice[name] = Date.now() - t0
      }),
    )
    stepTimings.push({ step: index + 1, key: stepLabel(step), ms: Date.now() - stepStart, perDevice })
    if (opts.stopAllOnMismatch && [...traces.values()].some((t) => !t.ok)) break
    await sleep(opts.intervalMs)
  }
  const devices = Object.fromEntries(
    [...traces.entries()].map(([name, t]) => [
      name,
      { ok: t.ok, issues: t.issues, issueTags: t.issueTags, completed: t.completed, of: steps.length, trace: t.trace },
    ]),
  )
  return { ok: Object.values(devices).every((d) => d.ok), totalMs: Date.now() - startedAt, devices, stepTimings }
}

type FailedStep = {
  step: number
  key: string
  expected?: unknown
  focused?: string | null
  missingStorageKeys?: string[]
  error?: string
}

/** The last trace entry of a failed run, reduced to what explains the failure. */
export function failedStep(trace: unknown[]): FailedStep | undefined {
  const last = trace[trace.length - 1] as
    | {
        key?: string
        expected?: unknown
        focused?: { label?: string } | null
        missingStorageKeys?: string[]
        error?: string
      }
    | undefined
  if (!last) return undefined
  return {
    step: trace.length,
    key: last.key ?? '',
    expected: last.expected,
    focused: last.focused?.label ?? null,
    ...(last.missingStorageKeys ? { missingStorageKeys: last.missingStorageKeys } : {}),
    ...(last.error ? { error: last.error } : {}),
  }
}
