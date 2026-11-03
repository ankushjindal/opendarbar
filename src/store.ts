// ---------------------------------------------------------------------------
// Slot / pool store — the filesystem primitives. Pure I/O, no bot state.
// ---------------------------------------------------------------------------
// A "slot" is a (token, access.json, inbox, claim) tuple on disk. In pool mode
// (Mac) slots live at ~/.claude/channels/kushbots/slot<N>/. In single mode
// (server sons) there is exactly one bot, addressed internally as slot 0, whose
// state lives directly in channelsDir.
//
// The claim file (claimed_by.pid) is the mutual-exclusion primitive: Telegram
// permits exactly one getUpdates consumer per token, so exactly one process may
// hold a slot. writeClaim() pre-empts a stale holder; releaseClaim() only ever
// removes OUR OWN claim (pid check) so a live sibling is never evicted.
import { execSync } from 'child_process'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, chmodSync } from 'fs'
import { join } from 'path'
import { ONE_BOT, BROKER_CLIENT, STATE } from './config'
import { KUSHBOTS_ROOT, singleDir } from './paths'

export function slotDir(slot: number): string { return ONE_BOT ? singleDir() : join(KUSHBOTS_ROOT, `slot${slot}`) }
// In broker-client mode several sessions share one bot dir — the token (.env)
// lives at the root, but each session gets a per-label subdir for its own
// access/inbox/approved/claim so concurrent clients never clobber each other.
export function stateDir(slot: number): string {
  return (BROKER_CLIENT && STATE.label) ? join(slotDir(slot), STATE.label) : slotDir(slot)
}
export function slotEnvFile(slot: number): string { return join(slotDir(slot), '.env') }
export function slotAccessFile(slot: number): string { return join(stateDir(slot), 'access.json') }
export function slotApprovedDir(slot: number): string { return join(stateDir(slot), 'approved') }
export function slotInboxDir(slot: number): string { return join(stateDir(slot), 'inbox') }
export function slotPidFile(slot: number): string { return join(stateDir(slot), 'claimed_by.pid') }

export function listSlots(): number[] {
  if (ONE_BOT) return [0]
  let entries: string[] = []
  try { entries = readdirSync(KUSHBOTS_ROOT) } catch { return [] }
  return entries
    .map(s => /^slot(\d+)$/.exec(s))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => parseInt(m[1], 10))
    .sort((a, b) => a - b)
}

export function readSlotEnv(slot: number): Record<string, string> {
  const out: Record<string, string> = {}
  try { chmodSync(slotEnvFile(slot), 0o600) } catch {}
  try {
    for (const line of readFileSync(slotEnvFile(slot), 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m) out[m[1]] = m[2]
    }
  } catch {}
  return out
}

export function isPidAlive(pid: number): boolean {
  if (pid <= 1) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

export function isSlotClaimed(slot: number): boolean {
  try {
    const pid = parseInt(readFileSync(slotPidFile(slot), 'utf8'), 10)
    if (pid === process.pid) return true
    return isPidAlive(pid)
  } catch { return false }
}

// slot0 is reserved for kc (the always-on parent session). Auto-pick skips it;
// explicit attach({slot:0}) and KUSHBOT_AUTO_ATTACH=0 still work.
export function findFreeSlot(): number | null {
  for (const s of listSlots()) {
    if (s === 0) continue
    if (!isSlotClaimed(s)) return s
  }
  return null
}

// Walk up a pid's ancestor chain to find the first process whose comm contains
// "claude". Returns {claudePid, tty, cwd} — or all "?" if not found.
export function resolveSession(mcpPid: number): { claudePid: string; tty: string; cwd: string } {
  let p = mcpPid
  for (let i = 0; i < 10; i++) {
    let ppid: number
    try {
      ppid = parseInt(execSync(`ps -o ppid= -p ${p}`).toString().trim(), 10)
    } catch { break }
    if (!ppid || ppid <= 1) break
    let comm = ''
    try { comm = execSync(`ps -o comm= -p ${ppid}`).toString().trim() } catch {}
    const base = comm.split('/').pop() || comm
    if (/claude/i.test(base)) {
      let tty = '?'
      let cwd = '?'
      try { tty = execSync(`ps -o tty= -p ${ppid}`).toString().trim() || '?' } catch {}
      try {
        const lsofOut = execSync(`lsof -p ${ppid} -d cwd 2>/dev/null`).toString()
        const cwdLine = lsofOut.split('\n')[1] || ''
        const parts = cwdLine.split(/\s+/)
        cwd = parts.slice(8).join(' ') || '?'
      } catch {}
      return { claudePid: String(ppid), tty, cwd }
    }
    p = ppid
  }
  return { claudePid: '?', tty: '?', cwd: '?' }
}

export function writeClaim(slot: number): void {
  mkdirSync(slotDir(slot), { recursive: true, mode: 0o700 })
  // Pre-empt any stale poller still holding this slot.
  try {
    const stale = parseInt(readFileSync(slotPidFile(slot), 'utf8'), 10)
    if (stale > 1 && stale !== process.pid && isPidAlive(stale)) {
      process.stderr.write(`kushbot slot${slot}: replacing stale poller pid=${stale}\n`)
      try { process.kill(stale, 'SIGTERM') } catch {}
    }
  } catch {}
  writeFileSync(slotPidFile(slot), String(process.pid))
}

export function releaseClaim(slot: number): void {
  try {
    const pid = parseInt(readFileSync(slotPidFile(slot), 'utf8'), 10)
    if (pid === process.pid) rmSync(slotPidFile(slot))
  } catch {}
}

// Status file keyed by the CLAUDE session pid (not our own ppid — that's the
// `bun run` wrapper on macOS, which isn't in the statusline shell's ancestor
// chain). Walk up via ps until we find a process whose comm contains "claude".
// Cached for the life of the server process.
export const STATUS_DIR = join(KUSHBOTS_ROOT, '_status')
let cachedClaudePid: number | null = null
export function getClaudePid(): number {
  if (cachedClaudePid !== null) return cachedClaudePid
  let p: number = process.pid
  for (let i = 0; i < 10; i++) {
    let ppid: number
    try {
      ppid = parseInt(execSync(`ps -o ppid= -p ${p}`).toString().trim(), 10)
    } catch { break }
    if (!ppid || ppid <= 1) break
    let comm = ''
    try { comm = execSync(`ps -o comm= -p ${ppid}`).toString().trim() } catch {}
    if (/claude/i.test(comm)) { cachedClaudePid = ppid; return ppid }
    p = ppid
  }
  cachedClaudePid = process.ppid
  return cachedClaudePid
}
export function statusFile(): string { return join(STATUS_DIR, String(getClaudePid())) }
export function writeStatus(slot: number): void {
  try {
    mkdirSync(STATUS_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(statusFile(), `slot=${slot}\n`)
  } catch {}
}
export function clearStatus(): void {
  try { rmSync(statusFile(), { force: true }) } catch {}
}

