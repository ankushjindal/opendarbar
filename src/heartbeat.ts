// ---------------------------------------------------------------------------
// /heartbeat — process-only self-diagnosis. NEVER injects into the model.
// ---------------------------------------------------------------------------
// The point is to answer "is the bridge alive?" WITHOUT costing a turn, so every
// check reads process/filesystem state only.
import { execSync } from 'child_process'
import { readFileSync, existsSync, statSync } from 'fs'
import { homedir, loadavg, freemem, totalmem, cpus } from 'os'
import { join, basename } from 'path'
import { STATE, SINGLE, BROKER_CLIENT, ONE_BOT, BOT_LABEL, NO_POLL } from './config'
import { recentErrorLines, bootPpid } from './errlog'
import { brokerSockPath } from './paths'
import { isSlotClaimed, isPidAlive, slotPidFile, getClaudePid } from './store'
import { state } from './state'
import { esc, fmtAge, shq } from './text'
import { getSessionContext, readSessionJson, readStatusCache } from './session'

// ---------------------------------------------------------------------------
// /heartbeat — process-only self-diagnosis (NEVER injects into the model)
// ---------------------------------------------------------------------------

// Load + memory snapshot. macOS over-reports "used" memory (inactive pages),
// so the caller applies a looser threshold there.
export function loadAndMem(): { load1: number; cores: number; usedPct: number } {
  let load1 = 0, cores = 1, usedPct = 0
  try { load1 = loadavg()[0] } catch {}
  try { cores = Math.max(1, cpus().length) } catch {}
  try { usedPct = Math.round((1 - freemem() / totalmem()) * 100) } catch {}
  return { load1, cores, usedPct }
}

// Count how many instances of THIS server binary are running (duplicate MCPs =
// 409 / orphan busy-loop risk). Best-effort: any failure reports 1 (ourselves).
//
// The cwd-based filter (`/plugins/local/kushbot`) is the safety net against
// false positives — `pgrep -af server.ts` would otherwise pick up any unrelated
// bun script with "server.ts" in its cmdline (e.g. the server-dashboard service,
// transient git-hook spawns, other claude-data sync scripts). 2026-06-24 healthy
// fleet on server showed 11 legit kushbot procs but `pgrep -af server.ts`
// surfaced 13 — the 2 extras were the dashboard + a transient. The cwd test
// scopes us back to actual kushbot MCP children only.
export function countMyMcpProcs(): number {
  try {
    const base = basename(process.argv[1] || 'server.ts')
    const out = execSync(`pgrep -af ${shq(base)} 2>/dev/null`).toString().trim()
    if (!out) return 1
    const pids = out.split('\n').filter(Boolean).map(line => line.split(/\s+/)[0])
    let count = 0
    for (const pid of pids) {
      try {
        const cwd = execSync(`readlink /proc/${pid}/cwd 2>/dev/null`).toString().trim()
        // Match the canonical kushbot plugin install path. Across the fleet:
        //   ~/<son>-home/.claude/plugins/local/kushbot
        //   ~/.claude/plugins/local/kushbot   (parent kai's canonical install)
        if (cwd.includes('/plugins/local/kushbot')) count++
      } catch { /* /proc/<pid>/cwd unreadable → skip */ }
    }
    return count > 0 ? count : 1   // we must be in the count
  } catch { return 1 }
}

// Build the HTML /heartbeat report. Process / ps / os only — every probe is
// wrapped so a missing tool yields "—" rather than throwing. Never injects.
export function runHeartbeat(): string {
  type Row = { sev: 0 | 1 | 2; mark: string; label: string; value: string }
  const rows: Row[] = []
  let worst: 0 | 1 | 2 = 0
  const mk = (sev: 0 | 1 | 2) => sev === 2 ? '❌' : sev === 1 ? '⚠️' : '✅'
  const add = (sev: 0 | 1 | 2, label: string, value: string) => {
    if (sev > worst) worst = sev
    rows.push({ sev, mark: mk(sev), label, value })
  }
  // advisory rows never escalate the verdict
  const note = (label: string, value: string) => rows.push({ sev: 0, mark: '✅', label, value })

  // 1. session pid liveness
  let claudePid = 0
  try { claudePid = getClaudePid() } catch {}
  const pidAlive = claudePid > 1 && isPidAlive(claudePid)
  add(pidAlive ? 0 : 2, 'session pid', pidAlive ? `${claudePid} alive` : `${claudePid || '?'} GONE (claude exited — orphan)`)

  // 2. orphan / reparent (same signals as the watchdog at the bottom)
  let parentDead = false
  if (process.platform !== 'win32' && bootPpid > 1) {
    try { process.kill(bootPpid, 0) } catch (e: any) { if (e?.code === 'ESRCH') parentDead = true }
  }
  const reparented = process.platform !== 'win32' && process.ppid !== bootPpid
  const stdinDead = process.stdin.destroyed || process.stdin.readableEnded
  const orphaned = parentDead || reparented || stdinDead
  add(orphaned ? 2 : 0, 'orphan',
    orphaned ? 'ORPHANED, will self-exit' : `no (parent ${bootPpid} alive)`)

  // 3. polling / broker binding
  if (BROKER_CLIENT) {
    const ok = !!state.currentBrokerSocket && !state.currentBrokerSocket.destroyed
    add(ok ? 0 : 2, 'broker',
      ok ? `connected as @${state.currentBotUsername || '?'}` : 'NOT connected — inbound queues unanswered')
  } else {
    const ok = state.currentBot != null && state.currentSlot != null
    add(ok ? 0 : 2, 'polling',
      ok ? `active as @${state.currentBotUsername || '?'} (slot${state.currentSlot})` : 'not attached — inbound queues unanswered')
  }

  // 4. last inbound (advisory only — a quiet chat is not unhealthy)
  note('last inbound', fmtAge(state.lastInboundAt))

  // 5. statusline freshness
  try {
    const sess = readSessionJson() ?? {}
    const sessionId = typeof sess.sessionId === 'string' ? sess.sessionId : null
    const cache = readStatusCache(sessionId)
    if (!cache || cache.ts == null) {
      add(1, 'statusline', 'no cache (statusline not running?)')
    } else {
      const tsMs = cache.ts < 1e12 ? cache.ts * 1000 : cache.ts
      const ageS = Math.floor((Date.now() - tsMs) / 1000)
      add(ageS > 120 && pidAlive ? 1 : 0, 'statusline',
        ageS > 120 ? `stale (rendered ${fmtAge(tsMs)})` : `fresh (${fmtAge(tsMs)})`)
    }
  } catch { add(1, 'statusline', '—') }

  // 6. duplicate MCP processes
  const procs = countMyMcpProcs()
  add(procs > 2 ? 2 : procs === 2 ? 1 : 0, 'mcp procs',
    procs === 1 ? '1 instance of this server' : `${procs} instances of this server`)

  // 7. load
  const { load1, cores, usedPct } = loadAndMem()
  add(load1 > cores * 2 ? 1 : 0, 'load', `1m=${load1.toFixed(2)} (${cores} core${cores === 1 ? '' : 's'})`)

  // 8. memory (Mac over-reports used → looser 95% WARN threshold)
  const memWarn = STATE.machine === 'mac' ? 95 : 80
  const memCrit = STATE.machine === 'mac' ? 98 : 90
  add(usedPct >= memCrit ? 2 : usedPct >= memWarn ? 1 : 0, 'mem', `${usedPct}% used`)

  // 9. recent stderr errors (the real 409/flap detector)
  const errs = recentErrorLines()
  add(errs.length >= 3 ? 2 : errs.length >= 1 ? 1 : 0, 'recent errors',
    errs.length === 0 ? 'none in last 10m' : `${errs.length} in last 10m`)

  // ---- assemble ----
  const sev: number = worst   // widen: TS narrows the closure-mutated `worst` to 0
  const verdict = sev === 2
    ? '❌ unhealthy — likely not responding'
    : sev === 1 ? '⚠️ degraded — see flags' : '✅ healthy'
  const head = `<b>Heartbeat — ${esc(BOT_LABEL)}@${esc(STATE.machine)} (${esc(STATE.mode)})</b>`
  const pad = Math.max(...rows.map(r => r.label.length))
  const body = rows
    .map(r => `${r.mark} ${esc(r.label.padEnd(pad))}  ${esc(r.value)}`)
    .join('\n')
  let out = `${head}\n${verdict}\n\n<pre>${body}</pre>`
  if (errs.length) {
    const tail = errs.slice(-6).map(e => `▸ ${esc(e.line)}`).join('\n')
    out += `\n\n<b>Recent errors</b>\n<blockquote expandable>${tail}</blockquote>`
  }
  return out
}

// ---------------------------------------------------------------------------
// /cli — exact copy-pasteable terminal command to jump into THIS session
// ---------------------------------------------------------------------------
