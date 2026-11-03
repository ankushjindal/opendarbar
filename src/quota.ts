// ---------------------------------------------------------------------------
// /quota - every AI budget the owner pays for, in one Telegram message.
// ---------------------------------------------------------------------------
// Two agents only: kc (the Mac parent) and kai (the server parent). The numbers
// are machine-wide and account-wide, so eleven sons each answering /quota would
// be eleven identical replies plus eleven live probes against the same accounts.
// Every other bot answers one line and points at the two that can.
//
// All the actual reading lives in fleet/quota.sh (shared with the CLI and with
// quota-alert.sh, so the three cannot drift). This module only shells out to it
// with --json and renders.
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { esc } from './text'
import { fleetSelf } from './fleet'
import { selfAgentName } from './accounts'

// Exactly the two parents. fleetSelf() covers both shapes: single-mode bots
// report their bot label ('kai' on server), and the Mac pool reports 'kc' for
// slot 0. selfAgentName() (registry lookup by HOME) is a second chance for
// server, where every home is its own agent - on the Mac it is unreliable,
// because kc and slots 1-3 all share one HOME.
const QUOTA_AGENTS = new Set(['kc', 'kai'])

export function quotaAllowed(): boolean {
  if (QUOTA_AGENTS.has(fleetSelf())) return true
  const n = selfAgentName()
  return n != null && QUOTA_AGENTS.has(n)
}

export const QUOTA_DENIAL = 'quota lives on kush and kai'

// fleet/quota.sh, wherever this install put it. The plugin checkout is the
// canonical copy; ~/kai/quota.sh and ~/bin/quota are symlinks to it, and are
// checked as a fallback in case this module ever runs from a bundled build with
// no fleet/ sibling.
export function quotaScriptPath(): string | null {
  const candidates = [
    join(import.meta.dir, '..', 'fleet', 'quota.sh'),
    join(homedir(), 'kai', 'quota.sh'),
    join(homedir(), '.claude', 'plugins', 'local', 'kushbot', 'fleet', 'quota.sh'),
    join(homedir(), 'bin', 'quota'),
  ]
  return candidates.find(p => existsSync(p)) ?? null
}

type Pool = {
  pool: string
  five_pct: number | null
  five_reset: number | null
  five_reset_ist: string
  weekly_pct: number | null
  weekly_reset_ist: string
  weekly_remaining_pct: number | null
  hours_left: number | null
  windows_left: number | null
  source: string
  age_s: number | null
  at_risk: boolean
  risk_reason: string
  note: string
}
type QuotaReport = { host: string; now: number; pools: Pool[] }

// Why the three outcomes are distinct: the old code returned null for all of
// them and the caller rendered "quota.sh not available on this host", which is a
// lie for the common case (the script IS there, a live probe was slow). A wrong
// diagnosis costs more than no diagnosis.
type QuotaRead =
  | { ok: true; report: QuotaReport }
  | { ok: false; why: 'missing' | 'timeout' | 'failed'; detail: string }

// execFileSync BLOCKS the bun event loop. quota.sh does two Claude header probes
// (curl -m 25 each) plus a codex app-server probe (10s ceiling), so a bad network
// froze the whole bot - no other command answered, no Telegram poll ran. Async
// execFile keeps the loop turning; the 25s ceiling bounds one slow pool.
const execFileAsync = promisify(execFile)

export async function readQuota(): Promise<QuotaRead> {
  const script = quotaScriptPath()
  if (!script) return { ok: false, why: 'missing', detail: 'no fleet/quota.sh on this host' }
  try {
    const { stdout } = await execFileAsync('bash', [script, '--json'], {
      timeout: 25_000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    })
    return { ok: true, report: JSON.parse(String(stdout)) as QuotaReport }
  } catch (err) {
    // A timeout kill arrives as killed=true (child_process sends SIGTERM), not as
    // an error code. Anything else is a real failure: bad bash, bad JSON, crash.
    const e = err as { killed?: boolean; signal?: string; code?: unknown }
    const timedOut = e?.killed === true || e?.signal === 'SIGTERM' || e?.code === 'ETIMEDOUT'
    process.stderr.write(`kushbot: quota.sh ${timedOut ? 'timed out' : 'failed'}: ${err}\n`)
    return timedOut
      ? { ok: false, why: 'timeout', detail: 'quota.sh did not answer in 25s' }
      : { ok: false, why: 'failed', detail: String(err) }
  }
}

function ageStr(s: number | null): string {
  if (s == null || s <= 0) return 'live'
  if (s < 3600) return `${Math.floor(s / 60)}m old`
  if (s < 172800) return `${Math.floor(s / 3600)}h old`
  return `${Math.floor(s / 86400)}d old`
}

// seconds -> "1h 0m" / "45m" / "2d 4h". Same vocabulary as quota.sh's dur(), so
// the CLI and the bot never describe the same window two different ways.
function durStr(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  if (s >= 172800) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 60)}m`
}

// quota.sh's ist() stamps every timestamp with " IST"; the header already says
// IST once, so strip the repetition off the per-pool lines.
function istShort(s: string): string { return s.replace(/\s*IST$/, '') }

// PHONE-FIRST. One long line per pool with " · " separators wraps mid-number on
// a phone, which makes /quota unreadable exactly where it is read. So: one block
// per pool, two short lines each, and "used" spelled out after EVERY percent - a
// bare "100%" is ambiguous between spent and remaining.
export async function renderQuota(): Promise<string> {
  const read = await readQuota()
  if (!read.ok) {
    const why = read.why === 'missing'
      ? 'quota.sh is not installed on this host.'
      : read.why === 'timeout'
      ? 'quota.sh did not answer in 25s: a live probe is hanging (network, or an expired token).'
      : 'quota.sh could not be run. Check the pane for the error.'
    return `<b>Quota</b>\n<i>${esc(why)}</i>`
  }
  const rep = read.report

  const hhmm = new Date(rep.now * 1000).toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  })

  const risky = rep.pools.filter(p => p.at_risk)
  const lines: string[] = [`<b>Quota</b> · ${esc(rep.host)} · ${esc(hhmm)} IST`]

  for (const p of rep.pools) {
    lines.push('')
    const head = `${p.at_risk ? '⚠️ ' : ''}<b>${esc(p.pool)}</b>`

    if (p.five_pct == null && p.weekly_pct == null) {
      lines.push(head)
      lines.push(`<i>${esc(p.note || p.risk_reason || 'unavailable')}</i>`)
      continue
    }

    // Line 1: the pool name carries the 5h burst cap, as time-left (a 5h window
    // rolling over costs nothing, so an absolute reset time is noise here).
    const five = p.five_pct == null
      ? 'no 5h window'
      : `5h ${p.five_pct}% used` +
        (p.five_reset != null ? `, resets in ${durStr(p.five_reset - rep.now)}` : '')
    lines.push(`${head} ${esc(five)}`)

    // Line 2: the weekly budget, as an absolute IST stamp - this is the deadline
    // money actually expires against, so he needs the day and the clock time.
    const week = p.weekly_pct == null
      ? 'weekly unknown'
      : `weekly ${p.weekly_pct}% used` +
        (p.weekly_reset_ist ? `, resets ${istShort(p.weekly_reset_ist)}` : '')
    lines.push(esc(week))

    // Line 3, only when there is something to say: the risk reason for a flagged
    // pool, otherwise a stale/degraded-source note in italics.
    if (p.at_risk && p.risk_reason) {
      lines.push(esc(p.risk_reason))
    } else {
      // risk_reason carries the stale explanation when at_risk is false; it
      // already states the age, so don't print the age twice.
      const stale = p.risk_reason.startsWith('stale')
      const notes = [
        p.note,
        p.risk_reason,
        !stale && p.age_s != null && p.age_s >= 3600 ? `${p.source} reading ${ageStr(p.age_s)}` : '',
      ].filter(Boolean)
      if (notes.length) lines.push(`<i>${esc(notes.join('; '))}</i>`)
    }
  }

  lines.push('')
  if (risky.length) {
    lines.push(
      `⚠️ ${esc(risky.map(p => p.pool).join(', '))} will waste the week. ` +
      `Park work onto <code>~/monorepo/team/parked-work.md</code>`)
  } else {
    lines.push('<i>No pool on track to waste its week.</i>')
  }

  const detail = rep.pools.map(p => {
    const bits = [
      `source ${p.source} (${ageStr(p.age_s)})`,
      p.five_reset_ist ? `5h resets ${p.five_reset_ist}` : null,
      p.hours_left != null ? `${p.hours_left}h to weekly reset` : null,
      p.weekly_remaining_pct != null ? `${p.weekly_remaining_pct}% weekly unspent` : null,
      p.windows_left != null ? `${p.windows_left} x 5h windows left` : null,
      p.note || null,
      !p.at_risk && p.risk_reason ? p.risk_reason : null,
    ].filter(Boolean)
    return `${p.pool}: ${bits.join(' · ')}`
  }).join('\n')

  lines.push('')
  lines.push(`<blockquote expandable>${esc(detail)}</blockquote>`)
  return lines.join('\n')
}
