// podcast-sync — the Mac reading queue's rendered audio as a private podcast feed.
//
// The Mac dashboard is the only process allowed to read the vault (TCC blocks
// even ssh from ~/Downloads), so server pulls over the tailnet:
//   GET  http://<mac>:3456/api/reading/list                     the queue
//   GET  http://<mac>:3456/api/reading/audio/state?f=<note>     saved renderings
//   GET  http://<mac>:3456/reading/audio?f=<stem>.<voice>.mp3   the audio
// and writes ~/kai/state/podcast/public/{feed.xml,cover.jpg,ep/<id>.mp3}, which
// Tailscale Funnel serves at https://server.TAILNET.ts.net/pod-<token>/.
// The token (~/kai/state/podcast/token, 0600) is the only key; never log it.
//
// An episode = an unread item (not read/skipped) with a saved, non-partial
// rendering. Marking an item read on the reading page drops it next sync.
// pubDate is the item's `added` time and guid is a hash of the note's file
// name, both stable, so podcast apps never see a re-added episode as new.
//
//   bun podcast-sync.ts            sync, print one summary line (JSON with --json)
//   bun podcast-sync.ts --dry-run  say what would change, touch nothing
//   bun podcast-sync.ts --daily    what the timer runs: hourly 12:00-18:00 IST,
//                                  a no-op once a sync has succeeded since 12:00
//                                  IST today (so a sleeping Mac just means a
//                                  later run, and a button press after noon
//                                  counts as the day's sync)

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, unlinkSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";

const MAC = process.env.PODCAST_MAC || "http://100.64.0.2:3456";
const DIR = "/home/owner/kai/state/podcast";
const PUB = join(DIR, "public"), EP = join(PUB, "ep");
const HOST = "https://server.TAILNET.ts.net";
const DRY = process.argv.includes("--dry-run"), JSON_OUT = process.argv.includes("--json");
const SKIP_KINDS = new Set(["tweet"]); // tweets get a digest later, not one episode each

const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unent = (s: string) => String(s ?? "").replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const hms = (s: number) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, Math.round(s) % 60].map((n) => String(n).padStart(2, "0")).join(":");
const idOf = (file: string) => createHash("sha1").update(file).digest("hex").slice(0, 12);

async function getJson(path: string): Promise<any> {
  const r = await fetch(MAC + path, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${path.split("?")[0]} -> HTTP ${r.status}`);
  return r.json();
}

export interface SyncResult { ok: boolean; episodes: number; added: string[]; removed: string[]; error?: string; at: string }

export async function sync(): Promise<SyncResult> {
  const at = new Date().toISOString();
  const token = readFileSync(join(DIR, "token"), "utf8").trim();
  const BASE = `${HOST}/pod-${token}`;
  let list: any[];
  try { list = (await getJson("/api/reading/list")).items; }
  catch (e: any) { return { ok: false, episodes: 0, added: [], removed: [], error: `Mac unreachable: ${e.message}`, at }; }

  const queue = list.filter((n) => n.status !== "read" && n.status !== "skipped" && !SKIP_KINDS.has(n.kind));
  const eps: { id: string; n: any; s: any }[] = [];
  for (const n of queue) {
    const st = await getJson(`/api/reading/audio/state?f=${encodeURIComponent(n.file)}`).catch(() => null);
    const saved = (st?.saved || []).filter((s: any) => !s.partial && s.url);
    if (!saved.length) continue;
    eps.push({ id: idOf(n.file), n, s: saved[0] });
  }

  mkdirSync(EP, { recursive: true });
  const have = new Set(readdirSync(EP).filter((f) => f.endsWith(".mp3")).map((f) => f.slice(0, -4)));
  const want = new Set(eps.map((e) => e.id));
  const added: string[] = [], removed: string[] = [];
  for (const e of eps) {
    if (have.has(e.id)) continue;
    added.push(unent(e.n.title));
    if (DRY) continue;
    const r = await fetch(MAC + e.s.url, { signal: AbortSignal.timeout(600_000) });
    if (!r.ok) throw new Error(`audio for ${e.n.file} -> HTTP ${r.status}`);
    const tmp = join(EP, `.${e.id}.part`);
    await Bun.write(tmp, r);
    renameSync(tmp, join(EP, `${e.id}.mp3`));
  }
  for (const id of have) if (!want.has(id)) { removed.push(id); if (!DRY) unlinkSync(join(EP, `${id}.mp3`)); }

  const items = eps.filter((e) => DRY || existsSync(join(EP, `${e.id}.mp3`))).map(({ id, n, s }) => {
    const size = DRY ? 0 : statSync(join(EP, `${id}.mp3`)).size;
    const added = Date.parse(n.added || n.clipped || "") || Date.now();
    const meta = [n.site, n.author, n.tags?.length ? n.tags.join(", ") : ""].filter(Boolean).join(" · ");
    const desc = `${meta}\n\n${n.source || ""}`;
    return `  <item>
    <title>${esc(unent(n.title || n.file.replace(/\.md$/, "")))}</title>
    <guid isPermaLink="false">darbar-${id}</guid>
    <pubDate>${new Date(added).toUTCString()}</pubDate>
    <enclosure url="${BASE}/ep/${id}.mp3" length="${size}" type="audio/mpeg"/>
    <itunes:duration>${hms(s.seconds || 0)}</itunes:duration>
    <description>${esc(desc)}</description>
    <link>${esc(n.source || "")}</link>
  </item>`;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title>Darbar Reading</title>
  <link>${BASE}/feed.xml</link>
  <language>en</language>
  <description>the owner's reading queue, read aloud. Private feed.</description>
  <itunes:author>KushDarbar</itunes:author>
  <itunes:image href="${BASE}/cover.jpg"/>
  <image><url>${BASE}/cover.jpg</url><title>Darbar Reading</title><link>${BASE}/feed.xml</link></image>
  <itunes:category text="Education"/>
  <itunes:explicit>false</itunes:explicit>
  <itunes:block>Yes</itunes:block>
  <itunes:type>episodic</itunes:type>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items.join("\n")}
</channel>
</rss>
`;
  if (!DRY) {
    writeFileSync(join(PUB, ".feed.xml.part"), xml);
    renameSync(join(PUB, ".feed.xml.part"), join(PUB, "feed.xml"));
    writeFileSync(join(DIR, "last-sync.json"), JSON.stringify({ at, episodes: eps.length, added, removed }, null, 2));
  }
  return { ok: true, episodes: eps.length, added, removed, at };
}

// Today's 12:00 IST (06:30 UTC) as epoch ms.
function noonIstToday(): number {
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 6, 30);
}

if (import.meta.main) {
  if (process.argv.includes("--daily")) {
    try {
      const last = JSON.parse(readFileSync(join(DIR, "last-sync.json"), "utf8"));
      if (Date.parse(last.at) >= noonIstToday()) { console.log(`already synced today (${last.at})`); process.exit(0); }
    } catch {}
  }
  const r = await sync().catch((e: any) => ({ ok: false, episodes: 0, added: [], removed: [], error: e.message, at: new Date().toISOString() }) as SyncResult);
  if (JSON_OUT) console.log(JSON.stringify(r));
  else console.log(r.ok ? `${DRY ? "[dry] " : ""}${r.episodes} episodes, +${r.added.length} -${r.removed.length}${r.added.length ? " (" + r.added.join("; ") + ")" : ""}` : `FAILED: ${r.error}`);
  process.exit(r.ok ? 0 : 1);
}
