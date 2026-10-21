#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { UNIVERSAL_KEYS } from '@tv-mcp/protocol'
import { z } from 'zod'

import {
  DEFAULT_KEY_INTERVAL_MS,
  DEFAULT_SETTLE_MS,
  fileAppUrl,
  NAVIGATION_SETTLE_MS,
  pressAndSettle,
  typeOnKeyboard,
  WAIT_POLL_MS,
} from './actions.js'
import { screenshot as adbScreenshot, setupDevice } from './adb.js'
import { CdpSession } from './cdp.js'
import { config, loadProfile, PACK_DIR } from './config.js'
import { loadDevices } from './devices.js'
import {
  agent,
  closeAll,
  describeRegistry,
  launchRegistryDevice,
  listAll,
  owner,
  resolveSession,
  resolveSessions,
  state,
  withSession,
} from './hub.js'
import { exportCapture, MAX_RESULT_CHARS, spill } from './export.js'
import { loadAllJourneys, runJourneyOnDevices } from './journeys.js'
import { listChecklists, loadChecklist, runSanity } from './sanity.js'
import { errorMessage, sleep } from './session.js'
import { runLockstep, stepSchema } from './steps.js'

const VERSION = '0.1.0'

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] })
const fail = (error: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: errorMessage(error) }] })
const tool =
  <A>(run: (args: A, extra: { signal: AbortSignal }) => Promise<unknown>, name = 'result') =>
  async (args: A, extra: { signal: AbortSignal }) => {
    try {
      const result = await run(args, extra)
      if (result && typeof result === 'object' && 'content' in result) return result as ReturnType<typeof json>
      const text = JSON.stringify(result, null, 2)
      // Oversized results go to a file: MCP clients disconnect on huge messages and the capture would be lost.
      return text.length > MAX_RESULT_CHARS ? json(await spill(name, text)) : json(result)
    } catch (error) {
      return fail(error)
    }
  }

const deviceArg = z
  .string()
  .optional()
  .describe(
    'Device name (agent or devices.json), DevTools target id, or a substring of ip/user agent/url. Omit with one device or after use_device.',
  )
const launchArg = z
  .enum(['auto', 'always', 'never'])
  .default('auto')
  .describe(
    'For devices.json devices with launch config: auto relaunches unreachable ones, always relaunches all, never skips.',
  )

const pressOptionShape = {
  times: z.number().int().min(1).max(50).default(1).describe('Repeat the press this many times.'),
  intervalMs: z.number().int().min(0).default(DEFAULT_KEY_INTERVAL_MS).describe('Gap between repeats.'),
  holdMs: z.number().int().min(0).default(0).describe('Hold the key down (long press / scrubbing).'),
  settleMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      `Max wait for focus/url to change; returns early on change. Default ${DEFAULT_SETTLE_MS}ms, ${NAVIGATION_SETTLE_MS}ms for Ok/Back.`,
    ),
}

const server = new McpServer({ name: 'tv-mcp', version: VERSION })

server.registerTool(
  'list_devices',
  {
    title: 'List connected TV devices',
    description:
      `Devices on the relay (${config.relayUrl}; apps with the tv-mcp agent: stable names, push events, claims) and ` +
      'DevTools devices from devices.json (debuggable WebViews and inspectors, any build). Also returns the registry ' +
      'with whether each named device is online and launchable.',
    inputSchema: {},
  },
  tool(
    async () => ({
      relay: config.relayUrl,
      pack: PACK_DIR,
      profile: (await loadProfile()).name,
      owner,
      defaultDevice: state.defaultDevice ?? null,
      devices: await listAll(),
      registry: await describeRegistry(),
    }),
    'list_devices',
  ),
)

server.registerTool(
  'use_device',
  {
    title: 'Pick the default device',
    description:
      'Sets the device used by every other tool when "device" is omitted, and claims it on the relay so other sessions ' +
      'cannot drive it at the same time. Pass the agent name, a devices.json name, or a stable matcher such as the ip.',
    inputSchema: { device: z.string(), force: z.boolean().default(false).describe('Take over an existing claim.') },
  },
  tool(async ({ device, force }: { device: string; force: boolean }) => {
    const session = await resolveSession(device)
    state.defaultDevice = device
    const claim =
      session.info.transport === 'agent'
        ? await agent.claim(session.info.id, false, force)
        : 'n/a (DevTools devices have no claims)'
    return { defaultDevice: device, resolvedTo: session.info, claim }
  }, 'use_device'),
)

server.registerTool(
  'press_key',
  {
    title: 'Press a remote-control key',
    description:
      'Sends a remote key to the app as its input layer receives one. Navigate only with Up/Down/Left/Right/Ok/Back ' +
      'as a viewer would; never click. Returns as soon as focus or url changes, with the focused element. Menus that ' +
      'load a page when focus dwells on an item need presses without pauses.',
    inputSchema: { key: z.enum(UNIVERSAL_KEYS), device: deviceArg, ...pressOptionShape },
  },
  tool(
    async ({
      key,
      device,
      ...opts
    }: {
      key: (typeof UNIVERSAL_KEYS)[number]
      device?: string
      times: number
      intervalMs: number
      holdMs: number
      settleMs?: number
    }) => withSession(device, (session) => pressAndSettle(session, key, opts)),
    'press_key',
  ),
)

server.registerTool(
  'press_sequence',
  {
    title: 'Press a planned sequence of keys, on one device or several in lockstep',
    description:
      'Runs several presses in one call. A step can press until a label matches (untilFocus), wait for a page load ' +
      '(waitUrl/waitText/waitSelector/waitGone/waitVideo; an unmatched wait fails the step) and be checked against an expected ' +
      'focus label or url. With `devices`, the plan runs on every device with a barrier after each step; a device ' +
      'that fails drops out while the others continue (or all stop with stopAllOnMismatch). Returns per-device traces ' +
      'and per-step timings. Plan legs from a snapshot, e.g. "Left untilFocus Home, Down untilFocus Settings, Ok waitUrl settings".',
    inputSchema: {
      device: deviceArg,
      devices: z
        .array(z.string())
        .min(1)
        .max(20)
        .optional()
        .describe('Run the same plan on these devices in lockstep.'),
      steps: z.array(stepSchema).min(1).max(60),
      intervalMs: z.number().int().min(0).default(DEFAULT_KEY_INTERVAL_MS),
      stopOnMismatch: z.boolean().default(true).describe('Stop a device at its first failed step.'),
      stopAllOnMismatch: z.boolean().default(false).describe('Stop every device when any device fails a step.'),
    },
  },
  tool(
    async (
      {
        device,
        devices,
        steps,
        intervalMs,
        stopOnMismatch,
        stopAllOnMismatch,
      }: {
        device?: string
        devices?: string[]
        steps: z.infer<typeof stepSchema>[]
        intervalMs: number
        stopOnMismatch: boolean
        stopAllOnMismatch: boolean
      },
      extra,
    ) => {
      const sessions = await resolveSessions(devices ?? [device ?? state.defaultDevice])
      const result = await runLockstep(sessions, steps, {
        intervalMs,
        stopOnMismatch,
        stopAllOnMismatch,
        signal: extra.signal,
      })
      if (devices) return result
      const only = Object.values(result.devices)[0]
      return {
        ...only,
        totalMs: result.totalMs,
        stepTimings: result.stepTimings.map(({ step, key, ms }) => ({ step, key, ms })),
      }
    },
    'press_sequence',
  ),
)

server.registerTool(
  'list_journeys',
  {
    title: 'List the journey library',
    description: `Journeys are JSON plans in ${config.journeysDir} that run unchanged on any device: a start condition plus press_sequence steps.`,
    inputSchema: {},
  },
  tool(
    async () =>
      (await loadAllJourneys()).map((j) => ({
        name: j.name,
        description: j.description,
        steps: j.steps.length,
        reset: j.start.reset,
        notes: j.notes ?? [],
      })),
    'list_journeys',
  ),
)

server.registerTool(
  'run_journey',
  {
    title: 'Run a journey on one or more devices',
    description:
      'Loads a journey by name, optionally reloads each device at its app root and waits for the start condition, then ' +
      'runs the steps in lockstep across all devices. Returns pass/fail per device, per-step timings per device (a ' +
      'cross-platform performance comparison) and the traces.',
    inputSchema: {
      name: z.string().describe('Journey name, as listed by list_journeys.'),
      vars: z
        .record(z.string(), z.string())
        .optional()
        .describe('Values for ${VAR} placeholders (fallback: env TVMCP_<VAR>).'),
      device: deviceArg,
      devices: z.array(z.string()).min(1).max(20).optional(),
      reset: z.boolean().optional().describe("Override the journey's start.reset."),
      stopAllOnMismatch: z.boolean().default(false),
      launch: launchArg,
    },
  },
  tool(
    async (
      {
        name,
        vars,
        device,
        devices,
        reset,
        stopAllOnMismatch,
        launch,
      }: {
        name: string
        vars?: Record<string, string>
        device?: string
        devices?: string[]
        reset?: boolean
        stopAllOnMismatch: boolean
        launch: 'auto' | 'always' | 'never'
      },
      extra,
    ) =>
      runJourneyOnDevices(name, vars, devices ?? [device ?? state.defaultDevice], {
        reset,
        stopAllOnMismatch,
        launch,
        signal: extra.signal,
      }),
    'run_journey',
  ),
)

server.registerTool(
  'list_sanity',
  {
    title: 'List sanity checklists',
    description: `Checklists in ${config.sanityDir}: the rows, which journeys cover each, and per-platform N/A rules.`,
    inputSchema: {},
  },
  tool(
    async () => ({ checklists: await Promise.all((await listChecklists()).map((n) => loadChecklist(n))) }),
    'list_sanity',
  ),
)

server.registerTool(
  'run_sanity',
  {
    title: 'Run a sanity checklist and produce the matrix',
    description:
      'Runs every item of a checklist on every device (items in order, devices in lockstep per journey, reset between ' +
      'journeys) and returns the matrix: PASS, FAIL, WITH ISSUE (only soft steps failed), N/A, UNABLE (rule or device ' +
      'unreachable) or NOT AUTOMATED (no journey yet). Writes <reports>/<time>-<checklist>.json and .md.',
    inputSchema: {
      checklist: z.string(),
      devices: z.array(z.string()).min(1).max(20),
      vars: z.record(z.string(), z.string()).optional(),
      items: z.array(z.number().int()).optional().describe('Only these item ids.'),
      launch: launchArg,
    },
  },
  tool(
    async (
      args: {
        checklist: string
        devices: string[]
        vars?: Record<string, string>
        items?: number[]
        launch: 'auto' | 'always' | 'never'
      },
      extra,
    ) => runSanity({ ...args, signal: extra.signal }),
    'run_sanity',
  ),
)

server.registerTool(
  'launch_app',
  {
    title: 'Cold-start the app on a device',
    description:
      `Wakes the device, restarts the app on its configured url (adb intent, Tizen sdb debug launch, or a launch ` +
      `command), sends launcher keys if configured, and waits until the page is reachable. Devices live in ${config.devicesFile}. ` +
      'Use it to recover a device that dropped off (screensaver, crash) or to put it on a specific build.',
    inputSchema: {
      device: z.string().describe('A name from devices.json.'),
      waitMs: z.number().int().min(5000).max(180000).default(60_000),
    },
  },
  tool(
    async ({ device, waitMs }: { device: string; waitMs: number }) => launchRegistryDevice(device, waitMs),
    'launch_app',
  ),
)

server.registerTool(
  'adb_setup',
  {
    title: 'One-time adb prep for an Android TV device',
    description:
      'Pushes out the screen-off, screensaver and sleep timeouts (screensavers drop the page socket and are often ' +
      "impossible to disable in the menus) and marks the device entry's `permissions` user-fixed so runtime prompts " +
      'stop interrupting cold starts. Settings persist across reboots.',
    inputSchema: { device: z.string().describe('A name from devices.json with an adb serial.') },
  },
  tool(async ({ device }: { device: string }) => {
    const entry = (await loadDevices())[device]
    if (!entry?.adb) throw new Error(`"${device}" has no adb serial in ${config.devicesFile}`)
    return {
      device,
      serial: entry.adb,
      settings: await setupDevice(entry.adb, entry.launch?.package, entry.permissions),
    }
  }, 'adb_setup'),
)

server.registerTool(
  'screenshot',
  {
    title: 'Screenshot a device',
    description:
      'Captures what the device shows: over DevTools (Page.captureScreenshot) when the page is reachable that way, ' +
      'otherwise over adb, which also works when the page is unreachable (launcher, error screens). Returns the image ' +
      'and the saved file path.',
    inputSchema: { device: z.string().describe('A devices.json name, or any device selector for DevTools targets.') },
  },
  tool(async ({ device }: { device: string }) => {
    const file = path.join(tmpdir(), `tv-mcp-${device.replace(/[^\w.-]/g, '_')}-${Date.now()}.png`)
    let png: Buffer | undefined
    let via = ''
    try {
      const session = await resolveSession(device)
      if (session instanceof CdpSession) {
        if (!session.connected) await session.connect()
        const shot = (await session.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
        png = Buffer.from(shot.data, 'base64')
        via = 'devtools'
      }
    } catch {
      // fall back to adb
    }
    if (!png) {
      const entry = (await loadDevices())[device]
      if (!entry?.adb)
        throw new Error(`"${device}" is not reachable over DevTools and has no adb serial in ${config.devicesFile}`)
      png = await adbScreenshot(entry.adb)
      via = 'adb'
    }
    await writeFile(file, png)
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ device, via, file, bytes: png.length }) },
        ...(png.length > 0 ? [{ type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' }] : []),
      ],
    }
  }, 'screenshot'),
)

server.registerTool(
  'type_text',
  {
    title: 'Type on the on-screen keyboard',
    description:
      'Types a string with the focused on-screen keyboard: reads the key grid, moves with arrows, presses Ok per ' +
      'character, switching case/symbol layers when the keyboard has them. Focus must already be on the keyboard ' +
      '(found through the profile keyboard.sectionPattern). Use "\\b" for delete.',
    inputSchema: {
      device: deviceArg,
      text: z.string().min(1).max(200),
      submitKey: z.string().optional().describe('Label of a key to press when done, e.g. "Next", "Done", "Search".'),
    },
  },
  tool(
    async ({ device, text, submitKey }: { device?: string; text: string; submitKey?: string }) =>
      withSession(device, (session) => typeOnKeyboard(session, text, submitKey)),
    'type_text',
  ),
)

server.registerTool(
  'clear_storage',
  {
    title: 'Clear all app storage on the device',
    description:
      "Back to first launch: the app's signOut hook when the agent has one (expires HttpOnly sessions server-side), " +
      'Storage.clearDataForOrigin on DevTools devices, then cookies, web storage, IndexedDB, caches and service workers, ' +
      'then a reload at the app root.',
    inputSchema: {
      device: deviceArg,
      reload: z.boolean().default(true).describe('Reload the app root after clearing.'),
    },
  },
  tool(
    async ({ device, reload }: { device?: string; reload: boolean }) =>
      withSession(device, (session) => session.clearStorage(reload)),
    'clear_storage',
  ),
)

server.registerTool(
  'snapshot',
  {
    title: 'Read the current UI state',
    description:
      'What a viewer sees: url, focused element (label, section, position), populated focus sections, visible ' +
      'focusable elements sorted by distance from focus, headings, dialogs, live-region text and <video> state. ' +
      'Use it to plan the next presses instead of assuming layout.',
    inputSchema: { device: deviceArg, maxElements: z.number().int().min(1).max(200).default(12) },
  },
  tool(
    async ({ device, maxElements }: { device?: string; maxElements: number }) =>
      withSession(device, (session) => session.snapshot(maxElements)),
    'snapshot',
  ),
)

server.registerTool(
  'read_text',
  {
    title: 'Read visible text',
    description: 'Visible text of an element (default: the whole page). Useful for synopses, error copy, prices.',
    inputSchema: {
      device: deviceArg,
      selector: z.string().default('body'),
      maxChars: z.number().int().min(50).max(20000).default(4000),
    },
  },
  tool(
    async ({ device, selector, maxChars }: { device?: string; selector: string; maxChars: number }) =>
      withSession(device, (session) => session.readText(selector, maxChars)),
    'read_text',
  ),
)

server.registerTool(
  'wait_for',
  {
    title: 'Wait for a UI condition',
    description:
      'Polls until any given condition holds or the timeout passes. Use after Ok/Back instead of sleeping blindly.',
    inputSchema: {
      device: deviceArg,
      text: z.string().optional().describe('Page text contains this.'),
      selector: z.string().optional().describe('A CSS selector matches.'),
      gone: z
        .string()
        .optional()
        .describe('No visible element matches this CSS selector (a loading overlay has gone).'),
      focusedLabel: z.string().optional().describe('Focused element label contains this (case-insensitive).'),
      urlIncludes: z.string().optional(),
      videoPlaying: z.boolean().optional().describe('A <video> is playing with data.'),
      videoNearEnd: z
        .number()
        .min(1)
        .optional()
        .describe('A content-length <video> is playing with at most this many seconds left.'),
      noDialog: z.boolean().optional().describe('No dialog is open.'),
      timeoutMs: z.number().int().min(100).max(120000).default(10000),
    },
  },
  tool(async ({ device, timeoutMs, ...conditions }: { device?: string; timeoutMs: number; [k: string]: unknown }) => {
    if (!Object.values(conditions).some((v) => v !== undefined)) throw new Error('give at least one condition')
    return withSession(device, async (session) => {
      const deadline = Date.now() + timeoutMs
      let last: { matched: string[] } | undefined
      while (Date.now() < deadline) {
        last = await session.condition(conditions)
        if (last.matched.length > 0) return { ok: true, ...last }
        await sleep(WAIT_POLL_MS)
      }
      return { ok: false, timedOutAfterMs: timeoutMs, ...last }
    })
  }, 'wait_for'),
)

server.registerTool(
  'navigate',
  {
    title: 'Load a URL on the device',
    description: 'Sets location.href on the device, e.g. a deeplink. Agent device names survive the reload.',
    inputSchema: { device: deviceArg, url: z.string().url() },
  },
  tool(
    async ({ device, url }: { device?: string; url: string }) =>
      withSession(device, (session) => session.navigate(fileAppUrl(url))),
    'navigate',
  ),
)

server.registerTool(
  'evaluate',
  {
    title: 'Evaluate JavaScript on the device',
    description:
      'Runs an expression in the page and returns its JSON-serialisable result (promises are awaited, up to 10 s). Escape hatch ' +
      'for state the other tools do not expose. Do not click; use press_key for navigation.',
    inputSchema: { device: deviceArg, expression: z.string() },
  },
  tool(
    async ({ device, expression }: { device?: string; expression: string }) =>
      withSession(device, async (session) => ({ value: await session.evaluate(expression) })),
    'evaluate',
  ),
)

server.registerTool(
  'console_logs',
  {
    title: 'Read console output',
    description:
      'The console as DevTools shows it, oldest first: format specifiers applied, objects expanded (sensitive keys ' +
      'redacted), source locations, uncaught exceptions, and on DevTools devices the messages the browser logs ' +
      "itself (CORS, ORB, failed loads, deprecations). Times are on this server's clock.",
    inputSchema: {
      device: deviceArg,
      pattern: z.string().optional().describe('Regex filter on the message text.'),
      level: z.string().optional().describe('log | info | warn | error | debug | exception'),
      origin: z
        .enum(['console', 'browser', 'exception'])
        .optional()
        .describe('console: the page console API; browser: messages the browser logs itself; exception: uncaught.'),
      sinceMs: z.number().int().min(0).optional().describe('Only the last N milliseconds.'),
      limit: z.number().int().min(1).max(20000).default(100),
    },
  },
  tool(
    async ({
      device,
      pattern,
      level,
      origin,
      sinceMs,
      limit,
    }: {
      device?: string
      pattern?: string
      level?: string
      origin?: string
      sinceMs?: number
      limit: number
    }) =>
      withSession(device, async (session) => {
        const regex = pattern ? new RegExp(pattern, 'i') : null
        const since = sinceMs !== undefined ? Date.now() - sinceMs : null
        const r = session.recorder
        const entries = r.console
          .map(({ at, ...e }) => ({ t: r.align(at, e.clock), ...e }))
          .filter(
            (e) =>
              (!level || e.level === level) &&
              (!origin || (e.origin ?? 'console') === origin) &&
              (!regex || regex.test(e.text)) &&
              (since === null || e.t >= since),
          )
          .sort((a, b) => a.t - b.t)
          .slice(-limit)
          .map(({ t, ...e }) => ({ at: new Date(t).toISOString(), ...e }))
        return { transport: session.info.transport, count: entries.length, entries }
      }),
    'console_logs',
  ),
)

server.registerTool(
  'network_requests',
  {
    title: 'Read network requests',
    description:
      'Requests paired with their responses by id, listed in request start order (order "end" for completion order), ' +
      'with in-flight requests marked pending. Each has method, url, status, timing, headers and body sizes; bodies ' +
      'come with includeBodies or a single `id` (capture and redaction follow the profile network policy). ' +
      'origin "server" lists exchanges the app reported for its server side (e.g. SSR fetches).',
    inputSchema: {
      device: deviceArg,
      id: z.string().optional().describe('Return this one exchange in full, bodies included.'),
      order: z.enum(['start', 'end']).default('start'),
      origin: z.enum(['device', 'server']).optional(),
      urlPattern: z.string().optional().describe('Regex filter on the URL.'),
      failedOnly: z.boolean().default(false).describe('Only failed requests or status >= 400.'),
      pendingOnly: z.boolean().default(false).describe('Only requests still waiting for a response.'),
      sinceMs: z.number().int().min(0).optional().describe('Only requests started in the last N milliseconds.'),
      includeBodies: z.boolean().default(false),
      limit: z.number().int().min(1).max(1000).default(100),
    },
  },
  tool(
    async ({
      device,
      id,
      ...query
    }: {
      device?: string
      id?: string
      order: 'start' | 'end'
      origin?: 'device' | 'server'
      urlPattern?: string
      failedOnly: boolean
      pendingOnly: boolean
      sinceMs?: number
      includeBodies: boolean
      limit: number
    }) =>
      withSession(device, async (session) => {
        await session.captureNetwork()
        const r = session.recorder
        if (id) {
          const record = r.get(id)
          if (!record) throw new Error(`no request ${id} on this device`)
          return r.present(record, true)
        }
        const entries = r.query(query)
        return { transport: session.info.transport, clockOffsetMs: r.clockOffsetMs, count: entries.length, entries }
      }),
    'network_requests',
  ),
)

server.registerTool(
  'timeline',
  {
    title: 'What happened, in order',
    description:
      'One ordered list of what tv-mcp did (press, navigate, clearStorage) and what the device reported (focus and ' +
      'route changes, console output, request start and response rows, app-reported server exchanges), on this ' +
      'server\'s clock. Use it to answer "what happened after I pressed Ok": rows carry request ids for network_requests.',
    inputSchema: {
      device: deviceArg,
      sinceMs: z.number().int().min(0).optional().describe('Only the last N milliseconds.'),
      kinds: z
        .array(z.string())
        .optional()
        .describe(
          'Only these kinds: press, navigate, clearStorage, focus, route, console (or console.error…), request, response, server-request, server-response.',
        ),
      limit: z.number().int().min(1).max(2000).default(200),
    },
  },
  tool(
    async ({ device, sinceMs, kinds, limit }: { device?: string; sinceMs?: number; kinds?: string[]; limit: number }) =>
      withSession(device, async (session) => {
        await session.captureNetwork()
        const rows = session.recorder.timeline({ sinceMs, kinds, limit })
        return {
          transport: session.info.transport,
          clockOffsetMs: session.recorder.clockOffsetMs,
          count: rows.length,
          rows: rows.map(({ t, ...row }) => row),
        }
      }),
    'timeline',
  ),
)

server.registerTool(
  'export_capture',
  {
    title: 'Export the capture to files (HAR + console + timeline)',
    description:
      'Writes everything recorded for the device to <reports>/captures/<time>-<device>/: network.har (HAR 1.2, as ' +
      'DevTools "Save all as HAR" writes it, bodies included; opens in the DevTools Network panel), console.jsonl and ' +
      'timeline.jsonl. Returns the paths and counts. Use it instead of pulling large listings through tool results.',
    inputSchema: { device: deviceArg },
  },
  tool(
    async ({ device }: { device?: string }) =>
      withSession(device, async (session) =>
        exportCapture(session.recorder, session.info.name ?? session.info.id, VERSION),
      ),
    'export_capture',
  ),
)

function shutdown(reason: string) {
  console.error(`[tv-mcp] exiting: ${reason}`)
  try {
    closeAll()
  } finally {
    process.exit(0)
  }
}

async function main() {
  const transport = new StdioServerTransport()
  // A reconnecting client leaves the old process alive with every device session open; exit with stdio.
  transport.onclose = () => shutdown('stdio closed')
  process.stdin.on('end', () => shutdown('stdin ended'))
  process.stdin.on('close', () => shutdown('stdin closed'))
  await server.connect(transport)
  // Join the relay now, so device events are recorded before the first tool call.
  void agent.warmUp().catch(() => undefined)
  console.error(`[tv-mcp] ${VERSION} ready as ${owner}; relay ${config.relayUrl}; pack ${PACK_DIR}`)
}

process.on('unhandledRejection', (reason) => {
  console.error(
    `[tv-mcp] unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  )
})
process.on('uncaughtException', (error) =>
  console.error(`[tv-mcp] uncaught exception: ${error.stack ?? error.message}`),
)
process.on('SIGINT', () => shutdown('SIGINT'))

main().catch((error) => {
  console.error('[tv-mcp] fatal', error)
  process.exit(1)
})
