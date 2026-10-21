// Per-device record of what happened: network exchanges (paired by id), console output, focus/route events and
// the actions tv-mcp itself took. Everything lands on one clock (this server's) so the timeline can interleave it.
import type { ExchangeEnd, ExchangeStart, FrameEvent } from '@tv-mcp/protocol'

/**
 * Which clock a time came from. `device` times are shifted onto this server's clock by the measured offset;
 * `server` times are an app server's clock (reported exchanges, assumed NTP-synced) and used as-is.
 */
export type Clock = 'device' | 'server' | 'tv-mcp'

export interface NetworkRecord extends ExchangeStart, Partial<Omit<ExchangeEnd, 'id'>> {
  pending: boolean
  clock: Clock
}

export interface ConsoleEntry {
  at: number
  clock: Clock
  level: string
  text: string
  /** console: page console API; browser: messages the browser itself logs (CORS, ORB, failed loads…); exception. */
  origin?: 'console' | 'browser' | 'exception'
  /** Where it was logged from, `url:line:column`, like the DevTools source link. */
  source?: string
  /** Browser messages: network, security, violation, deprecation, intervention… */
  category?: string
}

export interface MarkEntry {
  at: number
  clock: Clock
  kind: string
  summary: string
}

export interface TimelineRow {
  t: number
  iso: string
  clock: Clock
  kind: string
  summary: string
  id?: string
}

const MAX_RECORDS = 1000
const MAX_BODY_CHARS = 128 * 1024 * 1024
/** Console history: entries and characters; when over, info/log/debug go first so warnings and errors survive. */
const MAX_CONSOLE = 20000
const MAX_CONSOLE_CHARS = 64 * 1024 * 1024
const KEEP_LONGER = /^(error|warn|warning|exception|assert)$/
const MAX_MARKS = 1000
const MAX_FRAMES_PER_SOCKET = 200

const bodyChars = (r: NetworkRecord) => (r.requestBody?.length ?? 0) + (r.responseBody?.length ?? 0)

export interface NetworkQuery {
  order?: 'start' | 'end'
  origin?: 'device' | 'server'
  urlPattern?: string
  failedOnly?: boolean
  pendingOnly?: boolean
  sinceMs?: number
  limit?: number
  includeBodies?: boolean
}

export class Recorder {
  private records = new Map<string, NetworkRecord>()
  private frames = new Map<string, FrameEvent[]>()
  /** Ids dropped by the url policy; their later response events are ignored too. */
  private dropped = new Set<string>()
  private bodyTotal = 0
  readonly console: ConsoleEntry[] = []
  readonly marks: MarkEntry[] = []
  /** Server clock minus device clock, the smallest seen (the least delayed message gives the best estimate). */
  private offset: number | null = null

  /** Called with the device clock time carried by every agent event. */
  observeDeviceClock(deviceAt: number | undefined) {
    if (typeof deviceAt !== 'number') return
    const sample = Date.now() - deviceAt
    if (this.offset === null || sample < this.offset) this.offset = sample
  }

  get clockOffsetMs() {
    return this.offset
  }

  /** A time on this server's clock. */
  align(t: number, clock: Clock): number {
    return clock === 'device' && this.offset !== null ? t + this.offset : t
  }

  /** An action tv-mcp took (press, navigate…), on this server's clock. */
  mark(kind: string, summary: string) {
    this.event(kind, summary, Date.now(), 'tv-mcp')
  }

  /** Something the device reported (focus, route) at a time on its own clock. */
  event(kind: string, summary: string, at: number, clock: Clock) {
    this.marks.push({ at, clock, kind, summary })
    if (this.marks.length > MAX_MARKS) this.marks.splice(0, this.marks.length - MAX_MARKS)
  }

  private consoleChars = 0

  /** Returns the stored entry so a transport can fill in text that is still being serialised. */
  log(level: string, text: string, at: number, clock: Clock, extra: Partial<ConsoleEntry> = {}): ConsoleEntry {
    const entry: ConsoleEntry = { at, clock, level, text, ...extra }
    this.console.push(entry)
    this.consoleChars += text.length
    this.trimConsole()
    return entry
  }

  /** Replace an entry's text (DevTools object arguments resolve after the message arrived). */
  setText(entry: ConsoleEntry, text: string) {
    this.consoleChars += text.length - entry.text.length
    entry.text = text
    this.trimConsole()
  }

  private trimConsole() {
    if (this.console.length <= MAX_CONSOLE && this.consoleChars <= MAX_CONSOLE_CHARS) return
    // First pass drops the oldest low-severity entries; only if that is not enough do errors go too.
    for (const keepSevere of [true, false]) {
      for (
        let i = 0;
        i < this.console.length && (this.console.length > MAX_CONSOLE || this.consoleChars > MAX_CONSOLE_CHARS);
      ) {
        if (keepSevere && KEEP_LONGER.test(this.console[i].level)) {
          i++
          continue
        }
        this.consoleChars -= this.console[i].text.length
        this.console.splice(i, 1)
      }
    }
  }

  start(e: ExchangeStart, clock: Clock) {
    const existing = this.records.get(e.id)
    // An end can arrive first when the request body took longer to read than the response.
    const record: NetworkRecord = { ...(existing ?? {}), ...e, pending: existing ? existing.pending : true, clock }
    this.put(record, existing)
  }

  /** The url policy rejected this record; forget it and anything that arrives for it later. */
  drop(id: string) {
    this.dropped.add(id)
    const existing = this.records.get(id)
    if (existing) {
      this.bodyTotal -= bodyChars(existing)
      this.records.delete(id)
    }
  }

  frame(f: FrameEvent) {
    if (this.dropped.has(f.id) || !this.records.has(f.id)) return
    let list = this.frames.get(f.id)
    if (!list) {
      list = []
      this.frames.set(f.id, list)
    }
    if (list.length < MAX_FRAMES_PER_SOCKET) list.push(f)
  }

  end(e: ExchangeEnd, clock: Clock) {
    if (this.dropped.has(e.id)) return
    const existing = this.records.get(e.id)
    if (existing?.endedAt !== undefined && e.closedAt !== undefined) {
      // A WebSocket close after the handshake: keep the handshake time as the end.
      this.put(
        { ...existing, closedAt: e.closedAt, closeCode: e.closeCode, ...(e.failed ? { failed: e.failed } : {}) },
        existing,
      )
      return
    }
    const base: NetworkRecord = existing ?? {
      id: e.id,
      seq: Number.MAX_SAFE_INTEGER,
      origin: 'device',
      initiator: 'fetch',
      method: '?',
      url: '?',
      startedAt: e.endedAt,
      pending: false,
      clock,
    }
    this.put({ ...base, ...e, pending: false }, existing)
  }

  exchange(e: ExchangeStart & ExchangeEnd, clock: Clock) {
    this.put({ ...e, pending: false, clock }, this.records.get(e.id))
  }

  /** Patch a stored record (DevTools bodies arrive after the response). */
  patch(id: string, fields: Partial<NetworkRecord>) {
    const existing = this.records.get(id)
    if (existing) this.put({ ...existing, ...fields }, existing)
  }

  get(id: string) {
    return this.records.get(id)
  }

  clear() {
    this.records.clear()
    this.frames.clear()
    this.dropped.clear()
    this.consoleChars = 0
    this.bodyTotal = 0
    this.console.length = 0
    this.marks.length = 0
  }

  private put(record: NetworkRecord, previous?: NetworkRecord) {
    if (previous) {
      this.bodyTotal -= bodyChars(previous)
      this.records.delete(record.id)
    }
    this.records.set(record.id, record)
    this.bodyTotal += bodyChars(record)
    while (this.records.size > MAX_RECORDS) {
      const oldest = this.records.keys().next().value as string
      this.bodyTotal -= bodyChars(this.records.get(oldest)!)
      this.records.delete(oldest)
      this.frames.delete(oldest)
    }
    // Over the body budget: drop bodies from the oldest records first, keep their metadata.
    if (this.bodyTotal > MAX_BODY_CHARS) {
      for (const r of this.records.values()) {
        if (this.bodyTotal <= MAX_BODY_CHARS) break
        if (!bodyChars(r)) continue
        this.bodyTotal -= bodyChars(r)
        delete r.requestBody
        delete r.responseBody
        r.responseBodyOmitted = 'evicted (tv-mcp body budget)'
      }
    }
  }

  private sorted(order: 'start' | 'end'): NetworkRecord[] {
    const all = Array.from(this.records.values())
    const startOf = (r: NetworkRecord) => this.align(r.startedAt, r.clock)
    const endOf = (r: NetworkRecord) =>
      r.endedAt === undefined ? Number.POSITIVE_INFINITY : this.align(r.endedAt, r.clock)
    return all.sort((a, b) =>
      order === 'end'
        ? endOf(a) - endOf(b) || startOf(a) - startOf(b)
        : startOf(a) - startOf(b) || (a.id.split('-')[0] === b.id.split('-')[0] ? a.seq - b.seq : 0),
    )
  }

  /** Every record, presented with bodies and frames, in request start order (for exports). */
  allRecords() {
    return this.sorted('start').map((r) => this.present(r, true))
  }

  /** The console on this server's clock, oldest first (for exports). */
  consoleRows() {
    return this.console
      .map(({ at, ...e }) => ({ t: this.align(at, e.clock), ...e }))
      .sort((a, b) => a.t - b.t)
      .map(({ t, ...e }) => ({ at: new Date(t).toISOString(), ...e }))
  }

  query(q: NetworkQuery) {
    const regex = q.urlPattern ? new RegExp(q.urlPattern, 'i') : null
    const since = q.sinceMs !== undefined ? Date.now() - q.sinceMs : null
    const rows = this.sorted(q.order ?? 'start').filter(
      (r) =>
        (!q.origin || r.origin === q.origin) &&
        (!regex || regex.test(r.url)) &&
        (!q.failedOnly || Boolean(r.failed) || (r.status ?? 0) >= 400) &&
        (!q.pendingOnly || r.pending) &&
        (since === null || this.align(r.startedAt, r.clock) >= since),
    )
    const limited = rows.slice(-(q.limit ?? 100))
    return limited.map((r) => this.present(r, q.includeBodies ?? false))
  }

  /** One record as returned by tools: aligned times, duration, bodies optional (sizes always). */
  present(r: NetworkRecord, includeBodies: boolean) {
    const start = this.align(r.startedAt, r.clock)
    const end = r.endedAt === undefined ? undefined : this.align(r.endedAt, r.clock)
    const { requestBody, responseBody, ...rest } = r
    const frames = this.frames.get(r.id)
    return {
      ...rest,
      ...(frames ? { frameCount: frames.length } : {}),
      ...(frames && includeBodies
        ? { frames: frames.map((f) => ({ ...f, at: new Date(this.align(f.at, r.clock)).toISOString() })) }
        : {}),
      startedAt: new Date(start).toISOString(),
      ...(end !== undefined ? { endedAt: new Date(end).toISOString(), ms: Math.max(0, Math.round(end - start)) } : {}),
      ...(r.closedAt !== undefined ? { closedAt: new Date(this.align(r.closedAt, r.clock)).toISOString() } : {}),
      ...(r.pending ? { pendingForMs: Math.round(Date.now() - start) } : {}),
      requestBodyChars: requestBody?.length ?? 0,
      responseBodyChars: responseBody?.length ?? 0,
      ...(includeBodies ? { requestBody, responseBody } : {}),
    }
  }

  /** Marks, focus/route events, console and network start/end rows interleaved on this server's clock. */
  timeline(opts: { sinceMs?: number; kinds?: string[]; limit?: number }): TimelineRow[] {
    type Row = TimelineRow & { rank: number; page?: string; seq?: number }
    const rows: Row[] = []
    // Within one millisecond: actions before what they cause, requests before frames before responses.
    const RANK: Record<string, number> = {
      request: 1,
      'server-request': 1,
      'ws.sent': 2,
      'ws.received': 2,
      response: 3,
      'server-response': 3,
      'ws.closed': 4,
    }
    const add = (t: number, clock: Clock, kind: string, summary: string, record?: NetworkRecord) =>
      rows.push({
        t,
        iso: new Date(t).toISOString(),
        clock,
        kind,
        summary,
        // A WebSocket's handshake response precedes its frames.
        rank: kind === 'response' && record?.initiator === 'websocket' ? 1.5 : (RANK[kind] ?? 0),
        ...(record ? { id: record.id, page: record.id.split('-')[0], seq: record.seq } : {}),
      })
    for (const m of this.marks) add(this.align(m.at, m.clock), m.clock, m.kind, m.summary)
    for (const c of this.console)
      add(
        this.align(c.at, c.clock),
        c.clock,
        `${c.origin === 'browser' ? 'browser' : 'console'}.${c.level}`,
        `${c.text.slice(0, 300)}${c.source ? ` (${c.source})` : ''}`,
      )
    for (const r of this.records.values()) {
      add(
        this.align(r.startedAt, r.clock),
        r.clock,
        r.origin === 'server' ? 'server-request' : 'request',
        `#${r.seq} ${r.method} ${r.url}`,
        r,
      )
      if (r.endedAt !== undefined) {
        const outcome = r.failed ? [`failed: ${r.failed}`] : [r.status, r.mimeType]
        const ms = `${Math.round(r.endedAt - r.startedAt)}ms`
        const summary = [`#${r.seq}`, ...outcome, ms, r.method, r.url]
          .filter((x) => x !== undefined && x !== '')
          .join(' ')
        add(this.align(r.endedAt, r.clock), r.clock, r.origin === 'server' ? 'server-response' : 'response', summary, r)
      }
      if (r.closedAt !== undefined)
        add(
          this.align(r.closedAt, r.clock),
          r.clock,
          'ws.closed',
          [`#${r.seq}`, r.closeCode, r.url].filter((x) => x !== undefined).join(' '),
          r,
        )
    }
    for (const [id, list] of this.frames) {
      const r = this.records.get(id)
      if (!r) continue
      for (const f of list) {
        const preview = f.binary ? `[binary ${f.size} bytes]` : (f.data ?? '').slice(0, 160)
        add(this.align(f.at, r.clock), r.clock, `ws.${f.dir}`, `#${r.seq} ${r.url} ${preview}`, r)
      }
    }
    const since = opts.sinceMs !== undefined ? Date.now() - opts.sinceMs : null
    const kinds = opts.kinds?.length ? opts.kinds : null
    return rows
      .filter(
        (r) =>
          (since === null || r.t >= since) && (!kinds || kinds.some((k) => r.kind === k || r.kind.startsWith(`${k}.`))),
      )
      .sort((a, b) => a.t - b.t || a.rank - b.rank || (a.page && a.page === b.page ? (a.seq ?? 0) - (b.seq ?? 0) : 0))
      .slice(-(opts.limit ?? 200))
      .map(({ rank, page, seq, ...row }) => row)
  }
}
