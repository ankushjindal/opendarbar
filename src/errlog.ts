// ---------------------------------------------------------------------------
// stderr ring buffer + boot-parent pid (powers /heartbeat checks #9 and #2)
// ---------------------------------------------------------------------------
// We have no log file, so the only way /heartbeat can surface recent 409/flap/
// reconnect noise is to tee process.stderr.write into a bounded in-memory ring.
// The tee is try/catch-wrapped and always returns the original write's boolean
// (so backpressure semantics are preserved).
//
// IMPORT ORDER IS LOAD-BEARING: this module installs the tee as an import-time
// side effect, so it MUST be the first import in server.ts. Anything imported
// earlier that writes to stderr during its own module init would bypass the ring
// and be invisible to /heartbeat. This is the ONE module allowed a side effect at
// import time (config's loadState() read is the other); everything else in src/
// registers its timers and handlers from server.ts's explicit wiring block.
const ERR_RING_MAX = 40
const errRing: { ts: number; line: string }[] = []
const _origStderrWrite = process.stderr.write.bind(process.stderr)
;(process.stderr as any).write = (chunk: any, ...rest: any[]): boolean => {
  try {
    const s = typeof chunk === 'string' ? chunk : chunk?.toString?.() ?? ''
    for (const ln of s.split('\n')) { const t = ln.trim(); if (t) errRing.push({ ts: Date.now(), line: t }) }
    while (errRing.length > ERR_RING_MAX) errRing.shift()
  } catch {}
  return (_origStderrWrite as any)(chunk, ...rest)   // always return original's boolean (backpressure)
}

export function recentErrorLines(windowMs = 600_000) {
  const cut = Date.now() - windowMs
  return errRing.filter(e => e.ts >= cut && /error|fail|conflict|409|exception|rejection|stale|orphan|retry/i.test(e.line))
}

// The pid of our parent at boot (the claude session that spawned us). The orphan
// watchdog in server.ts probes it with signal 0; /heartbeat reuses it too.
export const bootPpid = process.ppid
