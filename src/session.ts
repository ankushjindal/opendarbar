// ---------------------------------------------------------------------------
// The live Claude session: how to find it, and how to drive its tmux pane.
// ---------------------------------------------------------------------------
// tmux send-keys is the ONLY mechanism that actually EXECUTES a slash command in
// the session. An MCP channel notification is delivered as literal chat text —
// the TUI never interprets it as a command. That asymmetry is why /compact and
// friends scrape a pane instead of riding the clean transport.
import { execSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Context } from 'grammy'
import { STATE, ONE_BOT, BOT_LABEL } from './config'
import { getClaudePid, resolveSession } from './store'
import { state } from './state'
import { shq, esc } from './text'

export function getSessionContext(): {
  claudePid: string
  tty: string
  cwd: string
  cwdShort: string
  resumeName: string | null
  agentName: string | null
  tmuxSession: string | null
} {
  const base = resolveSession(process.pid)
  let resumeName: string | null = null
  let agentName: string | null = null
  let tmuxSession: string | null = null

  if (base.claudePid !== '?') {
    try {
      const cmd = execSync(`ps -o command= -p ${base.claudePid}`).toString()
      // ps strips shell quoting, so `-r vc prep faq` arrives space-separated.
      // Capture until the next flag-like token (or EOL), not the first space —
      // and require the value not to start with "-" (bare `-r` with no label).
      const r = cmd.match(/(?:^| )(?:-r|--resume)[ =]((?![-\s])[^\n]*?)(?=\s+-{1,2}[a-zA-Z]|\s*$)/)
      if (r) resumeName = r[1].trim()
      const a = cmd.match(/--agent ([^ ]+)/)
      if (a) agentName = a[1]
    } catch {}
    try {
      // Map every tmux pane to {session_name, pane_pid}, then walk claude's
      // ancestor chain until a pid matches a pane_pid — that pane's session
      // owns this claude process.
      const lines = execSync(`tmux list-panes -a -F '#{session_name} #{pane_pid}' 2>/dev/null`)
        .toString().trim().split('\n').filter(Boolean)
      const paneMap = new Map<number, string>()
      for (const line of lines) {
        const [name, pidStr] = line.split(' ')
        const pid = parseInt(pidStr, 10)
        if (Number.isFinite(pid)) paneMap.set(pid, name)
      }
      let p = parseInt(base.claudePid, 10)
      for (let i = 0; i < 10 && Number.isFinite(p) && p > 1; i++) {
        if (paneMap.has(p)) { tmuxSession = paneMap.get(p) ?? null; break }
        try {
          p = parseInt(execSync(`ps -o ppid= -p ${p}`).toString().trim(), 10)
        } catch { break }
      }
    } catch {}
  }

  const cwdShort = base.cwd === '?'
    ? '?'
    : base.cwd.replace(process.env.HOME ?? '', '~')

  return { ...base, cwdShort, resumeName, agentName, tmuxSession }
}

// Drive the live Claude TUI by typing text + Enter into its tmux pane. This is
// the ONLY mechanism that actually EXECUTES a slash command (an MCP channel
// notification is treated as literal chat text, not a command). Returns false
// when this session isn't running inside tmux, or if send-keys throws.
export function sendKeysToSession(text: string): boolean {
  const { tmuxSession } = getSessionContext()
  if (!tmuxSession) return false
  try {
    // Text and Enter are sent as two separate keystroke batches with a beat
    // between them. Sending them in ONE call races the TUI's input commit:
    // Enter can land before the pasted text registers, submitting an empty
    // line and stranding the text unsubmitted in the input box (observed
    // live 2026-07-03 during the rishi/pulse revival smoke test).
    execSync(`tmux send-keys -t ${shq(tmuxSession)} ${shq(text)}`)
    execSync('sleep 0.3')
    execSync(`tmux send-keys -t ${shq(tmuxSession)} Enter`)
    return true
  } catch {
    return false
  }
}

// Poll the session's tmux pane for success/failure patterns after injecting a
// command — the anti-false-success primitive (generalizes the /model verify
// fix 23551ff; audit 2026-07-03 found 8 more optimistic surfaces).
// Returns 'ok' | 'fail' | 'unknown' plus the matched line for error context.
export async function verifyPane(
  successRx: RegExp[] | null,
  failureRx: Array<[RegExp, string]>,
  timeoutMs = 5000,
): Promise<{ verdict: 'ok' | 'fail' | 'unknown'; line: string }> {
  const { tmuxSession } = getSessionContext()
  if (!tmuxSession) return { verdict: 'unknown', line: 'not in tmux' }
  const sleepP = (ms: number) => new Promise(r => setTimeout(r, ms))
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleepP(500)
    let pane = ''
    try { pane = execSync(`tmux capture-pane -t ${shq(tmuxSession)} -p -J -S -30`).toString() } catch { continue }
    for (const [rx, tag] of failureRx) {
      if (rx.test(pane)) {
        const line = pane.split('\n').find(l => rx.test(l))?.trim().slice(0, 200) || tag
        return { verdict: 'fail', line }
      }
    }
    if (successRx && successRx.some(rx => rx.test(pane))) return { verdict: 'ok', line: '' }
  }
  return { verdict: 'unknown', line: '' }
}

// Failure patterns common to any injected slash command: the command echoed
// back as literal prompt text (TUI wasn't at the input line), auth walls, or
// an "Unknown command" complaint.
export const INJECT_FAILURES: Array<[RegExp, string]> = [
  [/Unknown (slash )?command/i, 'unknown command'],
  [/Please run \/login/i, 'needs /login'],
  [/Invalid authentication credentials/i, '401 — needs /login'],
]

// Inject a slash command into the TUI, then VERIFY from the pane instead of
// optimistically claiming success (the /compact "fire-and-forget lie" class).
//
// 2026-07-07 kai3 incident hardening: injecting into a MID-TURN session races
// the stream — the text lands in the input box but the Enter gets swallowed,
// leaving the command typed-but-never-submitted ("❯ /compact" sitting in the
// input while verify reports "inconclusive"). Now: (1) if the session is busy,
// WAIT for idle (up to 3 min) before typing; (2) after Enter, check the input
// box — if the command is still sitting there, re-send Enter (up to 3×);
// (3) report what actually happened, never "inconclusive" for a visible state.
export async function runInjectVerified(ctx: Context, name: string, slash: string): Promise<void> {
  const { tmuxSession } = getSessionContext()
  if (!tmuxSession) {
    await ctx.reply(`This session isn't running in tmux, so I can't run ${slash} remotely.`).catch(() => {})
    return
  }
  const sleepP = (ms: number) => new Promise(r => setTimeout(r, ms))
  const paneTail = (rows = 30) => {
    try { return execSync(`tmux capture-pane -t ${shq(tmuxSession)} -p -J -S -${rows}`).toString() } catch { return '' }
  }
  const busy = () => /esc to interrupt/i.test(paneTail(15))

  if (busy()) {
    await ctx.reply(`Session is mid-turn — waiting for the turn to finish, then running ${slash}. I'll confirm here.`).catch(() => {})
    const idleDeadline = Date.now() + 180_000
    while (Date.now() < idleDeadline && busy()) await sleepP(3000)
    if (busy()) {
      await ctx.reply(`⏸ Still mid-turn after 3 min — ${slash} NOT injected (typing into a running turn loses the keystroke). Send it again when the turn ends, or /stop first to interrupt.`).catch(() => {})
      return
    }
    await sleepP(1500)   // let the TUI settle at the prompt before typing
  }

  const ok = sendKeysToSession(slash)
  if (!ok) {
    await ctx.reply(`This session isn't running in tmux, so I can't run ${slash} remotely.`).catch(() => {})
    return
  }

  // Submission check: the unsubmitted input box renders "❯ <slash> ..." in the
  // bottom rows of the pane. If it's still sitting there, the Enter was eaten —
  // re-send it. (Bottom-rows restriction avoids matching queued-message echoes
  // higher up, which also render with a ❯.)
  const sittingRx = new RegExp('❯\\s*' + slash.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
  for (let i = 0; i < 3; i++) {
    await sleepP(1200)
    if (!sittingRx.test(paneTail(8))) break
    try { execSync(`tmux send-keys -t ${shq(tmuxSession)} Enter`) } catch {}
  }

  const successByName: Record<string, RegExp[]> = {
    compact: [/compact(ed|ing)/i, /Context (compacted|low)/i],
    clear: [/cleared/i, /new session/i],
    reload: [/reload(ed|ing)/i, /plugins? .*loaded/i],
  }
  const { verdict, line } = await verifyPane(successByName[name] ?? null, INJECT_FAILURES, 6000)
  let msg: string
  if (verdict === 'fail') msg = `⚠️ ${slash} rejected: ${line}`
  else if (verdict === 'ok') msg = `✅ ${slash} ran.`
  else if (sittingRx.test(paneTail(8))) msg = `⚠️ ${slash} is typed but NOT submitting (input box still shows it after 3 Enter retries) — the session may be in a dialog. Check /status or the terminal.`
  else if (busy()) msg = `⏳ ${slash} submitted — the session picked up work; if a turn was queued ahead of it, ${slash} runs when that turn ends.`
  else msg = `Sent ${slash} — no error visible in the pane after 6s (verification inconclusive; it may still be working).`
  await ctx.reply(msg).catch(() => {})
}

// Send a raw tmux key (a key NAME like "Escape" / "C-c", NOT literal text + Enter).
// Used by /stop to interrupt the live Claude TUI (ESC = interrupt current turn).
// Key is allowlisted so we never shell-inject an arbitrary string.
export const RAW_KEYS: Record<string, string> = { Escape: 'Escape', 'C-c': 'C-c' }
export function sendRawKey(key: string): boolean {
  const k = RAW_KEYS[key]
  if (!k) return false
  const { tmuxSession } = getSessionContext()
  if (!tmuxSession) return false
  try {
    execSync(`tmux send-keys -t ${shq(tmuxSession)} ${k}`)
    return true
  } catch {
    return false
  }
}

export function buildCliCommand(): string {
  const ctx = getSessionContext()
  const sess = readSessionJson() ?? {}
  const sessionId = typeof sess.sessionId === 'string' ? sess.sessionId : null
  const machine = STATE.machine
  const tmux = ctx.tmuxSession
  const cwd = ctx.cwd && ctx.cwd !== '?' ? ctx.cwd : null

  // resume target: prefer the bare session id (no quoting); fall back to the
  // resume name (single-quoted — names can have spaces).
  let resumeArg: string | null = null
  if (sessionId) resumeArg = sessionId
  else if (ctx.resumeName) resumeArg = shq(ctx.resumeName)
  const resumeCmd = resumeArg
    ? `${cwd ? `cd ${cwd} && ` : ''}claude --resume ${resumeArg}`
    : null

  const lines: string[] = []
  if (machine === 'mac') {
    lines.push(`<b>Jump into this session</b>`)
    lines.push(`machine: mac (local)`)
    lines.push('')
    if (tmux) {
      lines.push(`<code>tmux attach -t ${esc(tmux)}</code>`)
    }
    if (resumeCmd) {
      lines.push('')
      lines.push(`if not in tmux:`)
      lines.push(`<code>${esc(resumeCmd)}</code>`)
    }
    if (!tmux && !resumeCmd) {
      lines.push(`Could not derive an attach target (pid ${esc(ctx.claudePid)}, tty ${esc(ctx.tty)}).`)
    }
  } else {
    // server (and any non-mac): hop in over ssrv first.
    lines.push(`<b>Jump into this session</b>`)
    lines.push(`machine: ${esc(machine)} (remote — hop first)`)
    lines.push('')
    if (tmux) {
      lines.push(`<code>ssrv -t 'tmux attach -t ${esc(tmux)}'</code>`)
      lines.push('')
      lines.push(`or step by step:`)
      lines.push(`<code>ssrv</code>`)
      lines.push(`<code>tmux attach -t ${esc(tmux)}</code>`)
    }
    if (resumeCmd) {
      lines.push('')
      lines.push(`if not in tmux:`)
      lines.push(`<code>ssrv -t ${esc(shq(resumeCmd))}</code>`)
    }
    if (!tmux && !resumeCmd) {
      lines.push(`Could not derive an attach target (pid ${esc(ctx.claudePid)}, tty ${esc(ctx.tty)}).`)
    }
  }

  // footer
  const foot = `cwd: ${esc(ctx.cwdShort)}  ·  pid: ${esc(ctx.claudePid)}  ·  tty: ${esc(ctx.tty)}`
  lines.push('')
  lines.push(foot)
  if (sessionId) lines.push(`session id: ${esc(sessionId)}`)
  return lines.join('\n')
}

// Read the Claude session JSON the harness writes per-pid. Lives at
// ~/<home>/.claude/sessions/<pid>.json. Best-effort — every caller handles null.
export function readSessionJson(): Record<string, unknown> | null {
  const pid = getClaudePid()
  const path = join(homedir(), '.claude', 'sessions', `${pid}.json`)
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

// Best-effort cached auth email (the statusline writes this every 120s).
export function readAuthEmail(): string | null {
  try {
    const v = readFileSync('/tmp/.claude_auth_cache', 'utf8').trim()
    return v || null
  } catch { return null }
}

// Statusline cache written by ~/.claude/statusline.zsh on every render (every
// few seconds while claude is alive). Keyed on claude's pid. Lets us surface
// model / ctx % / rate-limit data the bot process can't see directly.
export type StatusCache = {
  model?: string | null
  ctx_pct?: number | null
  ctx_size?: number | null
  five_h_pct?: number | null
  five_h_resets?: number | null
  seven_d_pct?: number | null
  seven_d_resets?: number | null
  agent?: string | null
  ts?: number | null
}
export function readStatusCache(sessionId: string | null | undefined): StatusCache | null {
  if (!sessionId) return null
  try {
    const raw = readFileSync(`/tmp/.claude_status_${sessionId}.json`, 'utf8')
    return JSON.parse(raw) as StatusCache
  } catch { return null }
}

