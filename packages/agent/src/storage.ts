export interface ClearReport {
  signOut: unknown
  cookies: string[]
  localStorage: number | string
  sessionStorage: number | string
  indexedDb: string[] | string
  caches: string[] | string
  serviceWorkers: number | string
  remainingCookies: string
  reloading: boolean
}

const RELOAD_SAFETY_MS = 3000

/** Back to the app's first-launch state: the root of a hosted app, index.html of a packaged one. */
export function reloadAtRoot(): void {
  if (location.protocol === 'file:') {
    history.replaceState(null, '', 'index.html')
    location.reload()
  } else {
    location.href = location.origin + '/'
  }
}

/**
 * Wipes everything the page can reach (cookies on every path/domain variant, web storage, IndexedDB,
 * CacheStorage, service workers), optionally after an app sign-out that can expire HttpOnly session
 * cookies server-side, then reloads at the root once the async deletions settle. `keep` entries are written
 * back to localStorage after the wipe.
 */
export function clearStorage(
  reload: boolean,
  signOut?: () => Promise<unknown>,
  keep: { [key: string]: string } = {},
): Promise<ClearReport> {
  const report: ClearReport = {
    signOut: signOut ? 'requested' : 'no signOut hook: HttpOnly cookies are not cleared',
    cookies: [],
    localStorage: 0,
    sessionStorage: 0,
    indexedDb: [],
    caches: 'n/a',
    serviceWorkers: 'n/a',
    remainingCookies: '',
    reloading: reload,
  }
  const before: Promise<unknown> = signOut
    ? signOut().then(
        (r) => {
          report.signOut = r === undefined ? 'ok' : r
        },
        (e) => {
          report.signOut = 'error: ' + String(e)
        },
      )
    : Promise.resolve()

  return before.then(() => {
    const domains = ['']
    const parts = location.hostname.split('.')
    for (let d = 0; d < parts.length - 1; d++) domains.push('; domain=' + parts.slice(d).join('.'))
    const paths = ['/', location.pathname]
    const names = document.cookie.split(';')
    for (let c = 0; c < names.length; c++) {
      const name = names[c].split('=')[0].replace(/^\s+/, '')
      if (!name) continue
      report.cookies.push(name)
      for (let di = 0; di < domains.length; di++)
        for (let pi = 0; pi < paths.length; pi++)
          document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=' + paths[pi] + domains[di]
    }
    try {
      report.localStorage = localStorage.length
      localStorage.clear()
      // The agent's own entries (its device name) survive, or the device would re-register under a new name.
      for (const k in keep) localStorage.setItem(k, keep[k])
    } catch (e) {
      report.localStorage = 'error: ' + String(e)
    }
    try {
      report.sessionStorage = sessionStorage.length
      sessionStorage.clear()
    } catch (e) {
      report.sessionStorage = 'error: ' + String(e)
    }
    const pending: Array<Promise<unknown>> = []
    const idb = (window as unknown as { indexedDB?: IDBFactory & { databases?: () => Promise<IDBDatabaseInfo[]> } })
      .indexedDB
    if (idb && typeof idb.databases === 'function') {
      pending.push(
        idb.databases().then((dbs) => {
          const out: string[] = []
          for (let i = 0; i < dbs.length; i++) {
            const n = dbs[i].name
            if (n) {
              out.push(n)
              idb.deleteDatabase(n)
            }
          }
          report.indexedDb = out
        }),
      )
    } else {
      report.indexedDb = idb ? 'cannot enumerate on this engine' : 'n/a'
    }
    const cs = (window as unknown as { caches?: CacheStorage }).caches
    if (cs && typeof cs.keys === 'function') {
      pending.push(
        cs.keys().then((keys) => {
          report.caches = keys
          const deletes: Array<Promise<boolean>> = []
          for (let k = 0; k < keys.length; k++) deletes.push(cs['delete'](keys[k]))
          return Promise.all(deletes)
        }),
      )
    }
    const sw = (navigator as Navigator & { serviceWorker?: ServiceWorkerContainer }).serviceWorker
    if (sw && typeof sw.getRegistrations === 'function') {
      pending.push(
        sw.getRegistrations().then((regs) => {
          report.serviceWorkers = regs.length
          const un: Array<Promise<boolean>> = []
          for (let r = 0; r < regs.length; r++) un.push(regs[r].unregister())
          return Promise.all(un)
        }),
      )
    }
    report.remainingCookies = document.cookie
    if (reload) {
      let done = false
      const go = () => {
        if (done) return
        done = true
        reloadAtRoot()
      }
      Promise.all(pending).then(go, go)
      setTimeout(go, RELOAD_SAFETY_MS)
    }
    return report
  })
}
