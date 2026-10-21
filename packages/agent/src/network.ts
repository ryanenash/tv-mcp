// Device-side network capture: fetch, XMLHttpRequest and sendBeacon. Every request gets a page-unique id and
// sequence number when it starts, so records can be listed in request order with in-flight ones still visible;
// the response (status, headers, body, timing) is attached to the same id when it ends.
import { bodyOmission, parseHeaderLines, prepareBody, redactHeaders, redactUrl, shouldRecord } from '@tv-mcp/protocol'

import type { ExchangeEnd, ExchangeStart, FrameEvent, Headers, NetworkProfile } from '@tv-mcp/protocol'

export interface NetworkSink {
  start(e: ExchangeStart): void
  end(e: ExchangeEnd): void
  /** A complete record in one event (resource timing, failed element loads). */
  exchange(e: ExchangeStart & ExchangeEnd): void
  frame(f: FrameEvent): void
}

/** The agent's own relay socket must not be wrapped; it keeps the constructor from before installation. */
export const NativeWebSocket: typeof WebSocket | undefined = typeof WebSocket !== 'undefined' ? WebSocket : undefined
const MAX_FRAMES_PER_SOCKET = 200
const MAX_FRAME_CHARS = 4096
const RESOURCE_POLL_MS = 2000

export interface NetworkCapture {
  pageId: string
  nextSeq(): number
  uninstall(): void
}

const anchor = typeof document !== 'undefined' ? document.createElement('a') : null

/** Absolute url without relying on URL (missing on old engines). */
function absolute(url: string): string {
  if (!anchor) return url
  anchor.href = url
  return anchor.href
}

function lower(headers: Headers): Headers {
  const out: Headers = {}
  for (const k in headers) if (Object.prototype.hasOwnProperty.call(headers, k)) out[k.toLowerCase()] = headers[k]
  return out
}

type HeaderSource = { forEach?: (cb: (value: string, key: string) => void) => void } | string[][] | Headers | undefined

function collectHeaders(source: HeaderSource, into: Headers): Headers {
  if (!source) return into
  const withForEach = source as { forEach?: (cb: (value: string, key: string) => void) => void }
  if (source instanceof Array) {
    for (let i = 0; i < source.length; i++)
      if (source[i] && source[i].length >= 2) into[String(source[i][0]).toLowerCase()] = String(source[i][1])
  } else if (typeof withForEach.forEach === 'function') {
    withForEach.forEach((value, key) => {
      into[key.toLowerCase()] = value
    })
  } else {
    const plain = lower(source as Headers)
    for (const k in plain) into[k] = plain[k]
  }
  return into
}

function byteLength(value: unknown): number | undefined {
  const v = value as { size?: number; byteLength?: number }
  if (typeof v.size === 'number') return v.size
  if (typeof v.byteLength === 'number') return v.byteLength
  return undefined
}

/** Text of a request body as sent; binary bodies are described, not read. */
function describeBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString()
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const fields: string[] = []
    const form = body as FormData & { forEach?: (cb: (value: unknown, key: string) => void) => void }
    if (typeof form.forEach === 'function')
      form.forEach((value, key) =>
        fields.push(encodeURIComponent(key) + '=' + (typeof value === 'string' ? encodeURIComponent(value) : '[file]')),
      )
    return fields.length ? fields.join('&') : '[form-data]'
  }
  const size = byteLength(body)
  if (size !== undefined) return '[binary ' + size + ' bytes]'
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return '[stream]'
  return String(body)
}

function contentTypeOf(headers: Headers | undefined): string {
  return (headers && headers['content-type']) || ''
}

/**
 * `policy` is the effective capture policy; `isBoot` is true while it is the agent's built-in one (before the
 * pack profile arrived), which marks records so the server re-applies the pack policy to them.
 */
export function installNetworkCapture(
  sink: NetworkSink,
  policy: () => NetworkProfile,
  isBoot: () => boolean,
  exclude: string,
): NetworkCapture {
  const pageId = Math.random().toString(36).slice(2, 8)
  let seq = 0
  const nextSeq = () => ++seq
  const w = window as unknown as {
    fetch?: typeof fetch
    XMLHttpRequest: typeof XMLHttpRequest
    Request?: typeof Request
    navigator: Navigator
  }
  const skip = (url: string) => (exclude && url.indexOf(exclude) === 0) || !shouldRecord(url, policy())

  const startRecord = (
    initiator: ExchangeStart['initiator'],
    method: string,
    url: string,
    headers: Headers | undefined,
    body: string | undefined,
  ): ExchangeStart => {
    const p = policy()
    const n = nextSeq()
    const prepared = p.bodies ? prepareBody(body, contentTypeOf(headers), p) : {}
    return {
      id: pageId + '-' + n,
      seq: n,
      origin: 'device',
      initiator,
      method: method.toUpperCase(),
      url: redactUrl(url, p),
      startedAt: Date.now(),
      ...(isBoot() ? { bootPolicy: true } : {}),
      requestHeaders: redactHeaders(headers, p),
      ...(prepared.body !== undefined ? { requestBody: prepared.body } : {}),
      ...(prepared.truncated ? { requestBodyTruncated: true } : {}),
    }
  }

  // ── fetch ──────────────────────────────────────────────────────────────────────────────────────────
  const originalFetch = w.fetch
  if (originalFetch) {
    w.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const isRequest = !!w.Request && input instanceof w.Request
      const raw =
        typeof input === 'string' ? input : isRequest ? (input as Request).url : String((input as URL).href || input)
      const url = absolute(raw)
      if (skip(url)) return originalFetch.call(window, input, init)
      const method = (init && init.method) || (isRequest ? (input as Request).method : 'GET')
      const headers = collectHeaders(
        init && (init.headers as HeaderSource),
        isRequest ? collectHeaders((input as Request).headers as HeaderSource, {}) : {},
      )
      const explicitBody = init && init.body !== undefined ? describeBody(init.body) : undefined
      // A Request carries its own body (ky and similar clients send one); read a clone so the original is untouched.
      const fromRequest =
        explicitBody === undefined && isRequest && policy().bodies && !/^(GET|HEAD)$/i.test(method)
          ? (input as Request)
              .clone()
              .text()
              .then(
                (t) => t,
                () => '[unreadable body]',
              )
          : Promise.resolve(explicitBody)
      // Number the request now, so concurrent requests keep their start order whatever the body read takes.
      const record = startRecord('fetch', method, url, headers, undefined)
      const started = fromRequest.then((body) => {
        const p = policy()
        const prepared = p.bodies ? prepareBody(body, contentTypeOf(headers), p) : {}
        if (prepared.body !== undefined) record.requestBody = prepared.body
        if (prepared.truncated) record.requestBodyTruncated = true
        sink.start(record)
      })
      return originalFetch.call(window, input, init).then(
        (response) => {
          const endedAt = Date.now()
          const p = policy()
          const responseHeaders = collectHeaders(response.headers as unknown as HeaderSource, {})
          const contentType = contentTypeOf(responseHeaders)
          const length = Number(responseHeaders['content-length'])
          const omitted = bodyOmission(contentType, p, isFinite(length) && length > 0 ? length : undefined)
          const base: ExchangeEnd = {
            id: record.id,
            endedAt,
            status: response.status,
            statusText: response.statusText,
            mimeType: contentType.split(';')[0] || undefined,
            responseHeaders: redactHeaders(responseHeaders, p),
          }
          // Clone before handing the response back, so the app's own read is unaffected.
          const body: Promise<ExchangeEnd> = omitted
            ? Promise.resolve({ ...base, responseBodyOmitted: omitted })
            : response
                .clone()
                .text()
                .then(
                  (text) => {
                    const prepared = prepareBody(text, contentType, p)
                    return {
                      ...base,
                      responseBody: prepared.body,
                      ...(prepared.truncated ? { responseBodyTruncated: true } : {}),
                    }
                  },
                  () => ({ ...base, responseBodyOmitted: 'unreadable' }),
                )
          started.then(() => body).then((e) => sink.end(e))
          return response
        },
        (error) => {
          const endedAt = Date.now()
          started.then(() => sink.end({ id: record.id, endedAt, failed: String((error && error.message) || error) }))
          throw error
        },
      )
    } as typeof fetch
  }

  // ── XMLHttpRequest ─────────────────────────────────────────────────────────────────────────────────
  const proto = w.XMLHttpRequest.prototype
  const open = proto.open
  const send = proto.send
  const setRequestHeader = proto.setRequestHeader
  type Tracked = XMLHttpRequest & { __tvmcp?: { method: string; url: string; headers: Headers } }
  proto.open = function (this: Tracked, method: string, url: string | URL) {
    this.__tvmcp = { method, url: absolute(String(url)), headers: {} }
    return open.apply(this, arguments as unknown as Parameters<typeof open>)
  } as typeof open
  proto.setRequestHeader = function (this: Tracked, name: string, value: string) {
    if (this.__tvmcp) this.__tvmcp.headers[name.toLowerCase()] = value
    return setRequestHeader.call(this, name, value)
  }
  proto.send = function (this: Tracked, body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = this.__tvmcp
    if (meta && !skip(meta.url)) {
      const record = startRecord('xhr', meta.method, meta.url, meta.headers, describeBody(body))
      sink.start(record)
      const xhr = this
      this.addEventListener('loadend', () => {
        const endedAt = Date.now()
        const p = policy()
        if (!xhr.status) {
          sink.end({ id: record.id, endedAt, failed: 'network error or aborted' })
          return
        }
        const responseHeaders = parseHeaderLines(xhr.getAllResponseHeaders() || '')
        const contentType = contentTypeOf(responseHeaders)
        const type = xhr.responseType
        let omitted = bodyOmission(contentType, p)
        let text: string | undefined
        if (!omitted) {
          if (type === '' || type === 'text') text = xhr.responseText
          else if (type === 'json') text = JSON.stringify(xhr.response)
          else omitted = 'responseType ' + type
        }
        const prepared = text !== undefined ? prepareBody(text, contentType, p) : {}
        sink.end({
          id: record.id,
          endedAt,
          status: xhr.status,
          statusText: xhr.statusText,
          mimeType: contentType.split(';')[0] || undefined,
          responseHeaders: redactHeaders(responseHeaders, p),
          ...(prepared.body !== undefined ? { responseBody: prepared.body } : {}),
          ...(prepared.truncated ? { responseBodyTruncated: true } : {}),
          ...(omitted ? { responseBodyOmitted: omitted } : {}),
        })
      })
    }
    return send.apply(this, arguments as unknown as Parameters<typeof send>)
  }

  // ── sendBeacon (analytics) ────────────────────────────────────────────────────────────────────────
  const nav = w.navigator as Navigator & { sendBeacon?: (url: string, data?: BodyInit | null) => boolean }
  const originalBeacon = nav.sendBeacon
  if (typeof originalBeacon === 'function') {
    nav.sendBeacon = function (url: string, data?: BodyInit | null) {
      const queued = originalBeacon.call(nav, url, data)
      const full = absolute(url)
      if (!skip(full)) {
        const record = startRecord('beacon', 'POST', full, undefined, describeBody(data))
        sink.start(record)
        sink.end({
          id: record.id,
          endedAt: Date.now(),
          responseBodyOmitted: 'beacon (no response)',
          ...(queued ? {} : { failed: 'not queued' }),
        })
      }
      return queued
    }
  }

  // ── Everything else the page loads: resource timing (images, scripts, styles, media, and anything that
  // loaded before this script ran) and element load errors ─────────────────────────────────────────
  const perf = (window as unknown as { performance?: Performance }).performance
  const timeOrigin =
    perf && typeof perf.timeOrigin === 'number'
      ? perf.timeOrigin
      : perf && perf.timing
        ? perf.timing.navigationStart
        : Date.now()
  const installedAt = perf && perf.now ? perf.now() : 0
  // fetch/xhr/beacon entries after installation are recorded by the hooks above, with bodies.
  const hooked: { [type: string]: boolean } = { fetch: true, xmlhttprequest: true, beacon: true }
  let resourceSeq = 0
  const recordResource = (entry: PerformanceResourceTiming) => {
    if (hooked[entry.initiatorType] && entry.startTime >= installedAt) return
    if (entry.name.indexOf('data:') === 0 || skip(entry.name)) return
    const p = policy()
    const status = (entry as PerformanceResourceTiming & { responseStatus?: number }).responseStatus
    const size = entry.transferSize || entry.encodedBodySize || undefined
    sink.exchange({
      id: pageId + '-r' + ++resourceSeq,
      seq: nextSeq(),
      origin: 'device',
      initiator: 'resource',
      resourceType: entry.initiatorType || 'other',
      method: 'GET',
      url: redactUrl(entry.name, p),
      startedAt: Math.round(timeOrigin + entry.startTime),
      endedAt: Math.round(timeOrigin + (entry.responseEnd || entry.startTime + entry.duration)),
      ...(status ? { status } : {}),
      ...(size ? { size } : {}),
      responseBodyOmitted: hooked[entry.initiatorType]
        ? 'made before the agent loaded (resource timing only)'
        : 'resource timing (no body or headers)',
    })
  }
  let observer: PerformanceObserver | null = null
  let resourceTimer: ReturnType<typeof setInterval> | null = null
  const onBufferFull = () => {
    if (perf && perf.clearResourceTimings) perf.clearResourceTimings()
  }
  if (perf && typeof perf.getEntriesByType === 'function') {
    try {
      if (perf.setResourceTimingBufferSize) perf.setResourceTimingBufferSize(1000)
    } catch (e) {
      // keep the default buffer
    }
    const PO = (window as unknown as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver
    let observed = false
    if (PO) {
      try {
        observer = new PO((list) => {
          const entries = list.getEntries() as PerformanceResourceTiming[]
          for (let i = 0; i < entries.length; i++) recordResource(entries[i])
        })
        // buffered: entries from before installation (the page's first loads) are delivered too.
        observer.observe({ type: 'resource', buffered: true } as PerformanceObserverInit)
        observed = true
      } catch (e) {
        observer = null
      }
    }
    if (!observed) {
      // Engines without PerformanceObserver: poll the buffer.
      let seen = 0
      const poll = () => {
        const entries = perf.getEntriesByType('resource') as PerformanceResourceTiming[]
        if (entries.length < seen) seen = 0
        for (let i = seen; i < entries.length; i++) recordResource(entries[i])
        seen = entries.length
      }
      poll()
      resourceTimer = setInterval(poll, RESOURCE_POLL_MS)
    } else if (perf.addEventListener) {
      perf.addEventListener('resourcetimingbufferfull', onBufferFull)
    }
  }
  // Element load errors do not bubble; listen in the capture phase.
  const onElementError = (e: Event) => {
    const el = e.target as (HTMLElement & { src?: string; href?: string; currentSrc?: string }) | null
    if (!el || !el.tagName) return
    const url = el.currentSrc || el.src || el.href
    if (!url || skip(absolute(url))) return
    const now = Date.now()
    sink.exchange({
      id: pageId + '-e' + ++resourceSeq,
      seq: nextSeq(),
      origin: 'device',
      initiator: 'resource',
      resourceType: el.tagName.toLowerCase(),
      method: 'GET',
      url: redactUrl(absolute(url), policy()),
      startedAt: now,
      endedAt: now,
      failed: 'load error (' + el.tagName.toLowerCase() + ')',
    })
  }
  window.addEventListener('error', onElementError, true)

  // ── WebSocket: the connection as a record, each message as a frame ─────────────────────────────────
  const OriginalWS = NativeWebSocket
  let wsWrapped = false
  if (OriginalWS) {
    const frameText = (data: unknown): { data?: string; size: number; binary?: boolean; truncated?: boolean } => {
      if (typeof data === 'string') {
        const p = policy()
        const prepared = prepareBody(data, '', { ...p, maxBodyBytes: Math.min(p.maxBodyBytes, MAX_FRAME_CHARS) })
        return { data: prepared.body, size: data.length, ...(prepared.truncated ? { truncated: true } : {}) }
      }
      return { size: byteLength(data) || 0, binary: true }
    }
    const Wrapped = function (url: string | URL, protocols?: string | string[]) {
      const socket = protocols === undefined ? new OriginalWS(url) : new OriginalWS(url, protocols)
      const full = String(url)
      if (skip(full.replace(/^ws/, 'http'))) return socket
      const record = startRecord('websocket', 'GET', full, undefined, undefined)
      sink.start(record)
      let frames = 0
      const frame = (dir: 'sent' | 'received', data: unknown) => {
        if (++frames > MAX_FRAMES_PER_SOCKET) return
        sink.frame({ id: record.id, dir, at: Date.now(), ...frameText(data) })
      }
      socket.addEventListener('open', () =>
        sink.end({ id: record.id, endedAt: Date.now(), status: 101, statusText: 'Switching Protocols' }),
      )
      socket.addEventListener('message', (e: MessageEvent) => frame('received', e.data))
      socket.addEventListener('error', () =>
        sink.end({ id: record.id, endedAt: Date.now(), failed: 'websocket error' }),
      )
      socket.addEventListener('close', (e: CloseEvent) =>
        sink.end({ id: record.id, endedAt: Date.now(), closedAt: Date.now(), closeCode: e.code }),
      )
      const send = socket.send
      socket.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        frame('sent', data)
        return send.call(socket, data)
      }
      return socket
    } as unknown as typeof WebSocket
    Wrapped.prototype = OriginalWS.prototype
    const constants = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']
    for (let i = 0; i < constants.length; i++) {
      try {
        Object.defineProperty(Wrapped, constants[i], {
          value: (OriginalWS as unknown as { [k: string]: number })[constants[i]],
        })
      } catch (e) {
        // read-only on this engine
      }
    }
    ;(window as unknown as { WebSocket: typeof WebSocket }).WebSocket = Wrapped
    wsWrapped = true
  }

  return {
    pageId,
    nextSeq,
    uninstall() {
      if (observer) observer.disconnect()
      if (resourceTimer) clearInterval(resourceTimer)
      if (perf && perf.removeEventListener) perf.removeEventListener('resourcetimingbufferfull', onBufferFull)
      window.removeEventListener('error', onElementError, true)
      if (wsWrapped && OriginalWS) (window as unknown as { WebSocket: typeof WebSocket }).WebSocket = OriginalWS
      if (originalFetch) w.fetch = originalFetch
      proto.open = open
      proto.send = send
      proto.setRequestHeader = setRequestHeader
      if (typeof originalBeacon === 'function') nav.sendBeacon = originalBeacon
    },
  }
}
