import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { detectPlatform } from '@tv-mcp/protocol'

import { launchApp, screenshot } from './adb.js'
import { AgentClient, newOwnerId } from './agent.js'
import { CdpClient } from './cdp.js'
import { config, loadProfile } from './config.js'
import { launchable, loadDevices } from './devices.js'
import { sdbDebugLaunch } from './sdb.js'
import { errorMessage, sleep } from './session.js'

import type { DeviceInfo, DeviceSession } from './session.js'

const execFileAsync = promisify(execFile)
const RECONNECT_ERRORS = /timed out|disconnected|not connected|no device "/
const LAUNCH_REGISTER_MS = 60_000
/** After a reload the agent reconnects within a few seconds; DevTools pages re-list similarly. */
export const RESOLVE_RETRY_MS = 15_000
const FRESH_PAGE_MS = 30_000

export const owner = newOwnerId()
export const agent = new AgentClient(config.relayUrl, config.relayToken, owner, loadProfile)
export const cdp = new CdpClient(loadDevices, loadProfile)

// TODO(multi-client): a process-global default breaks parallel runs from several MCP client sessions sharing
// one server. Scope it per client session, or require `device` once more than one target is connected.
export const state: { defaultDevice?: string } = {}

export async function listAll(): Promise<DeviceInfo[]> {
  const [agents, targets] = await Promise.all([agent.listDevices(), cdp.listTargets().catch(() => [])])
  const cdpInfos: DeviceInfo[] = targets.map((t) => ({
    id: t.id,
    name: t.name,
    transport: 'cdp',
    title: t.title,
    url: t.url,
    ip: t.ip,
    userAgent: t.userAgent,
    platform: detectPlatform(t.userAgent),
  }))
  return [...agents, ...cdpInfos]
}

/** devices.json entries with whether each is reachable right now. */
export async function describeRegistry() {
  const registry = await loadDevices()
  const all = await listAll().catch(() => [] as DeviceInfo[])
  return Object.fromEntries(
    Object.entries(registry).map(([name, entry]) => {
      const needle = entry.match.toLowerCase()
      const online = all.some(
        (d) =>
          d.name === name ||
          [d.name, d.id, d.url, d.ip, d.userAgent].some((f) => (f ?? '').toLowerCase().includes(needle)),
      )
      return [name, { ...entry, online, canLaunch: launchable(entry) }]
    }),
  )
}

/** Registry names resolve through their matcher; anything else is used as-is. */
async function relaySelector(selector?: string): Promise<string | undefined> {
  if (!selector) return selector
  const registry = await loadDevices()
  return registry[selector]?.match ?? selector
}

/** Agent devices win; DevTools targets cover builds without the agent. */
export async function resolveSession(name?: string): Promise<DeviceSession> {
  const selector = await relaySelector(name)
  await agent.listDevices()
  const agentDevice = agent.resolve(selector)
  if (agentDevice) return agent.session(agentDevice)
  const target = (name && (await cdp.resolveTarget(name))) || (await cdp.resolveTarget(selector))
  if (target) return cdp.session(target)
  const all = await listAll()
  if (all.length === 0)
    throw new Error(`no devices connected (relay ${config.relayUrl}; DevTools devices from ${config.devicesFile})`)
  if (!selector)
    throw new Error(
      `${all.length} devices connected; pass "device" or call use_device. Options: ${all
        .map((d) => `${d.name ?? d.id} (${d.transport}, ${d.ip}, ${d.platform})`)
        .join(', ')}`,
    )
  throw new Error(`no device matches "${selector}"`)
}

/** Runs against the device, reconnecting once if the page reloaded or the relay dropped us. */
export async function withSession<T>(device: string | undefined, run: (session: DeviceSession) => Promise<T>) {
  const attempt = async () => {
    const session = await resolveSession(device ?? state.defaultDevice)
    if (!session.connected) await session.connect()
    return run(session)
  }
  try {
    return await attempt()
  } catch (error) {
    if (!(error instanceof Error) || !RECONNECT_ERRORS.test(error.message)) throw error
    console.error(`[tv-mcp] ${error.message}; reconnecting`)
    return attempt()
  }
}

export interface NamedSession {
  name: string
  session: DeviceSession
}

export async function resolveSessions(selectors: Array<string | undefined>, retryMs = 0): Promise<NamedSession[]> {
  const deadline = Date.now() + retryMs
  return Promise.all(
    selectors.map(async (selector) => {
      for (;;) {
        try {
          const session = await resolveSession(selector)
          if (!session.connected) await session.connect()
          return { name: selector ?? session.info.id, session }
        } catch (error) {
          if (Date.now() >= deadline) throw error
          console.error(`[tv-mcp] resolve ${selector ?? 'default'}: ${errorMessage(error)}; retrying`)
          await sleep(1000)
        }
      }
    }),
  )
}

/** After a reload, wait until we talk to the NEW document: accept only a page younger than FRESH_PAGE_MS. */
export async function waitForFreshPage(session: DeviceSession, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      if (!session.connected) await session.connect()
      const age = Number(await session.evaluate('performance.now()'))
      if (Number.isFinite(age) && age < FRESH_PAGE_MS) return
      lastError = new Error(`page age ${Math.round(age / 1000)}s; still the old document`)
    } catch (error) {
      lastError = error
      session.stale = true
    }
    await sleep(1000)
  }
  throw new Error(`device did not reload within ${timeoutMs}ms: ${errorMessage(lastError)}`)
}

async function runLaunchCommand(command: string) {
  const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', command], { timeout: 60_000 })
  return { command, output: `${stdout}${stderr}`.trim().split('\n').slice(-3).join('\n') }
}

/** Cold-start a registry device and wait until its page is reachable as a fresh document. */
export async function launchRegistryDevice(name: string, waitMs = LAUNCH_REGISTER_MS) {
  const registry = await loadDevices()
  const entry = registry[name]
  if (!entry) throw new Error(`"${name}" is not in ${config.devicesFile}`)
  if (!entry.launch || !launchable(entry)) throw new Error(`"${name}" has no launch config in ${config.devicesFile}`)
  const t0 = Date.now()
  const launched = entry.launch.command
    ? await runLaunchCommand(entry.launch.command)
    : entry.sdb
      ? await sdbDebugLaunch(entry.sdb, entry.launch.package ?? '')
      : await launchApp(entry.adb as string, { ...entry.launch, package: entry.launch.package as string })
  const deadline = Date.now() + waitMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const session = await resolveSession(name)
      await waitForFreshPage(session, Math.max(5000, deadline - Date.now()))
      return { ...launched, registeredMs: Date.now() - t0, target: session.info }
    } catch (error) {
      lastError = error
      await sleep(2000)
    }
  }
  // The page never became reachable; a screenshot is the only way to see what the device shows.
  const file = path.join(tmpdir(), `tv-mcp-${name}-${Date.now()}.png`)
  let shot = ''
  try {
    if (entry.adb) {
      await writeFile(file, await screenshot(entry.adb))
      shot = `; screenshot ${file}`
    }
  } catch {
    // best effort
  }
  throw new Error(`${name}: launched but not reachable after ${waitMs}ms (${errorMessage(lastError)})${shot}`)
}

/** Relaunch registry devices that are unreachable (auto) or all of them (always). */
export async function ensureLaunched(names: Array<string | undefined>, mode: 'auto' | 'always' | 'never') {
  if (mode === 'never') return {}
  const registry = await loadDevices()
  const results: Record<string, unknown> = {}
  await Promise.all(
    names.map(async (name) => {
      const entry = name ? registry[name] : undefined
      if (!name || !launchable(entry)) return
      if (mode === 'auto') {
        try {
          const session = await resolveSession(name)
          if (!session.connected) await session.connect()
          await session.evaluate('1')
          return
        } catch {
          // unreachable: relaunch below
        }
      }
      results[name] = await launchRegistryDevice(name)
    }),
  )
  return results
}

export function closeAll() {
  agent.closeAll()
  cdp.closeAll()
}
