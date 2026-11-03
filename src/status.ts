// ---------------------------------------------------------------------------
// /status — model, context, rate limits, cwd. Read-only, costs no turn.
// ---------------------------------------------------------------------------
// Reads the statusline cache (/tmp/.claude_status_<sid>.json) that Claude Code
// writes per session, so the numbers here match what the TUI shows without
// asking the model anything.
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { STATE, SINGLE, BROKER_CLIENT, ONE_BOT, BOT_LABEL } from './config'
import { state } from './state'
import { getClaudePid } from './store'
import { esc, fmtAge } from './text'
import { getSessionContext, readSessionJson, readAuthEmail, readStatusCache, type StatusCache } from './session'
import { effortForHome } from './fleet'
import { fmtSelfAccount, resolveSelfAccount } from './accounts'

export function fmtCtxSize(size: number): string {
  if (size >= 1_000_000) return `${Math.floor(size / 1_000_000)}m`
  if (size >= 1_000) return `${Math.floor(size / 1_000)}k`
  return String(size)
}

export function fmtFiveHourReset(resetsAt: number): string {
  const secsLeft = Math.max(0, resetsAt - Math.floor(Date.now() / 1000))
  // Match statusline rounding: 15-min buckets.
  const minsLeft = Math.floor((secsLeft + 450) / 900) * 15
  const hrs = Math.floor(minsLeft / 60)
  const mins = minsLeft % 60
  if (hrs === 0) return `${mins}m`
  if (mins === 0) return `${hrs}h`
  return `${hrs}:${String(mins).padStart(2, '0')}h`
}

export function fmtSevenDayReset(resetsAt: number): string {
  const now = Math.floor(Date.now() / 1000)
  const wkElapsed = Math.max(0, Math.min(100, Math.floor((now - (resetsAt - 604800)) * 100 / 604800)))
  return `${wkElapsed}%`
}

// Render a TUI-equivalent /status block for Telegram. Model / ctx % / rate
// limits are pulled from the statusline cache (out-of-band — bot process can't
// see them directly); fields without cache data render as "—".
export function renderStatus(): string {
  const ctx = getSessionContext()
  const sess = readSessionJson() ?? {}
  const sessionId = typeof sess.sessionId === 'string' ? sess.sessionId : '—'
  const cache = readStatusCache(sessionId !== '—' ? sessionId : null) ?? {}
  const sessAgent = typeof sess.agent === 'string' ? sess.agent : null
  const agent = sessAgent ?? (typeof cache.agent === 'string' && cache.agent ? cache.agent : (process.env.CLAUDE_CODE_AGENT || '—'))
  const version = typeof sess.version === 'string' ? sess.version : '—'
  const sessName = typeof sess.name === 'string' ? sess.name : null
  const email = readAuthEmail() ?? '—'
  const acct = resolveSelfAccount()
  // `acct.email ?? email` printed an EMPTY line for every token session: the
  // statusline writes email:"" when the label came from the token hash (there is
  // no email to be had under an injected OAT), and "" is present as far as ??
  // is concerned. First non-blank wins, then the placeholder.
  const acctEmail = [acct.email, email]
    .map(v => (typeof v === 'string' ? v.trim() : ''))
    .find(v => v.length > 0) ?? '(token session, no email)'
  const botLabel = BOT_LABEL || '—'
  const botUser = state.currentBotUsername ? `@${state.currentBotUsername}` : '—'
  const mode = STATE.mode
  const machine = STATE.machine

  const statusEffort = effortForHome(homedir())
  const modelLine = `model:       ${cache.model ?? '—'}${statusEffort ? ` · effort: ${statusEffort}` : ''}`
  const ctxLine = (cache.ctx_pct != null)
    ? `ctx:         ${Math.round(cache.ctx_pct)}% / ${cache.ctx_size ? fmtCtxSize(cache.ctx_size) : '—'}`
    : `ctx:         — / —`
  const fiveHLine = (cache.five_h_pct != null)
    ? `5h limit:    ${Math.round(cache.five_h_pct)}%${cache.five_h_resets ? ` (resets in ${fmtFiveHourReset(cache.five_h_resets)})` : ''}`
    : `5h limit:    —`
  const sevenDLine = (cache.seven_d_pct != null)
    ? `7d limit:    ${Math.round(cache.seven_d_pct)}%${cache.seven_d_resets ? ` (week ${fmtSevenDayReset(cache.seven_d_resets)} elapsed)` : ''}`
    : `7d limit:    —`

  const lines = [
    `<b>Claude session</b>`,
    modelLine,
    ctxLine,
    fiveHLine,
    sevenDLine,
    ``,
    `<b>Session</b>`,
    `id:          ${sessionId}`,
    `agent:       ${agent}`,
    ...(sessName ? [`name:        ${sessName}`] : []),
    `version:     ${version}`,
    `cwd:         ${ctx.cwdShort}`,
    `pid:         ${ctx.claudePid} (tty ${ctx.tty})`,
    `tmux:        ${ctx.tmuxSession ?? '—'}`,
    ``,
    `<b>Bot</b>`,
    `label:       ${botLabel}`,
    `username:    ${botUser}`,
    `machine:     ${machine}`,
    `mode:        ${mode}`,
    ``,
    `<b>Account</b>`,
    `account:     ${acct.label ?? '— (file grant / unknown)'}`,
    `email:       ${acctEmail}`,
    ``,
    `<b>MCP</b>`,
    `kushbot:     connected (this bot)`,
    `others:      — (not visible from bot process)`,
  ]
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Shared small helpers (tmux drive, HTML escape, formatting)
// ---------------------------------------------------------------------------

// Single-quote a string for safe use in a /bin/sh command line. Wraps in '…'
// and escapes any embedded single-quote as the classic '\'' sequence.
