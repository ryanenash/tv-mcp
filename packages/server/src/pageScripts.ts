/* eslint-disable @typescript-eslint/no-explicit-any */
// Scripts for the DevTools transport, serialised with Function.prototype.toString and evaluated inside the
// TV page. They must stay ES5 (no arrows, spread, template strings, let/const) and only reference
// `helpers`, `profile`, `args`, `window` and `document`. Shapes match the in-app agent's DomReader.
import type { AppProfile } from '@tv-mcp/protocol'

// esbuild (via tsx) may wrap inner functions in a __name() helper that does not exist in the page.
const HELPERS = `
  var __name = function (fn) { return fn }
  var helpers = {
    matches: function (el, sel) {
      var fn = el.matches || el.webkitMatchesSelector || el.msMatchesSelector
      return fn ? fn.call(el, sel) : false
    },
    closest: function (el, sel) {
      while (el && el.nodeType === 1) { if (helpers.matches(el, sel)) return el; el = el.parentElement }
      return null
    },
    text: function (el, max) {
      var t = (el && (el.getAttribute('aria-label') || el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').replace(/^\\s+|\\s+$/g, '')
      return t.length > max ? t.slice(0, max) + '…' : t
    },
    labelledBy: function (el) {
      var ids = el.getAttribute('aria-labelledby')
      if (!ids) return ''
      var out = []
      ids.split(/\\s+/).forEach(function (id) {
        var ref = document.getElementById(id)
        if (ref) out.push(helpers.text(ref, 120))
      })
      return out.join(' ')
    },
    rect: function (el) {
      var r = el.getBoundingClientRect()
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    },
    visible: function (rect) {
      return rect.w > 0 && rect.h > 0 && rect.x + rect.w > 0 && rect.y + rect.h > 0 &&
        rect.x < window.innerWidth && rect.y < window.innerHeight
    },
    shown: function (selector) {
      var nodes = document.querySelectorAll(selector)
      for (var i = 0; i < nodes.length; i++) if (helpers.visible(helpers.rect(nodes[i]))) return true
      return false
    },
    active: function () {
      if (profile.focus.activeSelector) return document.querySelector(profile.focus.activeSelector)
      var el = document.activeElement
      return el && el !== document.body && el !== document.documentElement ? el : null
    },
    idOf: function (el) {
      return el.getAttribute(profile.focus.idAttribute) || el.getAttribute('id') || null
    },
    sectionOf: function (el) {
      if (!profile.focus.sectionSelector) return null
      var root = helpers.closest(el, profile.focus.sectionSelector)
      return root ? root.getAttribute(profile.focus.sectionIdAttribute) : null
    },
    describe: function (el, active) {
      var rect = helpers.rect(el)
      return {
        id: helpers.idOf(el),
        section: helpers.sectionOf(el),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || null,
        label: el.getAttribute('aria-label') || helpers.labelledBy(el) || el.getAttribute('title') || helpers.text(el, 120),
        href: el.getAttribute('href') || null,
        rect: rect,
        visible: helpers.visible(rect),
        focused: el === active
      }
    },
    focused: function () {
      var el = helpers.active()
      return el ? helpers.describe(el, el) : null
    },
    dialogs: function () {
      var out = []
      var nodes = document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]')
      for (var i = 0; i < nodes.length; i++) out.push(helpers.text(nodes[i], 300))
      return out
    },
    videos: function () {
      var out = []
      var nodes = document.getElementsByTagName('video')
      for (var i = 0; i < nodes.length; i++) {
        var v = nodes[i]
        out.push({
          paused: v.paused, ended: v.ended, muted: v.muted, readyState: v.readyState,
          currentTime: Math.round(v.currentTime), duration: isFinite(v.duration) ? Math.round(v.duration) : null,
          src: (v.currentSrc || v.src || '').slice(0, 120)
        })
      }
      return out
    }
  }
`

function wrap(profile: AppProfile, fn: (args: any) => unknown, args: unknown, prelude = ''): string {
  return `(function () {
    var profile = ${JSON.stringify(profile)};${HELPERS}${prelude}
    var args = ${JSON.stringify(args)};
    try { return JSON.stringify((${fn.toString()})(args)); }
    catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); }
  })()`
}

declare const helpers: any
declare const profile: AppProfile

function keyEventFactory(code: number, key: string | null, toActive: boolean) {
  return function (type: string) {
    var ev: any
    var init: any = { bubbles: true, cancelable: true, keyCode: code, which: code }
    if (key) init.key = key
    try {
      ev = new KeyboardEvent(type, init)
    } catch (e) {
      ev = document.createEvent('KeyboardEvent')
      if (ev.initKeyboardEvent) ev.initKeyboardEvent(type, true, true, window, key || String(code), 0, '', false, '')
    }
    if (ev.keyCode !== code) {
      try {
        Object.defineProperty(ev, 'keyCode', {
          get: function () {
            return code
          },
        })
        Object.defineProperty(ev, 'which', {
          get: function () {
            return code
          },
        })
      } catch (e2) {
        /* engine refused; the init above is the best available */
      }
    }
    var target: any = toActive && document.activeElement ? document.activeElement : document
    target.dispatchEvent(ev)
  }
}

declare const KEY_EVENT_FACTORY: (code: number, key: string | null, toActive: boolean) => (type: string) => void
const KEY_EVENT_PRELUDE = `\n    var KEY_EVENT_FACTORY = ${keyEventFactory.toString()};`

export interface KeyArgs {
  action: string
  keyCode: number | null
  domKey: string | null
  holdMs: number
}

/** Prefers the app bridge's pressKey (the agent's global, when present), else a synthetic DOM key event. */
export function pressKeyScript(p: AppProfile, args: KeyArgs) {
  return wrap(
    p,
    function (args: any) {
      var beforeEl = helpers.active()
      var before = { focusId: beforeEl ? helpers.idOf(beforeEl) : null, url: location.href }
      var bridge = (window as any)[profile.bridgeGlobal]
      if (bridge && typeof bridge.pressKey === 'function') {
        var result = bridge.pressKey(args.action, { holdMs: args.holdMs })
        return { via: 'bridge', keyCode: result && result.keyCode, before: before }
      }
      if (args.keyCode === null) return { error: 'no key code for ' + args.action }
      var fire = KEY_EVENT_FACTORY(args.keyCode, args.domKey, profile.keyEvent.target === 'active')
      fire('keydown')
      if (args.holdMs > 0) {
        var start = Date.now()
        var timer = setInterval(function () {
          if (Date.now() - start >= args.holdMs) {
            clearInterval(timer)
            fire('keyup')
            return
          }
          fire('keydown')
        }, 100)
      } else {
        fire('keyup')
      }
      return { via: 'synthetic', keyCode: args.keyCode, before: before }
    },
    args,
    KEY_EVENT_PRELUDE,
  )
}

/** keydown now and every `repeatMs` until released, as a held remote button repeats. */
export function holdKeyScript(p: AppProfile, args: { keyCode: number; domKey: string | null; repeatMs: number }) {
  return wrap(
    p,
    function (args: any) {
      var w = window as any
      var fire = KEY_EVENT_FACTORY(args.keyCode, args.domKey, profile.keyEvent.target === 'active')
      w.__tvmcpHold = w.__tvmcpHold || {}
      if (w.__tvmcpHold[args.keyCode]) clearInterval(w.__tvmcpHold[args.keyCode])
      fire('keydown')
      w.__tvmcpHold[args.keyCode] = setInterval(function () {
        fire('keydown')
      }, args.repeatMs)
      return { holding: args.keyCode }
    },
    args,
    KEY_EVENT_PRELUDE,
  )
}

export function releaseKeyScript(p: AppProfile, args: { keyCode: number; domKey: string | null }) {
  return wrap(
    p,
    function (args: any) {
      var w = window as any
      var fire = KEY_EVENT_FACTORY(args.keyCode, args.domKey, profile.keyEvent.target === 'active')
      if (w.__tvmcpHold && w.__tvmcpHold[args.keyCode]) {
        clearInterval(w.__tvmcpHold[args.keyCode])
        delete w.__tvmcpHold[args.keyCode]
      }
      fire('keyup')
      return { released: args.keyCode }
    },
    args,
    KEY_EVENT_PRELUDE,
  )
}

export function focusSummaryScript(p: AppProfile) {
  return wrap(
    p,
    function () {
      var out: any = {
        url: location.href,
        focused: helpers.focused(),
        dialogs: helpers.dialogs(),
        videos: helpers.videos(),
      }
      if (document.visibilityState === 'hidden') out.hidden = true
      return out
    },
    {},
  )
}

export function snapshotScript(p: AppProfile, args: { maxElements: number }) {
  return wrap(
    p,
    function (args: any) {
      var f = profile.focus
      var active = helpers.active()
      var focused = active ? helpers.describe(active, active) : null
      var nodes = document.querySelectorAll(f.elementSelector)
      var elements: any[] = []
      for (var i = 0; i < nodes.length; i++) {
        var d = helpers.describe(nodes[i], active)
        if (d.visible) {
          delete d.visible
          if (!d.focused) delete d.focused
          if (!d.role) delete d.role
          if (!d.href) delete d.href
          elements.push(d)
        }
      }
      if (focused) {
        var fx = focused.rect.x + focused.rect.w / 2
        var fy = focused.rect.y + focused.rect.h / 2
        elements.sort(function (a, b) {
          var da = Math.abs(a.rect.x + a.rect.w / 2 - fx) + Math.abs(a.rect.y + a.rect.h / 2 - fy)
          var db = Math.abs(b.rect.x + b.rect.w / 2 - fx) + Math.abs(b.rect.y + b.rect.h / 2 - fy)
          return da - db
        })
      }
      var sections: any[] = []
      if (f.sectionSelector) {
        var roots = document.querySelectorAll(f.sectionSelector)
        for (var s = 0; s < roots.length; s++) {
          var count = roots[s].querySelectorAll(f.elementSelector).length
          if (count === 0) continue
          sections.push({
            id: roots[s].getAttribute(f.sectionIdAttribute),
            scope: f.scopeAttribute ? roots[s].getAttribute(f.scopeAttribute) : null,
            elements: count,
            hasFocus: !!active && roots[s].contains(active),
          })
        }
      }
      var headings: string[] = []
      var hNodes = document.querySelectorAll('h1,h2')
      for (var h = 0; h < hNodes.length && headings.length < 8; h++) {
        var ht = helpers.text(hNodes[h], 120)
        if (ht) headings.push(ht)
      }
      var live: string[] = []
      var liveNodes = document.querySelectorAll('[aria-live]')
      for (var l = 0; l < liveNodes.length; l++) {
        var lt = helpers.text(liveNodes[l], 200)
        if (lt) live.push(lt)
      }
      return {
        url: location.href,
        title: document.title,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        busy: !!document.querySelector('[aria-busy="true"],[role="progressbar"]'),
        transport: 'cdp',
        agentBridge: !!(window as any)[profile.bridgeGlobal],
        focused: focused,
        sections: sections,
        visibleElements: elements.length,
        elements: elements.slice(0, args.maxElements),
        headings: headings,
        dialogs: helpers.dialogs(),
        liveRegions: live,
        videos: helpers.videos(),
      }
    },
    args,
  )
}

export function readTextScript(p: AppProfile, args: { selector: string; maxChars: number }) {
  return wrap(
    p,
    function (args: any) {
      var root = document.querySelector(args.selector)
      if (!root) return { error: 'no element matches ' + args.selector }
      return { selector: args.selector, text: helpers.text(root, args.maxChars) }
    },
    args,
  )
}

export function conditionScript(p: AppProfile, args: Record<string, unknown>) {
  return wrap(
    p,
    function (args: any) {
      var minS = profile.player.contentMinDurationS
      var focused = helpers.focused()
      var matched: string[] = []
      var vids = helpers.videos()
      var some = function (pred: (v: any) => boolean) {
        for (var i = 0; i < vids.length; i++) if (pred(vids[i])) return true
        return false
      }
      var playing = function (v: any) {
        return !v.paused && v.readyState >= 3
      }
      var isContent = function (v: any) {
        return v.duration !== null && v.duration >= minS
      }
      if (args.text && document.body && (document.body.innerText || '').indexOf(args.text) !== -1) matched.push('text')
      if (args.selector && document.querySelector(args.selector)) matched.push('selector')
      if (args.gone && document.body && !helpers.shown(args.gone)) matched.push('gone')
      if (
        args.focusedLabel &&
        focused &&
        (focused.label || '').toLowerCase().indexOf(args.focusedLabel.toLowerCase()) !== -1
      )
        matched.push('focusedLabel')
      if (args.urlIncludes && location.href.indexOf(args.urlIncludes) !== -1) matched.push('urlIncludes')
      if (args.videoPlaying && some(playing)) matched.push('videoPlaying')
      if (typeof args.videoNearEnd === 'number') {
        if (
          some(function (v) {
            return isContent(v) && !v.paused && v.duration - v.currentTime <= args.videoNearEnd
          })
        )
          matched.push('videoNearEnd')
      }
      if (args.adPlaying) {
        var adMarked = !!(profile.player.adSelector && document.querySelector(profile.player.adSelector))
        if (
          some(function (v) {
            return playing(v) && (adMarked || (v.duration !== null && v.duration < minS))
          })
        )
          matched.push('adPlaying')
      }
      if (
        args.contentPlaying &&
        some(function (v) {
          return playing(v) && isContent(v)
        })
      )
        matched.push('contentPlaying')
      if (
        args.videoPaused &&
        some(function (v) {
          return v.paused && isContent(v)
        })
      )
        matched.push('videoPaused')
      if (args.noDialog && helpers.dialogs().length === 0) matched.push('noDialog')
      return { matched: matched, focused: focused, url: location.href, dialogs: helpers.dialogs() }
    },
    args,
  )
}

/** While the viewer scrubs, the <video> stays put and the time label shows the seek position. */
export function playerStateScript(p: AppProfile) {
  return wrap(
    p,
    function () {
      var pl = profile.player
      var v = document.getElementsByTagName('video')[0] || null
      var label = pl.timeLabelSelector ? document.querySelector(pl.timeLabelSelector) : null
      var raw = label ? (label.textContent || '').replace(/^\s+|\s+$/g, '') : ''
      var parts = raw.split(':')
      var seek: number | null = null
      if (parts.length === 3) seek = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2])
      else if (parts.length === 2) seek = Number(parts[0]) * 60 + Number(parts[1])
      if (seek !== null && !isFinite(seek)) seek = null
      var active = helpers.active()
      return {
        video: v
          ? {
              currentTime: v.currentTime,
              duration: isFinite(v.duration) ? v.duration : null,
              paused: v.paused,
              readyState: v.readyState,
            }
          : null,
        timeLabel: raw || null,
        seekTime: seek,
        adBreak: !!(pl.adSelector && document.querySelector(pl.adSelector)),
        controlsVisible: !!label,
        focusedId: active ? helpers.idOf(active) : null,
      }
    },
    {},
  )
}

export function keyboardLayoutScript(p: AppProfile) {
  return wrap(
    p,
    function () {
      var f = profile.focus
      var pattern = new RegExp(profile.keyboard.sectionPattern, 'i')
      var active = helpers.active()
      var section = active && f.sectionSelector ? helpers.closest(active, f.sectionSelector) : null
      if (!section || !pattern.test(section.getAttribute(f.sectionIdAttribute) || '')) {
        section = null
        var roots = f.sectionSelector ? document.querySelectorAll(f.sectionSelector) : []
        for (var i = 0; i < roots.length; i++) {
          if (pattern.test(roots[i].getAttribute(f.sectionIdAttribute) || '')) {
            section = roots[i]
            break
          }
        }
      }
      if (!section) return { error: 'no on-screen keyboard section found' }
      var nodes = section.querySelectorAll(f.elementSelector)
      var keys: any[] = []
      for (var k = 0; k < nodes.length; k++) {
        var r = nodes[k].getBoundingClientRect()
        if (r.width === 0) continue
        keys.push({
          id: helpers.idOf(nodes[k]),
          label: helpers.text(nodes[k], 40),
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          focused: nodes[k] === active,
        })
      }
      var inputs = document.getElementsByTagName('input')
      var values: string[] = []
      for (var j = 0; j < inputs.length; j++) values.push((inputs[j] as any).value)
      return { section: section.getAttribute(f.sectionIdAttribute) || '', keys: keys, inputValues: values }
    },
    {},
  )
}

export function storageKeysScript(p: AppProfile) {
  return wrap(
    p,
    function () {
      var keys: string[] = []
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i)
          if (k) keys.push(k)
        }
      } catch (e) {
        /* storage unavailable */
      }
      var cookies = document.cookie.split(';')
      for (var c = 0; c < cookies.length; c++) {
        var n = cookies[c].split('=')[0].replace(/^\s+/, '')
        if (n) keys.push(n)
      }
      return keys
    },
    {},
  )
}

export function navigateScript(p: AppProfile, args: { url: string }) {
  return wrap(
    p,
    function (args: any) {
      // Never location.assign(): some console browsers open a new window for it.
      location.href = args.url
      return { navigating: args.url }
    },
    args,
  )
}

/**
 * Page-side wipe for the DevTools transport (used after Storage.clearDataForOrigin, which also takes HttpOnly
 * cookies where the engine supports it): web storage, IndexedDB, caches, service workers, then a reload.
 */
export function clearStorageScript(p: AppProfile, args: { reload: boolean; reloadDelayMs: number }) {
  return wrap(
    p,
    function (args: any) {
      var report: any = {
        cookies: [],
        localStorage: 0,
        sessionStorage: 0,
        indexedDb: [],
        caches: 'n/a',
        serviceWorkers: 'n/a',
      }
      var domains = ['']
      var parts = location.hostname.split('.')
      for (var d = 0; d < parts.length - 1; d++) domains.push('; domain=' + parts.slice(d).join('.'))
      var paths = ['/', location.pathname]
      var names = document.cookie.split(';')
      for (var c = 0; c < names.length; c++) {
        var name = names[c].split('=')[0].replace(/^\s+/, '')
        if (!name) continue
        report.cookies.push(name)
        for (var di = 0; di < domains.length; di++)
          for (var pi = 0; pi < paths.length; pi++)
            document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=' + paths[pi] + domains[di]
      }
      try {
        report.localStorage = localStorage.length
        localStorage.clear()
      } catch (e) {
        report.localStorage = 'error: ' + e
      }
      try {
        report.sessionStorage = sessionStorage.length
        sessionStorage.clear()
      } catch (e) {
        report.sessionStorage = 'error: ' + e
      }
      var pending: any[] = []
      var idb: any = (window as any).indexedDB
      if (idb && typeof idb.databases === 'function') {
        pending.push(
          idb.databases().then(function (dbs: any[]) {
            var out: string[] = []
            for (var i = 0; i < dbs.length; i++)
              if (dbs[i].name) {
                out.push(dbs[i].name)
                idb.deleteDatabase(dbs[i].name)
              }
            report.indexedDb = out
          }),
        )
      } else {
        report.indexedDb = idb ? 'cannot enumerate on this engine' : 'n/a'
      }
      var cs: any = (window as any).caches
      if (cs && typeof cs.keys === 'function') {
        pending.push(
          cs.keys().then(function (keys: string[]) {
            report.caches = keys
            var deletes: any[] = []
            for (var k = 0; k < keys.length; k++) deletes.push(cs['delete'](keys[k]))
            return Promise.all(deletes)
          }),
        )
      }
      var sw: any = navigator.serviceWorker
      if (sw && typeof sw.getRegistrations === 'function') {
        pending.push(
          sw.getRegistrations().then(function (regs: any[]) {
            report.serviceWorkers = regs.length
            var un: any[] = []
            for (var r = 0; r < regs.length; r++) un.push(regs[r].unregister())
            return Promise.all(un)
          }),
        )
      }
      report.remainingCookies = document.cookie
      if (args.reload) {
        var reloaded = false
        var go = function () {
          if (reloaded) return
          reloaded = true
          if (location.protocol === 'file:') {
            history.replaceState(null, '', 'index.html')
            location.reload()
          } else {
            location.href = location.origin + '/'
          }
        }
        Promise.all(pending).then(go, go)
        setTimeout(go, args.reloadDelayMs)
        report.reloading = true
      }
      return report
    },
    args,
  )
}
