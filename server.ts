#!/usr/bin/env bun
/**
 * Kushbot — per-session Telegram bot remote control for Claude Code.
 *
 * Forked from claude-plugins-official/telegram@0.0.6. See UPSTREAM.md
 * (next to this file) for the source version and delta summary.
 *
 * The plugin starts dormant. From a session you ask Claude to call the
 * `attach` MCP tool: it picks a free slot from ~/.claude/channels/kushbots/,
 * reads that slot's bot token, instantiates a grammy Bot, registers handlers,
 * and starts polling. `detach()` reverses it. `current()` reports binding.
 *
 * Per-slot state lives at ~/.claude/channels/kushbots/slot{N}/ —
 *   .env             TELEGRAM_BOT_TOKEN=...
 *   access.json      allowlist + groups + pairing state
 *   approved/        drop-files from /telegram:access pair
 *   inbox/           downloaded attachments
 *   claimed_by.pid   set on attach, removed on detach / clean shutdown
 *
 * Auto-attach: setting `KUSHBOT_AUTO_ATTACH=<N>` in the environment causes
 * the server to self-call attach({slot:N}) once MCP is connected. That's
 * what the /spawn-attached-dc skill relies on.
 */

// errlog FIRST: it installs the stderr tee as an import-time side effect, so any
// module that writes to stderr during its own init must load after it.
import { recentErrorLines, bootPpid } from './src/errlog'
import { STATE, SINGLE, BROKER_CLIENT, ONE_BOT, BOT_LABEL, NO_POLL, QUIET_LIFECYCLE, CODEX_MODE, FAST_SHUTDOWN } from './src/config'
import { brokerSockPath, singleDir, KUSHBOTS_ROOT, fleetRootDir } from './src/paths'
import { DEFAULT_COMMANDS, INJECT_COMMANDS, resolveCommands, type SlashCommand } from './src/commands'
import { state, DEADMAN_MS, deadmanTick } from './src/state'
import { opsEvent, setBotStatusIcon, renderInspect } from './src/ops'
import { mcp, pendingPermissions, pendingAsks, multiAskKeyboard, savePending, loadPending, queuePermissionWhileDetached, flushPermissionQueue, queueInboundOnFailure, flushInboundQueue } from './src/mcp'
import { PERMISSION_REPLY_RE, opsRecipients, defaultAccess, readAccessFile, loadAccess, saveAccess, pruneExpired, assertSendable, assertAllowedChat, gate, isMentioned, checkApprovals, MAX_CHUNK_LIMIT, MAX_ATTACHMENT_BYTES, MEDIA_CAPTION_LIMIT, PHOTO_EXTS, VOICE_EXTS, AUDIO_EXTS, VIDEO_EXTS, type Access, type GateResult } from './src/access'
import { getSessionContext, sendKeysToSession, verifyPane, runInjectVerified, sendRawKey, buildCliCommand, INJECT_FAILURES, readSessionJson, readAuthEmail, readStatusCache, type StatusCache } from './src/session'
import { renderStatus } from './src/status'
import { findActiveWorkflow, renderWorkflow, renderJournalWf, listWorkflowRuns, journalWfState, journalRunMtime, fmtDur, fmtNum, WF_TERMINAL, WF_POLL_MS, WF_MAX_MS, type JournalWfState } from './src/wf'
import { listAccountLabels, switchableAccounts, resolveSelfAccount, fmtSelfAccount, selfAgentName, doAccountSwitch, renderAccountUsageLive, readAllStatusCaches, switchTokenPath } from './src/accounts'
import { quotaAllowed, renderQuota, QUOTA_DENIAL } from './src/quota'
import { runHeartbeat } from './src/heartbeat'
import { fleetSelf, fleetRegistry, newestSessionForHome, effortForHome, fleetAccountMap, fleetSend, fleetReceipts, checkFleetInbox, type FleetAgent } from './src/fleet'
import { slotDir, stateDir, slotEnvFile, slotAccessFile, slotApprovedDir, slotInboxDir, slotPidFile, listSlots, readSlotEnv, isPidAlive, isSlotClaimed, findFreeSlot, resolveSession, writeClaim, releaseClaim, STATUS_DIR, getClaudePid, statusFile, writeStatus, clearStatus } from './src/store'
import { findSmartCut, chunk, findUnclosedHtml, balanceChunks, safeName, resolveParseMode, resolveLinkPreview, shq, esc, fmtAge } from './src/text'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy'
import type { Message, ReactionTypeEmoji } from 'grammy/types'
import { randomBytes, createHash } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, renameSync, realpathSync, chmodSync, existsSync } from 'fs'
import { homedir, loadavg, freemem, totalmem, cpus } from 'os'
import { join, extname, sep, isAbsolute, basename } from 'path'
import { execSync, spawnSync } from 'child_process'
import { createConnection, type Socket } from 'net'

// ---------------------------------------------------------------------------
// Slot infra
// ---------------------------------------------------------------------------


// User-facing slash commands that every bot advertises in its Telegram menu and
// handles internally. /status renders a TUI-equivalent status block; /compact,
// /clear, /reload inject the corresponding slash command into the running Claude
// session via the same MCP channel notification path inbound messages use.
// ---------------------------------------------------------------------------
// Access (per-slot)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool list
// ---------------------------------------------------------------------------

// In NO_POLL (outbound-only) mode this instance SHARES a slot the inbound child
// owns. It must expose ONLY the outbound messaging tools — never the session/
// pool-management tools (attach/detach/current/pool_status/spawn/rename), which
// would let the sharer re-bind the slot away from the inbound poller. Env-gated:
// with NO_POLL unset the full tool set is returned exactly as before.
const NO_POLL_TOOL_ALLOWLIST = new Set([
  'reply', 'react', 'edit_message', 'ask', 'send_to_agent', 'download_attachment',
])
mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  const allTools = [
    {
      name: 'attach',
      description:
        'Bind a kushbot pool slot to this session and start polling Telegram. With no arguments picks the first free slot. Returns {slot, username} — relay the @username to the user. If a slot is already attached, this detaches it first.',
      inputSchema: {
        type: 'object',
        properties: {
          slot: { type: 'number', description: 'Specific slot number (1, 2, 3, …). Omit to auto-pick first free.' },
        },
      },
    },
    {
      name: 'detach',
      description: 'Stop polling and release the currently attached slot. No-op if dormant.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'current',
      description: 'Report the currently attached slot, or null if dormant. Returns {slot, username} or null.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'pool_status',
      description: 'Show live status of every kushbot slot — which are claimed, free, or stale, plus the claude session (pid, tty, cwd) owning each, and any tmux sessions spawned by `spawn`. Use when the user asks "what is attached", "kushbot status", "who owns slot X", etc.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'spawn',
      description: 'Spawn a new dc Claude Code session inside a detached tmux window with a kushbot slot pre-attached. Use when the user asks to "spawn a new dc with telegram", "start a separate dc for <thing>", "new sk-attached dc", etc. Returns the slot, tmux session name, and attach command. The new dc runs in the background; user attaches via `tmux attach -t kush<N>` when ready.',
      inputSchema: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Working directory. Relative paths resolve under ~/work/. Absolute paths are used as-is.' },
          slot: { type: 'number', description: 'Optional explicit slot number (1+; slot 0 is reserved for kc). Default: pick first free slot ≥1.' },
        },
        required: ['dir'],
      },
    },
    {
      name: 'reply',
      description:
        'Reply on Telegram. Pass chat_id from the inbound message. Either text or files (or both) must be supplied. ' +
        'files: absolute paths, routed by extension — .jpg/.png/.gif/.webp → photo (inline), .ogg/.opus/.oga → voice note (waveform UI), .mp3/.m4a/.aac/.flac/.wav → audio player (title/scrubber), .mp4/.mov/.webm/.m4v → video, anything else → generic document. ' +
        'If text is ≤1024 chars AND files are attached, the text rides along as the caption on the FIRST attachment (one notification, not two). Longer text sends as its own message(s) before the files. ' +
        'For rich text prefer format:"html" — supported tags: <b> <i> <u> <s> <code> <pre> <pre><code class="language-py"> <a href> <blockquote> <blockquote expandable> <tg-spoiler>. ' +
        "Escape & < > as &amp; &lt; &gt; in body text. Use <blockquote expandable> for long replies (collapses by default, taps to expand) — ideal for thinking blocks or verbose output. " +
        'Quote-anchoring: pass `quote` (must be an exact substring of the replied-to message) to visually anchor your reply to a specific phrase rather than the whole message — useful in long multi-question turns. Combine with `reply_to`.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          text: { type: 'string', description: 'Body text. Either text or files must be present. Up to 4096 chars as a message; ≤1024 chars rides as caption on first file when files are attached.' },
          reply_to: { type: 'string', description: 'Message ID to thread under.' },
          quote: { type: 'string', description: 'Substring of the replied-to message to anchor this reply to (visual quote bar in the TG client). MUST be an exact substring or TG rejects the send. Requires reply_to to be set. Max 1024 chars (TG limit). Ignored if reply_to is absent.' },
          quote_position: { type: 'number', description: 'Optional UTF-16 code-unit offset of `quote` in the target message. Omit if `quote` is unique enough that TG can find it on its own (recommended). Use only if the substring repeats in the target.' },
          quote_parse_mode: { type: 'string', enum: ['html', 'markdownv2'], description: 'Optional parse mode for `quote` if you want to anchor on rich-formatted text (e.g., a code span). Default plain.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths. Routed by extension to sendPhoto/sendVoice/sendAudio/sendVideo/sendDocument. Max 50MB each.' },
          format: { type: 'string', enum: ['text', 'html', 'markdownv2'], description: "Rendering mode. Default 'text'. 'html' is the most forgiving for rich output (only & < > need escaping in body text). Applies to both message text and the caption on the first attachment." },
          link_preview: { type: 'string', enum: ['default', 'disabled', 'above', 'below'], description: "URL preview behavior. 'default' (Telegram auto-previews first URL), 'disabled' (no preview — good for code/log output), 'above' or 'below' (force preview position)." },
        },
        required: ['chat_id'],
      },
    },
    {
      name: 'send_to_agent',
      description:
        'Send a message to ANOTHER fleet agent (agent-to-agent mail, not Telegram). The target\'s kushbot injects it into their session as an inbound turn and mirrors a copy to the owner\'s chat for transparency. Targets must exist in the fleet registry (see /peers). ADDRESS NAMES LITERALLY: when the user names a target ("ask kai"), use that EXACT registry name — "kai" is always the server parent (never kai-son/kai2/3/4, never kc, which is kush on the Mac). Do not reinterpret a named target through your own who-does-what priors; if the named target seems wrong, tell the user instead of rerouting (misroute incidents: munshi→kai-son, kai3→kc, 2026-07-07). Same-machine delivers in ~5s; cross-machine agents relay over tailscale (needs fleet-relay running on both machines). ' +
        'Loop rules: pass hops = (incoming hops + 1) when replying to an agent message; hops > 2 is rejected. Only reply when the incoming message has reply_expected=true or a reply is genuinely needed. Rate cap 10/hour per target. Body ≤ 4000 chars — send file paths, not file contents. ' +
        'Mirror control: quiet=true suppresses the owner\'s mirror ping for routine chatter (delivery and the audit trail are untouched); registry key quietMirrors sets per-pair defaults; priority="high" always mirrors.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Target agent name from the fleet registry (e.g. "munshi", "kai3").' },
          text: { type: 'string', description: 'Message body (≤4000 chars). Paths beat payloads.' },
          reply_expected: { type: 'boolean', description: 'Set true only if you need an answer back. Default false — recipient should NOT auto-reply.' },
          hops: { type: 'number', description: 'Conversation depth. 0 for a fresh thread (default); incoming hops + 1 when replying. Max 2.' },
          priority: { type: 'string', enum: ['normal', 'high'], description: 'high = flagged ❗ in the owner mirror, and ALWAYS mirrors (overrides every quiet setting). Default normal.' },
          quiet: { type: 'boolean', description: "Suppress the owner's Telegram mirror ping for this message (delivery, /outbox, inbox and receipts are unaffected). Omit to use the registry's quietMirrors default for this from>to pair; pass false to force a mirror on a pair that is quiet by default. Ignored when priority='high'. Use for routine agent↔agent chatter the owner did not ask to watch." },
        },
        required: ['to', 'text'],
      },
    },
    {
      name: 'react',
      description: 'Add an emoji reaction to a Telegram message. Telegram only accepts a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc).',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'string' },
          emoji: { type: 'string' },
        },
        required: ['chat_id', 'message_id', 'emoji'],
      },
    },
    {
      name: 'rename',
      description:
        "Rename this bot's Telegram display name (what the user sees in their chat list). The display name becomes EXACTLY the label you pass — just the subject, no bot-number prefix. Use a short label (2–4 words, ≤40 chars) that captures what this session is currently about. Telegram rate-limits name changes to a few per day per bot, so don't rename on every task switch.",
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: "Short focus label appended after the bot's base name (≤40 chars)." },
        },
        required: ['label'],
      },
    },
    {
      name: 'download_attachment',
      description: "Download a file attachment from a Telegram message to the current slot's inbox. Returns the local file path. Telegram caps bot downloads at 20MB.",
      inputSchema: {
        type: 'object',
        properties: { file_id: { type: 'string' } },
        required: ['file_id'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a message the bot previously sent. Useful for interim progress updates (does not push-notify). Same format/link_preview options as reply.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'string' },
          text: { type: 'string' },
          format: { type: 'string', enum: ['text', 'html', 'markdownv2'] },
          link_preview: { type: 'string', enum: ['default', 'disabled', 'above', 'below'] },
        },
        required: ['chat_id', 'message_id', 'text'],
      },
    },
    {
      name: 'ask',
      description:
        'Ask the user a question with tappable option buttons (Telegram inline keyboard). Non-blocking: returns immediately; when the user taps, the choice arrives as a normal inbound channel message of the form "[ask] <question> → <choice>". Use for quick decisions (2–10 short options) instead of free-text questions. Set multi:true for multi-select — the buttons become ☐/☑ toggles plus a Done button, and the answer arrives comma-separated ("→ a, c, d").',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          question: { type: 'string' },
          multi: {
            type: 'boolean',
            description: 'Multi-select: tapping toggles ☐/☑ instead of answering; the ask resolves when the user taps Done, delivering all picks comma-separated. Default false (first tap answers).',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '2–10 short option labels (≤60 chars each); one button per row',
          },
        },
        required: ['chat_id', 'question', 'options'],
      },
    },
  ]
  return { tools: NO_POLL ? allTools.filter(t => NO_POLL_TOOL_ALLOWLIST.has(t.name)) : allTools }
})

// ---------------------------------------------------------------------------
// attach / detach / current
// ---------------------------------------------------------------------------

// Pull semantic context about the calling claude session: what -r/--resume
// label it has, what --agent it loaded, what tmux session owns it (if any),
// plus the basics from resolveSession. Best-effort — every field gracefully
// degrades to null/"?" if its source command is missing.
// Send a "🟢 attached" / "🔴 detached" notice to every chat in the slot's
// allowFrom list. Best-effort — individual sends that fail are swallowed so
// they never break attach/detach itself.
// Planned-quiet-reload marker (fleet-ctl reload --soft writes it; expiry epoch
// in seconds inside). While valid it suppresses BOTH lifecycle notices — the
// operator asked for a silent bounce, so neither "going dark" nor "attached —
// listening" should ping him. 2026-07-07: --soft v1 only muted the watchdog;
// these bot-side notices still spammed every chat ×9 sons ×2 sweeps.
// Where a restart marker for THIS bot lives. Single-mode homes keep it in their
// channels dir; in pool mode the bots share one home, so it has to be per slot
// or a switch on slot 4 would silence (and confirm to) slot 1. Falls back to the
// old shared path only while nothing is attached yet.
function markerFile(name: string): string {
  if (!ONE_BOT && state.currentSlot != null) return join(slotDir(state.currentSlot), name)
  const dir = isAbsolute(STATE.channelsDir || '') && STATE.channelsDir
    ? STATE.channelsDir
    : join(homedir(), '.claude', STATE.channelsDir || '')
  return join(dir, name)
}
function quietRestartFile(): string {
  return markerFile('quiet-restart')
}
// true = suppress this notice. Detach leaves the marker for the successor
// process; attach consumes it. A stale (expired) marker is removed + ignored.
function quietRestartActive(action: 'attach' | 'detach'): boolean {
  try {
    const qr = quietRestartFile()
    if (!existsSync(qr)) return false
    const exp = Number(readFileSync(qr, 'utf8').trim())
    if (Number.isFinite(exp) && exp * 1000 > Date.now()) {
      if (action === 'attach') { try { rmSync(qr, { force: true }) } catch {} }
      return true
    }
    try { rmSync(qr, { force: true }) } catch {}
  } catch {}
  return false
}

// Lifecycle is TELEMETRY, not news (the owner 2026-07-14: "bot going on, down —
// even when it was I who requested this ... too noisy").
//
// A routine restart used to fire 🔴 going dark + 🟢 attached into the chat. He
// almost always caused it himself, so it told him nothing he didn't know — and
// the volume meant a real alert would be lost in the scroll.
//
// Now: the event goes to the ops log (readable on demand via /inspect), and the
// bot's NAME carries the state — 🔴 prefix while down, clean while up. The chat
// list becomes the status board, and nothing is pushed.
async function notifyLifecycle(
  slot: number,
  bot: Bot,
  username: string,
  action: 'attach' | 'detach',
): Promise<void> {
  const ctx = getSessionContext()
  const detail = [
    ctx.agentName ? `agent: ${ctx.agentName}` : '',
    ctx.tmuxSession ? `tmux: ${ctx.tmuxSession}` : '',
    `pid ${ctx.claudePid}`,
  ].filter(Boolean).join(' · ')

  opsEvent('info', action === 'attach' ? 'attach' : 'detach', `slot${slot} @${username} — ${detail}`)

  // The name is the notification. Down => 🔴 prefix.
  if (!QUIET_LIFECYCLE) {
    await setBotStatusIcon(bot, action === 'detach')
  }
}

// Account-switch confirmation. account-switch.sh drops an `account-switched`
// marker next to quiet-restart; the successor process consumes it on attach and
// posts ONE targeted "back on <label>" line — the affirmative the old restart
// never sent (it only went dark). Runs even when the quiet marker suppressed the
// generic 🟢, so a deliberate switch always confirms it landed.
function accountSwitchMarkerFile(): string {
  return markerFile('account-switched')
}
async function announceAccountSwitchIfPending(bot: Bot): Promise<void> {
  const f = accountSwitchMarkerFile()
  let label = ''; let chatId = ''
  try {
    if (!existsSync(f)) return
    const j = JSON.parse(readFileSync(f, 'utf8'))
    label = String(j.label ?? ''); chatId = String(j.chat_id ?? '')
  } catch { try { rmSync(f, { force: true }) } catch {} ; return }
  try { rmSync(f, { force: true }) } catch {}
  if (!chatId) return
  try {
    await bot.api.sendMessage(chatId, `✅ Back on ${label || 'the requested account'} — conversation resumed, nothing lost.`)
  } catch {}
}

async function detachInternal(): Promise<void> {
  const slot = state.currentSlot
  const bot = state.currentBot
  const username = state.currentBotUsername
  state.currentBot = null
  state.currentToken = null
  state.currentSlot = null
  state.currentBotUsername = ''
  if (state.currentBrokerSocket) { try { state.currentBrokerSocket.destroy() } catch {} ; state.currentBrokerSocket = null }
  if (!NO_POLL) clearStatus()

  // FAST_SHUTDOWN: release the claim + (already-cleared status) BEFORE the slow
  // long-poll drain, then stop the bot fire-and-forget so we return immediately.
  // Correctness preserved — claim + status are cleared; only the drain is skipped.
  if (FAST_SHUTDOWN) {
    if (slot !== null && !NO_POLL) releaseClaim(slot)
    if (bot) { void bot.stop().catch(() => {}) }
    return
  }

  // NO_POLL never announced an attach and isn't the listening bot — sending a
  // "detached — going dark" notice from it would be false + would spam the owner.
  if (bot && slot !== null && username && !NO_POLL) {
    // Send detach notice BEFORE stopping the bot — once stopped the api
    // call would race against the shutdown.
    try { await notifyLifecycle(slot, bot, username, 'detach') } catch {}
  }
  if (bot) {
    try { await bot.stop() } catch {}
  }
  // CRITICAL: NO_POLL never claimed the slot. releaseClaim would only unlink if
  // the pid matched (it won't), but we skip it entirely to be unambiguous — the
  // inbound child's claim file MUST survive a NO_POLL child's detach/exit.
  if (slot !== null && !NO_POLL) releaseClaim(slot)
}

// broker-client mode: the per-session bot does NOT poll Telegram (the standalone
// broker owns the single getUpdates connection). Instead we open a Unix-domain
// socket to the broker, declare our sender filter, and feed each forwarded update
// through the bot's normal handler stack via handleUpdate — so gate(),
// handleInbound() and every outbound tool work unchanged.
function connectBroker(slot: number, bot: Bot): void {
  const sockPath = brokerSockPath()
  let buf = ''
  const connectOnce = (attempt: number): void => {
    if (state.currentBot !== bot) return
    const sock = createConnection(sockPath)
    state.currentBrokerSocket = sock
    sock.setEncoding('utf8')
    sock.on('connect', () => {
      attempt = 0
      const access = loadAccess()
      sock.write(JSON.stringify({
        type: 'subscribe',
        label: STATE.label ?? BOT_LABEL,
        allowFrom: access.allowFrom,
        groups: Object.keys(access.groups),
      }) + '\n')
      process.stderr.write(`kushbot[${STATE.label}]: subscribed to broker at ${sockPath}\n`)
    })
    sock.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let frame: any
        try { frame = JSON.parse(line) } catch { continue }
        if (frame.type === 'update' && frame.update) {
          void bot.handleUpdate(frame.update).catch(err => {
            process.stderr.write(`kushbot[${STATE.label}]: handleUpdate error: ${err}\n`)
          })
        }
      }
    })
    sock.on('error', err => {
      process.stderr.write(`kushbot[${STATE.label}]: broker socket error: ${err}\n`)
      try { sock.destroy() } catch {}
    })
    sock.on('close', () => {
      if (state.currentBrokerSocket === sock) state.currentBrokerSocket = null
      if (state.currentBot !== bot) return
      const delay = Math.min(1000 * (attempt + 1), 15000)
      process.stderr.write(`kushbot[${STATE.label}]: broker connection closed, reconnecting in ${delay / 1000}s\n`)
      setTimeout(() => connectOnce(attempt + 1), delay)
    })
  }
  connectOnce(0)
}

async function attach(requestedSlot?: number): Promise<{ slot: number; username: string }> {
  if (state.currentBot) await detachInternal()

  const slots = listSlots()
  if (slots.length === 0) throw new Error(`no slots configured under ${KUSHBOTS_ROOT}`)

  let slot: number
  if (requestedSlot != null) {
    if (!slots.includes(requestedSlot)) throw new Error(`slot${requestedSlot} not configured`)
    // NO_POLL deliberately SHARES a claimed slot (outbound-only). Skip the guard.
    if (!NO_POLL && isSlotClaimed(requestedSlot)) throw new Error(`slot${requestedSlot} is already claimed by another session`)
    slot = requestedSlot
  } else {
    const free = findFreeSlot()
    if (free === null) throw new Error(`all ${slots.length} slot(s) are claimed; detach one or expand the pool`)
    slot = free
  }

  const env = readSlotEnv(slot)
  const token = env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error(`slot${slot}: no TELEGRAM_BOT_TOKEN in ${slotEnvFile(slot)}`)

  // NO_POLL must NOT claim: the inbound child owns the claim file. Claiming here
  // would either fail or (via writeClaim's stale-poller pre-emption) SIGTERM the
  // live inbound poller. So we never writeClaim in outbound-only mode.
  if (!NO_POLL) writeClaim(slot)
  state.currentSlot = slot
  state.currentToken = token
  const bot = new Bot(token)
  state.currentBot = bot
  registerHandlers(bot)

  // Without this, any throw in a message handler stops polling permanently.
  bot.catch(err => {
    process.stderr.write(`kushbot slot${slot}: handler error (polling continues): ${err.error}\n`)
  })

  if (NO_POLL) {
    // Outbound-only: expose the messaging tools without polling/claiming. init()
    // only fetches botInfo (username) so the api client is usable. NO bot.start(),
    // NO connectBroker, NO writeStatus, NO claim, NO lifecycle notice.
    try {
      await bot.init()
      state.currentSlot = slot
      state.currentToken = token
      state.currentBot = bot
      state.currentBotUsername = bot.botInfo.username
    } catch (err) {
      state.currentBot = null; state.currentToken = null; state.currentSlot = null; state.currentBotUsername = ''
      // Do NOT releaseClaim: we never claimed this slot; unlinking the claim file
      // would orphan the inbound child that owns it.
      throw err
    }
    process.stderr.write(`kushbot slot${slot}: NO_POLL outbound-only attached as @${state.currentBotUsername} (shares inbound child's claim; no poll)\n`)
    return { slot, username: state.currentBotUsername }
  }

  if (BROKER_CLIENT) {
    // No polling: the broker owns the single getUpdates connection. We only need
    // botInfo populated so handleUpdate can dispatch the registered handlers.
    try {
      await bot.init()
      state.currentBotUsername = bot.botInfo.username
    } catch (err) {
      state.currentBot = null; state.currentToken = null; state.currentSlot = null; state.currentBotUsername = ''
      releaseClaim(slot)
      throw err
    }
    connectBroker(slot, bot)
    writeStatus(slot)
    loadPending()
    void flushPermissionQueue(bot)
    void flushInboundQueue(bot)
    void registerSlashMenu(bot)
    try { await notifyLifecycle(slot, bot, state.currentBotUsername, 'attach') } catch {}
    void announceAccountSwitchIfPending(bot)
    process.stderr.write(`kushbot[${STATE.label}]: broker-client attached as @${state.currentBotUsername}\n`)
    return { slot, username: state.currentBotUsername }
  }

  let resolveStart!: (u: string) => void
  let rejectStart!: (e: Error) => void
  const startPromise = new Promise<string>((res, rej) => { resolveStart = res; rejectStart = rej })
  let firstAttempt = true
  let warned409 = false   // alert-once latch for the persistent-409 (competing poller) path

  // Background polling loop. Resolve on first onStart, reject on first failure
  // (so attach() surfaces a bad token / 409). Subsequent errors retry silently.
  void (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        await bot.start({
          onStart: info => {
            attempt = 0
            state.currentBotUsername = info.username
            if (firstAttempt) { firstAttempt = false; resolveStart(info.username) }
            if (warned409) {
              // Recovered from a competing-poller 409. The RECOVERY is not news —
              // the bot is simply working again, which is the expected state. Log
              // it (visible in /inspect) and stay quiet; only the breakage alerts.
              warned409 = false
              opsEvent('info', 'poller_recovered', `@${info.username} — competing poller gone`)
            }
            process.stderr.write(`kushbot slot${slot}: polling as @${info.username}\n`)
            void registerSlashMenu(bot)
          },
        })
        return // bot.stop() called → clean exit
      } catch (err) {
        if (state.currentBot !== bot) return // we were detached during this attempt
        if (err instanceof Error && err.message === 'Aborted delay') return
        if (firstAttempt) {
          firstAttempt = false
          rejectStart(err instanceof Error ? err : new Error(String(err)))
          return
        }
        const is409 = err instanceof GrammyError && err.error_code === 409
        if (is409 && attempt >= 8) {
          // Persistent 409 = ANOTHER process is polling this bot (a competing/orphan
          // poller — the 2026-07-07 zombie that silently ate kai's DMs for 3 days).
          // The old code exited the poller here and went PERMANENTLY, SILENTLY deaf.
          // Instead: alert the owner ONCE, then keep retrying at a slow cadence so we
          // auto-resume the instant the competitor dies (the watchdog kills orphan
          // pollers — see fleet-watchdog D7). Never go silently deaf again.
          if (!warned409) {
            warned409 = true
            process.stderr.write(`kushbot slot${slot}: 409 Conflict persists — a competing poller owns this bot; alerting owner, will keep retrying\n`)
            // ALERT, not info: a deaf bot needs a human. This survives the
            // noise cull precisely because it is the opposite of routine.
            opsEvent('alert', 'poller_conflict', `@${state.currentBotUsername || '?'} — deaf, competing poller`)
            try {
              for (const chat of opsRecipients(readAccessFile(slot))) {
                void bot.api.sendMessage(chat, `⚠️ Another process is polling @${state.currentBotUsername || 'this bot'} (Telegram 409 Conflict). Likely an orphaned/zombie poller — I'm deaf to new messages until it's gone. The watchdog will try to kill it and I'll auto-resume. If it persists: pgrep -af 'bun.*server.ts'`).catch(() => {})
              }
            } catch {}
          }
          await new Promise(r => setTimeout(r, 30000))
          if (state.currentBot !== bot) return
          continue   // keep retrying — do NOT exit into silent deafness
        }
        const delay = Math.min(1000 * attempt, 15000)
        process.stderr.write(`kushbot slot${slot}: ${is409 ? '409 Conflict' : `polling error: ${err}`}, retrying in ${delay / 1000}s\n`)
        await new Promise(r => setTimeout(r, delay))
        if (state.currentBot !== bot) return
      }
    }
  })()

  try {
    const username = await startPromise
    writeStatus(slot)
    loadPending()
    void flushPermissionQueue(bot)
    void flushInboundQueue(bot)
    // Best-effort attach notice; never let a send error break the attach itself.
    try { await notifyLifecycle(slot, bot, username, 'attach') } catch {}
    void announceAccountSwitchIfPending(bot)
    return { slot, username }
  } catch (err) {
    // First-attempt failure — undo claim so the slot is reusable.
    state.currentBot = null
    state.currentToken = null
    state.currentSlot = null
    state.currentBotUsername = ''
    releaseClaim(slot)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  // Defense-in-depth: a NO_POLL outbound-only child must never run the session/
  // pool-management tools even if a client calls them directly (they aren't in
  // its advertised tool list, but this guard makes it impossible to re-bind the
  // shared slot). Env-gated; unset NO_POLL leaves dispatch unchanged.
  if (NO_POLL && !NO_POLL_TOOL_ALLOWLIST.has(req.params.name)) {
    return { content: [{ type: 'text', text: `tool '${req.params.name}' is disabled in NO_POLL outbound-only mode` }], isError: true }
  }
  try {
    switch (req.params.name) {
      case 'attach': {
        const requested = args.slot != null ? Number(args.slot) : undefined
        const result = await attach(requested)
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      }
      case 'detach': {
        const slot = state.currentSlot
        await detachInternal()
        return { content: [{ type: 'text', text: slot != null ? `detached slot${slot}` : 'no slot was attached' }] }
      }
      case 'current': {
        const payload = state.currentSlot != null
          ? { slot: state.currentSlot, username: state.currentBotUsername || null }
          : null
        return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
      }
      case 'pool_status': {
        if (SINGLE) {
          const bound = state.currentSlot != null && state.currentBot != null
          return { content: [{ type: 'text', text:
            `=== KUSHBOT (single-bot mode) ===\n` +
            `machine: ${STATE.machine}\n` +
            `bot: ${BOT_LABEL}${state.currentBotUsername ? ` (@${state.currentBotUsername})` : ''}\n` +
            `channels: ${singleDir()}\n` +
            `polling: ${bound ? '✅ active' : '⚠ not attached'}` }] }
        }
        const lines: string[] = []
        lines.push('=== KUSHBOT POOL ===')
        const slots = listSlots()
        if (slots.length === 0) {
          lines.push('(no slots configured)')
        } else {
          for (const s of slots) {
            const tag = s === 0 ? ' (kc parent)' : ''
            const pidFile = slotPidFile(s)
            let entry = `slot${s}${tag}: `
            try {
              const pid = parseInt(readFileSync(pidFile, 'utf8'), 10)
              if (isPidAlive(pid)) {
                const { claudePid, tty, cwd } = resolveSession(pid)
                entry += `✅ MCP pid ${pid} → claude pid ${claudePid} (tty ${tty}, cwd ${cwd})`
              } else {
                entry += `⚠ stale pid ${pid} (will be GC'd on next attach)`
              }
            } catch {
              entry += 'free'
            }
            lines.push(entry)
          }
        }

        lines.push('')
        lines.push('=== KUSHBOT STATUS FILES (claude_pid → slot) ===')
        try {
          const statusEntries = readdirSync(join(KUSHBOTS_ROOT, '_status'))
          if (statusEntries.length === 0) {
            lines.push('(none)')
          } else {
            for (const f of statusEntries) {
              const claudePid = parseInt(f, 10)
              const alive = isPidAlive(claudePid) ? '(alive)' : '(stale)'
              let contents = ''
              try { contents = readFileSync(join(KUSHBOTS_ROOT, '_status', f), 'utf8').trim() } catch {}
              lines.push(`claude ${f} ${alive} → ${contents}`)
            }
          }
        } catch {
          lines.push('(no status dir yet)')
        }

        lines.push('')
        lines.push('=== TMUX SESSIONS (kush<N>) ===')
        try {
          const out = execSync('tmux ls 2>/dev/null', { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
          const matched = out.split('\n').filter(l => /^kush(-slot)?\d/.test(l))
          if (matched.length === 0) lines.push('(none)')
          else lines.push(...matched)
        } catch {
          lines.push('(tmux not running or no sessions)')
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
      case 'spawn': {
        if (SINGLE) return { content: [{ type: 'text', text: `spawn is unavailable in single-bot mode (${BOT_LABEL}@${STATE.machine}) — the pool/spawn machinery only exists on the Mac kush pool.` }], isError: true }
        const dirArg = String(args.dir ?? '').trim()
        if (!dirArg) throw new Error('spawn requires {dir}')
        const abs = dirArg.startsWith('/') ? dirArg : join(homedir(), 'work', dirArg)
        try {
          if (!statSync(abs).isDirectory()) throw new Error('not a directory')
        } catch {
          throw new Error(`directory not found: ${abs}`)
        }

        let target: number
        if (args.slot != null) {
          target = Number(args.slot)
          if (target === 0) throw new Error('slot 0 is reserved for kc — pick 1+')
          if (!listSlots().includes(target)) throw new Error(`slot${target} is not configured`)
          if (isSlotClaimed(target)) throw new Error(`slot${target} is already claimed`)
        } else {
          const free = findFreeSlot()
          if (free === null) throw new Error('no free slot ≥1 — detach one or expand the pool')
          target = free
        }

        if (!readSlotEnv(target).TELEGRAM_BOT_TOKEN) {
          throw new Error(`slot${target}/.env has no TELEGRAM_BOT_TOKEN`)
        }

        const sessionName = `kush${target}`

        // Kill any zombie tmux session by that name first (incl. legacy kush-slotN name).
        spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' })
        spawnSync('tmux', ['kill-session', '-t', `kush-slot${target}`], { stdio: 'ignore' })

        // NB: `dc`, NOT `exec dc`. `dc` is a zsh ALIAS (claude --dangerously-load-
        // development-channels ...); `exec` bypasses alias/function lookup and would
        // run /usr/bin/dc (the calculator) instead. `zsh -i` loads the alias; bare
        // `dc` in command position expands it.
        const innerCmd = `cd ${JSON.stringify(abs)}; export KUSHBOT_AUTO_ATTACH=${target}; dc`
        const spawnRes = spawnSync(
          'tmux',
          ['new-session', '-d', '-s', sessionName, '-c', abs, '/bin/zsh', '-i', '-c', innerCmd],
          { stdio: 'pipe' },
        )
        if (spawnRes.status !== 0) {
          throw new Error(`tmux new-session failed: ${spawnRes.stderr?.toString() || 'unknown'}`)
        }

        // A detached dc stalls on the "--dangerously-load-development-channels"
        // confirmation prompt (option 1 = local dev, "Enter to confirm") — nobody's
        // there to press Enter, so the MCP never boots and the slot never attaches.
        // Auto-confirm: tap Enter a couple times as claude initializes (extra Enters
        // at the empty input prompt are harmless no-ops).
        for (const delay of [3000, 6000, 9000]) {
          setTimeout(() => {
            try { spawnSync('tmux', ['send-keys', '-t', sessionName, 'Enter'], { stdio: 'ignore' }) } catch {}
          }, delay).unref?.()
        }

        const result = {
          slot: target,
          tmux_session: sessionName,
          attach_command: `tmux attach -t ${sessionName}`,
          dir: abs,
          message: `Spawned dc in ${abs} → slot${target} polling as @kush${target}_son_of_kush_bot. Attach with: tmux attach -t ${sessionName}`,
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      }
      case 'reply': {
        if (!state.currentBot || state.currentSlot == null) throw new Error('no slot attached — call attach() first')
        const chat_id = args.chat_id as string
        const text = (args.text as string | undefined) ?? ''
        const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
        const quote = args.quote as string | undefined
        const quotePosition = args.quote_position != null ? Number(args.quote_position) : undefined
        const quoteParseMode = resolveParseMode(args.quote_parse_mode as string | undefined)
        const files = (args.files as string[] | undefined) ?? []
        const format = (args.format as string | undefined) ?? 'text'
        const parseMode = resolveParseMode(format)
        const linkPreview = resolveLinkPreview(args.link_preview as string | undefined)
        const bot = state.currentBot

        if (text.length === 0 && files.length === 0) throw new Error('reply needs either text or files')
        if (quote != null && reply_to == null) {
          throw new Error('quote requires reply_to (TG anchors quotes to a specific replied-to message)')
        }
        if (quote != null && quote.length > 1024) {
          throw new Error(`quote too long (${quote.length}/1024 chars — TG limit)`)
        }

        // Build reply_parameters once — reused across text chunks + attachment sends.
        const replyParams = reply_to != null
          ? {
              message_id: reply_to,
              ...(quote != null ? { quote } : {}),
              ...(quotePosition != null ? { quote_position: quotePosition } : {}),
              ...(quoteParseMode != null ? { quote_parse_mode: quoteParseMode } : {}),
            }
          : undefined

        assertAllowedChat(chat_id)

        for (const f of files) {
          assertSendable(f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
          }
        }

        const access = loadAccess()
        const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
        // Default to 'newline' (smart) — the old 'length' default hard-cut at exactly
        // 4096 chars regardless of word boundaries, which corrupted kai-son's 4627-char
        // diagnosis at "block peop[le]" on 2026-06-13. 'length' remains as an opt-in
        // escape hatch via access.json chunkMode: 'length'.
        const mode = access.chunkMode ?? 'newline'
        const replyMode = access.replyToMode ?? 'first'
        const sentIds: number[] = []

        // Caption-eligible: short enough to ride along on the first attachment.
        // Telegram caps media captions at 1024 chars (vs 4096 for text), so longer
        // text falls back to a separate sendMessage burst before the attachments.
        const useCaption = files.length > 0 && text.length > 0 && text.length <= MEDIA_CAPTION_LIMIT
        const textChunks = (text.length > 0 && !useCaption)
          ? balanceChunks(chunk(text, limit, mode), parseMode)
          : []

        try {
          for (let i = 0; i < textChunks.length; i++) {
            const shouldReplyTo = reply_to != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
            const sent = await bot.api.sendMessage(chat_id, textChunks[i], {
              ...(shouldReplyTo ? { reply_parameters: replyParams! } : {}),
              ...(parseMode ? { parse_mode: parseMode } : {}),
              ...(linkPreview ? { link_preview_options: linkPreview } : {}),
            })
            sentIds.push(sent.message_id)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(`reply failed after ${sentIds.length} of ${textChunks.length} chunk(s) sent: ${msg}`)
        }

        for (let fi = 0; fi < files.length; fi++) {
          const f = files[fi]
          const ext = extname(f).toLowerCase()
          const input = new InputFile(f)
          // Caption rides on the first attachment only; subsequent files go bare.
          // replyTo also lands only on the first send (or all, per replyToMode).
          const isFirst = fi === 0
          const shouldReplyTo = reply_to != null && replyMode !== 'off' && (replyMode === 'all' || (isFirst && textChunks.length === 0))
          const replyOpt = shouldReplyTo ? { reply_parameters: replyParams! } : undefined
          const captionOpt = (useCaption && isFirst)
            ? { caption: text, ...(parseMode ? { parse_mode: parseMode } : {}) }
            : undefined
          const baseOpts = { ...(replyOpt ?? {}), ...(captionOpt ?? {}) }
          const opts = Object.keys(baseOpts).length ? baseOpts : undefined

          try {
            if (PHOTO_EXTS.has(ext)) {
              const sent = await bot.api.sendPhoto(chat_id, input, opts)
              sentIds.push(sent.message_id)
            } else if (AUDIO_EXTS.has(ext)) {
              // Render as a proper inline audio player (title + scrubber), not a download-only doc.
              const title = basename(f).replace(/\.[^.]+$/, '')
              const sent = await bot.api.sendAudio(chat_id, input, { ...(opts ?? {}), title })
              sentIds.push(sent.message_id)
            } else if (VOICE_EXTS.has(ext)) {
              const sent = await bot.api.sendVoice(chat_id, input, opts)
              sentIds.push(sent.message_id)
            } else if (VIDEO_EXTS.has(ext)) {
              const sent = await bot.api.sendVideo(chat_id, input, opts)
              sentIds.push(sent.message_id)
            } else {
              const sent = await bot.api.sendDocument(chat_id, input, opts)
              sentIds.push(sent.message_id)
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            throw new Error(`reply: failed sending ${basename(f)} (file ${fi + 1}/${files.length}, ${sentIds.length} ids already sent: ${sentIds.join(',') || '—'}): ${msg}`)
          }
        }

        state.lastOutboundAt = Date.now()
        const result = sentIds.length === 1
          ? `sent (id: ${sentIds[0]})`
          : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
        return { content: [{ type: 'text', text: result }] }
      }
      case 'send_to_agent': {
        const to = String(args.to ?? '').trim()
        const text = String(args.text ?? '').trim()
        if (!to || !text) throw new Error('send_to_agent needs {to, text}')
        const env = fleetSend(to, text, {
          hops: args.hops != null ? Number(args.hops) : 0,
          reply_expected: args.reply_expected === true,
          priority: args.priority === 'high' ? 'high' : 'normal',
          quiet: typeof args.quiet === 'boolean' ? args.quiet : undefined,
        })
        return { content: [{ type: 'text', text: `queued for ${to} (envelope ${env.id}). Their kushbot delivers within ~5s if attached; otherwise it waits in their inbox. ${env.quiet ? 'Quiet: no owner mirror ping (still in /outbox + their inbox).' : 'The owner sees a mirrored copy.'} /outbox shows delivery status.` }] }
      }
      case 'react': {
        if (!state.currentBot) throw new Error('no slot attached — call attach() first')
        assertAllowedChat(args.chat_id as string)
        await state.currentBot.api.setMessageReaction(args.chat_id as string, Number(args.message_id), [
          { type: 'emoji', emoji: args.emoji as ReactionTypeEmoji['emoji'] },
        ])
        // A reaction is an ACK ("seen it, working"), NOT a reply. It used to set
        // lastOutboundAt, which silenced the dead-man nudge permanently — so a
        // session that 👀'd and then wedged went unreported forever, defeating the
        // check. Recorded separately: it now DEFERS the nudge (10min -> 45min)
        // instead of cancelling it. See deadmanTick in src/state.ts.
        state.reactedInboundAt = Date.now()
        return { content: [{ type: 'text', text: 'reacted' }] }
      }
      case 'rename': {
        if (!state.currentBot) throw new Error('no slot attached — call attach() first')
        const label = String(args.label ?? '').trim()
        if (!label) throw new Error('rename needs a non-empty label')
        const newName = await renameBotDisplayName(state.currentBot, label)
        return { content: [{ type: 'text', text: `bot display name is now "${newName}" (chat lists may take a minute to refresh)` }] }
      }
      case 'download_attachment': {
        if (!state.currentBot || !state.currentToken || state.currentSlot == null) throw new Error('no slot attached — call attach() first')
        const file_id = args.file_id as string
        const file = await state.currentBot.api.getFile(file_id)
        if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
        const url = `https://api.telegram.org/file/bot${state.currentToken}/${file.file_path}`
        const res = await fetch(url)
        if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
        const buf = Buffer.from(await res.arrayBuffer())
        const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
        const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
        const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
        const path = join(slotInboxDir(state.currentSlot), `${Date.now()}-${uniqueId}.${ext}`)
        mkdirSync(slotInboxDir(state.currentSlot), { recursive: true })
        writeFileSync(path, buf)
        return { content: [{ type: 'text', text: path }] }
      }
      case 'edit_message': {
        if (!state.currentBot) throw new Error('no slot attached — call attach() first')
        assertAllowedChat(args.chat_id as string)
        const editFormat = (args.format as string | undefined) ?? 'text'
        const editParseMode = resolveParseMode(editFormat)
        const editLinkPreview = resolveLinkPreview(args.link_preview as string | undefined)
        const editOpts: Record<string, unknown> = {}
        if (editParseMode) editOpts.parse_mode = editParseMode
        if (editLinkPreview) editOpts.link_preview_options = editLinkPreview
        const edited = await state.currentBot.api.editMessageText(
          args.chat_id as string,
          Number(args.message_id),
          args.text as string,
          ...(Object.keys(editOpts).length ? [editOpts] : []),
        )
        const id = typeof edited === 'object' ? edited.message_id : args.message_id
        state.lastOutboundAt = Date.now()
        return { content: [{ type: 'text', text: `edited (id: ${id})` }] }
      }
      case 'ask': {
        if (!state.currentBot) throw new Error('no slot attached — call attach() first')
        assertAllowedChat(args.chat_id as string)
        const question = String(args.question ?? '').trim()
        const opts = Array.isArray(args.options) ? (args.options as unknown[]).map(o => String(o).slice(0, 60)) : []
        if (!question) throw new Error('question is required')
        if (opts.length < 2 || opts.length > 10) throw new Error('need 2–10 options')
        const multi = args.multi === true
        const nonce = (Math.random().toString(36).slice(2, 8) + '000000').slice(0, 6)
        const kb = multi
          ? multiAskKeyboard(nonce, opts, [])
          : opts.reduce((k, o, i) => k.text(o, `ask|${nonce}|${i}`).row(), new InlineKeyboard())
        const hint = multi ? '\n<i>tap to toggle, then Done</i>' : ''
        const sent = await state.currentBot.api.sendMessage(args.chat_id as string, `❓ ${question}${hint}`, {
          reply_markup: kb,
          ...(multi ? { parse_mode: 'HTML' as const } : {}),
        })
        pendingAsks.set(nonce, {
          question, options: opts, chatId: String(args.chat_id), messageId: sent.message_id,
          ...(multi ? { multi: true, selected: [] } : {}),
        })
        savePending()
        state.lastOutboundAt = Date.now()
        return { content: [{ type: 'text', text: multi
          ? `asked (multi-select, id: ${sent.message_id}) — arrives when they tap Done, as "[ask] ${question} → a, b, c"`
          : `asked (id: ${sent.message_id}) — the tap arrives later as an inbound message "[ask] ${question} → <choice>"` }] }
      }
      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }], isError: true }
  }
})

// ---------------------------------------------------------------------------
// Bot handler registration (called fresh on each attach)
// ---------------------------------------------------------------------------

type AttachmentMeta = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
  // Populated by kind:"voice" when the auto-transcribe pipeline ran.
  // See bot.on('message:voice') and runVoiceTranscribe() below.
  local_path?: string         // path to the downloaded .oga on disk (slot inbox)
  transcript?: string         // the actual transcribed text (replaces "(voice message)" placeholder when set)
  transcript_error?: string   // surfaced if download or transcribe failed; agent can choose to retry
}

// Rename the bot's Telegram display name (the label in the user's chat list)
// via Bot API setMyName — no BotFather round-trip, no restart. The name is
// set to exactly the label — just the subject, no bot-number base prefix.
// Powers both the /rename Telegram command and the `rename` MCP tool (which
// is how a bare /rename lets the agent pick its own smart label). Telegram
// caps names at 64 chars and rate-limits changes to a few per day per bot.
async function renameBotDisplayName(bot: Bot, label: string): Promise<string> {
  const name = label.slice(0, 64)
  await bot.api.setMyName(name)
  return name
}

// Populate the Telegram slash menu shown when the user taps "/". Pulls the
// effective list from resolveCommands() — DEFAULT_COMMANDS plus any per-bot
// extras from commands.json. Telegram caches this per-bot; calling it on every
// attach is harmless and keeps it consistent across restarts.
// The slash menu, gated. resolveCommands() is the shared base (DEFAULT_COMMANDS
// plus per-bot commands.json); /quota is appended only on kc and kai, because
// only those two answer it. Both the tap-menu and /help read this one function
// so they cannot drift.
function menuCommands(): SlashCommand[] | null {
  const base = resolveCommands()
  if (base === null) return null
  if (!quotaAllowed()) return base
  if (base.some(c => c.command === 'quota')) return base
  return [...base, { command: 'quota', description: 'AI budgets: claude x2, codex, grok, and what will expire unspent' }]
}

async function registerSlashMenu(bot: Bot): Promise<void> {
  const cmds = menuCommands()
  if (cmds === null) {
    process.stderr.write(`kushbot[${BOT_LABEL}]: commands.json opted out — skipping setMyCommands\n`)
    return
  }
  try {
    await bot.api.setMyCommands(cmds, { scope: { type: 'all_private_chats' } })
    process.stderr.write(`kushbot[${BOT_LABEL}]: registered ${cmds.length} slash command(s)\n`)
  } catch (err) {
    process.stderr.write(`kushbot[${BOT_LABEL}]: setMyCommands failed: ${err}\n`)
  }
}

// CODEX_MODE: emit a session-control command as a channel notification
// (meta.source="command"). Reuses the inbound MCP transport; the bridge switches
// on meta.source and maps command→app-server method. No 👀 ack, no tmux.
function emitCommandNotification(ctx: Context, command: string, args: string): void {
  const from = ctx.from
  const chat_id = ctx.chat ? String(ctx.chat.id) : ''
  const msgId = ctx.message?.message_id
  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: `/${command}${args ? ' ' + args : ''}`,
      meta: {
        source: 'command',
        command,
        args,
        chat_id,
        ...(msgId != null ? { message_id: String(msgId) } : {}),
        user: from?.username ?? String(from?.id ?? ''),
        user_id: String(from?.id ?? ''),
        ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
      },
    },
  }).catch(err => {
    process.stderr.write(`kushbot: failed to emit command notification: ${err}\n`)
  })
}

function registerHandlers(bot: Bot): void {
  // ── Forward guard (P0) ──────────────────────────────────────────────────
  // Telegram preserves a message's bot_command entity when it is FORWARDED, so a
  // forwarded copy of an old "/account personal" (or /stop, /compact, /clear …)
  // dispatches through grammy's bot.command() as a LIVE command — the 2026-07-10
  // incident where forwarding an old message restarted kai4. A forward is
  // evidence the user is showing you, never an instruction to execute. This
  // middleware runs BEFORE every command handler: any forwarded, command-shaped
  // text is rerouted to the session as ordinary content and never executes.
  // (Non-command forwards already flow through bot.on('message:*') as content, so
  // only '/'-prefixed forwards need interception here.)
  bot.use(async (ctx, next) => {
    const m = ctx.message
    if (m?.text && m.forward_origin && m.text.startsWith('/')) {
      process.stderr.write(`kushbot: forward-guard blocked forwarded command "${m.text.slice(0, 48).replace(/\n/g, ' ')}" — routing as content\n`)
      await handleInbound(ctx, m.text, undefined)
      return   // stop the chain — do NOT fall through to any command handler
    }
    await next()
  })

  bot.command('start', async ctx => {
    if (ctx.chat?.type !== 'private') return
    const access = loadAccess()
    if (access.dmPolicy === 'disabled') {
      await ctx.reply(`This bot isn't accepting new connections.`)
      return
    }
    await ctx.reply(
      `This bot bridges Telegram to a Claude Code session.\n\n` +
      `To pair: edit ~/.claude/channels/kushbots/slot${state.currentSlot}/access.json ` +
      `and add your sender ID to allowFrom.`,
    )
  })

  bot.command('help', async ctx => {
    if (ctx.chat?.type !== 'private') return
    // Built from resolveCommands() so /help can never drift from the tap-menu
    // again (the hand-maintained copy had lost /stop, /wf and /account).
    const cmds = menuCommands() ?? []
    const list = cmds.map(c => `/${c.command} — ${c.description}`).join('\n')
    await ctx.reply(
      `Messages you send here route to a paired Claude Code session. ` +
      `Text and photos are forwarded; replies and reactions come back.\n\n` +
      `/start — pairing instructions\n${list}`,
    )
  })

  // TUI-equivalent /status. For unpaired senders we still surface pairing state
  // (don't expose session internals to strangers); for paired senders we render
  // the full session block. Fields not derivable from the bot process show "—".
  bot.command('status', async ctx => {
    if (ctx.chat?.type !== 'private') return
    const from = ctx.from
    if (!from) return
    const senderId = String(from.id)
    const access = loadAccess()
    if (!access.allowFrom.includes(senderId)) {
      for (const [code, p] of Object.entries(access.pending)) {
        if (p.senderId === senderId) {
          await ctx.reply(
            `Pending pairing — add your sender ID (${senderId}) to ` +
            `~/.claude/channels/${STATE.channelsDir || `kushbots/slot${state.currentSlot}`}/access.json allowFrom.\n\n` +
            `(pairing code on file: ${code})`,
          )
          return
        }
      }
      await ctx.reply(`Not paired. Send me a message to be added to the pending list.`)
      return
    }
    try {
      await ctx.reply(renderStatus(), { parse_mode: 'HTML' })
    } catch (err) {
      process.stderr.write(`kushbot: /status reply failed: ${err}\n`)
      try { await ctx.reply('status render failed') } catch {}
    }
  })

  // /heartbeat — process-only health diagnosis. NEVER injects; answers even when
  // the model side is wedged/OOM. Allowlist-gated, private-chat-only.
  bot.command('heartbeat', async ctx => {
    if (ctx.chat?.type !== 'private') return
    const from = ctx.from
    if (!from) return
    if (!loadAccess().allowFrom.includes(String(from.id))) {
      await ctx.reply('Not paired — /heartbeat is only available to allowlisted senders.').catch(() => {})
      return
    }
    try {
      await ctx.reply(runHeartbeat(), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
    } catch (err) {
      process.stderr.write(`kushbot: /heartbeat reply failed: ${err}\n`)
      try { await ctx.reply('heartbeat render failed') } catch {}
    }
  })

  // /inspect [24h|7d|Nd|Nh] — the operational backlog, on demand, as ONE message.
  // This is the other half of the noise fix: because routine events no longer
  // notify, they have to be READABLE. Everything still lands in the ops log; this
  // is how you read it. Owner-only — ops telemetry is never for shared users.
  bot.command('inspect', async ctx => {
    if (ctx.chat?.type !== 'private') return
    const from = ctx.from
    if (!from) return
    const access = loadAccess()
    if (!opsRecipients(access).includes(String(from.id))) {
      await ctx.reply('/inspect is operator-only.').catch(() => {})
      return
    }
    if (state.currentSlot == null) {
      await ctx.reply('No slot attached — nothing to inspect.').catch(() => {})
      return
    }
    const arg = String(ctx.match ?? '').trim().toLowerCase()
    const m = /^(\d+)\s*([hd])$/.exec(arg)
    const hours = m
      ? (m[2] === 'd' ? parseInt(m[1], 10) * 24 : parseInt(m[1], 10))
      : 24                                    // default: last 24h
    try {
      await ctx.reply(renderInspect(state.currentSlot, Math.min(hours, 30 * 24)), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      })
    } catch (err) {
      process.stderr.write(`kushbot: /inspect reply failed: ${err}\n`)
      try { await ctx.reply('inspect render failed') } catch {}
    }
  })

  // /cli — the exact terminal command to attach to THIS session. Leaks cwd /
  // session id / tmux name, so allowlist-gated + private-chat-only.
  bot.command('cli', async ctx => {
    if (ctx.chat?.type !== 'private') return
    const from = ctx.from
    if (!from) return
    if (!loadAccess().allowFrom.includes(String(from.id))) {
      await ctx.reply('Not paired — /cli is only available to allowlisted senders.').catch(() => {})
      return
    }
    try {
      await ctx.reply(buildCliCommand(), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
    } catch (err) {
      process.stderr.write(`kushbot: /cli reply failed: ${err}\n`)
      try { await ctx.reply('cli render failed') } catch {}
    }
  })

  // /rename [label] — set this bot's display name in the user's chat list.
  // With a label the bot handles it directly (instant, no model involved):
  // base stays, label replaces whatever followed ' - '. Bare /rename is the
  // smart path — the bot process has no idea what the session is "about", so
  // it forwards a directive through the normal inbound path and the AGENT
  // picks a label from its live context and calls the `rename` MCP tool.
  bot.command('rename', async ctx => {
    if (ctx.chat?.type !== 'private') return
    const from = ctx.from
    if (!from) return
    if (!loadAccess().allowFrom.includes(String(from.id))) {
      await ctx.reply('Not paired — /rename is only available to allowlisted senders.').catch(() => {})
      return
    }
    const label = String(ctx.match ?? '').trim()
    if (label) {
      try {
        const name = await renameBotDisplayName(bot, label)
        await ctx.reply(`🏷️ Renamed to "${name}". Your chat list may take a minute to refresh.`)
      } catch (err) {
        // Most common failure: Telegram's name-change rate limit (429).
        await ctx.reply(`rename failed: ${err}`).catch(() => {})
      }
      return
    }
    await handleInbound(
      ctx,
      '[rename] The user ran /rename with no label — smart rename. Pick a short label (2–4 words, ≤40 chars) that best captures what this session is currently about or assigned to, call the kushbot `rename` MCP tool with it, then confirm the new name to the user in one line.',
      undefined,
    )
  })

  // performModelSwitch — inject `/model <name>` into the tmux pane and verify.
  // Used by the /model free-text path (gateway models like gpt-5.6-sol /
  // grok-4.5 that aren't on the buttons). Auto-confirms Claude's "Yes, switch
  // to X / No, go back" cache dialog. Mirrors the model|<alias> button logic
  // (kept separate deliberately — zero regression risk on the button path).
  async function performModelSwitch(name: string): Promise<{ result: 'switched' | 'rejected' | 'notmux' | 'unknown'; detail: string }> {
    const ok = sendKeysToSession('/model ' + name)
    if (!ok) return { result: 'notmux', detail: 'session not in tmux' }
    const { tmuxSession } = getSessionContext()
    const sleepP = (ms: number) => new Promise(r => setTimeout(r, ms))
    const failurePatterns: Array<[RegExp, string]> = [
      [/is not currently available/i, 'model unavailable'],
      [/currently unavailable/i, 'model unavailable'],
      [/not a recognized model id/i, 'not a recognized model id'],
      [/Please run \/login/i, 'needs /login'],
      [/Invalid authentication credentials/i, '401 — needs /login'],
      [/model not found/i, 'model not found'],
      [/insufficient/i, 'insufficient permissions'],
    ]
    const nameRx = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const successPatterns: RegExp[] = [
      new RegExp(`Set model to.*${nameRx}`, 'i'),
      new RegExp(`switched.*${nameRx}`, 'i'),
    ]
    let result: 'switched' | 'rejected' | 'unknown' = 'unknown'
    let detail = ''
    for (let i = 0; i < 10; i++) {
      await sleepP(500)
      let paneOut = ''
      try {
        paneOut = execSync(`tmux capture-pane -t ${shq(tmuxSession!)} -p -J -S -30`).toString()
      } catch { continue }
      if (/Yes,\s*switch\s*to/i.test(paneOut) && /No,\s*go\s*back/i.test(paneOut)) {
        try { execSync(`tmux send-keys -t ${shq(tmuxSession!)} 1 Enter`) } catch {}
        continue
      }
      for (const [rx, tag] of failurePatterns) {
        if (rx.test(paneOut)) {
          result = 'rejected'
          detail = (paneOut.split('\n').find(l => rx.test(l)) || tag).trim().slice(0, 200) || tag
          break
        }
      }
      if (result === 'rejected') break
      if (successPatterns.some(rx => rx.test(paneOut))) { result = 'switched'; break }
    }
    return { result, detail }
  }

  // /model — switch the session's model. With an argument (`/model gpt-5.6-sol`)
  // injects + verifies that exact model name — REQUIRED for gateway (dcg)
  // sessions whose models aren't Claude aliases. Bare /model sends the inline
  // keyboard; a tap runs `/model <alias>` via tmux send-keys (tmux-only).
  // Allowlist-gated.
  bot.command('model', async ctx => {
    if (ctx.chat?.type !== 'private') return
    const from = ctx.from
    if (!from) return
    if (!loadAccess().allowFrom.includes(String(from.id))) {
      await ctx.reply('Not paired — /model is only available to allowlisted senders.').catch(() => {})
      return
    }
    if (CODEX_MODE) { emitCommandNotification(ctx, 'model', String(ctx.match ?? '').trim()); return }
    const wanted = String(ctx.match ?? '').trim()
    if (wanted) {
      // Free-text switch (gateway models, exact IDs, aliases — anything).
      const note = await ctx.reply(`🔀 Switching model → ${wanted}…`).catch(() => null)
      const sw = await performModelSwitch(wanted)
      const txt =
        sw.result === 'switched' ? `🔀 Switched model → ${wanted}` :
        sw.result === 'notmux' ? "Can't switch — this session isn't running in tmux." :
        sw.result === 'rejected' ? `⚠️ Model switch to ${wanted} rejected:\n\n${sw.detail}` :
        `🤷 Sent /model ${wanted} — couldn't confirm from the pane. Check with /status.`
      if (note) await bot.api.editMessageText(note.chat.id, note.message_id, txt).catch(() => {})
      else await ctx.reply(txt).catch(() => {})
      return
    }
    let current = 'unknown'
    try {
      const sess = readSessionJson() ?? {}
      const sessionId = typeof sess.sessionId === 'string' ? sess.sessionId : null
      const cache = readStatusCache(sessionId)
      if (cache?.model) current = cache.model
    } catch {}
    const curEffort = effortForHome(homedir())
    // Gateway session? (dcg — the claude parent's env is inherited by this
    // child.) Build buttons from the proxy's LIVE model list instead of the
    // hardcoded Claude aliases, which don't route through the gateway at all.
    let keyboard: InlineKeyboard | null = null
    let hint = ''
    const gwBase = process.env.ANTHROPIC_BASE_URL || ''
    if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(gwBase)) {
      try {
        const res = await fetch(`${gwBase.replace(/\/$/, '')}/v1/models`, {
          headers: { 'x-api-key': process.env.ANTHROPIC_AUTH_TOKEN || '' },
          signal: AbortSignal.timeout(5000),
        })
        const body = (await res.json()) as { data?: Array<{ id?: string }> }
        const live = (body.data ?? []).map(m => String(m.id ?? ''))
        // Curated picker (the owner 2026-07-14): exactly these, in this order —
        // "rest all models are stale and won't be in use". Falls back to a
        // dynamic gpt/grok list only if none of the preferred ids are served.
        const GW_MODEL_PREFS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'grok-4.5']
        let ids = GW_MODEL_PREFS.filter(id => live.includes(id))
        if (!ids.length) ids = live
          .filter(id => /^(gpt|grok)-/.test(id))            // real names only, skip the -dd- disguises
          .filter(id => !/image|video|imagine/i.test(id))   // chat-capable only
          .slice(0, 9)
        if (ids.length) {
          keyboard = new InlineKeyboard()
          ids.forEach((id, i) => {
            keyboard!.text(id, `model|${id}`)
            if (i % 2 === 1) keyboard!.row()
          })
          hint = '\n(gateway session — Claude aliases won\'t route; or type /model <name>)'
        }
      } catch (err) {
        process.stderr.write(`kushbot: gateway model list failed: ${err}\n`)
      }
    }
    if (!keyboard) {
      keyboard = new InlineKeyboard()
        .text('Latest Sonnet', 'model|sonnet')
        .text('Latest Opus', 'model|opus')
        .text('Latest Fable', 'model|fable')
    }
    try {
      await ctx.reply(`Current model: ${current}${curEffort ? ` · effort: ${curEffort}` : ''}\nTap to switch:${hint}`, { reply_markup: keyboard })
    } catch (err) {
      process.stderr.write(`kushbot: /model reply failed: ${err}\n`)
    }
  })

  // /effort — change the session's reasoning effort without touching the model.
  // Same verified-inject pattern as /model: buttons → /effort <level> in the
  // TUI → pane-scrape confirmation (never report an unconfirmed switch).
  bot.command('effort', async ctx => {
    if (ctx.chat?.type !== 'private') return
    const from = ctx.from
    if (!from) return
    if (!loadAccess().allowFrom.includes(String(from.id))) {
      await ctx.reply('Not paired — /effort is only available to allowlisted senders.').catch(() => {})
      return
    }
    if (CODEX_MODE) { emitCommandNotification(ctx, 'effort', String(ctx.match ?? '').trim()); return }
    const cur = effortForHome(homedir())
    const kb = new InlineKeyboard()
      .text('low', 'effort|low').text('medium', 'effort|medium').text('high', 'effort|high').row()
      .text('xhigh', 'effort|xhigh').text('max', 'effort|max').text('keep', 'effort|keep')
    await ctx.reply(`Current effort: ${cur ?? 'unknown'}\nTap to change:`, { reply_markup: kb }).catch(() => {})
  })

  // /stop — interrupt the agent mid-work by sending ESC to the live TUI (tmux
  // send-keys is the only thing that reaches the running session). After this,
  // the owner just sends his new instruction as a normal message. tmux-only.
  bot.command('stop', async ctx => {
    if (ctx.chat?.type !== 'private') return
    const from = ctx.from
    if (!from) return
    if (!loadAccess().allowFrom.includes(String(from.id))) {
      await ctx.reply('Not paired — /stop is only available to allowlisted senders.').catch(() => {})
      return
    }
    if (CODEX_MODE) { emitCommandNotification(ctx, 'stop', ''); return }
    const ok = sendRawKey('Escape')
    if (!ok) {
      await ctx.reply("Can't interrupt — this session isn't running in tmux.").catch(() => {})
      return
    }
    // Verify the interrupt actually took: while a turn runs, the TUI shows
    // "esc to interrupt". If it's still there after the ESC, we didn't stop
    // anything (ESC may have just closed a dialog). Don't claim otherwise.
    const sleepP = (ms: number) => new Promise(r => setTimeout(r, ms))
    await sleepP(1200)
    let paneNow = ''
    try {
      const { tmuxSession } = getSessionContext()
      if (tmuxSession) paneNow = execSync(`tmux capture-pane -t ${shq(tmuxSession)} -p -J -S -15`).toString()
    } catch {}
    const stillRunning = /esc to interrupt/i.test(paneNow)
    await ctx.reply(stillRunning
      ? '⚠️ Sent ESC but the agent is still mid-turn (it may have closed a dialog instead). Send /stop again.'
      : '⛔ Interrupted. Send your new instruction now.'
    ).catch(() => {})
  })

  // /wf — live workflow view. Finds the newest running Workflow across all
  // sessions, renders a phase/agent status board, then edits that one message
  // in place every few seconds until the run finishes (no notification spam).
  // If nothing is running, shows the most recent completed run as a snapshot.
  bot.command('wf', async ctx => {
    if (ctx.chat?.type !== 'private') return
    const from = ctx.from
    if (!from) return
    if (!loadAccess().allowFrom.includes(String(from.id))) {
      await ctx.reply('Not paired — /wf is only available to allowlisted senders.').catch(() => {})
      return
    }
    const found = findActiveWorkflow()
    if (!found) { await ctx.reply('No workflows found.').catch(() => {}); return }
    // Session/project context so the user can tell WHOSE run they're watching
    // (findActiveWorkflow scans every session on the box). Path shapes:
    //   legacy  ~/.claude/projects/<project>/<session>/workflows/wf_*.json
    //   journal ~/.claude/projects/<project>/<session>/subagents/workflows/wf_*/
    const anchorPath = found.kind === 'legacy' ? found.path : found.run.dir
    const wfParts = anchorPath.split('/')
    const wfProject = (found.kind === 'legacy' ? wfParts[wfParts.length - 4] : wfParts[wfParts.length - 5]) ?? '?'
    const wfCtxLine = `\n<i>project: ${esc(wfProject)}</i>`
    // Snapshot mode: say how long ago it ended — a 3-day-old run must not read as live.
    let staleLine = ''
    if (!found.running) {
      const endedMs = found.kind === 'journal' ? found.state.lastMs
        : (() => { try { return statSync(found.path).mtimeMs } catch { return 0 } })()
      if (endedMs) staleLine = `\n<i>ended ${fmtAge(endedMs)} — static snapshot</i>`
    }
    let lastText = found.kind === 'legacy' ? renderWorkflow(found.data) : renderJournalWf(found.state)
    let sent
    try {
      sent = await ctx.reply(lastText + wfCtxLine + staleLine, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
    } catch (err) {
      process.stderr.write(`kushbot: /wf reply failed: ${err}\n`)
      return
    }
    if (!found.running) return  // static snapshot — nothing to poll
    const chatId = ctx.chat.id
    const messageId = sent.message_id
    const startedAt = Date.now()
    // Watcher death must never be silent (2026-07-03 audit): every exit path
    // below either pushes a NEW message (edits don't notify on Telegram) or
    // explains itself on the board. parseFails tolerates transient partial
    // JSON (the legacy wf file is rewritten in place; a read mid-rewrite used
    // to permanently kill the watcher on the first hiccup).
    let parseFails = 0
    const stopWatch = async (note: string, push: boolean) => {
      try {
        await bot.api.editMessageText(chatId, messageId, `${lastText}\n\n<i>${esc(note)}</i>${wfCtxLine}`, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
      } catch {}
      if (push) {
        try { await bot.api.sendMessage(chatId, note, { link_preview_options: { is_disabled: true } } as any) } catch {}
      }
    }
    const timer = setInterval(async () => {
      if (Date.now() - startedAt > WF_MAX_MS) {
        clearInterval(timer)
        void stopWatch('⏸ /wf watcher expired (30m cap) — the workflow is still running. Send /wf again to re-watch.', true)
        return
      }

      if (found.kind === 'journal') {
        // Re-derive state from the run dir each tick.
        let st: JournalWfState | null = null
        try { st = journalWfState({ ...found.run, mtime: journalRunMtime(found.run.dir) }) } catch {}
        if (!st) {
          clearInterval(timer)
          void stopWatch('⚠️ /wf watcher stopped — workflow journal unreadable (deleted or rotated). Send /wf to re-check.', true)
          return
        }
        const newText = renderJournalWf(st)
        if (newText !== lastText) {
          lastText = newText
          try {
            await bot.api.editMessageText(chatId, messageId, newText + wfCtxLine, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
          } catch { /* not modified / rate limit — ignore */ }
        }
        if (!st.running) {
          clearInterval(timer)
          const dur = fmtDur(st.lastMs - st.startMs)
          const note = st.inflight > 0
            ? `⚠️ workflow "${st.name}" went quiet with ${st.inflight} agent(s) still in flight — stalled, or its session was stopped. ${st.done}/${st.started} agents returned · ${dur}`
            : `✅ workflow "${st.name}" finished — ${st.started} agents · ${dur}`
          try { await bot.api.sendMessage(chatId, note, { link_preview_options: { is_disabled: true } } as any) } catch {}
        }
        return
      }

      // legacy layout: read the state json
      let data: any
      try {
        data = JSON.parse(readFileSync(found.path, 'utf8'))
        parseFails = 0
      } catch {
        parseFails++
        if (parseFails >= 5) {
          clearInterval(timer)
          void stopWatch('⚠️ /wf watcher stopped — workflow state file unreadable (deleted or rotated). Send /wf to re-check.', true)
        }
        return
      }
      const terminal = WF_TERMINAL.has(String(data.status))
      const newText = renderWorkflow(data)
      if (newText !== lastText) {
        lastText = newText
        try {
          await bot.api.editMessageText(chatId, messageId, newText + wfCtxLine, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
        } catch { /* "message is not modified" / rate limit — ignore */ }
      }
      if (terminal) {
        clearInterval(timer)
        // Push a NEW message on completion — the in-place edit above never
        // notifies, which was the original complaint ("no good visibility
        // when the workflow completed").
        const st = String(data.status)
        const emoji = st === 'completed' ? '✅' : st === 'failed' ? '❌' : '🛑'
        const name = String(data.workflowName || data.runId || 'workflow')
        const dur = fmtDur(Number(data.durationMs || (Date.now() - (Number(data.startTime) || Date.now()))))
        const agents = data.agentCount != null ? `${data.agentCount} agents · ` : ''
        const toks = data.totalTokens ? `${fmtNum(Number(data.totalTokens))} tok · ` : ''
        try {
          await bot.api.sendMessage(chatId, `${emoji} workflow "${name}" ${st} — ${agents}${toks}${dur}`, { link_preview_options: { is_disabled: true } } as any)
        } catch {}
      }
    }, WF_POLL_MS)
    timer.unref?.()
  })

  // /account — inspect which account this session is on + per-account quota;
  // /account <label> switches THIS session to that account (relaunches the pane
  // on the new token, resuming the same conversation). tmux-only for the switch.
  bot.command('account', async ctx => {
    if (ctx.chat?.type !== 'private') return
    const from = ctx.from
    if (!from) return
    if (!loadAccess().allowFrom.includes(String(from.id))) {
      await ctx.reply('Not paired — /account is only available to allowlisted senders.').catch(() => {})
      return
    }
    const arg = String(ctx.match ?? '').trim()
    const labels = listAccountLabels()

    if (!arg) {
      // INSPECT — this session's account (hash-resolved, reliable) + LIVE quota.
      const cur = fmtSelfAccount()
      const labelList = labels.length ? labels.map(l => `<code>${esc(l)}</code>`).join(' · ') : '<i>none saved</i>'
      const usage = await renderAccountUsageLive()
      const msg = `<b>This session:</b> ${esc(cur)}\n\n<b>Quota per account</b> <i>(live)</i>\n${usage}\n\n`
        + `<b>Saved accounts:</b> ${labelList}\nSwitch this session: <code>/account &lt;label&gt;</code>`
      try { await ctx.reply(msg, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }) }
      catch (err) { process.stderr.write(`kushbot: /account inspect failed: ${err}\n`) }
      return
    }

    // /account login — switch account MID-FLIGHT, NO restart. Drives the session's
    // /login (subscription), relays the OAuth URL; user logs in as the target account
    // and sends `/account code <code>` to complete. The running session swaps its auth
    // in place — no relaunch. (Doesn't use the saved setup-tokens; it's a fresh login.)
    if (arg === 'login') {
      const { tmuxSession } = getSessionContext()
      if (!tmuxSession) { await ctx.reply("Can't /login — this session isn't in tmux.").catch(() => {}); return }
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
      try {
        execSync(`tmux send-keys -t ${shq(tmuxSession)} ${shq('/login')} Enter`)
        await sleep(2000)
        execSync(`tmux send-keys -t ${shq(tmuxSession)} Enter`)  // pick "Claude subscription"
        let url: string | undefined
        for (let i = 0; i < 8 && !url; i++) {
          await sleep(2000)
          const pane = execSync(`tmux capture-pane -t ${shq(tmuxSession)} -p -J`).toString()
          url = (pane.match(/https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s]+/) || [])[0]
        }
        if (!url) { await ctx.reply('Started /login but couldn’t read the URL — check the session pane.').catch(() => {}); return }
        await ctx.reply(
          `🔐 Open this, log in as the account you want, then send me the code:\n\n${esc(url)}\n\nThen: <code>/account code &lt;the-code&gt;</code> (it has a # in it — paste the whole thing). Switches in place, no restart.`,
          { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
        )
      } catch (err) {
        process.stderr.write(`kushbot: /account login failed: ${err}\n`)
        await ctx.reply('login drive failed — check the session.').catch(() => {})
      }
      return
    }

    // /account code <code> — paste the OAuth code into the waiting /login prompt.
    // set-buffer + paste-buffer (NOT send-keys, which mangles the '#' in the code).
    if (arg.startsWith('code ')) {
      const code = arg.slice(5).trim()
      const { tmuxSession } = getSessionContext()
      if (!tmuxSession) { await ctx.reply("Can't paste — this session isn't in tmux.").catch(() => {}); return }
      if (!code) { await ctx.reply('Usage: /account code &lt;the-code&gt;', { parse_mode: 'HTML' }).catch(() => {}); return }
      try {
        execSync(`tmux set-buffer ${shq(code)}`)
        execSync(`tmux paste-buffer -t ${shq(tmuxSession)}`)
        execSync(`tmux send-keys -t ${shq(tmuxSession)} Enter`)
        await ctx.reply('✅ Code submitted — switching account in place, no restart. Give it ~10s, then /account to confirm.').catch(() => {})
      } catch (err) {
        process.stderr.write(`kushbot: /account code failed: ${err}\n`)
        await ctx.reply('code paste failed.').catch(() => {})
      }
      return
    }

    // SWITCH (token-based). The old path built `kc`/`dc` — Mac aliases — and ran
    // them via `zsh -ic` in a respawned pane. On server every single-mode bot is
    // internally slot 0, so it ALWAYS hit the `kc` branch, `kc` doesn't exist, and
    // the pane died: the 2026-07-09 "account switch went dark" + 2026-07-10
    // forwarded-/account incidents. Now: validate against the setup-token store,
    // require a confirm tap (this DOES restart the session), then hand off to the
    // detached, quiet, resume-preserving account-switch.sh.
    if (!switchableAccounts().includes(arg)) {
      await ctx.reply(`No switchable account '${esc(arg)}'. Available: ${switchableAccounts().join(', ') || 'none'} · or fresh login: <code>/account login</code>`, { parse_mode: 'HTML' }).catch(() => {})
      return
    }
    if (!existsSync(switchTokenPath(arg))) {
      await ctx.reply(`No setup-token stored for '${esc(arg)}' at <code>${esc(switchTokenPath(arg))}</code>.`, { parse_mode: 'HTML' }).catch(() => {})
      return
    }
    if (!getSessionContext().tmuxSession) {
      await ctx.reply("Can't switch — this session isn't running in tmux.").catch(() => {})
      return
    }
    if (!selfAgentName()) {
      await ctx.reply("Can't switch — this bot has no fleet-registry entry for its HOME, so the restart can't be driven safely.").catch(() => {})
      return
    }
    const kb = new InlineKeyboard()
      .text(`🔄 Switch to ${arg}`, `acct|${arg}`)
      .text('Cancel', 'acct|cancel')
    await ctx.reply(`Switch this session to <b>${esc(arg)}</b>?\nThis restarts the session — same conversation resumes (~15s), no going-dark ping.`, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {})
  })

  // /quota: every AI budget in one message. claude work, claude personal, codex,
  // grok, plus which of them is on track to waste its weekly budget. kc and kai
  // only: the numbers are account-wide, so a son answering would be a duplicate
  // reply plus a duplicate live probe against the same accounts.
  bot.command('quota', async ctx => {
    if (ctx.chat?.type !== 'private') return
    const from = ctx.from
    if (!from) return
    if (!loadAccess().allowFrom.includes(String(from.id))) {
      await ctx.reply('Not paired. /quota is only available to allowlisted senders.').catch(() => {})
      return
    }
    if (!quotaAllowed()) { await ctx.reply(QUOTA_DENIAL).catch(() => {}); return }
    // The live probes take a few seconds; ack so the tap does not look dead.
    try { await ctx.react('👀') } catch {}
    let msg: string
    try { msg = await renderQuota() } catch (err) {
      process.stderr.write(`kushbot: /quota failed: ${err}\n`)
      msg = '<b>Quota</b>\n<i>quota.sh failed. Check the pane.</i>'
    }
    await ctx.reply(msg, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }).catch(() => {})
  })

  // /outbox — this agent's A2A send log with delivery status. Incoming mail is
  // already mirrored in realtime; this is the on-demand OUTGOING view.
  bot.command('outbox', async ctx => {
    if (ctx.chat?.type !== 'private') return
    const from = ctx.from
    if (!from) return
    if (!loadAccess().allowFrom.includes(String(from.id))) {
      await ctx.reply('Not paired — /outbox is only available to allowlisted senders.').catch(() => {})
      return
    }
    const root = fleetRootDir()
    if (!root) { await ctx.reply('Fleet messaging not configured on this host.').catch(() => {}); return }
    let lines: string[] = []
    try {
      lines = readFileSync(join(root, fleetSelf(), 'outbox.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
    } catch {}
    if (!lines.length) { await ctx.reply(`No agent-to-agent messages sent by ${fleetSelf()} yet.`).catch(() => {}); return }
    const receipts = fleetReceipts()
    const rows = lines.slice(-15).reverse().map(l => {
      try {
        const e = JSON.parse(l)
        const r = receipts.get(String(e.id))
        const mark = !r ? '⏳ queued'
          : r.delivered === false ? '✗ failed'
          : `✓ ${String(r.delivered_ts).slice(11, 16)}Z`
        const body = String(e.body ?? '').replace(/\s+/g, ' ').slice(0, 80)
        return `${mark}  →${esc(String(e.to))}  ${String(e.ts).slice(5, 16)}  ${esc(body)}`
      } catch { return null }
    }).filter(Boolean) as string[]
    await ctx.reply(`<b>Outbox — ${esc(fleetSelf())}</b> (last ${rows.length})\n<pre>${rows.join('\n')}</pre>`, { parse_mode: 'HTML' }).catch(() => {})
  })

  // /peers — the fleet registry (who this agent may message).
  bot.command('peers', async ctx => {
    if (ctx.chat?.type !== 'private') return
    const from = ctx.from
    if (!from) return
    if (!loadAccess().allowFrom.includes(String(from.id))) {
      await ctx.reply('Not paired — /peers is only available to allowlisted senders.').catch(() => {})
      return
    }
    const agents = fleetRegistry()
    if (!agents.length) { await ctx.reply('Fleet registry empty or not configured.').catch(() => {}); return }
    const self = fleetSelf()
    // Live stats per LOCAL agent (the owner 2026-07-07): account (work/personal),
    // model + effort, ctx%. Remote agents show the relay marker only — their
    // stats live on the other machine.
    const acct = fleetAccountMap()
    const rows = agents.map(a => {
      const here = a.name === self ? ' ←' : ''
      if (a.machine !== STATE.machine) {
        return `${a.name.padEnd(8)} [${a.machine} · via relay]`
      }
      let stats = ''
      if (a.home) {
        const account = acct.byHome.get(a.home) ?? acct.machine
        const cache = readStatusCache(newestSessionForHome(a.home))
        const model = (cache?.model ?? '?').replace(/\s*\(.*\)$/, '')   // strip "(1M context)"
        const effort = effortForHome(a.home)
        const ctx2 = cache?.ctx_pct != null ? `${Math.round(cache.ctx_pct)}%` : '—'
        stats = `${account.padEnd(9)} ${(model + (effort ? '/' + effort : '')).padEnd(16)} ctx ${ctx2}`
      }
      const role = (a.role ?? '').slice(0, 48)
      return `${a.name.padEnd(8)} ${stats}${here}${role ? `\n         ${role}` : ''}`
    })
    await ctx.reply(`<b>Fleet peers</b> · account ${esc(acct.machine)} (* = own token)\n<pre>${esc(rows.join('\n'))}</pre>`, { parse_mode: 'HTML' }).catch(() => {})
  })

  // /compact, /clear, /reload — actually RUN the slash command in the live
  // Claude TUI via tmux send-keys (the only mechanism that executes; an MCP
  // channel notification would land as literal chat text). tmux-only — falls
  // back to an honest "can't run remotely" reply when not in a pane. Only
  // allowlisted senders may trigger these (they steer the live session).
  for (const [name, slash] of Object.entries(INJECT_COMMANDS)) {
    bot.command(name, async ctx => {
      if (ctx.chat?.type !== 'private') return
      const from = ctx.from
      if (!from) return
      const senderId = String(from.id)
      const access = loadAccess()
      if (!access.allowFrom.includes(senderId)) {
        await ctx.reply(`Not paired — /${name} is only available to allowlisted senders.`).catch(() => {})
        return
      }
      // CODEX_MODE: route /clear + /compact to the bridge (app-server). /reload is
      // a Claude-TUI concept with no codex analog — leave it on the tmux path.
      if (CODEX_MODE && (name === 'clear' || name === 'compact')) {
        emitCommandNotification(ctx, name, '')
        return
      }
      // /clear is one-tap destructive (wipes the session, sits next to
      // /compact in the slash menu) — require an explicit confirm tap.
      if (name === 'clear') {
        const kb = new InlineKeyboard()
          .text('🗑 Yes, wipe the session', 'inject|clear')
          .text('Cancel', 'inject|cancel')
        await ctx.reply('⚠️ /clear wipes this session\'s memory. Sure?', { reply_markup: kb }).catch(() => {})
        return
      }
      await runInjectVerified(ctx, name, slash)
    })
  }

  bot.on('callback_query:data', async ctx => {
    const data = ctx.callbackQuery.data

    // /clear confirm buttons.
    const inj = /^inject\|(clear|cancel)$/.exec(data)
    if (inj) {
      const senderId = String(ctx.from.id)
      if (!loadAccess().allowFrom.includes(senderId)) {
        await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
        return
      }
      await ctx.answerCallbackQuery().catch(() => {})
      if (inj[1] === 'cancel') {
        await ctx.editMessageText('Cancelled — session untouched.').catch(() => {})
        return
      }
      await ctx.editMessageText('🗑 Clearing…').catch(() => {})
      await runInjectVerified(ctx as unknown as Context, 'clear', '/clear')
      return
    }

    // /account switch confirm buttons.
    const acct = /^acct\|(cancel|[a-z0-9_-]+)$/.exec(data)
    if (acct) {
      const senderId = String(ctx.from.id)
      if (!loadAccess().allowFrom.includes(senderId)) {
        await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
        return
      }
      await ctx.answerCallbackQuery().catch(() => {})
      if (acct[1] === 'cancel') {
        await ctx.editMessageText('Cancelled — account unchanged.').catch(() => {})
        return
      }
      const label = acct[1]
      const chatId = String(ctx.chat?.id ?? senderId)
      await ctx.editMessageText(`🔄 Switching to ${label} — restarting, your conversation resumes in ~15s…`).catch(() => {})
      if (state.currentBot) await doAccountSwitch(state.currentBot, label, chatId)
      return
    }

    // `ask` option buttons: resolve the tap to its label, stamp the message,
    // and deliver the choice into the session as a normal inbound message.
    const askM = /^ask\|([a-z0-9]{6})\|(\d+)$/.exec(data)
    if (askM) {
      const senderId = String(ctx.from.id)
      const askAccess = loadAccess()
      if (!askAccess.allowFrom.includes(senderId)) {
        await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
        return
      }
      const [, nonce, idxStr] = askM
      const pending = pendingAsks.get(nonce)
      if (!pending) {
        // Stamp the message so dead buttons stop looking tappable — the
        // transient toast alone was invisible (2026-07-03 audit).
        await ctx.answerCallbackQuery({ text: 'This question has expired.' }).catch(() => {})
        const dead = ctx.callbackQuery.message
        if (dead && 'text' in dead && dead.text) {
          await ctx.editMessageText(`${dead.text}\n\n⌛ expired (bot restarted) — ask again if still relevant`).catch(() => {})
        }
        return
      }
      // MULTI-SELECT: a tap toggles, it does not answer. Redraw the checkboxes
      // via editMessageReplyMarkup (an edit does NOT push a notification, so
      // ticking five boxes costs zero pings) and keep the ask open until Done.
      if (pending.multi) {
        const idx = Number(idxStr)
        const sel = new Set(pending.selected ?? [])
        if (sel.has(idx)) sel.delete(idx); else sel.add(idx)
        const selected = [...sel].sort((a, b) => a - b)
        pendingAsks.set(nonce, { ...pending, selected })
        savePending()
        await ctx.answerCallbackQuery({
          text: `${sel.has(idx) ? '☑' : '☐'} ${pending.options[idx] ?? ''}`,
        }).catch(() => {})
        await ctx.editMessageReplyMarkup({
          reply_markup: multiAskKeyboard(nonce, pending.options, selected),
        }).catch(() => {})
        return
      }

      const choice = pending.options[Number(idxStr)] ?? `option ${idxStr}`
      pendingAsks.delete(nonce)
      savePending()
      await ctx.answerCallbackQuery({ text: choice }).catch(() => {})
      await ctx.editMessageText(`❓ ${pending.question}\n→ ✅ ${choice}`).catch(() => {})
      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `[ask] ${pending.question} → ${choice}`,
          meta: {
            source: 'telegram',   // see handleInbound for why
            chat_id: String(ctx.chat?.id ?? pending.chatId),
            user: ctx.from.username ?? String(ctx.from.id),
            user_id: senderId,
            ts: new Date().toISOString(),
          },
        },
      }).catch(err => {
        process.stderr.write(`kushbot: failed to deliver ask choice: ${err}\n`)
      })
      return
    }

    // Multi-select "Done" — resolve the ask with everything ticked.
    const askDone = /^askdone\|([a-z0-9]{6})$/.exec(data)
    if (askDone) {
      const senderId = String(ctx.from.id)
      if (!loadAccess().allowFrom.includes(senderId)) {
        await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
        return
      }
      const nonce = askDone[1]
      const pending = pendingAsks.get(nonce)
      if (!pending) {
        await ctx.answerCallbackQuery({ text: 'This question has expired.' }).catch(() => {})
        return
      }
      const picked = (pending.selected ?? []).map(i => pending.options[i]).filter(Boolean)
      if (picked.length === 0) {
        // Don't resolve an empty multi-select — it reads as "no answer" to the
        // session, which is indistinguishable from a bug. Nudge instead.
        await ctx.answerCallbackQuery({ text: 'Pick at least one, or say so in chat.' }).catch(() => {})
        return
      }
      pendingAsks.delete(nonce)
      savePending()
      const answer = picked.join(', ')
      await ctx.answerCallbackQuery({ text: `✅ ${picked.length} selected` }).catch(() => {})
      await ctx.editMessageText(`❓ ${pending.question}\n→ ✅ ${answer}`).catch(() => {})
      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `[ask] ${pending.question} → ${answer}`,
          meta: {
            source: 'telegram',
            chat_id: String(ctx.chat?.id ?? pending.chatId),
            user: ctx.from.username ?? String(ctx.from.id),
            user_id: senderId,
            ts: new Date().toISOString(),
          },
        },
      }).catch(err => {
        process.stderr.write(`kushbot: failed to deliver multi-ask choice: ${err}\n`)
      })
      return
    }

    // Gateway model buttons (free-form ids from the gateway /model keyboard):
    // route through performModelSwitch, then chain the effort picker like the
    // alias path does. Aliases fall through to the original block below.
    const gm = /^model\|([A-Za-z0-9._-]{1,48})$/.exec(data)
    if (gm && !/^(sonnet|opus|fable)$/.test(gm[1])) {
      const senderId = String(ctx.from.id)
      if (!loadAccess().allowFrom.includes(senderId)) {
        await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
        return
      }
      const name = gm[1]
      await ctx.answerCallbackQuery({ text: 'Switching to ' + name }).catch(() => {})
      const sw = await performModelSwitch(name)
      if (sw.result === 'switched') {
        const kb = new InlineKeyboard()
          .text('low', 'effort|low').text('medium', 'effort|medium').text('high', 'effort|high').row()
          .text('xhigh', 'effort|xhigh').text('max', 'effort|max').text('keep', 'effort|keep')
        await ctx.editMessageText(
          `🔀 Switched model → ${name}\n\nEffort? (current: ${effortForHome(homedir()) ?? 'unknown'})`,
          { reply_markup: kb }
        ).catch(() => {})
        return
      }
      const finalMsg =
        sw.result === 'notmux' ? "Can't switch — session not in tmux" :
        sw.result === 'rejected' ? `⚠️ Model switch to ${name} rejected:\n\n${sw.detail}` :
        `🤷 Sent /model ${name} — couldn't confirm from pane. Check the session.`
      await ctx.editMessageText(finalMsg).catch(() => {})
      return
    }

    // `model` switch buttons: run `/model <alias>` in the tmux pane. Then verify
    // by scraping the pane — Claude can REJECT the switch (model unavailable,
    // wrong entitlement, requires /login, etc) and we don't want to report
    // false success. If a known failure line appears within ~4s, surface it.
    const mm = /^model\|(sonnet|opus|fable)$/.exec(data)
    if (mm) {
      const senderId = String(ctx.from.id)
      if (!loadAccess().allowFrom.includes(senderId)) {
        await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
        return
      }
      const alias = mm[1]
      const ok = sendKeysToSession('/model ' + alias)
      await ctx.answerCallbackQuery({ text: ok ? 'Switching to ' + alias : 'not in tmux' }).catch(() => {})
      if (!ok) {
        await ctx.editMessageText("Can't switch — session not in tmux").catch(() => {})
        return
      }
      // Scrape pane for a rejection line. Auto-confirm the CLI prompt too:
      // when Claude Code asks "Yes, switch to X" via a keyboard picker, the
      // /model <alias> keystroke populates the input but doesn't confirm.
      // A subsequent "1" + Enter accepts the default choice (Yes, switch).
      const { tmuxSession } = getSessionContext()
      const sleep2 = (ms: number) => new Promise(r => setTimeout(r, ms))
      let paneOut = ''
      let result: 'switched' | 'rejected' | 'unknown' = 'unknown'
      let rejectionLine = ''
      const failurePatterns: Array<[RegExp, string]> = [
        [/is not currently available/i, 'model unavailable'],
        [/currently unavailable/i, 'model unavailable'],
        [/Please run \/login/i, 'needs /login'],
        [/Invalid authentication credentials/i, '401 — needs /login'],
        [/model not found/i, 'model not found'],
        [/insufficient/i, 'insufficient permissions'],
      ]
      const successPatterns: RegExp[] = [
        new RegExp(`Set model to.*${alias}`, 'i'),
        new RegExp(`switched.*${alias}`, 'i'),
      ]
      // Poll up to ~4s (8 × 500ms).
      for (let i = 0; i < 8; i++) {
        await sleep2(500)
        try {
          paneOut = execSync(`tmux capture-pane -t ${shq(tmuxSession!)} -p -J -S -30`).toString()
        } catch { continue }
        // Detect + auto-confirm the "Yes, switch to X / No, go back" picker.
        if (/Yes,\s*switch\s*to/i.test(paneOut) && /No,\s*go\s*back/i.test(paneOut)) {
          try { execSync(`tmux send-keys -t ${shq(tmuxSession!)} 1 Enter`) } catch {}
          continue
        }
        for (const [rx, tag] of failurePatterns) {
          const m2 = paneOut.match(rx)
          if (m2) {
            result = 'rejected'
            // Grab a slice of surrounding context for the error line.
            const line = paneOut.split('\n').find(l => rx.test(l)) || tag
            rejectionLine = line.trim().slice(0, 200) || tag
            break
          }
        }
        if (result === 'rejected') break
        if (successPatterns.some(rx => rx.test(paneOut))) { result = 'switched'; break }
      }
      if (result === 'switched') {
        // Chain the effort picker (the owner 2026-07-07: "/model should also let
        // me change effort after selecting the model").
        const kb = new InlineKeyboard()
          .text('low', 'effort|low').text('medium', 'effort|medium').text('high', 'effort|high').row()
          .text('xhigh', 'effort|xhigh').text('max', 'effort|max').text('keep', 'effort|keep')
        await ctx.editMessageText(
          `🔀 Switched model → ${alias}\n\nEffort? (current: ${effortForHome(homedir()) ?? 'unknown'})`,
          { reply_markup: kb }
        ).catch(() => {})
        return
      }
      const finalMsg = result === 'rejected'
        ? `⚠️ Model switch to ${alias} rejected:\n\n${rejectionLine}`
        : `🤷 Sent /model ${alias} — couldn't confirm from pane (no rejection line, no success line). Check the session.`
      await ctx.editMessageText(finalMsg).catch(() => {})
      return
    }

    // `effort` buttons (from /effort or chained after a /model switch): run
    // `/effort <level>` in the tmux pane, verify via pane scrape — Claude Code
    // prints "Set effort level to <level> ..." on success.
    const em = /^effort\|(low|medium|high|xhigh|max|keep)$/.exec(data)
    if (em) {
      const senderId = String(ctx.from.id)
      if (!loadAccess().allowFrom.includes(senderId)) {
        await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
        return
      }
      const level = em[1]
      if (level === 'keep') {
        await ctx.answerCallbackQuery().catch(() => {})
        await ctx.editMessageText(`✅ Effort unchanged (${effortForHome(homedir()) ?? 'current'}).`).catch(() => {})
        return
      }
      const ok = sendKeysToSession('/effort ' + level)
      await ctx.answerCallbackQuery({ text: ok ? 'Setting effort ' + level : 'not in tmux' }).catch(() => {})
      if (!ok) {
        await ctx.editMessageText("Can't set effort — session not in tmux").catch(() => {})
        return
      }
      const { tmuxSession } = getSessionContext()
      const sleepE = (ms: number) => new Promise(r => setTimeout(r, ms))
      let confirmed = false
      for (let i = 0; i < 8; i++) {
        await sleepE(500)
        let pane = ''
        try { pane = execSync(`tmux capture-pane -t ${shq(tmuxSession!)} -p -J -S -20`).toString() } catch { continue }
        if (new RegExp(`Set effort level to ${level}`, 'i').test(pane)) { confirmed = true; break }
      }
      await ctx.editMessageText(confirmed
        ? `⚡ Effort → ${level}`
        : `🤷 Sent /effort ${level} — couldn't confirm from pane. Check the session (/status).`
      ).catch(() => {})
      return
    }

    const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(data)
    if (!m) { await ctx.answerCallbackQuery().catch(() => {}); return }
    const access = loadAccess()
    const senderId = String(ctx.from.id)
    // Permission decisions are operator-only — a shared user (a teammate/a family member/
    // another teammate on guru/vaidya/rishi/raju) must not be able to Allow tool calls
    // even if a prompt reaches them (e.g. forwarded).
    if (!opsRecipients(access).includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Only the bot operator can act on permissions.' }).catch(() => {})
      return
    }
    const [, behavior, request_id] = m
    if (behavior === 'more') {
      const details = pendingPermissions.get(request_id)
      if (!details) {
        await ctx.answerCallbackQuery({ text: 'Details no longer available.' }).catch(() => {})
        return
      }
      const { tool_name, description, input_preview } = details
      let prettyInput: string
      try { prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2) } catch { prettyInput = input_preview }
      const expanded =
        `🔐 Permission: ${tool_name}\n\n` +
        `tool_name: ${tool_name}\n` +
        `description: ${description}\n` +
        `input_preview:\n${prettyInput}`
      const keyboard = new InlineKeyboard()
        .text('✅ Allow', `perm:allow:${request_id}`)
        .text('❌ Deny', `perm:deny:${request_id}`)
      await ctx.editMessageText(expanded, { reply_markup: keyboard }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }
    void mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id, behavior },
    })
    pendingPermissions.delete(request_id)
    savePending()
    const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
    await ctx.answerCallbackQuery({ text: label }).catch(() => {})
    const msg = ctx.callbackQuery.message
    if (msg && 'text' in msg && msg.text) {
      await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
    }
  })

  bot.on('message:text', async ctx => {
    await handleInbound(ctx, ctx.message.text, undefined)
  })

  bot.on('message:photo', async ctx => {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    const gid = ctx.message.media_group_id
    if (gid) {
      // Album item — buffer + debounce (see flushAlbum). Handler returns
      // immediately: zero time on the sequential update queue.
      const entry = albumBuf.get(gid)
      if (entry) {
        clearTimeout(entry.timer)
        entry.items.push({ id: best.file_id, uid: best.file_unique_id })
        if (ctx.message.caption && !entry.caption) entry.caption = ctx.message.caption
        entry.timer = setTimeout(() => { void flushAlbum(gid) }, ALBUM_DEBOUNCE_MS)
      } else {
        albumBuf.set(gid, {
          ctx,
          caption: ctx.message.caption,
          items: [{ id: best.file_id, uid: best.file_unique_id }],
          timer: setTimeout(() => { void flushAlbum(gid) }, ALBUM_DEBOUNCE_MS),
        })
      }
      return
    }
    const caption = ctx.message.caption ?? '(photo)'
    await handleInbound(ctx, caption, () => downloadPhotoToInbox(ctx.api, best.file_id, best.file_unique_id))
  })

  bot.on('message:document', async ctx => {
    const doc = ctx.message.document
    const name = safeName(doc.file_name)
    const text = ctx.message.caption ?? `(document: ${name ?? 'file'})`
    await handleInbound(ctx, text, undefined, {
      kind: 'document', file_id: doc.file_id, size: doc.file_size, mime: doc.mime_type, name,
    })
  })

  bot.on('message:voice', async ctx => {
    const voice = ctx.message.voice
    const placeholder = ctx.message.caption ?? '(voice message)'
    // Auto-transcribe before notifying claude (item 5, 2026-06-23). Saves the agent
    // two tool calls (download_attachment + Bash transcribe.sh) every voice turn. The
    // transcribe is blocking — bot-side ack-react (when access.ackReaction is set)
    // still fires from inside handleInbound, so user-visible "seen" timing is unchanged.
    // 180s ceiling — transcribe runs on the sequential update queue; a hung
    // Sarvam call must not stall every message behind it (normal runs: 5-15s).
    const tx = await withTimeout(runVoiceTranscribe(ctx, voice.file_id), 180_000, { error: 'transcribe timeout (180s)' })
    // Transcription failure must not be silent: the agent only sees
    // "(voice message)" and the spoken content is effectively lost unless
    // the user is told (2026-07-03 audit).
    if (!tx.transcript && tx.error && state.currentBot && ctx.chat) {
      void state.currentBot.api.sendMessage(String(ctx.chat.id),
        `🎤 Voice note received but transcription failed (${tx.error.slice(0, 120)}). The agent can't hear it — send as text if it matters.`,
      ).catch(() => {})
    }
    const content = tx.transcript ?? placeholder
    await handleInbound(ctx, content, undefined, {
      kind: 'voice', file_id: voice.file_id, size: voice.file_size, mime: voice.mime_type,
      local_path: tx.local_path,
      transcript: tx.transcript,
      transcript_error: tx.error,
    })
  })

  bot.on('message:audio', async ctx => {
    const audio = ctx.message.audio
    const name = safeName(audio.file_name)
    const text = ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`
    await handleInbound(ctx, text, undefined, {
      kind: 'audio', file_id: audio.file_id, size: audio.file_size, mime: audio.mime_type, name,
    })
  })

  bot.on('message:video', async ctx => {
    const video = ctx.message.video
    const text = ctx.message.caption ?? '(video)'
    await handleInbound(ctx, text, undefined, {
      kind: 'video', file_id: video.file_id, size: video.file_size, mime: video.mime_type, name: safeName(video.file_name),
    })
  })

  bot.on('message:video_note', async ctx => {
    const vn = ctx.message.video_note
    await handleInbound(ctx, '(video note)', undefined, {
      kind: 'video_note', file_id: vn.file_id, size: vn.file_size,
    })
  })

  bot.on('message:sticker', async ctx => {
    const sticker = ctx.message.sticker
    const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
    await handleInbound(ctx, `(sticker${emoji})`, undefined, {
      kind: 'sticker', file_id: sticker.file_id, size: sticker.file_size,
    })
  })
}

// Reply-to / quote / external-reply / forward-origin extractors (kushbot-improvements-recon
// items 2 + 3, 2026-06-23). Each returns a flat object of meta keys (no nested objects —
// the channel notification's `meta` is a flat map so the agent can read fields directly
// from the <channel ...> attribute list).
//
// Why this matters: the owner often sends long bursts in TG ("look at PR #142" → 3 more msgs →
// "yeah that one"). Without reply-to surfacing, the agent guesses which prior message the
// new turn refers to. The `quote` substring is even sharper — it pins focus to a specific
// line/sentence the owner selected when long-pressing his reply.
//
// UTF-16 note: Telegram's `quote.position` is a code-unit offset (matches JavaScript's
// native string indexing — `.substring(start, end)` is also code-unit-based). Emojis as
// surrogate pairs count as 2 units; that's fine, the slicer below stays consistent with TG.

const MAX_REPLY_TEXT_PREVIEW = 240   // truncate replied-to text for the meta surface
const MAX_QUOTE_TEXT = 480           // quote previews can be larger — they're the focus signal

function previewText(s: string | undefined, max: number): string | undefined {
  if (s == null) return undefined
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length === 0) return undefined
  return t.length <= max ? t : t.slice(0, max - 1) + '…'
}

function extractReplyContext(msg: Message | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!msg) return out

  // ctx.message.reply_to_message — user tapped "Reply" on a specific past message.
  // grammy types: `Message | undefined`. Surface the key identifying fields + a text preview.
  const r = msg.reply_to_message
  if (r) {
    out.reply_to_message_id = String(r.message_id)
    const senderName = r.from?.username ?? r.from?.first_name ?? (r.from ? String(r.from.id) : undefined)
    if (senderName) out.reply_to_from = senderName
    if (r.from?.is_bot) out.reply_to_from_is_bot = 'true'
    const rtext = previewText(('text' in r ? r.text : undefined) ?? ('caption' in r ? r.caption : undefined), MAX_REPLY_TEXT_PREVIEW)
    if (rtext) out.reply_to_text = rtext
    // If the replied-to message carried an attachment, surface kind so the agent doesn't
    // have to guess what "that screenshot" or "that voice" refers to.
    if ('photo' in r && r.photo) out.reply_to_kind = 'photo'
    else if ('voice' in r && r.voice) out.reply_to_kind = 'voice'
    else if ('audio' in r && r.audio) out.reply_to_kind = 'audio'
    else if ('video' in r && r.video) out.reply_to_kind = 'video'
    else if ('document' in r && r.document) out.reply_to_kind = 'document'
    else if ('sticker' in r && r.sticker) out.reply_to_kind = 'sticker'
  }

  // ctx.message.quote — when long-pressing "Reply" in TG, the user can select a substring
  // of the replied-to text. That selection arrives as a Quote object. is_manual=true means
  // user explicitly highlighted; false/undefined = client auto-quoted (less reliable signal).
  const q = msg.quote
  if (q) {
    const qt = previewText(q.text, MAX_QUOTE_TEXT)
    if (qt) out.quote_text = qt
    if (typeof q.position === 'number') out.quote_position = String(q.position)
    if (q.is_manual) out.quote_is_manual = 'true'
  }

  // ctx.message.external_reply — when the replied-to message is in a DIFFERENT chat
  // (forwarded from elsewhere as a reply context). Surface a lite summary; we don't
  // auto-download external media in v1.
  const er = msg.external_reply
  if (er) {
    out.external_reply = 'true'
    if (er.message_id) out.external_reply_message_id = String(er.message_id)
    const erText = previewText(('text' in er ? er.text : undefined), MAX_REPLY_TEXT_PREVIEW)
    if (erText) out.external_reply_text = erText
    // Origin tells us where the external message came from (user/hidden_user/chat/channel).
    if (er.origin?.type) out.external_reply_origin_type = er.origin.type
  }

  return out
}

function extractForwardOrigin(msg: Message | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!msg) return out
  const f = msg.forward_origin
  if (!f) return out

  // Discriminated union, 4 variants. Flatten to a `forward_type` discriminator + per-variant
  // fields, so agents can read e.g. forward_type="channel" + forward_chat="@somechannel" +
  // forward_message_id=42 without parsing nested JSON.
  out.forward_type = f.type
  out.forward_date = new Date(f.date * 1000).toISOString()

  if (f.type === 'user' && f.sender_user) {
    out.forward_from = f.sender_user.username ?? f.sender_user.first_name ?? String(f.sender_user.id)
    if (f.sender_user.is_bot) out.forward_from_is_bot = 'true'
  } else if (f.type === 'hidden_user') {
    out.forward_from = f.sender_user_name
    out.forward_from_hidden = 'true'  // user has privacy settings blocking direct attribution
  } else if (f.type === 'chat' && f.sender_chat) {
    out.forward_chat = f.sender_chat.username ?? f.sender_chat.title ?? String(f.sender_chat.id)
    if (f.author_signature) out.forward_signature = f.author_signature
  } else if (f.type === 'channel' && f.chat) {
    out.forward_chat = f.chat.username ?? f.chat.title ?? String(f.chat.id)
    out.forward_message_id = String(f.message_id)
    if (f.author_signature) out.forward_signature = f.author_signature
  }

  return out
}

// Auto-transcribe inbound voice notes via ~/.claude/skills/voice-bridge/transcribe.sh
// (item 5 of kushbot-improvements-recon, 2026-06-23). Downloads the .oga to slot inbox,
// shells out to the transcribe skill, returns the text. The voice handler calls this
// BEFORE handleInbound so the channel notification's content IS the transcript instead of
// the "(voice message)" placeholder — eliminates the agent's download + Bash round-trip.
//
// HOME pinning: the transcribe skill sources ~/.secrets/{sarvam,deepgram}-api-key.env,
// and those secrets live at /home/owner/.secrets/. Sons run kushbot under their own
// HOME (e.g. /home/owner/munshi-home), where ~/.secrets doesn't exist. We pin HOME
// for the spawned process to parent kai's home so the skill finds its keys regardless
// of which son's bot is calling.
// Machine-agnostic resolver: Mac uses ~/.claude/skills + normal HOME; server parent
// kai uses /home/owner/.claude + that HOME; server SONS run under their own HOME
// (e.g. ~/munshi-home, no skills dir) so they fall through to parent kai's path +
// pin HOME=/home/owner so the skill finds ~/.secrets keys. Was hardcoded to
// /home/owner — broke voice auto-transcribe on the Mac entirely.
function resolveTranscribe(): { bin: string; home: string } | null {
  const candidates = [
    { bin: join(homedir(), '.claude/skills/voice-bridge/transcribe.sh'), home: process.env.HOME || homedir() },
    { bin: '/home/owner/.claude/skills/voice-bridge/transcribe.sh', home: '/home/owner' },
  ]
  for (const c of candidates) { try { if (existsSync(c.bin)) return c } catch {} }
  return null
}
const TRANSCRIBE_TIMEOUT_MS = 30_000   // hard cap; >30s is almost always a stuck network

type TranscribeResult = {
  local_path?: string
  transcript?: string
  error?: string
}

async function runVoiceTranscribe(ctx: Context, fileId: string, fileExt: string = 'oga'): Promise<TranscribeResult> {
  if (state.currentSlot == null || !state.currentToken) return { error: 'no slot attached' }

  // Step 1: download via TG Bot API (mirrors the photo handler's download pattern).
  let localPath: string
  try {
    const file = await ctx.api.getFile(fileId)
    if (!file.file_path) return { error: 'getFile returned no file_path' }
    const url = `https://api.telegram.org/file/bot${state.currentToken}/${file.file_path}`
    const res = await fetch(url)
    if (!res.ok) return { error: `voice download HTTP ${res.status}` }
    const buf = Buffer.from(await res.arrayBuffer())
    const ext = (file.file_path.split('.').pop() ?? fileExt).slice(0, 8)
    localPath = join(slotInboxDir(state.currentSlot), `${Date.now()}-${fileId.slice(0, 16)}.${ext}`)
    mkdirSync(slotInboxDir(state.currentSlot), { recursive: true })
    writeFileSync(localPath, buf)
  } catch (err) {
    return { error: `voice download: ${err instanceof Error ? err.message : String(err)}` }
  }

  // Step 2: shell to transcribe.sh with HOME pinned for ~/.secrets resolution.
  // Retry up to 3× with backoff — the bulk of the 2026-07 "transcribe exit 1"
  // failures were transient (STT API 5xx / rate / network), and losing a spoken
  // instruction to a one-off flake is the expensive failure. Total worst case
  // (3 runs + backoff) stays under the 180s ceiling the caller enforces.
  const tb = resolveTranscribe()
  if (!tb) {
    return { local_path: localPath, error: 'transcribe.sh not found (~/.claude or /home/owner)' }
  }
  let lastErr = 'transcribe failed'
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const out = spawnSync('bash', [tb.bin, localPath], {
        env: { ...process.env, HOME: tb.home },
        timeout: TRANSCRIBE_TIMEOUT_MS,
        encoding: 'utf8',
      })
      if (out.error) lastErr = `transcribe spawn: ${out.error.message}`
      else if (out.status !== 0) lastErr = `transcribe exit ${out.status}: ${(out.stderr ?? '').trim().slice(0, 240) || '(no stderr)'}`
      else {
        const transcript = (out.stdout ?? '').trim()
        if (transcript) return { local_path: localPath, transcript }
        lastErr = 'transcribe returned empty'
      }
    } catch (err) {
      lastErr = `transcribe: ${err instanceof Error ? err.message : String(err)}`
    }
    if (attempt < 3) {
      process.stderr.write(`kushbot: transcribe attempt ${attempt} failed (${lastErr.slice(0, 80)}), retrying\n`)
      await new Promise(r => setTimeout(r, attempt * 1000))   // 1s, 2s backoff
    }
  }
  return { local_path: localPath, error: `${lastErr} (after 3 attempts)` }
}

// Hard ceiling on any inline await inside a message handler. grammy's built-in
// long-poll processes updates SEQUENTIALLY — one hung download/transcribe stalls
// every message behind it. 2026-07-07 incident: an album photo fetch hung ~4 min,
// the whole chat backed up at Telegram, then burst-delivered. Never hang; resolve
// with the fallback and move on.
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise(resolve => {
    const t = setTimeout(() => { resolve(fallback) }, ms)
    p.then(v => { clearTimeout(t); resolve(v) }, () => { clearTimeout(t); resolve(fallback) })
  })
}

// Shared photo download (single photos AND album items): TG getFile → fetch with
// a real socket timeout → slot inbox. Returns undefined on any failure.
async function downloadPhotoToInbox(api: Context['api'], fileId: string, uniqueId: string): Promise<string | undefined> {
  try {
    if (!state.currentToken || state.currentSlot == null) return undefined
    const file = await api.getFile(fileId)
    if (!file.file_path) return undefined
    const url = `https://api.telegram.org/file/bot${state.currentToken}/${file.file_path}`
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return undefined
    const buf = Buffer.from(await res.arrayBuffer())
    const ext = (file.file_path.split('.').pop() ?? 'jpg').slice(0, 8)
    const path = join(slotInboxDir(state.currentSlot), `${Date.now()}-${uniqueId}.${ext}`)
    mkdirSync(slotInboxDir(state.currentSlot), { recursive: true })
    writeFileSync(path, buf)
    return path
  } catch (err) {
    process.stderr.write(`kushbot: photo download failed: ${err}\n`)
    return undefined
  }
}

// Album (media-group) aggregation. Telegram delivers an N-photo album as N
// separate photo updates sharing media_group_id, with the caption on only ONE
// item. Without aggregation the user's "one message" arrived as disjoint
// inbounds (caption detached from its photos — 2026-07-07 bug report). Buffer
// items per group id, debounce, then deliver ONE inbound carrying every photo.
// Downloads happen in the debounce callback — OFF grammy's sequential update
// queue — so album fetches can never block the messages behind them.
type AlbumBufEntry = { ctx: Context; caption?: string; items: Array<{ id: string; uid: string }>; timer: ReturnType<typeof setTimeout> }
const albumBuf = new Map<string, AlbumBufEntry>()
const ALBUM_DEBOUNCE_MS = 1500

async function flushAlbum(gid: string): Promise<void> {
  const entry = albumBuf.get(gid)
  if (!entry) return
  albumBuf.delete(gid)
  const { ctx, caption, items } = entry
  const paths: string[] = []
  for (const f of items) {
    const p = await downloadPhotoToInbox(ctx.api, f.id, f.uid)
    if (p) paths.push(p)
  }
  let text = caption ?? `(album of ${items.length} photos)`
  if (paths.length > 1) {
    text += `\n\n[album: ${items.length} photos — the first is attached; the rest are downloaded, Read them:]` +
      paths.slice(1).map((p, i) => `\nphoto ${i + 2}: ${p}`).join('')
  } else if (paths.length === 0) {
    text += `\n\n[album: ${items.length} photos — every download failed; ask the user to resend]`
  }
  await handleInbound(ctx, text, paths.length ? async () => paths[0] : undefined)
}

async function handleInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
): Promise<void> {
  const result = gate(ctx)
  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(
      `${lead} — add your sender ID to ~/.claude/channels/kushbots/slot${state.currentSlot}/access.json allowFrom.\n\n` +
      `(pairing code: ${result.code})`,
    )
    return
  }

  const access = result.access
  const from = ctx.from!
  const chat_id = String(ctx.chat!.id)
  const msgId = ctx.message?.message_id

  // Forward guard, part 2: a forwarded "yes <id>" / "no <id>" must not approve or
  // deny a pending permission. Forwards don't start with '/', so they bypass the
  // command-dispatch guard above and land here as content — exempt them explicitly.
  const permMatch = ctx.message?.forward_origin ? null : PERMISSION_REPLY_RE.exec(text)
  if (permMatch) {
    void mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: {
        request_id: permMatch[2]!.toLowerCase(),
        behavior: permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
      },
    })
    if (msgId != null && state.currentBot) {
      const emoji = permMatch[1]!.toLowerCase().startsWith('y') ? '✅' : '❌'
      void state.currentBot.api.setMessageReaction(chat_id, msgId, [
        { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
      ]).catch(() => {})
    }
    return
  }

  if (state.currentBot) {
    void state.currentBot.api.sendChatAction(chat_id, 'typing').catch(() => {})
    if (access.ackReaction && msgId != null) {
      void state.currentBot.api.setMessageReaction(chat_id, msgId, [
        { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
      ]).catch(() => {})
    }
  }

  // 45s ceiling: this await runs on grammy's sequential update queue — an
  // unbounded download here stalls every message behind it (2026-07-07 album
  // incident). On failure/timeout, still deliver the text and SAY the photo
  // is missing, or the agent answers an image question it never saw.
  const imagePath = downloadImage ? await withTimeout(downloadImage(), 45_000, undefined) : undefined
  if (downloadImage && !imagePath) {
    text += '\n\n[a photo was attached but its download failed or timed out — ask the user to resend it]'
  }

  state.lastInboundAt = Date.now()   // deliver path only — gated/dropped msgs above already returned
  state.lastInboundChatId = chat_id
  // Reply-context, quote, external_reply, forward_origin — surface on every inbound so the
  // agent doesn't have to guess what "that one" / "fix that part" refers to in long threads.
  const replyMeta = extractReplyContext(ctx.message)
  const forwardMeta = extractForwardOrigin(ctx.message)
  const notifParams: Record<string, unknown> = {
      content: text,
      meta: {
        // `source` matches the docstring promise in registerCapabilities()
        // ('Inbound messages arrive as <channel source="telegram" ...>').
        // The global ~/.claude/CLAUDE.md routing rule keys off this attribute
        // to route the agent's reply back to TG instead of stdout.
        source: 'telegram',
        chat_id,
        ...(msgId != null ? { message_id: String(msgId) } : {}),
        user: from.username ?? String(from.id),
        user_id: String(from.id),
        ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
        ...replyMeta,
        ...forwardMeta,
        ...(imagePath ? { image_path: imagePath } : {}),
        ...(attachment ? {
          attachment_kind: attachment.kind,
          attachment_file_id: attachment.file_id,
          ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
          ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
          ...(attachment.name ? { attachment_name: attachment.name } : {}),
          // Voice auto-transcribe fields (kind:"voice" path); harmless on others.
          ...(attachment.local_path ? { attachment_local_path: attachment.local_path } : {}),
          ...(attachment.transcript ? { transcript: attachment.transcript } : {}),
          ...(attachment.transcript_error ? { transcript_error: attachment.transcript_error } : {}),
        } : {}),
      },
  }
  mcp.notification({ method: 'notifications/claude/channel', params: notifParams }).catch(err => {
    process.stderr.write(`kushbot: failed to deliver inbound to Claude: ${err}\n`)
    // Persist for redelivery on the next attach — an ACKed message must never be
    // silently lost (the "kai was not able to listen to me" class). Then tell the
    // user it's held, not lost.
    queueInboundOnFailure(notifParams)
    if (state.currentBot) {
      void state.currentBot.api.sendMessage(chat_id,
        '⚠️ Your message reached the bot but the session was mid-restart — I\'ve queued it and will deliver it the moment the session is back. No need to resend.',
      ).catch(() => {})
    }
  })
}

// ---------------------------------------------------------------------------
// Process-level safety nets
// ---------------------------------------------------------------------------

process.on('unhandledRejection', err => {
  process.stderr.write(`kushbot: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`kushbot: uncaught exception: ${err}\n`)
})

// ---------------------------------------------------------------------------
// Wiring — every background timer is registered HERE, nowhere else.
// ---------------------------------------------------------------------------
// Modules under src/ deliberately do not start timers at import time (see the
// doctrine note in src/state.ts). They export the tick body; this block owns the
// schedule. One place to read to know what runs on a clock, and one place to
// disable something without hunting through 4k lines.
//
// Dead-man nudge: an inbound delivered but unanswered for DEADMAN_MS while the
// session looks alive gets one heads-up — silence is otherwise ambiguous between
// "deep in work" and "wedged".
setInterval(deadmanTick, 60_000).unref()

// Approvals: the operator approves a pairing request out-of-band (a file drop by
// the /telegram:access skill); this picks it up and tells the newcomer they're in.
if (!NO_POLL) setInterval(checkApprovals, 5000).unref()

// Fleet A2A inbox: agent-to-agent mail is file-based. Claim by atomic rename (one
// winner even if two pollers race), inject, mirror to the owner, receipt, delete.
if (!NO_POLL) setInterval(() => { void checkFleetInbox() }, 5000).unref()

// ---------------------------------------------------------------------------
// MCP connect, then optional auto-attach
// ---------------------------------------------------------------------------

await mcp.connect(new StdioServerTransport())

if (SINGLE) {
  // Single-bot host (server): bind the one configured bot immediately at
  // launch — no attach() call needed, no slot to pick.
  process.stderr.write(`kushbot: single-bot mode (${BOT_LABEL}@${STATE.machine}) — self-attaching\n`)
  attach(0).then(
    r => process.stderr.write(`kushbot: single-bot attached as @${r.username}\n`),
    err => process.stderr.write(`kushbot: single-bot attach failed: ${err}\n`),
  )
} else if (BROKER_CLIENT) {
  // broker-client host: connect to the standalone broker instead of polling.
  process.stderr.write(`kushbot: broker-client mode (label=${STATE.label}@${STATE.machine}) — connecting to broker\n`)
  attach(0).then(
    r => process.stderr.write(`kushbot: broker-client attached as @${r.username}\n`),
    err => process.stderr.write(`kushbot: broker-client attach failed: ${err}\n`),
  )
} else if (process.env.KUSHBOT_AUTO_ATTACH) {
  const n = parseInt(process.env.KUSHBOT_AUTO_ATTACH, 10)
  if (Number.isFinite(n)) {
    process.stderr.write(`kushbot: KUSHBOT_AUTO_ATTACH=${n} — self-attaching\n`)
    attach(n).then(
      r => process.stderr.write(`kushbot: auto-attached slot${r.slot} as @${r.username}\n`),
      err => process.stderr.write(`kushbot: auto-attach failed: ${err}\n`),
    )
  } else {
    process.stderr.write(`kushbot: KUSHBOT_AUTO_ATTACH="${process.env.KUSHBOT_AUTO_ATTACH}" is not a number, ignoring\n`)
  }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('kushbot: shutting down\n')
  // Hard backstop: guarantee exit even if detachInternal hangs (e.g. a dead
  // broker socket or jammed Telegram call). Without this an orphan could linger.
  const hard = setTimeout(() => process.exit(0), 3000)
  if (typeof (hard as any).unref === 'function') (hard as any).unref()
  void detachInternal().finally(() => process.exit(0))
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

// Orphan watchdog: stdin events don't reliably fire when the parent chain
// is severed by a crash. Poll for reparenting (POSIX) or a dead stdin pipe.
//
// RELIABILITY FIX (2026-06-20): on Bun, neither process.ppid nor the stdin
// destroyed/ended flags flip reliably when the parent claude is SIGKILL'd
// (e.g. OOM). That let orphaned pollers survive headless and busy-loop on their
// reconnect/poll-retry timers — dozens accumulated and pinned the box's load +
// RAM until OOM. The robust signal: probe the ORIGINAL parent pid with signal 0,
// which throws ESRCH the moment that pid is gone. Exit promptly when it is.
// (bootPpid is declared near the top, next to the stderr ring buffer.)
setInterval(() => {
  let parentDead = false
  if (process.platform !== 'win32' && bootPpid > 1) {
    try { process.kill(bootPpid, 0) } catch (e: any) { if (e?.code === 'ESRCH') parentDead = true }
  }
  const orphaned =
    parentDead ||
    (process.platform !== 'win32' && process.ppid !== bootPpid) ||
    process.stdin.destroyed ||
    process.stdin.readableEnded
  if (orphaned) shutdown()
}, 5000).unref()

// ---------------------------------------------------------------------------
// Dashboard request-watcher (Tier 2): lets an external process (the home-dashboard)
// attach/detach THIS session over Telegram. attach/detach must run in-process, so
// the dashboard drops a request file keyed by our claude pid and we apply it here.
//   _requests/<claudePid>.json      {action:'attach'|'detach', slot?, nonce, ts}
//   _requests/<claudePid>.ack.json  {nonce, ok, slot?, username?, error?}
// Atomic claim via rename (one tick wins), nonce-dedupe so we never double-fire.
// ---------------------------------------------------------------------------

const REQUESTS_DIR = join(KUSHBOTS_ROOT, '_requests')
let lastRequestNonce: string | null = null

async function pollDashboardRequests(): Promise<void> {
  const pid = getClaudePid()
  const reqFile = join(REQUESTS_DIR, `${pid}.json`)
  const procFile = join(REQUESTS_DIR, `${pid}.processing`)
  const ackFile = join(REQUESTS_DIR, `${pid}.ack.json`)

  // Atomic claim first, then read what we claimed (avoids read/overwrite races).
  try { renameSync(reqFile, procFile) } catch { return }

  let req: any
  try { req = JSON.parse(readFileSync(procFile, 'utf8')) } catch { try { rmSync(procFile, { force: true }) } catch {} ; return }
  if (req.nonce && req.nonce === lastRequestNonce) { try { rmSync(procFile, { force: true }) } catch {} ; return }
  lastRequestNonce = req.nonce ?? null

  const ack = (o: Record<string, unknown>) => {
    try { writeFileSync(ackFile, JSON.stringify({ nonce: req.nonce, ...o })) } catch {}
  }
  try {
    if (req.action === 'attach') {
      const r = await attach(req.slot != null ? Number(req.slot) : undefined)
      ack({ ok: true, slot: r.slot, username: r.username })
      process.stderr.write(`kushbot: dashboard attach → slot${r.slot} (@${r.username})\n`)
    } else if (req.action === 'detach') {
      await detachInternal()
      ack({ ok: true })
      process.stderr.write('kushbot: dashboard detach\n')
    } else {
      ack({ ok: false, error: `unknown action: ${req.action}` })
    }
  } catch (e: any) {
    ack({ ok: false, error: String(e?.message || e) })
  } finally {
    try { rmSync(procFile, { force: true }) } catch {}
  }
}
setInterval(() => { void pollDashboardRequests() }, 1500).unref()
