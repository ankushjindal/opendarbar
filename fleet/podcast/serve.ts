// serve — the Darbar Reading feed's public files, with an access log.
//
// Tailscale Funnel mounts /pod-<token> -> http://127.0.0.1:3490. Funnel's own
// directory server keeps no log, which left "the episode won't play" with
// nothing to look at; this answers the same files (Range-aware, which iOS needs
// for audio) and writes one line per request to ~/kai/state/podcast/access.log.
// The token never reaches the log: paths are logged relative to the mount.

import { appendFileSync, statSync } from "fs";
import { join, normalize } from "path";

const PUB = "/home/owner/kai/state/podcast/public";
const LOG = "/home/owner/kai/state/podcast/access.log";
const PORT = Number(process.env.PODCAST_PORT || 3490);
const TYPES: Record<string, string> = { xml: "application/rss+xml; charset=utf-8", mp3: "audio/mpeg", jpg: "image/jpeg" };

function log(req: Request, rel: string, status: number, range: string) {
  const ua = (req.headers.get("user-agent") || "-").slice(0, 120);
  const ip = req.headers.get("x-forwarded-for") || "-";
  appendFileSync(LOG, `${new Date().toISOString()} ${req.method} ${rel} ${status} ${range || "-"} ip=${ip} ua="${ua}"\n`);
}

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    let p = decodeURIComponent(new URL(req.url).pathname).replace(/^\/pod-[A-Za-z0-9]+/, "");
    const rel = normalize(p).replace(/^(\.\.(\/|$))+/, "");
    const ext = rel.split(".").pop() || "";
    const range = req.headers.get("range") || "";
    if (!TYPES[ext] || rel.includes("/.") || !/^\/(feed\.xml|cover\.jpg|ep\/[0-9a-f]{12}\.mp3)$/.test(rel)) {
      log(req, rel, 404, range); return new Response("not found", { status: 404 });
    }
    const abs = join(PUB, rel);
    let size = 0;
    try { size = statSync(abs).size; } catch { log(req, rel, 404, range); return new Response("not found", { status: 404 }); }
    const head = { "Content-Type": TYPES[ext], "Accept-Ranges": "bytes", "Cache-Control": ext === "xml" ? "no-cache" : "public, max-age=86400" };
    const m = range.match(/^bytes=(\d*)-(\d*)$/);
    if (m && (m[1] || m[2])) {
      let start = m[1] ? +m[1] : Math.max(0, size - +m[2]);
      let end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
      if (start >= size || start > end) {
        log(req, rel, 416, range);
        return new Response(null, { status: 416, headers: { ...head, "Content-Range": `bytes */${size}` } });
      }
      log(req, rel, 206, range);
      return new Response(req.method === "HEAD" ? null : Bun.file(abs).slice(start, end + 1), {
        status: 206, headers: { ...head, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
      });
    }
    log(req, rel, 200, range);
    return new Response(req.method === "HEAD" ? null : Bun.file(abs), { headers: { ...head, "Content-Length": String(size) } });
  },
});
console.log(`podcast serve on 127.0.0.1:${PORT}`);
