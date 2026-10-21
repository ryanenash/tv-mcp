// Console message rendering shared by the agent and the DevTools transport, so both read like the DevTools
// console: format specifiers applied, %c styling dropped, objects serialised (circular-safe, Errors, Events, DOM).
// ES5-safe. `serializeValue` is also shipped into pages as source text: it must reference nothing outside itself.

/** JSON-ish text of any value, like DevTools' expanded preview. Self-contained (used via Function#toString). */
export function serializeValue(value: unknown, maxDepth: number, maxChars: number): string {
  var seen: unknown[] = []
  var describeNode = function (n: { nodeName?: string; id?: string; className?: unknown }) {
    var name = String(n.nodeName || 'node').toLowerCase()
    if (n.id) name += '#' + n.id
    if (typeof n.className === 'string' && n.className) name += '.' + n.className.split(/\s+/).join('.')
    return '<' + name + '>'
  }
  var walk = function (v: unknown, depth: number): unknown {
    if (v === null || v === undefined) return v === null ? null : '[undefined]'
    var t = typeof v
    if (t === 'string' || t === 'number' || t === 'boolean') return v
    if (t === 'bigint') return String(v) + 'n'
    if (t === 'symbol') return String(v)
    if (t === 'function') return '[function ' + ((v as { name?: string }).name || 'anonymous') + ']'
    var o = v as { [k: string]: unknown }
    if (typeof (o as { nodeType?: unknown }).nodeType === 'number' && typeof o.nodeName === 'string')
      return describeNode(o as { nodeName?: string; id?: string; className?: unknown })
    for (var s = 0; s < seen.length; s++) if (seen[s] === v) return '[circular]'
    if (depth >= maxDepth) return v instanceof Array ? '[Array(' + (v as unknown[]).length + ')]' : '[Object]'
    seen.push(v)
    var out: unknown
    if (v instanceof Error) {
      out = { name: v.name, message: v.message, stack: v.stack }
    } else if (typeof Event !== 'undefined' && v instanceof Event) {
      var ev = v as Event & { target?: unknown }
      out = {
        event: ev.type,
        target:
          ev.target && (ev.target as { nodeName?: string }).nodeName
            ? describeNode(ev.target as { nodeName?: string })
            : String(ev.target),
        isTrusted: ev.isTrusted,
      }
    } else if (v instanceof Array) {
      var arr: unknown[] = []
      for (var i = 0; i < v.length && i < 1000; i++) arr.push(walk(v[i], depth + 1))
      if (v.length > 1000) arr.push('[+' + (v.length - 1000) + ' more]')
      out = arr
    } else if (typeof Map !== 'undefined' && v instanceof Map) {
      var entries: unknown[] = []
      v.forEach(function (val: unknown, key: unknown) {
        entries.push([walk(key, depth + 1), walk(val, depth + 1)])
      })
      out = { '[Map]': entries }
    } else if (typeof Set !== 'undefined' && v instanceof Set) {
      var items: unknown[] = []
      v.forEach(function (val: unknown) {
        items.push(walk(val, depth + 1))
      })
      out = { '[Set]': items }
    } else {
      var obj: { [k: string]: unknown } = {}
      var count = 0
      for (var k in o) {
        if (count++ >= 1000) {
          obj['…'] = 'more keys'
          break
        }
        try {
          obj[k] = walk(o[k], depth + 1)
        } catch (e) {
          obj[k] = '[unreadable]'
        }
      }
      out = obj
    }
    seen.pop()
    return out
  }
  var text: string
  try {
    var walked = walk(value, 0)
    text = typeof walked === 'string' ? walked : JSON.stringify(walked)
  } catch (e) {
    text = String(value)
  }
  return text.length > maxChars ? text.slice(0, maxChars) + '…[truncated]' : text
}

/**
 * The text DevTools shows for a console call: when the first argument is a string, %s %d %i %f %o %O %j consume
 * the following arguments and %c consumes one and is dropped (styling); the rest are appended with spaces.
 * `render` turns a non-string argument into text.
 */
export function formatConsole(args: unknown[], render: (value: unknown) => string): string {
  if (args.length === 0) return ''
  var parts: string[] = []
  var rest = 0
  if (typeof args[0] === 'string' && args[0].indexOf('%') !== -1) {
    var next = 1
    var first = args[0].replace(/%([sdifoOjc%])/g, function (match: string, spec: string) {
      if (spec === '%') return '%'
      if (next >= args.length) return match
      var arg = args[next++]
      if (spec === 'c') return ''
      if (spec === 's') return typeof arg === 'string' ? arg : render(arg)
      if (spec === 'd' || spec === 'i') return String(parseInt(String(arg), 10))
      if (spec === 'f') return String(parseFloat(String(arg)))
      return render(arg)
    })
    parts.push(first)
    rest = next
  } else {
    parts.push(typeof args[0] === 'string' ? args[0] : render(args[0]))
    rest = 1
  }
  for (var i = rest; i < args.length; i++)
    parts.push(typeof args[i] === 'string' ? (args[i] as string) : render(args[i]))
  return parts.join(' ').replace(/\s+$/, '')
}
