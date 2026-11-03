// Real sentence times for a rendering, by listening back to it.
//
// Why this exists. Until now a cue's time came from sharing a chunk's measured
// length across the paragraphs inside it in proportion to their characters.
// At paragraph scale that is fine — the chunk edges are exact and a chunk is a
// handful of paragraphs. At sentence scale it is not: a voice does not spend
// equal time per character (a number, a comma, the breath at a full stop), so
// inside a 1,900-character chunk the interpolated position drifts by seconds,
// and seconds are exactly what you notice when a highlight is supposed to be
// sitting on the words being said.
//
// What the providers give us. Nothing — checked before writing any of this.
// Deepgram's REST /v1/speak answers with the audio bytes and no timing header.
// Its WebSocket /v1/speak has exactly five server messages, and the schema at
// developers.deepgram.com/reference/text-to-speech/speak-streaming (read
// 2026-09-11) spells out every field of them:
//
//     Audio     binary
//     Metadata  type, request_id, model_name, model_version, model_uuid,
//               additional_model_uuids
//     Flushed   type, sequence_id
//     Cleared   type, sequence_id
//     Warning   type, description, code
//
// A sequence id is which flush you are on, not when it was said. There is no
// timestamps, alignment, marks, viseme or TimedMetadata feature in Aura-2 at
// all. Sarvam's bulbul:v3 likewise answers /text-to-speech with a 200 whose
// whole body is `{request_id, audios[]}` — base64 wav and nothing else
// (docs.sarvam.ai/api-reference-docs/text-to-speech/convert, same day). So the
// timings have to be recovered from the audio.
//
// How. Force alignment through speech to text: send the finished mp3 to
// Deepgram's /v1/listen with nova-3, which returns every word with a start and
// an end, then align that word sequence against the words we asked the voice to
// say. The two are the same text, so the alignment is nearly the identity — but
// only nearly: numbers and symbols come back as they were spoken ("30" is
// "thirty", "$100" is "one hundred dollars"), so it has to tolerate one source
// word standing for several heard ones, and the odd word being dropped. A
// banded Needleman-Wunsch does that and is cheap at this size.
//
// Cost. Deepgram nova-3 monolingual, PRE-RECORDED, is $0.0043 a minute
// pay-as-you-go (deepgram.com/pricing, read 2026-09-11 — the $0.0077 on the
// same page is the streaming rate, which this does not use). Aligning the
// 67-minute Hyperliquid rendering cost $0.29. Rendering it cost nearly two
// dollars, so hearing the words land on the right line adds about a sixth.
//
// If the key is missing, or Deepgram fails, or the alignment comes back too
// thin to trust, the caller keeps the interpolated cues. A rendering is never
// left without cues.

import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { baseLog } from "../../lib/log";
import type { Block } from "./reading-audio";
// The sentence rule, shared with the reader so the two number sentences the
// same way. See dashboard/static/reading/sentences.js.
import { ranges as sentenceRanges } from "../../static/reading/sentences.js";

const SECRETS = join(homedir(), ".secrets");

// Pay-as-you-go, pre-recorded, nova-3 monolingual. deepgram.com/pricing,
// read 2026-09-11.
export const STT_USD_PER_MINUTE = 0.0043;

export interface Cue { i: number; s: number; t: number }

// One sentence of one block, in the order the voice says them.
interface Unit { i: number; s: number; text: string }

export function unitsOf(blocks: Block[]): Unit[] {
  const out: Unit[] = [];
  for (const b of blocks) {
    if (!b.speak) continue;
    const rs = sentenceRanges(b.text);
    // A block with no sentence in it still has one: itself.
    if (!rs.length) { out.push({ i: b.i, s: 0, text: b.text }); continue; }
    rs.forEach((r: number[], s: number) => {
      out.push({ i: b.i, s, text: b.text.slice(r[0], r[1]).trim() });
    });
  }
  return out;
}

// ── words ────────────────────────────────────────────────────────────────────
// Both sides are reduced to the same thing: lower case, letters and digits
// only. Everything that distinguishes written text from heard text — case,
// punctuation, hyphens, the apostrophe in "don't" — goes, because none of it
// survives being spoken.

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9à-ÿ]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

// ── Deepgram speech to text ──────────────────────────────────────────────────

interface Heard { word: string; start: number; end: number }

async function key(): Promise<string> {
  const text = await readFile(join(SECRETS, "deepgram-api-key.env"), "utf8");
  const v = text.match(/^(?:export\s+)?DEEPGRAM_API_KEY=(.+)$/m)?.[1]?.trim()
    .replace(/^["']/, "").replace(/["']$/, "");
  if (!v) throw new Error("DEEPGRAM_API_KEY is not set");
  return v;
}

// smart_format is deliberately off. It would render numbers as digits, which
// looks tidier in a transcript and is the wrong thing here: the source text has
// "30" and the voice said "thirty", and letting the transcript say "thirty" as
// well means the aligner sees two words that do not match rather than two words
// that do not match *and* a count that no longer lines up. punctuate is on only
// because it costs nothing and makes the raw transcript readable when a run
// goes wrong and has to be looked at.
export async function transcribe(mp3: string): Promise<Heard[]> {
  const k = await key();
  const q = new URLSearchParams({
    model: "nova-3", language: "en", punctuate: "true", smart_format: "false",
    mip_opt_out: "true",
  });
  const body = await readFile(mp3);
  const res = await fetch(`https://api.deepgram.com/v1/listen?${q}`, {
    method: "POST",
    headers: { Authorization: `Token ${k}`, "Content-Type": "audio/mpeg" },
    body,
    // An hour of audio takes Deepgram the better part of a minute to come back
    // with, and Bun's default would have given up long before that.
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 300).replace(/\s+/g, " ").trim(); } catch {}
    throw new Error(`Deepgram STT HTTP ${res.status}${detail ? ": " + detail : ""}`);
  }
  const j: any = await res.json();
  const ws = j?.results?.channels?.[0]?.alternatives?.[0]?.words;
  if (!Array.isArray(ws) || !ws.length) throw new Error("Deepgram STT returned no words");
  return ws.map((w: any) => ({
    word: String(w.word || "").toLowerCase().replace(/[^a-z0-9à-ÿ]+/g, ""),
    start: Number(w.start) || 0,
    end: Number(w.end) || 0,
  })).filter((w: Heard) => w.word.length > 0);
}

// ── alignment ────────────────────────────────────────────────────────────────
//
// Needleman-Wunsch, restricted to a band around the diagonal. The two sequences
// are the same text twice, so the alignment never wanders far from the
// diagonal; the band is what keeps an 11,000-word piece from asking for a
// hundred million cells. If it turns out to have wandered — the match rate
// comes back poor — the caller widens the band and tries again, which costs one
// more pass over memory and no more money.

const MATCH = 10;
const MISMATCH = -4;
const GAP = -5;

// For each word of `a`, the index in `b` it was matched to, or -1.
export function alignWords(a: string[], b: string[], band: number): Int32Array {
  const N = a.length, M = b.length;
  const W = Math.max(band, Math.abs(N - M) + 8);
  const K = 2 * W + 1;
  const NEG = -(1 << 28);
  // Direction for the traceback: 1 diagonal, 2 a-only (a word nothing was
  // heard for), 3 b-only (a word heard that we never wrote).
  const tb = new Uint8Array((N + 1) * K);
  let prev = new Int32Array(K).fill(NEG);
  let cur = new Int32Array(K).fill(NEG);

  const at = (j: number, i: number) => j - i + W;   // column j of row i, in band space

  // Row 0: nothing of `a` consumed, j of `b` skipped.
  for (let j = 0; j <= Math.min(M, W); j++) {
    prev[at(j, 0)] = j * GAP;
    tb[0 * K + at(j, 0)] = j === 0 ? 0 : 3;
  }

  for (let i = 1; i <= N; i++) {
    cur.fill(NEG);
    const lo = Math.max(0, i - W), hi = Math.min(M, i + W);
    const row = i * K;
    for (let j = lo; j <= hi; j++) {
      const o = at(j, i);
      let best = NEG, dir = 0;
      // diagonal: a[i-1] against b[j-1]
      if (j >= 1) {
        const po = at(j - 1, i - 1);
        if (po >= 0 && po < K && prev[po] > NEG) {
          const sc = prev[po] + (a[i - 1] === b[j - 1] ? MATCH : MISMATCH);
          if (sc > best) { best = sc; dir = 1; }
        }
      }
      // a[i-1] with nothing heard
      {
        const po = at(j, i - 1);
        if (po >= 0 && po < K && prev[po] > NEG) {
          const sc = prev[po] + GAP;
          if (sc > best) { best = sc; dir = 2; }
        }
      }
      // b[j-1] with nothing written
      if (j >= 1) {
        const po = at(j - 1, i);
        if (po >= 0 && po < K && cur[po] > NEG) {
          const sc = cur[po] + GAP;
          if (sc > best) { best = sc; dir = 3; }
        }
      }
      cur[o] = best;
      tb[row + o] = dir;
    }
    const swap = prev; prev = cur; cur = swap;
  }

  const map = new Int32Array(N).fill(-1);
  let i = N, j = M;
  if (at(j, i) < 0 || at(j, i) >= K) return map;    // the band could not reach the corner
  while (i > 0 || j > 0) {
    const d = tb[i * K + at(j, i)];
    if (d === 1) { if (a[i - 1] === b[j - 1]) map[i - 1] = j - 1; i--; j--; }
    else if (d === 2) { i--; }
    else if (d === 3) { j--; }
    else break;
  }
  return map;
}

// ── cues from the alignment ──────────────────────────────────────────────────

export interface AlignResult {
  cues: Cue[];
  matched: number;     // source words that found a heard word
  total: number;
  seconds: number;     // length of what was heard
}

export function cuesFrom(units: Unit[], heard: Heard[], band: number): AlignResult {
  const src: string[] = [];
  const owner: number[] = [];    // src word -> unit index
  units.forEach((u, k) => {
    for (const w of words(u.text)) { src.push(w); owner.push(k); }
  });
  const got = heard.map((h) => h.word);
  const map = alignWords(src, got, band);

  let matched = 0;
  for (let k = 0; k < map.length; k++) if (map[k] >= 0) matched++;

  // A unit starts when the first of its words that was actually heard was
  // heard. A short unit whose every word went unmatched ("Yes." between two
  // paragraphs) gets filled in afterwards.
  const starts = new Array<number>(units.length).fill(-1);
  for (let k = 0; k < src.length; k++) {
    const u = owner[k];
    if (starts[u] >= 0) continue;
    const g = map[k];
    if (g >= 0) starts[u] = heard[g].start;
  }

  // Fill the gaps by spreading the time between the two units either side, and
  // force the whole run to be non-decreasing: a highlight that jumps backwards
  // reads as a bug even when the audio is fine.
  const end = heard.length ? heard[heard.length - 1].end : 0;
  let last = 0;
  for (let u = 0; u < starts.length; u++) {
    if (starts[u] < 0) {
      let n = u;
      while (n < starts.length && starts[n] < 0) n++;           // [u, n) are missing
      const next = n < starts.length ? Math.max(starts[n], last) : end;
      const span = Math.max(0, next - last);
      for (let d = 0; d < n - u; d++) {
        starts[u + d] = last + span * ((d + 1) / (n - u + 1));
      }
    }
    if (starts[u] < last) starts[u] = last;
    last = starts[u];
  }

  const cues: Cue[] = units.map((u, k) => ({
    i: u.i, s: u.s, t: Math.round(starts[k] * 100) / 100,
  }));
  return { cues, matched, total: src.length, seconds: end };
}

// How much of the source was found in the transcript. Below this the alignment
// is not describing the same audio — a rendering that was cut short, the wrong
// file, a transcript of silence — and the interpolated cues are the safer
// answer.
const MIN_MATCH = 0.6;

// The whole thing: an mp3 on disk plus the blocks it was made from, in, sentence
// cues out. Throws rather than returning something half-trusted; the caller
// decides what to keep.
export async function alignFile(mp3: string, blocks: Block[]): Promise<AlignResult> {
  const units = unitsOf(blocks);
  if (!units.length) throw new Error("nothing to align");
  const heard = await transcribe(mp3);
  let r = cuesFrom(units, heard, 128);
  if (r.total && r.matched / r.total < MIN_MATCH) {
    baseLog.info(`reading/align: ${Math.round(r.matched / r.total * 100)}% in a narrow band, widening`);
    r = cuesFrom(units, heard, 768);
  }
  if (!r.total || r.matched / r.total < MIN_MATCH) {
    throw new Error(`alignment matched only ${r.total ? Math.round(r.matched / r.total * 100) : 0}% of the text`);
  }
  return r;
}
