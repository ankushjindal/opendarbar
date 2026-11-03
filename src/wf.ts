// ---------------------------------------------------------------------------
// /wf — live view of a running Workflow (the Workflow tool's subagent fan-out).
// ---------------------------------------------------------------------------
// Read-only over the workflow journal on disk. Pure render; server.ts owns the
// edit loop that keeps the Telegram message updating in place.
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { esc } from './text'

// ---------------------------------------------------------------------------
// /wf — live view of the running Workflow (the Workflow tool's subagent fan-out)
//
// Claude Code persists each workflow run's live state to
//   ~/.claude/projects/<proj>/<session>/workflows/wf_<runId>.json
// rewritten in place as the run progresses. `workflowProgress[]` is a flat list
// of {type:'workflow_phase'} + {type:'workflow_agent', phaseIndex, state, ...}
// entries — enough to reconstruct phases, per-phase agent counts, and each
// agent's state (done/error/running/queued). We poll the file and edit a single
// Telegram message in place (no notification spam) until the run is terminal.
// ---------------------------------------------------------------------------

export const WF_TERMINAL = new Set(['completed', 'failed', 'killed'])
export const WF_FRESH_MS = 5 * 60 * 1000     // non-terminal + mtime within this = actually live
export const WF_POLL_MS = 4000               // edit cadence
export const WF_MAX_MS = 30 * 60 * 1000      // safety cap on the auto-update loop

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60), rs = s % 60
  if (m < 60) return rs ? `${m}m${rs}s` : `${m}m`
  const h = Math.floor(m / 60), rm = m % 60
  return rm ? `${h}h${rm}m` : `${h}h`
}
export function fmtNum(n: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}

// Workflow state lives in TWO layouts depending on Claude Code version:
//   legacy  <sess>/workflows/wf_<id>.json           (full progress json, rewritten in place)
//   journal <sess>/subagents/workflows/wf_<id>/     (journal.jsonl + agent-*.jsonl; NO json)
// 2026-07-07 bug: the current harness stopped writing wf_*.json entirely, so
// /wf kept finding days-old legacy files and showed "the old workflow" while a
// live run was on the new layout. Scan both; synthesize state for journal runs.
export type WfRun =
  | { kind: 'legacy'; path: string; mtime: number }
  | { kind: 'journal'; dir: string; runId: string; sessDir: string; mtime: number }

export function listWorkflowRuns(): WfRun[] {
  const root = join(homedir(), '.claude', 'projects')
  const out: WfRun[] = []
  let projects: string[] = []
  try { projects = readdirSync(root) } catch { return out }
  for (const proj of projects) {
    let sessions: string[] = []
    try { sessions = readdirSync(join(root, proj)) } catch { continue }
    for (const sess of sessions) {
      const sessDir = join(root, proj, sess)
      try {
        for (const f of readdirSync(join(sessDir, 'workflows'))) {
          if (f.startsWith('wf_') && f.endsWith('.json')) {
            const p = join(sessDir, 'workflows', f)
            try { out.push({ kind: 'legacy', path: p, mtime: statSync(p).mtimeMs }) } catch {}
          }
        }
      } catch {}
      try {
        const wroot = join(sessDir, 'subagents', 'workflows')
        for (const d of readdirSync(wroot)) {
          if (!d.startsWith('wf_')) continue
          const jr = join(wroot, d, 'journal.jsonl')
          try { out.push({ kind: 'journal', dir: join(wroot, d), runId: d, sessDir, mtime: journalRunMtime(join(wroot, d)) }) } catch {}
          void jr
        }
      } catch {}
    }
  }
  return out
}

// Freshest write anywhere in a journal-layout run dir (journal appends on
// start/result only; agent transcripts append constantly while running).
export function journalRunMtime(dir: string): number {
  let m = 0
  for (const f of readdirSync(dir)) {
    try { m = Math.max(m, statSync(join(dir, f)).mtimeMs) } catch {}
  }
  return m
}

export type JournalWfState = {
  name: string; desc: string; phaseTitles: string[]
  started: number; done: number; inflight: number
  startMs: number; lastMs: number; running: boolean; quietMs: number
}

// Synthesize live state for a journal-layout run: done/in-flight from the
// journal, liveness from transcript mtimes, name/description/phases from the
// persisted script (<sess>/workflows/scripts/<name>-<runId>.js).
export function journalWfState(run: Extract<WfRun, { kind: 'journal' }>): JournalWfState | null {
  let lines: string[] = []
  try { lines = readFileSync(join(run.dir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean) } catch { return null }
  const startedIds = new Set<string>(), doneIds = new Set<string>()
  for (const ln of lines) {
    try {
      const e = JSON.parse(ln)
      if (e.type === 'started' && e.agentId) startedIds.add(String(e.agentId))
      else if (e.type === 'result' && e.agentId) doneIds.add(String(e.agentId))
    } catch {}
  }
  // script → name/desc/phases; also our best startMs (written at launch)
  let name = run.runId, desc = '', phaseTitles: string[] = [], startMs = 0
  try {
    const sdir = join(run.sessDir, 'workflows', 'scripts')
    const sf = readdirSync(sdir).find(f => f.endsWith(`${run.runId}.js`) || f.endsWith(`${run.runId.replace(/^wf_/, '')}.js`))
    if (sf) {
      startMs = statSync(join(sdir, sf)).mtimeMs
      const src = readFileSync(join(sdir, sf), 'utf8').slice(0, 4000)
      name = /name:\s*['"]([^'"]+)['"]/.exec(src)?.[1] ?? sf.replace(/-wf_.*$/, '')
      desc = /description:\s*['"]([^'"]+)['"]/.exec(src)?.[1] ?? ''
      const pb = /phases:\s*\[([\s\S]*?)\]/.exec(src)?.[1] ?? ''
      phaseTitles = [...pb.matchAll(/title:\s*['"]([^'"]+)['"]/g)].map(m => m[1])
    }
  } catch {}
  const lastMs = run.mtime
  if (!startMs) startMs = lastMs
  const inflight = [...startedIds].filter(id => !doneIds.has(id)).length
  const quietMs = Date.now() - lastMs
  // Running = work in flight and recent writes; a run with nothing in flight
  // that went quiet is finished; in-flight but long-quiet = stalled/killed.
  const running = inflight > 0 ? quietMs < WF_FRESH_MS : quietMs < 90_000
  return { name, desc, phaseTitles, started: startedIds.size, done: doneIds.size, inflight, startMs, lastMs, running, quietMs }
}

// Newest workflow across all sessions and BOTH layouts, preferring a live one.
export type FoundWf =
  | { kind: 'legacy'; data: any; path: string; running: boolean }
  | { kind: 'journal'; state: JournalWfState; run: Extract<WfRun, { kind: 'journal' }>; running: boolean }
export function findActiveWorkflow(): FoundWf | null {
  const runs = listWorkflowRuns().sort((a, b) => b.mtime - a.mtime)
  if (!runs.length) return null
  let newest: FoundWf | null = null
  for (const r of runs.slice(0, 12)) {
    if (r.kind === 'legacy') {
      let data: any
      try { data = JSON.parse(readFileSync(r.path, 'utf8')) } catch { continue }
      const live = !WF_TERMINAL.has(String(data.status)) && (Date.now() - r.mtime < WF_FRESH_MS)
      if (live) return { kind: 'legacy', data, path: r.path, running: true }
      if (!newest) newest = { kind: 'legacy', data, path: r.path, running: false }
    } else {
      const state = journalWfState(r)
      if (!state) continue
      if (state.running) return { kind: 'journal', state, run: r, running: true }
      if (!newest) newest = { kind: 'journal', state, run: r, running: false }
    }
  }
  return newest
}

export type WfPhase = { title: string; done: number; running: number; err: number; queued: number; total: number }

export function wfBar(done: number, total: number, width = 8): string {
  if (total <= 0) return '▱'.repeat(width)
  const filled = Math.min(width, Math.round((done / total) * width))
  return '▰'.repeat(filled) + '▱'.repeat(width - filled)
}

export function renderWorkflow(data: any): string {
  const name = esc(String(data.workflowName || data.runId || 'workflow'))
  const status = String(data.status || 'running')
  const emoji = status === 'completed' ? '✅' : status === 'failed' ? '❌'
    : status === 'killed' ? '🛑' : '⚙️'
  const wp: any[] = Array.isArray(data.workflowProgress) ? data.workflowProgress : []
  const titles = new Map<number, string>()
  for (const e of wp) if (e?.type === 'workflow_phase') titles.set(e.index, String(e.title ?? `Phase ${e.index}`))
  const phases = new Map<number, WfPhase>()
  for (const a of wp) {
    if (a?.type !== 'workflow_agent') continue
    const pi = Number(a.phaseIndex ?? 0)
    if (!phases.has(pi)) phases.set(pi, { title: String(a.phaseTitle || titles.get(pi) || `Phase ${pi}`), done: 0, running: 0, err: 0, queued: 0, total: 0 })
    const p = phases.get(pi)!
    p.total++
    const st = String(a.state)
    if (st === 'done') p.done++
    else if (st === 'error') p.err++
    else if (st === 'queued') p.queued++
    else p.running++ // start | progress
  }
  const tot = { done: 0, running: 0, err: 0, queued: 0 }
  for (const p of phases.values()) { tot.done += p.done; tot.running += p.running; tot.err += p.err; tot.queued += p.queued }

  const start = Number(data.startTime) || 0
  const elapsed = WF_TERMINAL.has(status) ? Number(data.durationMs || 0) : (start ? Date.now() - start : 0)
  const header = `${emoji} <b>${name}</b> · ${esc(status)} · ${fmtDur(elapsed)}`
  const meta = `${data.agentCount ?? tot.done + tot.running + tot.err + tot.queued} agents · ${fmtNum(Number(data.totalTokens || 0))} tok · ${fmtNum(Number(data.totalToolCalls || 0))} tools`

  const rows: string[] = []
  const ordered = [...phases.entries()].sort((a, b) => a[0] - b[0])
  for (const [, p] of ordered) {
    const tlabel = (p.title.length > 12 ? p.title.slice(0, 11) + '…' : p.title).padEnd(12)
    const mark = p.err ? `⚠${p.err}` : p.running ? `●${p.running}` : p.done === p.total && p.total ? '✓' : ''
    rows.push(`${tlabel} ${wfBar(p.done, p.total)} ${String(p.done)}/${p.total} ${mark}`.trimEnd())
  }
  const table = rows.length ? `<pre>${esc(rows.join('\n'))}</pre>` : '<i>no agents yet</i>'
  const footer = `✓ ${tot.done} done · ● ${tot.running} running · ⚠ ${tot.err} err · ${tot.queued} queued`
  return `${header}\n${meta}\n\n${table}\n${footer}`
}

// Journal-layout card. The journal doesn't carry per-phase progress or token
// counts (that data only exists in the running claude's memory), so this shows
// what IS reliably knowable: agent counts, liveness, phases from the script.
export function renderJournalWf(s: JournalWfState): string {
  const status = s.running ? 'running' : s.inflight > 0 ? 'stalled?' : 'finished'
  const emoji = s.running ? '⚙️' : s.inflight > 0 ? '⚠️' : '✅'
  const elapsed = (s.running ? Date.now() : s.lastMs) - s.startMs
  const header = `${emoji} <b>${esc(s.name)}</b> · ${status} · ${fmtDur(elapsed)}`
  const agents = `${s.started} agents started · ✓ ${s.done} done` + (s.inflight ? ` · ● ${s.inflight} in flight` : '')
  const phases = s.phaseTitles.length ? `\nphases: ${esc(s.phaseTitles.join(' → '))}` : ''
  const desc = s.desc ? `\n<i>${esc(s.desc.slice(0, 140))}</i>` : ''
  return `${header}\n${agents}${phases}${desc}`
}

