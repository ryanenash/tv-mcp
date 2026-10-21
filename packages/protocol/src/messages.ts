import type { ExchangeEnd, ExchangeStart, FrameEvent } from './network.js'

// Wire protocol between the in-app agent, the relay and MCP servers. JSON over WebSocket.
//   device → relay  (ws /agent/device?name=&platform=&build=&url=[&token=])
//   client → relay  (ws /agent/client?owner=[&token=])

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface ElementInfo {
  id: string | null
  section: string | null
  tag: string
  role: string | null
  label: string
  href: string | null
  rect: Rect
  visible: boolean
  focused: boolean
}

export interface VideoInfo {
  paused: boolean
  ended: boolean
  muted: boolean
  readyState: number
  currentTime: number
  duration: number | null
  src: string
}

export interface FocusSummary {
  url: string
  focused: ElementInfo | null
  dialogs: string[]
  videos: VideoInfo[]
  /** The page is hidden (window minimised or covered, background tab): the browser stops rendering and throttles timers. */
  hidden?: boolean
}

export interface KeyboardKey {
  id: string | null
  label: string
  x: number
  y: number
  focused: boolean
}

export interface KeyboardLayout {
  error?: string
  section: string
  keys: KeyboardKey[]
  inputValues: string[]
}

export interface Condition {
  text?: string
  selector?: string
  /** No visible element matches this selector (a loading overlay has gone). */
  gone?: string
  focusedLabel?: string
  urlIncludes?: string
  videoPlaying?: boolean
  /** A content-length video is playing with at most this many seconds left. */
  videoNearEnd?: number
  adPlaying?: boolean
  contentPlaying?: boolean
  /** A content-length video exists and is paused. */
  videoPaused?: boolean
  noDialog?: boolean
}

export interface ConditionResult {
  matched: string[]
  focused: ElementInfo | null
  url: string
  dialogs: string[]
  /** The page could not be read (usually mid-load); nothing matched. */
  error?: string
}

export interface PlayerState {
  video: { currentTime: number; duration: number | null; paused: boolean; readyState: number } | null
  timeLabel: string | null
  seekTime: number | null
  adBreak: boolean
  controlsVisible: boolean
  focusedId: string | null
}

export interface ConsoleEvent {
  level: string
  text: string
  source?: string
}

/** Methods the agent answers; params and results as documented in the agent README. */
export type AgentMethod =
  | 'ping'
  /** Replace the agent's profile with the test pack's (params.profile: AppProfile). */
  | 'configure'
  | 'eval'
  | 'pressKey'
  | 'holdKey'
  | 'releaseKey'
  | 'focus'
  | 'snapshot'
  | 'keyboard'
  | 'readText'
  | 'condition'
  | 'playerState'
  | 'navigate'
  | 'clearStorage'
  | 'storageKeys'

export type DeviceToRelay =
  | {
      type: 'hello'
      name: string
      platform: string
      build: string
      url: string
      agentVersion: string
      state: { focus: FocusSummary; route: { url: string } }
    }
  | { type: 'result'; id: number; ok: boolean; value?: unknown; error?: string }
  | { type: 'event'; event: 'focus'; data: FocusSummary }
  | { type: 'event'; event: 'route'; data: { url: string } }
  | { type: 'event'; event: 'console'; data: ConsoleEvent }
  | { type: 'event'; event: 'request'; data: ExchangeStart }
  | { type: 'event'; event: 'response'; data: ExchangeEnd }
  | { type: 'event'; event: 'exchange'; data: ExchangeStart & ExchangeEnd }
  | { type: 'event'; event: 'frame'; data: FrameEvent }
  | { type: 'pong' }

export type RelayToDevice =
  { type: 'call'; id: number; method: AgentMethod; params: Record<string, unknown> } | { type: 'ping' }

export interface RelayDevice {
  name: string
  platform: string
  build: string
  agentVersion: string
  userAgent: string
  url: string
  ip: string
  connectedAt: number
  lastSeen: number
  owner: string | null
  state: { focus?: FocusSummary; route?: { url: string }; at?: number } | null
}

export type ClientToRelay =
  | { type: 'list'; id?: number }
  | { type: 'claim'; id: number; device: string; release?: boolean; force?: boolean }
  | { type: 'call'; id: number; device: string; method: AgentMethod; params?: Record<string, unknown> }

export type RelayToClient =
  | { type: 'devices'; devices: RelayDevice[] }
  | { type: 'result'; id: number; device: string; ok: boolean; value?: unknown; error?: string }
  | { type: 'event'; device: string; event: string; data: unknown }
