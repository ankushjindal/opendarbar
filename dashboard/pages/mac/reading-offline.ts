// Everything /reading needs to work with the network off.
//
//   GET /reading/static/<file>?v=<hash>   the chrome: CSS, page scripts
//   GET /reading/sw.js                    the service worker, scoped to /reading
//   GET /reading/manifest.webmanifest     so Add to Home Screen gives an app
//   GET /reading/img?u=<url>              an allowlisted remote image, same-origin
//
// Why the chrome hangs off /reading rather than /static: a worker can only
// intercept inside its own scope, and /reading is the scope. Chrome served from
// /static would be uncacheable by the worker and the offline page would come up
// naked. The hash in the query string is what lets it be cached for a year.

import { createHash } from "crypto";
import { readFile, stat } from "fs/promises";
import { baseLog } from "../../lib/log";

// The chrome, by the name it is served under. Also the precache list: the
// worker takes all of it on install, so a cold offline start has everything.
//
// dashboard.css is the dashboard's own sheet, served a second time from inside
// the scope. It carries the font stack and the .md renderer that the reading
// pages build on, and a copy at /static/ is a copy the worker can never reach.
const FILES: Record<string, string> = {
  "dashboard.css": "./static/style.css",
  "reading.css": "./static/reading/reading.css",
  "list.css": "./static/reading/list.css",
  "reader.css": "./static/reading/reader.css",
  "save.css": "./static/reading/save.css",
  "common.js": "./static/reading/common.js",
  "settings.js": "./static/reading/settings.js",
  "sentences.js": "./static/reading/sentences.js",
  "list.js": "./static/reading/list.js",
  "reader.js": "./static/reading/reader.js",
  "wait.js": "./static/reading/wait.js",
};

export const CHROME = Object.keys(FILES);

// A hash per file, recomputed only when the file's mtime moves, so editing a
// stylesheet during a session is picked up without a restart and a steady
// server pays one stat per request.
const seen = new Map<string, { mtime: number; hash: string }>();

async function hashOf(name: string): Promise<string> {
  const path = FILES[name];
  if (!path) return "0";
  try {
    const s = await stat(path);
    const was = seen.get(name);
    if (was && was.mtime === s.mtimeMs) return was.hash;
    const hash = createHash("sha256").update(await readFile(path)).digest("hex").slice(0, 10);
    seen.set(name, { mtime: s.mtimeMs, hash });
    return hash;
  } catch {
    return "0";
  }
}

export async function chromeUrl(name: string): Promise<string> {
  return `/reading/static/${name}?v=${await hashOf(name)}`;
}

// One stamp over the whole chrome. It names the worker's shell cache, so any
// change to any of these files retires the old one on the next activation.
export async function buildId(): Promise<string> {
  const parts = await Promise.all(CHROME.map(hashOf));
  return createHash("sha256").update(parts.join(" ")).digest("hex").slice(0, 10);
}

const TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml",
  webmanifest: "application/manifest+json",
};

// GET /reading/static/<file>. The name has to be one of the chrome's, so this
// route can never be walked anywhere. A request that carries the hash gets a
// year; one that does not (a hand-typed address) gets nothing, so a stale URL
// can never be pinned.
export async function readingStatic(url: URL): Promise<Response> {
  const name = url.pathname.slice("/reading/static/".length);
  if (!Object.prototype.hasOwnProperty.call(FILES, name)) {
    return new Response("Not found", { status: 404 });
  }
  const file = Bun.file(FILES[name]);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  const type = TYPES[name.split(".").pop() || ""] || "application/octet-stream";
  return new Response(file, {
    headers: {
      "Content-Type": type,
      "Cache-Control": url.searchParams.has("v")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    },
  });
}

// GET /reading/sw.js. Two placeholders are filled in here rather than in the
// file, so the worker's source stays a file the parser can read on its own.
// Service-Worker-Allowed widens the scope from /reading/ (the script's own
// directory) to /reading, which is where the list actually lives.
export async function readingSw(): Promise<Response> {
  let src: string;
  try { src = await readFile("./static/reading/sw.js", "utf8"); }
  catch (e) { baseLog.error("reading/sw.js:", e); return new Response("Not found", { status: 404 }); }
  const urls = await Promise.all(CHROME.map(chromeUrl));
  urls.push("/reading/manifest.webmanifest");
  const body = src
    .replace('"__RL_BUILD__"', JSON.stringify(await buildId()))
    .replace('["__RL_PRECACHE__"]', JSON.stringify(urls));
  return new Response(body, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
      "Service-Worker-Allowed": "/reading",
    },
  });
}

// The paper ground and the dog-ear, so the installed app opens in Flexoki
// rather than in a white flash.
const MANIFEST = {
  name: "Reading",
  short_name: "Reading",
  description: "the owner's read-later queue.",
  start_url: "/reading",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  background_color: "#FFFCF0",
  theme_color: "#FFFCF0",
  icons: [
    { src: "/static/reading-icon-180.png", sizes: "180x180", type: "image/png" },
    { src: "/static/reading-icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/static/reading-icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

export function readingManifest(): Response {
  return Response.json(MANIFEST, {
    headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=3600" },
  });
}

// ── the image proxy ──────────────────────────────────────────────────────────
// A tweet's photos are on pbs.twimg.com and two articles pull theirs off
// Substack's CDN. Fetched cross-origin they can only ever be cached opaquely,
// and an opaque response is billed against the origin's quota at several
// megabytes each whatever its real size. Coming back through here they are
// ordinary same-origin responses the worker can hold, count and evict.
//
// An allowlist and nothing else: this is a fetch-anything hole otherwise, on a
// dashboard whose other routes are effectively code execution.
const IMG_HOSTS = new Set([
  "pbs.twimg.com",
  "substackcdn.com",
  "substack-post-media.s3.amazonaws.com",
  "bucketeer-e05bbc84-baa3-437e-9518-adb32be77984.s3.amazonaws.com",
  "i.ytimg.com",
  "img.youtube.com",
  "www.youtube.com",
  "www.anthropic.com",
  "www-cdn.anthropic.com",
]);

export function proxiedImage(src: string): string | null {
  try {
    const u = new URL(src);
    if (u.protocol !== "https:") return null;
    if (!IMG_HOSTS.has(u.hostname)) return null;
    return `/reading/img?u=${encodeURIComponent(u.toString())}`;
  } catch {
    return null;
  }
}

// Rewrite the <img src> of a rendered body. Same-origin figures (/reading/asset)
// and anything off the allowlist are left exactly as they were.
export function proxyImages(html: string): string {
  return html.replace(/(<img\b[^>]*?\bsrc=")([^"]+)(")/gi, (whole, head, src, tail) => {
    const via = proxiedImage(src);
    return via ? head + via + tail : whole;
  });
}

const IMG_CAP = 5 * 1024 * 1024;
const IMG_TIMEOUT_MS = 12_000;

export async function readingImg(url: URL): Promise<Response> {
  const raw = url.searchParams.get("u") || "";
  let target: URL;
  try { target = new URL(raw); } catch { return new Response("Bad url", { status: 400 }); }
  if (target.protocol !== "https:" || !IMG_HOSTS.has(target.hostname)) {
    return new Response("Not allowed", { status: 403 });
  }
  try {
    const res = await fetch(target, {
      headers: { Accept: "image/*", "User-Agent": "Mozilla/5.0 (Macintosh) reading-dashboard" },
      redirect: "follow",
      signal: AbortSignal.timeout(IMG_TIMEOUT_MS),
    });
    if (!res.ok) return new Response("Upstream said no", { status: 502 });
    const type = res.headers.get("content-type") || "";
    if (!type.startsWith("image/")) return new Response("Not an image", { status: 415 });
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > IMG_CAP) return new Response("Too big", { status: 413 });
    const body = await res.arrayBuffer();
    if (body.byteLength > IMG_CAP) return new Response("Too big", { status: 413 });
    return new Response(body, {
      headers: {
        "Content-Type": type.split(";")[0],
        "Content-Length": String(body.byteLength),
        // The address carries the remote one, which never changes under it.
        "Cache-Control": "public, max-age=2592000, immutable",
      },
    });
  } catch (e: any) {
    baseLog.error("reading/img:", e?.message || e);
    return new Response("Could not fetch it", { status: 502 });
  }
}
