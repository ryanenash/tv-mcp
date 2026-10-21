// Remote keys by name, and the key codes TV platforms deliver for them. Platform tables are published
// platform behaviour (Tizen TVInputDevice codes, Android TV KeyEvent codes as WebViews report them).

export const UNIVERSAL_KEYS = [
  'Ok',
  'Back',
  'Up',
  'Down',
  'Left',
  'Right',
  'Play',
  'Pause',
  'PlayPause',
  'Stop',
  'Rewind',
  'Forward',
  'Search',
  'Info',
  'ChannelUp',
  'ChannelDown',
  'Red',
  'Green',
  'Yellow',
  'Blue',
  'Digit0',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
] as const

export type UniversalKey = (typeof UNIVERSAL_KEYS)[number]

export type KeyCodes = { [key: string]: number }

/** `KeyboardEvent.key` values for synthetic events. */
export const DOM_KEY: { [key: string]: string } = {
  Ok: 'Enter',
  Back: 'Backspace',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Play: 'MediaPlay',
  Pause: 'MediaPause',
  PlayPause: 'MediaPlayPause',
  Stop: 'MediaStop',
  Rewind: 'MediaRewind',
  Forward: 'MediaFastForward',
  Search: 'BrowserSearch',
  Info: 'Info',
  ChannelUp: 'ChannelUp',
  ChannelDown: 'ChannelDown',
  Red: 'ColorF0Red',
  Green: 'ColorF1Green',
  Yellow: 'ColorF2Yellow',
  Blue: 'ColorF3Blue',
  Digit0: '0',
  Digit1: '1',
  Digit2: '2',
  Digit3: '3',
  Digit4: '4',
  Digit5: '5',
  Digit6: '6',
  Digit7: '7',
  Digit8: '8',
  Digit9: '9',
}

/** What a desktop keyboard (and most remotes mapped onto it) sends. */
export const KEYBOARD_CODES: KeyCodes = {
  Back: 8,
  Ok: 13,
  Left: 37,
  Up: 38,
  Right: 39,
  Down: 40,
  Digit0: 48,
  Digit1: 49,
  Digit2: 50,
  Digit3: 51,
  Digit4: 52,
  Digit5: 53,
  Digit6: 54,
  Digit7: 55,
  Digit8: 56,
  Digit9: 57,
  PlayPause: 179,
  Stop: 178,
  Red: 403,
  Green: 404,
  Yellow: 405,
  Blue: 406,
}

export const PLATFORM_CODES: { [platform: string]: KeyCodes } = {
  androidtv: {
    PlayPause: 179,
    Play: 179,
    Pause: 179,
    Rewind: 227,
    Forward: 228,
    Search: 170,
    Info: 457,
    ChannelUp: 33,
    ChannelDown: 34,
  },
  firetv: { Play: 179, Pause: 179, PlayPause: 179, Rewind: 227, Forward: 228 },
  tizen: {
    Back: 10009,
    PlayPause: 10252,
    Play: 415,
    Pause: 19,
    Stop: 413,
    Rewind: 412,
    Forward: 417,
    ChannelUp: 427,
    ChannelDown: 428,
  },
  webos: { Back: 461, Play: 415, Pause: 19, Stop: 413, Rewind: 412, Forward: 417, ChannelUp: 33, ChannelDown: 34 },
  hbbtv: { Back: 461, Play: 415, Pause: 19, Stop: 413, Rewind: 412, Forward: 417 },
  playstation: { Rewind: 116, Forward: 117 },
}

/** Best-effort platform family from a user agent; agents may report their own. */
export function detectPlatform(userAgent?: string): string {
  const ua = (userAgent || '').toLowerCase()
  if (ua.indexOf('tizen') !== -1) return 'tizen'
  if (ua.indexOf('web0s') !== -1 || ua.indexOf('webos') !== -1) return 'webos'
  if (ua.indexOf('playstation') !== -1) return 'playstation'
  if (ua.indexOf('xbox') !== -1) return 'xbox'
  if (ua.indexOf('hbbtv') !== -1) return 'hbbtv'
  if (ua.indexOf('aft') !== -1 || ua.indexOf('fire tv') !== -1) return 'firetv'
  if (ua.indexOf('android') !== -1) return 'androidtv'
  if (ua.indexOf('wpe') !== -1) return 'wpe'
  return 'unknown'
}

/** Profile override, then the platform's code, then the keyboard code. */
export function keyCodeFor(key: string, platform: string, overrides?: KeyCodes): number | undefined {
  if (overrides && overrides[key] !== undefined) return overrides[key]
  const table = PLATFORM_CODES[platform]
  if (table && table[key] !== undefined) return table[key]
  return KEYBOARD_CODES[key]
}
