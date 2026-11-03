// ---------------------------------------------------------------------------
// Access model + the inbound gate (per-slot).
// ---------------------------------------------------------------------------
// Who may talk to this bot, and what happens to a message from someone who may
// not. dmPolicy: 'pairing' (stranger gets a code, the operator approves) |
// 'allowlist' (silent drop) | 'disabled'.
//
// opsRecipients() is the security-critical one: operational traffic (lifecycle,
// permission prompts, A2A mirrors) goes to the OWNER ONLY, never to the whole
// allowlist. On a shared bot (guru serves a teammate + another teammate + a family member) the allowlist
// is not the operator. An earlier version fell back to allowFrom[0] and would
// have leaked ops chatter to them; there is deliberately no fallback now.
//
// checkApprovals() is exported as a tick body — server.ts's wiring block owns
// the schedule (no timers at import time).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, renameSync, realpathSync } from 'fs'
import { join, sep } from 'path'
import { randomBytes } from 'crypto'
import type { Context } from 'grammy'
import { STATE, ONE_BOT, BOT_LABEL, NO_POLL } from './config'
import { slotDir, slotAccessFile, slotApprovedDir, stateDir } from './store'
import { state } from './state'

// Permission-reply spec from anthropics/claude-cli-internal
// src/services/mcp/channelPermissions.ts — inlined.
// 5 lowercase letters a-z minus 'l'. Case-insensitive for phone autocorrect.
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
  owner?: string   // chat_id that receives ops traffic (lifecycle, permission prompts, A2A mirrors); defaults to allowFrom[0]
}

// Ops/console traffic — lifecycle red/green notices, permission Allow/Deny
// prompts, A2A mirror copies — goes to the bot OWNER only, never the whole
// allowlist. Shared bots (guru/vaidya/rishi/raju are also paired with
// a teammate/a family member/another teammate) must not spam non-operators with restart noise, and
// non-operators must NOT get tappable permission approvals (the owner 2026-07-08).
// Owner = access.owner if set, else the first allowFrom entry (the first
// paired chat is the operator by convention). Conversation replies are
// unaffected — they go wherever the conversation is.
// Operator/plumbing recipients: the bot OWNER only, never a fallback to a random
// allowlisted user. Lifecycle notices, permission approvals, A2A mirrors and other
// plumbing must NEVER reach a shared user (another teammate/a teammate/a family member on rishi/raju/guru/
// vaidya) — the 2026-07-08 "stop spamming the shared bots" report. The old code
// fell back to allowFrom[0], which on a shared bot IS the shared user. Now: owner
// or nobody (fails closed — safer for the approval-auth gate too). Every bot's
// access.json already sets owner=the owner; this makes the guarantee structural, not
// dependent on that staying correct.
export function opsRecipients(access: Pick<Access, 'owner' | 'allowFrom'>): string[] {
  return access.owner ? [access.owner] : []
}

export function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

export const MAX_CHUNK_LIMIT = 4096
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
export const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
export const VOICE_EXTS = new Set(['.ogg', '.opus', '.oga'])           // short voice notes -> sendVoice (waveform UI)
export const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav'])  // episodes -> sendAudio (player + title/scrubber)
export const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.m4v'])   // -> sendVideo (inline player)
export const MEDIA_CAPTION_LIMIT = 1024                                 // Telegram caps media captions at 1024 chars (vs 4096 for text)

export function readAccessFile(slot: number): Access {
  try {
    const raw = readFileSync(slotAccessFile(slot), 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
      owner: parsed.owner,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(slotAccessFile(slot), `${slotAccessFile(slot)}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write(`kushbot slot${slot}: access.json corrupt, moved aside. Starting fresh.\n`)
    return defaultAccess()
  }
}

export function loadAccess(): Access {
  if (state.currentSlot === null) return defaultAccess()
  return readAccessFile(state.currentSlot)
}

export function saveAccess(a: Access): void {
  if (state.currentSlot === null) return
  mkdirSync(slotDir(state.currentSlot), { recursive: true, mode: 0o700 })
  const tmp = slotAccessFile(state.currentSlot) + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, slotAccessFile(state.currentSlot))
}

export function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) { delete a.pending[code]; changed = true }
  }
  return changed
}

// reply's files param takes any path. .env is ~60 bytes and ships as a
// document. Block paths inside the slot's state dir (except inbox/) so the
// server's own credentials can't be exfiltrated.
export function assertSendable(f: string): void {
  if (state.currentSlot === null) return
  let real: string
  let stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(slotDir(state.currentSlot))
  } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

export function assertAllowedChat(chat_id: string): void {
  const access = loadAccess()
  if (access.allowFrom.includes(chat_id)) return
  if (chat_id in access.groups) return
  throw new Error(
    `chat ${chat_id} is not allowlisted — edit ${state.currentSlot != null ? slotAccessFile(state.currentSlot) : '(no slot bound)'}`,
  )
}

// ---------------------------------------------------------------------------
// Gate (per-message) — identical semantics to upstream
// ---------------------------------------------------------------------------

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

export function gate(ctx: Context): GateResult {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const from = ctx.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = ctx.chat?.type

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: String(ctx.chat!.id),
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const groupId = String(ctx.chat!.id)
    const policy = access.groups[groupId]
    if (!policy) return { action: 'drop' }
    const groupAllowFrom = policy.allowFrom ?? []
    const requireMention = policy.requireMention ?? true
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return { action: 'drop' }
    if (requireMention && !isMentioned(ctx, access.mentionPatterns)) return { action: 'drop' }
    return { action: 'deliver', access }
  }

  return { action: 'drop' }
}

export function isMentioned(ctx: Context, extraPatterns?: string[]): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention') {
      const mentioned = text.slice(e.offset, e.offset + e.length)
      if (mentioned.toLowerCase() === `@${state.currentBotUsername}`.toLowerCase()) return true
    }
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === state.currentBotUsername) {
      return true
    }
  }
  if (ctx.message?.reply_to_message?.from?.username === state.currentBotUsername) return true
  for (const pat of extraPatterns ?? []) {
    try { if (new RegExp(pat, 'i').test(text)) return true } catch {}
  }
  return false
}

// ---------------------------------------------------------------------------
// Approval polling (per active slot)
// ---------------------------------------------------------------------------

export function checkApprovals(): void {
  // Same single-consumer rule as checkFleetInbox: a NO_POLL child must not claim
  // approvals (would double-send "Paired!" and race the inbound child's writes).
  if (NO_POLL) return
  if (state.currentSlot === null || state.currentBot === null) return
  let files: string[]
  try { files = readdirSync(slotApprovedDir(state.currentSlot)) } catch { return }
  if (files.length === 0) return
  const bot = state.currentBot
  const slot = state.currentSlot
  for (const senderId of files) {
    const file = join(slotApprovedDir(slot), senderId)
    void bot.api.sendMessage(senderId, "Paired! Say hi to Claude.").then(
      () => rmSync(file, { force: true }),
      err => {
        process.stderr.write(`kushbot slot${slot}: failed to send approval confirm: ${err}\n`)
        rmSync(file, { force: true })
      },
    )
  }
}


