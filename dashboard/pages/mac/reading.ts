// GET /reading — read-later queue (Mac only). One list, newest first, built
// straight off the markdown notes in the Obsidian vault at Reading/Inbox.
//
//   GET  /reading                    list
//   GET  /reading/item?f=<basename>  reader
//   GET  /reading/file?f=<name>.pdf   a document's own copy, from Reading/Files
//   GET  /reading/thumb?f=<name>.png  page one of it, from Reading/Files/.thumbs
//   GET  /reading/add?url=&tags=[&format=json]  save from a Share Sheet or bookmarklet
//   GET  /api/reading/list           JSON, filters kind= status= tag= len=
//   POST /api/reading/status         { file, status?, star? }
//   POST /api/reading/progress       { file, percent, reset? } -> how far in he is
//   POST /api/reading/add            { url } -> the read-later skill's add.sh --full
//   POST /api/reading/replace        { file, url } -> the note takes on that link
//   POST /api/reading/highlight      { file, text } -> appended to ## Highlights
//   POST /api/reading/note           { file, text } -> appended to ## Notes
//   /reading/audio*, /api/reading/audio/*  Listen; see reading-audio.ts
//   /reading/static/*, /reading/sw.js, /reading/manifest.webmanifest, /reading/img
//                                    offline; see reading-offline.ts
//
// The notes are the database. Nothing here caches, nothing here deletes, and
// every write touches one frontmatter key and leaves the body byte-for-byte.
//
// The chrome is not here either. Every stylesheet and every page script is a
// file under static/reading/, linked with a content hash; this module is the
// markup, plus one small window.RL of whatever the server already knew.

import { readdir, readFile, writeFile, rename, mkdir, stat, appendFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { layout, esc, md } from "../../lib/html";
import { baseLog } from "../../lib/log";
// Listen. Only values used inside functions are taken from here: the two
// modules import each other (this one renders the control, that one reads the
// body through readerBodyHtml), and a top-level reference either way would
// evaluate before the other module had finished.
import {
  VOICES, DEFAULT_VOICE, LONG_SECONDS, savedFor, readingAudioApi,
} from "./reading-audio";
import type { Saved as SavedAudio } from "./reading-audio";
// Offline. The chrome is served from there with a hash in its address, and the
// worker, the manifest and the image proxy live there too.
import { chromeUrl, proxyImages } from "./reading-offline";

const HOME = homedir();
export const INBOX = join(HOME, "work/self/notes-vault/Reading/Inbox");
const ADD_SH = join(HOME, ".claude/skills/read-later/add.sh");
const TRASH = join(HOME, "work/self/notes-vault/Reading/Trash");
// Documents keep their own copy of the file beside the notes: a PDF that was
// on a CDN yesterday may not be tomorrow, and the preview should not depend on
// the far end allowing an iframe.
export const FILES = join(HOME, "work/self/notes-vault/Reading/Files");
const THUMBS = join(FILES, ".thumbs");
const VAULT = "notes-vault";

export type Kind = "article" | "video" | "tweet" | "document" | "book";

export interface Note {
  file: string;      // basename, with .md
  title: string;
  source: string;
  site: string;
  author: string;
  published: string;
  clipped: string;
  status: string;    // unread | read | skipped
  progress: number;   // 0 to 100, the furthest point he has reached
  progressAt: string; // when that point was reached, local ISO, "" when never
  fetched: boolean;
  starred: boolean;
  kind: Kind;
  via: string;
  duration: number;   // seconds, videos only, 0 when unknown
  pages: number;      // documents only, 0 when unknown
  pdf: string;        // documents: the file's name under Reading/Files, else ""
  readMin: number;    // minutes, 0 when we should not guess
  xArticle: boolean;      // an X long-form post: it has a title and an essay
  noTranscript: boolean;  // yt-dlp found no captions; do not ask again
  noBody: boolean;        // the article would not extract; do not ask again
  rating: number;     // 1 to 7, 0 when unrated
  tags: string[];     // without "reading" and "starred", which are structural
  added: string;      // when it entered the queue; the only thing ordering uses
}

// ── frontmatter ──────────────────────────────────────────────────────────────
// Notes come from three writers (the skill, the feeds, Obsidian itself), so
// both inline (`tags: [a, b]`) and block (`tags:\n  - a`) YAML show up.

function splitNote(raw: string): { fm: string; body: string } {
  const m = raw.match(/^---\n([\s\S]*?\n)---\n?/);
  if (!m) return { fm: "", body: raw };
  return { fm: m[1], body: raw.slice(m[0].length) };
}

function parseFm(fm: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val === "") {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) {
        items.push(unquote(lines[++i].replace(/^\s+-\s*/, "")));
      }
      out[key] = items.length ? items : "";
    } else if (val.startsWith("[") && val.endsWith("]")) {
      out[key] = val.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean);
    } else {
      out[key] = unquote(val);
    }
  }
  return out;
}

function unquote(s: string): string {
  return s.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").trim();
}

function asList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function str(v: string | string[] | undefined): string {
  if (!v) return "";
  return Array.isArray(v) ? v[0] || "" : v;
}

// 0 to 100 and nothing else. A note written by hand can say anything.
function pctOf(v: string): number {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

// 1 to 7, kepano's scale. Anything else is unrated.
function ratingOf(v: string): number {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 1 && n <= 7 ? n : 0;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function isPdfUrl(url: string): boolean {
  try { return /\.pdf$/i.test(new URL(url).pathname); } catch { return false; }
}

// arXiv publishes the same paper twice: /abs/<id> is the listing page, and the
// paper itself is at /pdf/<id>. The listing is what a clipper catches.
function arxivAbsId(url: string): string {
  try {
    const u = new URL(url);
    if (!/(^|\.)arxiv\.org$/.test(u.hostname)) return "";
    const m = /^\/abs\/(.+?)\/?$/.exec(u.pathname);
    return m ? m[1] : "";
  } catch { return ""; }
}

// An Amazon product page or a Goodreads book page, the same test add.sh makes.
function isBookUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^(www|smile)\./, "");
    if (/^amazon\.[a-z.]+$/.test(h)) return /\/(dp|gp\/product)\/[A-Z0-9]{10}/.test(u.pathname);
    return h === "goodreads.com" && u.pathname.startsWith("/book/");
  } catch { return false; }
}

function kindOf(fm: Record<string, string | string[]>, source: string): Kind {
  const k = str(fm.kind);
  if (k === "article" || k === "video" || k === "tweet" || k === "document" || k === "book") return k;
  const h = hostOf(source);
  if (isBookUrl(source)) return "book";
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(h)) return "video";
  if (/(^|\.)(x|twitter)\.com$/.test(h)) return "tweet";
  if (isPdfUrl(source)) return "document";
  return "article";
}

// Cleans up the "[[@handle]]" wikilink form the vault stores authors in.
function authorOf(fm: Record<string, string | string[]>): string {
  const a = asList(fm.author)[0] || "";
  return a.replace(/^\[\[/, "").replace(/\]\]$/, "").trim();
}

function toNote(file: string, raw: string): Note {
  const { fm: fmText, body } = splitNote(raw);
  const fm = parseFm(fmText);
  const source = str(fm.source);
  const tags = asList(fm.tags);
  const title = (body.match(/^#\s+(.+)$/m)?.[1] || file.replace(/\.md$/, "")).trim();
  const kind = kindOf(fm, source);
  const fetched = str(fm.fetched) === "true";
  const duration = parseInt(str(fm.duration) || "0", 10) || 0;

  // A number here has to be worth trusting. An article that was never fetched
  // has no body to count, and a tweet is a tweet.
  let readMin = 0;
  if (kind === "video" && duration > 0) {
    readMin = Math.max(1, Math.round(duration / 60));
  } else if ((kind === "article" || kind === "document" || str(fm.article) === "true") && fetched) {
    const words = splitMarginalia(body).main.trim().split(/\s+/).length;
    if (words > 40) readMin = Math.max(1, Math.round(words / 230));
  }

  return {
    file,
    title,
    source,
    site: str(fm.site) || hostOf(source),
    author: authorOf(fm),
    published: str(fm.published),
    clipped: str(fm.clipped),
    status: str(fm.status) || "unread",
    progress: pctOf(str(fm.progress)),
    progressAt: str(fm.progress_at),
    fetched,
    // Star is its own thing now: it means the "starred" tag, nothing else.
    // Rating is the owner's 1 to 7 scale and is not a way of starring.
    starred: tags.includes("starred"),
    kind,
    via: str(fm.via),
    duration,
    pages: parseInt(str(fm.pages) || "0", 10) || 0,
    pdf: /^[^/\\]+\.pdf$/i.test(str(fm.pdf)) ? str(fm.pdf) : "",
    readMin,
    xArticle: str(fm.article) === "true",
    noTranscript: str(fm.transcript) === "none",
    noBody: str(fm.body) === "unavailable",
    rating: ratingOf(str(fm.rating)),
    tags: tags.filter((t) => t !== "reading" && t !== "starred"),
    added: str(fm.added) || `${str(fm.clipped)}T00:00:00`,
  };
}

async function loadNotes(): Promise<Note[]> {
  let files: string[] = [];
  try { files = (await readdir(INBOX)).filter((f) => f.endsWith(".md")); }
  catch (e) { baseLog.error("reading: cannot read inbox:", e); return []; }

  const notes = await Promise.all(files.map(async (f) => {
    try { return toNote(f, await readFile(join(INBOX, f), "utf8")); }
    catch { return null; }
  }));
  // Ordering is `added` and nothing else. It used to fall back to file mtime,
  // which meant prefetch or the tagger touching a note shot it to the top of
  // the list; the day something entered the queue does not change.
  return notes
    .filter((n): n is Note => n !== null)
    .sort((a, b) => b.added.localeCompare(a.added) || a.title.localeCompare(b.title));
}

// f= is a basename and nothing else: no separator, no leading dot, .md only.
// A title may legitimately contain "..." (tweets often do), so the check is on
// separators and on the leading character, not on the two-dot sequence.
function safeFile(f: string | null): string | null {
  if (!f) return null;
  if (f.includes("/") || f.includes("\\") || f.includes("\0")) return null;
  if (f.startsWith(".")) return null;
  if (!f.endsWith(".md")) return null;
  return f;
}

// ── frontmatter writes ───────────────────────────────────────────────────────
// Every write rebuilds the frontmatter block only. The body is sliced off the
// original string and concatenated back untouched.

function setScalar(fm: string, key: string, value: string): string {
  const lines = fm.split("\n");
  const out: string[] = [];
  let done = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m && m[1] === key) {
      out.push(value === "" ? `${key}:` : `${key}: ${value}`);
      // drop any block-list continuation that belonged to the old value
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) i++;
      done = true;
      continue;
    }
    out.push(lines[i]);
  }
  if (!done) {
    // keep the trailing blank line produced by the split at the end
    const tail = out[out.length - 1] === "" ? out.pop()! : null;
    out.push(value === "" ? `${key}:` : `${key}: ${value}`);
    if (tail !== null) out.push(tail);
  }
  return out.join("\n");
}

// The inverse of setScalar: take one key out of the block, with whatever
// block-list continuation belonged to it. add.sh calls this fm_del.
function dropScalar(fm: string, key: string): string {
  const lines = fm.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m && m[1] === key) {
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) i++;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

function setTag(fm: string, tag: string, on: boolean): string {
  const lines = fm.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inline = line.match(/^tags:\s*\[(.*)\]\s*$/);
    if (inline) {
      let items = inline[1].split(",").map((s) => unquote(s.trim())).filter(Boolean);
      items = on ? (items.includes(tag) ? items : [...items, tag]) : items.filter((t) => t !== tag);
      out.push(`tags: [${items.join(", ")}]`);
      continue;
    }
    if (/^tags:\s*$/.test(line)) {
      const items: string[] = [];
      let indent = "  - ";
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) {
        const l = lines[++i];
        indent = l.match(/^(\s+-\s*)/)![1];
        items.push(unquote(l.replace(/^\s+-\s*/, "")));
      }
      const next = on ? (items.includes(tag) ? items : [...items, tag]) : items.filter((t) => t !== tag);
      out.push("tags:");
      for (const t of next) out.push(`${indent}${t}`);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// Rewrites the tags list in place, keeping the style the file already uses and
// never dropping "reading", which is what marks a note as part of the queue.
function writeTags(fm: string, next: string[]): string {
  const list = ["reading", ...next.filter((t) => t !== "reading")];
  const lines = fm.split("\n");
  const out: string[] = [];
  let block = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^tags:\s*\[.*\]\s*$/.test(line)) {
      out.push(`tags: [${list.join(", ")}]`);
      continue;
    }
    if (/^tags:\s*$/.test(line)) {
      let indent = "  - ";
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) {
        indent = lines[++i].match(/^(\s+-\s*)/)![1];
      }
      out.push("tags:");
      for (const t of list) out.push(`${indent}${t}`);
      block = true;
      continue;
    }
    out.push(line);
  }
  if (!block && !out.some((l) => /^tags:/.test(l))) {
    const tail = out[out.length - 1] === "" ? out.pop()! : null;
    out.push(`tags: [${list.join(", ")}]`);
    if (tail !== null) out.push(tail);
  }
  return out.join("\n");
}

function cleanTag(raw: string): string {
  return String(raw).toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 30);
}

async function applyTags(file: string, add: string[], remove: string[]): Promise<Note> {
  const path = join(INBOX, file);
  const raw = await readFile(path, "utf8");
  const { fm, body } = splitNote(raw);
  if (!fm) throw new Error("note has no frontmatter");

  const current = asList(parseFm(fm).tags);
  const drop = new Set(remove.map(cleanTag).filter(Boolean));
  let next = current.filter((t) => !drop.has(t));
  for (const t of add.map(cleanTag).filter(Boolean)) {
    if (!next.includes(t) && next.length < 20) next.push(t);
  }
  const out = `---\n${writeTags(fm, next)}---\n${body}`;
  await writeFile(path, out, "utf8");
  return toNote(file, out);
}

async function applyStatus(file: string, opts: { status?: string; star?: boolean; rating?: number | null }): Promise<Note> {
  const path = join(INBOX, file);
  const raw = await readFile(path, "utf8");
  const { fm, body } = splitNote(raw);
  if (!fm) throw new Error("note has no frontmatter");

  let next = fm;
  if (opts.status) next = setScalar(next, "status", opts.status);
  // Done and progress are one fact, so one write says both: finishing a piece
  // is being 100% through it, and putting it back in the queue is saying you
  // are not through it at all. Skipped is left alone — deciding not to read
  // something is not a claim to have read it.
  if (opts.status === "read") next = setProgress(next, 100);
  if (opts.status === "unread") next = dropScalar(dropScalar(next, "progress"), "progress_at");
  // Star owns the "starred" tag and nothing else. Rating is the 1 to 7 scale
  // and is set on its own; one is a shortlist, the other is a verdict.
  if (opts.star !== undefined) next = setTag(next, "starred", opts.star);
  if (opts.rating !== undefined) next = setScalar(next, "rating", opts.rating ? String(opts.rating) : "");
  await writeFile(path, `---\n${next}---\n${body}`, "utf8");
  return toNote(file, `---\n${next}---\n${body}`);
}

// ── progress ─────────────────────────────────────────────────────────────────
// Two keys, written together so the number always says when it was true:
//
//   progress: 42
//   progress_at: 2026-09-11T15:20:04
//
// The furthest point wins. The reader reports where he is every few seconds and
// again on the way out, from three different places (the scroll, the video
// player, the voice), on however many devices; taking the maximum is what makes
// that safe to do from all of them at once. Going backwards is a decision, and
// there are exactly two ways to say it: Unread, or an explicit reset.

function isoStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function setProgress(fm: string, pct: number): string {
  return setScalar(setScalar(fm, "progress", String(pct)), "progress_at", isoStamp());
}

// `exact` is the book picker: a book has no scroll to measure, so the number is
// whatever he says it is, lower included, and 0 takes it off.
async function applyProgress(file: string, percent: number, reset: boolean, exact = false): Promise<Note> {
  const path = join(INBOX, file);
  const raw = await readFile(path, "utf8");
  const { fm, body } = splitNote(raw);
  if (!fm) throw new Error("note has no frontmatter");

  const now = pctOf(str(parseFm(fm).progress));
  let next: string;
  if ((reset || exact) && percent === 0) next = dropScalar(dropScalar(fm, "progress"), "progress_at");
  else if (percent > now || (exact && percent !== now)) next = setProgress(fm, percent);
  // Nothing to say: he is behind the mark he already left, which is the normal
  // case for a re-read. The file is not touched at all, so the vault does not
  // see a write every five seconds.
  else return toNote(file, raw);

  const out = `---\n${next}---\n${body}`;
  await writeFile(path, out, "utf8");
  return toNote(file, out);
}

// ── highlights and notes ─────────────────────────────────────────────────────
// Both live in the note body so Obsidian sees them, in two sections pinned to
// the end of the file in a fixed order:
//
//   ## Highlights
//
//   > the selected text
//
//   ## Notes
//
//   - 2026-09-08 14:05 the note
//
// Everything above them is passed through byte for byte, and neither one
// touches the frontmatter: highlighting a paragraph does not mean you are done
// with the piece.

const HL_HEAD = "## Highlights";
const NT_HEAD = "## Notes";

// A highlight can carry its own notes, indented under the quote the way
// Readwise writes them, so a thought stays attached to the line that caused it.
interface Highlight { text: string; notes: string[] }
interface Marginalia { main: string; highlights: Highlight[]; notes: string[] }

function collapse(s: string): string {
  return String(s).replace(/\s+/g, " ").trim();
}

// The tail is only ours when every line from the heading to the end of the file
// is a heading, a blockquote or a bullet. An article whose own text has a
// "## Notes" section of prose fails that test and is left alone.
function splitMarginalia(body: string): Marginalia {
  const re = /^## (?:Highlights|Notes)[ \t]*$/gm;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) starts.push(m.index);

  let cut = -1;
  for (const i of starts) {
    const structural = body.slice(i).split("\n").every((line) => {
      const t = line.trim();
      return t === "" || t === HL_HEAD || t === NT_HEAD || t === ">" || t.startsWith("> ") || t.startsWith("- ");
    });
    if (structural) { cut = i; break; }
  }
  if (cut < 0) return { main: body, highlights: [], notes: [] };

  const highlights: Highlight[] = [];
  const notes: string[] = [];
  let mode: "h" | "n" | null = null;
  for (const line of body.slice(cut).split("\n")) {
    const t = line.trim();
    if (t === HL_HEAD) { mode = "h"; continue; }
    if (t === NT_HEAD) { mode = "n"; continue; }
    if (mode === "h" && t.startsWith("> ")) {
      highlights.push({ text: t.slice(2).trim(), notes: [] });
    } else if (mode === "h" && t.startsWith("- ") && highlights.length) {
      // indented under the quote above it
      highlights[highlights.length - 1].notes.push(t.slice(2).trim());
    } else if (mode === "n" && t.startsWith("- ")) {
      notes.push(t.slice(2).trim());
    }
  }
  return { main: body.slice(0, cut), highlights, notes };
}

function joinMarginalia(mg: Marginalia): string {
  if (!mg.highlights.length && !mg.notes.length) return mg.main;
  // pure append: pad up to one blank line, never trim what is already there
  let out = mg.main;
  if (!out.endsWith("\n\n")) out += out.endsWith("\n") ? "\n" : "\n\n";
  out += `${HL_HEAD}\n\n`;
  if (mg.highlights.length) {
    out += mg.highlights
      .map((h) => `> ${h.text}` + h.notes.map((x) => `\n    - ${x}`).join(""))
      .join("\n\n") + "\n\n";
  }
  out += `${NT_HEAD}\n\n`;
  if (mg.notes.length) out += mg.notes.map((n) => `- ${n}`).join("\n") + "\n";
  return out;
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// A selection that starts or ends mid-word is almost always a fat finger on a
// phone, not an intention. Grow it out to the nearest word edges using the note
// itself, which is the only place that knows what the neighbouring letters are.
function snapToWords(main: string, sel: string): string {
  const flat = main.replace(/\s+/g, " ");
  const at = flat.indexOf(sel);
  if (at < 0) return sel.trim();
  let a = at;
  let b = at + sel.length;
  while (a > 0 && /\w/.test(flat[a - 1]) && /\w/.test(flat[a])) a--;
  while (b < flat.length && /\w/.test(flat[b]) && /\w/.test(flat[b - 1])) b++;
  return flat.slice(a, b).trim();
}

type MargOp =
  | { op: "highlight"; text: string }
  | { op: "unhighlight"; text: string }
  | { op: "highlight-note"; highlight: string; text: string }
  | { op: "note"; text: string };

async function editMarginalia(file: string, action: MargOp): Promise<{ mg: Marginalia; duplicate: boolean }> {
  const path = join(INBOX, file);
  const raw = await readFile(path, "utf8");
  const { fm, body } = splitNote(raw);
  if (!fm) throw new Error("note has no frontmatter");

  const mg = splitMarginalia(body);
  let duplicate = false;
  let changed = true;

  if (action.op === "highlight") {
    const text = snapToWords(mg.main, action.text);
    if (mg.highlights.some((h) => h.text === text)) duplicate = true;
    else mg.highlights.push({ text, notes: [] });
    changed = !duplicate;
  } else if (action.op === "unhighlight") {
    const before = mg.highlights.length;
    mg.highlights = mg.highlights.filter((h) => h.text !== action.text);
    changed = mg.highlights.length !== before;
  } else if (action.op === "highlight-note") {
    const target = mg.highlights.find((h) => h.text === action.highlight);
    if (!target) throw new Error("no such highlight");
    target.notes.push(`${stamp()} ${action.text}`);
  } else {
    mg.notes.push(`${stamp()} ${action.text}`);
  }

  if (changed) await writeFile(path, `---\n${fm}---\n${joinMarginalia(mg)}`, "utf8");
  return { mg, duplicate };
}

// Tint the highlighted passages in the rendered body. Splitting on tags keeps
// the search inside text, so a highlight can never rewrite an attribute, and
// normalizing whitespace inside a text node is a no-op in normal flow while
// letting a selection that spanned a line break still match.
function markHighlights(html: string, highlights: Highlight[]): string {
  const needles: { needle: string; source: string }[] = [];
  for (const h of highlights) {
    if (h.text.length < 4) continue;
    const full = esc(h.text).replace(/\s+/g, " ");
    const minimal = h.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\s+/g, " ");
    needles.push({ needle: full, source: h.text });
    if (minimal !== full) needles.push({ needle: minimal, source: h.text });
  }
  if (!needles.length) return html;

  const parts = html.split(/(<[^>]*>)/);
  let inPre = false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith("<")) {
      if (/^<pre\b/i.test(part)) inPre = true;
      else if (/^<\/pre\b/i.test(part)) inPre = false;
      continue;
    }
    if (inPre || !part.trim()) continue;
    let seg = part.replace(/\s+/g, " ");
    for (const n of needles) {
      // the mark carries its own text so tapping it can manage that highlight
      if (seg.includes(n.needle)) {
        seg = seg.split(n.needle).join(`<mark class="rl-mark" data-h="${esc(n.source)}">${n.needle}</mark>`);
      }
    }
    parts[i] = seg;
  }
  return parts.join("");
}

function highlightsHtml(highlights: Highlight[]): string {
  return highlights.map((h) => {
    const notes = h.notes.map((x) => {
      const m = x.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+([\s\S]*)$/);
      return `<li class="rl-hl-note">${m ? `<span class="rl-note-when">${esc(m[1])}</span> ${esc(m[2])}` : esc(x)}</li>`;
    }).join("");
    return `<div class="rl-hl-item" data-h="${esc(h.text)}">`
      + `<blockquote class="rl-hl">${esc(h.text)}</blockquote>`
      + (notes ? `<ul class="rl-hl-notes">${notes}</ul>` : "")
      + `<span class="rl-hl-acts">`
      + `<button type="button" class="rl-hl-act" data-a="note">+ note</button>`
      + `<button type="button" class="rl-hl-act" data-a="remove">remove</button>`
      + `</span></div>`;
  }).join("");
}

function notesHtml(notes: string[]): string {
  return notes.map((n) => {
    const m = n.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+([\s\S]*)$/);
    const when = m ? m[1] : "";
    const text = m ? m[2] : n;
    return `<li class="rl-note">${when ? `<span class="rl-note-when">${esc(when)}</span> ` : ""}${esc(text)}</li>`;
  }).join("");
}

// ── fetching (delegates to the read-later skill, one implementation) ─────────

// One line per write, so "did that save?" has an answer that is not a guess.
const ACTION_LOG = join(HOME, "kush/logs/read-later-actions.log");

async function logAction(what: string, file: string, detail = ""): Promise<void> {
  const line = `${new Date().toISOString()} ${what} ${file}${detail ? " " + detail : ""}\n`;
  try {
    await mkdir(join(HOME, "kush/logs"), { recursive: true });
    await appendFile(ACTION_LOG, line, "utf8");
  } catch (e) { baseLog.error("reading: action log:", e); }
}

const inflight = new Map<string, Promise<string>>();

function runAdd(url: string, via: string, tags: string[] = [], full = true): Promise<string> {
  return new Promise((resolve) => {
    const args = [ADD_SH, url, "--via", via];
    if (full) args.push("--full");
    if (tags.length) args.push("--tags", tags.join(","));
    const proc = Bun.spawn(args, {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}` },
    });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, 120_000);
    (async () => {
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      clearTimeout(timer);
      resolve(out.trim());
    })();
  });
}

// A video with no captions and a page that will not extract are both permanent
// answers, not slow ones. After two honest attempts the note records that, so
// neither the reader nor the hourly prefetch asks again.
const MAX_FETCH_TRIES = 2;

async function noteAttempts(file: string): Promise<number> {
  try {
    const raw = await readFile(join(INBOX, file), "utf8");
    return parseInt(str(parseFm(splitNote(raw).fm).fetch_attempts) || "0", 10) || 0;
  } catch { return 0; }
}

async function recordAttempt(file: string, kind: Kind, tries: number): Promise<void> {
  const path = join(INBOX, file);
  const raw = await readFile(path, "utf8");
  const { fm, body } = splitNote(raw);
  if (!fm) return;
  let next = setScalar(fm, "fetch_attempts", String(tries));
  if (tries >= MAX_FETCH_TRIES) {
    next = setScalar(next, "fetched", "true");
    next = kind === "video"
      ? setScalar(next, "transcript", "none")
      : setScalar(next, "body", "unavailable");
  }
  await writeFile(path, `---\n${next}---\n${body}`, "utf8");
}

export interface FetchState { ready: boolean; failed: boolean; kind: Kind }

// add.sh's upgrade path keeps the frontmatter and throws the whole body away,
// which would take his highlights and notes with it. They are his, so they are
// lifted out before each pass and put back after it. Nothing to do on a note
// that has none, which is every note the reader fetches for the first time.
async function keepMarginalia(file: string): Promise<Marginalia | null> {
  try {
    const mg = splitMarginalia(splitNote(await readFile(join(INBOX, file), "utf8")).body);
    return mg.highlights.length || mg.notes.length ? mg : null;
  } catch { return null; }
}

async function putMarginaliaBack(file: string, keep: Marginalia | null): Promise<void> {
  if (!keep) return;
  try {
    const path = join(INBOX, file);
    const { fm, body } = splitNote(await readFile(path, "utf8"));
    if (!fm) return;
    const mg = splitMarginalia(body);
    const seen = new Set(mg.highlights.map((h) => h.text));
    for (const h of keep.highlights) if (!seen.has(h.text)) mg.highlights.push(h);
    const known = new Set(mg.notes);
    for (const n of keep.notes) if (!known.has(n)) mg.notes.push(n);
    await writeFile(path, `---\n${fm}---\n${joinMarginalia(mg)}`, "utf8");
  } catch (e) { baseLog.error("reading: marginalia restore:", e); }
}

// Runs at most two add.sh passes and then gives a definite answer either way.
async function fetchBounded(file: string, source: string, kind: Kind): Promise<FetchState> {
  let tries = await noteAttempts(file);
  while (tries < MAX_FETCH_TRIES) {
    const keep = await keepMarginalia(file);
    await runAdd(source, "web");
    await putMarginaliaBack(file, keep);
    try {
      const n = toNote(file, await readFile(join(INBOX, file), "utf8"));
      if (n.fetched) return { ready: true, failed: false, kind };
    } catch { return { ready: false, failed: true, kind }; }
    tries += 1;
    await recordAttempt(file, kind, tries);
  }
  return { ready: false, failed: true, kind };
}

const fetching = new Map<string, Promise<FetchState>>();

function startFetch(file: string, source: string, kind: Kind): Promise<FetchState> {
  let p = fetching.get(file);
  if (!p) {
    p = fetchBounded(file, source, kind).finally(() => setTimeout(() => fetching.delete(file), 3000));
    fetching.set(file, p);
  }
  return p;
}

function ensureFetched(key: string, url: string, via = "web", tags: string[] = [], full = true): Promise<string> {
  let p = inflight.get(key);
  if (!p) {
    p = runAdd(url, via, tags, full).finally(() => setTimeout(() => inflight.delete(key), 5000));
    inflight.set(key, p);
  }
  return p;
}

// What add.sh would call this link. The extension is the cheap answer; a PDF
// served from a path with no extension only admits it in the content type.
async function kindForUrl(url: string): Promise<Kind> {
  const guess = kindOf({}, url);
  if (guess !== "article") return guess;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, {
      method: "HEAD", redirect: "follow", signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    clearTimeout(timer);
    if ((res.headers.get("content-type") || "").toLowerCase().includes("application/pdf")) return "document";
  } catch {}
  return "article";
}

// Everything the old address put there. A note that is about to be about
// something else must not keep the first thing's page count or byline, and the
// give-up markers describe a failure that has not happened to the new link yet.
const REPLACE_DROPS = ["pdf", "pages", "duration", "transcript", "body", "fetch_attempts", "published", "author"];

// Point a note at a different link and let the ordinary fetch fill it in. The
// file keeps its name, so the name goes stale until the vault is tidied; the
// alternative is a second note and a lost position. `added`, `status`,
// `rating`, `tags`, `via` and `clipped` are his decisions about this row in the
// queue and survive, as do his highlights and notes; the H1 goes so add.sh
// looks the title up again; the address it used to hold is written down.
async function applyReplace(file: string, newUrl: string): Promise<{ kind: Kind; from: string }> {
  const path = join(INBOX, file);
  const raw = await readFile(path, "utf8");
  const { fm, body } = splitNote(raw);
  if (!fm) throw new Error("note has no frontmatter");

  const from = str(parseFm(fm).source);
  const kind = await kindForUrl(newUrl);

  let next = setScalar(fm, "source", newUrl);
  next = setScalar(next, "site", hostOf(newUrl));
  next = setScalar(next, "kind", kind);
  next = setScalar(next, "fetched", "false");
  for (const key of REPLACE_DROPS) next = dropScalar(next, key);
  if (from) next = setScalar(next, "replaced", from);

  const mg = splitMarginalia(body);
  mg.main = `**[Open original \u2192](${newUrl})**\n\n*Not yet fetched.*\n`;
  await writeFile(path, `---\n${next}---\n${joinMarginalia(mg)}`, "utf8");
  return { kind, from };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Safari will hand back a bfcache copy of the list when you navigate away from
// the reader and come straight back, so a note marked Done still shows as
// unread. The page asks not to be stored and refetches on a restore; this stops
// the same staleness reaching the API responses.
function noStore(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "no-store, must-revalidate");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// ── shared chrome ────────────────────────────────────────────────────────────

// Flexoki. The dashboard's own tokens are redefined here rather than shadowed,
// so the shared nav and the .md renderer come along without a second stylesheet.
// Flexoki, in the shape stephango.com uses it: paper ground, text-coloured
// links with a hairline underline, accent reserved for controls.
const LIGHT = `
  --bg: #FFFCF0; --surface: #F2F0E5; --border: #E6E4D9;
  --text: #100F0F; --text2: #6F6E69; --text3: #B7B5AC;
  --accent: #205EA6; --mark: #FAEEC6; --danger: #AF3029;`;

const DARK = `
  --bg: #100F0F; --surface: #1C1B1A; --border: #282726;
  --text: #CECDC3; --text2: #878580; --text3: #575653;
  --accent: #4385BE; --mark: #3A2D0B; --danger: #D14D41;`;

const TOKENS = `
:root {${LIGHT}
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${DARK} } }
:root[data-theme="dark"] {${DARK} }
:root[data-theme="light"] {${LIGHT} }`;

const DARK_FORCED = `
:root {${DARK} }
.rl-theme-knob { transform: translateX(22px); }
.rl-theme .rl-moon { display: block; }
.rl-theme .rl-sun { display: none; }`;

// The dog-ear is the whole idea: a page with its corner turned down is the mark
// you leave on something you mean to come back to.
// On a dark rounded tile (18 Oct 2026, the owner): the bare page vanished on Dia's
// pale sidebar tiles; the tile matches the app icon and the fund, usage and
// research icons.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">`
  + `<rect width="32" height="32" rx="7" fill="#1C1B1A"/>`
  + `<g transform="translate(4.9 4.2) scale(0.72)">`
  + `<path d="M6 3h13l7 7v19a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="#FFFCF0"/>`
  + `<path d="M19 3l7 7h-6a1 1 0 0 1-1-1z" fill="#D0A215"/>`
  + `<g stroke="#1C1B1A" stroke-width="1.4" stroke-linecap="round" opacity="0.3"><path d="M9 15h8M9 18.5h13M9 22h13M9 25.5h10"/></g>`
  + `</g></svg>`;

const FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`;

// The manifest is what makes Add to Home Screen give a standalone app rather
// than a Safari tab, and a standalone app is what stops Safari evicting the
// offline copy after seven days of not being opened.
const HEAD_TAGS =
  `<link rel="icon" type="image/svg+xml" href="${FAVICON_HREF}">`
  + `<link rel="icon" type="image/png" sizes="180x180" href="/static/reading-icon-180.png">`
  + `<link rel="apple-touch-icon" href="/static/reading-icon-180.png">`
  + `<link rel="manifest" href="/reading/manifest.webmanifest">`
  + `<meta name="apple-mobile-web-app-capable" content="yes">`
  + `<meta name="mobile-web-app-capable" content="yes">`
  + `<meta name="apple-mobile-web-app-title" content="Reading">`
  + `<meta name="apple-mobile-web-app-status-bar-style" content="default">`
  + `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#FFFCF0">`
  + `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#100F0F">`;

function themeToggleHtml(): string {
  return `<button type="button" class="rl-theme" id="rl-theme" aria-label="Switch theme">`
    + `<span class="rl-theme-knob">`
    + `<svg class="rl-sun" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">`
    + `<circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none"/>`
    + `<path d="M8 1.4v1.6M8 13v1.6M1.4 8h1.6M13 8h1.6M3.3 3.3l1.1 1.1M11.6 11.6l1.1 1.1M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1"/></svg>`
    + `<svg class="rl-moon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">`
    + `<path d="M13.3 9.9A5.6 5.6 0 0 1 6.1 2.7a5.7 5.7 0 1 0 7.2 7.2z"/></svg>`
    + `</span></button>`;
}

// Applied before paint so a stored choice does not flash the other theme.
const THEME_BOOT = `<script>
(function () {
  try {
    var t = localStorage.getItem("rl-theme");
    if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
  } catch (e) {}
})();
</script>`;

// The head of every reading page: the tokens and the forced-dark override
// inline, because they have to be in the cascade before the sheets that use
// them and they are four hundred bytes; the rest as two stylesheets with a
// content hash in the address, cached for a year and precached by the worker.
// The theme boot stays inline for the same reason it always did — it runs
// before first paint so a stored choice never flashes the other theme.
async function readingHead(css: string, dark: boolean): Promise<string> {
  return `<style>${TOKENS}${dark ? DARK_FORCED : ""}</style>`
    + `<link rel="stylesheet" href="${await chromeUrl("reading.css")}">`
    + `<link rel="stylesheet" href="${await chromeUrl(css)}">`
    + THEME_BOOT;
}

// What the page knew and the scripts need: one small JSON object, so the
// scripts themselves are static files with no server values baked into them.
async function readingScripts(data: Record<string, unknown>, ...names: string[]): Promise<string> {
  // settings.js comes before every page script because the pages read their
  // settings while they are setting themselves up, not afterwards.
  const srcs = await Promise.all(["common.js", "settings.js", ...names].map(chromeUrl));
  // A note's title is inside this object and a tweet can say anything, so the
  // three characters that could close the tag or break the line are escaped.
  const json = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<script>window.RL = ${json};</script>`
    + srcs.map((s) => `<script src="${s}"></script>`).join("");
}

function headerHtml(here: string, opts: { plus?: boolean; podcast?: boolean; backHref?: string }): string {
  const crumbs = opts.backHref
    ? `<a class="rl-crumb" href="/">Kush</a><span class="rl-sep">/</span>`
      + `<a class="rl-crumb" href="${esc(opts.backHref)}">Reading</a>`
      + `<span class="rl-sep">/</span><span class="rl-here">${esc(here)}</span>`
    : `<a class="rl-crumb" href="/">Kush</a><span class="rl-sep">/</span><span class="rl-here">${esc(here)}</span>`;
  return `<div class="rl-top">${crumbs}<div class="rl-top-right">`
    + (opts.plus ? `<button type="button" class="rl-add-toggle" id="rl-add-toggle" aria-label="Add a link" aria-expanded="false">`
    + `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11"/></svg></button>` : "")
    // Darbar Reading podcast: server serves the queue's audio as a private feed
    // (fleet/podcast) and syncs it daily at 12:00 IST; this runs that sync now.
    + (opts.podcast ? `<button type="button" class="rl-add-toggle" id="rl-pod" aria-label="Update podcast feed" title="Update podcast feed">`
    + `<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="6.5" r="1.6"/><path d="M8 8.6v5"/><path d="M5.2 9.3a3.8 3.8 0 1 1 5.6 0"/><path d="M3.3 11.2a6.4 6.4 0 1 1 9.4 0"/></svg></button>` : "")
    + themeToggleHtml()
    + `</div></div>`
    // Where the network says its one sentence: reading a cached copy, a newer
    // one waiting, or how many changes have not been sent yet. Empty and
    // hidden until there is something to say.
    + `<p class="rl-net" id="rl-net" hidden></p>`;
}

// ── list page ────────────────────────────────────────────────────────────────

// "Name (@handle): the tweet" repeats a byline that already says who wrote it,
// and a reply opens with the handles it answers, which is noise in a list.
function displayTitle(n: Note): string {
  if (n.kind !== "tweet") return n.title;
  let t = n.title.replace(/^.{0,60}?\(@[A-Za-z0-9_]+\):\s*/, "").replace(/^@[A-Za-z0-9_]+:\s*/, "");
  const stripped = t.replace(/^(@[A-Za-z0-9_]+[\s,]+)+/, "");
  if (stripped.trim().split(/\s+/).length >= 3) t = stripped;
  return t.trim() || n.title;
}

// Three buckets, off the minutes a note already knows. A tweet is always under
// five: its readMin is 0 because counting the words of a tweet is not worth
// trusting, not because its length is a mystery. Everything else at 0 -- an
// article that was never fetched, a video with no duration -- has no length at
// all, so it belongs to no bucket and shows only when no length chip is
// pressed. Filing those under "<5m" would be a guess, and half the guesses
// would be wrong; leaving them out of every bucket is at least honest.
function lenBucket(n: Note): string {
  if (n.kind === "tweet") return "short";
  if (!n.readMin) return "";
  if (n.readMin < 5) return "short";
  if (n.readMin <= 20) return "mid";
  return "long";
}

function rowHtml(n: Note): string {
  const who = (n.kind === "tweet" || n.kind === "book") && n.author ? n.author : displaySite(n.site);
  // Rows show the date the list sorts by: when it was saved. The publish date lives in the reader.
  const when = (n.added || n.clipped).slice(0, 10);
  const read = n.readMin ? `${n.readMin} min` : "";
  const rating = n.rating ? `${n.rating}/7` : "";
  const pages = n.kind === "document" ? (n.pages ? `PDF, ${n.pages} pages` : "PDF") : "";
  const meta = [who, when, pages, read].filter(Boolean).map(esc).join(" &middot; ");
  const metaDone = [who, when, pages, read, rating].filter(Boolean).map(esc).join(" &middot; ");
  // Progress is not baked into data-unread: the row's own data-progress is what
  // apply() reads, so marking something done or unread repaints the line and
  // the words without a reload.
  const started = n.progress > 0 && n.progress < 100;
  const metaNow = started ? `${meta} &middot; ${n.progress}% read` : meta;
  const progLine = `<span class="rl-prog"${started ? "" : " hidden"}><span style="width:${n.progress}%"></span></span>`;
  const thumb = n.kind === "document" && n.pdf
    ? `<img class="rl-thumb" src="${thumbHref(n)}" alt="" loading="lazy" onerror="this.remove()">`
    : "";
  const open = n.source
    ? `<a class="rl-quick" href="${esc(n.source)}" target="_blank" rel="noopener noreferrer">open</a>`
    : `<span class="rl-quick" aria-hidden="true"></span>`;
  return `<li class="rl-item" data-kind="${n.kind}" data-status="${esc(n.status)}"`
    + ` data-star="${n.starred ? "1" : "0"}" data-rating="${n.rating || 0}"`
    + ` data-tags="${esc(n.tags.join(" "))}" data-len="${lenBucket(n)}" data-progress="${n.progress}">`
    + `<a class="rl-row" href="/reading/item?f=${encodeURIComponent(n.file)}">${thumb}<span class="rl-text">`
    + `<span class="rl-title">${n.kind === "book" ? `<svg class="rl-glyph" viewBox="0 0 24 24" width="14" height="14" aria-label="Book"><use href="#rl-book"></use></svg>` : ""}${esc(displayTitle(n))}</span>`
    + progLine
    + `<span class="rl-meta" data-unread="${meta}" data-done="${metaDone}">${metaNow}</span></span></a>`
    + `<span class="rl-actions">`
    + `<button type="button" class="rl-star" aria-pressed="${n.starred}" aria-label="Star" data-file="${esc(n.file)}">`
    + `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><use href="#rl-star"></use></svg></button>`
    + open
    + `<button type="button" class="rl-quick rl-quick-done" data-file="${esc(n.file)}">${n.status === "unread" ? "done" : "unread"}</button>`
    + `</span></li>`;
}

export async function readingPage(url: URL): Promise<Response> {
  const dark = url.searchParams.get("theme") === "dark";
  const notes = await loadNotes();
  const unread = notes.filter((n) => n.status === "unread").length;

  // What the worker should have ready on a train: the unread queue, newest
  // first, as far as thirty. The list itself is one cached document however it
  // is filtered, so these are the only other pages worth fetching ahead.
  // Only ones that already have a body: opening an unfetched note runs add.sh,
  // and warming must not start thirty of those behind his back — nor cache the
  // waiting page under the address of the piece he wanted to read.
  const warm = notes.filter((n) => n.status === "unread" && n.fetched).slice(0, 30)
    .map((n) => `/reading/item?f=${encodeURIComponent(n.file)}`);
  const scripts = await readingScripts({ warm }, "list.js");

  const body = `
${await readingHead("list.css", dark)}
${headerHtml("Reading", { plus: true, podcast: true })}
<span class="rl-count" id="rl-count">${unread} unread</span>
<form class="rl-add" id="rl-add"><input id="rl-url" type="url" placeholder="Paste a link, then #tags" autocomplete="off" spellcheck="false"></form>
<p class="rl-msg" id="rl-msg"></p>
<form class="rl-search" id="rl-search" onsubmit="return false"><input id="rl-q" type="search" placeholder="Search" autocomplete="off" spellcheck="false"></form>
<p class="rl-hint" id="rl-hint">words, #tag, r:5+, kind:book</p>
<div class="rl-chips" id="rl-kind">
  <button class="rl-chip" data-v="all" aria-pressed="true">All</button>
  <button class="rl-chip" data-v="article" aria-pressed="false">Articles</button>
  <button class="rl-chip" data-v="video" aria-pressed="false">Videos</button>
  <button class="rl-chip" data-v="tweet" aria-pressed="false">Tweets</button>
  <button class="rl-chip" data-v="document" aria-pressed="false">Documents</button>
  <button class="rl-chip" data-v="book" aria-pressed="false">Books</button>
</div>
<div class="rl-chips" id="rl-status">
  <button class="rl-chip" data-v="unread" aria-pressed="true">Unread</button>
  <button class="rl-chip" data-v="progress" aria-pressed="false">In progress</button>
  <button class="rl-chip" data-v="starred" aria-pressed="false">Starred</button>
  <button class="rl-chip" data-v="done" aria-pressed="false">Archive</button>
</div>
<div class="rl-chips rl-facets">
  <span class="rl-group" id="rl-len">
    <button class="rl-chip" data-v="short" aria-pressed="false">&lt;5m</button>
    <button class="rl-chip" data-v="mid" aria-pressed="false">5-20m</button>
    <button class="rl-chip" data-v="long" aria-pressed="false">&gt;20m</button>
  </span>
  <span class="rl-group" id="rl-tags"></span>
</div>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><symbol id="rl-star" viewBox="0 0 24 24"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" stroke-linejoin="round"></path></symbol><symbol id="rl-book" viewBox="0 0 24 24"><path d="M5 4.5h11.5a1.5 1.5 0 0 1 1.5 1.5v13.5H6.5A1.5 1.5 0 0 1 5 18V4.5zM5 18a1.5 1.5 0 0 1 1.5-1.5H18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"></path></symbol></svg>
<ul class="rl-list" id="rl-list">${notes.map(rowHtml).join("")}</ul>
<p class="rl-empty" id="rl-empty" hidden>Nothing here.</p>
${keysOverlayHtml()}
${scripts}`;
  return noStore(layout("Reading", body, { fullTitle: "Reading", head: HEAD_TAGS, stylesheet: await chromeUrl("dashboard.css") }));
}

// ── reader ───────────────────────────────────────────────────────────────────

// ── transcript cues ──────────────────────────────────────────────────────────
// A video note stores its transcript as "**0:36** · one paragraph" blocks, the
// convention the vault already used. Parsing them back out is what lets the
// reader follow the player.

interface Cue { t: number; label: string; text: string }

function cueSeconds(label: string): number {
  const parts = label.split(":").map((x) => parseInt(x, 10));
  if (parts.some(isNaN)) return 0;
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
}

function parseTranscript(body: string): { intro: string; cues: Cue[] } {
  const head = body.match(/^##\s+Transcript\s*$/m);
  if (!head || head.index === undefined) return { intro: body, cues: [] };
  const intro = body.slice(0, head.index);
  const rest = body.slice(head.index + head[0].length);
  const cues: Cue[] = [];
  for (const raw of rest.split(/\n{2,}/)) {
    // the heading match can swallow a trailing newline, which would otherwise
    // leave the first cue with a leading break and drop it silently
    const para = raw.trim();
    const m = para.match(/^\*\*(\d{1,2}:\d{2}(?::\d{2})?)\*\*\s*[\u00b7-]?\s*([\s\S]+)$/);
    if (!m) continue;
    const text = m[2].replace(/\s+/g, " ").trim();
    if (text) cues.push({ t: cueSeconds(m[1]), label: m[1], text });
  }
  return { intro, cues };
}

function cuesHtml(cues: Cue[]): string {
  return cues.map((c) =>
    `<li class="rl-cue" data-t="${c.t}">`
    + `<button type="button" class="rl-cue-t">${esc(c.label)}</button>`
    + `<p class="rl-cue-x">${esc(c.text)}</p></li>`
  ).join("");
}

function ytId(url: string): string | null {
  const m = url.match(/[?&]v=([\w-]{6,})/) || url.match(/youtu\.be\/([\w-]{6,})/);
  return m ? m[1] : null;
}

// Body cleanups that only make sense in the reader: the note repeats its own
// title as an h1 (hidden in CSS), and video notes carry an embed or watch link
// that the iframe above replaces.
// A quoted tweet is a document inside a document. In the file it is a plain
// "## Quoting @who" section so Obsidian stays readable; here it becomes one
// indented block so you can see at a glance where the quote starts and ends.
// A thread post can quote too, so this wraps one section and is called until
// there are none left.
function wrapQuoteSections(text: string): string {
  let out = text;
  for (let i = 0; i < 25; i++) {
    const next = wrapQuoteSection(out);
    if (next === out) return out;
    out = next;
  }
  return out;
}

function wrapQuoteSection(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^## Quoting @/.test(l));
  if (start < 0) return text;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^!\[\]\(/.test(lines[i]) || /^\[[A-Z]+\]\(/.test(lines[i]) || /^\*\*\[Open on/.test(lines[i])
        || /^\*\*\d+\/\d+\*\*\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const inner = lines.slice(start, end);
  inner[0] = inner[0].replace(/^## Quoting (@\S+)\s*$/, "**Quoting $1**");
  return [
    ...lines.slice(0, start),
    '<div class="rl-quote">',
    "",
    ...inner,
    "",
    "</div>",
    ...lines.slice(end),
  ].join("\n");
}

function readerBody(n: Note, body: string): string {
  let text = body;
  if (n.noTranscript || n.noBody) {
    text = text
      .replace(/^\*{0,2}\[Open original[^\]]*\]\([^)]*\)\*{0,2}\s*$/gm, "")
      .replace(/^\*Not yet fetched[^\n]*$/gm, "")
      .replace(/^\*Transcript not fetched[^\n]*$/gm, "");
  }
  if (n.kind === "tweet") {
    // the byline already carries the author and the link out
    text = text.replace(/^\*{0,2}\[Open on (?:x\.com|X)[^\]]*\]\([^)]*\)\*{0,2}\s*$/gm, "");
    // media that is not a photo was written as a shouted [VIDEO]; a quiet line
    // pointing at the tweet is what that actually wants to be
    text = text.replace(/^\[(?:VIDEO|GIF|ANIMATED_GIF)\]\([^)]*\)\s*$/gm,
      n.source ? `[Video](${n.source})` : "");
    text = wrapQuoteSections(text);
    // A thread's "1/7" is a place marker, not a heading: quiet, and the only
    // thing separating one post from the next. The trailing match is [ \t]*,
    // not \s*, which would eat the blank line after it and leave the post's
    // blockquote inside the marker's HTML block, rendered as literal "> ".
    text = text.replace(/^\*\*(\d+\/\d+)\*\*[ \t]*$/gm, '<p class="rl-tn">$1</p>');
  }
  if (n.kind === "video") {
    text = text
      .replace(/^!\[\]\(https?:\/\/[^)]*\)\s*$/gm, "")
      .replace(/^\*{0,2}\[Watch on YouTube[^\]]*\]\([^)]*\)\*{0,2}\s*$/gm, "")
      .replace(/^\*Transcript not fetched[^\n]*$/gm, "")
      .replace(/^>\s*$/gm, "")
      .replace(/^---\s*$/m, "");
    // dim the transcript timestamps without touching the rest of the bold text
    text = text.replace(/^\*\*(\d{1,2}:\d{2}(?::\d{2})?)\*\*/gm, '<span class="rl-ts">$1</span>');
  }
  // A tweet's photos live on pbs.twimg.com and two articles pull theirs off
  // Substack. Sent back through /reading/img they become same-origin responses,
  // which is the difference between an offline copy the worker can hold and a
  // pile of opaque ones each charged several megabytes against the quota.
  return proxyImages(externalNewTab(md(text.trim())));
}

// The same HTML the reader shows, from the file on disk. Listen prepares its
// text from this rather than from the markdown, so the paragraph it is reading
// and the paragraph it marks on screen are counted the same way.
export function readerBodyHtml(file: string, raw: string): string {
  const n = toNote(file, raw);
  return readerBody(n, splitMarginalia(splitNote(raw).body).main);
}

// Anything pointing off the dashboard opens in its own tab: the note body is a
// reading surface, and losing your place to an arXiv PDF is not a navigation.
// Relative and same-origin hrefs (the back link, chips, the list) are untouched.
function externalNewTab(html: string): string {
  return html.replace(
    /<a\s+href="(https?:\/\/[^"]*)"/gi,
    '<a href="$1" target="_blank" rel="noopener noreferrer"'
  );
}

// kepano's scale, his words. Shown while choosing so the number means something.
const RATING_LABELS: Record<number, string> = {
  7: "Perfect: must try, life-changing, go out of your way to seek this out",
  6: "Excellent: worth repeating",
  5: "Good: do not go out of your way, but enjoyable",
  4: "Passable: works in a pinch",
  3: "Bad: do not do this if you can",
  2: "Atrocious: actively avoid, repulsive",
  1: "Evil: life-changing in a bad way",
};

const RATING_SHORT: Record<number, string> = {
  7: "7 Perfect", 6: "6 Excellent", 5: "5 Good", 4: "4 Passable",
  3: "3 Bad", 2: "2 Atrocious", 1: "1 Evil",
};

// What the wheel shows: the number, the word, and enough of the meaning to
// choose by without opening the shortcuts sheet.
const RATING_OPTIONS: Record<number, string> = {
  7: "7 Perfect, must try, life-changing",
  6: "6 Excellent, worth repeating",
  5: "5 Good, enjoyable, do not go out of your way",
  4: "4 Passable, works in a pinch",
  3: "3 Bad, do not if you can",
  2: "2 Atrocious, actively avoid",
  1: "1 Evil, life-changing in a bad way",
};

function keysOverlayHtml(): string {
  const list: [string, string][] = [
    ["j / k", "down / up the visible rows"],
    ["Enter, o", "open the focused row"],
    ["e", "archive the focused row, or put it back"],
    ["s", "star the focused row"],
    ["/", "search"],
    ["Esc", "clear the search or the focus"],
    ["1 2 3 4 5 6", "All, Articles, Videos, Tweets, Documents, Books"],
    ["u i t a", "Unread, In progress, Starred, Archive"],
    ["tap", "a length or a tag chip narrows; tap it again to clear"],
  ];
  const reader: [string, string][] = [
    ["e", "done, then the next unread; unread again if archived"],
    ["s", "star"],
    ["n / p", "next / previous item"],
    ["] / [", "the same"],
    ["o", "open the source"],
    ["right-click a link", "queue it, or make it this item"],
    ["long press a link", "the same, where there is no mouse"],
    ["f", "the PDF, fullscreen"],
    ["v", "Read or PDF view of a document"],
    ["l", "Listen: the voice, the estimate, what is saved"],
    ["space", "play or pause, while a player is up"],
    [", / .", "the sentence before / after, while the voice plays"],
    ["h", "highlight the selection"],
    ["H", "highlight it and add a note"],
    ["c", "copy the markdown"],
    ["d then y", "delete to Trash"],
    ["···", "the rest: Keep offline, Obsidian, Copy, Replace, Delete, and the two switches"],
    ["Esc, b", "back to the list"],
  ];
  const rows = (pairs: [string, string][]) =>
    pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  const ratings = [7, 6, 5, 4, 3, 2, 1]
    .map((n) => `<dt>${n}</dt><dd>${esc(RATING_LABELS[n])}</dd>`).join("");
  return `<div class="rl-keys" id="rl-keys">
  <div class="rl-keys-sheet">
    <div class="rl-keys-cols">
      <div><h3>List</h3><dl>${rows(list)}</dl></div>
      <div><h3>Reader</h3><dl>${rows(reader)}</dl></div>
    </div>
    <p class="rl-keys-note">The filters live in the address bar: /reading?kind=video&amp;status=unread&amp;tag=trading&amp;len=short&amp;q=words. A link wins over the last filter you used here.</p>
    <h3>Listening</h3>
    <p class="rl-keys-note">The player is the bar above the bottom bar: back and forward fifteen seconds, the sentence either side, the speed, and Close, on the line that names the voice, to put it away. The sentence being spoken carries the hairline; tap any sentence to read from there. Where you stopped is kept in the note, so the phone and the Mac agree about it.</p>
    <p class="rl-keys-note">"Scroll to sync", in the sheet under the three dots in the bar, keeps that sentence in view — and does the same for a video's transcript. Scroll yourself and it stops following until you scroll back to it or tap "Back to sync". It applies to every item, not just this one.</p>
    <p class="rl-keys-note">Progress is kept in the note, not in this browser: how far down the text you have been, how far into the video, how far the voice has read. The furthest point wins and nothing lowers it but Unread. Done sets it to 100. A started item shows a hairline under its title, "40% read" in its meta, and "12 min left" in the reader instead of its length.</p>
    <h3>Rating</h3>
    <dl><dt>1 to 7</dt><dd>set</dd><dt>0</dt><dd>clear</dd>${ratings}</dl>
    <p class="rl-keys-note">More granularity at the top, for the good experiences.</p>
    <h3>Offline</h3>
    <p class="rl-keys-note">Over the tailnet's https address the queue keeps a copy of itself: the list, the newest thirty unread pieces, their pictures, and any PDF or audio you asked it to keep. Add it to the Home Screen and the copy stops being evicted after a week.</p>
    <p class="rl-keys-note" id="rl-store">Offline copy: reading…</p>
  </div>
</div>`;
}

// The frontmatter keeps whatever the clipper wrote, "www." and all; nothing in
// a byline is improved by it.
function displaySite(site: string): string {
  return site.replace(/^www\./, "");
}

function fileHref(n: Note): string {
  return `/reading/file?f=${encodeURIComponent(n.pdf)}`;
}

function thumbHref(n: Note): string {
  return `/reading/thumb?f=${encodeURIComponent(n.pdf.replace(/\.pdf$/i, ".png"))}`;
}

function docPreviewHtml(n: Note): string {
  const label = n.pages ? `Open the PDF, ${n.pages} pages` : "Open the PDF";
  return `<div class="rl-doc" id="rl-doc">`
    + `<iframe class="rl-doc-frame" src="${fileHref(n)}#view=FitH" title="${esc(n.title)}" allowfullscreen></iframe>`
    + `<button type="button" class="rl-doc-exit" id="rl-doc-exit" aria-label="Exit fullscreen">Exit</button>`
    + `<div class="rl-doc-row">`
    + `<a class="rl-doc-open" href="${fileHref(n)}" target="_blank" rel="noopener">`
    + `<img class="rl-doc-cover" src="${thumbHref(n)}" alt="" onerror="this.remove()"><span>${esc(label)}</span></a>`
    + `<button type="button" class="rl-doc-full" id="rl-doc-full">Fullscreen</button>`
    + `</div></div>`;
}

function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return iso || "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

// ── Listen ────────────────────────────────────────────────────────────────────
// Videos already have a voice and a plain tweet is two lines, so the control
// only appears on the kinds where being read to is the point: articles,
// documents with a text layer, and X's long-form posts.
function canListen(n: Note, emptyBody: boolean): boolean {
  if (n.noBody || emptyBody) return false;
  return n.kind === "article" || n.kind === "document" || (n.kind === "tweet" && n.xArticle);
}

function shortDay(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Minutes and seconds, and hours only when there are any. Same shape as the
// player's clock, and as the one the client draws when it repaints these rows.
function clock(seconds: number): string {
  const n = Math.max(0, Math.round(seconds));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s).padStart(2, "0");
}

// One saved rendering. The client rebuilds this exact shape when a render
// finishes and again on every load, so the two have to stay identical.
function savedRowHtml(s: SavedAudio): string {
  const mins = Math.max(1, Math.round(s.seconds / 60));
  const resume = s.at > 20 && s.at < s.seconds - 10 ? `, at ${clock(s.at)}` : "";
  const what = `Saved: ${s.label}, ${mins} min${s.partial ? ", first 30 min" : ""}, ${shortDay(s.created)}${resume}`;
  // The player's own line says a shorter version of this, so it carries the
  // facts rather than parsing the sentence back apart.
  return `<div class="rl-saved-row" data-voice="${esc(s.voice)}" data-url="${esc(s.url)}" data-cues="${esc(s.cuesUrl)}" data-at="${s.at || 0}" data-label="${esc(s.label)}" data-secs="${Math.round(s.seconds) || 0}">`
    + `<span class="rl-saved-name">${esc(what)}</span>`
    + `<button type="button" class="rl-saved-act" data-a="play">Play</button>`
    + `<a class="rl-saved-act" href="${esc(s.url)}&amp;download=1" download>Download</a>`
    + `</div>`;
}

function listenHtml(saved: SavedAudio[]): string {
  const opts = VOICES.map((v) => `<option value="${esc(v.id)}">${esc(v.label)}</option>`).join("");
  return `<div class="rl-listen" id="rl-listen" data-open="0" data-confirm="0">
  <button type="button" class="rl-listen-open" id="rl-listen-open" aria-expanded="false">Listen</button>
  <div class="rl-listen-panel">
    <div id="rl-saved">${saved.map(savedRowHtml).join("")}</div>
    <button type="button" class="rl-listen-more" id="rl-listen-more"${saved.length ? "" : " hidden"}>Make another with a different voice</button>
    <div class="rl-make" id="rl-make"${saved.length ? " hidden" : ""}>
      <span class="rl-voice" id="rl-voice">
        <span class="rl-voice-text" id="rl-voice-text">${esc(VOICES[0].label)}</span>
        <span class="rl-rate-chev"></span>
        <select id="rl-voice-select" aria-label="Voice">${opts}</select>
      </span>
      <button type="button" class="rl-listen-go" id="rl-listen-go">Make audio</button>
      <span class="rl-listen-est" id="rl-listen-est"></span>
    </div>
    <div class="rl-listen-confirm" id="rl-listen-confirm">
      <span id="rl-listen-ask"></span>
      <button type="button" class="rl-listen-act" data-a="whole">Whole text</button>
      <button type="button" class="rl-listen-act" data-a="first">First 30 minutes</button>
      <button type="button" class="rl-listen-act rl-listen-cancel" data-a="cancel">Cancel</button>
    </div>
    <p class="rl-listen-msg" id="rl-listen-msg"></p>
  </div>
</div>`;
}

// Pinned above the bar, shown the moment something is playing. Safari's own
// control was the right thing to start with and the wrong thing to keep: it is
// a scrubber and a volume slider, and what he actually does on a walk is jump
// back fifteen seconds, step to the sentence he missed, and change the speed —
// none of which the native control offers, and all of which it takes the width
// of the screen to not offer. The <audio> element stays, hidden, as the engine;
// everything above it is ours, and the lock screen is handled properly through
// the Media Session API instead of being inherited.
//
// Five transport controls, in the order a thumb expects them. They are drawn
// rather than written because this is the one part of the page he uses without
// looking at it.
const ICON_PREV = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M7 5h1.9v14H7zM19 5.4v13.2L9.6 12z" fill="currentColor"/></svg>`;
const ICON_NEXT = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M15.1 5H17v14h-1.9zM5 5.4 14.4 12 5 18.6z" fill="currentColor"/></svg>`;
const ICON_BACK15 = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="M11.6 6.2V2.6L7.1 6.4l4.5 3.8V7.7a5.6 5.6 0 1 1-5.5 6.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><text x="12.4" y="17.4" font-size="8" font-family="inherit" text-anchor="middle" fill="currentColor">15</text></svg>`;
const ICON_FWD15 = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="M12.4 6.2V2.6l4.5 3.8-4.5 3.8V7.7a5.6 5.6 0 1 0 5.5 6.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><text x="11.6" y="17.4" font-size="8" font-family="inherit" text-anchor="middle" fill="currentColor">15</text></svg>`;
const ICON_PLAY = `<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" focusable="false"><path d="M7 4.5 20 12 7 19.5z" fill="currentColor"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" focusable="false"><path d="M6.5 4.5h4.2v15H6.5zM13.3 4.5h4.2v15h-4.2z" fill="currentColor"/></svg>`;

const AUDIO_PLAYER_HTML = `<div class="rl-audio" id="rl-audio" hidden>
  <div class="rl-audio-in">
    <audio id="rl-audio-el" preload="metadata"></audio>
    <div class="rl-scrub">
      <span class="rl-time" id="rl-audio-at">0:00</span>
      <input type="range" class="rl-seek" id="rl-audio-seek" min="0" max="10000" step="1" value="0" aria-label="Position">
      <span class="rl-time" id="rl-audio-left">0:00</span>
    </div>
    <div class="rl-transport">
      <button type="button" class="rl-tbtn" id="rl-audio-prev" aria-label="Previous sentence" title="Previous sentence">${ICON_PREV}</button>
      <button type="button" class="rl-tbtn" id="rl-audio-back" aria-label="Back 15 seconds" title="Back 15 seconds">${ICON_BACK15}</button>
      <button type="button" class="rl-tbtn rl-tbtn-play" id="rl-audio-play" data-on="0" aria-label="Play" title="Play">${ICON_PLAY}${ICON_PAUSE}</button>
      <button type="button" class="rl-tbtn" id="rl-audio-fwd" aria-label="Forward 15 seconds" title="Forward 15 seconds">${ICON_FWD15}</button>
      <button type="button" class="rl-tbtn" id="rl-audio-next" aria-label="Next sentence" title="Next sentence">${ICON_NEXT}</button>
    </div>
    <div class="rl-audio-row">
      <span class="rl-audio-name" id="rl-audio-name"></span>
      <span class="rl-speeds" id="rl-speeds">
        <button type="button" data-r="1" aria-pressed="true">1x</button>
        <button type="button" data-r="1.25" aria-pressed="false">1.25x</button>
        <button type="button" data-r="1.5" aria-pressed="false">1.5x</button>
        <button type="button" data-r="2" aria-pressed="false">2x</button>
      </span>
      <button type="button" class="rl-audio-close" id="rl-audio-close">Close</button>
    </div>
  </div>
</div>`;

// The one way back when he has scrolled away from what is playing. It is not
// part of the player: the video transcript follows a playhead too, and the same
// button serves both.
const FOLLOW_HTML = `<button type="button" class="rl-follow" id="rl-follow" hidden>Back to sync</button>`;

// Everything the bar used to spell out on a row of its own. The bottom of a
// phone was six stacked rows and 250px of chrome over the words; the rare
// actions belong behind the three dots and the bar keeps the three he presses.
//
// Two kinds of thing share one sheet because there is only ever one sheet: what
// this note can be made to do, then a rule under a divider and the switches,
// which are about every note. The order is that way round because he opens this
// to do something far more often than to change something.
function settingsSheetHtml(obsidian: string, heavy: boolean): string {
  return `<div class="rl-settings" id="rl-settings">
  <div class="rl-settings-sheet">
    <h3>This item, and settings</h3>
    <div class="rl-sheet-acts">
      ${heavy ? `<button type="button" class="rl-sheet-act" id="rl-keep" hidden aria-pressed="false">Keep offline</button>` : ""}
      <a class="rl-sheet-act" href="${esc(obsidian)}">Obsidian</a>
      <button type="button" class="rl-sheet-act" id="rl-copy">Copy</button>
      <button type="button" class="rl-sheet-act" id="rl-replace">Replace…</button>
      <button type="button" class="rl-sheet-act" id="rl-del">Delete</button>
    </div>
    <hr class="rl-sheet-rule">
    <label class="rl-setting">
      <input type="checkbox" id="rl-set-scrollsync">
      <span class="rl-setting-body">
        <span class="rl-setting-name">Scroll to sync</span>
        <span class="rl-setting-why">Keep the line being spoken, or said in the video, in view. Scroll yourself and it stops following until you come back to it.</span>
      </span>
    </label>
    <label class="rl-setting">
      <input type="checkbox" id="rl-set-pinplayer">
      <span class="rl-setting-body">
        <span class="rl-setting-name">Hold the video</span>
        <span class="rl-setting-why">Keep the video at the top of the screen while the transcript scrolls under it.</span>
      </span>
    </label>
    <p class="rl-keys-note">These apply to every item, not just this one, and stay on this device.</p>
    <button type="button" class="rl-settings-done" id="rl-settings-done">Done</button>
  </div>
</div>`;
}

// ── the header that follows him down ─────────────────────────────────────────
// Once the h1 is off the screen there is nothing left saying what he is in.
// This is that, and it is as little as it can be: the title, quiet enough to
// read as chrome, and the two things he otherwise has to go back to the top
// for. Tapping the line is the way back up, because the title of the thing is
// the most obvious "home" on a reading page and it needs no second control.
//
// Listen is only drawn on the kinds that can be listened to, and the tag row
// only when there is a tag row to talk to; a control that cannot do anything
// is worse than no control, because he will press it.
function stickyHtml(heading: string, listenable: boolean): string {
  return `<div class="rl-sticky" id="rl-sticky" data-show="0" data-tag="0">
  <div class="rl-sticky-row" id="rl-sticky-row">
    <button type="button" class="rl-sticky-back" id="rl-sticky-back" title="Back to the top">${esc(heading)}</button>
    <span class="rl-sticky-acts">
      ${listenable ? `<button type="button" class="rl-sticky-act" id="rl-sticky-listen">Listen</button>` : ""}
      <button type="button" class="rl-sticky-act" id="rl-sticky-tag" aria-expanded="false">Tag</button>
    </span>
  </div>
  <div class="rl-sticky-tagrow">
    <span class="rl-tags" id="rl-sticky-taglist"></span>
    <input class="rl-tag-input on" id="rl-sticky-tag-input" maxlength="30" placeholder="tag" aria-label="Add a tag">
  </div>
</div>`;
}

export async function readerPage(url: URL): Promise<Response> {
  const dark = url.searchParams.get("theme") === "dark";
  const file = safeFile(url.searchParams.get("f"));
  if (!file) return new Response("Bad file", { status: 400 });

  const path = join(INBOX, file);
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch { return new Response("Not found", { status: 404 }); }

  let n = toNote(file, raw);

  // Not fetched yet: start it, wait a beat, and if it is still going show a
  // waiting page that asks in place rather than reloading itself forever. The
  // address never grows a try= counter, and the fetch itself is bounded, so a
  // video with no captions ends in an answer instead of a loop.
  if (!n.fetched && n.source) {
    await Promise.race([startFetch(file, n.source, n.kind), sleep(1200)]);
    try { raw = await readFile(path, "utf8"); n = toNote(file, raw); } catch {}
    if (!n.fetched) {
      const back = `/reading/item?f=${encodeURIComponent(file)}${dark ? "?theme=dark" : ""}`;
      return noStore(layout("Reading", `${await readingHead("reader.css", dark)}
${headerHtml(n.kind, { backHref: "/reading" })}
<h1 class="rl-h1">${esc(n.title)}</h1>
<p class="rl-byline" id="rl-wait">Fetching the ${n.kind === "video" ? "transcript" : n.kind === "document" ? "document" : "article"}.</p>
${await readingScripts({ file, back }, "wait.js")}`,
        { fullTitle: `${n.title} · Reading`, head: HEAD_TAGS, stylesheet: await chromeUrl("dashboard.css") }));
    }
  }

  const { body } = splitNote(raw);
  const mg = splitMarginalia(body);
  const heading = n.kind === "tweet" && !n.xArticle ? (n.author || n.site) : displayTitle(n);

  // One muted line: when, who, how long. The way out is the bottom bar.
  // On a tweet the heading is already the handle, so the byline is date and
  // length only; the way out is the Open button in the bar.
  // Once he is inside something, what is left to do is the useful number; the
  // whole length is a fact about a thing he has not started. Same arithmetic
  // for a video, whose readMin is its duration in minutes.
  const started = n.progress > 0 && n.progress < 100;
  const readLabel = !n.readMin
    ? ""
    : started
      ? `${Math.max(1, Math.round(n.readMin * (100 - n.progress) / 100))} min left`
      : `${n.readMin} minute ${n.kind === "video" ? "watch" : "read"}`;
  const whoHtml = n.kind === "tweet" && !n.xArticle
    ? ""
    : n.xArticle && n.source
      ? `<a href="${esc(n.source)}" target="_blank" rel="noopener noreferrer">${esc(n.author || "x.com")}</a>`
      : n.source
      ? `<a href="${esc(n.source)}" target="_blank" rel="noopener noreferrer">${esc(displaySite(n.site))}</a>`
      : esc(displaySite(n.site));
  // Only `published` is the day the thing was written. When there is none, say
  // which day this is, rather than passing off the day he saved it.
  const dateLabel = n.published ? longDate(n.published) : `saved ${longDate(n.clipped)}`;
  const pagesLabel = n.kind === "document" && n.pages ? `${n.pages} pages`
    : n.kind === "book" && n.author ? `by ${n.author}` : "";
  const byline = [dateLabel, whoHtml, esc(pagesLabel), esc(readLabel)].filter(Boolean).join(" &middot; ");

  const vid = n.kind === "video" ? ytId(n.source) : null;
  // A transcript with timestamps gets the scriptable player and a cue list that
  // follows it. Anything else keeps the plain embed, which cannot fail to load.
  const script = vid ? parseTranscript(mg.main) : { intro: mg.main, cues: [] as Cue[] };
  const synced = Boolean(vid) && script.cues.length > 1;
  // Both shapes are the same box: a slot that holds its 16:9 place in the flow,
  // the picture inside it, and the one word that puts the picture away while it
  // is pinned to the top of the screen. Only what goes in the picture differs —
  // a div for the API to take over, or the plain embed that cannot fail to load.
  const inner = !vid
    ? ""
    : synced
      ? `<div id="rl-yt"></div>`
      : `<iframe src="https://www.youtube-nocookie.com/embed/${esc(vid)}" title="${esc(n.title)}" allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
  const embed = !vid
    ? ""
    : `<div class="rl-player" id="rl-player"><div class="rl-player-in">${inner}</div>`
      + `<button type="button" class="rl-pin-hide" id="rl-pin-hide">Hide</button></div>`;

  // Two honest attempts came back with nothing. Say that, once, instead of
  // showing a spinner that will never finish.
  const emptyBody = mg.main.replace(/^#\s+.*$/m, "").replace(/\*{0,2}\[[^\]]*\]\([^)]*\)\*{0,2}/g, "").trim().length < 4;
  const missing = n.noTranscript
    ? `<p class="rl-missing">No transcript for this video.</p>`
    : n.noBody
      ? `<p class="rl-missing">Could not fetch the ${n.kind === "document" ? "document" : "text"}.${n.source ? ` <a href="${esc(n.source)}" target="_blank" rel="noopener noreferrer">Open the source</a>` : ""}</p>`
      : n.kind === "tweet" && emptyBody
        ? `<p class="rl-missing">This post has no text.${n.source ? ` <a href="${esc(n.source)}" target="_blank" rel="noopener noreferrer">Open it on X</a>` : ""}</p>`
        : n.kind === "document" && emptyBody && n.pdf
          ? `<p class="rl-missing">This PDF has no text layer. The preview is all of it.</p>`
          : "";

  // A document's preview comes first; its text layer follows under its own
  // label, the way a transcript follows the player.
  const doc = n.kind === "document" && n.pdf ? docPreviewHtml(n) : "";
  const textLabel = doc && !emptyBody ? `<h2 class="rl-cues-h rl-doc-label">Text</h2>` : "";

  const bodyHtml = synced
    ? markHighlights(readerBody(n, script.intro), mg.highlights)
      + `<h2 class="rl-cues-h">Transcript</h2><ol class="rl-cues" id="rl-cues">${cuesHtml(script.cues)}</ol>`
    : textLabel + markHighlights(readerBody(n, mg.main), mg.highlights) + missing;

  // arXiv keeps the paper at /pdf/<id> and a listing for it at /abs/<id>; a
  // clipper catches the listing, which is an abstract and a row of links. Say
  // so once, under the byline, and offer the swap. A note that is already the
  // PDF is a document and says nothing.
  const absId = n.kind === "document"
    ? ""
    : arxivAbsId(n.source) || (mg.main.match(/arxiv\.org\/abs\/([A-Za-z0-9.\/-]+)/)?.[1] || "");
  const arxivHint = absId
    ? `<p class="rl-swap">This is the abstract page. <a href="https://arxiv.org/pdf/${esc(absId)}" id="rl-arxiv">Replace with the PDF</a></p>`
    : "";

  const obsidian = `obsidian://open?vault=${encodeURIComponent(VAULT)}&file=${encodeURIComponent("Reading/Inbox/" + file.replace(/\.md$/, ""))}`;
  const rateOpts = [7, 6, 5, 4, 3, 2, 1]
    .map((r) => `<option value="${r}"${n.rating === r ? " selected" : ""}>${esc(RATING_OPTIONS[r])}</option>`)
    .join("");
  // A book has no scroll to measure; how far in is something he says.
  const bookProg = n.kind !== "book" ? "" : `<div><span class="rl-rate" id="rl-bookprog" data-set="${n.progress ? 1 : 0}">
    <span class="rl-rate-text" id="rl-bookprog-text">${n.progress ? `${n.progress}% read` : "Progress"}</span>
    <span class="rl-rate-chev"></span>
    <select id="rl-bookprog-select" aria-label="Progress">
      <option value=""${n.progress ? "" : " selected"}>Progress</option>
      ${[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((p) => `<option value="${p}"${n.progress === p ? " selected" : ""}>${p}%</option>`).join("")}
      <option value="0">Not started</option>
    </select>
  </span></div>`;
  const tagBtns = n.tags
    .map((t) => `<button type="button" class="rl-tag" data-t="${esc(t)}">${esc(t)}</button>`).join("");

  // Saved renderings come off disk, so the list is right on the first paint and
  // the client only has to rebuild it after making a new one.
  const listenable = canListen(n, emptyBody);
  const savedAudio = listenable ? await savedFor(file) : [];
  const listen = listenable ? listenHtml(savedAudio) : "";

  // The big files this item owns. Everything else about it is cached without
  // being asked; these two are megabytes, so they are kept only on request.
  const heavy = [
    ...(n.kind === "document" && n.pdf ? [fileHref(n)] : []),
    ...savedAudio.map((s) => s.url),
  ];

  const scripts = await readingScripts({
    file,
    kind: n.kind,
    progress: n.progress || 0,
    unread: n.status === "unread",
    rating: n.rating || 0,
    ratingShort: RATING_SHORT,
    voices: Object.fromEntries(VOICES.map((v) => [v.id, v.label])),
    defaultVoice: DEFAULT_VOICE,
    longSeconds: LONG_SECONDS,
    videoId: vid || "",
    heavy,
    // What a write made offline has to be able to answer with. The page keeps
    // its own copy of these three and hands back the list the server would
    // have, so a highlight or a tag applied on a train looks exactly like one
    // applied at the desk.
    tags: n.tags,
    highlights: mg.highlights,
    notes: mg.notes,
    title: n.title,
  }, "sentences.js", "reader.js");

  const page = `
${await readingHead("reader.css", dark)}
<div class="rl-prog-top" id="rl-prog-top" aria-hidden="true"><span id="rl-prog-in" style="width:${n.progress}%"></span></div>
${headerHtml(n.kind, { backHref: "/reading" })}
${stickyHtml(heading, Boolean(listen))}
<h1 class="rl-h1">${esc(heading)}</h1>
<p class="rl-byline">${byline}</p>
<p class="rl-resume" id="rl-resume" hidden></p>
${arxivHint}
<div class="rl-controls">
  <div><span class="rl-rate" id="rl-rate" data-set="${n.rating ? 1 : 0}">
    <span class="rl-rate-text" id="rl-rate-text">${n.rating ? esc(RATING_SHORT[n.rating]) : "Rate"}</span>
    <span class="rl-rate-chev"></span>
    <select id="rl-rate-select" aria-label="Rating">
      <option value=""${n.rating ? "" : " selected"}>Rate</option>
      ${rateOpts}
      <option value="0">Clear rating</option>
    </select>
  </span></div>
  ${bookProg}
  <div><span class="rl-tags" id="rl-tags">${tagBtns}<button type="button" class="rl-tag-add" id="rl-tag-add">+ tag</button><input class="rl-tag-input" id="rl-tag-input" maxlength="30" placeholder="tag"></span></div>
  ${doc ? `<div class="rl-mode" id="rl-mode" role="group" aria-label="View">
    <button type="button" class="rl-chip" data-v="read" aria-pressed="true">Read</button>
    <button type="button" class="rl-chip" data-v="pdf" aria-pressed="false">PDF</button>
  </div>` : ""}
  ${listen ? `<div>${listen}</div>` : ""}
</div>
${embed}${doc}
<div class="rl-body${n.kind === "tweet" ? " rl-tweet" : ""}">${bodyHtml}</div>
<section class="rl-marg">
  <h2 class="rl-marg-h${mg.highlights.length ? "" : " rl-off"}" id="rl-hl-h">Highlights</h2>
  <div id="rl-hl-list">${highlightsHtml(mg.highlights)}</div>
  <h2 class="rl-marg-h">Notes</h2>
  <ul class="rl-note-list" id="rl-note-list">${notesHtml(mg.notes)}</ul>
  <form class="rl-note-form" id="rl-note-form">
    <textarea id="rl-note-text" rows="3" maxlength="5000" placeholder="Add a note"></textarea>
    <button type="submit" class="rl-note-btn">Add note</button>
  </form>
</section>
<div class="rl-pill" id="rl-pill" data-mode="main">
  <span class="rl-pill-main" id="rl-pill-main"></span>
  <span class="rl-pill-note">
    <input id="rl-pill-input" maxlength="500" placeholder="Note">
  </span>
</div>
${keysOverlayHtml()}
${settingsSheetHtml(obsidian, heavy.length > 0)}
${FOLLOW_HTML}
${listen ? AUDIO_PLAYER_HTML : ""}
<div class="rl-bar" id="rl-bar" data-confirm="0">
 <div class="rl-bar-inner">
  <p class="rl-err" id="rl-err"></p>
  <div class="rl-bar-main">
    <button class="rl-act" id="rl-done" data-status="${esc(n.status)}">${n.status === "unread" ? "Done" : "Unread"}</button>
    <button class="rl-act" id="rl-star" aria-pressed="${n.starred}">Star</button>
    ${n.source ? `<a class="rl-act" id="rl-open" href="${esc(n.source)}" target="_blank" rel="noopener noreferrer">Open</a>` : ""}
    <span class="rl-bar-right">
      <span class="rl-minor rl-queued" id="rl-queued" hidden></span>
      <button type="button" class="rl-act rl-act-dots" id="rl-settings-open" aria-label="More" title="More" aria-expanded="false">···</button>
    </span>
  </div>
  <div class="rl-confirm rl-confirm-del" id="rl-confirm">
    <span>Delete this?</span>
    <button type="button" class="rl-act" id="rl-del-yes">Yes</button>
    <button type="button" class="rl-act" id="rl-del-no">No</button>
  </div>
  <div class="rl-confirm rl-confirm-rep">
    <input class="rl-rep-url" id="rl-rep-url" type="url" inputmode="url" autocomplete="off"
           autocapitalize="off" spellcheck="false" placeholder="https://\u2026" aria-label="Replace with">
    <button type="button" class="rl-act" id="rl-rep-go">Replace</button>
    <button type="button" class="rl-act" id="rl-rep-no">Cancel</button>
  </div>
 </div>
</div>
${scripts}
${synced ? '<script src="https://www.youtube.com/iframe_api"></script>' : ""}`;
  return noStore(layout("Reading", page, { fullTitle: `${heading} · Reading`, head: HEAD_TAGS, stylesheet: await chromeUrl("dashboard.css") }));
}

// ── API ──────────────────────────────────────────────────────────────────────

export function readingIcon(): Response {
  return new Response(FAVICON_SVG, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
  });
}

// f= is a basename with the one expected extension, and nothing else.
function safeAsset(f: string | null, ext: string): string | null {
  if (!f) return null;
  if (f.includes("/") || f.includes("\\") || f.includes("\0")) return null;
  if (f.startsWith(".")) return null;
  if (!f.toLowerCase().endsWith(ext)) return null;
  return f;
}

async function serveAsset(dir: string, name: string, type: string): Promise<Response> {
  const file = Bun.file(join(dir, name));
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `inline; filename="${name.replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}

// What add.sh said, as one answer. It prints the note's path, or DUP: <path>, or
// TRASHED: <path>, then a MODE: line.
function parseAddOutput(out: string, fallback: string): { ok: boolean; file: string; title: string; duplicate: boolean; trashed: boolean } {
  const trashed = out.split("\n").find((l) => l.startsWith("TRASHED:"));
  if (trashed) {
    const name = trashed.replace(/^TRASHED:\s*/, "").split("/").pop()?.replace(/\.md$/, "") || fallback;
    return { ok: false, file: "", title: name, duplicate: false, trashed: true };
  }
  const line = out.split("\n").find((l) => l.startsWith("DUP:") || l.includes("/Reading/Inbox/")) || "";
  const duplicate = line.startsWith("DUP:");
  const path = line.replace(/^DUP:\s*/, "").trim();
  const file = path.split("/").pop() || "";
  return { ok: Boolean(file), file, title: file.replace(/\.md$/, "") || fallback, duplicate, trashed: false };
}

// The dashboard's own addresses: the Tailscale IP, loopback, and the ts.net
// HTTPS front door, on any port.
function isSelf(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "100.64.0.2" || h === "127.0.0.1" || h === "localhost" || h.endsWith(".ts.net");
  } catch { return false; }
}

// GET /reading/add?url=...&tags=a,b[&format=json]
// The Share Sheet on the phone and a bookmarklet on the Mac both land here. The
// note is written at once with its title so the answer comes back in a couple
// of seconds; the body is fetched right after in the background, the same way
// the hourly prefetch would have.
export async function readingAddPage(url: URL): Promise<Response> {
  const raw = (url.searchParams.get("url") || "").trim();
  const tags = (url.searchParams.get("tags") || "").split(/[\s,]+/)
    .map((t) => cleanTag(t.replace(/^#/, ""))).filter(Boolean).slice(0, 8);
  const json = url.searchParams.get("format") === "json";
  const dark = url.searchParams.get("theme") === "dark";
  const answer = async (status: number, body: Record<string, unknown>, heading: string, detail: string, file?: string) => {
    if (json) return Response.json(body, { status });
    const open = file ? `<a class="rl-act" href="/reading/item?f=${encodeURIComponent(file)}">Open it</a>` : "";
    return noStore(layout("Reading", `${await readingHead("save.css", dark)}
${headerHtml("Save", { backHref: "/reading" })}
<p class="rl-save-h">${esc(heading)}</p>
<p class="rl-save-d">${detail}</p>
<p class="rl-save-acts">${open}<a class="rl-act" href="/reading">Reading list</a><a class="rl-act" href="#" onclick="history.back();return false">Back</a></p>
${await readingScripts({})}`,
      { fullTitle: `${heading} · Reading`, head: HEAD_TAGS, stylesheet: await chromeUrl("dashboard.css") }));
  };
  if (!/^https?:\/\/\S+$/i.test(raw)) {
    return answer(400, { ok: false, message: "Not a link." }, "Not a link", "The address has to start with http:// or https://.");
  }
  // The bookmarklet pressed while on the reading page itself would queue the
  // dashboard as an article. Say so instead of making a note titled after the host.
  if (isSelf(raw)) {
    return answer(400, { ok: false, message: "That is the reading page itself." }, "That is this page",
      "Open the article you want to keep, then press Save to Reading.");
  }
  try {
    const out = await ensureFetched("save:" + raw, raw, "safari", tags, false);
    const r = parseAddOutput(out, raw);
    if (r.trashed) {
      return answer(200, { ok: false, message: `In trash: ${r.title}.` }, "In the trash",
        `${esc(r.title)} was deleted earlier. Move the file back into Reading/Inbox to restore it.`);
    }
    if (!r.ok) return answer(500, { ok: false, message: "add.sh returned nothing." }, "Could not save", "The capture script returned nothing.");
    if (!r.duplicate) {
      await logAction("add", r.file, ["safari", ...tags].join(" "));
      // the body, in the background; the page does not wait for defuddle
      ensureFetched("full:" + raw, raw, "safari", [], true).catch(() => {});
    }
    const tagLine = tags.length ? ` (tags: ${tags.join(", ")})` : "";
    const message = r.duplicate ? `Already in the queue: ${r.title}` : `Queued: ${r.title}${tagLine}`;
    return answer(200, { ok: true, duplicate: r.duplicate, title: r.title, tags, file: r.file, message },
      r.duplicate ? "Already in the queue" : "Queued",
      `${esc(r.title)}${tags.length ? ` <span class="rl-save-tags">${tags.map(esc).join(" · ")}</span>` : ""}`, r.file);
  } catch (e: any) {
    baseLog.error("reading/add page:", e);
    return answer(500, { ok: false, message: e.message }, "Could not save", esc(e.message));
  }
}

// GET /reading/file?f=<name>.pdf: the document's own copy.
export async function readingFile(url: URL): Promise<Response> {
  const f = safeAsset(url.searchParams.get("f"), ".pdf");
  if (!f) return new Response("Bad file", { status: 400 });
  return serveAsset(FILES, f, "application/pdf");
}

// GET /reading/thumb?f=<name>.png: page one, rendered when the file arrived.
export async function readingThumb(url: URL): Promise<Response> {
  const f = safeAsset(url.searchParams.get("f"), ".png");
  if (!f) return new Response("Bad file", { status: 400 });
  return serveAsset(THUMBS, f, "image/png");
}

// Figures the extractor lifted out of a document, one directory per document.
const FIGURES = join(FILES, ".assets");
const FIGURE_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

// GET /reading/asset?f=<document>/<file>: one figure. Exactly two names, each a
// plain one — the document's own directory, then an image inside it.
export async function readingAsset(url: URL): Promise<Response> {
  const parts = (url.searchParams.get("f") || "").split("/");
  const type = FIGURE_TYPE[parts[1]?.toLowerCase().split(".").pop() || ""];
  const named = parts.length === 2 && parts.every((p) => p && !p.startsWith(".") && !p.includes("\\") && !p.includes("\0"));
  if (!named || !type) return new Response("Bad file", { status: 400 });
  return serveAsset(join(FIGURES, parts[0]), parts[1], type);
}

export async function readingApi(path: string, req: Request, url: URL): Promise<Response | null> {
  const res = await readingApiRoute(path, req, url);
  return res ? noStore(res) : null;
}

// Rebuilds a shareable markdown document: the title, one byline line with the
// source, the body, and his own highlights and notes if he made any. No
// frontmatter, because that is the vault's business, not the reader's.
function shareMarkdown(n: Note, body: string): string {
  const mg = splitMarginalia(body);
  const main = mg.main.replace(/^#\s+.*$/m, "").trim();
  const bits = [longDate(n.published || n.clipped), n.author || n.site].filter(Boolean);
  const byline = n.source ? `${bits.join(" · ")} · [source](${n.source})` : bits.join(" · ");
  const parts = [`# ${n.title}`, byline, main];
  if (mg.highlights.length) {
    parts.push("## Highlights", mg.highlights
      .map((h) => `> ${h.text}` + h.notes.map((x) => `\n    - ${x}`).join(""))
      .join("\n\n"));
  }
  if (mg.notes.length) {
    parts.push("## Notes", mg.notes.map((x) => `- ${x}`).join("\n"));
  }
  return parts.filter(Boolean).join("\n\n") + "\n";
}

async function readingApiRoute(path: string, req: Request, url: URL): Promise<Response | null> {
  // Listen keeps its own routes in reading-audio.ts; this is only the door.
  if (path.startsWith("/api/reading/audio/")) return readingAudioApi(path, req, url);

  // "Update podcast feed": server pulls this queue's audio back from us and
  // rewrites the feed, so this only knocks on its door and relays the answer.
  if (path === "/api/reading/podcast" && req.method === "POST") {
    const SERVER = process.env.PODCAST_SERVER || "http://100.64.0.1:3456";
    try {
      const r = await fetch(`${SERVER}/api/podcast/sync`, { method: "POST", signal: AbortSignal.timeout(15 * 60_000) });
      return Response.json(await r.json());
    } catch (e: any) {
      return Response.json({ ok: false, error: `server unreachable: ${e.message}` }, { status: 502 });
    }
  }

  if (path === "/api/reading/list") {
    const kind = url.searchParams.get("kind") || "";
    const status = url.searchParams.get("status") || "";
    const tag = (url.searchParams.get("tag") || "").toLowerCase();
    const len = url.searchParams.get("len") || "";
    let items = await loadNotes();
    if (kind && kind !== "all") items = items.filter((n) => n.kind === kind);
    if (status === "starred") items = items.filter((n) => n.starred);
    else if (status === "done") items = items.filter((n) => n.status === "read" || n.status === "skipped");
    // Started and not finished: the pile he is actually in the middle of.
    else if (status === "progress") items = items.filter((n) => n.status === "unread" && n.progress > 0 && n.progress < 100);
    else if (status) items = items.filter((n) => n.status === status);
    // The reader asks for the list the page was showing, tag and length
    // included, so next and previous walk the same narrowed queue.
    if (tag) items = items.filter((n) => n.tags.some((t) => t.toLowerCase() === tag));
    if (len) items = items.filter((n) => lenBucket(n) === len);
    return Response.json({ count: items.length, items });
  }

  if (path === "/api/reading/fetch-state") {
    const file = safeFile(url.searchParams.get("f"));
    if (!file) return Response.json({ ready: false, failed: true, message: "bad file" }, { status: 400 });
    try {
      const n = toNote(file, await readFile(join(INBOX, file), "utf8"));
      // a marker is a finished answer, the same as having a body
      return Response.json({ ready: n.fetched, failed: n.noTranscript || n.noBody });
    } catch (e: any) {
      return Response.json({ ready: false, failed: true, message: e.message });
    }
  }

  if (path === "/api/reading/markdown") {
    const file = safeFile(url.searchParams.get("f"));
    if (!file) return new Response("bad file", { status: 400 });
    try {
      const raw = await readFile(join(INBOX, file), "utf8");
      const n = toNote(file, raw);
      const text = shareMarkdown(n, splitNote(raw).body);
      return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    } catch (e: any) {
      return new Response(e.message, { status: 404 });
    }
  }

  if (path === "/api/reading/status" && req.method === "POST") {
    let b: any = {};
    try { b = await req.json(); } catch {}
    const file = safeFile(b.file);
    if (!file) return Response.json({ ok: false, message: "bad file" }, { status: 400 });
    if (b.status && !["unread", "read", "skipped"].includes(b.status)) {
      return Response.json({ ok: false, message: "bad status" }, { status: 400 });
    }
    let rating: number | null | undefined;
    if ("rating" in b) {
      if (b.rating === null || b.rating === 0) rating = null;
      else if (Number.isInteger(b.rating) && b.rating >= 1 && b.rating <= 7) rating = b.rating;
      else return Response.json({ ok: false, message: "rating must be 1 to 7" }, { status: 400 });
    }
    try {
      const note = await applyStatus(file, {
        status: b.status,
        star: typeof b.star === "boolean" ? b.star : undefined,
        rating,
      });
      if (b.status) await logAction(b.status === "read" ? "done" : b.status, file);
      if (typeof b.star === "boolean") await logAction(b.star ? "star" : "unstar", file);
      if (rating !== undefined) await logAction("rating", file, String(rating ?? "cleared"));
      return Response.json({ ok: true, note });
    } catch (e: any) {
      baseLog.error("reading/status:", e);
      return Response.json({ ok: false, message: e.message }, { status: 500 });
    }
  }

  // POST /api/reading/progress { file, percent, reset? }
  // Called every few seconds from the reader, and once more as the tab goes
  // away, so it answers small and writes nothing when the number has not moved.
  // No line in the action log for the same reason: a write every five seconds
  // is not an event, and progress_at in the note is the record of when.
  if (path === "/api/reading/progress" && req.method === "POST") {
    let b: any = {};
    try { b = await req.json(); } catch {}
    const file = safeFile(b.file);
    if (!file) return Response.json({ ok: false, message: "bad file" }, { status: 400 });
    const percent = Math.round(Number(b.percent));
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return Response.json({ ok: false, message: "percent must be 0 to 100" }, { status: 400 });
    }
    const reset = b.reset === true;
    const exact = b.exact === true;
    try {
      const note = await applyProgress(file, percent, reset, exact);
      if (exact) await logAction("progress-set", file, String(percent));
      if (reset && percent === 0) await logAction("progress-reset", file);
      return Response.json({ ok: true, progress: note.progress, progressAt: note.progressAt });
    } catch (e: any) {
      baseLog.error("reading/progress:", e);
      return Response.json({ ok: false, message: e.message }, { status: 500 });
    }
  }

  if (path === "/api/reading/tags" && req.method === "POST") {
    let b: any = {};
    try { b = await req.json(); } catch {}
    const file = safeFile(b.file);
    if (!file) return Response.json({ ok: false, message: "bad file" }, { status: 400 });
    const add = Array.isArray(b.add) ? b.add.slice(0, 20) : [];
    const remove = Array.isArray(b.remove) ? b.remove.slice(0, 20) : [];
    if (!add.length && !remove.length) return Response.json({ ok: false, message: "nothing to do" }, { status: 400 });
    try {
      const note = await applyTags(file, add, remove);
      await logAction("tags", file, [...add.map((t: string) => "+" + cleanTag(t)), ...remove.map((t: string) => "-" + cleanTag(t))].join(" "));
      return Response.json({ ok: true, tags: note.tags });
    } catch (e: any) {
      baseLog.error("reading/tags:", e);
      return Response.json({ ok: false, message: e.message }, { status: 500 });
    }
  }

  if (path === "/api/reading/delete" && req.method === "POST") {
    let b: any = {};
    try { b = await req.json(); } catch {}
    const file = safeFile(b.file);
    if (!file) return Response.json({ ok: false, message: "bad file" }, { status: 400 });
    try {
      // Moved, never unlinked. A note is a file he wrote something on.
      await mkdir(TRASH, { recursive: true });
      let dest = join(TRASH, file);
      try {
        await stat(dest);
        dest = join(TRASH, file.replace(/\.md$/, `-${Date.now()}.md`));
      } catch {}
      await rename(join(INBOX, file), dest);
      await logAction("delete", file);
      return Response.json({ ok: true });
    } catch (e: any) {
      baseLog.error("reading/delete:", e);
      return Response.json({ ok: false, message: e.message }, { status: 500 });
    }
  }

  if ((path === "/api/reading/highlight" || path === "/api/reading/highlight-note"
       || path === "/api/reading/note") && req.method === "POST") {
    let b: any = {};
    try { b = await req.json(); } catch {}
    const file = safeFile(b.file);
    if (!file) return Response.json({ ok: false, message: "bad file" }, { status: 400 });

    let action: MargOp;
    let label: string;
    if (path.endsWith("/highlight") && b.remove) {
      action = { op: "unhighlight", text: collapse(String(b.remove)) };
      label = "unhighlight";
    } else if (path.endsWith("/highlight-note")) {
      const note = collapse(String(b.note ?? b.text ?? ""));
      if (!note) return Response.json({ ok: false, message: "empty note" }, { status: 400 });
      if (note.length > 5000) return Response.json({ ok: false, message: "too long" }, { status: 400 });
      action = { op: "highlight-note", highlight: collapse(String(b.highlight ?? "")), text: note };
      label = "highlight-note";
    } else {
      const text = collapse(String(b.text ?? ""));
      if (!text) return Response.json({ ok: false, message: "empty text" }, { status: 400 });
      if (text.length > 5000) return Response.json({ ok: false, message: "too long" }, { status: 400 });
      action = path.endsWith("/highlight") ? { op: "highlight", text } : { op: "note", text };
      label = path.endsWith("/highlight") ? "highlight" : "note";
    }

    try {
      const { mg, duplicate } = await editMarginalia(file, action);
      if (!duplicate) await logAction(label, file);
      return Response.json({ ok: true, duplicate, highlights: mg.highlights, notes: mg.notes });
    } catch (e: any) {
      baseLog.error(`reading${path.slice("/api/reading".length)}:`, e);
      return Response.json({ ok: false, message: e.message }, { status: 500 });
    }
  }

  // POST /api/reading/replace { file, url }: this note is now about that link.
  // The answer comes back as soon as the note has been rewritten; the fetch
  // runs behind it, and the reader the client reloads shows the waiting page
  // and polls the same way it does for anything not yet fetched.
  if (path === "/api/reading/replace" && req.method === "POST") {
    let b: any = {};
    try { b = await req.json(); } catch {}
    const file = safeFile(b.file);
    if (!file) return Response.json({ ok: false, message: "bad file" }, { status: 400 });
    const raw = String(b.url || "").trim().split(/\s+/)[0] || "";
    if (!/^https?:\/\/\S+$/i.test(raw)) return Response.json({ ok: false, message: "Not a link." }, { status: 400 });
    if (isSelf(raw)) return Response.json({ ok: false, message: "That is the reading page itself." }, { status: 400 });
    try {
      const { kind, from } = await applyReplace(file, raw);
      await logAction("replace", file, `${from || "(none)"} -> ${raw}`);
      // not awaited: the client is about to reload into the waiting page, and
      // startFetch dedupes, so the reader picks up this very promise
      startFetch(file, raw, kind).catch((e) => baseLog.error("reading/replace fetch:", e));
      return Response.json({ ok: true, file, kind, replaced: from });
    } catch (e: any) {
      baseLog.error("reading/replace:", e);
      return Response.json({ ok: false, message: e.message }, { status: 500 });
    }
  }

  if (path === "/api/reading/add" && req.method === "POST") {
    let b: any = {};
    try { b = await req.json(); } catch {}
    // "https://... #trading #systematic" or the same words without hashes
    const parts = String(b.url || "").trim().split(/\s+/).filter(Boolean);
    const raw = parts.shift() || "";
    const tags = parts.map((t) => cleanTag(t.replace(/^#/, ""))).filter(Boolean).slice(0, 8);
    if (!/^https?:\/\/\S+$/i.test(raw)) return Response.json({ ok: false, message: "Not a link." }, { status: 400 });
    if (isSelf(raw)) return Response.json({ ok: false, message: "That is the reading page itself." }, { status: 400 });
    try {
      // The note first, with its title, so the answer is back in a couple of
      // seconds; the body follows in the background, as the Share Sheet path does.
      const out = await ensureFetched("add:" + raw + tags.join(","), raw, "web", tags, false);
      // deleting a note is a decision; adding the same link back should say so
      const trashed = out.split("\n").find((l) => l.startsWith("TRASHED:"));
      if (trashed) {
        const name = trashed.replace(/^TRASHED:\s*/, "").split("/").pop()?.replace(/\.md$/, "") || raw;
        return Response.json({
          ok: false,
          message: `In trash: ${name}. Move the file back into Reading/Inbox to restore it.`,
        });
      }
      const line = out.split("\n").find((l) => l.startsWith("DUP:") || l.includes("/Reading/Inbox/")) || "";
      const duplicate = line.startsWith("DUP:");
      const file = line.replace(/^DUP:\s*/, "").trim();
      const title = file.split("/").pop()?.replace(/\.md$/, "") || raw;
      if (file && !duplicate) {
        await logAction("add", title + ".md", tags.join(" "));
        ensureFetched("full:" + raw, raw, "web", [], true).catch(() => {});
      }
      return Response.json({ ok: Boolean(file), duplicate, title, tags, message: file ? "" : "add.sh returned nothing." });
    } catch (e: any) {
      baseLog.error("reading/add:", e);
      return Response.json({ ok: false, message: e.message }, { status: 500 });
    }
  }

  return null;
}
