#!/usr/bin/env bun
/*
 * kushbot-broker — one Telegram bot token fanned out to many filtered sessions.
 *
 * The kushbot MCP server is one-per-session and can only deliver to its own
 * session; Telegram allows exactly one getUpdates poller per token. So when one
 * bot must feed several independent Claude sessions (e.g. Guru for the owner/another teammate/
 * a teammate), THIS standalone process owns the single poller and routes each update
 * to the right session over a Unix-domain socket. Each session runs server.ts in
 * `broker-client` mode: it subscribes with its allowFrom filter and feeds the
 * forwarded updates through its own handler stack via bot.handleUpdate().
 *
 * Outbound (reply/react/etc) is NOT proxied — it's stateless Telegram HTTPS that
 * each client does directly with the shared token. Only getUpdates is exclusive.
 *
 * Usage:  bun broker.ts [channelsDir]
 *   channelsDir defaults to ~/.claude/channels/telegram (or $KUSHBOT_BROKER_DIR).
 *   Reads token from <dir>/.env (TELEGRAM_BOT_TOKEN) and routes from
 *   <dir>/routes.json: { "routes": {"<user_id>":"<label>"}, "default":"unrouted" }
 */
import { Bot, GrammyError, type Context } from 'grammy'
import { createServer, type Socket, type Server } from 'net'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join, isAbsolute } from 'path'

const CHANNELS_DIR = (() => {
  const p = process.argv[2] ?? process.env.KUSHBOT_BROKER_DIR ?? join('channels', 'telegram')
  return isAbsolute(p) ? p : join(homedir(), '.claude', p)
})()
const SOCK = join(CHANNELS_DIR, 'broker.sock')
const PID_FILE = join(CHANNELS_DIR, 'broker.pid')
const PENDING_ROOT = join(CHANNELS_DIR, 'pending')
const UNROUTED_LOG = join(CHANNELS_DIR, 'unrouted.log')
const MAX_QUEUE_PER_LABEL = 200

function log(msg: string): void { process.stderr.write(`kushbot-broker: ${msg}\n`) }

// ---- config -------------------------------------------------------------
function readEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const line of readFileSync(join(CHANNELS_DIR, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/); if (m) out[m[1]] = m[2]
    }
  } catch {}
  return out
}
function loadRoutes(): { routes: Record<string, string>; default: string } {
  try {
    const raw = JSON.parse(readFileSync(join(CHANNELS_DIR, 'routes.json'), 'utf8'))
    return { routes: raw.routes ?? {}, default: raw.default ?? 'unrouted' }
  } catch { return { routes: {}, default: 'unrouted' } }
}

const TOKEN = readEnv().TELEGRAM_BOT_TOKEN
if (!TOKEN) { log(`no TELEGRAM_BOT_TOKEN in ${CHANNELS_DIR}/.env`); process.exit(2) }

// ---- single-instance guard ---------------------------------------------
function isPidAlive(pid: number): boolean {
  if (pid <= 1) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
try {
  const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
  if (stale > 1 && stale !== process.pid && isPidAlive(stale)) {
    log(`pre-empting stale broker pid=${stale}`)
    try { process.kill(stale, 'SIGTERM') } catch {}
  }
} catch {}
mkdirSync(CHANNELS_DIR, { recursive: true, mode: 0o700 })
writeFileSync(PID_FILE, String(process.pid))

// ---- subscriber registry ------------------------------------------------
type Sub = { socket: Socket; label: string; allowFrom: Set<string>; groups: Set<string> }
const subs = new Map<string, Sub>()   // label -> sub (one live client per label)

function writeFrame(sub: Sub, obj: unknown): void {
  try { sub.socket.write(JSON.stringify(obj) + '\n') } catch (e) { log(`write to ${sub.label} failed: ${e}`) }
}

// queue an update for an offline label (bounded, ordered by update_id)
function queueForLabel(label: string, update: any): void {
  const dir = join(PENDING_ROOT, label)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    let files = readdirSync(dir).filter(f => f.endsWith('.json')).sort()
    while (files.length >= MAX_QUEUE_PER_LABEL) {
      try { unlinkSync(join(dir, files[0])) } catch {}
      files = files.slice(1)
    }
    const id = String(update.update_id ?? Date.now()).padStart(16, '0')
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(update))
  } catch (e) { log(`queue for ${label} failed: ${e}`) }
}

function flushQueue(sub: Sub): void {
  const dir = join(PENDING_ROOT, sub.label)
  let files: string[] = []
  try { files = readdirSync(dir).filter(f => f.endsWith('.json')).sort() } catch { return }
  for (const f of files) {
    try {
      const update = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      writeFrame(sub, { type: 'update', update })
      unlinkSync(join(dir, f))
    } catch (e) { log(`flush ${sub.label}/${f} failed: ${e}`) }
  }
  if (files.length) log(`flushed ${files.length} queued update(s) to ${sub.label}`)
}

// ---- routing ------------------------------------------------------------
function routeKey(ctx: Context): { kind: 'dm' | 'group'; key: string } | null {
  const chat = ctx.chat
  if (chat && (chat.type === 'group' || chat.type === 'supergroup')) return { kind: 'group', key: String(chat.id) }
  const fid = ctx.from?.id
  return fid != null ? { kind: 'dm', key: String(fid) } : null
}

function findLiveSub(rk: { kind: 'dm' | 'group'; key: string }): Sub | null {
  for (const sub of subs.values()) {
    if (rk.kind === 'dm' && sub.allowFrom.has(rk.key)) return sub
    if (rk.kind === 'group' && sub.groups.has(rk.key)) return sub
  }
  return null
}

const ROUTES = loadRoutes()

async function route(ctx: Context): Promise<void> {
  const rk = routeKey(ctx)
  if (!rk) return
  const live = findLiveSub(rk)
  if (live) { writeFrame(live, { type: 'update', update: ctx.update }); return }

  // No live subscriber. If we know which label owns this key, queue for it.
  const label = rk.kind === 'dm' ? ROUTES.routes[rk.key] : undefined
  if (label && label !== ROUTES.default) { queueForLabel(label, ctx.update); return }

  // Unrouted user → log + a one-line pairing hint (DMs only).
  try { writeFileSync(UNROUTED_LOG, `${new Date().toISOString()} ${rk.kind} ${rk.key} @${ctx.from?.username ?? '?'}\n`, { flag: 'a' }) } catch {}
  if (rk.kind === 'dm' && ctx.chat) {
    try {
      await ctx.api.sendMessage(ctx.chat.id,
        `You're not connected to a session yet. Ask the operator to add your ID (${rk.key}) to a session's allowFrom + routes.json.`)
    } catch {}
  }
  log(`unrouted ${rk.kind} ${rk.key}`)
}

// ---- IPC server ---------------------------------------------------------
function startIpc(): Server {
  try { unlinkSync(SOCK) } catch {}
  const server = createServer((socket: Socket) => {
    socket.setEncoding('utf8')
    let buf = ''
    let myLabel: string | null = null
    socket.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let frame: any
        try { frame = JSON.parse(line) } catch { continue }
        if (frame.type === 'subscribe' && frame.label) {
          myLabel = String(frame.label)
          const sub: Sub = {
            socket, label: myLabel,
            allowFrom: new Set((frame.allowFrom ?? []).map(String)),
            groups: new Set((frame.groups ?? []).map(String)),
          }
          subs.set(myLabel, sub)
          log(`subscribed: ${myLabel} (allowFrom=${[...sub.allowFrom].join(',') || '∅'}, groups=${[...sub.groups].join(',') || '∅'})`)
          writeFrame(sub, { type: 'subscribed', bot_username: botUsername })
          flushQueue(sub)
        }
      }
    })
    const drop = (): void => {
      if (myLabel && subs.get(myLabel)?.socket === socket) {
        subs.delete(myLabel)
        log(`client ${myLabel} disconnected (will queue)`)
      }
    }
    socket.on('error', () => { try { socket.destroy() } catch {} })
    socket.on('close', drop)
  })
  server.listen(SOCK, () => log(`listening on ${SOCK}`))
  return server
}

// ---- Telegram poller (the ONLY getUpdates consumer for this token) ------
let botUsername = ''
const bot = new Bot(TOKEN)
bot.use(async ctx => { await route(ctx) })
bot.catch(err => log(`handler error: ${err.error}`))

const ipc = startIpc()

async function startPolling(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: info => { attempt = 0; botUsername = info.username; log(`polling as @${info.username}`) },
      })
      return
    } catch (err) {
      const is409 = err instanceof GrammyError && err.error_code === 409
      const delay = Math.min(1000 * attempt, 15000)
      log(`${is409 ? '409 Conflict (another poller on this token?)' : `polling error: ${err}`}, retry in ${delay / 1000}s`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
}

function shutdown(): void {
  log('shutting down')
  try { ipc.close() } catch {}
  try { unlinkSync(SOCK) } catch {}
  try { const p = parseInt(readFileSync(PID_FILE, 'utf8'), 10); if (p === process.pid) unlinkSync(PID_FILE) } catch {}
  void bot.stop().finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

void startPolling()
