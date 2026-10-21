// DOM readers driven by the app profile. Same shapes as the server's DevTools page scripts, so every
// transport returns identical results. Compiled to ES5: no Array.from, no Element.closest assumption.
import type {
  AppProfile,
  Condition,
  ConditionResult,
  ElementInfo,
  FocusSummary,
  KeyboardKey,
  KeyboardLayout,
  PlayerState,
  Rect,
  VideoInfo,
} from '@tv-mcp/protocol'

function toArray<T extends Element>(list: NodeListOf<T> | HTMLCollectionOf<T>): T[] {
  const out: T[] = []
  for (let i = 0; i < list.length; i++) out.push(list[i])
  return out
}

function matches(el: Element, selector: string): boolean {
  const proto = el as Element & {
    msMatchesSelector?: (s: string) => boolean
    webkitMatchesSelector?: (s: string) => boolean
  }
  const fn = proto.matches || proto.webkitMatchesSelector || proto.msMatchesSelector
  return fn ? fn.call(el, selector) : false
}

export function closest(el: Element | null, selector: string): Element | null {
  let node: Element | null = el
  while (node && node.nodeType === 1) {
    if (matches(node, selector)) return node
    node = node.parentElement
  }
  return null
}

export function text(el: Element | null, max: number): string {
  if (!el) return ''
  const raw = el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.textContent || ''
  const t = raw.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '')
  return t.length > max ? t.slice(0, max) + '…' : t
}

function labelledBy(el: Element): string {
  const ids = el.getAttribute('aria-labelledby')
  if (!ids) return ''
  const out: string[] = []
  const parts = ids.split(/\s+/)
  for (let i = 0; i < parts.length; i++) {
    const t = text(document.getElementById(parts[i]), 120)
    if (t) out.push(t)
  }
  return out.join(' ')
}

export function rect(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
}

export function isVisible(r: Rect): boolean {
  return r.w > 0 && r.h > 0 && r.x + r.w > 0 && r.y + r.h > 0 && r.x < window.innerWidth && r.y < window.innerHeight
}

/** Some element matching `selector` is laid out on screen. */
export function shown(selector: string): boolean {
  const nodes = document.querySelectorAll(selector)
  for (let i = 0; i < nodes.length; i++) if (isVisible(rect(nodes[i]))) return true
  return false
}

export class DomReader {
  constructor(private readonly profile: AppProfile) {}

  activeElement(): Element | null {
    const f = this.profile.focus
    if (f.activeSelector) return document.querySelector(f.activeSelector)
    const el = document.activeElement
    return el && el !== document.body && el !== document.documentElement ? el : null
  }

  idOf(el: Element): string | null {
    return el.getAttribute(this.profile.focus.idAttribute) || el.getAttribute('id') || null
  }

  sectionOf(el: Element): string | null {
    const f = this.profile.focus
    if (!f.sectionSelector) return null
    const root = closest(el, f.sectionSelector)
    return root ? root.getAttribute(f.sectionIdAttribute) : null
  }

  describe(el: Element, active?: Element | null): ElementInfo {
    const r = rect(el)
    const focused = active === undefined ? this.activeElement() : active
    return {
      id: this.idOf(el),
      section: this.sectionOf(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      label: el.getAttribute('aria-label') || labelledBy(el) || el.getAttribute('title') || text(el, 120),
      href: el.getAttribute('href'),
      rect: r,
      visible: isVisible(r),
      focused: el === focused,
    }
  }

  focused(): ElementInfo | null {
    const el = this.activeElement()
    return el ? this.describe(el, el) : null
  }

  dialogs(): string[] {
    const out: string[] = []
    const nodes = toArray(document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]'))
    for (let i = 0; i < nodes.length; i++) out.push(text(nodes[i], 300))
    return out
  }

  videos(): VideoInfo[] {
    const out: VideoInfo[] = []
    const nodes = toArray(document.getElementsByTagName('video'))
    for (let i = 0; i < nodes.length; i++) {
      const v = nodes[i]
      out.push({
        paused: v.paused,
        ended: v.ended,
        muted: v.muted,
        readyState: v.readyState,
        currentTime: Math.round(v.currentTime),
        duration: isFinite(v.duration) ? Math.round(v.duration) : null,
        src: (v.currentSrc || v.src || '').slice(0, 120),
      })
    }
    return out
  }

  focusSummary(): FocusSummary {
    const out: FocusSummary = {
      url: location.href,
      focused: this.focused(),
      dialogs: this.dialogs(),
      videos: this.videos(),
    }
    if (document.visibilityState === 'hidden') out.hidden = true
    return out
  }

  snapshot(maxElements: number) {
    const f = this.profile.focus
    const active = this.activeElement()
    const focused = active ? this.describe(active, active) : null
    const elements: ElementInfo[] = []
    const nodes = toArray(document.querySelectorAll(f.elementSelector))
    for (let i = 0; i < nodes.length; i++) {
      const d = this.describe(nodes[i], active)
      if (d.visible) elements.push(d)
    }
    if (focused) {
      const fx = focused.rect.x + focused.rect.w / 2
      const fy = focused.rect.y + focused.rect.h / 2
      const dist = (d: ElementInfo) => Math.abs(d.rect.x + d.rect.w / 2 - fx) + Math.abs(d.rect.y + d.rect.h / 2 - fy)
      elements.sort((a, b) => dist(a) - dist(b))
    }
    const sections: Array<{ id: string | null; scope: string | null; elements: number; hasFocus: boolean }> = []
    if (f.sectionSelector) {
      const roots = toArray(document.querySelectorAll(f.sectionSelector))
      for (let s = 0; s < roots.length; s++) {
        const count = roots[s].querySelectorAll(f.elementSelector).length
        if (count === 0) continue
        sections.push({
          id: roots[s].getAttribute(f.sectionIdAttribute),
          scope: f.scopeAttribute ? roots[s].getAttribute(f.scopeAttribute) : null,
          elements: count,
          hasFocus: !!active && roots[s].contains(active),
        })
      }
    }
    const headings: string[] = []
    const hs = toArray(document.querySelectorAll('h1,h2'))
    for (let h = 0; h < hs.length && headings.length < 8; h++) {
      const t = text(hs[h], 120)
      if (t) headings.push(t)
    }
    const liveRegions: string[] = []
    const ls = toArray(document.querySelectorAll('[aria-live]'))
    for (let l = 0; l < ls.length; l++) {
      const t = text(ls[l], 200)
      if (t) liveRegions.push(t)
    }
    const trimmed: Array<Record<string, unknown>> = []
    for (let e = 0; e < elements.length && e < maxElements; e++) {
      const d = elements[e]
      const row: Record<string, unknown> = { id: d.id, section: d.section, tag: d.tag, label: d.label, rect: d.rect }
      if (d.focused) row.focused = true
      if (d.role) row.role = d.role
      if (d.href) row.href = d.href
      trimmed.push(row)
    }
    return {
      url: location.href,
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      busy: !!document.querySelector('[aria-busy="true"],[role="progressbar"]'),
      transport: 'agent',
      focused,
      sections,
      visibleElements: elements.length,
      elements: trimmed,
      headings,
      dialogs: this.dialogs(),
      liveRegions,
      videos: this.videos(),
    }
  }

  keyboardLayout(): KeyboardLayout {
    const f = this.profile.focus
    const pattern = new RegExp(this.profile.keyboard.sectionPattern, 'i')
    const active = this.activeElement()
    let section = active && f.sectionSelector ? closest(active, f.sectionSelector) : null
    if (!section || !pattern.test(section.getAttribute(f.sectionIdAttribute) || '')) {
      section = null
      const roots = f.sectionSelector ? toArray(document.querySelectorAll(f.sectionSelector)) : []
      for (let i = 0; i < roots.length; i++) {
        if (pattern.test(roots[i].getAttribute(f.sectionIdAttribute) || '')) {
          section = roots[i]
          break
        }
      }
    }
    if (!section) return { error: 'no on-screen keyboard section found', section: '', keys: [], inputValues: [] }
    const keys: KeyboardKey[] = []
    const nodes = toArray(section.querySelectorAll(f.elementSelector))
    for (let k = 0; k < nodes.length; k++) {
      const r = nodes[k].getBoundingClientRect()
      if (r.width === 0) continue
      keys.push({
        id: this.idOf(nodes[k]),
        label: text(nodes[k], 40),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        focused: nodes[k] === active,
      })
    }
    const inputValues: string[] = []
    const inputs = toArray(document.getElementsByTagName('input'))
    for (let j = 0; j < inputs.length; j++) inputValues.push(inputs[j].value)
    return { section: section.getAttribute(f.sectionIdAttribute) || '', keys, inputValues }
  }

  readText(selector: string, maxChars: number) {
    const root = document.querySelector(selector)
    if (!root) return { error: 'no element matches ' + selector }
    return { selector, text: text(root, maxChars) }
  }

  playerState(): PlayerState {
    const p = this.profile.player
    const v = document.getElementsByTagName('video')[0] || null
    const label = p.timeLabelSelector ? document.querySelector(p.timeLabelSelector) : null
    const raw = label ? (label.textContent || '').replace(/^\s+|\s+$/g, '') : ''
    const parts = raw.split(':')
    let seek: number | null = null
    if (parts.length === 3) seek = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2])
    else if (parts.length === 2) seek = Number(parts[0]) * 60 + Number(parts[1])
    if (seek !== null && !isFinite(seek)) seek = null
    const active = this.activeElement()
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
      adBreak: !!(p.adSelector && document.querySelector(p.adSelector)),
      controlsVisible: !!label,
      focusedId: active ? this.idOf(active) : null,
    }
  }

  condition(args: Condition): ConditionResult {
    const minS = this.profile.player.contentMinDurationS
    const focused = this.focused()
    const matched: string[] = []
    const vids = this.videos()
    const playing = (v: VideoInfo) => !v.paused && v.readyState >= 3
    const isContent = (v: VideoInfo) => v.duration !== null && v.duration >= minS
    const some = (pred: (v: VideoInfo) => boolean) => {
      for (let i = 0; i < vids.length; i++) if (pred(vids[i])) return true
      return false
    }
    if (args.text && document.body && (document.body.innerText || '').indexOf(args.text) !== -1) matched.push('text')
    if (args.selector && document.querySelector(args.selector)) matched.push('selector')
    if (args.gone && document.body && !shown(args.gone)) matched.push('gone')
    if (args.focusedLabel && focused && focused.label.toLowerCase().indexOf(args.focusedLabel.toLowerCase()) !== -1)
      matched.push('focusedLabel')
    if (args.urlIncludes && location.href.indexOf(args.urlIncludes) !== -1) matched.push('urlIncludes')
    if (args.videoPlaying && some(playing)) matched.push('videoPlaying')
    if (typeof args.videoNearEnd === 'number') {
      const left = args.videoNearEnd
      if (some((v) => isContent(v) && !v.paused && (v.duration as number) - v.currentTime <= left))
        matched.push('videoNearEnd')
    }
    if (args.adPlaying) {
      const adMarked = !!(this.profile.player.adSelector && document.querySelector(this.profile.player.adSelector))
      if (some((v) => playing(v) && (adMarked || (v.duration !== null && v.duration < minS)))) matched.push('adPlaying')
    }
    if (args.contentPlaying && some((v) => playing(v) && isContent(v))) matched.push('contentPlaying')
    if (args.videoPaused && some((v) => v.paused && isContent(v))) matched.push('videoPaused')
    if (args.noDialog && this.dialogs().length === 0) matched.push('noDialog')
    return { matched, focused, url: location.href, dialogs: this.dialogs() }
  }

  /** localStorage keys plus cookie names, for dismissal-persistence checks. */
  storageKeys(): string[] {
    const keys: string[] = []
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k) keys.push(k)
      }
    } catch (e) {
      // storage unavailable
    }
    const cookies = document.cookie.split(';')
    for (let c = 0; c < cookies.length; c++) {
      const n = cookies[c].split('=')[0].replace(/^\s+/, '')
      if (n) keys.push(n)
    }
    return keys
  }
}
