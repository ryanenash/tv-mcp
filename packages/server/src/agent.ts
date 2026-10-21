import { randomUUID } from 'node:crypto'
import {
  bodyOmission,
  DEFAULT_PROFILE,
  detectPlatform,
  prepareBody,
  redactHeaders,
  redactJsonText,
  redactUrl,
  shouldRecord,
} from '@tv-mcp/protocol'
import WebSocket from 'ws'

import { Recorder } from './recorder.js'
import { changed, conditionResult, errorMessage, sleep } from './session.js'

import type {
  AgentMethod,
  AppProfile,
  Condition,
  ConditionResult,
  FocusSummary,
  KeyboardLayout,
  ExchangeEnd,
  ExchangeStart,
  FrameEvent,
  NetworkProfile,
  PlayerState,
  RelayDevice,
} from '@tv-mcp/protocol'
import type { DeviceInfo, DeviceSession, FocusRef, PressResult } from './session.js'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const CALL_TIMEOUT_MS = 15_000
const CONNECT_TIMEOUT_MS = 8_000
const LIST_TIMEOUT_MS = 3_000
const AGENT_POLL_MS = 250

/** One WebSocket to the relay's /agent/client, multiplexing every agent device. */
export class AgentClient {
  private ws: WebSocket | null = null
  private connecting: Promise<void> | null = null
  private pending = new Map<number, Pending>()
  private listWaiters: Array<() => void> = []
  private nextId = 1
  private devices = new Map<string, RelayDevice>()
  private sessions = new Map<string, AgentSession>()
  /** One per device name, created on its first event so nothing is lost before a tool resolves the device. */
  private recorders = new Map<string, Recorder>()
  private connectedOnce = false
  /** The pack's network policy, re-applied to every record an agent sends (agents may still be on their boot policy). */
  private policy: NetworkProfile = DEFAULT_PROFILE.network

  private async refreshPolicy() {
    try {
      this.policy = (await this.profile()).network
    } catch {
      // keep the last good policy
    }
  }
  private readonly httpBase: string
  private readonly wsBase: string

  constructor(
    relayUrl: string,
    private readonly token: string,
    readonly owner: string,
    private readonly profile: () => Promise<AppProfile>,
  ) {
    this.httpBase = relayUrl.replace(/\/+$/, '')
    this.wsBase = this.httpBase.replace(/^http/, 'ws')
  }

  get url() {
    return this.httpBase
  }

  async listDevices(): Promise<DeviceInfo[]> {
    await this.refreshPolicy()
    try {
      await this.ensureConnected()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, LIST_TIMEOUT_MS)
        this.listWaiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
        this.ws?.send(JSON.stringify({ type: 'list' }))
      })
    } catch (error) {
      console.error(`[tv-mcp] relay ${this.httpBase} unavailable: ${errorMessage(error)}`)
      return []
    }
    return Array.from(this.devices.values()).map(toInfo)
  }

  resolve(selector?: string): RelayDevice | undefined {
    const all = Array.from(this.devices.values())
    if (!selector) return all.length === 1 ? all[0] : undefined
    const needle = selector.toLowerCase()
    return (
      all.find((d) => d.name === selector) ??
      all.find((d) =>
        [d.name, d.ip, d.userAgent, d.url, d.platform].some((f) => (f ?? '').toLowerCase().includes(needle)),
      )
    )
  }

  session(device: RelayDevice): AgentSession {
    let session = this.sessions.get(device.name)
    if (!session) {
      session = new AgentSession(this, device, this.profile, this.recorderFor(device.name))
      this.sessions.set(device.name, session)
    }
    session.device = device
    return session
  }

  recorderFor(name: string): Recorder {
    let recorder = this.recorders.get(name)
    if (!recorder) {
      recorder = new Recorder()
      this.recorders.set(name, recorder)
    }
    return recorder
  }

  /** Connect now rather than on the first tool call, so device events are recorded from the start. */
  async warmUp() {
    await this.listDevices()
  }

  async call(device: string, method: AgentMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    await this.ensureConnected()
    return this.request({ type: 'call', device, method, params }, String(method))
  }

  async claim(device: string, release = false, force = false) {
    await this.ensureConnected()
    return this.request({ type: 'claim', device, release, force }, 'claim')
  }

  closeAll() {
    this.ws?.close()
  }

  private request(message: Record<string, unknown>, label: string): Promise<unknown> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('relay not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${label} timed out after ${CALL_TIMEOUT_MS}ms`))
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ ...message, id }))
    })
  }

  private ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve()
    if (this.connecting) return this.connecting
    this.connecting = new Promise<void>((resolve, reject) => {
      // The relay replays recent device events to new clients; only the first connection wants them.
      const replay = this.connectedOnce ? '&replay=0' : ''
      const query = `owner=${encodeURIComponent(this.owner)}${this.token ? `&token=${encodeURIComponent(this.token)}` : ''}${replay}`
      const ws = new WebSocket(`${this.wsBase}/agent/client?${query}`)
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new Error('relay connect timed out'))
      }, CONNECT_TIMEOUT_MS)
      ws.once('open', () => {
        clearTimeout(timer)
        this.connectedOnce = true
        this.ws = ws
        resolve()
      })
      ws.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      ws.on('message', (data) => this.onMessage(data.toString()))
      ws.on('close', () => {
        this.ws = null
        for (const p of this.pending.values()) {
          clearTimeout(p.timer)
          p.reject(new Error('relay disconnected'))
        }
        this.pending.clear()
        for (const s of this.sessions.values()) s.stale = true
      })
    }).finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private onMessage(raw: string) {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.type === 'devices') {
      this.devices = new Map((message.devices as RelayDevice[]).map((d) => [d.name, d]))
      for (const [name, session] of this.sessions) {
        const d = this.devices.get(name)
        if (d) session.device = d
      }
      const waiters = this.listWaiters
      this.listWaiters = []
      for (const w of waiters) w()
      return
    }
    if (message.type === 'result') {
      const p = this.pending.get(message.id as number)
      if (!p) return
      clearTimeout(p.timer)
      this.pending.delete(message.id as number)
      if (message.ok) p.resolve(message.value)
      else p.reject(new Error(String(message.error ?? 'device error')))
      return
    }
    if (message.type === 'event') {
      const name = String(message.device)
      const at = typeof message.at === 'number' ? message.at : undefined
      const data = message.data as Record<string, unknown>
      record(this.recorderFor(name), String(message.event), data, at, this.policy)
      this.sessions.get(name)?.onEvent(String(message.event), data)
    }
  }
}

const contentType = (headers?: Record<string, string>) => headers?.['content-type'] ?? headers?.['Content-Type'] ?? ''

/** The pack policy over a request record: url filter, url/header redaction, request body. Null when dropped. */
function applyToStart<T extends ExchangeStart>(e: T, policy: NetworkProfile): T | null {
  if (!shouldRecord(e.url, policy)) return null
  const out: T = { ...e, url: redactUrl(e.url, policy), requestHeaders: redactHeaders(e.requestHeaders, policy) }
  if (!policy.bodies) {
    delete out.requestBody
    delete out.requestBodyTruncated
  } else if (e.requestBody !== undefined) {
    const prepared = prepareBody(e.requestBody, contentType(e.requestHeaders), policy)
    out.requestBody = prepared.body
    out.requestBodyTruncated = e.requestBodyTruncated || prepared.truncated
  }
  return out
}

/** The pack policy over a response: header redaction, body redaction/cut, or no body when the pack says so. */
function applyToEnd<T extends ExchangeEnd>(e: T, policy: NetworkProfile): T {
  const out: T = { ...e, responseHeaders: redactHeaders(e.responseHeaders, policy) }
  if (e.responseBody === undefined) return out
  const omitted = bodyOmission(e.mimeType ?? contentType(e.responseHeaders), policy)
  if (omitted) {
    delete out.responseBody
    delete out.responseBodyTruncated
    out.responseBodyOmitted = omitted
    return out
  }
  const prepared = prepareBody(e.responseBody, e.mimeType ?? contentType(e.responseHeaders), policy)
  out.responseBody = prepared.body
  out.responseBodyTruncated = e.responseBodyTruncated || prepared.truncated
  return out
}

/** Device events into the device's recorder, on the device clock (aligned later by the measured offset). */
function record(
  recorder: Recorder,
  event: string,
  data: Record<string, unknown>,
  at: number | undefined,
  policy: NetworkProfile,
) {
  recorder.observeDeviceClock(at)
  const when = at ?? Date.now()
  const clock = at === undefined ? 'tv-mcp' : 'device'
  if (event === 'console')
    recorder.log(String(data.level ?? 'log'), redactJsonText(String(data.text ?? ''), policy), when, clock, {
      origin: data.level === 'exception' ? 'exception' : 'console',
      ...(typeof data.source === 'string' ? { source: data.source } : {}),
    })
  else if (event === 'request') {
    const start = applyToStart(data as unknown as ExchangeStart, policy)
    if (start) recorder.start(start, 'device')
    else recorder.drop(String(data.id))
  } else if (event === 'response') recorder.end(applyToEnd(data as unknown as ExchangeEnd, policy), 'device')
  else if (event === 'exchange') {
    const x = data as unknown as ExchangeStart & ExchangeEnd
    const start = applyToStart(x, policy)
    if (start) recorder.exchange(applyToEnd(start, policy), x.origin === 'server' ? 'server' : 'device')
  } else if (event === 'frame') {
    const f = { ...(data as unknown as FrameEvent) }
    if (!policy.bodies) delete f.data
    else if (f.data !== undefined) {
      const prepared = prepareBody(f.data, '', { ...policy, maxBodyBytes: Math.min(policy.maxBodyBytes, 4096) })
      f.data = prepared.body
      f.truncated = f.truncated || prepared.truncated
    }
    recorder.frame(f)
  } else if (event === 'focus') {
    const focused = (data as { focused?: { label?: string; id?: string | null } | null }).focused
    recorder.event('focus', focused ? `${focused.label ?? ''} (${focused.id ?? '?'})` : 'nothing focused', when, clock)
  } else if (event === 'route') recorder.event('route', String(data.url ?? ''), when, clock)
}

function toInfo(d: RelayDevice): DeviceInfo {
  return {
    id: d.name,
    transport: 'agent',
    name: d.name,
    url: d.url,
    ip: d.ip,
    userAgent: d.userAgent,
    platform: d.platform && d.platform !== 'unknown' ? d.platform : detectPlatform(d.userAgent),
    build: d.build,
    owner: d.owner,
  }
}

export class AgentSession implements DeviceSession {
  stale = false
  /** The agent restarts with its built-in profile on every page load; re-send ours per connection. */
  private configuredFor = -1
  private waiters: Array<(summary: FocusSummary) => void> = []

  constructor(
    private readonly client: AgentClient,
    public device: RelayDevice,
    private readonly profile: () => Promise<AppProfile>,
    readonly recorder: Recorder,
  ) {}

  get info(): DeviceInfo {
    return toInfo(this.device)
  }

  get connected() {
    return !this.stale
  }

  async connect() {
    this.stale = false
  }

  close() {}

  async captureNetwork(): Promise<void> {}

  onEvent(event: string, data: Record<string, unknown>) {
    if (event === 'focus') {
      const waiters = this.waiters
      this.waiters = []
      for (const w of waiters) w(data as unknown as FocusSummary)
    } else if (event === 'route') {
      // A route change invalidates whatever focus we knew; waiters re-read.
      const waiters = this.waiters
      this.waiters = []
      void this.focusSummary()
        .then((s) => waiters.forEach((w) => w(s)))
        .catch(() => undefined)
    }
  }

  private async call<T = unknown>(method: AgentMethod, params: Record<string, unknown> = {}): Promise<T> {
    if (this.configuredFor !== this.device.connectedAt) {
      const connectedAt = this.device.connectedAt
      await this.client.call(this.device.name, 'configure', { profile: await this.profile() })
      this.configuredFor = connectedAt
    }
    return this.client.call(this.device.name, method, params) as Promise<T>
  }

  evaluate(expression: string) {
    return this.call('eval', { expression })
  }

  async press(key: string, holdMs: number): Promise<PressResult> {
    const before = await this.focusSummary()
    this.recorder.mark(
      'press',
      `${key}${holdMs ? ` hold ${holdMs}ms` : ''} on ${before.focused?.label ?? 'nothing focused'}`,
    )
    const result = await this.call<{ keyCode?: number; error?: string }>('pressKey', { key, holdMs })
    if (result?.error) throw new Error(result.error)
    return {
      via: 'agent',
      keyCode: result?.keyCode ?? null,
      before: { focusId: before.focused?.id ?? null, url: before.url },
    }
  }

  async holdKey(key: string, repeatMs: number) {
    const result = await this.call<{ error?: string }>('holdKey', { key, repeatMs })
    if (result?.error) throw new Error(result.error)
  }

  async releaseKey(key: string) {
    const result = await this.call<{ error?: string }>('releaseKey', { key })
    if (result?.error) throw new Error(result.error)
  }

  focusSummary() {
    return this.call<FocusSummary>('focus')
  }

  waitForChange(before: FocusRef, timeoutMs: number): Promise<FocusSummary> {
    return new Promise((resolve) => {
      let done = false
      const finish = (summary: FocusSummary) => {
        if (done) return
        done = true
        resolve(summary)
      }
      const timer = setTimeout(async () => {
        if (!done) finish(await this.focusSummary())
      }, timeoutMs)
      this.waiters.push((summary) => {
        if (!changed(before, summary)) return
        clearTimeout(timer)
        finish(summary)
      })
      // Push events are the fast path; polling covers focus systems that emit no DOM event.
      void (async () => {
        while (!done) {
          const now = await this.focusSummary().catch(() => null)
          if (done) return
          if (now && changed(before, now)) {
            clearTimeout(timer)
            finish(now)
            return
          }
          await sleep(AGENT_POLL_MS)
        }
      })()
    })
  }

  snapshot(maxElements: number) {
    return this.call('snapshot', { maxElements })
  }

  async keyboardLayout() {
    const layout = await this.call<KeyboardLayout>('keyboard')
    if (layout.error) throw new Error(layout.error)
    return layout
  }

  readText(selector: string, maxChars: number) {
    return this.call('readText', { selector, maxChars })
  }

  async condition(args: Condition) {
    return conditionResult(await this.call<ConditionResult>('condition', args as Record<string, unknown>))
  }

  playerState() {
    return this.call<PlayerState>('playerState')
  }

  storageKeys() {
    return this.call<string[]>('storageKeys')
  }

  async navigate(url: string) {
    this.recorder.mark('navigate', url)
    const result = await this.call('navigate', { url })
    this.stale = true
    return result
  }

  async clearStorage(reload: boolean) {
    this.recorder.mark('clearStorage', reload ? 'and reload' : 'no reload')
    const result = await this.call('clearStorage', { reload })
    if (reload) this.stale = true
    return result
  }
}

export const newOwnerId = () => `tv-mcp-${randomUUID().slice(0, 8)}`
