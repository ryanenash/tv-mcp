// Shared plumbing for the end-to-end tests: child processes, headless Chrome, the MCP client, checks.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const verbose = Boolean(process.env.E2E_VERBOSE)

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function createHarness() {
  const children = []
  const dirs = []
  const results = []
  let client

  const tempDir = (prefix) => {
    const dir = mkdtempSync(path.join(tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }

  const start = (cmd, args, env = {}) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const tag = `[${path.basename(args[0] ?? cmd)}]`
    child.stdout.on('data', (d) => verbose && process.stderr.write(`${tag} ${d}`))
    child.stderr.on('data', (d) => verbose && process.stderr.write(`${tag} ${d}`))
    children.push(child)
    return child
  }

  const chrome = (url, extra = []) =>
    start(CHROME, [
      '--headless=new',
      `--user-data-dir=${tempDir('tvmcp-e2e-chrome-')}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1920,1080',
      ...extra,
      url,
    ])

  async function until(what, check, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        if (await check()) return
      } catch {
        // not yet
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await sleep(300)
    }
  }

  function check(name, ok, detail) {
    results.push({ name, ok: Boolean(ok) })
    const extra = ok || detail === undefined ? '' : `\n      ${JSON.stringify(detail).slice(0, 900)}`
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra}`)
  }

  async function connect(env) {
    client = new Client({ name: 'tv-mcp-e2e', version: '0.0.0' })
    await client.connect(
      new StdioClientTransport({
        command: 'node',
        args: [path.join(repo, 'packages/server/dist/server.js')],
        env: { ...process.env, ...env },
        stderr: verbose ? 'inherit' : 'ignore',
      }),
    )
    return client
  }

  /** Calls a tool and parses its JSON text result; errors come back as { error }. */
  async function call(name, args = {}) {
    const r = await client.callTool({ name, arguments: args })
    const text = r.content.find((c) => c.type === 'text')?.text ?? ''
    if (r.isError) return { error: text }
    try {
      return JSON.parse(text)
    } catch {
      return { text, content: r.content }
    }
  }

  async function finish(error) {
    if (error) {
      console.error('e2e aborted:', error)
      process.exitCode = 1
    } else {
      const failed = results.filter((r) => !r.ok)
      console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
      process.exitCode = failed.length ? 1 : 0
    }
    await client?.close().catch(() => undefined)
    for (const child of children) child.kill('SIGKILL')
    await sleep(500)
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    // Browser helper processes can hold inherited pipes open; do not wait for them.
    process.exit(process.exitCode ?? 0)
  }

  return {
    start,
    chrome,
    until,
    check,
    connect,
    call,
    tempDir,
    finish,
    get client() {
      return client
    },
  }
}
