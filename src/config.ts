// ---------------------------------------------------------------------------
// Machine + bot state, and the env-gated mode flags.
// ---------------------------------------------------------------------------
// Leaf module: imports nothing from src/. Everything here is resolved once at
// boot and read-only thereafter, so any module may import it freely.
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// --- machine + bot state (per-home config; absent ⇒ Mac pool mode) ---------
// A home becomes a single-bot host (server: kai, kai-son, kai2, vaidya) by
// dropping ~/.claude/channels/kushbot.json:
//   { "machine": "server", "mode": "single", "bot": "kai",
//     "channelsDir": "channels/telegram" }
// No file (or mode != "single") ⇒ { machine:"mac", mode:"pool" } ⇒ behaviour
// is byte-for-byte the old pool logic, so the Mac kush pool is untouched.
export type KushbotState = { machine: string; mode: 'pool' | 'single' | 'broker-client'; bot: string | null; channelsDir: string; brokerSock?: string; label?: string; fleetRoot?: string }

export const STATE_FILE = process.env.KUSHBOT_STATE ?? join(homedir(), '.claude', 'channels', 'kushbot.json')

function loadState(): KushbotState {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (raw && typeof raw === 'object' && (raw.mode === 'single' || raw.mode === 'broker-client')) {
      return {
        machine: String(raw.machine ?? 'server'),
        mode: raw.mode,
        bot: raw.bot != null ? String(raw.bot) : null,
        channelsDir: String(raw.channelsDir ?? join('channels', 'telegram')),
        brokerSock: raw.brokerSock != null ? String(raw.brokerSock) : undefined,
        label: raw.label != null ? String(raw.label) : undefined,
        fleetRoot: raw.fleetRoot != null ? String(raw.fleetRoot) : undefined,
      }
    }
  } catch {}
  // Pool mode: still honor machine/fleetRoot from the file so the Mac pool can
  // join fleet A2A (2026-07-07 cross-device work). Without this, pool mode
  // hardcoded machine:'mac' (the registry calls the Mac 'laptop') and never
  // loaded a fleetRoot — A2A was structurally disabled on the Mac.
  let machine = 'mac'
  let fleetRoot: string | undefined
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (raw && typeof raw === 'object') {
      if (raw.machine != null) machine = String(raw.machine)
      if (raw.fleetRoot != null) fleetRoot = String(raw.fleetRoot)
    }
  } catch {}
  return { machine, mode: 'pool', bot: null, channelsDir: '', fleetRoot }
}

export const STATE = loadState()
export const SINGLE = STATE.mode === 'single'
export const BROKER_CLIENT = STATE.mode === 'broker-client'
export const ONE_BOT = SINGLE || BROKER_CLIENT
export const BOT_LABEL = STATE.bot ?? STATE.machine

// --- env-gated modes (codex-bridge; all additive — unset = legacy behavior) --
// Outbound-only mode (codex-bridge Phase 2). When set, this instance attaches a
// slot that is ALREADY claimed + polled by the inbound child, purely to expose
// the messaging tools (reply/react/edit_message/ask/send_to_agent) for OUTBOUND.
// It NEVER polls, NEVER claims the slot, NEVER writes status, and NEVER touches
// the inbound child's claim file on detach. Fully additive + env-gated: absent
// this env var the pool behaves exactly as before.
export const NO_POLL = process.env.KUSHBOT_NO_POLL === '1'
// Suppress the 🟢 attached / 🔴 detached lifecycle notices. A long-lived host
// like the codex-bridge attaches/detaches its inbound child on every restart;
// pinging the owner each time is noise. Env-gated + additive: unset = notices fire
// exactly as before.
export const QUIET_LIFECYCLE = process.env.KUSHBOT_QUIET_LIFECYCLE === '1'
// codex-bridge Phase 3: the session-control slash commands (/model /effort /stop
// /clear /compact) drive a codex app-server, not a Claude TUI — so the tmux
// send-keys path is meaningless. When set, those five commands SKIP tmux and emit
// a dedicated channel notification (meta.source="command") the bridge maps to an
// app-server method. Env-gated + additive: unset = today's tmux behavior is
// byte-identical.
export const CODEX_MODE = process.env.KUSHBOT_CODEX_MODE === '1'
// codex-bridge Phase 5: free the slot FAST on shutdown so a durable supervisor
// can restart immediately. Releases the claim + clears status BEFORE the slow
// grammy bot.stop() long-poll drain (which the 3s hard backstop otherwise races,
// orphaning the claim). Env-gated + additive: unset = today's ordered shutdown.
export const FAST_SHUTDOWN = process.env.KUSHBOT_FAST_SHUTDOWN === '1'
