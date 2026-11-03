import {
  Action,
  ActionPanel,
  Alert,
  Clipboard,
  Color,
  confirmAlert,
  Detail,
  Icon,
  Keyboard,
  LaunchProps,
  List,
  open,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useCachedState } from "@raycast/utils";
import { homedir } from "node:os";
import { useCallback, useEffect, useRef, useState } from "react";
import AttachForm from "./attach-form";
import ComposeForm from "./compose-form";
import EditForm from "./edit-form";
import ForwardList from "./forward-list";
import SendForm from "./send-form";
import {
  chatUrl,
  type Contact,
  matchContacts,
  parseSend,
  transportLabel,
} from "./lib/contacts";
import { isPlaying, startPlayer, stopPlayer, useViewAlive } from "./lib/player";
import { type SendOpts, sendTo } from "./lib/transports";
import {
  absTime,
  firstLine,
  fmtDuration,
  hasThumb,
  humanSize,
  isAudio,
  isImage,
  mediaLabel,
  pageSize,
  relTime,
  tgs,
  TgsError,
  type SavedMessage,
} from "./lib/tgs";

/**
 * KushConsole · Saved (0.3) — the bar is a composer: text saves, @name sends, /word searches.
 *
 *   first row       → always the composer (Raycast's default highlight lands on it): ↵ saves the draft,
 *                      or opens the long-note form when the bar is empty; ↵ on any other row also saves a draft
 *   bar: /query      → server-side search replaces the list; clear → back to list
 *   bar: @name text  → Send (0.3): ↵ delivers via WhatsApp / iMessage / Telegram / Google Chat per
 *                      the address book (lib/contacts); `@` alone lists contacts, ↵ picks; `@me` = Saved
 *   bar: empty       → ↵ on a message = edit (text) / open (media)
 *   scroll to end    → next page (also ⌘L)
 *   ⌘C copy · ⌃X delete · ⌘↵ full view · ⌘R refresh · ⌘T open in Telegram
 *   ⌘⇧V save clipboard (text or image) · ⌘⇧A attach a file · ⌘⇧N long note
 *   media: ⌘O open · ⌘C copy image (photos/stickers/gifs; ⌥⌘C copies other files; text moves to ⇧⌘C) · ⌘S save to Downloads · ⌘Y quick look (after first download)
 *   ⌘M select/deselect · ⌘⇧M select all loaded · ⌃⇧X delete selected · ⌘⇧C copy selected
 *   root argument    → `saved <text>` saves immediately, then opens the list
 *   instant open     → last page is cached; renders at once, refreshes in the background
 */
const COMPOSE_ID = "__compose";

const URL_RE = /https?:\/\/[^\s<>"')\]]+/i;
function firstUrl(text: string): string | null {
  const m = text.match(URL_RE);
  return m ? m[0].replace(/[.,;:!?]+$/, "") : null;
}
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
/** "x.com/openclaw/status/2094…" — host + trimmed path, no scheme, no query noise */
function prettyUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return firstLine(`${u.hostname.replace(/^www\./, "")}${path}`, 70);
  } catch {
    return firstLine(url, 70);
  }
}

function DetailView({ markdown, title }: { markdown: string; title: string }) {
  useViewAlive();
  return <Detail markdown={markdown} navigationTitle={title} />;
}

export default function Command(
  props: LaunchProps<{ arguments: { text?: string } }>,
) {
  const N = pageSize();
  const [items, setItems] = useCachedState<SavedMessage[]>(
    "saved:first-page",
    [],
  );
  const [meId, setMeId] = useCachedState<number | null>("me:id", null);
  const [meName, setMeName] = useCachedState<string | null>(
    "me:username",
    null,
  );
  // Pinned: cached so it paints instantly; refreshed after page 1, never on the quick-add path.
  const [pinned, setPinned] = useCachedState<SavedMessage[]>(
    "saved:pinned",
    [],
  );
  const [transcripts, setTranscripts] = useCachedState<Record<number, string>>(
    "media:transcripts",
    {},
  );
  const [thumbs, setThumbs] = useCachedState<Record<number, string>>(
    "media:thumbs",
    {},
  );
  const [files, setFiles] = useCachedState<Record<number, string>>(
    "media:files:v2", // v2: audio paths are m4a; v1 cached .oga which nothing could open
    {},
  );
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [bar, setBar] = useState("");
  const barRef = useRef(""); // latest bar text — read at action time, never from a stale render
  const { push } = useNavigation();
  const [error, setError] = useState<string | null>(null);
  const [marked, setMarked] = useState<Set<number>>(new Set());
  const [serverMatches, setServerMatches] = useState<SavedMessage[]>([]);
  const [results, setResults] = useState<SavedMessage[]>([]); // /search results, never cached
  const composeSeq = useRef(0);
  const seq = useRef(0);
  const bootArg = useRef((props.arguments.text ?? "").trim());
  const thumbQueue = useRef<Set<number>>(new Set());
  // Reopen with as many rows as were loaded last time (⌘L ×2 → 15 stays 15), capped.
  const bootCount = useRef(Math.min(Math.max(items.length, N), 50));
  const [playing, setPlaying] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  // Send mode: last 10 deliveries this session (↵ opens that chat).
  const [sent, setSent] = useState<
    { c: Contact; text: string; at: number; id?: string }[]
  >([]);

  useViewAlive();
  useEffect(() => {
    if (!isPlaying()) setPlaying(null);
  }, []);

  const searching = bar.startsWith("/");
  const sendReq = parseSend(bar);
  const sending = sendReq !== null;
  const target = sendReq?.mode === "compose" ? sendReq.contact : null;
  const sendText = sendReq?.mode === "compose" ? sendReq.text : "";
  const query = searching ? bar.slice(1).trim() : "";
  const draft = searching || sending ? "" : bar.trim();

  const fill = useCallback((t: string) => {
    barRef.current = t;
    setBar(t);
  }, []);

  const fail = useCallback(async (title: string, e: unknown) => {
    const msg = (e as TgsError).message ?? String(e);
    setError(msg);
    await showToast({ style: Toast.Style.Failure, title, message: msg });
  }, []);

  const upsert = useCallback(
    (m: SavedMessage) => {
      setItems((cur) => {
        const i = cur.findIndex((x) => x.id === m.id);
        if (i === -1) return [m, ...cur];
        const next = cur.slice();
        next[i] = m;
        return next;
      });
    },
    [setItems],
  );

  const loadFirst = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const want = bootCount.current;
      const page = await tgs.list(want);
      if (my !== seq.current) return;
      setItems(page);
      setHasMore(page.length === want);
    } catch (e) {
      if (my === seq.current) await fail("Couldn't load Saved Messages", e);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [N, fail, setItems]);

  const loadMore = useCallback(async () => {
    if (!hasMore || items.length === 0 || searching || loading) return;
    setLoading(true);
    try {
      const page = await tgs.list(N, items[items.length - 1].id);
      setItems((cur) => [...cur, ...page]);
      bootCount.current = Math.min(items.length + page.length, 50);
      setHasMore(page.length === N);
    } catch (e) {
      await fail("Couldn't load more", e);
    } finally {
      setLoading(false);
    }
  }, [N, hasMore, items, searching, loading, fail, setItems]);

  const save = useCallback(
    async (
      text: string,
      source: "bar" | "clipboard" | "argument" | "compose",
    ): Promise<boolean> => {
      const t = text.replace(/\s+$/, "");
      if (!t.trim()) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Nothing to save",
        });
        return false;
      }
      const toast = await showToast({
        style: Toast.Style.Animated,
        title: "Saving…",
      });
      try {
        const m = await tgs.add(t);
        upsert(m);
        if (source === "bar") setBar("");
        if (source === "compose") {
          barRef.current = "";
          setBar("");
        }
        toast.style = Toast.Style.Success;
        toast.title =
          source === "clipboard"
            ? `Saved clipboard #${m.id}`
            : `Saved #${m.id}`;
        return true;
      } catch (e) {
        toast.hide();
        await fail("Save failed", e);
        return false;
      }
    },
    [upsert, fail],
  );

  const saveFile = useCallback(
    async (path: string, caption?: string) => {
      const toast = await showToast({
        style: Toast.Style.Animated,
        title: "Uploading…",
      });
      try {
        const m = await tgs.addFile(path, caption);
        upsert(m);
        setBar("");
        toast.style = Toast.Style.Success;
        toast.title = `Saved ${mediaLabel(m).toLowerCase()} #${m.id}`;
      } catch (e) {
        toast.hide();
        await fail("Upload failed", e);
      }
    },
    [upsert, fail],
  );

  // Send: one path for bar ↵, attach, voice and clipboard in @ mode. Clears the bar on success.
  const doSend = useCallback(
    async (c: Contact, text: string, opts?: SendOpts): Promise<boolean> => {
      const toast = await showToast({
        style: Toast.Style.Animated,
        title: `Sending to ${c.label} · ${transportLabel(c.transport)}…`,
      });
      try {
        const r = await sendTo(c, text, opts);
        if (r.message) upsert(r.message);
        setSent((cur) =>
          [{ c, text, at: Date.now(), id: r.id }, ...cur].slice(0, 10),
        );
        fill("");
        toast.style = Toast.Style.Success;
        toast.title = `Sent to ${c.label} · ${transportLabel(c.transport)}`;
        toast.message = firstLine(text, 60) || undefined;
        return true;
      } catch (e) {
        toast.hide();
        await fail("Send failed", e);
        return false;
      }
    },
    [upsert, fill, fail],
  );

  // Boot: optional root argument saves first, then the list refreshes (cached page already showing).
  useEffect(() => {
    (async () => {
      // Take the argument synchronously: this effect can run twice (React double-invoke /
      // Raycast remount) and an await in between saved the note twice.
      const arg = bootArg.current;
      bootArg.current = "";
      if (arg.startsWith("@"))
        fill(arg); // `saved @kai …` lands in send mode, never saved as a note
      else if (arg) await save(arg, "argument");
      await loadFirst();
      tgs
        .listPinned()
        .then(setPinned)
        .catch(() => {});
      if (meId === null) {
        tgs
          .doctor()
          .then((d) => {
            setMeId(d.user_id);
            if (d.user.startsWith("@")) setMeName(d.user.slice(1));
          })
          .catch(() => {});
      }
    })();
  }, []);

  // Search mode: /query → results replace the list (debounced). Leaving search mode clears them.
  const wasSearching = useRef(false);
  useEffect(() => {
    if (searching) {
      wasSearching.current = true;
      if (!query) return;
      const my = ++seq.current;
      setLoading(true);
      const t = setTimeout(() => {
        tgs
          .search(query, 20)
          .then((res) => {
            if (my !== seq.current) return;
            setResults(res);
          })
          .catch((e) => {
            if (my === seq.current) void fail("Search failed", e);
          })
          .finally(() => {
            if (my === seq.current) setLoading(false);
          });
      }, 300);
      return () => clearTimeout(t);
    } else if (wasSearching.current) {
      wasSearching.current = false;
      setResults([]);
      setLoading(false);
    }
  }, [searching, query, fail]);

  // Composer: filter live — local substring on what's loaded (instant) + a debounced server search.
  // The bar itself is NOT throttled: a fast type-then-↵ must see the draft immediately.
  useEffect(() => {
    const my = ++composeSeq.current;
    if (!draft || draft.length < 2) {
      setServerMatches([]);
      return;
    }
    const t = setTimeout(() => {
      tgs
        .search(draft, 10)
        .then((res) => {
          if (my === composeSeq.current) setServerMatches(res);
        })
        .catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [draft]);

  const draftLower = draft.toLowerCase();
  const localMatches = draft
    ? items.filter((m) => m.text.toLowerCase().includes(draftLower))
    : [];
  const localIds = new Set(localMatches.map((m) => m.id));
  const composeMatches = draft
    ? [...localMatches, ...serverMatches.filter((m) => !localIds.has(m.id))]
    : [];

  // Thumbnails: fetch lazily for visible media, one at a time, cached across launches.
  const visible = draft ? composeMatches : searching ? results : items;
  useEffect(() => {
    const want = visible.filter(
      (m) => hasThumb(m) && !thumbs[m.id] && !thumbQueue.current.has(m.id),
    );
    if (want.length === 0) return;
    want.forEach((m) => thumbQueue.current.add(m.id));
    (async () => {
      for (const m of want) {
        try {
          const r = await tgs.media(m.id, { thumb: true });
          setThumbs((cur) => ({ ...cur, [m.id]: r.path }));
        } catch {
          /* no thumb — keep the type icon */
        }
      }
    })();
  }, [visible, thumbs, setThumbs]);

  // Audio is fetched as m4a (Telegram voice = Opus/OGG, which macOS can't play natively).
  const download = useCallback(
    async (m: SavedMessage, out?: string): Promise<string | null> => {
      const toast = await showToast({
        style: Toast.Style.Animated,
        title: `Downloading ${mediaLabel(m).toLowerCase()}…`,
      });
      try {
        const r = await tgs.media(m.id, { out, m4a: isAudio(m) && !out });
        if (!out) setFiles((cur) => ({ ...cur, [m.id]: r.path }));
        toast.hide();
        return r.path;
      } catch (e) {
        toast.hide();
        await fail("Download failed", e);
        return null;
      }
    },
    [fail, setFiles],
  );

  const openMedia = useCallback(
    async (m: SavedMessage) => {
      const path = files[m.id] ?? (await download(m));
      if (path) await open(path);
    },
    [files, download],
  );

  const saveToDownloads = useCallback(
    async (m: SavedMessage) => {
      const path = await download(m, `${homedir()}/Downloads`);
      if (path)
        await showToast({
          style: Toast.Style.Success,
          title: "Saved to Downloads",
          message: path.split("/").pop(),
        });
    },
    [download],
  );

  // Copy Image: download (cached) then put the file on the pasteboard, so ⌘V pastes the picture.
  const copyMedia = useCallback(
    async (m: SavedMessage) => {
      const path = files[m.id] ?? (await download(m));
      if (!path) return;
      await Clipboard.copy({ file: path });
      await showToast({
        style: Toast.Style.Success,
        title: isImage(m) ? "Image copied" : "File copied",
        message: path.split("/").pop(),
      });
    },
    [files, download],
  );

  const prepareQuickLook = useCallback(
    async (m: SavedMessage) => {
      const path = await download(m);
      if (path)
        await showToast({
          style: Toast.Style.Success,
          title: "Ready — press ⌘Y again for Quick Look",
        });
    },
    [download],
  );

  // Native macOS Telegram has no message-level deep link for private chats (tested 2026-09-03:
  // tg://openmessage opens the app but doesn't navigate). Best available: open Saved Messages.
  const openInTelegram = useCallback(async () => {
    if (meName) await open(`tg://resolve?domain=${meName}`);
    else if (meId) await open(`tg://openmessage?user_id=${meId}`);
    else
      await showToast({
        style: Toast.Style.Failure,
        title: "Telegram identity not known yet — try again in a second",
      });
  }, [meId, meName]);

  // Voice / audio: play in place (lib/player). Survives view pushes; stops when the console closes.
  const playToggle = useCallback(
    async (m: SavedMessage) => {
      if (playing === m.id) {
        stopPlayer();
        setPlaying(null);
        return;
      }
      const path = files[m.id] ?? (await download(m));
      if (!path) return;
      startPlayer(path, () => setPlaying(null));
      setPlaying(m.id);
      await showToast({
        style: Toast.Style.Success,
        title: `Playing ${mediaLabel(m).toLowerCase()}${m.duration ? ` · ${fmtDuration(m.duration)}` : ""}`,
        message: "⌘⇧P stops",
      });
    },
    [playing, files, download],
  );

  // ⌘⇧R: record from the mic → press again to stop → upload as a voice note (bar text = caption).
  const recordToggle = useCallback(async () => {
    if (!recording) {
      try {
        await tgs.record.start();
        setRecording(true);
        await showToast({
          style: Toast.Style.Animated,
          title: "Recording… ⌘⇧R to stop and send",
          message: draft ? `caption: ${firstLine(draft, 40)}` : undefined,
        });
      } catch (e) {
        await fail("Couldn't start recording", e);
      }
      return;
    }
    setRecording(false);
    if (target) {
      // @ mode: voice note to that contact (Telegram = waveform bubble; others get the audio file)
      const rec = await tgs.record.stop().catch((e) => {
        void fail("Recording failed", e);
        return null;
      });
      if (rec) await doSend(target, sendText, { file: rec.path, voice: true });
      return;
    }
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Uploading voice note…",
    });
    try {
      const rec = await tgs.record.stop();
      const m = await tgs.addVoice(rec.path, draft || undefined);
      upsert(m);
      setBar("");
      toast.style = Toast.Style.Success;
      toast.title = `Saved voice note #${m.id} · ${fmtDuration(rec.seconds)}`;
    } catch (e) {
      toast.hide();
      await fail("Voice note failed", e);
    }
  }, [recording, draft, target, sendText, doSend, upsert, fail]);

  // If a recording was left running (Raycast closed mid-record), pick it up.
  useEffect(() => {
    tgs.record
      .status()
      .then((s) => setRecording(!!s.recording))
      .catch(() => {});
  }, []);

  // ⌘⇧T on a voice note: first press transcribes (Sarvam; Deepgram via ⌥⇧T), second press
  // writes the transcript as the message caption so /search finds it — here and in Telegram.
  const transcribe = useCallback(
    async (m: SavedMessage, engine: "sarvam" | "deepgram" = "sarvam") => {
      const toast = await showToast({
        style: Toast.Style.Animated,
        title: `Transcribing (${engine})…`,
      });
      try {
        const r = await tgs.transcribe(m.id, engine);
        setTranscripts((cur) => ({ ...cur, [m.id]: r.text }));
        toast.style = Toast.Style.Success;
        toast.title = r.cached
          ? "Transcript (cached)"
          : `Transcribed · ${engine}`;
        toast.message = firstLine(r.text, 80);
      } catch (e) {
        toast.hide();
        await fail("Transcription failed", e);
      }
    },
    [setTranscripts, fail],
  );

  const captionFromTranscript = useCallback(
    async (m: SavedMessage) => {
      const text = transcripts[m.id];
      if (!text) return;
      try {
        const u = await tgs.edit(m.id, text);
        upsert(u);
        await showToast({
          style: Toast.Style.Success,
          title: `Caption set on #${m.id}`,
          message: "now searchable",
        });
      } catch (e) {
        await fail("Couldn't set caption", e);
      }
    },
    [transcripts, upsert, fail],
  );

  const pinToggle = useCallback(
    async (m: SavedMessage) => {
      try {
        const u = m.pinned ? await tgs.unpin(m.id) : await tgs.pin(m.id);
        upsert(u);
        setPinned((cur) =>
          u.pinned
            ? [u, ...cur.filter((x) => x.id !== u.id)]
            : cur.filter((x) => x.id !== u.id),
        );
        await showToast({
          style: Toast.Style.Success,
          title: u.pinned ? `Pinned #${u.id}` : `Unpinned #${u.id}`,
        });
      } catch (e) {
        await fail(m.pinned ? "Unpin failed" : "Pin failed", e);
      }
    },
    [upsert, setPinned, fail],
  );

  const remove = useCallback(
    async (m: SavedMessage) => {
      const ok = await confirmAlert({
        title: "Delete saved message?",
        message: firstLine(m.text, 120) || mediaLabel(m) || `#${m.id}`,
        primaryAction: {
          title: "Delete",
          style: Alert.ActionStyle.Destructive,
        },
      });
      if (!ok) return;
      try {
        await tgs.delete([m.id]);
        setItems((cur) => cur.filter((x) => x.id !== m.id));
        setPinned((cur) => cur.filter((x) => x.id !== m.id));
        await showToast({
          style: Toast.Style.Success,
          title: `Deleted #${m.id}`,
        });
      } catch (e) {
        await fail("Delete failed", e);
      }
    },
    [fail, setItems],
  );

  // Clipboard: image/file → attach; text → save as note.
  const saveClipboard = useCallback(async () => {
    const c = await Clipboard.read();
    const path = c.file
      ? c.file.startsWith("file://")
        ? decodeURIComponent(c.file.slice(7))
        : c.file
      : null;
    if (target) {
      // @ mode: clipboard goes to that contact — file as attachment (bar text = caption), else text
      await doSend(target, path ? sendText : (c.text ?? ""), {
        file: path ?? undefined,
      });
      return;
    }
    if (path) {
      await saveFile(path, draft || undefined);
      return;
    }
    await save(c.text ?? "", "clipboard");
  }, [save, saveFile, draft, target, sendText, doSend]);

  const toggleMark = useCallback((id: number) => {
    setMarked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allMarked = items.length > 0 && items.every((m) => marked.has(m.id));
  const markAll = useCallback(() => {
    setMarked(allMarked ? new Set() : new Set(items.map((m) => m.id)));
  }, [items, allMarked]);

  const markedItems = items.filter((m) => marked.has(m.id));

  const copyMarked = useCallback(async () => {
    if (markedItems.length === 0) return;
    await Clipboard.copy(
      markedItems.map((m) => m.text || mediaLabel(m)).join("\n\n"),
    );
    await showToast({
      style: Toast.Style.Success,
      title: `Copied ${markedItems.length} message${markedItems.length > 1 ? "s" : ""}`,
    });
  }, [markedItems]);

  const deleteMarked = useCallback(async () => {
    if (markedItems.length === 0) return;
    const preview = markedItems
      .slice(0, 5)
      .map((m) => "• " + (firstLine(m.text, 60) || mediaLabel(m) || `#${m.id}`))
      .join("\n");
    const ok = await confirmAlert({
      title: `Delete ${markedItems.length} saved message${markedItems.length > 1 ? "s" : ""}?`,
      message:
        preview +
        (markedItems.length > 5 ? `\n… +${markedItems.length - 5} more` : ""),
      primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
    });
    if (!ok) return;
    const ids = markedItems.map((m) => m.id);
    try {
      await tgs.delete(ids);
      setItems((cur) => cur.filter((x) => !marked.has(x.id)));
      setPinned((cur) => cur.filter((x) => !marked.has(x.id)));
      setMarked(new Set());
      await showToast({
        style: Toast.Style.Success,
        title: `Deleted ${ids.length}`,
      });
    } catch (e) {
      await fail("Bulk delete failed", e);
    }
  }, [markedItems, marked, fail, setItems]);

  // ↵ on the composer row. Decides from the LIVE bar text, so a fast type→↵ can't hit a stale
  // "empty" action: Raycast delivers keystrokes before the ↵, and this reads the ref at call time.
  // Long note: opens pre-filled with whatever is in the bar (read live, so fast keys still land),
  // and saving from the form clears the bar.
  const openLongNote = useCallback(() => {
    const live = barRef.current.startsWith("/") ? "" : barRef.current;
    push(
      <EditForm
        mode="add"
        initial={live}
        onDone={(m) => {
          upsert(m);
          barRef.current = "";
          setBar("");
        }}
      />,
    );
  }, [push, upsert]);

  const onSentForm = useCallback(
    (c: Contact, text: string, id?: string) => {
      setSent((cur) => [{ c, text, at: Date.now(), id }, ...cur].slice(0, 10));
      fill("");
    },
    [fill],
  );

  // ⌘⇧↵: the bar, but multi-line. `@name …` → message to that contact through doSend (same
  // transport code, errors, toast as ↵); anything else → a note through save(). Reads the bar
  // live, like composeEnter, so text typed just before the keypress is carried over.
  const openCompose = useCallback(() => {
    const live = barRef.current;
    const req = parseSend(live);
    if (req?.mode === "compose") {
      const c = req.contact;
      push(
        <ComposeForm
          target={c}
          initial={req.text}
          onSubmit={(text) => doSend(c, text)}
        />,
      );
      return;
    }
    if (req) {
      void showToast({
        style: Toast.Style.Failure,
        title:
          req.mode === "pick"
            ? "Pick a contact first"
            : `No contact @${req.key}`,
        message:
          req.mode === "pick"
            ? "type @name and a space, then ⌘⇧↵"
            : "add it to ~/.config/kushconsole/contacts.json",
      });
      return;
    }
    push(
      <ComposeForm
        target={null}
        initial={live.startsWith("/") ? "" : live}
        onSubmit={(text) => save(text, "compose")}
      />,
    );
  }, [push, doSend, save]);

  const composeEnter = useCallback(() => {
    const live = barRef.current;
    const req = parseSend(live);
    if (req) {
      if (req.mode === "compose" && req.text.trim())
        void doSend(req.contact, req.text);
      else if (req.mode === "compose")
        push(<SendForm to={req.contact} onSent={onSentForm} />);
      else if (req.mode === "pick") {
        const first = matchContacts(req.prefix)[0];
        if (first) fill(`@${first.key} `);
      } else
        void showToast({
          style: Toast.Style.Failure,
          title: `No contact @${req.key}`,
          message: "add it to ~/.config/kushconsole/contacts.json",
        });
      return;
    }
    if (live.trim() && !live.startsWith("/")) void save(live, "bar");
    else openLongNote();
  }, [save, openLongNote, doSend, push, onSentForm, fill]);

  const bulkActions = (
    <ActionPanel.Section
      title={marked.size ? `${marked.size} selected` : "Select"}
    >
      <Action
        title={allMarked ? "Deselect All" : "Select All Loaded"}
        icon={Icon.CheckCircle}
        shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
        onAction={markAll}
      />
      {marked.size > 0 && (
        <>
          <Action
            title={`Copy ${marked.size} Selected`}
            icon={Icon.CopyClipboard}
            shortcut={Keyboard.Shortcut.Common.Copy}
            onAction={copyMarked}
          />
          <Action
            title={`Delete ${marked.size} Selected`}
            icon={Icon.Trash}
            style={Action.Style.Destructive}
            shortcut={{ modifiers: ["ctrl", "shift"], key: "x" }}
            onAction={deleteMarked}
          />
          <Action.Push
            title={`Forward ${marked.size} Selected…`}
            icon={Icon.ArrowRight}
            shortcut={{ modifiers: ["ctrl", "shift"], key: "f" }}
            target={
              <ForwardList
                messages={markedItems}
                onDone={() => setMarked(new Set())}
              />
            }
          />
          <Action
            title="Clear Selection"
            icon={Icon.XMarkCircle}
            onAction={() => setMarked(new Set())}
          />
        </>
      )}
    </ActionPanel.Section>
  );

  const consoleActions = (
    <ActionPanel.Section title="Console">
      {(target || !sending) && (
        <Action
          title={
            target
              ? `Compose Long Message to ${target.label}…`
              : "Compose Long Note…"
          }
          icon={Icon.Pencil}
          shortcut={{ modifiers: ["cmd", "shift"], key: "return" }}
          onAction={openCompose}
        />
      )}
      {!sending && (
        <Action
          title="Long Note…"
          icon={Icon.TextDocument}
          shortcut={{ modifiers: ["cmd", "shift"], key: "n" }}
          onAction={openLongNote}
        />
      )}
      <Action.Push
        title={target ? `Attach a File for ${target.label}…` : "Attach a File…"}
        icon={Icon.Paperclip}
        shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
        target={
          <AttachForm
            initialCaption={target ? sendText : draft}
            target={target ?? undefined}
            onDone={upsert}
            onSent={onSentForm}
          />
        }
      />
      <Action
        title={recording ? "Stop Recording & Send" : "Record Voice Note"}
        icon={
          recording
            ? { source: Icon.Stop, tintColor: Color.Red }
            : Icon.Microphone
        }
        shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
        onAction={recordToggle}
      />
      <Action
        title="Save Clipboard"
        icon={Icon.Clipboard}
        shortcut={{ modifiers: ["cmd", "shift"], key: "v" }}
        onAction={saveClipboard}
      />
      {!searching && hasMore && (
        <Action
          title={`Load ${N} More`}
          icon={Icon.ArrowDown}
          shortcut={{ modifiers: ["cmd"], key: "l" }}
          onAction={loadMore}
        />
      )}
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={() => {
          void loadFirst();
          tgs
            .listPinned()
            .then(setPinned)
            .catch(() => {});
        }}
      />
      <Action
        title="Open Saved Messages in Telegram"
        icon={Icon.Airplane}
        shortcut={{ modifiers: ["cmd"], key: "t" }}
        onAction={openInTelegram}
      />
    </ActionPanel.Section>
  );

  const itemIcon = (m: SavedMessage) => {
    if (thumbs[m.id]) return { source: thumbs[m.id] };
    switch (m.media_type) {
      case "photo":
        return Icon.Image;
      case "video":
      case "gif":
        return Icon.Video;
      case "voice":
        return Icon.Microphone;
      case "audio":
        return Icon.Music;
      case "sticker":
        return Icon.Emoji;
      case "document":
        return Icon.Document;
      case null:
        return Icon.Message;
      default:
        return Icon.Paperclip;
    }
  };

  const detailMarkdown = (m: SavedMessage) => {
    const img = files[m.id] ?? thumbs[m.id];
    const parts: string[] = [];
    if (
      m.media &&
      img &&
      (m.media_type === "photo" ||
        m.media_type === "sticker" ||
        m.media_type === "gif")
    )
      parts.push(`![${mediaLabel(m)}](${img})`);
    else if (m.media)
      parts.push(
        `_${mediaLabel(m)}${m.duration ? ` · ${fmtDuration(m.duration)}` : ""}${m.size ? ` · ${humanSize(m.size)}` : ""}${isAudio(m) ? " · ⌘⇧P plays" : ""}_`,
      );
    if (m.text) parts.push(m.text);
    if (isAudio(m) && transcripts[m.id] && transcripts[m.id] !== m.text)
      parts.push(`**Transcript**\n\n${transcripts[m.id]}`);
    return parts.join("\n\n") || "_(empty)_";
  };

  const renderItem = (m: SavedMessage, ns = "") => {
    const label = mediaLabel(m);
    const url = firstUrl(m.text);
    const pureLink = !m.media && url !== null && m.text.trim() === url;
    const title = pureLink
      ? prettyUrl(url)
      : firstLine(m.text) || label || "(empty)";
    const subtitle =
      m.media && m.text
        ? label
        : isAudio(m) && transcripts[m.id]
          ? firstLine(transcripts[m.id], 90)
          : pureLink
            ? hostOf(url)
            : undefined;
    const file = files[m.id];
    return (
      <List.Item
        key={`${ns}${m.id}`}
        id={`${ns}${m.id}`}
        icon={pureLink ? Icon.Link : itemIcon(m)}
        title={title}
        subtitle={subtitle}
        quickLook={
          file ? { path: file, name: m.file_name ?? label } : undefined
        }
        accessories={[
          ...(marked.has(m.id)
            ? [
                {
                  icon: { source: Icon.CheckCircle, tintColor: Color.Green },
                  tooltip: "selected",
                },
              ]
            : []),
          ...(playing === m.id
            ? [
                {
                  icon: { source: Icon.Play, tintColor: Color.Green },
                  tooltip: "playing · ⌘⇧P stops",
                },
              ]
            : []),
          ...(m.duration
            ? [{ text: fmtDuration(m.duration), tooltip: "duration" }]
            : []),
          ...(m.size && !isAudio(m) ? [{ text: humanSize(m.size) }] : []),
          ...(m.pinned ? [{ icon: Icon.Pin, tooltip: "pinned" }] : []),
          ...(m.edited
            ? [{ tag: { value: "edited", color: Color.SecondaryText } }]
            : []),
          { text: relTime(m.date), tooltip: absTime(m.date) },
        ]}
        actions={
          <ActionPanel>
            <ActionPanel.Section
              title={`#${m.id}${m.media ? ` · ${label}` : ""}`}
            >
              {draft && (
                <Action
                  title={`Save: ${firstLine(draft, 60)}`}
                  icon={{ source: Icon.PlusCircle, tintColor: Color.Green }}
                  onAction={() => save(barRef.current, "bar")}
                />
              )}
              {isAudio(m) ? (
                <Action
                  title={playing === m.id ? "Stop" : "Play"}
                  icon={playing === m.id ? Icon.Stop : Icon.Play}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
                  onAction={() => playToggle(m)}
                />
              ) : m.media ? (
                <Action
                  title="Open"
                  icon={Icon.ArrowNe}
                  onAction={() => openMedia(m)}
                />
              ) : pureLink ? (
                <Action.OpenInBrowser url={url} />
              ) : (
                <Action.Push
                  title="Edit"
                  icon={Icon.Pencil}
                  shortcut={Keyboard.Shortcut.Common.Edit}
                  target={<EditForm mode="edit" message={m} onDone={upsert} />}
                />
              )}
              {m.media && (
                <>
                  {isAudio(m) && (
                    <>
                      {transcripts[m.id] && m.text !== transcripts[m.id] ? (
                        <Action
                          title="Set Transcript as Caption"
                          icon={Icon.Text}
                          shortcut={{ modifiers: ["cmd", "shift"], key: "t" }}
                          onAction={() => captionFromTranscript(m)}
                        />
                      ) : (
                        <Action
                          title={
                            transcripts[m.id]
                              ? "Re-Transcribe (Sarvam)"
                              : "Transcribe (Sarvam)"
                          }
                          icon={Icon.Text}
                          shortcut={{ modifiers: ["cmd", "shift"], key: "t" }}
                          onAction={() => transcribe(m, "sarvam")}
                        />
                      )}
                      <Action
                        title="Transcribe (Deepgram)"
                        icon={Icon.Text}
                        shortcut={{ modifiers: ["opt", "shift"], key: "t" }}
                        onAction={() => transcribe(m, "deepgram")}
                      />
                      {transcripts[m.id] && (
                        <Action.CopyToClipboard
                          title="Copy Transcript"
                          content={transcripts[m.id]}
                          shortcut={Keyboard.Shortcut.Common.Copy}
                        />
                      )}
                    </>
                  )}
                  {file ? (
                    <Action.ToggleQuickLook
                      title="Quick Look"
                      shortcut={Keyboard.Shortcut.Common.ToggleQuickLook}
                    />
                  ) : (
                    <Action
                      title="Download for Quick Look"
                      icon={Icon.Eye}
                      shortcut={Keyboard.Shortcut.Common.ToggleQuickLook}
                      onAction={() => prepareQuickLook(m)}
                    />
                  )}
                  <Action
                    title="Open"
                    icon={Icon.ArrowNe}
                    shortcut={Keyboard.Shortcut.Common.Open}
                    onAction={() => openMedia(m)}
                  />
                  <Action
                    title={isImage(m) ? "Copy Image" : "Copy File"}
                    icon={Icon.Clipboard}
                    shortcut={
                      isImage(m)
                        ? { modifiers: ["cmd"], key: "c" }
                        : { modifiers: ["cmd", "opt"], key: "c" }
                    }
                    onAction={() => copyMedia(m)}
                  />
                  <Action
                    title="Save to Downloads"
                    icon={Icon.Download}
                    shortcut={Keyboard.Shortcut.Common.Save}
                    onAction={() => saveToDownloads(m)}
                  />
                  {m.text && (
                    <Action.Push
                      title="Edit Caption"
                      icon={Icon.Pencil}
                      shortcut={Keyboard.Shortcut.Common.Edit}
                      target={
                        <EditForm mode="edit" message={m} onDone={upsert} />
                      }
                    />
                  )}
                </>
              )}
              <Action
                title={m.pinned ? "Unpin" : "Pin"}
                icon={m.pinned ? Icon.PinDisabled : Icon.Pin}
                shortcut={{ modifiers: ["cmd", "shift"], key: "i" }}
                onAction={() => pinToggle(m)}
              />
              <Action
                title={marked.has(m.id) ? "Deselect" : "Select"}
                icon={marked.has(m.id) ? Icon.Circle : Icon.CheckCircle}
                shortcut={{ modifiers: ["cmd"], key: "m" }}
                onAction={() => toggleMark(m.id)}
              />
              {url && !m.media && (
                <Action.OpenInBrowser
                  title={pureLink ? "Open in Browser" : "Open Link"}
                  url={url}
                  shortcut={Keyboard.Shortcut.Common.Open}
                />
              )}
              {pureLink && (
                <Action.Push
                  title="Edit"
                  icon={Icon.Pencil}
                  shortcut={Keyboard.Shortcut.Common.Edit}
                  target={<EditForm mode="edit" message={m} onDone={upsert} />}
                />
              )}
              <Action.CopyToClipboard
                title="Copy Text"
                content={m.text || label}
                shortcut={
                  isImage(m)
                    ? { modifiers: ["cmd", "shift"], key: "c" }
                    : { modifiers: ["cmd"], key: "c" }
                }
              />
              <Action.Push
                title="Forward…"
                icon={Icon.ArrowRight}
                shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
                target={<ForwardList messages={[m]} />}
              />
              <Action.Push
                title="View Full"
                icon={Icon.Eye}
                shortcut={{ modifiers: ["cmd"], key: "return" }}
                target={
                  <DetailView markdown={detailMarkdown(m)} title={`#${m.id}`} />
                }
              />
              <Action
                title="Delete"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                shortcut={{ modifiers: ["ctrl"], key: "x" }}
                onAction={() => remove(m)}
              />
            </ActionPanel.Section>
            {bulkActions}
            {consoleActions}
          </ActionPanel>
        }
      />
    );
  };

  const placeholder = searching
    ? "Searching Saved Messages…"
    : sending
      ? "@name message  ·  ↵ sends"
      : "type a note, ↵ saves  ·  @name sends  ·  /word searches";

  // Composer row in @ mode: what ↵ will do, spelled out.
  const sendRow = (() => {
    if (!sendReq) return null;
    if (sendReq.mode === "compose") {
      const c = sendReq.contact;
      const via = `${c.label} · ${transportLabel(c.transport)}`;
      return sendReq.text.trim()
        ? {
            icon: { source: Icon.Airplane, tintColor: Color.Green },
            title: `Send to ${via}: ${firstLine(sendReq.text, 80)}`,
            subtitle: "⌘⇧↵ long message" as string | undefined,
          }
        : {
            icon: { source: Icon.Airplane, tintColor: Color.Green },
            title: `Message ${via}`,
            subtitle: "type after the name, ↵ sends · ↵ now = long message",
          };
    }
    if (sendReq.mode === "pick") {
      const first = matchContacts(sendReq.prefix)[0];
      return first
        ? {
            icon: Icon.Person,
            title: `@${first.key} — ${first.label} · ${transportLabel(first.transport)}`,
            subtitle: "↵ picks, then type the message",
          }
        : {
            icon: { source: Icon.Person, tintColor: Color.Red },
            title: `No contact matches "${sendReq.prefix}"`,
            subtitle: "~/.config/kushconsole/contacts.json",
          };
    }
    return {
      icon: { source: Icon.Person, tintColor: Color.Red },
      title: `No contact @${sendReq.key}`,
      subtitle: "add it to ~/.config/kushconsole/contacts.json",
    };
  })();

  const contactRow = (c: Contact) => (
    <List.Item
      key={`c:${c.key}`}
      id={`c:${c.key}`}
      icon={Icon.Person}
      title={`@${c.key}`}
      subtitle={c.label}
      accessories={[{ text: transportLabel(c.transport) }]}
      actions={
        <ActionPanel>
          <Action
            title={`Message ${c.label}`}
            icon={Icon.Airplane}
            onAction={() => fill(`@${c.key} `)}
          />
          <Action.Push
            title="Long Message…"
            icon={Icon.TextDocument}
            shortcut={{ modifiers: ["cmd", "shift"], key: "n" }}
            target={<SendForm to={c} onSent={onSentForm} />}
          />
          {chatUrl(c, meName) && (
            <Action.Open
              title={`Open Chat in ${transportLabel(c.transport)}`}
              target={chatUrl(c, meName) as string}
              shortcut={{ modifiers: ["cmd"], key: "t" }}
            />
          )}
          {consoleActions}
        </ActionPanel>
      }
    />
  );

  const sentRow = (s: { c: Contact; text: string; at: number }, i: number) => (
    <List.Item
      key={`s:${s.at}:${i}`}
      icon={{ source: Icon.Checkmark, tintColor: Color.Green }}
      title={firstLine(s.text, 80) || "(file)"}
      subtitle={`${s.c.label} · ${transportLabel(s.c.transport)}`}
      accessories={[{ text: relTime(new Date(s.at).toISOString()) }]}
      actions={
        <ActionPanel>
          {chatUrl(s.c, meName) && (
            <Action.Open
              title={`Open Chat in ${transportLabel(s.c.transport)}`}
              target={chatUrl(s.c, meName) as string}
            />
          )}
          <Action
            title={`Message ${s.c.label} Again`}
            icon={Icon.Airplane}
            onAction={() => fill(`@${s.c.key} `)}
          />
          <Action.CopyToClipboard title="Copy Text" content={s.text} />
          {consoleActions}
        </ActionPanel>
      }
    />
  );

  return (
    <List
      isLoading={loading}
      filtering={false}
      searchText={bar}
      onSearchTextChange={(t) => {
        barRef.current = t;
        setBar(t);
      }}
      searchBarPlaceholder={placeholder}
      navigationTitle="KushConsole · Saved"
      pagination={{
        onLoadMore: loadMore,
        hasMore: hasMore && !searching,
        pageSize: N,
      }}
      actions={
        <ActionPanel>
          {bulkActions}
          {consoleActions}
        </ActionPanel>
      }
    >
      {!searching && (
        <List.Section title={sending ? "Send" : draft ? "Compose" : "New"}>
          <List.Item
            id={COMPOSE_ID}
            icon={
              sendRow?.icon ?? {
                source: Icon.PlusCircle,
                tintColor: Color.Green,
              }
            }
            title={
              sendRow
                ? sendRow.title
                : draft
                  ? `Save: ${firstLine(draft, 100)}`
                  : "New note"
            }
            subtitle={
              sendRow
                ? sendRow.subtitle
                : draft
                  ? undefined
                  : "type above, ↵ saves · @name sends · ↵ now = long note"
            }
            accessories={[{ text: "↵" }]}
            actions={
              <ActionPanel>
                <Action
                  title={
                    sending ? "Send" : draft ? "Save to Telegram" : "New Note"
                  }
                  icon={sending ? Icon.Airplane : Icon.Upload}
                  onAction={composeEnter}
                />
                {target && chatUrl(target, meName) && (
                  <Action.Open
                    title={`Open Chat in ${transportLabel(target.transport)}`}
                    target={chatUrl(target, meName) as string}
                    shortcut={{ modifiers: ["cmd"], key: "t" }}
                  />
                )}
                {!sending && bulkActions}
                {consoleActions}
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      {sendReq?.mode === "pick" && (
        <List.Section title="Contacts">
          {matchContacts(sendReq.prefix).map(contactRow)}
        </List.Section>
      )}
      {sendReq?.mode === "unknown" && (
        <List.Section title="Contacts">
          {matchContacts(sendReq.key).map(contactRow)}
        </List.Section>
      )}
      {sending && sent.length > 0 && (
        <List.Section title="Sent" subtitle="this session">
          {sent.map(sentRow)}
        </List.Section>
      )}

      {!searching && !sending && pinned.length > 0 && (
        <List.Section title="Pinned" subtitle={String(pinned.length)}>
          {pinned.map((m) => renderItem(m, "pin"))}
        </List.Section>
      )}

      {sending ? null : searching && !query ? (
        <List.EmptyView
          icon={Icon.MagnifyingGlass}
          title="Search Saved Messages"
          description="Type after the slash, e.g. /invoice — searches all of Saved on Telegram, not just what's loaded"
        />
      ) : error && items.length === 0 ? (
        <List.EmptyView
          icon={Icon.ExclamationMark}
          title="tgs error"
          description={error}
        />
      ) : (searching ? results : items).length === 0 && !loading && !draft ? (
        <List.EmptyView
          icon={Icon.Message}
          title={searching ? "No matches" : "Nothing saved yet"}
          description={searching ? "" : "Type a note and press ↵"}
        />
      ) : draft ? (
        <List.Section
          title={
            composeMatches.length ? "Matches" : "No matches — ↵ saves as new"
          }
          subtitle={
            composeMatches.length ? String(composeMatches.length) : undefined
          }
        >
          {composeMatches.map((m) => renderItem(m))}
        </List.Section>
      ) : (
        <List.Section
          title={searching ? `Results for "${query}"` : "Saved"}
          subtitle={
            searching
              ? undefined
              : `${items.length}${hasMore ? "+" : ""}${marked.size ? ` · ${marked.size} selected` : ""}`
          }
        >
          {(searching ? results : items).map((m) => renderItem(m))}
        </List.Section>
      )}
    </List>
  );
}
