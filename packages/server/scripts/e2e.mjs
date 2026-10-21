// End-to-end smoke test over http: relay + demo app + two headless Chromes (one with the agent, one
// DevTools-only), driven through the real MCP server over stdio. Run after `pnpm build`:
//   node packages/server/scripts/e2e.mjs
// Env: CHROME (browser binary), RELAY_PORT (18080), DEMO_PORT (3100 with the agent, +1 without), DEVTOOLS_PORT (9223).
import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { createHarness, repo } from './harness.mjs'

const RELAY_PORT = Number(process.env.RELAY_PORT ?? 18080)
const DEMO_PORT = Number(process.env.DEMO_PORT ?? 3100)
const DEVTOOLS_PORT = Number(process.env.DEVTOOLS_PORT ?? 9223)
const relayUrl = `http://localhost:${RELAY_PORT}`

const TO_SETTINGS = [
  { navigate: '/' },
  { key: 'Left', expectFocusChange: true },
  { key: 'Up', untilFocus: 'Home' },
  { key: 'Down', untilFocus: 'Settings' },
  { key: 'Ok', waitUrl: '#/settings', expectFocus: 'Sign in' },
]
const REDACTED = '[redacted]'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Network checks shared by both transports: bodies, redaction, ordering, pending, truncation, timeline. */
async function networkChecks(h, device, label) {
  const { call, check } = h
  const nav = await call('press_sequence', { device, steps: TO_SETTINGS })
  check(`${label}: reach Settings`, nav.ok === true, nav)

  await call('press_key', { device, key: 'Ok' })
  const signedIn = await call('wait_for', { device, text: 'Signed in', timeoutMs: 10000 })
  check(`${label}: sign in completes`, signedIn.ok === true, signedIn)
  await sleep(500)
  const login = (await call('network_requests', { device, urlPattern: 'api/login', includeBodies: true })).entries?.at(
    -1,
  )
  check(
    `${label}: POST body captured from a Request object, password redacted`,
    login?.method === 'POST' &&
      login?.requestBody?.includes('viewer@example.test') &&
      login?.requestBody?.includes(`"password":"${REDACTED}"`) &&
      !login?.requestBody?.includes('hunter2'),
    login,
  )
  check(
    `${label}: response body captured, token redacted`,
    login?.status === 200 &&
      login?.responseBody?.includes(`"token":"${REDACTED}"`) &&
      !login?.responseBody?.includes('tok-secret'),
    login,
  )
  const profile = (
    await call('network_requests', { device, urlPattern: 'api/profile', includeBodies: true })
  ).entries?.at(-1)
  check(
    `${label}: Authorization header and pin redacted`,
    profile?.requestHeaders?.authorization === REDACTED && profile?.responseBody?.includes(`"pin":"${REDACTED}"`),
    profile,
  )

  await call('press_key', { device, key: 'Down' })
  const refreshFocus = await call('snapshot', { device })
  check(`${label}: focus on Refresh data`, refreshFocus.focused?.label === 'Refresh data', refreshFocus.focused)
  await call('press_key', { device, key: 'Ok', settleMs: 0 })
  const pending = await call('network_requests', { device, urlPattern: 'api/slow', pendingOnly: true })
  check(
    `${label}: slow request listed as pending while in flight`,
    pending.count >= 1 && pending.entries[0].pending === true,
    pending,
  )
  const refreshed = await call('wait_for', { device, text: 'Refreshed', timeoutMs: 15000 })
  check(`${label}: refresh completes`, refreshed.ok === true, refreshed)
  await sleep(800)

  const byStart =
    (await call('network_requests', { device, urlPattern: 'api/(slow|fast)', sinceMs: 30000 })).entries ?? []
  const byEnd =
    (await call('network_requests', { device, urlPattern: 'api/(slow|fast)', sinceMs: 30000, order: 'end' })).entries ??
    []
  const names = (rows) => rows.slice(-2).map((r) => (r.url.includes('slow') ? 'slow' : 'fast'))
  check(`${label}: start order lists slow before fast`, names(byStart).join() === 'slow,fast', byStart)
  check(`${label}: completion order lists fast before slow`, names(byEnd).join() === 'fast,slow', byEnd)
  const slow = byStart.filter((r) => r.url.includes('slow')).at(-1)
  check(`${label}: slow request timed (>= 1400 ms)`, slow?.ms >= 1400 && slow?.pending === false, slow)
  const one = slow && (await call('network_requests', { device, id: slow.id }))
  check(`${label}: single exchange by id includes its body`, one?.responseBody === '{"slow":true}', one)

  const segment = (await call('network_requests', { device, urlPattern: 'segment\\.m4s' })).entries?.at(-1)
  check(
    `${label}: player-style media segment recorded, body not read`,
    segment?.status === 200 &&
      /video\/mp4/.test(segment?.mimeType ?? '') &&
      /media/.test(segment?.responseBodyOmitted ?? ''),
    segment,
  )
  const ws = (await call('network_requests', { device, urlPattern: 'api/ws', includeBodies: true })).entries?.at(-1)
  const sent = ws?.frames?.find((f) => f.dir === 'sent')
  const received = ws?.frames?.find((f) => f.dir === 'received')
  check(`${label}: WebSocket connection recorded (101)`, ws?.initiator === 'websocket' && ws?.status === 101, ws)
  check(
    `${label}: WebSocket frames both ways, tokens redacted`,
    sent?.data?.includes(`"token":"${REDACTED}"`) &&
      received?.data?.includes('"echo"') &&
      received?.data?.includes(`"token":"${REDACTED}"`) &&
      !JSON.stringify(ws?.frames).includes('secret'),
    ws,
  )
  check(`${label}: WebSocket close recorded`, Boolean(ws?.closedAt), ws)
  const css = (await call('network_requests', { device, urlPattern: 'app\\.css', limit: 1000 })).entries?.[0]
  check(
    `${label}: stylesheet recorded (loaded before the agent script)`,
    css && /link|stylesheet/i.test(css.resourceType ?? ''),
    css,
  )
  const logo = (await call('network_requests', { device, urlPattern: 'logo\\.svg' })).entries?.at(-1)
  check(`${label}: image recorded`, logo && /img|image/i.test(logo.resourceType ?? ''), logo)
  const missing = (await call('network_requests', { device, urlPattern: 'missing-artwork' })).entries ?? []
  check(
    `${label}: failed image recorded`,
    missing.some((m) => m.failed || m.status === 404),
    missing,
  )

  const big = (await call('network_requests', { device, urlPattern: 'api/big' })).entries?.at(-1)
  check(
    `${label}: large body truncated at the profile cap`,
    big?.responseBodyTruncated === true && big?.responseBodyChars === 65536,
    big,
  )

  const timeline = await call('timeline', { device, sinceMs: 30000 })
  const rows = timeline.rows ?? []
  const sorted = rows.every((r, i) => i === 0 || rows[i - 1].iso <= r.iso)
  const lastOk = rows.map((r) => r.kind === 'press' && r.summary.startsWith('Ok')).lastIndexOf(true)
  const slowStart = rows.findIndex((r, i) => i > lastOk && r.kind === 'request' && r.summary.includes('api/slow'))
  const fastEnd = rows.findIndex(
    (r) => r.kind === 'response' && r.summary.includes('api/fast') && rows.indexOf(r) > lastOk,
  )
  const slowEnd = rows.findIndex(
    (r) => r.kind === 'response' && r.summary.includes('api/slow') && rows.indexOf(r) > lastOk,
  )
  check(
    `${label}: timeline is ordered and shows press → requests → fast response → slow response`,
    sorted && lastOk >= 0 && slowStart > lastOk && fastEnd > slowStart && slowEnd > fastEnd,
    { lastOk, slowStart, fastEnd, slowEnd, rows: rows.slice(-12) },
  )
  const slowRequest = rows.findIndex((r, i) => i > lastOk && r.kind === 'request' && r.summary.includes('api/slow'))
  const fastRequest = rows.findIndex((r, i) => i > lastOk && r.kind === 'request' && r.summary.includes('api/fast'))
  check(
    `${label}: timeline keeps start order for requests in the same millisecond`,
    slowRequest >= 0 && slowRequest < fastRequest,
    rows.slice(lastOk, lastOk + 8),
  )
  check(
    `${label}: timeline summaries are tidy`,
    rows.every((r) => !r.summary.includes('  ')),
    rows.filter((r) => r.summary.includes('  ')),
  )
  const all = (await call('timeline', { device, sinceMs: 30000, kinds: ['response', 'ws'] })).rows ?? []
  const handshake = all.findIndex((r) => r.kind === 'response' && r.summary.includes('api/ws'))
  const firstFrame = all.findIndex(
    (r) => r.kind.startsWith('ws.') && r.kind !== 'ws.closed' && r.summary.includes('api/ws'),
  )
  const closed = all.findIndex((r) => r.kind === 'ws.closed')
  check(
    `${label}: WebSocket handshake row before its frames, close row after them`,
    handshake >= 0 && handshake < firstFrame && closed > firstFrame,
    all.filter((r) => r.summary.includes('api/ws')),
  )
  check(
    `${label}: WebSocket closedAt is an ISO time`,
    typeof ws?.closedAt === 'string' && !Number.isNaN(Date.parse(ws.closedAt)),
    ws?.closedAt,
  )
  const boot = (await call('console_logs', { device, pattern: 'demo\\] boot', limit: 20000 })).entries?.at(-1)
  check(
    `${label}: console formatted like DevTools (%c dropped, %s applied, object expanded, circular marked)`,
    boot?.text?.startsWith('[demo] boot ok {') &&
      boot.text.includes('"nested":{"level":2}') &&
      boot.text.includes('"self":"[circular]"') &&
      !boot.text.includes('color:'),
    boot,
  )
  check(
    `${label}: console object keys redacted`,
    boot?.text?.includes(`"token":"${REDACTED}"`) && !boot.text.includes('console-secret'),
    boot,
  )
  check(`${label}: console entry has its source location`, /app\.js:\d+:\d+/.test(boot?.source ?? ''), boot)
  const jsonLine = (await call('console_logs', { device, pattern: 'demo\\] json', limit: 20000 })).entries?.at(-1)
  check(
    `${label}: JSON inside a console string redacted`,
    jsonLine?.text?.includes(`"password":"${REDACTED}"`) && !jsonLine.text.includes('console-pass'),
    jsonLine,
  )
  const wsRows = (await call('timeline', { device, sinceMs: 30000, kinds: ['ws'] })).rows ?? []
  check(
    `${label}: timeline shows WebSocket frames`,
    wsRows.some((r) => r.kind === 'ws.sent') && wsRows.some((r) => r.kind === 'ws.received'),
    wsRows,
  )
  return { login }
}

/** Fixes from the first real-app run: loading overlays, popups, hidden pages, promise evaluation. */
async function robustnessChecks(h, device, label, appUrl) {
  const { call, check } = h
  const nav = await call('press_sequence', { device, steps: TO_SETTINGS })
  check(`${label}: back on Settings`, nav.ok === true, nav)

  // Presses wait for the profile's loading overlay instead of moving focus unseen beneath it.
  await call('press_key', { device, key: 'Down' })
  await call('press_key', { device, key: 'Ok', settleMs: 0 })
  const covered = await call('wait_for', { device, selector: '[data-splash]', timeoutMs: 1000 })
  const up = await call('press_key', { device, key: 'Up' })
  const afterUp = await call('wait_for', { device, gone: '[data-splash]', timeoutMs: 100 })
  check(
    `${label}: press waits until the loading overlay has gone`,
    covered.ok === true && up.busyWaitMs > 500 && up.after?.focused?.label === 'Sign in' && afterUp.ok === true,
    { covered: covered.ok, busyWaitMs: up.busyWaitMs, focused: up.after?.focused?.label },
  )
  const steps = await call('press_sequence', {
    device,
    steps: [
      { key: 'Down', expectFocus: 'Refresh data' },
      { key: 'Ok', settleMs: 0, waitGone: '[data-splash]' },
    ],
  })
  const refreshed = await call('wait_for', { device, text: 'Refreshed', timeoutMs: 100 })
  check(
    `${label}: waitGone step holds until the overlay has gone`,
    steps.ok === true && steps.trace?.[1]?.waited?.includes('gone') && refreshed.ok === true,
    steps.trace?.[1] ?? steps,
  )
  const gone = await call('wait_for', { device, gone: '[data-splash]' })
  check(`${label}: wait_for gone matches once the overlay is off screen`, gone.matched?.includes('gone'), gone)

  // A popup guard with dismissKeys is closed and the step carries on, instead of failing it.
  await call('navigate', { device, url: `${appUrl}${appUrl.includes('?') ? '&' : '?'}promo=1#/home` })
  const promo = await call('wait_for', { device, selector: '[data-promo]', timeoutMs: 10000 })
  const past = await call('press_sequence', { device, steps: [{ key: 'Right', expectFocus: 'Harbour Town' }] })
  check(
    `${label}: popup guard dismissed with its keys, step continues`,
    promo.ok === true && past.ok === true && past.trace?.[0]?.dismissed?.includes('promo'),
    past.trace?.[0] ?? past,
  )

  // A popup that lands while a step waits for a page load is closed too, so the wait and focus check still pass.
  await call('navigate', { device, url: `${appUrl}${appUrl.includes('?') ? '&' : '?'}promo=late#/home` })
  await call('wait_for', { device, focusedLabel: 'Northern Lights', timeoutMs: 10000 })
  const late = await call('press_sequence', {
    device,
    steps: [{ key: 'Ok', waitSelector: '[data-focus-id=details-play]', expectFocus: 'Play' }],
  })
  check(
    `${label}: popup that appears mid-wait is dismissed and the step passes`,
    late.ok === true && late.trace?.[0]?.dismissed?.includes('promo'),
    late.trace?.[0] ?? late,
  )
  await call('press_key', { device, key: 'Back' })

  // A hidden page (minimised or covered window) is reported, since the browser then throttles it.
  await call('evaluate', {
    device,
    expression:
      "(Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return 'hidden' } }), true)",
  })
  const hidden = await call('press_key', { device, key: 'Left' })
  await call('evaluate', { device, expression: '(delete document.visibilityState, document.visibilityState)' })
  const shown = await call('press_key', { device, key: 'Right' })
  check(
    `${label}: press warns when the page is hidden, and only then`,
    /page is hidden/.test(hidden.warning ?? '') && shown.warning === undefined,
    { hidden: hidden.warning, shown: shown.warning },
  )

  const awaited = await call('evaluate', {
    device,
    expression: 'new Promise(function (r) { setTimeout(function () { r({ late: 42 }) }, 100) })',
  })
  check(`${label}: evaluate awaits a promise`, awaited.value?.late === 42, awaited)
}

const h = createHarness()
let failure
try {
  h.start('node', [path.join(repo, 'packages/relay/dist/server.js')], { PORT: String(RELAY_PORT), HOST: '127.0.0.1' })
  h.start('node', [path.join(repo, 'examples/demo-app/serve.mjs'), String(DEMO_PORT)], { RELAY_URL: relayUrl })
  h.start('node', [path.join(repo, 'examples/demo-app/serve.mjs'), String(DEMO_PORT + 1)], { NO_AGENT: '1' })
  await h.until('relay', async () => (await fetch(`${relayUrl}/health`)).ok)
  await h.until('demo app', async () => (await fetch(`http://localhost:${DEMO_PORT}/`)).ok)
  const agentJs = await fetch(`${relayUrl}/agent.js`)
  h.check('relay serves the agent bundle', agentJs.ok && (await agentJs.text()).length > 1000)

  h.chrome(`http://localhost:${DEMO_PORT}/?tvmcp=demo`)
  h.chrome(`http://localhost:${DEMO_PORT + 1}/`, [`--remote-debugging-port=${DEVTOOLS_PORT}`])
  await h.until('agent device on the relay', async () => {
    const body = await (await fetch(`${relayUrl}/agent/devices`)).json()
    return body.devices.some((d) => d.name === 'demo')
  })
  await h.until('DevTools endpoint', async () => (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/version`)).ok)

  // The example pack's devices.json points at the default ports; write one for the test ports.
  const scratch = h.tempDir('tvmcp-e2e-')
  const devicesFile = path.join(scratch, 'devices.json')
  writeFileSync(
    devicesFile,
    JSON.stringify({
      demo: { match: 'demo' },
      'demo-devtools': { match: `localhost:${DEMO_PORT + 1}`, devtools: `http://127.0.0.1:${DEVTOOLS_PORT}` },
    }),
  )
  await h.connect({
    TVMCP_PACK: path.join(repo, 'examples'),
    TVMCP_RELAY_URL: relayUrl,
    TVMCP_DEVICES: devicesFile,
    TVMCP_REPORTS: path.join(scratch, 'reports'),
    // Low enough that the full listing with bodies must spill to a file.
    TVMCP_MAX_RESULT_CHARS: '200000',
    TVMCP_EVAL_TIMEOUT_MS: '2000',
  })
  const { call, check } = h

  const tools = await h.client.listTools()
  check(
    'server lists its tools',
    tools.tools.length >= 18,
    tools.tools.map((t) => t.name),
  )

  const listed = await call('list_devices')
  const transports = Object.fromEntries((listed.devices ?? []).map((d) => [d.name ?? d.id, d.transport]))
  check('list_devices sees the agent device', transports.demo === 'agent', listed)
  check('list_devices sees the DevTools device', Object.values(transports).includes('cdp'), listed)

  // Agent transport: first launch (welcome guard), then the checklist.
  const sanity = await call('run_sanity', { checklist: 'smoke', devices: ['demo'], vars: { QUERY: 'lights' } })
  const cells = Object.fromEntries((sanity.rows ?? []).map((r) => [r.id, r.cells.demo?.status]))
  check('agent: first launch welcome', cells[1] === 'PASS', sanity.rows?.[0] ?? sanity)
  check('agent: browse home and details', cells[2] === 'PASS', sanity.rows?.[1])
  check('agent: search with on-screen keyboard', cells[3] === 'PASS', sanity.rows?.[2])
  check('agent: open settings', cells[4] === 'PASS', sanity.rows?.[3])
  check('sanity: no journey reports NOT AUTOMATED', cells[5] === 'NOT AUTOMATED', cells)
  check('sanity: N/A rule', cells[6] === 'N/A', cells)
  check('sanity: report files written', Boolean(sanity.files?.markdown), sanity.files)

  const snap = await call('snapshot', { device: 'demo' })
  check('agent: snapshot reports focus and sections', Boolean(snap.focused?.label) && snap.sections?.length > 0, snap)

  const net = await call('network_requests', { device: 'demo' })
  check('agent: network capture (fetch/xhr metadata)', net.transport === 'agent' && Array.isArray(net.entries), net)
  const logs = await call('console_logs', { device: 'demo' })
  check('agent: console capture', logs.transport === 'agent' && Array.isArray(logs.entries), logs)

  // Network capture on the agent transport.
  // The very first page load of a fresh browser: the agent has no pack profile yet and records under its boot
  // policy; the server applies the pack policy (here: an extra redaction key) to those records.
  const boot = await call('network_requests', {
    device: 'demo',
    urlPattern: 'api/catalogue',
    includeBodies: true,
    limit: 1000,
  })
  const firstBoot = boot.entries?.[0]
  check(
    'agent: first page load has bodies (boot policy)',
    firstBoot?.bootPolicy === true && firstBoot?.responseBody?.includes('Northern Lights'),
    firstBoot ?? boot,
  )
  check(
    'agent: pack policy re-applied server-side to first-load records (pack-only redaction key)',
    firstBoot?.responseBody?.includes(`"partnerId":"${REDACTED}"`) && !firstBoot?.responseBody?.includes('p-secret'),
    firstBoot,
  )
  const server = (
    await call('network_requests', { device: 'demo', origin: 'server', includeBodies: true })
  ).entries?.at(-1)
  check(
    'agent: app-reported server exchange recorded with url and body redaction',
    server?.clock === 'server' &&
      server?.url.includes('token=%5Bredacted%5D') &&
      server?.responseBody?.includes(`"apiKey":"${REDACTED}"`),
    server,
  )
  await networkChecks(h, 'demo', 'agent')
  const beacon = (
    await call('network_requests', { device: 'demo', urlPattern: 'api/events', includeBodies: true })
  ).entries?.at(-1)
  check(
    'agent: sendBeacon recorded with its body',
    beacon?.initiator === 'beacon' && beacon?.requestBody?.includes('refresh'),
    beacon,
  )

  // DevTools transport: trusted input on a page without the agent.
  const welcome = await call('press_key', { device: 'demo-devtools', key: 'Ok' })
  check(
    'devtools: Ok dismisses the welcome dialog via trusted input',
    welcome.via === 'cdp-input' && welcome.after?.focused?.label === 'Northern Lights',
    welcome,
  )
  const journey = await call('run_journey', { name: 'home-browse-details', device: 'demo-devtools' })
  check('devtools: home-browse-details journey', journey.ok === true, journey.summary ?? journey)
  const shot = await h.client.callTool({ name: 'screenshot', arguments: { device: 'demo-devtools' } })
  check(
    'devtools: screenshot returns an image',
    shot.content.some((c) => c.type === 'image'),
    shot.content[0],
  )

  // Network capture on the DevTools transport (bodies from the browser, same policy and redaction).
  const cdp = await networkChecks(h, 'demo-devtools', 'devtools')
  check(
    'devtools: Set-Cookie response header redacted',
    cdp.login?.responseHeaders?.['set-cookie'] === REDACTED,
    cdp.login,
  )

  await robustnessChecks(h, 'demo', 'agent', `http://localhost:${DEMO_PORT}/?tvmcp=demo`)
  await robustnessChecks(h, 'demo-devtools', 'devtools', `http://localhost:${DEMO_PORT + 1}/`)

  const never = await h.client.callTool({
    name: 'evaluate',
    arguments: { device: 'demo-devtools', expression: 'new Promise(function () {})' },
  })
  check(
    'devtools: evaluate of a promise that never settles fails with a clear timeout',
    never.isError === true && /did not settle/.test(never.content?.[0]?.text ?? ''),
    never.content?.[0]?.text,
  )

  // wait_for while a document is still loading (no <body> yet) keeps polling instead of crashing.
  await call('navigate', { device: 'demo-devtools', url: `http://localhost:${DEMO_PORT + 1}/stall?ms=3000` })
  const stalled = await h.client.callTool({
    name: 'wait_for',
    arguments: { device: 'demo-devtools', text: 'Stalled page ready', timeoutMs: 15000 },
  })
  check(
    'devtools: wait_for during a page load without <body> polls through it',
    !stalled.isError && JSON.parse(stalled.content?.[0]?.text ?? '{}').ok === true,
    stalled.content?.[0]?.text,
  )
  await call('navigate', { device: 'demo-devtools', url: `http://localhost:${DEMO_PORT + 1}/` })
  await call('wait_for', { device: 'demo-devtools', selector: '[data-focus-id]', timeoutMs: 10000 })

  // A page that is navigating away gets its loadingFinished only after the next page commits, when Chrome no
  // longer returns the body; the streamed copy keeps it.
  await call('evaluate', {
    device: 'demo-devtools',
    expression:
      "(location.href = '/slow-nav?ms=3000&to=%2F%3Farrived%3D1', setTimeout(function () { fetch('/api/fast?outgoing=1') }, 300), true)",
  })
  await call('wait_for', { device: 'demo-devtools', urlIncludes: 'arrived=1', timeoutMs: 15000 })
  await sleep(500)
  const outgoing = (
    await call('network_requests', { device: 'demo-devtools', urlPattern: 'outgoing=1', includeBodies: true })
  ).entries?.at(-1)
  check(
    'devtools: response body kept for a request made by a page that is navigating away',
    outgoing?.status === 200 && outgoing?.responseBody?.includes('"fast":true'),
    outgoing && { status: outgoing.status, body: outgoing.responseBody, omitted: outgoing.responseBodyOmitted },
  )

  // Holding API responses to read their bodies must never stall a stream the page reads as it arrives.
  const firstEvent = await call('evaluate', {
    device: 'demo-devtools',
    expression:
      "new Promise(function (resolve) { var t = Date.now(); fetch('/api/sse').then(function (r) { var reader = r.body.getReader(); reader.read().then(function () { resolve(Date.now() - t); reader.cancel() }) }) })",
  })
  check(
    'devtools: an event stream reaches the page at once (not held for its body)',
    firstEvent.value < 1000,
    firstEvent,
  )

  // WebSockets carry what DevTools shows for them: who opened it and the upgrade request headers.
  const socket = (await call('network_requests', { device: 'demo-devtools', urlPattern: 'api/ws' })).entries?.at(-1)
  check(
    'devtools: WebSocket has its initiator and handshake request headers',
    socket?.initiatorInfo?.type === 'script' &&
      /app\.js/.test(socket?.initiatorInfo?.url ?? '') &&
      Boolean(socket?.requestHeaders?.['sec-websocket-key']) &&
      socket?.resourceType === 'WebSocket',
    socket && { initiatorInfo: socket.initiatorInfo, headers: Object.keys(socket.requestHeaders ?? {}) },
  )

  // Other tabs on the same DevTools endpoint: browser pages are never targets, and a registry name picks the
  // page its match describes even when a blank tab is listed first.
  const devtoolsBase = `http://127.0.0.1:${DEVTOOLS_PORT}`
  const opened = []
  for (const url of ['chrome://version', 'about:blank']) {
    const res = await fetch(`${devtoolsBase}/json/new?${url}`, { method: 'PUT' })
    if (res.ok) opened.push((await res.json()).id)
  }
  const chosen = await call('use_device', { device: 'demo-devtools' })
  const listedNow = (await call('list_devices')).devices ?? []
  for (const id of opened) await fetch(`${devtoolsBase}/json/close/${id}`)
  check(
    'devtools: registry name resolves to the page its match describes, not another tab',
    opened.length === 2 && chosen.resolvedTo?.url?.includes(`localhost:${DEMO_PORT + 1}`),
    { opened: opened.length, resolvedTo: chosen.resolvedTo?.url },
  )
  check(
    'devtools: browser pages (chrome://, devtools://) are not listed as devices',
    !listedNow.some((d) => /^(chrome|devtools|chrome-extension):/.test(d.url ?? '')),
    listedNow.map((d) => d.url),
  )

  // DevTools parity: what the Network and Console panels show beyond the basics.
  const profileReq = (
    await call('network_requests', { device: 'demo-devtools', urlPattern: 'api/profile' })
  ).entries?.at(-1)
  check(
    'devtools: Cookie request header (sent cookies) captured and redacted',
    profileReq?.requestHeaders?.cookie === REDACTED,
    profileReq,
  )
  check(
    'devtools: timing phases, transfer size, address, protocol',
    typeof profileReq?.timing?.wait === 'number' &&
      typeof profileReq?.timing?.total === 'number' &&
      profileReq?.transferSize > 0 &&
      /:\d+$/.test(profileReq?.remoteAddress ?? '') &&
      Boolean(profileReq?.protocol),
    profileReq,
  )
  check(
    'devtools: initiator (script and line) and priority',
    profileReq?.initiatorInfo?.type === 'script' &&
      /app\.js/.test(profileReq?.initiatorInfo?.url ?? '') &&
      Boolean(profileReq?.priority),
    profileReq,
  )
  const browserMsgs =
    (await call('console_logs', { device: 'demo-devtools', origin: 'browser', limit: 20000 })).entries ?? []
  check(
    'devtools: browser-originated console messages (failed resource load)',
    browserMsgs.some((m) => /Failed to load resource.*404/.test(m.text) && /missing-artwork/.test(m.source ?? '')),
    browserMsgs,
  )
  const docs = (await call('network_requests', { device: 'demo-devtools', limit: 1000 })).entries ?? []
  const docRecords = docs.filter((d) => d.resourceType === 'Document')
  check(
    'devtools: every document load complete across navigations (none left pending)',
    docRecords.length >= 2 && docRecords.every((d) => !d.pending && d.status >= 200 && d.status < 400),
    docRecords.map((d) => ({ url: d.url, pending: d.pending, status: d.status })),
  )
  const reconnects = (
    (await call('timeline', { device: 'demo-devtools', kinds: ['devtools'], limit: 2000 })).rows ?? []
  ).filter((r) => r.summary.startsWith('reconnected'))
  check('devtools: no socket reconnects across navigations (nothing lost)', reconnects.length === 0, reconnects)

  // Big results never cross the MCP connection: they spill to a file, and the whole capture exports as HAR.
  const { readFileSync } = await import('node:fs')
  const everything = await call('network_requests', { device: 'demo-devtools', includeBodies: true, limit: 1000 })
  check(
    'large results spill to a file instead of the connection',
    typeof everything.spilledTo === 'string' || Array.isArray(everything.entries),
    everything.spilledTo ?? everything.count,
  )
  const exported = await call('export_capture', { device: 'demo-devtools' })
  const har = exported.files ? JSON.parse(readFileSync(exported.files.har, 'utf8')) : null
  const harLogin = har?.log?.entries?.find((e) => e.request.url.includes('api/login'))
  check(
    'export_capture writes a HAR 1.2 with bodies, timings and DevTools fields',
    har?.log?.version === '1.2' &&
      har.log.entries.length === exported.counts.requests &&
      harLogin?.request?.postData?.text?.includes(`"password":"${REDACTED}"`) &&
      harLogin?.response?.content?.text?.includes(`"token":"${REDACTED}"`) &&
      typeof harLogin?.timings?.wait === 'number' &&
      Boolean(harLogin?._resourceType),
    { counts: exported.counts, login: harLogin && { timings: harLogin.timings, type: harLogin._resourceType } },
  )
  const consoleLines = exported.files
    ? readFileSync(exported.files.console, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : []
  check(
    'export_capture writes the console (formatted, with browser messages)',
    consoleLines.some((c) => c.origin === 'browser') && consoleLines.some((c) => c.text?.startsWith('[demo] boot ok')),
    consoleLines.length,
  )
} catch (error) {
  failure = error
}
await h.finish(failure)
