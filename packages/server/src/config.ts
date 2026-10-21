import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveProfile } from '@tv-mcp/protocol'

import type { AppProfile } from '@tv-mcp/protocol'

/**
 * A test pack is one directory per app under test: profile.json, devices.json, journeys/, sanity/ and
 * reports/. TVMCP_PACK points at it; every path below can also be overridden on its own.
 */
export const PACK_DIR = path.resolve(process.env.TVMCP_PACK ?? process.cwd())

export const config = {
  relayUrl: process.env.TVMCP_RELAY_URL ?? 'http://localhost:8080',
  relayToken: process.env.TVMCP_TOKEN ?? '',
  profileFile: process.env.TVMCP_PROFILE ?? path.join(PACK_DIR, 'profile.json'),
  devicesFile: process.env.TVMCP_DEVICES ?? path.join(PACK_DIR, 'devices.json'),
  journeysDir: process.env.TVMCP_JOURNEYS ?? path.join(PACK_DIR, 'journeys'),
  sanityDir: process.env.TVMCP_SANITY ?? path.join(PACK_DIR, 'sanity'),
  reportsDir: process.env.TVMCP_REPORTS ?? path.join(PACK_DIR, 'reports'),
  /** DevTools devices capture network from connect; TVMCP_NETWORK=off waits for the first network tool call. */
  networkOnConnect: process.env.TVMCP_NETWORK !== 'off',
}

let cached: { mtimeKey: string; profile: AppProfile } | null = null

/** profile.json from the pack, over the defaults; re-read when the file changes. */
export async function loadProfile(): Promise<AppProfile> {
  let raw: string
  try {
    raw = await readFile(config.profileFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolveProfile(null)
    throw error
  }
  if (cached?.mtimeKey === raw) return cached.profile
  try {
    const profile = resolveProfile(JSON.parse(raw))
    cached = { mtimeKey: raw, profile }
    return profile
  } catch (error) {
    throw new Error(`${config.profileFile}: ${error instanceof Error ? error.message : error}`)
  }
}
