// Listen — text to speech for the read-later queue, with the audio saved next
// to the note so it is made once and kept.
//
//   POST /api/reading/audio/estimate  { file, voice }        what it would cost
//   POST /api/reading/audio/render    { file, voice, limitSeconds? }
//   GET  /api/reading/audio/state?f=&voice=                  queued/running/ready/failed
//   GET  /reading/audio?f=<stem>.<voice>.mp3                 the audio, Range-aware
//   GET  /reading/audio/cues?f=<stem>.<voice>.json           paragraph cues
//
// Renderings live in Reading/Files/audio/ beside the PDFs, and the note's
// frontmatter grows one key, `audio:`, listing the voices that exist. Nothing
// else about the note is touched, and a rendering that fails leaves no file.

import { readFile, writeFile, mkdir, mkdtemp, rm, rename, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { createHash } from "crypto";
import { baseLog } from "../../lib/log";
import { INBOX, FILES, readerBodyHtml } from "./reading";
import { alignFile, STT_USD_PER_MINUTE, type Cue } from "./reading-align";
// Where a sentence ends, in one place, shared with the reader. reading-align.ts
// numbers a block's sentences with it and reader.js wraps the same sentences in
// spans with it; a cue says "block 12, sentence 3" and means nothing if the two
// ever disagree. See dashboard/static/reading/sentences.js.
import { ranges as sentenceRanges, urlRe } from "../../static/reading/sentences.js";

// FILES comes from reading.ts, which imports this module straight back, so the
// path is built on first use rather than at load: at load time that module has
// not reached its own consts yet.
function audioDir(): string { return join(FILES, "audio"); }
const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const FFPROBE = "/opt/homebrew/bin/ffprobe";
const SECRETS = join(homedir(), ".secrets");

// ── voices ───────────────────────────────────────────────────────────────────
// the owner's own three Aura-2 voices first, in the order he meets them elsewhere:
// Thalia is what Guru speaks with, Neptune narrates a side project, Orpheus is Kush
// on Telegram. Sarvam follows for the Indian-English register.

export interface Voice {
  id: string;
  label: string;
  provider: "deepgram" | "sarvam";
  model?: string;   // sarvam only
}

export const VOICES: Voice[] = [
  { id: "aura-2-thalia-en", label: "Thalia (Deepgram)", provider: "deepgram" },
  { id: "aura-2-neptune-en", label: "Neptune (Deepgram)", provider: "deepgram" },
  { id: "aura-2-orpheus-en", label: "Orpheus (Deepgram)", provider: "deepgram" },
  // All three on bulbul:v3. tts.sh still asks for v2 and only reaches for v3
  // when a speaker needs it, which is how it was written in May; Sarvam now
  // answers v2 with "Model 'bulbul:v2' has been deprecated. Please use
  // 'bulbul:v3' instead." (2026-09-11, on the first render made through here),
  // so the v2-or-v3 choice no longer exists and the field only records which.
  //
  // Priya renders. Anushka and Abhilash do NOT: they were v2 speakers and are
  // not on the v3 roster, which the API gives as aditya, ritu, ashutosh, priya,
  // neha, rahul, pooja, rohan, simran, kavya, amit, dev, ishita, shreya, ratan,
  // varun, manan, sumit, roopa, kabir, aayan, shubh, advait, anand, tanya,
  // tarun. They are still listed because these three are the voices the owner
  // asked for; picking two replacements off that roster is his call, and until
  // he makes it choosing one of them fails with Sarvam's own sentence, which
  // names the alternatives.
  { id: "priya", label: "Priya (Sarvam)", provider: "sarvam", model: "bulbul:v3" },
  // Anushka and Abhilash were bulbul:v2 speakers and went with it (Sarvam
  // retired v2 in 2026); Ritu and Anand are their nearest on the v3 roster.
  { id: "ritu", label: "Ritu (Sarvam)", provider: "sarvam", model: "bulbul:v3" },
  { id: "anand", label: "Anand (Sarvam)", provider: "sarvam", model: "bulbul:v3" },
];

export const DEFAULT_VOICE = VOICES[0].id;

function voiceOf(id: unknown): Voice | null {
  return VOICES.find((v) => v.id === id) || null;
}

// Per-request character ceilings. Deepgram's /v1/speak takes about 2000 and
// tts.sh stays at 1900 for headroom; Sarvam's inputs cap at 500 per string and
// tts.sh uses 480 for the same reason.
const CHUNK_MAX = { deepgram: 1900, sarvam: 480 };

// Aura-2 is billed per character: $0.030 per 1,000 characters on pay-as-you-go,
// from deepgram.com/pricing, read 2026-09-11. Sarvam bills the same way at
// ₹30 per 10,000 characters for bulbul:v3, the only model it still serves
// (docs.sarvam.ai/api-reference-docs/pricing, same day), quoted in rupees here
// because turning it into dollars would bake in an exchange rate that goes
// stale faster than the price does.
const USD_PER_CHAR = 0.03 / 1000;
const INR_PER_CHAR = 30 / 10000;

// Speech runs at roughly 15 characters a second across all six of these voices,
// which is close enough to put a number on a page before spending anything.
const CHARS_PER_SECOND = 15;

// Anything past half an hour is a commitment, in money and in listening, so the
// client asks first.
export const LONG_SECONDS = 30 * 60;

// ── the note, as speakable paragraphs ────────────────────────────────────────
//
// Mapping rule, and the reason this reads the *rendered HTML* rather than the
// markdown: a cue's `i` is the index of an element in
//
//     document.querySelectorAll(".rl-body .md p, .rl-body .md h2, .rl-body .md h3, .rl-body .md li")
//
// which the DOM returns in document order. Opening tags appear in the HTML in
// exactly that order, so walking the same HTML the reader renders and counting
// p/h2/h3/li opens gives the same indices without having to predict what marked
// will do with a given piece of markdown. Change the selector in reading.ts and
// you must change SPOKEN here, and vice versa.

const SPOKEN = new Set(["p", "h2", "h3", "li"]);
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);

export interface Block {
  i: number;       // index among all p/h2/h3/li, spoken or not
  text: string;
  speak: boolean;
  chars: number;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ldquo: "\u201c", rdquo: "\u201d", lsquo: "\u2018", rsquo: "\u2019",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", middot: "\u00b7",
};

function decode(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body: string) => {
    if (body[0] === "#") {
      const n = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[body] ?? all;
  });
}

// What a block sounds like. The H1 never reaches here (it is not in SPOKEN, and
// the reader hides it anyway); page marks are a visual index of where the PDF
// turned over and would read as "page 14" mid-sentence; a raw URL read aloud is
// a minute of punctuation, while the words that linked to it survive because
// stripping <a> keeps its text.
function speakable(inner: string): string {
  let s = inner
    .replace(/<span class="rl-pg"[\s\S]*?<\/span>/gi, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  s = decode(s);
  s = s.replace(urlRe(), " ");
  return unshout(s.replace(/\s+/g, " ").trim());
}

// Shouted words. Aura reads an all-caps word as an acronym, so "you DIE" came
// out letter by letter as "D-I-E" (the owner, 2026-11-02, a podcast episode).
// An all-caps word of three or more letters that the system dictionary knows
// as an ordinary lowercase word is emphasis, not an acronym, and is spoken in
// lowercase; GPU, NVDA, LLM are not dictionary words and stay as they are.
// Lowercasing keeps every character offset, so sentence ranges and cues still
// line up with what the reader shows.
let DICT: Set<string> | null = null;
function dict(): Set<string> {
  if (DICT) return DICT;
  DICT = new Set();
  try {
    for (const w of require("fs").readFileSync("/usr/share/dict/words", "utf8").split("\n")) {
      if (/^[a-z]+$/.test(w)) DICT.add(w);
    }
  } catch {}
  return DICT;
}
function unshout(s: string): string {
  return s.replace(/\b[A-Z]{3,}\b/g, (w) => (dict().has(w.toLowerCase()) ? w.toLowerCase() : w));
}

// A heading is a fragment; spoken back to back with the paragraph under it, it
// runs into the first sentence. Ending it turns it into one. List items get the
// same treatment so the chunker has a sentence edge to cut on.
function asSentence(text: string): string {
  if (!text) return "";
  return /[.!?:;\u2026]["')\]]?$/.test(text) ? text : text + ".";
}

export function blocksOf(html: string): Block[] {
  const out: Block[] = [];
  const stack: { tag: string; slot: number; start: number }[] = [];
  // Attribute values never contain a bare ">" here: everything reaching this
  // point came out of marked, which escapes them.
  const re = /<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (VOID.has(tag) || m[3] === "/") continue;
    if (!closing) {
      let slot = -1;
      if (SPOKEN.has(tag)) {
        slot = out.length;
        out.push({ i: slot, text: "", speak: true, chars: 0 });
      }
      stack.push({ tag, slot, start: re.lastIndex });
      continue;
    }
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].tag !== tag) continue;
      const open = stack[k];
      if (open.slot >= 0) {
        const inner = html.slice(open.start, m.index);
        const b = out[open.slot];
        // A loose list item is a wrapper around its own paragraph. Speaking
        // both says everything twice, so the wrapper keeps its index and goes
        // quiet; the index is what the cues are pinned to, so it cannot go away.
        const wrapper = /^\s*<(p|ul|ol|blockquote|div|table|pre)\b/i.test(inner);
        b.text = wrapper ? "" : asSentence(speakable(inner));
        b.speak = b.text.length > 1;
        b.chars = b.text.length;
      }
      stack.length = k;
      break;
    }
  }
  return out;
}

// ── chunks ───────────────────────────────────────────────────────────────────

export interface Chunk {
  text: string;
  // The blocks inside, in order. `from` is where the piece starts in that
  // block's own text, which is what lets a sentence's character offset be
  // turned back into a time when there is no alignment to ask.
  parts: { i: number; from: number; chars: number }[];
}

function sentences(text: string, max: number): string[] {
  const out: string[] = [];
  let buf = "";
  // The same rule the reader uses to wrap sentences on the page and the aligner
  // uses to number them, so a chunk can only ever be cut where a sentence
  // genuinely ends.
  for (const s of sentenceRanges(text).map((r: number[]) => text.slice(r[0], r[1]).trim())) {
    if (buf && buf.length + 1 + s.length > max) { out.push(buf); buf = ""; }
    if (s.length > max) {
      // A single sentence longer than the ceiling is a wall of text with no
      // punctuation. Cut it on a word rather than mid-word.
      let rest = s;
      while (rest.length > max) {
        let cut = rest.lastIndexOf(" ", max);
        if (cut < max / 2) cut = max;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      buf = rest;
      continue;
    }
    buf = buf ? buf + " " + s : s;
  }
  if (buf) out.push(buf);
  return out.filter(Boolean);
}

export function chunksOf(blocks: Block[], max: number): Chunk[] {
  const out: Chunk[] = [];
  let cur: Chunk | null = null;
  for (const b of blocks) {
    if (!b.speak) continue;
    if (b.chars > max) {
      if (cur) { out.push(cur); cur = null; }
      // The pieces are the block's own text back again, minus the single space
      // that joined each to the next, so the running offset counts that space.
      let from = 0;
      for (const piece of sentences(b.text, max)) {
        out.push({ text: piece, parts: [{ i: b.i, from, chars: piece.length }] });
        from += piece.length + 1;
      }
      continue;
    }
    if (cur && cur.text.length + 1 + b.chars > max) { out.push(cur); cur = null; }
    if (!cur) cur = { text: b.text, parts: [{ i: b.i, from: 0, chars: b.chars }] };
    else { cur.text += " " + b.text; cur.parts.push({ i: b.i, from: 0, chars: b.chars }); }
  }
  if (cur) out.push(cur);
  return out;
}

// ── cues without an alignment ────────────────────────────────────────────────
// The fallback, and what every rendering starts with: each chunk's measured
// length spread across the characters inside it. A sentence's start is where
// its first character falls in that arithmetic. It is honest at chunk edges and
// drifts by up to a second or two in the middle of a long one, which is why
// reading-align.ts exists — but it needs no key, costs nothing, and means a
// rendering is never left with no cues at all.

export function interpolatedCues(blocks: Block[], chunks: Chunk[], seconds: number[]): Cue[] {
  interface Span { i: number; from: number; to: number; t0: number; t1: number }
  const spans: Span[] = [];
  let t = 0;
  chunks.forEach((chunk, ci) => {
    const total = chunk.parts.reduce((n, p) => n + p.chars, 0) || 1;
    const dur = seconds[ci] || 0;
    let inside = 0;
    for (const part of chunk.parts) {
      const t0 = t + (inside / total) * dur;
      inside += part.chars;
      spans.push({
        i: part.i, from: part.from, to: part.from + part.chars,
        t0, t1: t + (inside / total) * dur,
      });
    }
    t += dur;
  });

  const byBlock = new Map<number, Span[]>();
  for (const s of spans) {
    const a = byBlock.get(s.i);
    if (a) a.push(s); else byBlock.set(s.i, [s]);
  }

  const cues: Cue[] = [];
  for (const b of blocks) {
    if (!b.speak) continue;
    const mine = byBlock.get(b.i);
    if (!mine || !mine.length) continue;     // trimmed off by "first 30 minutes"
    const rs = sentenceRanges(b.text);
    const list: number[][] = rs.length ? rs : [[0, b.text.length]];
    list.forEach((r: number[], s: number) => {
      const at = r[0];
      let span = mine[0];
      for (const c of mine) { if (at >= c.from) span = c; else break; }
      const width = span.to - span.from;
      const frac = width > 0 ? Math.min(1, Math.max(0, (at - span.from) / width)) : 0;
      cues.push({ i: b.i, s, t: Math.round((span.t0 + frac * (span.t1 - span.t0)) * 100) / 100 });
    });
  }
  return cues;
}

// ── reading the note ─────────────────────────────────────────────────────────

async function prepare(file: string, voice: Voice): Promise<{ blocks: Block[]; chunks: Chunk[]; chars: number }> {
  const raw = await readFile(join(INBOX, file), "utf8");
  const blocks = blocksOf(readerBodyHtml(file, raw));
  const chunks = chunksOf(blocks, CHUNK_MAX[voice.provider]);
  const chars = chunks.reduce((n, c) => n + c.text.length, 0);
  return { blocks, chunks, chars };
}

// "First 30 minutes" is a character budget, cut at a chunk edge so no sentence
// is left half-said.
function trim(chunks: Chunk[], limitSeconds: number): Chunk[] {
  const budget = Math.round(limitSeconds * CHARS_PER_SECOND);
  const out: Chunk[] = [];
  let n = 0;
  for (const c of chunks) {
    if (n && n + c.text.length > budget) break;
    out.push(c);
    n += c.text.length;
  }
  return out.length ? out : chunks.slice(0, 1);
}

export function costOf(chars: number, voice: Voice): { amount: number; label: string } {
  if (voice.provider === "sarvam") {
    const inr = chars * INR_PER_CHAR;
    return { amount: inr, label: `\u20b9${inr < 10 ? inr.toFixed(1) : Math.round(inr)}` };
  }
  const usd = chars * USD_PER_CHAR;
  return { amount: usd, label: `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}` };
}

function minutesOf(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

// ── file names ───────────────────────────────────────────────────────────────
// A note's name is a title, so it can hold anything a title can, including the
// separators an asset route must refuse. The stem is that name made safe; when
// making it safe changed it, six hex of the original goes on the end so two
// notes that flatten to the same slug cannot flatten onto the same audio file.

export function stemOf(file: string): string {
  const base = file.replace(/\.md$/i, "");
  const slug = base.replace(/[^A-Za-z0-9 _.,()'&+-]/g, "-").replace(/-{2,}/g, "-").replace(/\.+$/, "").trim();
  if (slug === base && slug && !slug.startsWith(".")) return slug;
  const hash = createHash("sha256").update(base).digest("hex").slice(0, 6);
  return `${slug || "note"}~${hash}`;
}

function mp3Name(file: string, voice: string): string { return `${stemOf(file)}.${voice}.mp3`; }
function jsonName(file: string, voice: string): string { return `${stemOf(file)}.${voice}.json`; }

// The audio routes take a basename and nothing else: no separator, no leading
// dot, and the extension the route serves. Same shape as safeAsset in
// reading.ts, kept here so the audio dir has its own gate.
export function safeAudio(f: string | null, ext: string): string | null {
  if (!f) return null;
  if (f.includes("/") || f.includes("\\") || f.includes("\0")) return null;
  if (f.startsWith(".")) return null;
  if (!f.toLowerCase().endsWith(ext)) return null;
  return f;
}

// ── what has been rendered ───────────────────────────────────────────────────

export interface Saved {
  voice: string;
  label: string;
  provider: string;
  seconds: number;
  chars: number;
  created: string;
  partial: boolean;
  aligned: boolean;
  at: number;        // seconds he had reached in this rendering, 0 for none
  url: string;
  cuesUrl: string;
}

// v is the shape of `cues`, not of the file. v1 had one `{i, t}` per paragraph;
// v2 has one `{i, s, t}` per sentence and says in `aligned` whether those times
// came from listening back to the audio or from spreading a chunk's length
// across its characters. The reader still reads v1 — a cue with no `s` is
// sentence 0 of its paragraph — so a rendering made before any of this works
// exactly as well as it did, at paragraph resolution.
interface Sidecar {
  v?: number;
  provider: string; voice: string; label: string;
  seconds: number; chars: number; created: string;
  partial?: boolean;
  aligned?: boolean;
  alignedAt?: string;
  matched?: number;    // share of the source text the aligner found, 0 to 1
  cues: Cue[];
}

export const CUE_VERSION = 2;

// Where he had got to, out of the note's own frontmatter:
//
//     audio_at: [aura-2-thalia-en, 742]
//
// The voice as well as the seconds, because two renderings of the same note are
// two different lengths and a position in one means nothing in the other. This
// lives in the note rather than only in localStorage for the same reason the
// read-so-far percentage does: a service worker can serve him a page it cached
// yesterday, and a phone and a Mac should agree about where he stopped.
export function audioAtOf(raw: string): { voice: string; at: number } {
  const m = raw.match(/^---\n([\s\S]*?\n)---\n?/);
  const line = m?.[1].match(/^audio_at:\s*\[(.*)\]\s*$/m)?.[1];
  if (!line) return { voice: "", at: 0 };
  const parts = line.split(",").map((s) => s.trim());
  const at = Number(parts[1]);
  return { voice: parts[0] || "", at: Number.isFinite(at) && at > 0 ? at : 0 };
}

async function recordAudioAt(file: string, voice: string, at: number): Promise<void> {
  const path = join(INBOX, file);
  const raw = await readFile(path, "utf8");
  const m = raw.match(/^---\n([\s\S]*?\n)---\n?/);
  if (!m) throw new Error("note has no frontmatter");
  await writeFile(
    path,
    `---\n${setInlineList(m[1], "audio_at", [voice, String(Math.round(at))])}---\n${raw.slice(m[0].length)}`,
    "utf8",
  );
}

export async function savedFor(file: string): Promise<Saved[]> {
  const stem = stemOf(file);
  let raw = "";
  try { raw = await readFile(join(INBOX, file), "utf8"); } catch {}
  const at = audioAtOf(raw);
  let names: string[] = [];
  try { names = await readdir(audioDir()); } catch { return []; }
  const out: Saved[] = [];
  for (const v of VOICES) {
    const mp3 = `${stem}.${v.id}.mp3`;
    const json = `${stem}.${v.id}.json`;
    if (!names.includes(mp3) || !names.includes(json)) continue;
    try {
      const meta = JSON.parse(await readFile(join(audioDir(), json), "utf8")) as Sidecar;
      out.push({
        voice: v.id, label: v.label, provider: v.provider,
        seconds: meta.seconds || 0, chars: meta.chars || 0,
        created: meta.created || "", partial: Boolean(meta.partial),
        aligned: Boolean(meta.aligned),
        at: at.voice === v.id ? at.at : 0,
        url: `/reading/audio?f=${encodeURIComponent(mp3)}`,
        cuesUrl: `/reading/audio/cues?f=${encodeURIComponent(json)}`,
      });
    } catch { /* a sidecar we cannot read is a rendering we do not have */ }
  }
  return out;
}

// ── frontmatter ──────────────────────────────────────────────────────────────
// One key, `audio:`, as an inline list. Everything else in the file, body
// included, is sliced off and concatenated back byte for byte.

function setInlineList(fm: string, key: string, values: string[]): string {
  const line = `${key}: [${values.join(", ")}]`;
  const lines = fm.split("\n");
  const out: string[] = [];
  let done = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m && m[1] === key) {
      out.push(line);
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) i++;
      done = true;
      continue;
    }
    out.push(lines[i]);
  }
  if (!done) {
    const tail = out[out.length - 1] === "" ? out.pop()! : null;
    out.push(line);
    if (tail !== null) out.push(tail);
  }
  return out.join("\n");
}

async function recordVoice(file: string, voice: string): Promise<void> {
  const path = join(INBOX, file);
  const raw = await readFile(path, "utf8");
  const m = raw.match(/^---\n([\s\S]*?\n)---\n?/);
  if (!m) throw new Error("note has no frontmatter");
  const fm = m[1];
  const body = raw.slice(m[0].length);
  const have = (fm.match(/^audio:\s*\[(.*)\]\s*$/m)?.[1] || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (have.includes(voice)) return;
  have.push(voice);
  await writeFile(path, `---\n${setInlineList(fm, "audio", have)}---\n${body}`, "utf8");
}

// ── providers ────────────────────────────────────────────────────────────────
// Both keys live in ~/.secrets as shell env files. They are read into memory
// once, never logged, and never reach a response body.

const keyCache = new Map<string, string>();

async function secret(fileName: string, varName: string): Promise<string> {
  const hit = keyCache.get(varName);
  if (hit) return hit;
  let text: string;
  try { text = await readFile(join(SECRETS, fileName), "utf8"); }
  catch { throw new Error(`${varName} is not on this machine`); }
  const v = text.match(new RegExp(`^(?:export\\s+)?${varName}=(.+)$`, "m"))?.[1]?.trim()
    .replace(/^["']/, "").replace(/["']$/, "");
  if (!v) throw new Error(`${varName} is not set`);
  keyCache.set(varName, v);
  return v;
}

// A provider error is the one thing worth quoting verbatim: "insufficient
// credits" and "voice not found" want different things done about them.
async function providerMessage(res: Response, who: string): Promise<string> {
  let detail = "";
  try { detail = (await res.text()).slice(0, 300).replace(/\s+/g, " ").trim(); } catch {}
  return `${who} HTTP ${res.status}${detail ? ": " + detail : ""}`;
}

async function speakDeepgram(text: string, voice: Voice, out: string): Promise<void> {
  const key = await secret("deepgram-api-key.env", "DEEPGRAM_API_KEY");
  // mip_opt_out keeps his reading out of Deepgram's model-improvement program,
  // the same setting a side-project narration locked in.
  const q = new URLSearchParams({
    model: voice.id, encoding: "linear16", container: "wav",
    sample_rate: "24000", mip_opt_out: "true",
  });
  const res = await fetch(`https://api.deepgram.com/v1/speak?${q}`, {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(await providerMessage(res, "Deepgram"));
  await Bun.write(out, await res.arrayBuffer());
}

async function speakSarvam(text: string, voice: Voice, out: string): Promise<void> {
  const key = await secret("sarvam-api-key.env", "SARVAM_API_KEY");
  const res = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: { "api-subscription-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      inputs: [text], target_language_code: "en-IN",
      speaker: voice.id, model: voice.model || "bulbul:v3",
    }),
  });
  if (!res.ok) throw new Error(await providerMessage(res, "Sarvam"));
  const j: any = await res.json();
  const b64 = j?.audios?.[0];
  if (!b64) throw new Error("Sarvam returned no audio");
  await Bun.write(out, Buffer.from(b64, "base64"));
}

// ── ffmpeg ───────────────────────────────────────────────────────────────────

async function run(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd[0].split("/").pop()}: ${err.slice(-300).trim() || "exit " + code}`);
  return out;
}

async function durationOf(path: string): Promise<number> {
  const out = await run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", path]);
  const n = parseFloat(out.trim());
  return Number.isFinite(n) ? n : 0;
}

// ── the job queue ────────────────────────────────────────────────────────────
// One job at a time per note, chained on a promise so a second voice queues
// behind the first rather than racing it into the same directory. The job is
// not tied to the request that started it: the POST returns as soon as the job
// is queued, and the page asks how it is going afterwards.

type JobState = "queued" | "running" | "ready" | "failed";

interface Job {
  file: string;
  voice: string;
  state: JobState;
  done: number;
  total: number;
  message: string;
}

const jobs = new Map<string, Job>();
const chains = new Map<string, Promise<void>>();

function jobKey(file: string, voice: string): string { return `${file}\u0000${voice}`; }

// A few at once is enough to make a long article bearable without giving the
// provider a reason to rate-limit us.
const PARALLEL = 3;

async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function render(job: Job, voice: Voice, limitSeconds: number): Promise<void> {
  job.state = "running";
  const work = await mkdtemp(join(tmpdir(), "rl-listen-"));
  try {
    const prep = await prepare(job.file, voice);
    let chunks = prep.chunks;
    const partial = limitSeconds > 0 && prep.chars > limitSeconds * CHARS_PER_SECOND;
    if (partial) chunks = trim(chunks, limitSeconds);
    if (!chunks.length) throw new Error("nothing to read in this note");
    job.total = chunks.length;

    const wavs = chunks.map((_, i) => join(work, `c${String(i).padStart(4, "0")}.wav`));
    await pool(chunks, PARALLEL, async (chunk, i) => {
      if (voice.provider === "deepgram") await speakDeepgram(chunk.text, voice, wavs[i]);
      else await speakSarvam(chunk.text, voice, wavs[i]);
      job.done += 1;
    });

    const seconds = await Promise.all(wavs.map(durationOf));
    const list = wavs.map((w) => `file '${w.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
    await writeFile(join(work, "list.txt"), list, "utf8");
    const mp3 = join(work, "out.mp3");
    await run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
      "-f", "concat", "-safe", "0", "-i", join(work, "list.txt"),
      "-c:a", "libmp3lame", "-b:a", "64k", "-ac", "1", "-ar", "24000", mp3]);

    const total = seconds.reduce((n, s) => n + s, 0);
    const meta: Sidecar = {
      v: CUE_VERSION,
      provider: voice.provider, voice: voice.id, label: voice.label,
      seconds: Math.round(total), chars: chunks.reduce((n, c) => n + c.text.length, 0),
      created: new Date().toISOString(), partial, aligned: false,
      cues: interpolatedCues(prep.blocks, chunks, seconds),
    };

    // Listen back to what was just made and put the real time on every sentence.
    // It costs about a sixth of what the rendering did and is what makes the
    // highlight sit on the words rather than near them. If it fails the
    // interpolated cues stand and the rendering is still a rendering.
    try {
      const r = await alignFile(mp3, prep.blocks);
      meta.cues = r.cues;
      meta.aligned = true;
      meta.alignedAt = new Date().toISOString();
      meta.matched = Math.round(r.matched / Math.max(1, r.total) * 1000) / 1000;
      baseLog.info(`reading/audio: aligned ${job.file} — ${Math.round(r.matched / Math.max(1, r.total) * 100)}% of ${r.total} words`);
    } catch (e: any) {
      baseLog.error("reading/align:", String(e?.message || e));
    }

    await writeFile(join(work, "out.json"), JSON.stringify(meta), "utf8");

    // Only now does anything appear in the audio directory, and both files
    // appear together: a half-written mp3 with no sidecar would read as a
    // rendering that exists.
    await mkdir(audioDir(), { recursive: true });
    await rename(mp3, join(audioDir(), mp3Name(job.file, voice.id)));
    await rename(join(work, "out.json"), join(audioDir(), jsonName(job.file, voice.id)));
    await recordVoice(job.file, voice.id);

    job.state = "ready";
    baseLog.info(`reading/audio: ${voice.id} for ${job.file} — ${meta.seconds}s, ${meta.chars} chars`);
  } catch (e: any) {
    job.state = "failed";
    job.message = String(e?.message || e);
    baseLog.error("reading/audio:", job.message);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

function start(file: string, voice: Voice, limitSeconds: number): Job {
  const key = jobKey(file, voice.id);
  const live = jobs.get(key);
  if (live && (live.state === "queued" || live.state === "running")) return live;
  const job: Job = { file, voice: voice.id, state: "queued", done: 0, total: 0, message: "" };
  jobs.set(key, job);
  const prior = chains.get(file) || Promise.resolve();
  const chained = prior.then(() => render(job, voice, limitSeconds));
  chains.set(file, chained);
  return job;
}

// ── aligning something already rendered ──────────────────────────────────────
// Every rendering made before the aligner existed carries interpolated
// paragraph cues, and re-rendering to get sentence times would be spending the
// text-to-speech money twice for audio that is already correct. This takes the
// mp3 as it stands, listens to it, and rewrites only the sidecar.

export async function realign(file: string, voice: Voice): Promise<{ matched: number; sentences: number; seconds: number }> {
  const mp3 = join(audioDir(), mp3Name(file, voice.id));
  const sidecar = join(audioDir(), jsonName(file, voice.id));
  if (!(await Bun.file(mp3).exists())) throw new Error("no rendering to align");
  const meta = JSON.parse(await readFile(sidecar, "utf8")) as Sidecar;

  // A "first 30 minutes" rendering is only the front of the note. Aligning the
  // whole note's words against it would leave two thirds of them unmatched and
  // the run would be thrown away as untrustworthy, so cut the blocks back to
  // what the mp3 actually says — the sidecar records how many characters that
  // was, and the chunker is deterministic, so the same prefix comes back.
  const prep = await prepare(file, voice);
  let blocks = prep.blocks;
  if (meta.partial && meta.chars > 0) {
    const kept = new Set<number>();
    let n = 0;
    for (const c of prep.chunks) {
      if (n >= meta.chars) break;
      for (const p of c.parts) kept.add(p.i);
      n += c.text.length;
    }
    blocks = blocks.filter((b) => kept.has(b.i));
  }

  const r = await alignFile(mp3, blocks);
  meta.v = CUE_VERSION;
  meta.cues = r.cues;
  meta.aligned = true;
  meta.alignedAt = new Date().toISOString();
  meta.matched = Math.round(r.matched / Math.max(1, r.total) * 1000) / 1000;
  await writeFile(sidecar, JSON.stringify(meta), "utf8");
  baseLog.info(`reading/align: ${voice.id} for ${file} — ${r.cues.length} sentences, ${Math.round(r.matched / Math.max(1, r.total) * 100)}% matched`);
  return { matched: meta.matched, sentences: r.cues.length, seconds: r.seconds };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, message }, { status });
}

// f= here is a note basename, the same gate reading.ts uses for its own notes.
function safeNote(f: unknown): string | null {
  if (typeof f !== "string" || !f) return null;
  if (f.includes("/") || f.includes("\\") || f.includes("\0")) return null;
  if (f.startsWith(".") || !f.endsWith(".md")) return null;
  return f;
}

export async function readingAudioApi(path: string, req: Request, url: URL): Promise<Response | null> {
  if (path === "/api/reading/audio/estimate" && req.method === "POST") {
    let b: any = {};
    try { b = await req.json(); } catch {}
    const file = safeNote(b.file);
    const voice = voiceOf(b.voice);
    if (!file) return bad("bad file");
    if (!voice) return bad("unknown voice");
    try {
      const { chars, chunks } = await prepare(file, voice);
      if (!chars) return bad("nothing to read in this note");
      const seconds = Math.round(chars / CHARS_PER_SECOND);
      const cost = costOf(chars, voice);
      const capped = costOf(Math.min(chars, LONG_SECONDS * CHARS_PER_SECOND), voice);
      // What listening back to it costs, shown separately because it is a
      // second bill in a second currency: the speech-to-text that puts a real
      // time on every sentence is Deepgram's whatever the voice was.
      const align = (seconds / 60) * STT_USD_PER_MINUTE;
      return Response.json({
        ok: true, chars, seconds, minutes: minutesOf(seconds), parts: chunks.length,
        cost: cost.label, alignCost: `$${align.toFixed(2)}`,
        voice: voice.id, label: voice.label,
        long: seconds > LONG_SECONDS,
        capMinutes: LONG_SECONDS / 60, capCost: capped.label,
      });
    } catch (e: any) { return bad(e.message, 500); }
  }

  if (path === "/api/reading/audio/render" && req.method === "POST") {
    let b: any = {};
    try { b = await req.json(); } catch {}
    const file = safeNote(b.file);
    const voice = voiceOf(b.voice);
    if (!file) return bad("bad file");
    if (!voice) return bad("unknown voice");
    const limitSeconds = Number.isFinite(b.limitSeconds) && b.limitSeconds > 0
      ? Math.min(Number(b.limitSeconds), LONG_SECONDS) : 0;
    try { await readFile(join(INBOX, file), "utf8"); }
    catch { return bad("no such note", 404); }
    const job = start(file, voice, limitSeconds);
    return Response.json({ ok: true, state: job.state, done: job.done, total: job.total });
  }

  // Sentence times for an mp3 that already exists, without re-rendering it.
  // Synchronous on purpose: it is a one-off repair, it takes under a minute for
  // an hour of audio, and there is nothing useful to show while it runs.
  if (path === "/api/reading/audio/align" && req.method === "POST") {
    let b: any = {};
    try { b = await req.json(); } catch {}
    const file = safeNote(b.file);
    const voice = voiceOf(b.voice);
    if (!file) return bad("bad file");
    if (!voice) return bad("unknown voice");
    try {
      const r = await realign(file, voice);
      return Response.json({ ok: true, ...r });
    } catch (e: any) { return bad(String(e?.message || e), 500); }
  }

  // Where he is in a rendering, kept in the note. Small, frequent, and never
  // worth an error on screen: if it does not land, the local pointer still has
  // it and the next one will.
  if (path === "/api/reading/audio/at" && req.method === "POST") {
    let b: any = {};
    try { b = await req.json(); } catch {}
    const file = safeNote(b.file);
    const voice = voiceOf(b.voice);
    const at = Number(b.seconds);
    if (!file) return bad("bad file");
    if (!voice) return bad("unknown voice");
    if (!Number.isFinite(at) || at < 0) return bad("bad position");
    try {
      await recordAudioAt(file, voice.id, at);
      return Response.json({ ok: true });
    } catch (e: any) { return bad(String(e?.message || e), 500); }
  }

  if (path === "/api/reading/audio/state") {
    const file = safeNote(url.searchParams.get("f"));
    if (!file) return bad("bad file");
    const voiceId = url.searchParams.get("voice") || "";
    const saved = await savedFor(file);
    if (!voiceId) return Response.json({ ok: true, state: "none", saved });
    const job = jobs.get(jobKey(file, voiceId));
    const ready = saved.some((s) => s.voice === voiceId);
    const state = job ? job.state : ready ? "ready" : "none";
    return Response.json({
      ok: true, state, done: job?.done || 0, total: job?.total || 0,
      message: job?.message || "", saved,
    });
  }

  return null;
}

// GET /reading/audio?f=<stem>.<voice>.mp3 — the rendering itself.
//
// Range matters here and nowhere else on this page: Safari will not let you
// scrub, and on iOS will not play at all, unless the server answers a byte
// range with a 206. Bun.file().slice gives a lazily-read blob, so a seek into
// the middle of an hour of audio does not read the front of it.
export async function readingAudioFile(url: URL, req: Request): Promise<Response> {
  const f = safeAudio(url.searchParams.get("f"), ".mp3");
  if (!f) return new Response("Bad file", { status: 400 });
  const file = Bun.file(join(audioDir(), f));
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  const size = file.size;
  const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline";
  const base = {
    "Content-Type": "audio/mpeg",
    "Accept-Ranges": "bytes",
    "Content-Disposition": `${disposition}; filename="${f.replace(/"/g, "")}"`,
    "Cache-Control": "private, max-age=3600",
  };

  const range = req.headers.get("range");
  const m = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) {
    return new Response(file, { headers: { ...base, "Content-Length": String(size) } });
  }
  let start: number;
  let end: number;
  if (m[1] === "") {                       // "-500": the last 500 bytes
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) {
    return new Response("Range not satisfiable", {
      status: 416, headers: { "Content-Range": `bytes */${size}` },
    });
  }
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: {
      ...base,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
    },
  });
}

// GET /reading/audio/cues?f=<stem>.<voice>.json — where each paragraph starts.
export async function readingAudioCues(url: URL): Promise<Response> {
  const f = safeAudio(url.searchParams.get("f"), ".json");
  if (!f) return new Response("Bad file", { status: 400 });
  const file = Bun.file(join(audioDir(), f));
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, {
    headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=3600" },
  });
}
