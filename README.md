# tv-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent drive and verify TV web apps on real
devices the way a viewer does: remote-control keys in, what is on screen out. It runs scripted journeys and
whole sanity checklists across several devices in lockstep, and reports pass/fail and per-step timings per
device.

It targets big-screen web apps (Android TV and Fire TV web wrappers, Tizen, webOS, HbbTV and operator
set-top boxes, console web shells, plain browsers) whose UI is driven by a remote and a focus engine rather
than a mouse.

## How it fits together

```
 AI client (Claude Code, …)
        │ stdio (MCP)
        ▼
 ┌──────────────┐  ws /agent/client  ┌───────────┐  ws /agent/device  ┌──────────────────────────┐
 │ @tv-mcp/     │ ─────────────────▶ │ @tv-mcp/  │ ◀───────────────── │ TV app + @tv-mcp/agent    │
 │ server       │                    │ relay     │   (outbound from   │ (one <script> tag)        │
 │              │                    └───────────┘    the device)     └──────────────────────────┘
 │              │  Chrome DevTools Protocol (adb / sdb forward, or host:port)
 │              │ ─────────────────────────────────────────────────────▶ debuggable WebView / inspector
 └──────────────┘
```

Two transports, one tool surface:

| Transport    | Needs                                                    | Gives                                                                                      |
| ------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **agent**    | the app loads the agent script (test builds)             | any device that can open a WebSocket out; stable names; push focus/route events; claims    |
| **devtools** | a debuggable WebView or inspector reachable from the Mac | any build, no app change; trusted `Input.dispatchKeyEvent` keys; screenshots; full network |

The agent connects **out** from the device to the relay, so it works through NAT, on consoles and on boxes that
expose no debugging port. The relay can run on a laptop or as a shared service (see `packages/relay/Dockerfile`).

| Package             | What it is                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `packages/server`   | The MCP server (`tv-mcp` bin).                                                            |
| `packages/relay`    | WebSocket relay between devices and servers; also serves the agent bundle at `/agent.js`. |
| `packages/agent`    | In-app agent: ES5 bundle for a script tag, or an ES module for apps that bundle it.       |
| `packages/protocol` | The app profile, key tables and wire protocol shared by all of the above.                 |
| `examples/`         | A demo TV app and a complete test pack for it (profile, devices, journeys, checklist).    |

## Quick start (demo app, five minutes)

```bash
pnpm install && pnpm build
pnpm relay                                   # relay on :8080 (PORT=… to change)
pnpm demo                                    # demo TV app on :3100 (RELAY_URL=… if the relay moved)
open "http://localhost:3100/?tvmcp=demo"     # any browser; it registers as device "demo"
```

Register the server with your MCP client, pointing it at the example pack (Claude Code: copy
`.mcp.json.example` to `.mcp.json`, adjust the path), then ask for things like:

- "list the devices, then run the smoke checklist on demo with QUERY=lights"
- "on demo, go to Search and type northern"
- "take a snapshot and tell me what is focused"

`pnpm e2e` runs the whole stack headless (relay, demo app, headless Chromes, the server over stdio) and checks
both transports, first over http, then as a packaged `file://` app (reset in place, storage clear, router urls
mapped onto exported pages, page loads between package files); it is the regression test for this repo.

## Making an app drivable

### 1. Load the agent (agent transport)

The least intrusive way is one tag in **test builds only**, in `<head>` so requests made while the app boots are
captured too:

```html
<script src="http://<relay-host>:8080/agent.js" data-autostart></script>
```

Packaged (`file://`) apps can load the script from the relay as above, or bundle `tv-mcp-agent.js` (from
`@tv-mcp/agent/script`) into the package; a bundled copy has no relay origin, so it needs `data-relay` and refuses to
start without it. The platform must allow the page to reach the relay (e.g. an `<access>` rule in Tizen's config.xml).

Attributes: `data-relay` (default: the script's origin), `data-name` (default: `?tvmcp=<name>` in the page url,
then the name stored from the last run, then `<platform>-<random>`), `data-token`, `data-platform`, `data-build`,
`data-profile` (JSON). Or set `window.TVMCP_OPTIONS` before the tag.

Apps that bundle their own code can import it instead, and hand it hooks into their own input and auth layers:

```ts
import { startAgent } from '@tv-mcp/agent'

startAgent({
  relayUrl: process.env.TVMCP_RELAY_URL,
  build: BUILD_ID,
  hooks: {
    // Route keys through the app's input layer instead of synthetic DOM events (optional).
    pressKey: (key, { holdMs }) => remote.simulate(key, holdMs),
    // Expire HttpOnly session cookies before a storage wipe, so "first launch" is really first launch.
    signOut: () => api.signOut(),
  },
})
```

The agent can evaluate arbitrary script on behalf of whoever can reach the relay's client side. Never ship it in
production builds, and run any shared relay with both tokens set.

### 2. Or use DevTools (devtools transport)

Nothing to change in the app if its WebView or browser is debuggable: Android WebViews with debugging enabled
(over adb), Tizen apps launched with `sdb shell 0 debug` (over sdb), webOS debug installs, or any Chrome with
`--remote-debugging-port`. Describe the device in `devices.json` with `devtools`.

A desktop Chrome pauses rendering and throttles timers in windows that are minimised or covered, so the app may
ignore keys and a viewer sees nothing move (press results then carry a `warning`). Launch it with:

```sh
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/tvmcp-chrome \
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
  --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling
```

DevTools windows, `chrome://` and extension pages on the endpoint are never devices, and a registry name picks the
page its `match` describes.

### 3. Describe the app: `profile.json`

The profile tells every transport how the app marks focus, where the player keeps its position, and which
dialogs must never appear unasked. Unset fields fall back to the defaults below (native focus).

| Field                                    | Default                           | Meaning                                                                                                                                                                                                                      |
| ---------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `focus.activeSelector`                   | `""` (`document.activeElement`)   | Selector for the focused element, for focus engines that mark it with a class.                                                                                                                                               |
| `focus.elementSelector`                  | focusable elements                | What `snapshot` lists.                                                                                                                                                                                                       |
| `focus.idAttribute`                      | `data-focus-id`                   | Stable element id (falls back to `id`).                                                                                                                                                                                      |
| `focus.sectionSelector` / `…IdAttribute` | `[data-focus-section]`            | Groups of focusables (rails, menus, dialogs).                                                                                                                                                                                |
| `focus.scopeAttribute`                   | `data-focus-scope`                | Optional scope name of a section (e.g. `modal`).                                                                                                                                                                             |
| `focus.focusEvent`                       | `focusin`                         | Event fired when focus moves; drives push events (polling covers engines without one).                                                                                                                                       |
| `player.timeLabelSelector`               | `""`                              | Element showing the playhead while scrubbing (`mm:ss` / `h:mm:ss`).                                                                                                                                                          |
| `player.adSelector`                      | `""`                              | Present while an ad plays.                                                                                                                                                                                                   |
| `player.contentMinDurationS`             | `120`                             | Shorter videos count as ads.                                                                                                                                                                                                 |
| `player.seekStepS`                       | `10`                              | Seconds one Right tap skips.                                                                                                                                                                                                 |
| `player.endOverlay`                      | `null`                            | `{ selector, keys }`: dismiss an autoplay overlay so `scrubToEnd` can reach the end.                                                                                                                                         |
| `keyboard.sectionPattern`                | `keyboard`                        | Regex matched against section ids to find the on-screen keyboard.                                                                                                                                                            |
| `guards[]`                               | `[]`                              | `{ name, selector, storageKey?, hint?, dismissKeys? }`: dialogs that fail any step not expecting them; with `dismissKeys` (popups that may appear anywhere) they are closed with those keys instead and the step carries on. |
| `startSelector`                          | `""`                              | A journey reset is ready when this matches (and something is focused).                                                                                                                                                       |
| `busySelector`                           | `""`                              | Loading overlays (splash, spinner). Presses wait until none is on screen (`TVMCP_BUSY_WAIT_MS`, 60 s), so focus never moves unseen beneath one.                                                                              |
| `keyCodes`                               | `{}`                              | Key-code overrides by key name, for remotes the built-in tables do not know.                                                                                                                                                 |
| `keyEvent`                               | `{ key: true, target: "active" }` | Whether synthetic events carry `key`, and whether they target the focused element or document.                                                                                                                               |
| `bridgeGlobal`                           | `__tvmcp`                         | Global the agent installs; DevTools scripts use its `pressKey` when present.                                                                                                                                                 |
| `network.bodies`                         | `false`                           | Capture request and response bodies (both transports). Costs CPU on slow boxes.                                                                                                                                              |
| `network.maxBodyBytes`                   | `65536`                           | Longer bodies are cut and flagged `truncated`.                                                                                                                                                                               |
| `network.bodyTypes`                      | json, text, xml, form…            | Regex on the content type; media and binary bodies are never read.                                                                                                                                                           |
| `network.include` / `exclude`            | `[]`                              | Regexes on the url: record only / never these requests.                                                                                                                                                                      |
| `network.redactHeaders`                  | auth, cookie, api-key headers     | Header values replaced by `[redacted]`.                                                                                                                                                                                      |
| `network.redactKeys`                     | password, pin, token, secret…     | Regex on JSON keys, form fields and query parameters to redact (before the cut).                                                                                                                                             |

The server pushes the pack's profile to each agent on connect, so the profile lives with the tests, not in the
app build. The agent keeps the last profile it was sent and boots with it next time.

### Network capture

Every request is recorded when it **starts**, with a page-unique id and sequence number, and its response (status,
headers, body, duration, or the failure) is attached to the same record when it ends. Lists come back in request
order by default, completion order on request, with in-flight requests marked `pending`, so concurrent requests
never appear shuffled. The agent covers `fetch` (including clients such as ky that pass a `Request` object, whose
body is read from a clone), `XMLHttpRequest`, `sendBeacon` and `WebSocket` (connection, close and every frame both
ways), plus everything else the page loads through resource timing (images, scripts, styles, and requests made
before the agent ran) and element load errors. Events raised before the relay socket opens are queued, and the
relay replays a device's recent events to a server that connects later. Until the pack profile reaches a freshly
started agent it captures with bodies on under its built-in limits and redaction; the server re-applies the pack
policy to every record it receives, so the first page load is as complete as later ones and the pack's redaction
rules hold for it too. DevTools devices record
every resource the browser loads (documents, scripts, images, media) with bodies from `Network.getResponseBody`.

Requests an app makes on its server (server-side rendering) are invisible to any in-page tool. An app that already
collects them can forward them through the agent so they appear in the same lists, marked `origin: "server"`:

```js
window.__tvmcp?.recordExchange({
  origin: 'server',
  method: 'GET',
  url,
  startedAt,
  endedAt,
  status,
  responseHeaders,
  responseBody, // redaction and size limits apply here too
})
```

`timeline` interleaves what tv-mcp did (presses, navigation), what the device reported (focus, route, console) and
request start/response rows on one clock: device times are shifted onto the server's clock by an offset measured
from every agent event; app-server times are used as they are.

## Test packs

One directory per app under test; point the server at it with `TVMCP_PACK`:

```
my-app-pack/
  profile.json       how the app marks focus etc. (above)
  devices.json       named devices: how to find, reach and relaunch each one
  journeys/*.json    fixed plans that run unchanged on any device
  sanity/*.json      checklists: rows mapped to journeys, per-platform N/A rules
  reports/           written by run_sanity (json + markdown + live progress.json)
```

Packs carry device addresses and credentials variables; keep client packs in their own repositories (`packs/` is
gitignored here). `examples/` is a complete pack for the demo app.

### devices.json

```jsonc
{
  "lounge-androidtv": {
    "match": "lounge-androidtv", // agent name / ip / user-agent / url substring
    "adb": "10.0.0.21:5555", // adb serial (network or USB)
    "devtools": false, // true: adb/sdb-forwarded DevTools; or "http://host:9222"
    "keys": "trusted", // DevTools only: "synthetic" for DOM events instead
    "launch": {
      "url": "https://…",
      "package": "com.example.tvwrapper",
      "activity": "…",
      "urlExtra": "url",
      "launcherKeys": ["DPAD_RIGHT", "DPAD_CENTER"],
      "command": "./launch.sh …",
    },
    "timeoutScale": 1, // slow boxes: 2
    "maxHoldMs": 1200, // pulse scrub holds on boxes that fall over at top seek speed
    "permissions": ["android.permission.RECORD_AUDIO"], // adb_setup marks them user-fixed
    "notes": "…",
  },
}
```

`examples/devices.reference.json` shows one entry per connection style (Android TV, Fire TV over DevTools, Tizen
over sdb, webOS inspector, vendor launch CLI, agent-only console).

### Journeys

A journey is a start condition plus steps. Each step is a key press (or `typeText`, `navigate`, `clearStorage`,
`scrubToEnd`, or a verify-only step), followed by optional waits and expectations:

```json
{
  "name": "settings-open",
  "description": "Open Settings from the menu and land on its first option.",
  "steps": [
    { "key": "Left", "expectFocusChange": true },
    { "key": "Up", "untilFocus": "Home" },
    { "key": "Down", "untilFocus": "Settings" },
    { "key": "Ok", "waitUrl": "#/settings", "expectFocus": "Reset app" }
  ]
}
```

- **Press:** `key`, `times`, `holdMs`, `untilFocus` + `maxPresses` (press until the focused label matches; absorbs
  dropped keys and menus whose length varies).
- **Wait:** `waitUrl`, `waitText`, `waitSelector`, `waitGone` (no visible match: an overlay has gone), `waitVideo`,
  `waitAd`, `waitContent`, `waitVideoNearEnd`, `waitVideoAdvance`; an unmet wait fails the step.
- **Expect:** `expectFocus`, `expectUrl`, `expectFocusChange`, `expectVideoDelta`, `expectStorageKeys`,
  `expectDialog` (this step starts with that guard dialog up, usually because it dismisses it).
- **Branch:** `ifFocus`, `ifSelector`, `ifVideoPaused` skip the step when not met.
- **Severity:** `soft` + `tag` record an issue (sanity: WITH ISSUE) without stopping the device.
- **Timing:** journey `timeouts` (`step`, `page`, `content`), per-step `waitMs`, device `timeoutScale`.
- `${VAR}` in `typeText`, `untilFocus`, `expectFocus`, `waitText` and `navigate` comes from `vars` or `TVMCP_<VAR>`.

Journeys assert requirements. When an app misbehaves (a dialog shows up late, focus lands in the wrong place),
the journey should fail and the finding be reported, never be adapted to step around the bug.

### Sanity checklists

Rows map to journeys; a row passes on a device when all its journeys pass. Cells are PASS, FAIL, WITH ISSUE,
N/A (`na` platforms), UNABLE (`unable`, unreachable device, or blocked by an `abortOnFail` row) or NOT AUTOMATED
(no journey yet). A journey shared by several rows runs once.

## Tools

| Tool                                    | Purpose                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `list_devices`, `use_device`            | What is connected, the registry, and the default device (claimed on the relay). |
| `press_key`, `press_sequence`           | Single keys, or planned sequences on one or many devices in lockstep.           |
| `snapshot`, `read_text`, `wait_for`     | What the viewer sees; wait on conditions instead of sleeping.                   |
| `type_text`                             | Type on the on-screen keyboard (layer switching included).                      |
| `navigate`, `clear_storage`, `evaluate` | Deeplinks, first-launch state, escape hatch.                                    |
| `console_logs`, `network_requests`      | Console output; requests paired with responses (bodies, redaction, ordering).   |
| `timeline`                              | Presses, focus/route changes, console and network rows in one ordered list.     |
| `run_journey`, `list_journeys`          | Journeys from the pack, across devices, with per-step timings per device.       |
| `run_sanity`, `list_sanity`             | Whole checklists into a matrix and a markdown report.                           |
| `launch_app`, `adb_setup`, `screenshot` | Device lifecycle: cold start, unattended-run prep, what is on screen.           |

## Configuration

| Variable                                                                            | Default                  | Used by                                                       |
| ----------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------- |
| `TVMCP_PACK`                                                                        | current directory        | server: pack root                                             |
| `TVMCP_PROFILE`, `TVMCP_DEVICES`, `TVMCP_JOURNEYS`, `TVMCP_SANITY`, `TVMCP_REPORTS` | inside the pack          | server                                                        |
| `TVMCP_RELAY_URL`                                                                   | `http://localhost:8080`  | server                                                        |
| `TVMCP_TOKEN`                                                                       | none                     | relay (required from clients when set), server                |
| `TVMCP_DEVICE_TOKEN`                                                                | none                     | relay (required from devices when set); agent `data-token`    |
| `TVMCP_NETWORK=off`                                                                 | capture from connect     | server: DevTools devices wait for the first network tool call |
| `ADB`, `SDB`                                                                        | found on PATH / SDK dirs | server                                                        |
| `PORT`, `HOST`                                                                      | `8080`, `0.0.0.0`        | relay                                                         |

## Platform notes

- The agent bundle is ES5 syntax and needs `WebSocket` and `Promise` (polyfill `Promise` before the tag on engines
  without it). It is tested in current Chrome only; verify it on each legacy engine before relying on it.
- Synthetic key events are untrusted: they reach the app's own key handlers (which TV focus engines use) but do
  not trigger browser default actions. The DevTools transport sends trusted keys.
- Some console browsers open a new window for `location.assign()`; the tools only ever set `location.href`.
- Android TV screensavers drop page sockets; run `adb_setup` once per device before unattended runs.
- Packaged `file://` apps (Tizen) are reset by reloading `index.html` in place, and routes like `file:///player`
  are mapped onto the exported `.html` files.

## Known gaps

- The default device is process-global; several MCP client sessions sharing one server should pass `device`.
- The agent hold (`holdKey`, used by `scrubToEnd`) always uses synthetic events, even when a `pressKey` hook is set.
- No per-device relay ACLs: a client token grants every device on that relay.
- Media loaded by platform-native players (e.g. AVPlay, native HLS) never passes through the page, so neither
  transport sees it; JavaScript players (hls.js, Shaka, dash.js and the like) fetch segments through XHR/fetch and
  are recorded (metadata only, media bodies are never read).
- Images, scripts, styles and other element loads come from resource timing on the agent: url, type, timing and
  size, status only where the engine reports `responseStatus`, no headers or bodies; cross-origin resources without
  `Timing-Allow-Origin` report no sizes. DevTools devices record them fully.
- `fetch`/XHR calls made before the agent script runs appear from resource timing only (no bodies); load the agent
  first in `<head>`.
- Response headers browsers hide from scripts (`Set-Cookie`) are only visible over DevTools.
- WebSocket frames are kept up to 200 per connection, text previews up to 4 KB.
