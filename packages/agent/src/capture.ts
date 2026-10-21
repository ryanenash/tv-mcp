import { formatConsole, redactJsonText, serializeValue } from '@tv-mcp/protocol'

import type { ConsoleEvent, NetworkProfile } from '@tv-mcp/protocol'

const LEVELS = ['log', 'info', 'warn', 'error', 'debug']

/** The caller's location from a stack (`url:line:col`), skipping the agent's own frames. */
function callerSource(stack: string | undefined): string | undefined {
  if (!stack) return undefined
  const lines = stack.split('\n')
  for (let i = 1; i < lines.length; i++) {
    const m = /(\w+:\/\/[^\s)]+:\d+:\d+)/.exec(lines[i])
    if (m && m[1].indexOf('tv-mcp-agent') === -1 && m[1].indexOf('/agent.js') === -1) return m[1]
  }
  return undefined
}

/**
 * Forwards console.* calls (formatted and expanded the way DevTools shows them), uncaught errors and unhandled
 * rejections. `limits` gives the current message cap and object depth. Returns an uninstaller.
 */
export function captureConsole(
  emit: (e: ConsoleEvent) => void,
  consoleMethods: boolean,
  limits: () => { maxMessageChars: number; maxDepth: number },
  policy: () => NetworkProfile,
): () => void {
  const c = console as unknown as { [level: string]: (...args: unknown[]) => void }
  const originals: { [level: string]: (...args: unknown[]) => void } = {}
  let busy = false
  if (consoleMethods) {
    for (let i = 0; i < LEVELS.length; i++) {
      const level = LEVELS[i]
      const original = c[level]
      if (typeof original !== 'function') continue
      originals[level] = original
      c[level] = function () {
        const args = Array.prototype.slice.call(arguments) as unknown[]
        // The relay socket may log on failure; never recurse into ourselves.
        if (!busy) {
          busy = true
          try {
            const l = limits()
            const text = redactJsonText(
              formatConsole(args, (v) => serializeValue(v, l.maxDepth, l.maxMessageChars)),
              policy(),
            )
            emit({
              level,
              text: text.length > l.maxMessageChars ? text.slice(0, l.maxMessageChars) + '…[truncated]' : text,
              source: callerSource(new Error().stack),
            })
          } finally {
            busy = false
          }
        }
        return original.apply(console, args)
      }
    }
  }
  const onError = (e: ErrorEvent) =>
    emit({
      level: 'exception',
      text: e.error && e.error.stack ? String(e.error.stack) : String(e.message),
      source: e.filename ? e.filename + ':' + e.lineno + ':' + e.colno : undefined,
    })
  const onRejection = (e: PromiseRejectionEvent) =>
    emit({ level: 'exception', text: 'unhandled rejection: ' + serializeValue(e.reason, 4, limits().maxMessageChars) })
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    for (const level in originals) c[level] = originals[level]
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}
