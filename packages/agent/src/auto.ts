// Script-tag entry, bundled as dist/tv-mcp-agent.js and served by the relay at /agent.js:
//   <script src="http://<relay>:8080/agent.js" data-autostart></script>
// Options come from data-* attributes (data-relay, data-name, data-token, data-build, data-profile as
// JSON) or from window.TVMCP_OPTIONS set before the tag. Without data-relay the script's own origin is used.
import { startAgent } from './agent.js'

import type { AgentHandle, AgentOptions } from './agent.js'

interface Global {
  TVMCP_OPTIONS?: Partial<AgentOptions>
  TvMcpAgent?: { start: typeof startAgent; current: AgentHandle | null }
}

function findScript(): HTMLScriptElement | null {
  const current = document.currentScript as HTMLScriptElement | null
  if (current) return current
  const scripts = document.getElementsByTagName('script')
  for (let i = scripts.length - 1; i >= 0; i--) {
    if (/(\/agent\.js|tv-mcp-agent(\.min)?\.js)(\?|$)/.test(scripts[i].src)) return scripts[i]
  }
  return null
}

/** The script's http(s) origin; a script bundled into a packaged (file://) app has none. */
function originOf(src: string): string {
  const match = /^(https?:\/\/[^/]+)/.exec(src)
  return match ? match[1] : ''
}

const g = window as unknown as Global
const api = { start: startAgent, current: null as AgentHandle | null }
g.TvMcpAgent = api

const script = findScript()
if (script && script.hasAttribute('data-autostart')) {
  const preset = g.TVMCP_OPTIONS || {}
  let profile = preset.profile
  const profileAttr = script.getAttribute('data-profile')
  if (profileAttr) {
    try {
      profile = JSON.parse(profileAttr)
    } catch (e) {
      // keep the preset profile
    }
  }
  const options: AgentOptions = {
    relayUrl: script.getAttribute('data-relay') || preset.relayUrl || originOf(script.src),
    token: script.getAttribute('data-token') || preset.token,
    name: script.getAttribute('data-name') || preset.name,
    platform: script.getAttribute('data-platform') || preset.platform,
    build: script.getAttribute('data-build') || preset.build,
    profile,
    hooks: preset.hooks,
    captureConsole: preset.captureConsole,
    captureNetwork: preset.captureNetwork,
  }
  const start = () => {
    api.current = startAgent(options)
  }
  if (!options.relayUrl) {
    console.error('[tv-mcp] agent not started: set data-relay (the script is not served by a relay)')
  } else {
    // Start at once, even from <head>, so requests the app makes while it boots are captured.
    start()
  }
}
