// Network exchange records and the capture policy helpers shared by the agent (device side) and the server
// (DevTools side). ES5-safe: the agent bundles this file.
import type { NetworkProfile } from './profile.js'

export type Headers = { [name: string]: string }

/** Who observed the exchange: the device page itself, or an app server that reported it (e.g. SSR fetches). */
export type ExchangeOrigin = 'device' | 'server'

export interface ExchangeStart {
  /** Unique per page load: `<pageId>-<seq>`. */
  id: string
  /** Order of the request start within the page load. */
  seq: number
  origin: ExchangeOrigin
  initiator: 'fetch' | 'xhr' | 'beacon' | 'websocket' | 'resource' | 'devtools' | 'app'
  /** DevTools: Document, Script, Image, XHR, Fetch, Media…; resource timing: img, link, script, css, video… */
  resourceType?: string
  /** Recorded under the agent's built-in policy, before the pack profile arrived (the server re-applies it). */
  bootPolicy?: boolean
  /** DevTools only: what started it (parser, script with its top frame, preload…). */
  initiatorInfo?: { type: string; url?: string; line?: number; column?: number; function?: string }
  priority?: string
  method: string
  url: string
  /** Epoch ms on the clock of `origin`. */
  startedAt: number
  requestHeaders?: Headers
  requestBody?: string
  requestBodyTruncated?: boolean
}

export interface ExchangeEnd {
  id: string
  /** Epoch ms when the response headers arrived (or the request failed). */
  endedAt: number
  status?: number
  statusText?: string
  mimeType?: string
  responseHeaders?: Headers
  responseBody?: string
  responseBodyTruncated?: boolean
  /** Why the body was not captured (policy off, content type, too large, unreadable). */
  responseBodyOmitted?: string
  failed?: string
  /** Bytes on the wire (resource timing transferSize, or the decoded body length). */
  size?: number
  /** DevTools only: bytes on the wire including headers (loadingFinished encodedDataLength). */
  transferSize?: number
  /** DevTools only: phase durations in ms, as the Timing tab shows them. */
  timing?: { [phase: string]: number }
  /** DevTools only. */
  remoteAddress?: string
  protocol?: string
  cache?: 'disk' | 'memory' | 'service-worker' | 'prefetch'
  /** DevTools only: why the browser blocked or failed it (CORS, ORB, mixed content, cancelled…). */
  blockedReason?: string
  corsError?: string
  canceled?: boolean
  /** DevTools only: browser console messages about this request (CORS/ORB explanations, failed loads…). */
  notes?: string[]
  /** WebSocket close. */
  closedAt?: number
  closeCode?: number
}

/** One WebSocket message, attached to the connection's record by id. */
export interface FrameEvent {
  id: string
  dir: 'sent' | 'received'
  at: number
  size: number
  /** Text frames, redacted and capped; binary frames carry only their size. */
  data?: string
  truncated?: boolean
  binary?: boolean
}

/** A complete exchange, as an app reports one through `recordExchange`. */
export type Exchange = Omit<ExchangeStart, 'id' | 'seq'> & Omit<ExchangeEnd, 'id'> & { id?: string }

export const REDACTED = '[redacted]'

function regexes(sources: string[]): RegExp[] {
  const out: RegExp[] = []
  for (let i = 0; i < sources.length; i++) {
    try {
      out.push(new RegExp(sources[i]))
    } catch (e) {
      // an invalid pattern matches nothing
    }
  }
  return out
}

export function shouldRecord(url: string, policy: NetworkProfile): boolean {
  const include = regexes(policy.include)
  const exclude = regexes(policy.exclude)
  for (let i = 0; i < exclude.length; i++) if (exclude[i].test(url)) return false
  if (include.length === 0) return true
  for (let j = 0; j < include.length; j++) if (include[j].test(url)) return true
  return false
}

const NEVER_READ = /^(video|audio|image|font)\/|octet-stream|mpegurl|dash\+xml|mp4|protobuf|zip|pdf/i

/** Null when the body may be read, else the reason it is skipped. */
export function bodyOmission(contentType: string, policy: NetworkProfile, contentLength?: number): string | null {
  if (!policy.bodies) return 'bodies off (profile network.bodies)'
  if (NEVER_READ.test(contentType)) return 'binary or media content type'
  let allowed: RegExp
  try {
    allowed = new RegExp(policy.bodyTypes, 'i')
  } catch (e) {
    allowed = /json|text/i
  }
  if (contentType && !allowed.test(contentType)) return 'content type ' + contentType + ' not in network.bodyTypes'
  // Reading a huge body only to cut it costs memory on the device; skip well past the cap.
  if (contentLength !== undefined && contentLength > policy.maxBodyBytes * 8)
    return 'too large (' + contentLength + ' bytes)'
  return null
}

export function redactHeaders(headers: Headers | undefined, policy: NetworkProfile): Headers | undefined {
  if (!headers) return headers
  const names: { [n: string]: boolean } = {}
  for (let i = 0; i < policy.redactHeaders.length; i++) names[policy.redactHeaders[i].toLowerCase()] = true
  const out: Headers = {}
  for (const k in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, k)) out[k] = names[k.toLowerCase()] ? REDACTED : headers[k]
  }
  return out
}

function keyPattern(policy: NetworkProfile): RegExp | null {
  try {
    return policy.redactKeys ? new RegExp(policy.redactKeys, 'i') : null
  } catch (e) {
    return null
  }
}

function redactValue(value: unknown, pattern: RegExp): unknown {
  if (value instanceof Array) {
    const arr: unknown[] = []
    for (let i = 0; i < value.length; i++) arr.push(redactValue(value[i], pattern))
    return arr
  }
  if (value && typeof value === 'object') {
    const out: { [k: string]: unknown } = {}
    const obj = value as { [k: string]: unknown }
    for (const k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k))
        out[k] =
          pattern.test(k) && obj[k] !== null && typeof obj[k] !== 'object' ? REDACTED : redactValue(obj[k], pattern)
    }
    return out
  }
  return value
}

function redactPairs(text: string, pattern: RegExp): string {
  const parts = text.split('&')
  for (let i = 0; i < parts.length; i++) {
    const eq = parts[i].indexOf('=')
    if (eq <= 0) continue
    let key = parts[i].slice(0, eq)
    try {
      key = decodeURIComponent(key.replace(/\+/g, ' '))
    } catch (e) {
      // keep the raw key
    }
    if (pattern.test(key)) parts[i] = parts[i].slice(0, eq + 1) + encodeURIComponent(REDACTED)
  }
  return parts.join('&')
}

/** Redacts sensitive keys in JSON or form bodies; other text passes through unchanged. */
export function redactBody(body: string | undefined, contentType: string, policy: NetworkProfile): string | undefined {
  if (body === undefined || body === '') return body
  const pattern = keyPattern(policy)
  if (!pattern) return body
  const trimmed = body.replace(/^\s+/, '')
  if (/json/i.test(contentType) || trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
    try {
      return JSON.stringify(redactValue(JSON.parse(body), pattern))
    } catch (e) {
      // not JSON after all
    }
  }
  if (/x-www-form-urlencoded/i.test(contentType) || /^[^\s=&]+=[^\s]*(&[^\s=&]+=[^\s]*)*$/.test(body))
    return redactPairs(body, pattern)
  // JSON that does not parse (cut by a size cap): redact "key": scalar pairs textually.
  if (/json/i.test(contentType) || trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[')
    return redactJsonText(body, policy)
  return body
}

/**
 * Redacts `"key": scalar` pairs wherever they appear in text (console messages that embed JSON, or JSON cut by a
 * size cap), plus sensitive query parameters in any urls in it.
 */
export function redactJsonText(text: string, policy: NetworkProfile): string {
  const pattern = keyPattern(policy)
  if (!pattern) return text
  return text.replace(
    /"((?:[^"\\]|\\.)*)"(\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*|true|false)/g,
    (m: string, key: string, sep: string) => (pattern.test(key) ? '"' + key + '"' + sep + '"' + REDACTED + '"' : m),
  )
}

/** Redacts sensitive query parameters, e.g. tokens passed in urls. */
export function redactUrl(url: string, policy: NetworkProfile): string {
  const pattern = keyPattern(policy)
  const q = url.indexOf('?')
  if (!pattern || q === -1) return url
  const hash = url.indexOf('#', q)
  const query = hash === -1 ? url.slice(q + 1) : url.slice(q + 1, hash)
  return url.slice(0, q + 1) + redactPairs(query, pattern) + (hash === -1 ? '' : url.slice(hash))
}

export function truncate(body: string | undefined, policy: NetworkProfile): { body?: string; truncated?: boolean } {
  if (body === undefined) return {}
  if (body.length <= policy.maxBodyBytes) return { body }
  return { body: body.slice(0, policy.maxBodyBytes), truncated: true }
}

/** Redact, then cut to the cap (redaction first, so a cut never hides a key from the redactor). */
export function prepareBody(
  body: string | undefined,
  contentType: string,
  policy: NetworkProfile,
): { body?: string; truncated?: boolean } {
  return truncate(redactBody(body, contentType, policy), policy)
}

/** `a: b\r\nc: d` (XHR getAllResponseHeaders) to a header map with lower-case names. */
export function parseHeaderLines(raw: string): Headers {
  const out: Headers = {}
  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].indexOf(':')
    if (idx <= 0) continue
    out[
      lines[i]
        .slice(0, idx)
        .replace(/^\s+|\s+$/g, '')
        .toLowerCase()
    ] = lines[i].slice(idx + 1).replace(/^\s+|\s+$/g, '')
  }
  return out
}
