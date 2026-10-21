import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const SDB = process.env.SDB ?? path.join(homedir(), 'tizen-studio', 'tools', 'sdb')

export async function sdb(serial: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout, stderr } = await execFileAsync(SDB, ['-s', serial, ...args], { timeout: timeoutMs })
  return `${stdout}${stderr}`.trim()
}

/** Idempotent; a TV drops the sdb session on standby and refuses it until Developer Mode is re-enabled. */
export async function sdbConnect(serial: string): Promise<void> {
  const { stdout } = await execFileAsync(SDB, ['devices'], { timeout: 15_000 })
  if (stdout.includes(serial)) return
  const out = await execFileAsync(SDB, ['connect', serial], { timeout: 30_000 }).then(
    (r) => `${r.stdout}${r.stderr}`,
    (error: Error & { stdout?: string; stderr?: string }) => `${error.stdout ?? ''}${error.stderr ?? error.message}`,
  )
  if (!/connected to/i.test(out) || /failed/i.test(out)) {
    throw new Error(`sdb connect ${serial}: ${out.trim()} (re-enable Developer Mode on the TV with this machine's ip)`)
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')),
      )
    })
  })
}

/** Local ports already forwarded to this TV, from `sdb forward --list`. */
export async function sdbForwards(serial: string): Promise<number[]> {
  const { stdout } = await execFileAsync(SDB, ['forward', '--list'], { timeout: 15_000 })
  return stdout
    .split('\n')
    .filter((line) => line.includes(serial))
    .map((line) => Number(line.match(/tcp:(\d+)\s+tcp:\d+/)?.[1]))
    .filter((port) => Number.isFinite(port) && port > 0)
}

/** Restarts the app with its Web Inspector on (`sdb shell 0 debug`) and forwards the inspector locally. */
export async function sdbDebugLaunch(serial: string, appId: string) {
  if (!appId) throw new Error(`sdb ${serial}: set launch.package to the Tizen app id`)
  await sdbConnect(serial)
  const output = await sdb(serial, ['shell', '0', 'debug', appId], 90_000)
  const remote = output.match(/port:\s*(\d+)/)?.[1]
  if (!remote) throw new Error(`sdb debug ${appId}: no inspector port in "${output}"`)
  const local = await freePort()
  await sdb(serial, ['forward', `tcp:${local}`, `tcp:${remote}`])
  return { command: `sdb -s ${serial} shell 0 debug ${appId}`, output, inspector: `http://127.0.0.1:${local}` }
}
