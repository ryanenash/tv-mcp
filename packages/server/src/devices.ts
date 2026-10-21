import { readFile } from 'node:fs/promises'
import { z } from 'zod'

import { config } from './config.js'

const launchSchema = z.object({
  url: z.string(),
  /** Shell command that (re)launches the app at `url` where there is no adb/sdb (vendor CLIs, launcher tools). */
  command: z.string().optional(),
  /** Android package, or the Tizen app id with `sdb`. */
  package: z.string().optional(),
  activity: z.string().optional(),
  urlExtra: z.string().optional(),
  launcherKeys: z.array(z.string()).optional(),
  launcherSettleMs: z.number().int().min(0).optional(),
})

const deviceSchema = z.object({
  /** Agent selector (agent name, or a substring of ip/user agent/url) that finds this device on the relay. */
  match: z.string(),
  /** adb serial: `ip:port` for network devices, the usb serial otherwise. */
  adb: z.string().optional(),
  /** Tizen sdb serial (`ip:26101`); launch restarts `launch.package` with its Web Inspector forwarded. */
  sdb: z.string().optional(),
  /**
   * Drive the page over Chrome DevTools: `true` for adb/sdb-forwarded inspectors, or a DevTools HTTP
   * endpoint such as "http://10.0.0.20:9222". Works on builds without the agent.
   */
  devtools: z.union([z.boolean(), z.string().url()]).default(false),
  /** DevTools only: `synthetic` dispatches DOM key events instead of trusted browser input. */
  keys: z.enum(['trusted', 'synthetic']).default('trusted'),
  launch: launchSchema.optional(),
  /** Multiplies journey timeouts for this device (slow set-top boxes: 2). */
  timeoutScale: z.number().min(0.1).max(10).default(1),
  /** Pulse long scrub holds on devices that fall over when a hold escalates to the fastest seek speed. */
  maxHoldMs: z.number().int().min(200).optional(),
  /** adb_setup marks these Android permissions user-fixed for launch.package. */
  permissions: z.array(z.string()).default([]),
  notes: z.string().optional(),
})

export type DeviceEntry = z.infer<typeof deviceSchema>
export type DeviceRegistry = Record<string, DeviceEntry>

/** devices.json: named devices with how to find them and how to (re)launch them. */
export async function loadDevices(): Promise<DeviceRegistry> {
  try {
    const raw = JSON.parse(await readFile(config.devicesFile, 'utf8')) as unknown
    return z.record(z.string(), deviceSchema).parse(raw)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`${config.devicesFile}: ${error instanceof Error ? error.message : error}`)
  }
}

export const launchable = (entry?: DeviceEntry) =>
  Boolean(entry?.launch && (entry.launch.command || entry.sdb || (entry.adb && entry.launch.package)))
