// ---------------------------------------------------------------------------
// Filesystem locations derived from STATE. Leaf module: config only.
// ---------------------------------------------------------------------------
import { homedir } from 'os'
import { isAbsolute, join } from 'path'
import { STATE } from './config'

// broker-client: where the standalone broker's Unix-domain socket lives.
export function brokerSockPath(): string {
  const p = STATE.brokerSock ?? join(STATE.channelsDir || join('channels', 'telegram'), 'broker.sock')
  return isAbsolute(p) ? p : join(homedir(), '.claude', p)
}

// In single mode there is exactly one bot, addressed internally as "slot 0",
// whose state (.env / access.json / inbox) lives directly in channelsDir
// instead of a slotN subfolder.
export function singleDir(): string {
  return isAbsolute(STATE.channelsDir) ? STATE.channelsDir : join(homedir(), '.claude', STATE.channelsDir)
}

export const KUSHBOTS_ROOT = process.env.KUSHBOT_ROOT ?? join(homedir(), '.claude', 'channels', 'kushbots')

// Where to look for an optional per-bot commands.json override. Single-bot homes
// keep it next to kushbot.json (the standard channels dir); pool mode falls back
// to the kushbots root (rarely used in practice — pool bots get the defaults).
export function commandsFile(): string {
  const dir = STATE.channelsDir
    ? (isAbsolute(STATE.channelsDir) ? STATE.channelsDir : join(homedir(), '.claude', STATE.channelsDir))
    : KUSHBOTS_ROOT
  // commands.json lives one level above (e.g. ~/.claude/channels/commands.json),
  // since channelsDir points at the bot's state subfolder (.../telegram).
  return join(dir, '..', 'commands.json')
}

// The SHARED fleet root for agent-to-agent mail (kushbot.json `fleetRoot`; on
// server every home points at parent kai's ~/.claude/channels/fleet).
export function fleetRootDir(): string | null {
  if (STATE.fleetRoot) return isAbsolute(STATE.fleetRoot) ? STATE.fleetRoot : join(homedir(), '.claude', STATE.fleetRoot)
  return null   // fleet messaging disabled unless configured
}
