import { DOM_KEY, keyCodeFor } from '@tv-mcp/protocol'

import type { AppProfile, KeyCodes } from '@tv-mcp/protocol'

const REPEAT_MS = 100

export interface KeyInput {
  press(key: string, holdMs: number): { keyCode?: number; error?: string }
  hold(key: string, repeatMs: number): { holding?: number; error?: string }
  release(key: string): { released?: number; error?: string }
}

function makeKeyEvent(type: string, keyCode: number, key: string | null): KeyboardEvent {
  let event: KeyboardEvent
  const init: Record<string, unknown> = { bubbles: true, cancelable: true, keyCode, which: keyCode }
  if (key) init.key = key
  try {
    event = new KeyboardEvent(type, init as KeyboardEventInit)
  } catch (e) {
    event = document.createEvent('KeyboardEvent')
    const legacy = event as KeyboardEvent & {
      initKeyboardEvent?: (...args: unknown[]) => void
    }
    if (legacy.initKeyboardEvent)
      legacy.initKeyboardEvent(type, true, true, window, key || String(keyCode), 0, '', false, '')
  }
  // Chromium ignores keyCode/which in the init dict on older engines; force them.
  if (event.keyCode !== keyCode) {
    try {
      Object.defineProperty(event, 'keyCode', { get: () => keyCode })
      Object.defineProperty(event, 'which', { get: () => keyCode })
    } catch (e) {
      // engine refused; the init above is the best available
    }
  }
  return event
}

/**
 * Synthetic remote keys: keydown/keyup carrying the platform's key code. Apps whose input layer reads
 * `keyCode` (most TV focus engines) react as to the real remote. Holds repeat keydown like a held button.
 */
export function createKeyInput(profile: AppProfile, platform: string, codes?: () => KeyCodes): KeyInput {
  const holds: { [code: number]: ReturnType<typeof setInterval> } = {}
  const resolve = (key: string) => {
    const live = codes ? codes() : undefined
    if (live && live[key] !== undefined) return live[key]
    return keyCodeFor(key, platform, profile.keyCodes)
  }
  const target = (): EventTarget =>
    profile.keyEvent.target === 'active' && document.activeElement ? document.activeElement : document
  const dispatch = (type: string, key: string, code: number) =>
    target().dispatchEvent(makeKeyEvent(type, code, profile.keyEvent.key ? DOM_KEY[key] || null : null))

  return {
    press(key, holdMs) {
      const code = resolve(key)
      if (code === undefined) return { error: 'no key code for ' + key }
      dispatch('keydown', key, code)
      if (holdMs <= 0) {
        dispatch('keyup', key, code)
        return { keyCode: code }
      }
      const start = Date.now()
      const timer = setInterval(() => {
        if (Date.now() - start >= holdMs) {
          clearInterval(timer)
          dispatch('keyup', key, code)
          return
        }
        dispatch('keydown', key, code)
      }, REPEAT_MS)
      return { keyCode: code }
    },
    hold(key, repeatMs) {
      const code = resolve(key)
      if (code === undefined) return { error: 'no key code for ' + key }
      if (holds[code]) clearInterval(holds[code])
      dispatch('keydown', key, code)
      holds[code] = setInterval(() => dispatch('keydown', key, code), repeatMs || REPEAT_MS)
      return { holding: code }
    },
    release(key) {
      const code = resolve(key)
      if (code === undefined) return { error: 'no key code for ' + key }
      if (holds[code]) {
        clearInterval(holds[code])
        delete holds[code]
      }
      dispatch('keyup', key, code)
      return { released: code }
    },
  }
}
