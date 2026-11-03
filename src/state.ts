// ---------------------------------------------------------------------------
// Mutable binding state — the one place the running bot's identity lives.
// ---------------------------------------------------------------------------
// WHY AN OBJECT AND NOT `export let`:
//
// ESM gives importers a read-only *view* of a `let` export. `import { currentBot }
// from './state'; currentBot = bot` is a TypeError at runtime — and only when the
// assignment actually executes. Every writer here lives on a cold path (attach,
// detachInternal, connectBroker's close handler, the deliver path in
// handleInbound), so the failure would not appear at boot, or in a smoke test, or
// in the first hour of traffic. It would appear on the first detach in production.
//
// Property writes on a shared object are legal from any module and reads are
// always current. The property names are deliberately unchanged from the
// single-file version so the migration was a mechanical `x` -> `state.x`.
//
// Invariant: this module holds state, never behavior. No imports beyond types, no
// timers, no I/O — the deadman nudge that reads these fields is registered from
// server.ts's wiring block, not here.
import type { Bot } from 'grammy'
import type { Socket } from 'net'

export const state = {
  // --- bot binding (written by attach / detachInternal / connectBroker) ---
  currentSlot: null as number | null,
  currentToken: null as string | null,
  currentBot: null as Bot | null,
  currentBotUsername: '',
  currentBrokerSocket: null as Socket | null,   // broker-client mode only

  // Timestamp of the last inbound message actually DELIVERED to the session (set in
  // handleInbound's deliver path, not for gated/dropped messages). /heartbeat #4.
  lastInboundAt: null as number | null,

  // Dead-man nudge state (2026-07-03 audit, roadmap item 6): if an inbound sits
  // unanswered for DEADMAN_MS while the session looks alive, tell the user once —
  // silence is otherwise ambiguous between "deep in work" and "wedged".
  lastInboundChatId: null as string | null,
  lastOutboundAt: null as number | null,
  nudgedForInboundAt: null as number | null,

  // A 👀 reaction on the inbound. Tracked SEPARATELY from lastOutboundAt so a
  // "seen it, working on it" ack is distinguishable from a real reply.
  reactedInboundAt: null as number | null,
}

export const DEADMAN_MS = 10 * 60 * 1000        // no ack at all      -> nudge
export const DEADMAN_ACKED_MS = 45 * 60 * 1000  // 👀 but still silent -> nudge

// The dead-man nudge body. Registered on an interval by server.ts's wiring block
// (never here — src/ modules don't start timers at import time).
//
// A 👀 DEFERS the nudge; it does not cancel it (the owner 2026-07-14: "if there was
// eye reaction - we dont get this headsup msg"). Cancelling outright would mean a
// wedge that happens AFTER the 👀 is never surfaced — which is precisely the
// failure the deadman exists to catch. So: acked => stay quiet for 45 min, not
// forever. A real reply (reply/edit, not a reaction) clears it for good.
export function deadmanTick(): void {
  const { currentBot, lastInboundAt, lastInboundChatId, lastOutboundAt, nudgedForInboundAt, reactedInboundAt } = state
  if (!currentBot || lastInboundAt == null || lastInboundChatId == null) return
  if (lastOutboundAt != null && lastOutboundAt >= lastInboundAt) return   // real reply went out
  if (nudgedForInboundAt === lastInboundAt) return                        // already nudged once

  const acked = reactedInboundAt != null && reactedInboundAt >= lastInboundAt
  const patience = acked ? DEADMAN_ACKED_MS : DEADMAN_MS
  if (Date.now() - lastInboundAt < patience) return

  state.nudgedForInboundAt = lastInboundAt
  const msg = acked
    ? '⏳ Still on your message from 45+ min ago — it was acknowledged (👀) but no reply has gone out. Could be deep work, could be a wedge. /heartbeat to check, /stop to interrupt.'
    : '⏳ Heads-up: your message was delivered to the session 10+ min ago and no reply has gone out yet. Could be deep work, could be a wedge — /heartbeat to check, /stop to interrupt.'
  void currentBot.api.sendMessage(lastInboundChatId, msg).catch(() => {})
}
