// ---------------------------------------------------------------------------
// Pure string helpers: chunking, HTML balancing, shell quoting, formatting.
// ---------------------------------------------------------------------------
// Leaf module — zero imports, zero state, zero side effects. Safe for anything
// to import.
//
// esc() and fmtAge() live here rather than beside their original neighbours
// (esc sat in the tmux block, fmtAge in the heartbeat block) because they are
// pure and cross-cutting: fleet A2A calls esc(), several renderers call both.
// In the single-file version that worked only through function hoisting —
// checkFleetInbox() at line ~445 called esc() defined at line ~2436. Split
// naively, that becomes a runtime "esc is not defined" on the A2A path only,
// with a clean boot. Co-locating them by *nature* (pure text) instead of by
// *neighbourhood* is what makes the import graph honest.

// Find the best position in [0, limit] to split `text`, preferring logical
// boundaries. Priority: ASCII section divider (\n═══, \n━━━, \n## , \n===,
// \n---) > paragraph (\n\n) > line (\n) > sentence (. / ! / ? followed by
// space or newline) > word (space). The first four are only honored if they
// fall in the back half of the window (so chunks aren't pathologically small).
// Word boundaries are used anywhere > 0. Last resort: hard cut at limit
// (can mid-word, but only if there's no space in the first `limit` chars —
// pathological case like a giant URL).
export function findSmartCut(text: string, limit: number): number {
  const half = Math.floor(limit / 2)
  const window = text.slice(0, limit)

  // 1. Section divider: cut BEFORE the newline so the divider opens the next chunk.
  let bestDivider = -1
  const dividerRe = /\n(?:[━═]{3,}|#{1,6} |={3,}|-{3,})/g
  let m: RegExpExecArray | null
  while ((m = dividerRe.exec(window)) !== null) bestDivider = m.index
  if (bestDivider > half) return bestDivider + 1 // skip the \n; next chunk starts with the divider text

  // 2. Paragraph break (\n\n) — cut at first \n; the leading \n is stripped from next chunk.
  const para = text.lastIndexOf('\n\n', limit)
  if (para > half) return para + 1

  // 3. Single newline.
  const nl = text.lastIndexOf('\n', limit)
  if (nl > half) return nl + 1

  // 4. Sentence boundary: end this chunk with the punctuation; next chunk starts after the separator.
  let bestSent = -1
  for (const sep of ['. ', '! ', '? ', '.\n', '!\n', '?\n']) {
    const idx = text.lastIndexOf(sep, limit)
    if (idx > bestSent) bestSent = idx + 1 // cut AFTER the punctuation; leading space/newline strips
  }
  if (bestSent > half) return bestSent

  // 5. Word boundary — last space anywhere in the window.
  const space = text.lastIndexOf(' ', limit)
  if (space > 0) return space

  // 6. Last resort.
  return limit
}

// Split text into ≤limit-char chunks. mode='newline' (default) uses
// findSmartCut to avoid mid-word breaks. mode='length' is an escape hatch
// that hard-cuts at exactly `limit` (may break mid-word — preserves legacy
// behavior for callers that set chunkMode:'length' in access.json).
export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const cut = mode === 'length' ? limit : findSmartCut(rest, limit)
    out.push(rest.slice(0, cut))
    // Strip leading newlines only (not spaces) so the next chunk doesn't
    // open with the \n we just split on. Preserves the space that follows
    // a sentence boundary cut (". " split keeps " word" on the next chunk
    // — joining the chunks back round-trips the original text byte-for-byte
    // up to the dropped leading \n). Never strips indentation in code blocks.
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// Track HTML tags still open at the end of a chunk, so balanceChunks can
// close-and-reopen them across chunk boundaries. Stack stores the original
// open-tag verbatim so attributes (e.g. <a href="..."> ) survive the round
// trip. Telegram's HTML mode permits only a fixed tag whitelist; we don't
// enforce that whitelist here — bad input rejects at sendMessage time, as
// before, and balance never invents tags the caller didn't write.
type HtmlOpenTag = { name: string; raw: string }
export function findUnclosedHtml(s: string): HtmlOpenTag[] {
  const VOID = new Set(['br', 'hr', 'img'])
  const stack: HtmlOpenTag[] = []
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(s)) !== null) {
    const isClose = m[1] === '/'
    const name = m[2].toLowerCase()
    if (VOID.has(name)) continue
    if (isClose) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === name) { stack.splice(i, 1); break }
      }
    } else {
      stack.push({ name, raw: m[0] })
    }
  }
  return stack
}

// Close-and-reopen any HTML tags that straddle a chunk boundary so each
// chunk parses as standalone HTML on Telegram's side. No-op when chunks
// fit in one message, or when parseMode is anything other than HTML.
//
// MarkdownV2 is NOT balanced automatically. Its markers (* _ ~ || ` ```)
// are positional and escape-sensitive, so naive marker-counting fights
// the escape rules. Callers using markdownv2 with chunked output should
// split content on \n\n boundaries themselves; the smart cutter prefers
// those naturally, so straddling formatting is rare in practice.
export function balanceChunks(chunks: string[], parseMode: 'HTML' | 'MarkdownV2' | undefined): string[] {
  if (parseMode !== 'HTML' || chunks.length <= 1) return chunks
  const out: string[] = []
  let prefix = ''
  for (let i = 0; i < chunks.length; i++) {
    const body = prefix + chunks[i]
    if (i === chunks.length - 1) { out.push(body); break }
    const open = findUnclosedHtml(body)
    if (open.length === 0) {
      out.push(body)
      prefix = ''
    } else {
      const closes = open.slice().reverse().map(t => `</${t.name}>`).join('')
      out.push(body + closes)
      prefix = open.map(t => t.raw).join('')
    }
  }
  return out
}

export function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

// Translate the public `format` arg ('text' | 'html' | 'markdownv2') to the
// Telegram parse_mode string. Returns undefined for plain text (no parser).
export function resolveParseMode(format: string | undefined): 'HTML' | 'MarkdownV2' | undefined {
  if (format === 'html') return 'HTML'
  if (format === 'markdownv2') return 'MarkdownV2'
  return undefined
}

// Translate the public `link_preview` arg to a LinkPreviewOptions object.
// 'default' / undefined → no override (Telegram auto-previews). Otherwise
// disable or position the preview above/below the message body.
export function resolveLinkPreview(lp: string | undefined): { is_disabled?: boolean; show_above_text?: boolean } | undefined {
  if (!lp || lp === 'default') return undefined
  if (lp === 'disabled') return { is_disabled: true }
  if (lp === 'above') return { show_above_text: true }
  if (lp === 'below') return { show_above_text: false }
  return undefined
}

// Quote a string for safe inclusion in a shell command (tmux send-keys etc).
export function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

// Escape a dynamic string for Telegram HTML mode (only & < > are significant
// inside element text). Reused by /heartbeat, /cli, and the fleet A2A mirror.
export function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Human-friendly age for a past timestamp (ms epoch) or null.
export function fmtAge(ms: number | null): string {
  if (ms == null) return 'never'
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
