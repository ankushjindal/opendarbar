// The reading list, offline. Scope /reading, registered only over https —
// Safari will not run a worker on the plain-http Tailscale address, so that
// origin simply has no offline copy and everything here is absent rather than
// half-working.
//
// Two lines are filled in by the server when it serves this file: the build
// stamp (a hash of the chrome) and the list of chrome URLs to precache. That is
// what makes a chrome change roll the shell cache without a hand-edited version
// number.
const BUILD = "__RL_BUILD__";
const PRECACHE = ["__RL_PRECACHE__"];

// Cache names carry a schema version as well as the build. SHELL is rebuilt
// whenever the chrome changes; the other three survive a deploy, because the
// pages and the figures in them are the same pages and figures. Bump V when the
// shape of what is stored changes and the old ones have to go.
const V = 1;
const SHELL = "rl-shell-v" + V + "-" + BUILD;
const PAGES = "rl-pages-v" + V;
const MEDIA = "rl-media-v" + V;
const KEEP = "rl-keep-v" + V;
const MINE = [SHELL, PAGES, MEDIA, KEEP];

const STAMP = "x-rl-cached-at";

// Pages and figures are the two things worth a lot of room; a kept PDF is
// deliberate. Nothing here is allowed to grow without an answer.
const MAX_PAGES = 400;

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n.startsWith("rl-") && MINE.indexOf(n) < 0).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

// ── what a page is filed under ───────────────────────────────────────────────
// The list ignores every query key but theme, and rewrites its own address as
// the chips move, so /reading?kind=video and /reading?t=17... are the same
// document and get one entry. A reader page is its file and nothing else.
function pageKey(u) {
  let url;
  // The page hands over relative addresses; the fetch handler absolute ones.
  try { url = new URL(u, self.location.origin); } catch (e) { return null; }
  if (url.origin !== self.location.origin) return null;
  if (url.pathname === "/reading") return url.origin + "/reading";
  if (url.pathname === "/reading/item") {
    const f = url.searchParams.get("f");
    return f ? url.origin + "/reading/item?f=" + encodeURIComponent(f) : null;
  }
  return null;
}

// A cached copy has to be able to say when it was taken, and Date is the
// server's clock rather than ours. Restamp on the way in.
async function stamp(res) {
  const body = await res.clone().arrayBuffer();
  const h = new Headers(res.headers);
  h.set(STAMP, new Date().toISOString());
  return new Response(body, { status: res.status, statusText: res.statusText, headers: h });
}

async function trimPages() {
  const c = await caches.open(PAGES);
  const keys = await c.keys();
  if (keys.length <= MAX_PAGES) return;
  for (const k of keys.slice(0, keys.length - MAX_PAGES)) await c.delete(k);
}

// ── the strategies ───────────────────────────────────────────────────────────

// Show what we have, ask the network anyway, and say so if the answer differs.
// The page is what the list and the reader both are, so this is where the whole
// queue comes from on a train.
async function swrPage(event) {
  const key = pageKey(event.request.url);
  const cache = await caches.open(PAGES);
  const hit = key ? await cache.match(key) : null;
  // Cloned now, not later: handing `hit` to the page consumes its body, and the
  // comparison below runs after that. A clone taken before the handover is the
  // only copy still readable when the network answers.
  const kept = hit ? hit.clone() : null;

  const refresh = fetch(event.request).then(async (res) => {
    if (!res || !res.ok || !key) return res;
    const before = kept ? await kept.text() : null;
    const after = await res.clone().text();
    await cache.put(key, await stamp(res.clone()));
    trimPages();
    offline.delete(key);
    if (before !== null && before !== after) tell({ type: "fresh", url: key });
    return res;
  }).catch((e) => {
    if (key) offline.add(key);
    throw e;
  });

  // The page asks where it came from the moment it runs, which is while this
  // is still in the air. Park it so that question can wait for the answer
  // rather than reporting the last one.
  if (key) {
    const settled = refresh.then(() => {}, () => {});
    pending.set(key, settled);
    settled.then(() => { if (pending.get(key) === settled) pending.delete(key); });
  }

  if (hit) { event.waitUntil(refresh.catch(() => {})); return hit; }
  return refresh;
}

// Cache first, for things that never change under their address: the chrome
// (hashed), a figure, a thumbnail, a proxied image.
async function cacheFirst(cacheName, request) {
  const c = await caches.open(cacheName);
  const hit = await c.match(request, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (res && res.ok && res.status === 200) c.put(request, await stamp(res.clone()));
  return res;
}

// A kept PDF or a kept MP3. Nothing is stored here unless the reader asked for
// it by name, and the whole file is stored, so a Range request — which is how
// every <audio> element asks — is answered by slicing what we have.
async function keptOrNetwork(request) {
  const c = await caches.open(KEEP);
  const hit = await c.match(keepKey(request.url), { ignoreVary: true });
  if (!hit) return fetch(request);
  const range = request.headers.get("range");
  const m = range && range.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return hit;
  const buf = await hit.arrayBuffer();
  const size = buf.byteLength;
  let start, end;
  if (m[1] === "") { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start >= size || start > end) {
    return new Response("Range not satisfiable", { status: 416, headers: { "Content-Range": "bytes */" + size } });
  }
  const h = new Headers(hit.headers);
  h.set("Content-Range", "bytes " + start + "-" + end + "/" + size);
  h.set("Content-Length", String(end - start + 1));
  h.set("Accept-Ranges", "bytes");
  return new Response(buf.slice(start, end + 1), { status: 206, statusText: "Partial Content", headers: h });
}

// download=1 is the same bytes with a different Content-Disposition; one entry.
function keepKey(u) {
  const url = new URL(u);
  url.searchParams.delete("download");
  return url.toString();
}

const offline = new Set();
const pending = new Map();

function tell(msg) {
  self.clients.matchAll({ type: "window" }).then((cs) => cs.forEach((c) => c.postMessage(msg)));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;

  // The writes and the capture script are never anything but live.
  if (p.startsWith("/api/reading/") || p === "/reading/add") return;

  if (req.mode === "navigate" && (p === "/reading" || p === "/reading/item")) {
    event.respondWith(swrPage(event));
    return;
  }
  if (p.startsWith("/reading/static/") || p === "/reading/manifest.webmanifest") {
    event.respondWith(cacheFirst(SHELL, req));
    return;
  }
  if (p === "/reading/asset" || p === "/reading/thumb" || p === "/reading/img" || p === "/reading/icon.svg") {
    event.respondWith(cacheFirst(MEDIA, req));
    return;
  }
  if (p === "/reading/file" || p === "/reading/audio" || p === "/reading/audio/cues") {
    event.respondWith(keptOrNetwork(req));
    return;
  }
});

// ── what the page asks ───────────────────────────────────────────────────────

async function cacheSize(name) {
  const c = await caches.open(name);
  const keys = await c.keys();
  let bytes = 0, newest = "";
  for (const k of keys) {
    const r = await c.match(k);
    if (!r) continue;
    const len = Number(r.headers.get("content-length") || 0);
    bytes += len || (await r.clone().blob()).size;
    const at = r.headers.get(STAMP) || "";
    if (at > newest) newest = at;
  }
  return { bytes, count: keys.length, newest };
}

// One at a time and never while a tap is waiting: warming is a background
// errand, not a download manager.
// A page warmed by fetching has no DOM, so nothing asks for its pictures. A
// tweet without its photo is half a tweet, so they are read out of the markup
// and fetched too — the same handful the browser would have asked for, capped
// so one figure-heavy document cannot take the whole errand.
const MAX_WARM_IMAGES = 8;

async function warmImages(html) {
  const c = await caches.open(MEDIA);
  const srcs = [];
  const re = /<img\b[^>]*?\bsrc="(\/reading\/(?:img|asset|thumb)\?[^"]+)"/gi;
  let m;
  while ((m = re.exec(html)) && srcs.length < MAX_WARM_IMAGES) {
    const href = m[1].replace(/&amp;/g, "&");
    if (srcs.indexOf(href) < 0) srcs.push(href);
  }
  for (const src of srcs) {
    const req = new Request(src, { credentials: "same-origin" });
    if (await c.match(req, { ignoreVary: true })) continue;
    try {
      const res = await fetch(req);
      if (res && res.ok) await c.put(req, await stamp(res));
    } catch (e) { return; }
  }
}

async function warm(urls) {
  let added = 0;
  const c = await caches.open(PAGES);
  for (const u of urls) {
    const key = pageKey(u);
    if (!key) continue;
    if (await c.match(key)) continue;
    try {
      const res = await fetch(key, { credentials: "same-origin" });
      if (!res || !res.ok) continue;
      const copy = await stamp(res);
      await c.put(key, copy.clone());
      added++;
      await warmImages(await copy.text());
    } catch (e) { break; }   // the network went away; stop asking
  }
  trimPages();
  return { added };
}

async function keepFiles(urls) {
  const c = await caches.open(KEEP);
  let bytes = 0;
  for (const u of urls) {
    const key = keepKey(new URL(u, self.location.origin).toString());
    try {
      const res = await fetch(key, { credentials: "same-origin" });
      if (!res || !res.ok) continue;
      const stamped = await stamp(res);
      bytes += (await stamped.clone().blob()).size;
      await c.put(key, stamped);
    } catch (e) { return { ok: false, bytes: 0, message: "Could not fetch it." }; }
  }
  return { ok: true, bytes };
}

async function keptBytes(urls) {
  const c = await caches.open(KEEP);
  let bytes = 0, n = 0;
  for (const u of urls || []) {
    const r = await c.match(keepKey(new URL(u, self.location.origin).toString()), { ignoreVary: true });
    if (!r) continue;
    n++;
    bytes += (await r.clone().blob()).size;
  }
  return { kept: n > 0 && n === (urls || []).length, some: n > 0, bytes };
}

self.addEventListener("message", (event) => {
  const d = event.data || {};
  // Every question gets an answer, including a broken one. A handler that threw
  // used to leave the page waiting on a port that would never speak again.
  const reply = (x) => { if (event.ports && event.ports[0]) event.ports[0].postMessage(x); };
  const answer = (p) => event.waitUntil(
    Promise.resolve().then(p).then(reply, (e) => reply({ error: String((e && e.message) || e) }))
  );

  if (d.type === "nav-status") {
    answer(async () => {
      const key = pageKey(d.url);
      if (!key) return { cached: false };
      if (pending.has(key)) await pending.get(key);
      const c = await caches.open(PAGES);
      const r = await c.match(key);
      return {
        cached: Boolean(r),
        cachedAt: r ? (r.headers.get(STAMP) || r.headers.get("date") || "") : "",
        offline: offline.has(key) || self.navigator.onLine === false,
      };
    });
    return;
  }

  if (d.type === "warm") { answer(() => warm(d.urls || [])); return; }
  if (d.type === "keep") { answer(() => keepFiles(d.urls || [])); return; }
  if (d.type === "kept") { answer(() => keptBytes(d.urls)); return; }

  if (d.type === "unkeep") {
    answer(async () => {
      const c = await caches.open(KEEP);
      for (const u of d.urls || []) await c.delete(keepKey(new URL(u, self.location.origin).toString()));
      return { ok: true, bytes: 0 };
    });
    return;
  }

  // Written elsewhere since this copy was taken: throw it away and fetch again,
  // so the next visit is not the state before the change.
  if (d.type === "refresh") {
    answer(async () => {
      const c = await caches.open(PAGES);
      for (const u of d.urls || []) {
        const key = pageKey(u);
        if (!key) continue;
        await c.delete(key);
        try {
          const res = await fetch(key, { credentials: "same-origin" });
          if (res && res.ok) await c.put(key, await stamp(res));
        } catch (e) {}
      }
      return { ok: true };
    });
    return;
  }

  if (d.type === "storage") {
    answer(async () => {
      const [shell, pages, media, keep] = await Promise.all(
        [SHELL, PAGES, MEDIA, KEEP].map(cacheSize)
      );
      return {
        bytes: shell.bytes + pages.bytes + media.bytes + keep.bytes,
        pages: pages.count,
        figures: media.count,
        keptBytes: keep.bytes,
        keptFiles: keep.count,
        updated: pages.newest || shell.newest,
        build: BUILD,
      };
    });
  }
});
