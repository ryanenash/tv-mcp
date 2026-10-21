import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { config } from './config.js'

import type { Recorder } from './recorder.js'

/** Tool results above this are written to a file instead; MCP clients drop oversized messages (16 MB in Claude Code). */
export const MAX_RESULT_CHARS = Number(process.env.TVMCP_MAX_RESULT_CHARS ?? 1_000_000)

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
const safe = (name: string) => name.replace(/[^\w.-]+/g, '_').slice(0, 60)

/** Writes an oversized tool result to <reports>/results/ and returns a small pointer the client can follow. */
export async function spill(toolName: string, text: string) {
  const dir = path.join(config.reportsDir, 'results')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${stamp()}-${safe(toolName)}.json`)
  await writeFile(file, text)
  return {
    spilledTo: file,
    chars: text.length,
    note: `Result larger than ${MAX_RESULT_CHARS} characters; written to the file instead. Narrow the call (urlPattern, limit, sinceMs, id) or use export_capture for the whole capture.`,
  }
}

type Headers = Record<string, string> | undefined
const harHeaders = (h: Headers) => Object.entries(h ?? {}).map(([name, value]) => ({ name, value }))

function queryString(url: string) {
  try {
    return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value }))
  } catch {
    return []
  }
}

/**
 * HAR 1.2, as DevTools "Save all as HAR" writes it, including Chrome's underscore fields (_resourceType,
 * _initiator, _priority). Unknown timings are -1, as the spec asks.
 */
export function toHar(recorder: Recorder, device: string, version: string) {
  const entries = recorder.allRecords().map((r) => {
    const t = r.timing ?? {}
    const phase = (k: string) => (typeof t[k] === 'number' ? t[k] : -1)
    const total = typeof t.total === 'number' ? t.total : (r.ms ?? 0)
    const reqType = r.requestHeaders?.['content-type'] ?? ''
    return {
      startedDateTime: r.startedAt,
      time: total,
      request: {
        method: r.method,
        url: r.url,
        httpVersion: r.protocol ?? '',
        headers: harHeaders(r.requestHeaders),
        queryString: queryString(r.url),
        cookies: [],
        headersSize: -1,
        bodySize: r.requestBody?.length ?? 0,
        ...(r.requestBody !== undefined ? { postData: { mimeType: reqType, text: r.requestBody } } : {}),
      },
      response: {
        status: r.status ?? 0,
        statusText: r.statusText ?? r.failed ?? '',
        httpVersion: r.protocol ?? '',
        headers: harHeaders(r.responseHeaders),
        cookies: [],
        content: {
          size: r.responseBody?.length ?? r.size ?? 0,
          mimeType: r.mimeType ?? '',
          ...(r.responseBody !== undefined ? { text: r.responseBody } : {}),
          ...(r.responseBodyOmitted || r.responseBodyTruncated
            ? { comment: r.responseBodyOmitted ?? 'truncated at the profile cap' }
            : {}),
        },
        redirectURL: r.responseHeaders?.location ?? '',
        headersSize: -1,
        bodySize: r.transferSize ?? -1,
        ...(r.failed ? { _error: r.failed } : {}),
      },
      cache: {},
      timings: {
        blocked: phase('stalled'),
        dns: phase('dns'),
        connect: phase('connect'),
        ssl: phase('ssl'),
        send: Math.max(0, phase('send')),
        wait: Math.max(0, typeof t.wait === 'number' ? t.wait : (r.ms ?? 0)),
        receive: Math.max(0, phase('download')),
      },
      ...(r.remoteAddress ? { serverIPAddress: r.remoteAddress.replace(/:\d+$/, '') } : {}),
      _resourceType: (r.resourceType ?? r.initiator ?? '').toLowerCase(),
      ...(r.initiatorInfo ? { _initiator: r.initiatorInfo } : {}),
      ...(r.priority ? { _priority: r.priority } : {}),
      ...(r.cache ? { _fromCache: r.cache } : {}),
      ...(r.blockedReason ? { _blockedReason: r.blockedReason } : {}),
      ...(r.corsError ? { _corsError: r.corsError } : {}),
      ...(r.notes?.length ? { _messages: r.notes } : {}),
      ...(r.frames ? { _webSocketMessages: r.frames } : {}),
      _tvmcp: { id: r.id, seq: r.seq, origin: r.origin, initiator: r.initiator, clock: r.clock, pending: r.pending },
    }
  })
  return {
    log: { version: '1.2', creator: { name: 'tv-mcp', version }, pages: [], entries, comment: `device ${device}` },
  }
}

/** network.har + console.jsonl + timeline.jsonl for one device, under <reports>/captures/. */
export async function exportCapture(recorder: Recorder, device: string, version: string) {
  const dir = path.join(config.reportsDir, 'captures', `${stamp()}-${safe(device)}`)
  await mkdir(dir, { recursive: true })
  const har = toHar(recorder, device, version)
  const consoleLines = recorder.consoleRows()
  const timeline = recorder.timeline({ limit: Number.MAX_SAFE_INTEGER })
  const files = {
    har: path.join(dir, 'network.har'),
    console: path.join(dir, 'console.jsonl'),
    timeline: path.join(dir, 'timeline.jsonl'),
  }
  await writeFile(files.har, JSON.stringify(har, null, 1))
  await writeFile(files.console, consoleLines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  await writeFile(files.timeline, timeline.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return {
    dir,
    files,
    counts: {
      requests: har.log.entries.length,
      pending: har.log.entries.filter((e) => e._tvmcp.pending).length,
      withResponseBody: har.log.entries.filter((e) => e.response.content.text !== undefined).length,
      console: consoleLines.length,
      timeline: timeline.length,
    },
  }
}
