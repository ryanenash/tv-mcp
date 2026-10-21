import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { sleep } from './session.js'

const execFileAsync = promisify(execFile)

const ADB_CANDIDATES = [
  process.env.ADB,
  'adb',
  path.join(homedir(), 'Android', 'Sdk', 'platform-tools', 'adb'),
  path.join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
].filter((p): p is string => Boolean(p))

let adbBinary: string | undefined
async function adbPath(): Promise<string> {
  if (adbBinary) return adbBinary
  for (const candidate of ADB_CANDIDATES) {
    try {
      if (candidate === 'adb') await execFileAsync('adb', ['version'])
      else await access(candidate)
      adbBinary = candidate
      return adbBinary
    } catch {
      continue
    }
  }
  throw new Error(`adb not found; set ADB=/path/to/adb (tried ${ADB_CANDIDATES.join(', ')})`)
}

export async function adb(serial: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const bin = await adbPath()
  const { stdout } = await execFileAsync(bin, ['-s', serial, ...args], {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout.trim()
}

/** Network serials (`ip:port`) need `adb connect` after a reboot of either side; it is idempotent. */
export async function adbConnect(serial: string): Promise<string> {
  if (!serial.includes(':')) return 'usb'
  const bin = await adbPath()
  const { stdout } = await execFileAsync(bin, ['connect', serial], { timeout: 15_000 })
  const line = stdout.trim()
  if (!/connected to/.test(line)) throw new Error(`adb connect ${serial}: ${line}`)
  return line
}

export interface AdbLaunch {
  /** URL passed as the intent data, or as the string extra named by `urlExtra`. */
  url: string
  /** Android package of the app or web wrapper. */
  package: string
  /** Activity to start; with it omitted, the package's launcher activity is resolved. */
  activity?: string
  urlExtra?: string
  /** `KEYCODE_*` names (prefix optional) sent after start, e.g. to pick an entry on a launcher page. */
  launcherKeys?: string[]
  /** How long the app needs before it takes those keys. */
  launcherSettleMs?: number
}

const LAUNCHER_SETTLE_MS = 8000
const KEY_GAP_MS = 400

async function launcherActivity(serial: string, pkg: string): Promise<string> {
  const out = await adb(serial, ['shell', 'cmd', 'package', 'resolve-activity', '--brief', pkg])
  const component = out.split('\n').pop()?.trim() ?? ''
  if (!component.includes('/')) throw new Error(`no launcher activity for ${pkg} on ${serial}: ${out}`)
  return component
}

/** Wake the device, cold-start the app on `url`, then send launcher keys if configured. */
export async function launchApp(serial: string, cfg: AdbLaunch) {
  await adbConnect(serial)
  const component = cfg.activity ? `${cfg.package}/${cfg.activity}` : await launcherActivity(serial, cfg.package)
  await adb(serial, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'])
  await adb(serial, ['shell', 'am', 'force-stop', cfg.package])
  const urlArgs = cfg.urlExtra ? ['--es', cfg.urlExtra, cfg.url] : ['-a', 'android.intent.action.VIEW', '-d', cfg.url]
  const out = await adb(serial, ['shell', 'am', 'start', '-n', component, ...urlArgs])
  if (/Error/.test(out)) throw new Error(`am start failed on ${serial}: ${out}`)
  const keys = cfg.launcherKeys ?? []
  if (keys.length > 0) {
    await sleep(cfg.launcherSettleMs ?? LAUNCHER_SETTLE_MS)
    for (const key of keys) {
      await adb(serial, ['shell', 'input', 'keyevent', key.startsWith('KEYCODE_') ? key : `KEYCODE_${key}`])
      await sleep(KEY_GAP_MS)
    }
  }
  return { serial, intent: `${component} ${urlArgs.join(' ')}`, keys }
}

/** PNG bytes of the screen; the only view of a page that never reached the relay. */
export async function screenshot(serial: string): Promise<Buffer> {
  const bin = await adbPath()
  const { stdout } = await execFileAsync(bin, ['-s', serial, 'exec-out', 'screencap', '-p'], {
    encoding: 'buffer',
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
}

const SCREEN_OFF_NEVER_MS = '2147460000'

/**
 * One-time device prep for long unattended runs. Android TV screensavers drop a WebView's sockets and are
 * often impossible to disable in the menus; this pushes the timeouts out. `permissions` are marked
 * user-fixed for the package so runtime prompts (microphone, location) stop interrupting cold starts.
 */
export async function setupDevice(serial: string, pkg?: string, permissions: string[] = []) {
  await adbConnect(serial)
  const script = [
    `settings put system screen_off_timeout ${SCREEN_OFF_NEVER_MS}`,
    'settings put secure screensaver_enabled 0',
    'settings put secure sleep_timeout -1',
    ...(pkg ? permissions.map((p) => `pm set-permission-flags ${pkg} ${p} user-fixed`) : []),
    'echo screen_off_timeout=$(settings get system screen_off_timeout)',
    'echo screensaver_enabled=$(settings get secure screensaver_enabled)',
    'echo sleep_timeout=$(settings get secure sleep_timeout)',
  ].join('; ')
  const out = await adb(serial, ['shell', script])
  return Object.fromEntries(
    out
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => l.split('=') as [string, string]),
  )
}
