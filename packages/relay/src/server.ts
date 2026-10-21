#!/usr/bin/env node
// The tv-mcp relay: devices running the in-app agent dial /agent/device, MCP servers dial /agent/client,
// and the relay routes calls and results between them. It also serves the agent bundle at /agent.js so an
// app needs nothing more than one script tag.
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { URL } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'

import type { ClientToRelay, DeviceToRelay, RelayDevice } from '@tv-mcp/protocol'

const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.HOST ?? '0.0.0.0'
/** Required from MCP clients (list, claim, call) when set. */
const CLIENT_TOKEN = process.env.TVMCP_TOKEN ?? ''
/** Required from devices when set; bake it into test builds with data-token. */
const DEVICE_TOKEN = process.env.TVMCP_DEVICE_TOKEN ?? ''
const PING_MS = 25_000
const STALE_MS = 90_000
const CALL_TIMEOUT_MS = 60_000
/** Recent events per device name, replayed to clients that connect later (page-load requests, startup logs). */
const REPLAY_MAX = 500
const REPLAY_TTL_MS = 10 * 60_000

const log = (...args: unknown[]) => console.log(new Date().toISOString(), '[relay]', ...args)

function loadAgentBundle(): string | null {
  try {
    const require = createRequire(import.meta.url)
    return readFileSync(require.resolve('@tv-mcp/agent/script'), 'utf8')
  } catch {
    return null
  }
}
const agentBundle = loadAgentBundle()

interface Device extends Omit<RelayDevice, 'owner'> {
  ws: WebSocket
  ownerWs: WebSocket | null
}

interface Client {
  owner: string
}

interface PendingCall {
  client: WebSocket
  clientId: number
  device: string
  timer: NodeJS.Timeout
}

const devices = new Map<string, Device>()
const clients = new Map<WebSocket, Client>()
/** Relay-assigned call id → who asked. Client ids are only unique per client. */
const calls = new Map<number, PendingCall>()
let nextCallId = 1
const replay = new Map<string, { at: number; events: string[] }>()

function remember(device: string, message: string) {
  let entry = replay.get(device)
  if (!entry) {
    entry = { at: Date.now(), events: [] }
    replay.set(device, entry)
  }
  entry.at = Date.now()
  entry.events.push(message)
  if (entry.events.length > REPLAY_MAX) entry.events.splice(0, entry.events.length - REPLAY_MAX)
}

const send = (ws: WebSocket | null, message: unknown) => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
}

const publicDevice = (d: Device): RelayDevice => ({
  name: d.name,
  platform: d.platform,
  build: d.build,
  agentVersion: d.agentVersion,
  userAgent: d.userAgent,
  url: d.url,
  ip: d.ip,
  connectedAt: d.connectedAt,
  lastSeen: d.lastSeen,
  owner: d.ownerWs ? (clients.get(d.ownerWs)?.owner ?? null) : null,
  state: d.state,
})

const listDevices = () => Array.from(devices.values()).map(publicDevice)
const broadcast = (message: unknown) => {
  for (const ws of clients.keys()) send(ws, message)
}
const authorised = (url: URL, token: string) => !token || url.searchParams.get('token') === token

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://relay')
  if (url.pathname === '/agent/health' || url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, devices: devices.size, clients: clients.size, agentBundle: !!agentBundle }))
    return
  }
  if (url.pathname === '/agent/devices') {
    if (!authorised(url, CLIENT_TOKEN)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'token required' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ devices: listDevices() }))
    return
  }
  if (url.pathname === '/agent.js') {
    if (!agentBundle) {
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end('agent bundle not built: run pnpm build')
      return
    }
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' })
    res.end(agentBundle)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://relay')
  const reject = (status: string) => {
    socket.write(`HTTP/1.1 ${status}\r\n\r\n`)
    socket.destroy()
  }
  if (url.pathname === '/agent/device') {
    if (!authorised(url, DEVICE_TOKEN)) return reject('401 Unauthorized')
    wss.handleUpgrade(req, socket, head, (ws) => onDevice(ws, req, url))
  } else if (url.pathname === '/agent/client') {
    if (!authorised(url, CLIENT_TOKEN)) return reject('401 Unauthorized')
    wss.handleUpgrade(req, socket, head, (ws) => onClient(ws, url))
  } else {
    reject('404 Not Found')
  }
})

function failCallsFor(predicate: (call: PendingCall) => boolean, error: string) {
  for (const [id, call] of calls) {
    if (!predicate(call)) continue
    clearTimeout(call.timer)
    calls.delete(id)
    send(call.client, { type: 'result', id: call.clientId, device: call.device, ok: false, error })
  }
}

function onDevice(ws: WebSocket, req: http.IncomingMessage, url: URL) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')[0]
    .trim()
  const ip = forwarded || req.socket.remoteAddress || ''
  const name = url.searchParams.get('name') || `device-${Math.random().toString(36).slice(2, 8)}`
  const previous = devices.get(name)
  // A reload reconnects under the same name; the old socket is dead or about to be.
  if (previous && previous.ws !== ws) previous.ws.terminate()
  const device: Device = {
    name,
    platform: url.searchParams.get('platform') ?? 'unknown',
    build: url.searchParams.get('build') ?? '',
    agentVersion: '',
    userAgent: String(req.headers['user-agent'] ?? ''),
    url: url.searchParams.get('url') ?? '',
    ip,
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    ws,
    ownerWs: previous?.ownerWs ?? null,
    state: null,
  }
  devices.set(name, device)
  log(`device ${name} connected from ${ip} (${device.platform})`)
  broadcast({ type: 'devices', devices: listDevices() })

  ws.on('message', (raw) => {
    device.lastSeen = Date.now()
    let message: DeviceToRelay
    try {
      message = JSON.parse(raw.toString()) as DeviceToRelay
    } catch {
      return
    }
    if (message.type === 'hello') {
      device.platform = message.platform || device.platform
      device.build = message.build ?? device.build
      device.url = message.url || device.url
      device.agentVersion = message.agentVersion ?? ''
      device.state = { ...message.state, at: Date.now() }
      broadcast({ type: 'devices', devices: listDevices() })
    } else if (message.type === 'result') {
      const call = calls.get(message.id)
      if (!call) return
      clearTimeout(call.timer)
      calls.delete(message.id)
      send(call.client, { ...message, id: call.clientId, device: name })
    } else if (message.type === 'event') {
      if (message.event === 'route' || message.event === 'focus') {
        device.state = { ...(device.state ?? {}), [message.event]: message.data, at: Date.now() }
        if (message.event === 'route') device.url = message.data.url
      }
      const out = JSON.stringify({ ...message, device: name })
      remember(name, out)
      for (const client of clients.keys()) if (client.readyState === WebSocket.OPEN) client.send(out)
    }
  })
  ws.on('close', () => {
    if (devices.get(name)?.ws !== ws) return
    devices.delete(name)
    failCallsFor((c) => c.device === name, `device ${name} disconnected`)
    log(`device ${name} disconnected`)
    broadcast({ type: 'devices', devices: listDevices() })
  })
  ws.on('error', (error) => log(`device ${name} error ${error.message}`))
}

function onClient(ws: WebSocket, url: URL) {
  const client: Client = { owner: url.searchParams.get('owner') || 'anonymous' }
  clients.set(ws, client)
  log(`client ${client.owner} connected`)
  send(ws, { type: 'devices', devices: listDevices() })
  // A client that has seen the stream before (a reconnect) passes replay=0 to avoid duplicates.
  if (url.searchParams.get('replay') !== '0') {
    for (const entry of replay.values()) for (const message of entry.events) ws.send(message)
  }

  const claimedByOther = (device: Device) => device.ownerWs && device.ownerWs !== ws && clients.has(device.ownerWs)

  ws.on('message', (raw) => {
    let message: ClientToRelay
    try {
      message = JSON.parse(raw.toString()) as ClientToRelay
    } catch {
      return
    }
    if (message.type === 'list') {
      send(ws, { type: 'devices', devices: listDevices() })
      return
    }
    const device = devices.get(message.device)
    const result = (ok: boolean, extra: Record<string, unknown>) =>
      send(ws, { type: 'result', id: message.id, device: message.device, ok, ...extra })
    if (!device) return result(false, { error: `no device "${message.device}"` })
    if (message.type === 'claim') {
      if (claimedByOther(device) && !message.force)
        return result(false, { error: `claimed by ${clients.get(device.ownerWs!)!.owner}` })
      device.ownerWs = message.release ? null : ws
      result(true, { value: publicDevice(device) })
      broadcast({ type: 'devices', devices: listDevices() })
      return
    }
    if (message.type === 'call') {
      if (claimedByOther(device)) return result(false, { error: `claimed by ${clients.get(device.ownerWs!)!.owner}` })
      const id = nextCallId++
      const timer = setTimeout(() => {
        calls.delete(id)
        result(false, { error: `${message.method} timed out in the relay after ${CALL_TIMEOUT_MS}ms` })
      }, CALL_TIMEOUT_MS)
      calls.set(id, { client: ws, clientId: message.id, device: device.name, timer })
      send(device.ws, { type: 'call', id, method: message.method, params: message.params ?? {} })
    }
  })
  ws.on('close', () => {
    clients.delete(ws)
    for (const [id, call] of calls) {
      if (call.client !== ws) continue
      clearTimeout(call.timer)
      calls.delete(id)
    }
    for (const device of devices.values()) if (device.ownerWs === ws) device.ownerWs = null
    log(`client ${client.owner} disconnected`)
    broadcast({ type: 'devices', devices: listDevices() })
  })
}

setInterval(() => {
  const now = Date.now()
  for (const [name, entry] of replay) if (!devices.has(name) && now - entry.at > REPLAY_TTL_MS) replay.delete(name)
  for (const device of devices.values()) {
    if (now - device.lastSeen > STALE_MS) {
      log(`device ${device.name} stale; dropping`)
      device.ws.terminate()
      continue
    }
    send(device.ws, { type: 'ping' })
  }
}, PING_MS)

server.listen(PORT, HOST, () =>
  log(
    `listening on ${HOST}:${PORT}; client token ${CLIENT_TOKEN ? 'set' : 'not set'}; device token ${DEVICE_TOKEN ? 'set' : 'not set'}; agent bundle ${agentBundle ? 'served at /agent.js' : 'missing'}`,
  ),
)
