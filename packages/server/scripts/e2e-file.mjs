// End-to-end test for packaged (file://) apps, the way Tizen and similar platforms run them: the demo app is
// loaded from disk in three copies and driven through the real MCP server.
//   file-relay     agent loaded from the relay's /agent.js
//   file-bundled   agent bundled into the package, pointed at the relay with data-relay
//   file-devtools  agent bundled without data-relay (must refuse to start), driven over DevTools instead
// Covers: journey reset (reload index.html in place), clear_storage reload, router urls without .html mapped onto
// the exported files, and real page-to-page navigation between package files.
//   node packages/server/scripts/e2e-file.mjs
// Env: CHROME, RELAY_PORT (18090), DEVTOOLS_PORT (9224).
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createHarness, repo } from './harness.mjs'

const RELAY_PORT = Number(process.env.RELAY_PORT ?? 18090)
const DEVTOOLS_PORT = Number(process.env.DEVTOOLS_PORT ?? 9224)
const relayUrl = `http://localhost:${RELAY_PORT}`
const AGENT_TAG = /<script src="http:\/\/localhost:8080\/agent\.js"[^>]*><\/script>/

const h = createHarness()

/** A copy of the demo app as a package directory, with each page's agent tag replaced by `tag`. */
function packageApp(name, tag, bundleAgent) {
  const dir = path.join(h.tempDir(`tvmcp-e2e-${name}-`), 'app')
  mkdirSync(dir)
  const src = path.join(repo, 'examples/demo-app')
  for (const file of readdirSync(src)) {
    if (file.endsWith('.mjs')) continue
    const from = path.join(src, file)
    if (file.endsWith('.html')) writeFileSync(path.join(dir, file), readFileSync(from, 'utf8').replace(AGENT_TAG, tag))
    else copyFileSync(from, path.join(dir, file))
  }
  if (bundleAgent)
    copyFileSync(path.join(repo, 'packages/agent/dist/tv-mcp-agent.js'), path.join(dir, 'tv-mcp-agent.js'))
  return pathToFileURL(path.join(dir, 'index.html')).href
}

let failure
try {
  h.start('node', [path.join(repo, 'packages/relay/dist/server.js')], { PORT: String(RELAY_PORT), HOST: '127.0.0.1' })
  await h.until('relay', async () => (await fetch(`${relayUrl}/health`)).ok)

  const relayCopy = packageApp(
    'relay',
    `<script src="${relayUrl}/agent.js" data-autostart data-platform="demo" data-name="file-relay"></script>`,
    false,
  )
  const bundledCopy = packageApp(
    'bundled',
    `<script src="tv-mcp-agent.js" data-autostart data-platform="demo" data-name="file-bundled" data-relay="${relayUrl}"></script>`,
    true,
  )
  const unconfiguredCopy = packageApp('devtools', '<script src="tv-mcp-agent.js" data-autostart></script>', true)

  h.chrome(relayCopy)
  h.chrome(bundledCopy)
  h.chrome(unconfiguredCopy, [`--remote-debugging-port=${DEVTOOLS_PORT}`])
  const devices = async () => (await (await fetch(`${relayUrl}/agent/devices`)).json()).devices
  await h.until('both file:// agents on the relay', async () => {
    const names = (await devices()).map((d) => d.name)
    return names.includes('file-relay') && names.includes('file-bundled')
  })
  await h.until('DevTools endpoint', async () => (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/version`)).ok)

  const registered = await devices()
  h.check(
    'agents register from file:// pages (relay-served and bundled)',
    registered.filter((d) => d.url.startsWith('file://')).length === 2,
    registered.map((d) => ({ name: d.name, url: d.url })),
  )

  // A pack with the example journeys plus file-routing journeys.
  const pack = h.tempDir('tvmcp-e2e-pack-')
  cpSync(path.join(repo, 'examples/profile.json'), path.join(pack, 'profile.json'))
  cpSync(path.join(repo, 'examples/journeys'), path.join(pack, 'journeys'), { recursive: true })
  writeFileSync(
    path.join(pack, 'devices.json'),
    JSON.stringify({
      'file-relay': { match: 'file-relay' },
      'file-bundled': { match: 'file-bundled' },
      'file-devtools': { match: 'not-an-agent', devtools: `http://127.0.0.1:${DEVTOOLS_PORT}` },
    }),
  )
  writeFileSync(
    path.join(pack, 'journeys', 'file-router-url.json'),
    JSON.stringify({
      name: 'file-router-url',
      description:
        'A router url without .html (player?…) loads the exported player.html, and Ok returns to index.html.',
      steps: [
        {
          navigate: 'player?title=Signal%20Lost',
          waitSelector: '#player-title',
          expectUrl: 'player.html?title=Signal%20Lost',
          expectFocus: 'Back to home',
        },
        {
          key: 'Ok',
          waitSelector: '[data-focus-section=featuredRail] [data-focus-id]',
          expectUrl: 'index.html',
          expectFocus: 'Northern Lights',
        },
      ],
    }),
  )
  writeFileSync(
    path.join(pack, 'journeys', 'file-play-and-return.json'),
    JSON.stringify({
      name: 'file-play-and-return',
      description: 'Programme page (hash route) → Play loads player.html (a page load inside the package) → back home.',
      steps: [
        { key: 'Ok', waitUrl: '#/details/', expectFocus: 'Play' },
        { key: 'Ok', waitUrl: 'player.html', expectFocus: 'Back to home' },
        { key: 'Ok', waitUrl: 'index.html', expectFocus: 'Northern Lights' },
      ],
    }),
  )
  await h.connect({ TVMCP_PACK: pack, TVMCP_RELAY_URL: relayUrl })
  const { call, check } = h
  const both = ['file-relay', 'file-bundled']

  // Agent transport on file:// pages.
  const first = await call('run_journey', { name: 'first-launch-welcome', devices: both })
  check(
    'agent file://: clear storage reloads index.html in place, welcome flow',
    first.ok === true,
    first.summary ?? first,
  )
  const browse = await call('run_journey', { name: 'home-browse-details', devices: both })
  check(
    'agent file://: reset reloads index.html in place, browse journey',
    browse.ok === true,
    browse.summary ?? browse,
  )
  const router = await call('run_journey', { name: 'file-router-url', devices: both })
  check('agent file://: router url mapped onto player.html', router.ok === true, router.summary ?? router)
  const play = await call('run_journey', { name: 'file-play-and-return', devices: both })
  check('agent file://: agent survives page loads between package files', play.ok === true, play.summary ?? play)
  const after = (await devices()).filter((d) => both.includes(d.name))
  check(
    'agent file://: both devices still registered on index.html',
    after.length === 2 && after.every((d) => d.url.includes('index.html')),
    after.map((d) => ({ name: d.name, url: d.url })),
  )

  // A bundled agent without data-relay must not start (there is no relay origin to fall back to).
  const unstarted = await call('evaluate', {
    device: 'file-devtools',
    expression: '!!window.TvMcpAgent && window.TvMcpAgent.current === null',
  })
  check('bundled agent without data-relay does not start', unstarted.value === true, unstarted)

  // DevTools transport on a file:// page.
  const welcome = await call('press_key', { device: 'file-devtools', key: 'Ok' })
  check('devtools file://: trusted Ok dismisses welcome', welcome.after?.focused?.label === 'Northern Lights', welcome)
  const cdpRouter = await call('run_journey', { name: 'file-router-url', device: 'file-devtools' })
  check('devtools file://: reset + router url mapping', cdpRouter.ok === true, cdpRouter.summary ?? cdpRouter)
  const cleared = await call('clear_storage', { device: 'file-devtools' })
  check(
    'devtools file://: clear_storage skips the opaque origin and wipes page-side',
    String(cleared.protocolClear).startsWith('skipped') && cleared.page?.reloading === true,
    cleared,
  )
  const back = await call('wait_for', {
    device: 'file-devtools',
    selector: '[data-focus-id=welcome-continue]',
    timeoutMs: 15000,
  })
  check(
    'devtools file://: after clearing, first launch again on index.html',
    back.ok === true && String(back.url).endsWith('index.html'),
    back,
  )
} catch (error) {
  failure = error
}
await h.finish(failure)
