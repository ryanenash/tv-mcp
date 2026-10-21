// Static server for the demo app: node examples/demo-app/serve.mjs [port]
// RELAY_URL (default http://localhost:8080) is where the page loads the agent from; NO_AGENT=1 (or ?noagent)
// serves the page without it, for the DevTools transport. /api/* is a tiny fake backend for network capture tests.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const port = Number(process.argv[2] ?? process.env.PORT ?? 3100)
const relay = (process.env.RELAY_URL ?? 'http://localhost:8080').replace(/\/+$/, '')
const noAgent = process.env.NO_AGENT === '1'
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
const AGENT_TAG = /<script src="http:\/\/localhost:8080\/agent\.js"([^>]*)><\/script>/
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
  })
}

/** The fake backend: JSON endpoints with a login, an authorised call, slow/fast pairs and a large body. */
async function api(req, res, url) {
  const json = (status, value, headers = {}) =>
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(value))
  switch (url.pathname) {
    case '/api/catalogue':
      return json(200, {
        rails: { featured: ['Northern Lights', 'Harbour Town'], drama: ['Quiet Rooms'] },
        partnerId: 'p-secret-000',
      })
    case '/api/login': {
      const body = JSON.parse((await readBody(req)) || '{}')
      return json(
        200,
        { token: 'tok-secret-123', user: { name: 'Demo Viewer', email: body.email } },
        {
          'set-cookie': 'session=sess-secret-456; Path=/; HttpOnly',
        },
      )
    }
    case '/api/profile':
      if (!req.headers.authorization) return json(401, { error: 'no token' })
      return json(200, { plan: 'premium', pin: '1234' })
    case '/api/slow':
      await sleep(Number(url.searchParams.get('ms') ?? 1500))
      return json(200, { slow: true })
    case '/api/sse':
      // A live event stream: the first event at once, the stream closed a while later.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('data: {"event":"first"}\n\n')
      await sleep(2500)
      return res.end('data: {"event":"last"}\n\n')
    case '/api/fast':
      return json(200, { fast: true })
    case '/api/big':
      return json(200, { items: Array.from({ length: 4000 }, (_, i) => ({ id: i, title: `Programme ${i}` })) })
    case '/api/segment.m4s':
      return res.writeHead(200, { 'content-type': 'video/mp4' }).end(Buffer.alloc(256 * 1024))
    case '/api/events':
      await readBody(req)
      return res.writeHead(204).end()
    default:
      return json(404, { error: 'unknown endpoint' })
  }
}

/** A minimal WebSocket echo (text frames only) so the demo needs no dependencies. */
function websocketEcho(req, socket) {
  const key = req.headers['sec-websocket-key']
  if (!String(req.url).startsWith('/api/ws') || !key) return socket.destroy()
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  const send = (text) => {
    const payload = Buffer.from(text)
    const head =
      payload.length < 126
        ? Buffer.from([0x81, payload.length])
        : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255])
    socket.write(Buffer.concat([head, payload]))
  }
  let buffer = Buffer.alloc(0)
  socket.on('error', () => undefined)
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f
      let length = buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      }
      const masked = (buffer[1] & 0x80) !== 0
      const maskAt = offset
      if (masked) offset += 4
      if (buffer.length < offset + length) return
      let payload = buffer.subarray(offset, offset + length)
      if (masked) payload = Buffer.from(payload.map((b, i) => b ^ buffer[maskAt + (i % 4)]))
      buffer = buffer.subarray(offset + length)
      if (opcode === 8) {
        socket.end(Buffer.from([0x88, 2, 0x03, 0xe8]))
        return
      }
      if (opcode === 1) send(JSON.stringify({ echo: JSON.parse(payload.toString()), token: 'ws-reply-secret' }))
    }
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://demo')
  if (url.pathname.startsWith('/api/')) return api(req, res, url)
  if (url.pathname === '/slow-nav') {
    // A navigation whose response is slow: the page being left keeps running (and requesting) meanwhile.
    await sleep(Number(url.searchParams.get('ms') ?? 3000))
    res.writeHead(302, { location: url.searchParams.get('to') ?? '/' }).end()
    return
  }
  if (url.pathname === '/stall') {
    // A document whose <body> arrives late: scripts that read document.body meanwhile see null.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.write('<!doctype html><html><head><title>Stalled</title>' + ' '.repeat(2048))
    await sleep(Number(url.searchParams.get('ms') ?? 3000))
    res.end('</head><body><p>Stalled page ready</p></body></html>')
    return
  }
  const file = path.join(root, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname))
  if (!file.startsWith(root) || file.endsWith('.mjs')) {
    res.writeHead(404).end()
    return
  }
  try {
    let body = await readFile(file)
    if (file.endsWith('.html')) {
      const html = body
        .toString('utf8')
        .replace(
          AGENT_TAG,
          noAgent || url.searchParams.has('noagent') ? '' : `<script src="${relay}/agent.js"$1></script>`,
        )
      body = Buffer.from(html)
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' }).end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})
server.on('upgrade', websocketEcho)
server.listen(port, '0.0.0.0', () => console.log(`demo app on http://localhost:${port}/ (agent from ${relay})`))
