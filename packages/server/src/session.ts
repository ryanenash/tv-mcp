import type { Recorder } from './recorder.js'
import type { Condition, ConditionResult, FocusSummary, KeyboardLayout, PlayerState } from '@tv-mcp/protocol'

export interface DeviceInfo {
  id: string
  transport: 'agent' | 'cdp'
  name?: string
  title?: string
  url: string
  ip: string
  userAgent: string
  platform: string
  build?: string
  owner?: string | null
}

export interface FocusRef {
  focusId: string | null
  url: string
}

export interface PressResult {
  via: string
  keyCode?: number | null
  before: FocusRef
}

/** What every transport offers; the MCP tools only talk to this. */
export interface DeviceSession {
  readonly info: DeviceInfo
  /** Network exchanges, console output and events for this device, on one clock. */
  readonly recorder: Recorder
  stale: boolean
  readonly connected: boolean
  /** Counts reconnects that landed on a new document; undefined where the transport cannot tell. */
  readonly generation?: number
  connect(): Promise<void>
  close(): void
  /** Start capturing requests where capture is opt-in (DevTools); the agent captures from page load. */
  captureNetwork(): Promise<void>
  evaluate(expression: string): Promise<unknown>
  press(key: string, holdMs: number): Promise<PressResult>
  holdKey(key: string, repeatMs: number): Promise<void>
  releaseKey(key: string): Promise<void>
  focusSummary(): Promise<FocusSummary>
  /** Resolve when focus or url differs from `before`, or after `timeoutMs`. */
  waitForChange(before: FocusRef, timeoutMs: number): Promise<FocusSummary>
  snapshot(maxElements: number): Promise<unknown>
  keyboardLayout(): Promise<KeyboardLayout>
  readText(selector: string, maxChars: number): Promise<unknown>
  condition(args: Condition): Promise<ConditionResult>
  playerState(): Promise<PlayerState>
  storageKeys(): Promise<string[]>
  navigate(url: string): Promise<unknown>
  clearStorage(reload: boolean): Promise<unknown>
}

export const changed = (before: FocusRef, after: FocusSummary) =>
  after.url !== before.url || (after.focused?.id ?? null) !== (before.focusId ?? null)

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Polling fallback for transports without push events. */
export async function pollForChange(
  read: () => Promise<FocusSummary>,
  before: FocusRef,
  timeoutMs: number,
  pollMs: number,
): Promise<FocusSummary> {
  const deadline = Date.now() + timeoutMs
  let after = await read()
  while (!changed(before, after) && Date.now() < deadline) {
    await sleep(pollMs)
    after = await read()
  }
  return after
}

/** A page that could not be read (mid-load, script error) counts as nothing matched rather than a crash. */
export function conditionResult(raw: unknown): ConditionResult {
  const r = (raw ?? {}) as Partial<ConditionResult> & { error?: string }
  if (Array.isArray(r.matched)) return r as ConditionResult
  return { matched: [], focused: null, url: r.url ?? '', dialogs: [], error: r.error ?? 'page not readable' }
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
