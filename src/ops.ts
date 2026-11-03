// ---------------------------------------------------------------------------
// Operational telemetry: log everything, notify almost nothing.
// ---------------------------------------------------------------------------
// the owner, 2026-07-14: "i get a lot of operational messages — bot going on, down
// (even when it was I who requested this), watchdogs... seldom important but too
// noisy."
//
// The old model pushed every operational event straight into the chat, so a
// routine restart he asked for produced 🔴 going dark + 🟢 attached + a watchdog
// note — three notifications for a non-event. The signal-to-noise was bad enough
// that a real alert would be missed in the scroll.
//
// The new model splits telemetry from alerting:
//
//   opsEvent(sev, event, detail)
//     'info'  -> disk only. Read it later with /inspect. Never notifies.
//     'alert' -> disk AND a chat message. Reserved for "a human must act":
//                rate limit / quota, auth death, a watchdog heal that FAILED,
//                server rebooted.
//
// Status that used to arrive as a message is now carried by the bot's NAME
// (see setBotStatusIcon): a down bot renames itself 🔴, so the chat list itself
// shows fleet state at a glance and nothing has to be pushed.
//
// Recipients: alerts route through opsRecipients(), which is OWNER-ONLY. On a
// shared bot (guru serves a teammate/another teammate/a family member) they must never see ops traffic.
import { appendFileSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import type { Bot } from 'grammy'
import { stateDir } from './store'
import { state } from './state'

export type OpsSeverity = 'info' | 'alert'

export type OpsEvent = {
  ts: number
  sev: OpsSeverity
  event: string        // short stable key, e.g. 'attach', 'detach', 'rate_limit'
  detail?: string
}

// Bounded: keep the log useful for /inspect (7d) without growing forever.
const OPS_MAX_LINES = 2000
const OPS_TRIM_TO = 1500

function opsFile(slot: number): string {
  return join(stateDir(slot), 'ops.jsonl')
}

/**
 * Record an operational event. ALWAYS writes to disk; only sev='alert' is
 * allowed to reach the chat (the caller does the sending — this module owns the
 * ledger, not the transport).
 *
 * Returns true if the event warrants a notification.
 */
export function opsEvent(sev: OpsSeverity, event: string, detail?: string): boolean {
  const slot = state.currentSlot
  if (slot == null) return sev === 'alert'
  const rec: OpsEvent = { ts: Date.now(), sev, event, ...(detail ? { detail } : {}) }
  try {
    mkdirSync(stateDir(slot), { recursive: true, mode: 0o700 })
    appendFileSync(opsFile(slot), JSON.stringify(rec) + '\n')
    trimOpsLog(slot)
  } catch {
    // Telemetry must never break the bot. A failed write is silently dropped.
  }
  return sev === 'alert'
}

// Rewrite-on-overflow, atomically, so a crash mid-trim can't truncate the log.
function trimOpsLog(slot: number): void {
  try {
    const f = opsFile(slot)
    const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean)
    if (lines.length <= OPS_MAX_LINES) return
    const tmp = f + '.tmp'
    writeFileSync(tmp, lines.slice(-OPS_TRIM_TO).join('\n') + '\n')
    renameSync(tmp, f)
  } catch {}
}

export function readOpsLog(slot: number, sinceMs: number): OpsEvent[] {
  try {
    return readFileSync(opsFile(slot), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l) as OpsEvent } catch { return null } })
      .filter((e): e is OpsEvent => e !== null && e.ts >= sinceMs)
  } catch { return [] }
}

// ---------------------------------------------------------------------------
// The bot's NAME is the status indicator.
// ---------------------------------------------------------------------------
// Instead of pushing "🔴 detached — going dark" into the chat, the bot renames
// itself so the chat LIST shows it. Zero notifications, always-visible state.
//
// Only ever called on a state CHANGE (attach/detach), never on a poll, so
// Telegram's setMyName rate limit is not a concern in practice — and a 429 is
// swallowed anyway, because failing to rename must never take the bot down.
const DOWN_PREFIX = '🔴 '

export async function setBotStatusIcon(bot: Bot, down: boolean): Promise<void> {
  try {
    const current = (await bot.api.getMyName()).name
    const base = current.startsWith(DOWN_PREFIX) ? current.slice(DOWN_PREFIX.length) : current
    const wanted = down ? DOWN_PREFIX + base : base
    if (wanted === current) return           // no-op: never spend a rate-limit slot on a no-change
    await bot.api.setMyName(wanted)
  } catch {
    // 429 (name changed too often) or any API hiccup: the icon is a nicety, the
    // bot is not. Swallow.
  }
}

// ---------------------------------------------------------------------------
// /inspect — the backlog, on demand, as ONE message.
// ---------------------------------------------------------------------------
export function renderInspect(slot: number, hours: number): string {
  const since = Date.now() - hours * 3600_000
  const evs = readOpsLog(slot, since)
  const win = hours >= 24 ? `${Math.round(hours / 24)}d` : `${hours}h`

  if (evs.length === 0) {
    return `🔍 <b>inspect · last ${win}</b>\n\nNothing to report — no operational events.`
  }

  const alerts = evs.filter(e => e.sev === 'alert')
  const byEvent = new Map<string, number>()
  for (const e of evs) byEvent.set(e.event, (byEvent.get(e.event) ?? 0) + 1)

  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const time = (ts: number): string =>
    new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const day = (ts: number): string =>
    new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })

  const out: string[] = [`🔍 <b>inspect · last ${win}</b> — ${evs.length} event${evs.length > 1 ? 's' : ''}`]

  if (alerts.length) {
    out.push('', `<b>⚠️ Needed attention (${alerts.length})</b>`)
    for (const a of alerts.slice(-10)) {
      out.push(`• ${day(a.ts)} ${time(a.ts)} — ${esc(a.event)}${a.detail ? `: ${esc(a.detail)}` : ''}`)
    }
  } else {
    out.push('', '✅ No alerts — nothing needed you.')
  }

  const summary = [...byEvent.entries()].sort((a, b) => b[1] - a[1])
  out.push('', '<b>Summary</b>')
  for (const [ev, n] of summary) out.push(`• ${esc(ev)} × ${n}`)

  // Full timeline collapsed — present if he wants it, invisible if he doesn't.
  const tail = evs.slice(-60)
  out.push('', '<blockquote expandable>' + tail.map(e =>
    `${day(e.ts)} ${time(e.ts)} [${e.sev}] ${esc(e.event)}${e.detail ? ` — ${esc(e.detail)}` : ''}`,
  ).join('\n') + '</blockquote>')

  return out.join('\n')
}
