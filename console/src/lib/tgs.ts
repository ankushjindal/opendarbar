/**
 * Thin adapter over the `tgs` CLI (KushDarbar/tgs). Every call is `tgs --json <cmd>`.
 * This is the only file that knows tgs exists; the console UI talks to these functions.
 * Future transports (imsg, wacli, gog) get their own adapter with the same shape.
 */
import { getPreferenceValues } from "@raycast/api";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { extname } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type MediaType =
  | "photo"
  | "video"
  | "gif"
  | "sticker"
  | "voice"
  | "audio"
  | "document"
  | string;

export type SavedMessage = {
  id: number;
  date: string; // ISO, local offset
  text: string;
  media: boolean;
  edited: boolean;
  media_type: MediaType | null;
  file_name: string | null;
  mime: string | null;
  size: number | null;
  duration: number | null; // seconds, audio/video only
  pinned: boolean;
};

export type Doctor = {
  user: string;
  user_id: number;
  latency_ms: number;
  daemon: boolean;
};
export type RecordStatus = {
  recording: boolean;
  path?: string;
  seconds?: number;
};

type Prefs = { tgsPath?: string; pageSize?: string };

export function pageSize(): number {
  const n = parseInt(getPreferenceValues<Prefs>().pageSize ?? "5", 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function tgsBin(): string {
  const p = (getPreferenceValues<Prefs>().tgsPath ?? "~/bin/tgs").trim();
  return p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
}

export class TgsError extends Error {
  constructor(
    message: string,
    public readonly code: number,
  ) {
    super(message);
  }
}

async function run<T>(args: string[], timeout = 25_000): Promise<T> {
  try {
    const { stdout } = await execFileP(tgsBin(), ["--json", ...args], {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        HOME: homedir(),
        PATH: `${process.env.PATH ?? ""}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
      },
    });
    return JSON.parse(stdout) as T;
  } catch (e) {
    const err = e as {
      stderr?: string;
      code?: number | string;
      message: string;
    };
    const msg = (err.stderr ?? err.message).trim().replace(/^tgs: /, "");
    const code = typeof err.code === "number" ? err.code : 1;
    if (code === 2)
      throw new TgsError("Not logged in — run `tgs login` in a terminal", 2);
    throw new TgsError(msg || "tgs failed", code);
  }
}

export const tgs = {
  doctor: () => run<Doctor>(["doctor"]),
  list: (n: number, before?: number) =>
    run<SavedMessage[]>([
      "list",
      "-n",
      String(n),
      ...(before ? ["--before", String(before)] : []),
    ]),
  listPinned: (n = 50) =>
    run<SavedMessage[]>(["list", "--pinned", "-n", String(n)]),
  pin: (id: number) => run<SavedMessage>(["pin", String(id)]),
  unpin: (id: number) => run<SavedMessage>(["unpin", String(id)]),
  search: (q: string, n = 10) =>
    run<SavedMessage[]>(["search", q, "-n", String(n)]),
  show: (id: number | string) => run<SavedMessage>(["show", String(id)]),
  add: (text: string) => run<SavedMessage>(["add", text]),
  addFile: (path: string, caption?: string) =>
    run<SavedMessage>(
      ["add", "--file", path, ...(caption ? [caption] : [])],
      120_000,
    ),
  /** Sends audio as a Telegram voice note (waveform bubble). Converts to Opus/OGG when needed. */
  addVoice: (path: string, caption?: string) =>
    run<SavedMessage>(
      ["add", "--voice", path, ...(caption ? [caption] : [])],
      120_000,
    ),
  /** tgs 0.3: text / file / voice to any peer (`me`, `@username`, id). Returns the sent message. */
  send: (
    to: string,
    text?: string,
    opts: { file?: string; voice?: boolean } = {},
  ) =>
    run<SavedMessage & { to: string }>(
      [
        "send",
        ...(opts.file ? [opts.voice ? "--voice" : "--file", opts.file] : []),
        "--",
        to,
        ...(text ? [text] : []),
      ],
      120_000,
    ),
  /** Telegram-native forward of saved messages to any peer (media kept, "Forwarded from" header). */
  forward: (ids: number[], to: string) =>
    run<{ to: string; ids: number[]; forwarded: SavedMessage[] }>(
      ["forward", "--", to, ...ids.map(String)],
      120_000,
    ),
  chats: (n = 30) =>
    run<
      {
        id: number;
        name: string;
        username: string | null;
        kind: string;
        unread: number;
      }[]
    >(["chats", "-n", String(n)]),
  edit: (id: number, text: string) =>
    run<SavedMessage>(["edit", String(id), text]),
  delete: (ids: number[]) =>
    run<{ ids: number[]; deleted: number }>(["delete", ...ids.map(String)]),
  /**
   * Downloads to the tgs media cache (or `out`) and returns the local path. Cached on repeat.
   * `m4a` transcodes audio (Telegram voice = Opus/OGG, which macOS can't play) to AAC for
   * afplay / Quick Look / QuickTime.
   */
  media: (
    id: number,
    opts: { thumb?: boolean; out?: string; m4a?: boolean } = {},
  ) =>
    run<{ id: number; path: string; cached: boolean }>(
      [
        "media",
        String(id),
        ...(opts.thumb ? ["--thumb"] : []),
        ...(opts.out ? ["--out", opts.out] : []),
        ...(opts.m4a ? ["--m4a"] : []),
      ],
      120_000,
    ),
  /** Speech-to-text for a voice/audio message; cached per engine on the tgs side. */
  transcribe: (
    id: number,
    engine: "sarvam" | "deepgram" = "sarvam",
    force = false,
  ) =>
    run<{ id: number; text: string; engine: string; cached: boolean }>(
      [
        "transcribe",
        String(id),
        "--engine",
        engine,
        ...(force ? ["--force"] : []),
      ],
      300_000,
    ),
  record: {
    start: () =>
      run<{ path: string; pid: number; recording: true }>(["record", "start"]),
    stop: () => run<{ path: string; seconds: number }>(["record", "stop"]),
    status: () => run<RecordStatus>(["record", "status"]),
  },
};

// ------------------------------------------------------------------ helpers

const AUDIO_EXT = new Set([
  ".m4a",
  ".mp3",
  ".wav",
  ".aac",
  ".ogg",
  ".oga",
  ".opus",
  ".flac",
  ".aiff",
  ".caf",
]);
export function isAudioPath(p: string): boolean {
  return AUDIO_EXT.has(extname(p).toLowerCase());
}

export function isAudio(m: SavedMessage): boolean {
  return m.media_type === "voice" || m.media_type === "audio";
}

export function firstLine(text: string, max = 80): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function hasThumb(m: SavedMessage): boolean {
  return (
    m.media_type === "photo" ||
    m.media_type === "video" ||
    m.media_type === "gif" ||
    m.media_type === "sticker"
  );
}

// Copyable to the clipboard as an image (Clipboard.copy({file})).
export function isImage(m: SavedMessage): boolean {
  return (
    m.media_type === "photo" ||
    m.media_type === "sticker" ||
    m.media_type === "gif"
  );
}

export function mediaLabel(m: SavedMessage): string {
  switch (m.media_type) {
    case "photo":
      return "Photo";
    case "video":
      return "Video";
    case "gif":
      return "GIF";
    case "sticker":
      return "Sticker";
    case "voice":
      return "Voice note";
    case "audio":
      return m.file_name ?? "Audio";
    case "document":
      return m.file_name ?? "File";
    case null:
      return "";
    default:
      return m.file_name ?? m.media_type;
  }
}

export function humanSize(n: number | null): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 14 → "0:14", 754 → "12:34" */
export function fmtDuration(s: number | null): string {
  if (!s) return "";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** "now" · "12m" · "3h" · "yesterday" · "4d" · "21 Aug" · "21 Aug 2025" */
export function relTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = Date.now();
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const days = Math.round(h / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d`;
  const day = d.toLocaleDateString([], { day: "numeric", month: "short" });
  return d.getFullYear() === new Date().getFullYear()
    ? day
    : `${day} ${d.getFullYear()}`;
}

export function absTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
