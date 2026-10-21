import {
  bodyOmission,
  DEFAULT_PROFILE,
  formatConsole,
  redactBody,
  redactJsonText,
  serializeValue,
  DOM_KEY,
  detectPlatform,
  keyCodeFor,
  prepareBody,
  redactHeaders,
  redactUrl,
  shouldRecord,
} from '@tv-mcp/protocol'
import WebSocket from 'ws'

import { adb, adbConnect } from './adb.js'
import { config } from './config.js'
import {
  clearStorageScript,
  conditionScript,
  focusSummaryScript,
  holdKeyScript,
  keyboardLayoutScript,
  navigateScript,
  playerStateScript,
  pressKeyScript,
  readTextScript,
  releaseKeyScript,
  snapshotScript,
  storageKeysScript,
} from './pageScripts.js'
import { Recorder } from './recorder.js'
import { conditionResult, errorMessage, pollForChange } from './session.js'
import { sdbForwards } from './sdb.js'

import type {
  AppProfile,
  Condition,
  ConditionResult,
  FocusSummary,
  Headers,
  KeyboardLayout,
  NetworkProfile,
  PlayerState,
} from '@tv-mcp/protocol'
import type { DeviceRegistry } from './devices.js'
import type { DeviceInfo, DeviceSession, FocusRef, PressResult } from './session.js'

export interface CdpTarget {
  /** `<registry name>:<page id>`. */
  id: string
  /** Registry name of the device. */
  name: string
  title: string
  url: string
  /** adb/sdb serial or endpoint host. */
  ip: string
  userAgent: string
  wsUrl: string
  /** Synthetic DOM events instead of Input.dispatchKeyEvent. */
  syntheticKeys: boolean
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface DevToolsPage {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

const CALL_TIMEOUT_MS = 15_000
// Bodies that never end or arrive in parts the page reads as they come; holding them would stall the app.
const STREAMING_TYPE = /event-stream|ndjson|x-mixed-replace|multipart\//i
const HOLD_BODY_MS = 2000
const BROWSER_PAGE = /^(devtools|chrome|chrome-extension|chrome-untrusted|chrome-search|edge|extension):/
const EVAL_TIMEOUT_MS = Number(process.env.TVMCP_EVAL_TIMEOUT_MS ?? 10_000)
const SETTLE_POLL_MS = 80
const CLEAR_RELOAD_DELAY_MS = 3000
const HTTP_TIMEOUT_MS = 3000

function describeArg(arg: { type?: string; value?: unknown; description?: string }): string {
  if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)
  return arg.description ?? arg.type ?? ''
}

/** Windows virtual key codes CDP expects for keys that are not plain characters. */
const VIRTUAL_KEY: Record<string, number> = {
  Ok: 13,
  Back: 8,
  Left: 37,
  Up: 38,
  Right: 39,
  Down: 40,
  PlayPause: 179,
  Stop: 178,
}

/** One Chrome DevTools Protocol connection to a page (Android WebView, Tizen inspector, desktop Chrome). */
export class CdpSession implements DeviceSession {
  readonly recorder = new Recorder()
  /** Set when the page reloaded or stopped answering; the next call reconnects. */
  stale = false
  private ws: WebSocket | null = null
  private pending = new Map<number, Pending>()
  // Large random base so ids never collide with a DevTools frontend sharing the target.
  private nextId = 1_000_000 + Math.floor(Math.random() * 1_000_000)
  private networkOn = false
  /** CDP requestId → record id; a redirect reuses the requestId, so each hop gets its own record. */
  private requestIds = new Map<string, string>()
  private networkSeq = 0
  /** responseReceivedExtraInfo that arrived before its responseReceived. */
  private pendingExtra = new Map<string, () => void>()
  /** The pack profile's network policy, refreshed on connect (events are handled synchronously). */
  private policy: NetworkProfile = DEFAULT_PROFILE.network
  private consolePolicy = DEFAULT_PROFILE.console
  /** Monotonic request start (seconds) and header times, for DevTools-style phase timings. */
  private monotonic = new Map<string, { start: number; requestTime?: number; headersEnd?: number }>()
  /** requestWillBeSentExtraInfo can arrive before its requestWillBeSent. */
  private pendingRequestExtra = new Map<string, Headers>()
  /**
   * API response bodies read while the browser holds the response (Fetch domain), by network request id. Chrome
   * answers getResponseBody for a page that is navigating away only after the next page commits, when that page's
   * bodies are gone; the browser-side copy does not depend on the page.
   */
  private held = new Map<string, string>()
  private trustedHolds = new Map<string, NodeJS.Timeout>()

  constructor(
    public target: CdpTarget,
    private readonly profile: () => Promise<AppProfile>,
    private readonly connectUrl: () => Promise<string>,
  ) {}

  get connected() {
    return !this.stale && this.ws?.readyState === WebSocket.OPEN
  }

  get info(): DeviceInfo {
    const t = this.target
    return {
      id: t.id,
      transport: 'cdp',
      name: t.name,
      title: t.title,
      url: t.url,
      ip: t.ip,
      userAgent: t.userAgent,
      platform: detectPlatform(t.userAgent),
    }
  }

  private get platform() {
    return detectPlatform(this.target.userAgent)
  }

  private async keyCode(key: string) {
    return keyCodeFor(key, this.platform, (await this.profile()).keyCodes) ?? null
  }

  /** Promises are awaited, up to EVAL_TIMEOUT_MS. */
  async evaluate(expression: string) {
    const wrapped = `(function () {
      var ok = function (r) { return JSON.stringify({ value: r === undefined ? null : r }) }
      var fail = function (e) { return JSON.stringify({ error: String(e && e.message || e) }) }
      try { var r = (${expression}); return r && typeof r.then === 'function' ? r.then(ok, fail) : ok(r) } catch (e) { return fail(e) }
    })()`
    let result: { value?: unknown; error?: string }
    try {
      result = await this.evaluateJson(wrapped, EVAL_TIMEOUT_MS)
    } catch (error) {
      if (!/timed out/.test(errorMessage(error))) throw error
      const hidden = await this.evaluateJson<string>('JSON.stringify(document.visibilityState)').catch(() => null)
      throw new Error(
        `expression did not settle within ${EVAL_TIMEOUT_MS}ms` +
          (hidden === 'hidden' ? '; the page is hidden, so its timers and animation frames are throttled' : ''),
      )
    }
    if (result.error) throw new Error(result.error)
    return result.value ?? null
  }

  /** A trusted key through the browser's input pipeline, as a real remote or keyboard would produce. */
  private async dispatchTrusted(type: 'down' | 'up', key: string, code: number, autoRepeat = false) {
    const domKey = DOM_KEY[key] ?? key
    const text = key === 'Ok' ? '\r' : /^Digit\d$/.test(key) ? key.slice(5) : undefined
    const vk = VIRTUAL_KEY[key] ?? code
    await this.send('Input.dispatchKeyEvent', {
      type: type === 'up' ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown',
      key: domKey,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: code,
      autoRepeat,
      ...(text && type === 'down' ? { text, unmodifiedText: text } : {}),
    })
  }

  /** The page's agent bridge when present, else trusted CDP input, else a synthetic DOM event. */
  async press(key: string, holdMs: number): Promise<PressResult> {
    this.recorder.mark('press', `${key}${holdMs ? ` hold ${holdMs}ms` : ''}`)
    const p = await this.profile()
    const code = await this.keyCode(key)
    const bridge = await this.evaluate(`!!window[${JSON.stringify(p.bridgeGlobal)}]`).catch(() => false)
    if (!bridge && !this.target.syntheticKeys && code !== null) {
      const before = await this.focusSummary()
      try {
        await this.dispatchTrusted('down', key, code)
        if (holdMs > 0) {
          const until = Date.now() + holdMs
          while (Date.now() < until) {
            await new Promise((r) => setTimeout(r, 100))
            await this.dispatchTrusted('down', key, code, true)
          }
        }
        await this.dispatchTrusted('up', key, code)
        return { via: 'cdp-input', keyCode: code, before: { focusId: before.focused?.id ?? null, url: before.url } }
      } catch (error) {
        console.error(`[tv-mcp] Input.dispatchKeyEvent failed on ${this.target.id}: ${errorMessage(error)}; synthetic`)
      }
    }
    const result = await this.evaluateJson<{ via?: string; error?: string; keyCode?: number; before?: FocusRef }>(
      pressKeyScript(p, { action: key, keyCode: code, domKey: p.keyEvent.key ? (DOM_KEY[key] ?? null) : null, holdMs }),
    )
    if (result.error) throw new Error(result.error)
    return {
      via: result.via ?? 'synthetic',
      keyCode: result.keyCode ?? code,
      before: result.before ?? { focusId: null, url: '' },
    }
  }

  async holdKey(key: string, repeatMs: number) {
    const p = await this.profile()
    const code = await this.keyCode(key)
    if (code === null) throw new Error(`no key code for ${key}`)
    if (!this.target.syntheticKeys) {
      try {
        await this.dispatchTrusted('down', key, code)
        clearInterval(this.trustedHolds.get(key))
        this.trustedHolds.set(
          key,
          setInterval(() => void this.dispatchTrusted('down', key, code, true).catch(() => undefined), repeatMs),
        )
        return
      } catch {
        // fall through to the page-side hold
      }
    }
    const domKey = p.keyEvent.key ? (DOM_KEY[key] ?? null) : null
    await this.evaluateJson(holdKeyScript(p, { keyCode: code, domKey, repeatMs }))
  }

  async releaseKey(key: string) {
    const p = await this.profile()
    const code = await this.keyCode(key)
    if (code === null) throw new Error(`no key code for ${key}`)
    const trusted = this.trustedHolds.get(key)
    if (trusted) {
      clearInterval(trusted)
      this.trustedHolds.delete(key)
      await this.dispatchTrusted('up', key, code)
      return
    }
    const domKey = p.keyEvent.key ? (DOM_KEY[key] ?? null) : null
    await this.evaluateJson(releaseKeyScript(p, { keyCode: code, domKey }))
  }

  async focusSummary() {
    return this.evaluateJson<FocusSummary>(focusSummaryScript(await this.profile()))
  }

  waitForChange(before: FocusRef, timeoutMs: number) {
    return pollForChange(() => this.focusSummary(), before, timeoutMs, SETTLE_POLL_MS)
  }

  async snapshot(maxElements: number) {
    return this.evaluateJson(snapshotScript(await this.profile(), { maxElements }))
  }

  async keyboardLayout() {
    const layout = await this.evaluateJson<KeyboardLayout>(keyboardLayoutScript(await this.profile()))
    if (layout.error) throw new Error(layout.error)
    return layout
  }

  async readText(selector: string, maxChars: number) {
    return this.evaluateJson(readTextScript(await this.profile(), { selector, maxChars }))
  }

  async condition(args: Condition) {
    return conditionResult(await this.evaluateJson<ConditionResult>(conditionScript(await this.profile(), { ...args })))
  }

  async playerState() {
    return this.evaluateJson<PlayerState>(playerStateScript(await this.profile()))
  }

  async storageKeys() {
    return this.evaluateJson<string[]>(storageKeysScript(await this.profile()))
  }

  async navigate(url: string) {
    this.recorder.mark('navigate', url)
    const result = await this.evaluateJson(navigateScript(await this.profile(), { url }))
    this.stale = true
    return result
  }

  /** Storage.clearDataForOrigin takes HttpOnly cookies too; the page-side wipe covers older engines. */
  async clearStorage(reload: boolean) {
    this.recorder.mark('clearStorage', reload ? 'and reload' : 'no reload')
    let origin = ''
    try {
      origin = new URL(this.target.url).origin
    } catch {
      // file:// and opaque origins have no clearable origin
    }
    let protocolClear: unknown = 'skipped'
    if (origin && origin !== 'null') {
      try {
        await this.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })
        protocolClear = 'ok'
      } catch (error) {
        protocolClear = `unsupported: ${errorMessage(error)}`
      }
    }
    const page = await this.evaluateJson(
      clearStorageScript(await this.profile(), { reload, reloadDelayMs: CLEAR_RELOAD_DELAY_MS }),
    )
    if (reload) this.stale = true
    return { protocolClear, page }
  }

  async connect(): Promise<void> {
    if (this.connected) return
    const p = await this.profile()
    this.policy = p.network
    this.consolePolicy = p.console
    // A navigation or a slow call marks the session stale, but the page socket survives both. Replacing it would
    // drop every in-flight network event and make the browser forget earlier request ids (bodies unreadable).
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.stale = false
      return
    }
    const reconnecting = this.ws !== null
    this.ws?.removeAllListeners()
    this.ws?.close()
    this.stale = false
    const ws = new WebSocket(await this.connectUrl())
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', (error) => reject(error))
    })
    ws.on('message', (data) => this.onMessage(data.toString()))
    ws.on('close', () => this.onClose())
    ws.on('error', (error) => console.error(`[tv-mcp] ws error ${this.target.id}: ${error.message}`))
    this.recorder.mark('devtools', reconnecting ? 'reconnected: events while disconnected are lost' : 'connected')
    try {
      await this.send('Runtime.enable')
      // Browser-originated messages: CORS, ORB, mixed content, failed loads, deprecations, interventions.
      await this.send('Log.enable').catch(() => undefined)
      this.networkOn = false
      if (config.networkOnConnect) await this.captureNetwork()
    } catch (error) {
      this.stale = true
      throw error
    }
  }

  async captureNetwork(): Promise<void> {
    this.policy = (await this.profile()).network
    if (this.networkOn) return
    // Large buffers so bodies stay readable as long as DevTools would keep them.
    await this.send('Network.enable', {
      maxTotalBufferSize: 256 * 1024 * 1024,
      maxResourceBufferSize: 64 * 1024 * 1024,
      maxPostDataSize: 64 * 1024 * 1024,
    })
    // Hold API responses just long enough to read their bodies (see `held`). Browsers without the Fetch domain
    // (older TV engines) keep getResponseBody alone.
    if (this.policy.bodies)
      await this.send('Fetch.enable', {
        patterns: [
          { resourceType: 'XHR', requestStage: 'Response' },
          { resourceType: 'Fetch', requestStage: 'Response' },
        ],
      }).catch(() => undefined)
    this.networkOn = true
  }

  close() {
    this.networkOn = false
    for (const timer of this.trustedHolds.values()) clearInterval(timer)
    this.trustedHolds.clear()
    this.ws?.close()
  }

  /** `timeoutMs` below the default is for page work that may legitimately hang; it does not mark the socket stale. */
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('device session not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        if (timeoutMs >= CALL_TIMEOUT_MS) this.stale = true
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluate an expression that resolves to a JSON string, and parse it. */
  async evaluateJson<T = unknown>(expression: string, timeoutMs?: number): Promise<T> {
    const response = (await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    )) as {
      result?: { type?: string; value?: unknown; description?: string; className?: string }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails
      throw new Error(detail.exception?.description ?? detail.text ?? 'evaluation threw')
    }
    const value = response.result?.value
    if (typeof value === 'string') return JSON.parse(value) as T
    if (response.result?.className === 'Promise') {
      throw new Error('expression returned a Promise and this device runtime cannot await it')
    }
    return value as T
  }

  private onMessage(raw: string) {
    let message: {
      id?: number
      method?: string
      params?: Record<string, unknown>
      result?: unknown
      error?: { message?: string }
    }
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message ?? 'CDP error'))
      else pending.resolve(message.result)
      return
    }
    if (message.method) this.onEvent(message.method, message.params ?? {})
  }

  private onEvent(method: string, params: Record<string, unknown>) {
    const at = Date.now()
    switch (method) {
      case 'Runtime.executionContextsCleared':
        // A navigation: the socket and enabled domains survive it; just note it.
        this.recorder.event('navigation', 'document replaced', at, 'tv-mcp')
        break
      case 'Runtime.consoleAPICalled':
        void this.onConsole(params, at)
        break
      case 'Runtime.exceptionThrown': {
        const details = params.exceptionDetails as
          | {
              text?: string
              url?: string
              lineNumber?: number
              columnNumber?: number
              exception?: { description?: string }
            }
          | undefined
        this.recorder.log(
          'exception',
          details?.exception?.description ?? details?.text ?? 'uncaught exception',
          at,
          'tv-mcp',
          {
            origin: 'exception',
            ...(details?.url
              ? { source: `${details.url}:${(details.lineNumber ?? 0) + 1}:${(details.columnNumber ?? 0) + 1}` }
              : {}),
          },
        )
        break
      }
      case 'Log.entryAdded': {
        const entry = params.entry as {
          source?: string
          level?: string
          text?: string
          url?: string
          lineNumber?: number
          networkRequestId?: string
        }
        const level = entry.level === 'verbose' ? 'debug' : entry.level === 'warning' ? 'warn' : (entry.level ?? 'info')
        const text = redactUrl(String(entry.text ?? ''), this.policy)
        this.recorder.log(level, text, at, 'tv-mcp', {
          origin: 'browser',
          category: entry.source,
          ...(entry.url
            ? {
                source: `${redactUrl(entry.url, this.policy)}${entry.lineNumber !== undefined ? `:${entry.lineNumber + 1}` : ''}`,
              }
            : {}),
        })
        // Tie the message to its request, as DevTools does in the request's Issues/console link.
        const id = entry.networkRequestId ? this.requestIds.get(entry.networkRequestId) : undefined
        if (id) this.recorder.patch(id, { notes: [...(this.recorder.get(id)?.notes ?? []), text] })
        break
      }
      case 'Network.requestServedFromCache': {
        const id = this.requestIds.get(String(params.requestId))
        if (id) this.recorder.patch(id, { cache: 'memory' })
        break
      }
      case 'Network.requestWillBeSentExtraInfo': {
        // The headers actually sent, including Cookie, which requestWillBeSent leaves out.
        const extra = redactHeaders(lowerCase(params.headers as Headers | undefined), this.policy)
        if (!extra) break
        const id = this.requestIds.get(String(params.requestId))
        const record = id ? this.recorder.get(id) : undefined
        if (id && record) this.recorder.patch(id, { requestHeaders: { ...(record.requestHeaders ?? {}), ...extra } })
        else this.pendingRequestExtra.set(String(params.requestId), extra)
        break
      }
      case 'Network.requestWillBeSent':
        this.onRequest(params, at)
        break
      case 'Network.responseReceived': {
        const id = this.requestIds.get(String(params.requestId))
        const response = params.response as CdpResponse
        if (id && response) {
          this.recorder.end(this.endFields(id, response, at, String(params.requestId)), 'tv-mcp')
          this.pendingExtra.get(id)?.()
          this.pendingExtra.delete(id)
        }
        break
      }
      case 'Network.responseReceivedExtraInfo': {
        // Raw headers, including Set-Cookie, which responseReceived leaves out. May arrive before or after it.
        const id = this.requestIds.get(String(params.requestId))
        const extra = redactHeaders(lowerCase(params.headers as Headers | undefined), this.policy)
        if (!id || !extra) break
        const merge = () => {
          const record = this.recorder.get(id)
          if (record) this.recorder.patch(id, { responseHeaders: { ...(record.responseHeaders ?? {}), ...extra } })
        }
        if (this.recorder.get(id)?.endedAt !== undefined) merge()
        else this.pendingExtra.set(id, merge)
        break
      }
      case 'Network.webSocketCreated': {
        const url = String(params.url ?? '')
        if (!shouldRecord(url, this.policy)) break
        const seq = ++this.networkSeq
        const id = `cdp-ws-${String(params.requestId)}`
        this.requestIds.set(String(params.requestId), id)
        const initiatorInfo = this.initiatorOf(params.initiator)
        this.recorder.start(
          {
            id,
            seq,
            origin: 'device',
            initiator: 'websocket',
            resourceType: 'WebSocket',
            method: 'GET',
            url: redactUrl(url, this.policy),
            startedAt: at,
            ...(initiatorInfo ? { initiatorInfo } : {}),
          },
          'tv-mcp',
        )
        break
      }
      case 'Network.webSocketWillSendHandshakeRequest': {
        // The upgrade request DevTools shows under Headers (Origin, Cookie, Sec-WebSocket-*).
        const id = this.requestIds.get(String(params.requestId))
        const request = params.request as { headers?: Headers } | undefined
        const headers = redactHeaders(lowerCase(request?.headers), this.policy)
        if (id && headers) this.recorder.patch(id, { requestHeaders: headers })
        break
      }
      case 'Network.webSocketHandshakeResponseReceived': {
        const id = this.requestIds.get(String(params.requestId))
        const response = params.response as { status?: number; statusText?: string; headers?: Headers } | undefined
        if (id && response) this.recorder.end(this.endFields(id, response, at), 'tv-mcp')
        break
      }
      case 'Network.webSocketFrameSent':
      case 'Network.webSocketFrameReceived': {
        const id = this.requestIds.get(String(params.requestId))
        const frame = params.response as { opcode?: number; payloadData?: string } | undefined
        if (!id || !frame) break
        const dir = method === 'Network.webSocketFrameSent' ? 'sent' : 'received'
        const text = frame.opcode === 1 ? (frame.payloadData ?? '') : undefined
        if (text === undefined) {
          this.recorder.frame({
            id,
            dir,
            at,
            size: Math.floor(((frame.payloadData ?? '').length * 3) / 4),
            binary: true,
          })
          break
        }
        const prepared = this.policy.bodies
          ? prepareBody(text, '', { ...this.policy, maxBodyBytes: Math.min(this.policy.maxBodyBytes, 4096) })
          : {}
        this.recorder.frame({
          id,
          dir,
          at,
          size: text.length,
          ...(prepared.body !== undefined ? { data: prepared.body } : {}),
          ...(prepared.truncated ? { truncated: true } : {}),
        })
        break
      }
      case 'Network.webSocketClosed': {
        const id = this.requestIds.get(String(params.requestId))
        if (id) this.recorder.patch(id, { closedAt: at })
        break
      }
      case 'Network.loadingFinished': {
        const requestId = String(params.requestId)
        const id = this.requestIds.get(requestId)
        if (id) {
          const t = this.monotonic.get(requestId)
          const finished = Number(params.timestamp)
          const record = this.recorder.get(id)
          const timing = { ...(record?.timing ?? {}) }
          if (t && Number.isFinite(finished)) {
            timing.total = Math.round((finished - t.start) * 1000)
            if (t.requestTime !== undefined && t.headersEnd !== undefined)
              timing.download = Math.max(0, Math.round((finished - t.requestTime) * 1000 - t.headersEnd))
          }
          this.recorder.patch(id, { transferSize: Number(params.encodedDataLength) || 0, timing })
          this.monotonic.delete(requestId)
        }
        void this.fetchResponseBody(requestId)
        break
      }
      case 'Network.loadingFailed': {
        const requestId = String(params.requestId)
        const id = this.requestIds.get(requestId)
        if (!id) break
        const cors = params.corsErrorStatus as { corsError?: string; failedParameter?: string } | undefined
        const detail = {
          failed: String(params.errorText ?? 'failed'),
          ...(params.canceled ? { canceled: true } : {}),
          ...(params.blockedReason ? { blockedReason: String(params.blockedReason) } : {}),
          ...(cors?.corsError
            ? { corsError: `${cors.corsError}${cors.failedParameter ? ` (${cors.failedParameter})` : ''}` }
            : {}),
        }
        if (this.recorder.get(id)?.pending) this.recorder.end({ id, endedAt: at, ...detail }, 'tv-mcp')
        else this.recorder.patch(id, detail)
        this.monotonic.delete(requestId)
        this.held.delete(requestId)
        break
      }
      case 'Fetch.requestPaused':
        void this.readHeldResponse(params)
        break
      default:
        break
    }
  }

  private endFields(id: string, response: CdpResponse, at: number, requestId?: string) {
    const t = response.timing
    const timing: { [phase: string]: number } = {}
    if (t) {
      const span = (a?: number, b?: number) =>
        a !== undefined && b !== undefined && a >= 0 && b >= 0 ? Math.round(b - a) : undefined
      const firstPhase = [t.dnsStart, t.connectStart, t.sendStart].find((v) => v !== undefined && v >= 0)
      const phases: { [k: string]: number | undefined } = {
        stalled: firstPhase !== undefined ? Math.round(firstPhase) : undefined,
        dns: span(t.dnsStart, t.dnsEnd),
        connect: span(t.connectStart, t.connectEnd),
        ssl: span(t.sslStart, t.sslEnd),
        send: span(t.sendStart, t.sendEnd),
        wait: span(t.sendEnd, t.receiveHeadersEnd),
      }
      for (const [k, v] of Object.entries(phases)) if (v !== undefined) timing[k] = v
      if (requestId) {
        const m = this.monotonic.get(requestId)
        if (m) {
          m.requestTime = t.requestTime
          m.headersEnd = t.receiveHeadersEnd
        }
      }
    }
    const cache = response.fromDiskCache
      ? 'disk'
      : response.fromServiceWorker
        ? 'service-worker'
        : response.fromPrefetchCache
          ? 'prefetch'
          : undefined
    return {
      id,
      endedAt: at,
      status: response.status,
      statusText: response.statusText,
      mimeType: response.mimeType,
      responseHeaders: redactHeaders(lowerCase(response.headers), this.policy),
      ...(Object.keys(timing).length ? { timing } : {}),
      ...(response.remoteIPAddress
        ? { remoteAddress: `${response.remoteIPAddress}:${response.remotePort ?? ''}` }
        : {}),
      ...(response.protocol ? { protocol: response.protocol } : {}),
      ...(cache ? { cache: cache as 'disk' | 'service-worker' | 'prefetch' } : {}),
    }
  }

  /** A console call as DevTools shows it: format specifiers applied, objects expanded (and redacted by key). */
  private async onConsole(params: Record<string, unknown>, at: number) {
    type RemoteObject = {
      type?: string
      subtype?: string
      value?: unknown
      unserializableValue?: string
      description?: string
      objectId?: string
    }
    const args = (params.args as RemoteObject[]) ?? []
    const raw = String(params.type ?? 'log')
    const level = raw === 'warning' ? 'warn' : raw === 'startGroup' || raw === 'startGroupCollapsed' ? 'group' : raw
    const frame = (
      params.stackTrace as
        { callFrames?: Array<{ url?: string; lineNumber?: number; columnNumber?: number }> } | undefined
    )?.callFrames?.[0]
    const cap = this.consolePolicy.maxMessageChars
    // Store first so arrival order is kept while objects are fetched; fill the text in after.
    const entry = this.recorder.log(level, args.map(describeArg).join(' '), at, 'tv-mcp', {
      origin: 'console',
      ...(frame?.url ? { source: `${frame.url}:${(frame.lineNumber ?? 0) + 1}:${(frame.columnNumber ?? 0) + 1}` } : {}),
    })
    class Rendered {
      constructor(readonly text: string) {}
    }
    const serializer = serializeValue.toString()
    const values = await Promise.all(
      args.map(async (arg): Promise<unknown> => {
        if (arg.type === 'string') return String(arg.value ?? '')
        if (arg.unserializableValue !== undefined) return new Rendered(arg.unserializableValue)
        if (arg.objectId) {
          try {
            const r = (await this.send('Runtime.callFunctionOn', {
              objectId: arg.objectId,
              functionDeclaration: `function () { return (${serializer})(this, ${this.consolePolicy.maxDepth}, ${cap}) }`,
              returnByValue: true,
              silent: true,
            })) as { result?: { value?: unknown } }
            const text = typeof r.result?.value === 'string' ? r.result.value : (arg.description ?? '')
            return new Rendered(redactBody(text, 'application/json', this.policy) ?? text)
          } catch {
            return new Rendered(arg.description ?? arg.type ?? '')
          }
        }
        return arg.value === undefined ? new Rendered(arg.description ?? String(arg.type)) : arg.value
      }),
    )
    const text = formatConsole(values, (v) =>
      v instanceof Rendered ? v.text : typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)),
    )
    const redacted = redactJsonText(text, this.policy)
    this.recorder.setText(entry, redacted.length > cap ? `${redacted.slice(0, cap)}…[truncated]` : redacted)
  }

  /** DevTools' Initiator column: the script, line and function that started the request. */
  private initiatorOf(raw: unknown) {
    const init = raw as
      | {
          type?: string
          url?: string
          lineNumber?: number
          columnNumber?: number
          stack?: {
            callFrames?: Array<{ url?: string; lineNumber?: number; columnNumber?: number; functionName?: string }>
          }
        }
      | undefined
    if (!init?.type) return undefined
    const top = init.stack?.callFrames?.[0]
    return {
      type: init.type,
      ...(top?.url || init.url ? { url: redactUrl(String(top?.url ?? init.url), this.policy) } : {}),
      ...(top?.lineNumber !== undefined || init.lineNumber !== undefined
        ? { line: (top?.lineNumber ?? init.lineNumber ?? 0) + 1 }
        : {}),
      ...(top?.columnNumber !== undefined ? { column: top.columnNumber + 1 } : {}),
      ...(top?.functionName ? { function: top.functionName } : {}),
    }
  }

  private onRequest(params: Record<string, unknown>, at: number) {
    const requestId = String(params.requestId)
    const request = params.request as {
      url?: string
      method?: string
      headers?: Headers
      postData?: string
      hasPostData?: boolean
      initialPriority?: string
    }
    const fullUrl = request?.url ?? ''
    // DevTools lists data: urls too; keep them, cut to something readable.
    const url = fullUrl.startsWith('data:') ? `${fullUrl.slice(0, 120)}…` : fullUrl
    if (!shouldRecord(url, this.policy)) return
    const previous = this.requestIds.get(requestId)
    const redirect = params.redirectResponse as
      { status?: number; statusText?: string; mimeType?: string; headers?: Headers } | undefined
    if (previous && redirect) this.recorder.end(this.endFields(previous, redirect as CdpResponse, at), 'tv-mcp')
    if (Number.isFinite(Number(params.timestamp))) this.monotonic.set(requestId, { start: Number(params.timestamp) })
    const initiatorInfo = this.initiatorOf(params.initiator)
    const seq = ++this.networkSeq
    const id = `cdp-${requestId}${previous ? `~${seq}` : ''}`
    this.requestIds.set(requestId, id)
    const extra = this.pendingRequestExtra.get(requestId)
    this.pendingRequestExtra.delete(requestId)
    const headers = { ...(lowerCase(request?.headers) ?? {}), ...(extra ?? {}) }
    const body = this.policy.bodies ? prepareBody(request?.postData, headers['content-type'] ?? '', this.policy) : {}
    this.recorder.start(
      {
        id,
        seq,
        origin: 'device',
        initiator: 'devtools',
        resourceType: typeof params.type === 'string' ? params.type : undefined,
        ...(initiatorInfo ? { initiatorInfo } : {}),
        ...(request?.initialPriority ? { priority: request.initialPriority } : {}),
        method: request?.method ?? 'GET',
        url: redactUrl(url, this.policy),
        startedAt: at,
        requestHeaders: redactHeaders(headers, this.policy),
        ...(body.body !== undefined ? { requestBody: body.body } : {}),
        ...(body.truncated ? { requestBodyTruncated: true } : {}),
      },
      'tv-mcp',
    )
    // Large posts are not inlined in the event; ask for them.
    if (this.policy.bodies && request?.hasPostData && request.postData === undefined) {
      void this.send('Network.getRequestPostData', { requestId })
        .then((r) => {
          const prepared = prepareBody(
            (r as { postData?: string }).postData,
            headers?.['content-type'] ?? '',
            this.policy,
          )
          this.recorder.patch(id, {
            requestBody: prepared.body,
            ...(prepared.truncated ? { requestBodyTruncated: true } : {}),
          })
        })
        .catch(() => undefined)
    }
  }

  /** Bodies must be read right after loading finishes: the browser drops them on navigation. */
  /**
   * A paused API response: read its body, then always let it continue. Streams and binary are passed straight on,
   * and no response is held longer than HOLD_BODY_MS.
   */
  private async readHeldResponse(params: Record<string, unknown>) {
    const pausedId = String(params.requestId)
    const networkId = params.networkId === undefined ? '' : String(params.networkId)
    const status = Number(params.responseStatusCode)
    const headers = (params.responseHeaders as Array<{ name: string; value: string }> | undefined) ?? []
    const mime = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? ''
    try {
      const readable =
        this.requestIds.has(networkId) &&
        status >= 200 &&
        status < 300 &&
        status !== 204 &&
        !STREAMING_TYPE.test(mime) &&
        !bodyOmission(mime, this.policy)
      if (readable) {
        const r = (await this.send('Fetch.getResponseBody', { requestId: pausedId }, HOLD_BODY_MS)) as {
          body?: string
          base64Encoded?: boolean
        }
        this.held.set(
          networkId,
          r.base64Encoded ? Buffer.from(r.body ?? '', 'base64').toString('utf8') : (r.body ?? ''),
        )
      }
    } catch {
      // Not readable in time (a slow or endless body): the page gets it untouched and getResponseBody is tried later.
    } finally {
      await this.send('Fetch.continueResponse', { requestId: pausedId }).catch(() => undefined)
    }
  }

  private async fetchResponseBody(requestId: string) {
    const id = this.requestIds.get(requestId)
    const record = id ? this.recorder.get(id) : undefined
    const held = this.held.get(requestId)
    this.held.delete(requestId)
    if (!id || !record) return
    // Preflights, 204 and 304 carry no body; the browser has none to return (DevTools shows "no response data").
    if (record.method === 'OPTIONS' || record.status === 204 || record.status === 304) {
      this.recorder.patch(id, { responseBodyOmitted: 'no response body' })
      return
    }
    const omitted = bodyOmission(record.mimeType ?? '', this.policy)
    if (omitted) {
      this.recorder.patch(id, { responseBodyOmitted: omitted })
      return
    }
    if (held !== undefined) {
      const prepared = prepareBody(held, record.mimeType ?? '', this.policy)
      this.recorder.patch(id, {
        responseBody: prepared.body,
        ...(prepared.truncated ? { responseBodyTruncated: true } : {}),
      })
      return
    }
    try {
      const r = (await this.send('Network.getResponseBody', { requestId })) as {
        body?: string
        base64Encoded?: boolean
      }
      if (r.base64Encoded) {
        this.recorder.patch(id, { responseBodyOmitted: 'binary (base64)' })
        return
      }
      const prepared = prepareBody(r.body, record.mimeType ?? '', this.policy)
      this.recorder.patch(id, {
        responseBody: prepared.body,
        ...(prepared.truncated ? { responseBodyTruncated: true } : {}),
      })
    } catch (error) {
      this.recorder.patch(id, { responseBodyOmitted: `unavailable: ${errorMessage(error)}` })
    }
  }

  private onClose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('device disconnected'))
    }
    this.pending.clear()
    this.ws = null
    this.stale = true
  }
}

interface CdpResponse {
  status?: number
  statusText?: string
  mimeType?: string
  headers?: Headers
  remoteIPAddress?: string
  remotePort?: number
  protocol?: string
  fromDiskCache?: boolean
  fromServiceWorker?: boolean
  fromPrefetchCache?: boolean
  timing?: {
    requestTime?: number
    dnsStart?: number
    dnsEnd?: number
    connectStart?: number
    connectEnd?: number
    sslStart?: number
    sslEnd?: number
    sendStart?: number
    sendEnd?: number
    receiveHeadersEnd?: number
  }
}

function lowerCase(headers?: Headers): Headers | undefined {
  if (!headers) return headers
  const out: Headers = {}
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = String(v)
  return out
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`${url} responded ${response.status}`)
  return (await response.json()) as T
}

/**
 * Finds DevTools pages for registry devices with `devtools` set: debuggable Android WebViews over adb,
 * Tizen apps over an sdb-forwarded Web Inspector, or any DevTools HTTP endpoint (`devtools: "http://host:9222"`).
 */
export class CdpClient {
  private forwards = new Map<string, number>()
  private sessions = new Map<string, CdpSession>()

  constructor(
    private readonly registry: () => Promise<DeviceRegistry>,
    private readonly profile: () => Promise<AppProfile>,
  ) {}

  private async alive(port: number): Promise<boolean> {
    try {
      await getJson(`http://127.0.0.1:${port}/json/version`)
      return true
    } catch {
      return false
    }
  }

  private async forward(serial: string, socket: string): Promise<number> {
    const key = `${serial}:${socket}`
    const known = this.forwards.get(key)
    if (known && (await this.alive(known))) return known
    const out = await adb(serial, ['forward', 'tcp:0', `localabstract:${socket}`])
    const port = Number(out.trim())
    if (!Number.isFinite(port) || port <= 0) throw new Error(`adb forward on ${serial} gave "${out}"`)
    this.forwards.set(key, port)
    return port
  }

  /** Pages at a DevTools HTTP endpoint, with their socket urls pointed back at that endpoint. */
  private async pagesAt(base: string, name: string, ip: string, syntheticKeys: boolean): Promise<CdpTarget[]> {
    const [pages, version] = await Promise.all([
      getJson<DevToolsPage[]>(`${base}/json`),
      getJson<Record<string, string>>(`${base}/json/version`).catch(() => ({}) as Record<string, string>),
    ])
    const host = new URL(base).host
    return (
      pages
        // An endpoint also lists DevTools windows, browser UI and extension pages. Block those rather than allow
        // web schemes: a page mid-navigation is briefly listed with an empty url.
        .filter((p) => p.type === 'page' && p.webSocketDebuggerUrl && !BROWSER_PAGE.test(p.url))
        .map((page) => {
          const ws = new URL(page.webSocketDebuggerUrl as string)
          ws.host = host
          return {
            id: `${name}:${page.id}`,
            name,
            title: page.title,
            url: page.url,
            ip,
            userAgent: version['User-Agent'] ?? '',
            wsUrl: ws.href,
            syntheticKeys,
          }
        })
    )
  }

  async listTargets(): Promise<CdpTarget[]> {
    const registry = await this.registry()
    const out: CdpTarget[] = []
    await Promise.all(
      Object.entries(registry).map(async ([name, entry]) => {
        if (!entry.devtools) return
        const synthetic = entry.keys === 'synthetic'
        try {
          if (typeof entry.devtools === 'string') {
            out.push(
              ...(await this.pagesAt(
                entry.devtools.replace(/\/+$/, ''),
                name,
                new URL(entry.devtools).hostname,
                synthetic,
              )),
            )
          } else if (entry.sdb) {
            for (const port of await sdbForwards(entry.sdb)) {
              out.push(...(await this.pagesAt(`http://127.0.0.1:${port}`, name, entry.sdb, synthetic).catch(() => [])))
            }
          } else if (entry.adb) {
            await adbConnect(entry.adb)
            const sockets = (await adb(entry.adb, ['shell', 'cat /proc/net/unix']))
              .split('\n')
              .map((l) => l.match(/(webview_devtools_remote_\d+|chrome_devtools_remote)/)?.[1])
              .filter((s): s is string => Boolean(s))
            for (const socket of [...new Set(sockets)]) {
              const port = await this.forward(entry.adb, socket)
              out.push(...(await this.pagesAt(`http://127.0.0.1:${port}`, name, entry.adb, synthetic)))
            }
          }
        } catch (error) {
          console.error(`[tv-mcp] devtools ${name}: ${errorMessage(error)}`)
        }
      }),
    )
    return out
  }

  /** Match by registry name, target id, or a substring of url, serial or user agent. */
  async resolveTarget(selector?: string): Promise<CdpTarget | undefined> {
    const targets = await this.listTargets()
    if (!selector) return targets.length === 1 ? targets[0] : undefined
    const byId = targets.find((t) => t.id === selector)
    if (byId) return byId
    // A registry name can cover several pages (other tabs); prefer the one its `match` describes.
    const named = targets.filter((t) => t.name === selector)
    if (named.length) {
      const match = (await this.registry())[selector]?.match?.toLowerCase()
      return (
        (match && named.find((t) => [t.url, t.title].some((f) => (f ?? '').toLowerCase().includes(match)))) || named[0]
      )
    }
    const needle = selector.toLowerCase()
    return targets.find((t) =>
      [t.title, t.url, t.ip, t.userAgent].some((f) => (f ?? '').toLowerCase().includes(needle)),
    )
  }

  async session(target: CdpTarget): Promise<CdpSession> {
    let session = this.sessions.get(target.id)
    if (!session) {
      // The forwarded port can change when adb restarts; re-list to get a live endpoint.
      session = new CdpSession(
        target,
        this.profile,
        async () => (await this.resolveTarget(target.id))?.wsUrl ?? target.wsUrl,
      )
      this.sessions.set(target.id, session)
    }
    if (session.target.url !== target.url) session.stale = true
    session.target = target
    if (!session.connected) {
      try {
        await session.connect()
      } catch (error) {
        this.sessions.delete(target.id)
        throw error
      }
    }
    return session
  }

  closeAll() {
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }
}
