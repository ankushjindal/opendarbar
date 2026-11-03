// ---------------------------------------------------------------------------
// /account — which Anthropic account a session is on, and what quota is left.
// ---------------------------------------------------------------------------
import { execSync, spawn } from 'child_process'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, existsSync, realpathSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { STATE, SINGLE, BROKER_CLIENT, BOT_LABEL } from './config'
import { getClaudePid } from './store'
import { state } from './state'
import type { Bot } from 'grammy'
import { esc, fmtAge, shq } from './text'
import { getSessionContext, readAuthEmail, readStatusCache, type StatusCache } from './session'
import { fleetSelf, fleetRegistry, effortForHome } from './fleet'

// The two machines keep their switchable tokens in different places and are
// driven by different scripts, so every account entry point below branches on
// this one flag rather than sniffing paths at each call site.
const IS_MAC = process.platform === 'darwin'

// ---------------------------------------------------------------------------
// /account — inspect which Claude account each session is on + per-account quota,
// and switch the current session to another account. Multi-subscription support.
// Tokens live at ~/.config/claude-accounts/<label>; sessions are tagged by
// CLAUDE_ACCT_LABEL (written into the per-session status cache by the statusline).
// ---------------------------------------------------------------------------

export const ACCT_DIR = join(homedir(), '.config', 'claude-accounts')

export function listAccountLabels(): string[] {
  try { return readdirSync(ACCT_DIR).filter(f => !f.startsWith('.')) } catch { return [] }
}
export function accountTokenPath(label: string): string { return join(ACCT_DIR, label) }
export function readAccountToken(label: string): string | null {
  try { return readFileSync(accountTokenPath(label), 'utf8').trim() || null } catch { return null }
}

// Account SWITCH uses the fleet's setup-token store (creds-store/oat-<label>.txt)
// — the same probed, durable tokens fleet-ctl injects — NOT the older, possibly
// revoked ~/.config/claude-accounts/* that /account INSPECT still reads. A switch
// must relaunch on a token known-good, or it drops the session into a login wall.
// On the MAC there is no creds-store: ~/.config/claude-accounts/<label> IS the
// durable setup-token store (it is what dcx/kcx and fleet-up.sh launch from), so
// inspect and switch read the same files there.
export const CREDS_STORE = join(homedir(), '.claude', 'creds-store')
export function switchTokenPath(label: string): string {
  return IS_MAC ? accountTokenPath(label) : join(CREDS_STORE, `oat-${label}.txt`)
}
export function switchableAccounts(): string[] {
  if (IS_MAC) return listAccountLabels()
  try {
    return readdirSync(CREDS_STORE)
      .filter(f => /^oat-.+\.txt$/.test(f) && f !== 'oat-active.txt')
      .map(f => f.slice(4, -4))   // oat-<label>.txt -> <label>
  } catch { return [] }
}
// Which account THIS session actually booted on (#19 — "I can't tell if it's
// family1/personal or owner/work"). Ground truth: hash the live
// CLAUDE_CODE_OAUTH_TOKEN in the claude process's environ against the setup-token
// store → work/personal label. Email is the statusline's cached auth email. Both
// may be null (a file-grant session, or a cold statusline that hasn't written yet).
export function tokenHash(t: string): string { return createHash('sha256').update(t.trim()).digest('hex') }
function labelForToken(tok: string): string | null {
  const h = tokenHash(tok)
  for (const l of switchableAccounts()) {
    try { if (tokenHash(readFileSync(switchTokenPath(l), 'utf8')) === h) return l } catch {}
  }
  return null
}
// One env var out of the claude process, macOS edition. There is no /proc here,
// and `ps -E` truncates long environments, so a value can come back missing or
// clipped. Every caller therefore treats a miss as "ask the next source", never
// as "no account".
function macProcEnv(key: string): string | null {
  try {
    const pid = Number(getClaudePid())
    if (!Number.isFinite(pid) || pid <= 0) return null
    const out = execSync(`ps -E -o command= -p ${pid}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.match(new RegExp(`\\b${key}=([^\\s]+)`))?.[1] ?? null
  } catch { return null }
}
export function resolveSelfAccount(): { label: string | null; email: string | null } {
  let label: string | null = null
  if (IS_MAC) {
    // 1. the launcher's own label (dcx / kcx / fleet-up.sh / a dashboard switch)
    label = macProcEnv('CLAUDE_ACCT_LABEL')
    // 2. hash the live token, when ps showed us all of it
    if (!label) {
      const tok = macProcEnv('CLAUDE_CODE_OAUTH_TOKEN')
      if (tok) label = labelForToken(tok)
    }
    // 3. what the statusline resolved for this very session (it sees the real
    //    env, and is the only source that can name a keychain login)
    if (!label) {
      const c = readStatusCache(getSessionContext().resumeName) as (StatusCache & { label?: string }) | null
      const l = String(c?.label ?? '').trim()
      if (l && l !== '?' && l !== 'oat?') label = l
    }
  } else {
    try {
      const kv = readFileSync(`/proc/${getClaudePid()}/environ`, 'utf8')
        .split('\0').find(x => x.startsWith('CLAUDE_CODE_OAUTH_TOKEN='))
      const tok = kv ? kv.slice('CLAUDE_CODE_OAUTH_TOKEN='.length) : ''
      if (tok) label = labelForToken(tok)
    } catch {}
  }
  return { label, email: readAuthEmail() }
}
export function fmtSelfAccount(): string {
  const { label, email } = resolveSelfAccount()
  if (label && email) return `${label} · ${email}`
  if (label) return label
  if (email) return email
  return 'default login (file grant / unknown)'
}
// This son's registry name (for fleet-ctl / account-switch.sh), resolved by HOME
// so it's independent of bot-label vs registry-name drift.
export function selfAgentName(): string | null {
  const reg = fleetRegistry()
  // The Mac pool shares one HOME, so a home match there returns whichever agent
  // happens to be listed first (always kc) for every son. The pool identity is
  // the registry key on that machine: slot0 = kc, slot N = slot<N>.
  if (IS_MAC) {
    const self = fleetSelf()
    return reg.some(a => a.name === self) ? self : null
  }
  return reg.find(a => a.home === homedir())?.name ?? null
}
// Run a short shell command and resolve its exit code. Async (so the Telegram
// poller keeps turning) and hard-bounded (so a wedged tmux server cannot park a
// turn). -1 means "could not tell": timed out, or never started.
function sh(cmd: string, timeoutMs: number): Promise<number> {
  return new Promise(resolve => {
    let done = false
    const fin = (code: number) => { if (!done) { done = true; clearTimeout(t); resolve(code) } }
    const child = spawn('/bin/sh', ['-c', cmd], { stdio: 'ignore' })
    const t = setTimeout(() => { try { child.kill('SIGKILL') } catch {} ; fin(-1) }, timeoutMs)
    child.on('error', () => fin(-1))
    child.on('close', code => fin(code ?? -1))
  })
}
// Fire the detached account switch. account-switch.sh sets quiet markers, drops
// the confirmation marker, and (after a short delay) relaunches this son via
// fleet-ctl start with the target token injected — resuming the SAME session.
// The script only SCHEDULES the detached relaunch, so this bot process finishes
// the turn before its own tmux session is killed.
export async function doAccountSwitch(bot: Bot, label: string, chatId: string): Promise<void> {
  const agent = selfAgentName()
  const tok = switchTokenPath(label)
  if (!agent || !existsSync(tok)) {
    try { await bot.api.sendMessage(chatId, `Switch aborted — ${!agent ? 'no registry agent name for this HOME' : `token missing at ${tok}`}.`) } catch {}
    return
  }
  // Same contract on both machines (detached, quiet, resume-preserving), two
  // scripts because the relaunch differs: server delegates to fleet-ctl with an
  // OAT override, the Mac rebuilds the tmux command itself from the registry.
  const script = IS_MAC
    ? join(import.meta.dir, '..', 'fleet', 'mac-account-switch.sh')
    : join(homedir(), 'kai', 'account-switch.sh')
  const cmd = IS_MAC
    ? `${shq(script)} ${shq(agent)} ${shq(label)} ${shq(chatId)}`
    : `${shq(script)} ${shq(agent)} ${shq(tok)} ${shq(label)} ${shq(chatId)}`
  const logHint = IS_MAC ? '~/.claude/channels/fleet/logs/mac-account-switch.log' : '~/kai/logs/account-switch.log'
  // Busy guard, Mac only (this is where the switch kills a pane outright). The
  // script's --dry-run resolves everything and exits 3 when the pane is mid-turn,
  // so ask it first and refuse rather than throwing a live turn away. There is
  // deliberately NO force path from Telegram: killing someone's turn in flight is
  // a decision that belongs in front of the dashboard's confirm, not in a chat.
  if (IS_MAC) {
    const probe = `${shq(script)} --dry-run ${shq(agent)} ${shq(label)}`
    if (await sh(probe, 10_000) === 3) {
      try {
        await bot.api.sendMessage(chatId, `Switch to <b>${esc(label)}</b> refused: <b>${esc(agent)}</b> is mid-turn right now, and switching kills the pane (that turn's work would be lost, not resumed). Try again once it is idle, or force it from the dashboard /fleet accounts panel.`, { parse_mode: 'HTML' })
      } catch {}
      return
    }
  }
  // Detached, never awaited: this runs on the Telegram poller's thread, and the
  // scripts do real work before they fork (jq over the registry, tmux capture,
  // a token stat). An execSync with no timeout would park the poller for as long
  // as any one of those takes, and a wedged tmux server would park it forever.
  // The scripts only SCHEDULE the relaunch, so there is nothing to wait for.
  try {
    const child = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: 'ignore' })
    child.on('error', (err) => { process.stderr.write(`kushbot: account-switch spawn failed: ${err}\n`) })
    child.unref()
  } catch (err) {
    process.stderr.write(`kushbot: account-switch spawn failed: ${err}\n`)
    try { await bot.api.sendMessage(chatId, `Switch to ${label} failed to launch. Check ${logHint}`) } catch {}
  }
}

export type StatusEntry = StatusCache & { email?: string | null; label?: string | null; sessionId?: string }

// Read every per-session status cache (/tmp/.claude_status_<sid>.json).
export function readAllStatusCaches(): StatusEntry[] {
  const out: StatusEntry[] = []
  let files: string[] = []
  try { files = readdirSync('/tmp') } catch { return out }
  for (const f of files) {
    if (!f.startsWith('.claude_status_') || !f.endsWith('.json')) continue
    try {
      const e = JSON.parse(readFileSync(join('/tmp', f), 'utf8')) as StatusEntry
      e.sessionId = f.slice('.claude_status_'.length, -'.json'.length)
      out.push(e)
    } catch {}
  }
  return out
}

export function acctKey(e: StatusEntry): string {
  const l = (e.label ?? '').trim()
  return l || (e.email ?? '').trim() || 'unknown'
}

// Live per-account usage. There's no GET endpoint for subscription 5h/7d usage
// with an OAuth token, but the unified ratelimit headers come back on any
// /v1/messages call — so probe each saved account with a 1-token haiku call and
// read the headers. `utilization` is a FRACTION (0-1). Cached 60s per account so
// repeat /account checks don't burn calls.
export type AcctUsage = { five: number; fiveReset: number; seven: number; sevenReset: number; status: string }
export async function probeAccountUsage(label: string): Promise<AcctUsage | null> {
  const tok = readAccountToken(label)
  if (!tok) return null
  const cacheF = `/tmp/.claude_acct_usage_${label}.json`
  try { const c = JSON.parse(readFileSync(cacheF, 'utf8')); if (Date.now() - c.ts < 60_000 && c.v?.fiveReset) return c.v } catch {}
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tok}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }),
    })
    const num = (h: string) => { const v = Number(r.headers.get(h)); return Number.isFinite(v) ? v : NaN }
    const v: AcctUsage = {
      five: num('anthropic-ratelimit-unified-5h-utilization'),
      fiveReset: num('anthropic-ratelimit-unified-5h-reset'),
      seven: num('anthropic-ratelimit-unified-7d-utilization'),
      sevenReset: num('anthropic-ratelimit-unified-7d-reset'),
      status: r.headers.get('anthropic-ratelimit-unified-status') || '?',
    }
    try { writeFileSync(cacheF, JSON.stringify({ ts: Date.now(), v })) } catch {}
    return v
  } catch { return null }
}

// Match the statusline: 5h shows time-to-reset (rounded to 15min); 7d shows
// what % of the 7-day window has elapsed. e.g. "5h: 26%/2:45h | 7d: 55%/29%".
export function fmt5hLeft(resetEpoch: number): string {
  const secs = Math.max(0, resetEpoch - Math.floor(Date.now() / 1000))
  const mins = Math.floor((secs + 450) / 900) * 15
  const h = Math.floor(mins / 60), m = mins % 60
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}:${String(m).padStart(2, '0')}h`
}
export function fmt7dElapsed(resetEpoch: number): number {
  const now = Math.floor(Date.now() / 1000)
  return Math.max(0, Math.min(100, Math.floor((now - (resetEpoch - 604800)) * 100 / 604800)))
}

export async function renderAccountUsageLive(): Promise<string> {
  const labels = listAccountLabels()
  if (!labels.length) return '<i>no accounts saved (claude-acct save &lt;label&gt;)</i>'
  const rows = await Promise.all(labels.sort().map(async l => {
    const u = await probeAccountUsage(l)
    if (!u || Number.isNaN(u.five)) return `<b>${esc(l)}</b> — <i>unavailable</i>`
    const f = Math.round(u.five * 100), s = Math.round(u.seven * 100)
    const flag = u.status && u.status !== 'allowed' ? `  ⚠️ ${esc(u.status)}` : ''
    return `<b>${esc(l)}</b>  5h: ${f}%/${fmt5hLeft(u.fiveReset)} | 7d: ${s}%/${fmt7dElapsed(u.sevenReset)}%${flag}`
  }))
  return rows.join('\n')
}

