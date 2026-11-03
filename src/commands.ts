// ---------------------------------------------------------------------------
// The Telegram slash-command menu + which commands are injected into the TUI.
// ---------------------------------------------------------------------------
// Split out of config.ts (rather than living beside the other constants) purely
// to keep the import graph acyclic: resolveCommands() needs commandsFile() from
// paths, and paths needs STATE from config. config → paths → commands is a
// straight line; folding this into config would close the loop.
import { readFileSync } from 'fs'
import { commandsFile } from './paths'

export type SlashCommand = { command: string; description: string }

// Ordered by how often the owner actually reaches for them: daily cockpit first
// (status/wf/peers), interventions next (stop/model/effort/account), session
// maintenance after (compact/outbox/cli/reload), destructive + pure-ping last
// (clear/heartbeat). Telegram renders the menu in array order.
export const DEFAULT_COMMANDS: SlashCommand[] = [
  { command: 'status', description: 'Session status: model, ctx, rate limits, cwd' },
  { command: 'wf', description: 'Live view of the running workflow' },
  { command: 'peers', description: 'Fleet cockpit: account, model+effort, ctx % per agent' },
  { command: 'stop', description: 'Interrupt the agent (ESC) — then send a new instruction' },
  { command: 'model', description: "Switch the session's model (then pick effort)" },
  { command: 'effort', description: "Change the session's reasoning effort" },
  { command: 'account', description: 'Account + quota; /account login to switch in-place (no restart)' },
  { command: 'compact', description: 'Compact this session — frees context, keeps the thread' },
  { command: 'outbox', description: 'Agent-to-agent messages this agent sent (delivery status)' },
  { command: 'cli', description: 'Terminal command to attach to this session' },
  { command: 'rename', description: 'Rename this bot: /rename <label>, or bare = agent picks a smart label' },
  { command: 'reload', description: 'Reload plugins, agents, hooks, skills' },
  { command: 'clear', description: '⚠️ Start fresh — wipes current context' },
  { command: 'inspect', description: 'Operational log: what happened (default 24h; /inspect 7d)' },
  { command: 'heartbeat', description: 'Ping the bot bridge process (health check)' },
]

// Slash commands handled by injecting the literal text into the Claude TUI.
// Map menu name → text that lands in the session ("/compact\n" etc).
export const INJECT_COMMANDS: Record<string, string> = {
  compact: '/compact',
  clear: '/clear',
  reload: '/reload-plugins',
}

// Returns the effective slash-command list. Default = DEFAULT_COMMANDS. An
// optional commands.json in the bot's channels dir can override:
//   - { "commands": [] }                 → disable auto-registration entirely
//   - { "commands": [{command, description}, ...] }  → full replacement
//   - { "extra":    [{command, description}, ...] }  → merge with defaults
// Invalid JSON / missing file silently falls back to defaults.
export function resolveCommands(): SlashCommand[] | null {
  let raw: any
  try { raw = JSON.parse(readFileSync(commandsFile(), 'utf8')) } catch { return DEFAULT_COMMANDS }
  if (!raw || typeof raw !== 'object') return DEFAULT_COMMANDS
  const sanitize = (xs: any): SlashCommand[] => Array.isArray(xs)
    ? xs.filter(c => c && typeof c.command === 'string' && typeof c.description === 'string')
        .map(c => ({ command: String(c.command).replace(/^\//, ''), description: String(c.description) }))
    : []
  if (Array.isArray(raw.commands)) {
    if (raw.commands.length === 0) return null   // explicit opt-out
    return sanitize(raw.commands)
  }
  if (Array.isArray(raw.extra)) {
    const extras = sanitize(raw.extra)
    const seen = new Set(DEFAULT_COMMANDS.map(c => c.command))
    return [...DEFAULT_COMMANDS, ...extras.filter(c => !seen.has(c.command))]
  }
  return DEFAULT_COMMANDS
}
