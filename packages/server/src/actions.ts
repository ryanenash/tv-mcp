import { loadProfile } from './config.js'
import { changed, sleep } from './session.js'

import type {
  AppProfile,
  Condition,
  FocusSummary,
  KeyboardKey,
  KeyboardLayout,
  PlayerState,
  UniversalKey,
} from '@tv-mcp/protocol'
import type { DeviceSession } from './session.js'

// Many TV input layers throttle repeats at ~200 ms; menus that load a page on dwell need presses faster than that.
export const DEFAULT_KEY_INTERVAL_MS = 250
const SETTLE_AFTER_CHANGE_MS = 120
export const DEFAULT_SETTLE_MS = 800
// Ok/Back usually trigger a page load, which takes seconds on device.
export const NAVIGATION_SETTLE_MS = 4000
export const WAIT_POLL_MS = 250
const TYPE_MAX_ATTEMPTS_PER_CHAR = 3
const LAYER_SWITCH_SETTLE_MS = 250

export const ARROW_KEYS = new Set<string>(['Up', 'Down', 'Left', 'Right'])
// A splash that outlives this is a finding in itself; press anyway and report it.
export const BUSY_WAIT_MS = Number(process.env.TVMCP_BUSY_WAIT_MS ?? 60_000)

export const HIDDEN_PAGE_WARNING =
  'the page is hidden (window minimised or covered, or a background tab): the browser pauses rendering and ' +
  'throttles timers, so the app may ignore keys and a viewer sees nothing. Keep the window visible, or launch ' +
  'Chrome with --disable-backgrounding-occluded-windows --disable-renderer-backgrounding ' +
  '--disable-background-timer-throttling.'

/** Wait while the profile's loading overlay is on screen. Returns how long it waited and whether it cleared. */
export async function waitUntilIdle(session: DeviceSession, capMs = BUSY_WAIT_MS) {
  const selector = (await loadProfile()).busySelector
  if (!selector) return { waitedMs: 0, idle: true }
  const started = Date.now()
  for (;;) {
    if ((await session.condition({ gone: selector })).matched.includes('gone'))
      return { waitedMs: Date.now() - started, idle: true }
    if (Date.now() - started >= capMs) return { waitedMs: Date.now() - started, idle: false }
    await sleep(WAIT_POLL_MS)
  }
}

export interface PressOptions {
  times: number
  intervalMs: number
  holdMs: number
  settleMs?: number
}

const settleFor = (key: string, settleMs?: number) =>
  settleMs ?? (key === 'Ok' || key === 'Back' ? NAVIGATION_SETTLE_MS : DEFAULT_SETTLE_MS)

/** Press a key, then return as soon as focus or url changes (or the settle budget passes). */
export async function pressAndSettle(session: DeviceSession, key: UniversalKey, opts: PressOptions) {
  let via = ''
  let before: { focusId: string | null; url: string } | undefined
  const busy = await waitUntilIdle(session)
  for (let i = 0; i < opts.times; i++) {
    const result = await session.press(key, opts.holdMs)
    via = result.via
    before = before ?? result.before
    if (opts.holdMs > 0) await sleep(opts.holdMs)
    if (i < opts.times - 1) await sleep(opts.intervalMs)
  }
  const cap = settleFor(key, opts.settleMs)
  let after = await session.waitForChange(before!, cap)
  if (ARROW_KEYS.has(key)) {
    const deadline = Date.now() + cap
    while ((after.focused?.id ?? null) === (before!.focusId ?? null) && Date.now() < deadline) {
      await sleep(WAIT_POLL_MS)
      after = await session.focusSummary()
    }
  }
  const didChange = changed(before!, after)
  if (didChange) {
    await sleep(SETTLE_AFTER_CHANGE_MS)
    after = await session.focusSummary()
  }
  return {
    pressed: key,
    times: opts.times,
    via,
    changed: didChange,
    after,
    ...(busy.waitedMs > 0 ? { busyWaitMs: busy.waitedMs } : {}),
    ...(busy.idle ? {} : { busyTimedOut: `loading overlay still up after ${busy.waitedMs}ms; pressed anyway` }),
    ...(after.hidden ? { warning: HIDDEN_PAGE_WARNING } : {}),
  }
}

/**
 * A packaged (file://) app only loads its exported files, but client-side routers write urls like
 * `file:///?page=…` and `file:///player?…`; loading those leaves the package. Map them onto real files.
 */
export function fileAppUrl(href: string): string {
  const url = new URL(href)
  if (url.protocol !== 'file:' || url.pathname.endsWith('.html')) return href
  url.pathname = url.pathname === '/' ? '/index.html' : `${url.pathname.replace(/\/$/, '')}.html`
  return url.href
}

const FILE_APP_HOME_SCRIPT =
  "(function () { history.replaceState(null, '', 'index.html'); setTimeout(function () { location.reload() }, 50); return 'reloading' })()"

/** Hosted apps load their origin root; a packaged file:// app reloads in place at index.html. */
export async function goHome(session: DeviceSession): Promise<void> {
  const url = new URL(session.info.url)
  if (url.protocol === 'file:') {
    await session.evaluate(FILE_APP_HOME_SCRIPT)
    session.stale = true
    return
  }
  await session.navigate(`${url.origin}/`)
}

/** A page transition briefly leaves nothing focused; a label check must not read that gap. */
export async function waitForFocusedElement(session: DeviceSession, summary: FocusSummary, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  let current = summary
  while (!current.focused && Date.now() < deadline) {
    await sleep(WAIT_POLL_MS)
    current = await session.focusSummary()
  }
  return current
}

/** Poll a condition, surviving channel drops while a page settles. */
export async function waitForCondition(session: DeviceSession, condition: Condition, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (!session.connected) await session.connect()
      const c = await session.condition(condition)
      if (c.matched.length > 0) return true
    } catch {
      session.stale = true
    }
    await sleep(WAIT_POLL_MS)
  }
  return false
}

// ── On-screen keyboard ──────────────────────────────────────────────────────────────────────────────

const SPECIAL_LABELS: Record<string, RegExp> = {
  ' ': /^(space|spacebar)$/i,
  '\b': /^(delete|backspace|del)$/i,
}
const LAYER_TOGGLE = /uppercase|lowercase|symbols|numbers|^(shift|caps|abc|123|#\+=|\.\?123|more)$/i

function layerFor(char: string): RegExp {
  if (/[A-Z]/.test(char)) return /upper|shift|caps|^ABC$/i
  if (/[a-z]/.test(char)) return /lower|small|^abc$/i
  return /symbol|number|123|#\+=/i
}

/** The character a key types, from labels like "a", "Capital A" or "Letter b". */
function keyChar(label: string): string | null {
  if (label.length === 1) return label
  const capital = /^(capital|uppercase)\s+(\S)$/i.exec(label)
  if (capital) return capital[2].toUpperCase()
  const small = /^(lowercase|small|letter)\s+(\S)$/i.exec(label)
  if (small) return small[2].toLowerCase()
  return null
}

function findKey(keys: KeyboardKey[], char: string): KeyboardKey | undefined {
  const special = SPECIAL_LABELS[char]
  if (special) return keys.find((k) => special.test(k.label))
  const exact = keys.find((k) => keyChar(k.label) === char)
  if (exact) return exact
  // Keyboards with a case/symbol layer must switch layer; only case-less keyboards may match loosely.
  if (keys.some((k) => LAYER_TOGGLE.test(k.label))) return undefined
  return keys.find((k) => k.label.toLowerCase() === char.toLowerCase())
}

/** Vertical presses to reach the target's row on a grid-aligned keyboard. */
function verticalMoves(keys: KeyboardKey[], from: KeyboardKey, to: KeyboardKey) {
  const rows = Array.from(new Set(keys.map((k) => k.y))).sort((a, b) => a - b)
  const dr = rows.indexOf(to.y) - rows.indexOf(from.y)
  return dr === 0 ? [] : [{ key: (dr > 0 ? 'Down' : 'Up') as UniversalKey, times: Math.abs(dr) }]
}

function horizontalMoves(keys: KeyboardKey[], from: KeyboardKey, to: KeyboardKey) {
  const row = keys.filter((k) => k.y === to.y).sort((a, b) => a.x - b.x)
  const fromIdx = row.findIndex((k) => k.id === from.id)
  const toIdx = row.findIndex((k) => k.id === to.id)
  if (fromIdx === -1) {
    const between = row.filter((k) => (to.x > from.x ? k.x > from.x && k.x <= to.x : k.x < from.x && k.x >= to.x))
    return between.length ? [{ key: (to.x > from.x ? 'Right' : 'Left') as UniversalKey, times: between.length }] : []
  }
  const dc = toIdx - fromIdx
  return dc === 0 ? [] : [{ key: (dc > 0 ? 'Right' : 'Left') as UniversalKey, times: Math.abs(dc) }]
}

/** Type on the focused on-screen keyboard: read the grid, move with arrows, Ok per char, switch layers. */
export async function typeOnKeyboard(session: DeviceSession, text: string, submitKey?: string) {
  const trace: string[] = []
  const fast = { times: 1, intervalMs: DEFAULT_KEY_INTERVAL_MS, holdMs: 0, settleMs: 500 }
  const readLayout = () => session.keyboardLayout()
  const locate = (layout: KeyboardLayout, target: string, special: boolean) =>
    special ? layout.keys.find((k) => k.label.toLowerCase() === target.toLowerCase()) : findKey(layout.keys, target)
  const pressTo = async (target: string, special = false) => {
    for (let attempt = 1; attempt <= TYPE_MAX_ATTEMPTS_PER_CHAR; attempt++) {
      let layout = await readLayout()
      let focused = layout.keys.find((k) => k.focused)
      if (!focused) throw new Error(`focus is not on the keyboard (section ${layout.section})`)
      let to = locate(layout, target, special)
      if (!to) {
        const wanted = layerFor(target)
        const toggle = layout.keys.find((k) => LAYER_TOGGLE.test(k.label) && wanted.test(k.label))
        if (!toggle) throw new Error(`no key for "${target}" and no matching layer toggle on this keyboard`)
        trace.push(`layer:${toggle.label}`)
        await pressTo(toggle.label, true)
        await sleep(LAYER_SWITCH_SETTLE_MS)
        layout = await readLayout()
        focused = layout.keys.find((k) => k.focused)!
        to = locate(layout, target, special)
        if (!to) throw new Error(`no key for "${target}" after switching layer`)
      }
      for (const move of verticalMoves(layout.keys, focused, to)) {
        await pressAndSettle(session, move.key, { ...fast, times: move.times })
      }
      layout = await readLayout()
      focused = layout.keys.find((k) => k.focused)!
      to = layout.keys.find((k) => k.id === to!.id) ?? to
      for (const move of horizontalMoves(layout.keys, focused, to)) {
        await pressAndSettle(session, move.key, { ...fast, times: move.times })
      }
      layout = await readLayout()
      focused = layout.keys.find((k) => k.focused)!
      if (focused.id === to.id) {
        await pressAndSettle(session, 'Ok', { ...fast, settleMs: 300 })
        trace.push(`${target === ' ' ? 'space' : target}✓`)
        return
      }
      trace.push(`${target}↻ landed on ${focused.label}`)
    }
    throw new Error(`could not reach key "${target}" after ${TYPE_MAX_ATTEMPTS_PER_CHAR} attempts`)
  }
  for (const char of text) await pressTo(char)
  if (submitKey) await pressTo(submitKey, true)
  const layout = await readLayout().catch(() => null)
  const after = await session.focusSummary()
  return { typed: text, trace, inputValues: layout?.inputValues ?? [], after }
}

// ── Scrub to end ────────────────────────────────────────────────────────────────────────────────────

// 250 ms keeps relay traffic light on slow devices; at 60 s/s that is 15 s of position per poll.
const SCRUB_POLL_MS = 250
const HOLD_REPEAT_MS = 100
// Holding Right usually scrubs with escalating speed and the release commits the seek. Release latency at top
// speed overshoots by tens of seconds, so the hold aims well above the window, taps close the gap, and natural
// playback carries the position in.
const SCRUB_HOLD_RELEASE_MARGIN_S = 110
const SCRUB_TAP_SAFETY_S = 4
const SCRUB_TAP_SETTLE_MS = 2500
// Gap between presses inside the player (slow boxes drop keys sent in bursts).
const SCRUB_KEY_GAP_MS = 400
// How long a tap's seek may take to land before the next reading.
const SCRUB_TAP_LAND_MS = 6000

/** Scrub forward to within `remainTarget` seconds of the end, then let playback carry it inside the window. */
export async function scrubToEnd(
  session: DeviceSession,
  profile: AppProfile,
  remainTarget: number,
  waitMs: number,
  maxHoldMs?: number,
) {
  const t0 = Date.now()
  const deadline = t0 + waitMs
  const minDuration = profile.player.contentMinDurationS
  const tapS = profile.player.seekStepS
  const state = () => session.playerState()
  let presses = 0
  const tap = async (key: UniversalKey) => {
    await session.press(key, 0)
    presses++
    await sleep(SCRUB_KEY_GAP_MS)
  }
  const isContent = (st: PlayerState) => Boolean(st.video?.duration && st.video.duration >= minDuration)
  const trace: Array<Record<string, unknown>> = []
  const mark = (event: string, extra: Record<string, unknown> = {}) =>
    trace.push({ t: Date.now() - t0, event, ...extra })

  /** An autoplay overlay near the end would leave the asset early; dismiss it once with the profile's keys. */
  let overlayHandled = false
  const dismissEndOverlay = async (): Promise<boolean> => {
    const overlay = profile.player.endOverlay
    if (!overlay || overlayHandled) return false
    if (!(await session.condition({ selector: overlay.selector })).matched.length) return false
    for (const key of overlay.keys) await tap(key as UniversalKey)
    overlayHandled = true
    mark('end-overlay-dismissed')
    await sleep(SCRUB_TAP_SETTLE_MS)
    return true
  }
  /** Content (not an ad) playing; ads are short videos on the same element. */
  const waitContent = async (): Promise<PlayerState> => {
    let st = await state()
    while (!(isContent(st) && !st.video!.paused)) {
      if (Date.now() > deadline) throw new Error(`no content video playing after ${waitMs}ms (ad break or stalled)`)
      await sleep(500)
      st = await state()
    }
    return st
  }

  let st = await waitContent()
  const duration = st.video!.duration!
  const contentWaitMs = Date.now() - t0
  const startAt = st.video!.currentTime
  let remaining = duration - startAt
  let inWindowSeen = false
  const snap = (s: PlayerState) => ({
    cur: s.video ? Math.round(s.video.currentTime) : null,
    seek: s.seekTime === null ? null : Math.round(s.seekTime),
    paused: s.video?.paused ?? null,
    dur: s.video?.duration ? Math.round(s.video.duration) : null,
  })
  // The asset can end (and autoplay the next) while we work; a different content duration means new media.
  const mediaChanged = (s: PlayerState) => isContent(s) && Math.abs(s.video!.duration! - duration) > 2
  const note = (s: PlayerState) => {
    if (s.video && duration - s.video.currentTime <= remainTarget) inWindowSeen = true
  }
  const finish = async (landed: boolean, phase: string, extra: Record<string, unknown> = {}) => {
    const after = await state()
    const sameMedia = !mediaChanged(after)
    return {
      landed,
      phase,
      duration: Math.round(duration),
      startAt: Math.round(startAt),
      contentWaitMs,
      remainingNow: after.video && sameMedia ? Math.round(duration - after.video.currentTime) : null,
      playing: Boolean(after.video && !after.video.paused),
      nextMediaStarted: !sameMedia,
      presses,
      ms: Date.now() - t0,
      ...extra,
      trace,
    }
  }

  // Phase 1: hold Right until the seek position is a safe margin above the window, then release. Devices with
  // maxHoldMs get pulsed holds (release, settle, hold again) instead of one long escalating hold.
  let heldMs = 0
  let holds = 0
  while (remaining > remainTarget + SCRUB_HOLD_RELEASE_MARGIN_S + tapS) {
    if (Date.now() >= deadline) throw new Error(`hold did not bring the position near the end within ${waitMs}ms`)
    const holdStart = Date.now()
    mark('hold', snap(st))
    await session.holdKey('Right', HOLD_REPEAT_MS)
    presses++
    holds++
    try {
      while (Date.now() < deadline) {
        await sleep(SCRUB_POLL_MS)
        st = await state()
        if (mediaChanged(st)) break
        const seek = st.seekTime ?? st.video?.currentTime ?? startAt
        remaining = duration - seek
        if (remaining <= remainTarget + SCRUB_HOLD_RELEASE_MARGIN_S) break
        if (maxHoldMs !== undefined && Date.now() - holdStart >= maxHoldMs) break
      }
    } finally {
      mark('release', { ...snap(st), remaining: Math.round(remaining) })
      await session.releaseKey('Right')
      heldMs += Date.now() - holdStart
    }
    if (mediaChanged(st)) return finish(false, 'hold', { heldMs, holds, error: 'media ended during the hold' })
    await sleep(SCRUB_TAP_SETTLE_MS)
    st = await waitContent()
    if (mediaChanged(st)) return finish(false, 'hold', { heldMs, holds, error: 'media ended during the hold' })
    remaining = duration - st.video!.currentTime
    mark('after-hold', { ...snap(st), remaining: Math.round(remaining) })
  }

  // Phase 2: taps while a tap cannot overshoot the end. A tap's seek takes a moment to land, so each tap
  // waits for the jump to show before the next reading.
  let taps = 0
  for (;;) {
    st = await waitContent()
    if (mediaChanged(st))
      return finish(inWindowSeen, 'taps', {
        heldMs,
        holds,
        taps,
        ...(inWindowSeen ? {} : { error: 'media ended before the window was reached' }),
      })
    note(st)
    if (await dismissEndOverlay()) continue
    const before = st.video!.currentTime
    remaining = duration - before
    if (remaining <= remainTarget) break
    if (remaining - tapS < remainTarget - SCRUB_TAP_SAFETY_S) break
    if (Date.now() >= deadline) throw new Error(`taps did not reach the window within ${waitMs}ms`)
    mark('tap', { ...snap(st), remaining: Math.round(remaining) })
    await tap('Right')
    taps++
    const tapDeadline = Date.now() + SCRUB_TAP_LAND_MS
    while (Date.now() < tapDeadline) {
      await sleep(SCRUB_POLL_MS)
      st = await state()
      if (mediaChanged(st)) break
      const pos = st.seekTime ?? st.video?.currentTime ?? before
      if (pos >= before + tapS / 2 && !st.video?.paused) break
    }
    mark('tap-landed', snap(st))
  }

  // Phase 3: playback carries the position into the window (a seek over an ad break may play the break first).
  while (Date.now() < deadline) {
    st = await state()
    if (mediaChanged(st))
      return finish(inWindowSeen, 'wait', {
        heldMs,
        taps,
        ...(inWindowSeen ? {} : { error: 'media ended before the window was reached' }),
      })
    note(st)
    if (isContent(st) && !st.video!.paused && inWindowSeen) return finish(true, 'wait', { heldMs, holds, taps })
    await dismissEndOverlay()
    await sleep(WAIT_POLL_MS)
  }
  return finish(false, 'wait', {
    heldMs,
    holds,
    taps,
    error: `not inside the last ${remainTarget}s within ${waitMs}ms`,
  })
}
