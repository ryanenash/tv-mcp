// The app profile describes how one TV app exposes its UI: how focus is marked, where the player keeps its
// position, which dialogs must never appear unasked. Both the in-app agent and the DevTools page scripts read
// the DOM through it, so one profile drives every transport. Keep this file ES5-safe: the agent bundles it.

export interface FocusProfile {
  /** Selector for the focused element. Empty: `document.activeElement` (native focus). */
  activeSelector: string
  /** Focusable elements listed by `snapshot`. */
  elementSelector: string
  /** Stable id of a focusable element; falls back to the `id` attribute. */
  idAttribute: string
  /** Container of a group of focusables (a rail, a menu, a dialog). Empty disables sections. */
  sectionSelector: string
  sectionIdAttribute: string
  /** Optional attribute naming the focus scope a section belongs to (e.g. "modal"). */
  scopeAttribute: string
  /** Event fired on the focused element (capture phase on document) when focus moves; drives push events. */
  focusEvent: string
}

export interface PlayerProfile {
  /** Element whose text is the playhead ("12:34" or "1:02:03") while scrubbing. Empty: use the <video> clock. */
  timeLabelSelector: string
  /** Present while an ad break plays. Empty: ads are told apart by duration only. */
  adSelector: string
  /** Shorter videos are treated as ads, longer ones as content. */
  contentMinDurationS: number
  /** Seconds one tap of Right/Left skips in the player. */
  seekStepS: number
  /**
   * An end-of-play overlay (autoplay countdown) that would leave the asset before its end. While `selector`
   * matches, `keys` are pressed once to dismiss it and keep playing to the end.
   */
  endOverlay: { selector: string; keys: string[] } | null
}

export interface KeyboardProfile {
  /** Regex (source) matched against section ids to find the on-screen keyboard. */
  sectionPattern: string
}

/** A dialog that is a requirement on one screen and a bug anywhere else; journeys must expect it explicitly. */
export interface DialogGuard {
  name: string
  selector: string
  /** Storage key (localStorage or cookie) that records the dismissal; reported when the dialog reappears. */
  storageKey?: string
  /** Regex (source); a step whose expectations match it is expecting this dialog. */
  hint?: string
  /**
   * For popups that may legitimately appear on any screen (marketing messages): instead of failing the step,
   * press these keys in order to close it, then carry on. Each key is skipped once the popup has gone.
   */
  dismissKeys?: string[]
}

export interface KeyEventProfile {
  /** Also set `key` (ArrowUp, Enter, …) on synthetic events. Some input layers drop events that carry it. */
  key: boolean
  /** Dispatch on the focused element (bubbles to document) or on document only. */
  target: 'active' | 'document'
}

export interface NetworkProfile {
  /** Capture request and response bodies (within the limits below). Off by default: it costs CPU on slow boxes. */
  bodies: boolean
  /** Bodies longer than this are cut and flagged truncated. */
  maxBodyBytes: number
  /** Regex (source) on the content type; only matching bodies are read. Media and binary are never read. */
  bodyTypes: string
  /** Regex sources; when set, only matching urls are recorded at all. */
  include: string[]
  /** Regex sources; matching urls are never recorded. */
  exclude: string[]
  /** Header names (case-insensitive) whose values are replaced by [redacted]. */
  redactHeaders: string[]
  /** Regex (source, case-insensitive) on JSON keys, form fields and query parameters to redact. */
  redactKeys: string
}

export interface ConsoleProfile {
  /** Longest console message kept (serialised objects included); longer ones are cut and marked. */
  maxMessageChars: number
  /** How deep objects are expanded. */
  maxDepth: number
}

export interface AppProfile {
  name: string
  focus: FocusProfile
  player: PlayerProfile
  keyboard: KeyboardProfile
  guards: DialogGuard[]
  /** A journey reset is ready when this matches (plus a focused element). Empty: focus alone. */
  startSelector: string
  /**
   * Loading overlays (splash, full-screen spinner) that hide the UI while it still takes keys. Presses wait until
   * no visible element matches, so a viewer sees each move. Empty: no wait.
   */
  busySelector: string
  /** Key code overrides by key name (Ok, Back, Play…), applied on every platform. */
  keyCodes: Record<string, number>
  keyEvent: KeyEventProfile
  /** Global the agent installs on window; DevTools scripts prefer its pressKey when present. */
  bridgeGlobal: string
  network: NetworkProfile
  console: ConsoleProfile
}

export const DEFAULT_PROFILE: AppProfile = {
  name: 'default',
  focus: {
    activeSelector: '',
    elementSelector:
      '[data-focus-id], a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [role="button"]',
    idAttribute: 'data-focus-id',
    sectionSelector: '[data-focus-section]',
    sectionIdAttribute: 'data-focus-section',
    scopeAttribute: 'data-focus-scope',
    focusEvent: 'focusin',
  },
  player: {
    timeLabelSelector: '',
    adSelector: '',
    contentMinDurationS: 120,
    seekStepS: 10,
    endOverlay: null,
  },
  keyboard: { sectionPattern: 'keyboard' },
  guards: [],
  startSelector: '',
  busySelector: '',
  keyCodes: {},
  keyEvent: { key: true, target: 'active' },
  bridgeGlobal: '__tvmcp',
  network: {
    bodies: false,
    maxBodyBytes: 65536,
    bodyTypes: 'json|text|xml|javascript|x-www-form-urlencoded|graphql',
    include: [],
    exclude: [],
    redactHeaders: ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token'],
    redactKeys:
      '^(password|passwd|pass|pin|secret|token|access_?token|refresh_?token|id_?token|api_?key|authorization|session_?id|cookie)$',
  },
  console: { maxMessageChars: 65536, maxDepth: 8 },
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !(value instanceof Array)
}

function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key in base) if (Object.prototype.hasOwnProperty.call(base, key)) out[key] = base[key]
  for (const key in patch) {
    if (!Object.prototype.hasOwnProperty.call(patch, key) || patch[key] === undefined) continue
    const b = base[key]
    const p = patch[key]
    out[key] = isPlainObject(b) && isPlainObject(p) ? merge(b, p) : p
  }
  return out
}

/** Defaults overlaid with a partial profile; arrays and `endOverlay` replace rather than merge. */
export function resolveProfile(partial?: DeepPartial<AppProfile> | null): AppProfile {
  if (!partial) return DEFAULT_PROFILE
  return merge(
    DEFAULT_PROFILE as unknown as Record<string, unknown>,
    partial as Record<string, unknown>,
  ) as unknown as AppProfile
}
