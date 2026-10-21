// The in-app agent: a small WebSocket client that registers the page with the relay, answers calls from
// MCP servers and pushes focus, route, console and network events. Include it in test builds only; it
// can evaluate arbitrary script on behalf of whoever holds the relay's client token.
import { detectPlatform, resolveProfile } from '@tv-mcp/protocol'

import { captureConsole } from './capture.js'
import { DomReader } from './dom.js'
import { createKeyInput } from './input.js'
import { installNetworkCapture, NativeWebSocket } from './network.js'
import { clearStorage } from './storage.js'

import { prepareBody, redactHeaders, redactUrl } from '@tv-mcp/protocol'

import type { AgentMethod, AppProfile, DeepPartial, Exchange, KeyCodes } from '@tv-mcp/protocol'

export const AGENT_VERSION = '0.1.0'

export interface AgentHooks {
  /** Deliver a remote key through the app's own input layer instead of a synthetic DOM event. */
  pressKey?: (key: string, options: { holdMs: number }) => { keyCode?: number; error?: string }
  /** The app's live key map (key name → code), preferred over the built-in platform tables. */
  keyCodes?: () => KeyCodes
  /** Server-side sign-out run before a storage wipe, so HttpOnly session cookies are expired too. */
  signOut?: () => Promise<unknown>
  /** Replace the built-in storage wipe entirely. */
  clearStorage?: (reload: boolean) => Promise<unknown>
}

export interface AgentOptions {
  /** Relay base url, e.g. http://10.0.0.5:8080. */
  relayUrl: string
  /** Device token, when the relay was started with TVMCP_DEVICE_TOKEN. */
  token?: string
  /** Stable device name. Default: ?tvmcp=<name>, then the stored name, then `<platform>-<random>`. */
  name?: string
  platform?: string
  /** Build identifier reported to clients. */
  build?: string
  profile?: DeepPartial<AppProfile>
  hooks?: AgentHooks
  /** Forward console.* calls (exceptions are always forwarded). Default true. */
  captureConsole?: boolean
  /** Record fetch/XHR/beacon requests (bodies per the profile's network policy). Default true. */
  captureNetwork?: boolean
}

export interface AgentHandle {
  name: string
  /**
   * Report an exchange the page did not make itself, e.g. a server-side (SSR) fetch collected by the app server.
   * Redaction and size limits apply as for device requests; origin defaults to "server".
   */
  recordExchange(exchange: Exchange): void
  stop(): void
}

const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 30000
const ROUTE_POLL_MS = 500
const NAME_KEY = 'tvmcpName'
/** The last profile a server sent, so the next page load starts with it (bodies at boot, guards…). */
const PROFILE_KEY = 'tvmcpProfile'
/** Events raised before the socket is open (page startup requests) wait here, oldest dropped first. */
const OFFLINE_QUEUE_MAX = 500

function storedName(): string | null {
  try {
    return localStorage.getItem(NAME_KEY)
  } catch (e) {
    return null
  }
}

function queryParam(name: string): string | null {
  const match = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search)
  return match ? decodeURIComponent(match[1]) : null
}

function storedProfile(): DeepPartial<AppProfile> | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY)
    return raw ? (JSON.parse(raw) as DeepPartial<AppProfile>) : null
  } catch (e) {
    return null
  }
}

export function resolveAgentName(platform: string, explicit?: string): string {
  const name =
    explicit || queryParam('tvmcp') || storedName() || platform + '-' + Math.random().toString(36).slice(2, 6)
  try {
    localStorage.setItem(NAME_KEY, name)
  } catch (e) {
    // storage unavailable: the name lasts until reload
  }
  return name
}

function socketUrl(relayUrl: string, params: { [k: string]: string }): string {
  const base = relayUrl.replace(/\/+$/, '').replace(/^http/, 'ws')
  const query: string[] = []
  for (const k in params) if (params[k]) query.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
  return base + '/agent/device?' + query.join('&')
}

function settle(value: unknown): Promise<unknown> {
  return value && typeof (value as Promise<unknown>).then === 'function'
    ? (value as Promise<unknown>)
    : Promise.resolve(value)
}

export function startAgent(options: AgentOptions): AgentHandle {
  if (!NativeWebSocket) throw new Error('tv-mcp agent needs WebSocket')
  const Socket = NativeWebSocket
  const saved = storedProfile()
  let profile = resolveProfile(options.profile || saved)
  // Until a pack profile is known, capture with bodies on (built-in caps and redaction); the server re-applies
  // the pack policy to these records, so the very first page load is as complete as every later one.
  let configured = Boolean(options.profile || saved)
  const effectivePolicy = () => (configured ? profile.network : { ...profile.network, bodies: true })
  const platform = options.platform || detectPlatform(navigator.userAgent)
  const name = resolveAgentName(platform, options.name)
  const hooks = options.hooks || {}
  let dom = new DomReader(profile)
  let input = createKeyInput(profile, platform, hooks.keyCodes)

  let ws: WebSocket | null = null
  let stopped = false
  let backoff = BACKOFF_MIN_MS
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let lastUrl = location.href

  const queue: string[] = []
  const send = (message: unknown) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(message))
  }
  // `at` is the device clock at send time; the server derives the device clock offset from it.
  const event = (eventName: string, data: unknown) => {
    const message = JSON.stringify({ type: 'event', event: eventName, data, at: Date.now() })
    if (ws && ws.readyState === 1) ws.send(message)
    else {
      queue.push(message)
      if (queue.length > OFFLINE_QUEUE_MAX) queue.shift()
    }
  }
  const flush = () => {
    while (queue.length && ws && ws.readyState === 1) ws.send(queue.shift() as string)
  }

  const handle = (method: AgentMethod, params: { [k: string]: unknown }): unknown => {
    switch (method) {
      case 'ping':
        return 'pong'
      case 'configure': {
        const next = resolveProfile(params.profile as DeepPartial<AppProfile>)
        try {
          localStorage.setItem(PROFILE_KEY, JSON.stringify(params.profile))
        } catch (e) {
          // storage unavailable: the profile lasts until reload
        }
        document.removeEventListener(profile.focus.focusEvent, onFocused, true)
        const w = window as unknown as { [k: string]: unknown }
        if (w[profile.bridgeGlobal] === bridge) delete w[profile.bridgeGlobal]
        profile = next
        configured = true
        dom = new DomReader(profile)
        input = createKeyInput(profile, platform, hooks.keyCodes)
        document.addEventListener(profile.focus.focusEvent, onFocused, true)
        w[profile.bridgeGlobal] = bridge
        return { configured: profile.name }
      }
      case 'eval': {
        const value = new Function('return (' + String(params.expression) + ')')()
        return value === undefined ? null : value
      }
      case 'pressKey': {
        const key = String(params.key)
        const holdMs = Number(params.holdMs || 0)
        return hooks.pressKey ? hooks.pressKey(key, { holdMs }) : input.press(key, holdMs)
      }
      case 'holdKey':
        return input.hold(String(params.key), Number(params.repeatMs || 0))
      case 'releaseKey':
        return input.release(String(params.key))
      case 'focus':
        return dom.focusSummary()
      case 'snapshot':
        return dom.snapshot(Number(params.maxElements || 12))
      case 'keyboard':
        return dom.keyboardLayout()
      case 'readText':
        return dom.readText(String(params.selector || 'body'), Number(params.maxChars || 4000))
      case 'condition':
        return dom.condition(params)
      case 'playerState':
        return dom.playerState()
      case 'storageKeys':
        return dom.storageKeys()
      case 'navigate':
        // Never location.assign(): some console browsers open a new window for it.
        setTimeout(() => {
          location.href = String(params.url)
        }, 0)
        return { navigating: params.url }
      case 'clearStorage': {
        const reload = params.reload !== false
        const keep: { [k: string]: string } = { [NAME_KEY]: name }
        try {
          const saved = localStorage.getItem(PROFILE_KEY)
          if (saved) keep[PROFILE_KEY] = saved
        } catch (e) {
          // storage unavailable
        }
        if (!hooks.clearStorage) return clearStorage(reload, hooks.signOut, keep)
        return settle(hooks.clearStorage(reload)).then((result) => {
          try {
            localStorage.setItem(NAME_KEY, name)
            if (keep[PROFILE_KEY]) localStorage.setItem(PROFILE_KEY, keep[PROFILE_KEY])
          } catch (e) {
            // storage unavailable
          }
          return result
        })
      }
      default:
        throw new Error('unknown method ' + method)
    }
  }

  const onMessage = (raw: MessageEvent) => {
    let message: { type?: string; id?: number; method?: AgentMethod; params?: { [k: string]: unknown } }
    try {
      message = JSON.parse(String(raw.data))
    } catch (e) {
      return
    }
    if (message.type === 'ping') {
      send({ type: 'pong' })
      return
    }
    if (message.type !== 'call' || !message.method) return
    const id = message.id
    let result: Promise<unknown>
    try {
      result = settle(handle(message.method, message.params || {}))
    } catch (error) {
      result = Promise.reject(error)
    }
    result.then(
      (value) => send({ type: 'result', id, ok: true, value }),
      (error) => send({ type: 'result', id, ok: false, error: error instanceof Error ? error.message : String(error) }),
    )
  }

  const onFocused = () => event('focus', dom.focusSummary())
  const checkRoute = () => {
    if (location.href === lastUrl) return
    lastUrl = location.href
    event('route', { url: lastUrl })
  }
  const routeTimer = setInterval(checkRoute, ROUTE_POLL_MS)

  const uninstallConsole = captureConsole(
    (e) => event('console', e),
    options.captureConsole !== false,
    () => profile.console,
    effectivePolicy,
  )
  const network =
    options.captureNetwork === false
      ? null
      : installNetworkCapture(
          {
            start: (e) => event('request', e),
            end: (e) => event('response', e),
            exchange: (e) => event('exchange', e),
            frame: (f) => event('frame', f),
          },
          effectivePolicy,
          () => !configured,
          options.relayUrl.replace(/^ws/, 'http'),
        )
  let serverSeq = 0
  const recordExchange = (x: Exchange) => {
    const p = profile.network
    const contentType =
      (x.responseHeaders && (x.responseHeaders['content-type'] || x.responseHeaders['Content-Type'])) || ''
    const reqType = (x.requestHeaders && (x.requestHeaders['content-type'] || x.requestHeaders['Content-Type'])) || ''
    const req = p.bodies ? prepareBody(x.requestBody, reqType, p) : {}
    const res = p.bodies ? prepareBody(x.responseBody, contentType, p) : {}
    const n = ++serverSeq
    event('exchange', {
      ...x,
      id: x.id || (network ? network.pageId : 'page') + '-x' + n,
      seq: n,
      origin: x.origin || 'server',
      initiator: x.initiator || 'app',
      url: redactUrl(x.url, p),
      requestHeaders: redactHeaders(x.requestHeaders, p),
      responseHeaders: redactHeaders(x.responseHeaders, p),
      requestBody: req.body,
      requestBodyTruncated: req.truncated,
      responseBody: res.body,
      responseBodyTruncated: res.truncated,
      ...(p.bodies ? {} : { responseBodyOmitted: 'bodies off (profile network.bodies)' }),
    })
  }

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, backoff)
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
  }

  function connect() {
    if (stopped) return
    try {
      ws = new Socket(
        socketUrl(options.relayUrl, {
          name,
          platform,
          build: options.build || '',
          url: location.href,
          token: options.token || '',
        }),
      )
    } catch (e) {
      scheduleReconnect()
      return
    }
    ws.onopen = () => {
      backoff = BACKOFF_MIN_MS
      send({
        type: 'hello',
        name,
        platform,
        build: options.build || '',
        url: location.href,
        agentVersion: AGENT_VERSION,
        state: { focus: dom.focusSummary(), route: { url: location.href } },
      })
      flush()
    }
    ws.onmessage = onMessage
    ws.onclose = scheduleReconnect
  }

  document.addEventListener(profile.focus.focusEvent, onFocused, true)
  window.addEventListener('hashchange', checkRoute)
  window.addEventListener('popstate', checkRoute)
  connect()

  const bridge = {
    version: AGENT_VERSION,
    name,
    pressKey: (key: string, opts?: { holdMs?: number }) =>
      hooks.pressKey
        ? hooks.pressKey(key, { holdMs: (opts && opts.holdMs) || 0 })
        : input.press(key, (opts && opts.holdMs) || 0),
    recordExchange,
  }
  ;(window as unknown as { [k: string]: unknown })[profile.bridgeGlobal] = bridge

  return {
    name,
    recordExchange,
    stop() {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      clearInterval(routeTimer)
      document.removeEventListener(profile.focus.focusEvent, onFocused, true)
      window.removeEventListener('hashchange', checkRoute)
      window.removeEventListener('popstate', checkRoute)
      uninstallConsole()
      if (network) network.uninstall()
      const w = window as unknown as { [k: string]: unknown }
      if (w[profile.bridgeGlobal] === bridge) delete w[profile.bridgeGlobal]
      if (ws) ws.close()
    },
  }
}
