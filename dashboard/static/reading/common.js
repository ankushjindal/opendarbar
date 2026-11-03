// Chrome shared by every reading page: the theme switch, the ? overlay, and
// the whole of the offline story — registering the worker, saying when what you
// are looking at came out of the cache, warming the queue, keeping a file, and
// reporting what all of that costs.
//
// Plain globals on purpose. list.js and reader.js each run one IIFE that reads
// keysEl and typing() the way they did when this was inline in the page.

// ── theme ────────────────────────────────────────────────────────────────────
var themeBtn = document.getElementById("rl-theme");
if (themeBtn) {
  themeBtn.addEventListener("click", function () {
    var root = document.documentElement;
    var now = root.dataset.theme
      || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    var next = now === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem("rl-theme", next); } catch (e) {}
  });
}

// ── the ? overlay ────────────────────────────────────────────────────────────
// ? opens it, ? or Esc or a tap outside closes it, and it never fires while you
// are typing. The waiting page has no overlay, hence the guards.
var keysEl = document.getElementById("rl-keys");
function typing(e) {
  var t = e.target;
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}
function keysOpen(on) {
  if (!keysEl) return;
  keysEl.classList.toggle("on", on);
  if (on) rlStorageReport();
}
if (keysEl) {
  keysEl.addEventListener("click", function (e) { if (e.target === keysEl) keysOpen(false); });
}

// ── offline ──────────────────────────────────────────────────────────────────
// Safari refuses a worker over plain http, so on the Tailscale IP there is
// simply no offline copy and every call below is a no-op that resolves null.
// Over https://laptop.TAILNET.ts.net:8443 the same pages get one.

function rlOnline() { return navigator.onLine !== false; }

// navigator.onLine is the cheap answer and it lies: a laptop on a captive
// portal, or a phone whose radio came back before the tunnel did, both say
// true. A fetch that rejects rather than answering is the honest one — the
// browser throws a TypeError for a connection it could not make at all,
// which is exactly and only the case worth calling offline.
var RL_OFFLINE_MSG = "Offline. That change needs the Mac.";
function rlNetworkError(e) {
  if (!e) return false;
  if (e.name === "TypeError") return true;
  return /failed to fetch|load failed|networkerror|connection/i.test(String(e.message || e));
}

// One line under the header, on both pages, composed from three facts that can
// all be true at once: you are reading a cached copy, a newer one has arrived,
// and some of your changes are still waiting to be sent.
var rlWhere = { offline: "", fresh: false, note: "" };

function rlRender() {
  var el = document.getElementById("rl-net");
  if (!el) return;
  var bits = [];
  if (rlWhere.offline) bits.push(rlWhere.offline);
  var q = rlQueueLine();
  if (q) bits.push(q);
  if (rlWhere.note) bits.push(rlWhere.note);
  if (rlWhere.fresh) bits.push("A newer copy is ready. <u>Reload</u>.");
  if (!bits.length) {
    el.hidden = true; el.textContent = ""; el.onclick = null;
    el.classList.remove("rl-net-act");
    return;
  }
  el.innerHTML = bits.join(" ");
  el.hidden = false;
  // Two things the line can be tapped for, and never both at once: take the
  // newer copy, or throw away a change the server refused three times. A
  // refusal has to be dismissable by hand — it is never retried again, and a
  // line he cannot clear is a line he stops reading.
  var stuck = rlPending.filter(function (r) { return r.stuck; });
  var act = null;
  if (rlWhere.fresh) {
    act = function () { location.reload(); };
  } else if (stuck.length) {
    el.innerHTML = el.innerHTML + " <u>Discard</u>.";
    act = function () {
      rlQueueDrop(stuck.map(function (r) { return r.id; })).then(rlQueueRefresh);
    };
  }
  el.classList.toggle("rl-net-act", Boolean(act));
  el.onclick = act;
}

// A one-off sentence that is not one of the three standing facts: a refusal,
// mostly. It clears itself so the line goes back to the truth.
function rlSay(text) {
  rlWhere.note = text || "";
  rlRender();
  if (text) setTimeout(function () {
    if (rlWhere.note === text) { rlWhere.note = ""; rlRender(); }
  }, 6000);
}

function rlClock(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function rlBytes(n) {
  if (!n) return "0 KB";
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(1) + " GB";
}

// The worker this page should talk to. controller is null on the very first
// load after a registration, so fall back to the active worker the
// registration hands over; either one answers the same messages.
var rlWorkerP = null;
function rlWorker() {
  if (rlWorkerP) return rlWorkerP;
  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    rlWorkerP = Promise.resolve(null);
    return rlWorkerP;
  }
  rlWorkerP = navigator.serviceWorker.ready.then(function (reg) {
    return navigator.serviceWorker.controller || reg.active || null;
  }).catch(function () { return null; });
  return rlWorkerP;
}

// Ask the worker something and get one answer back. A MessageChannel rather
// than a broadcast, so two questions in flight cannot read each other's reply.
function rlAsk(msg) {
  return rlWorker().then(function (sw) {
    if (!sw) return null;
    return new Promise(function (resolve) {
      var ch = new MessageChannel();
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve(null); } }, 6000);
      ch.port1.onmessage = function (e) {
        if (done) return;
        done = true; clearTimeout(timer);
        resolve(e.data);
      };
      try { sw.postMessage(msg, [ch.port2]); }
      catch (e) { done = true; clearTimeout(timer); resolve(null); }
    });
  });
}

// Where this page came from. The worker serves the cache first and refreshes
// behind it, so "cached" is the normal case and only "offline" is worth saying.
function rlNavStatus() {
  return rlAsk({ type: "nav-status", url: location.href }).then(function (r) {
    if (!r || !r.cached || !r.offline) return;
    rlWhere.offline = "Offline, showing the copy from " + (rlClock(r.cachedAt) || "earlier") + ".";
    rlRender();
  });
}

// The refresh behind the cached copy landed and it is not what you are reading.
function rlFresh() { rlWhere.fresh = true; rlRender(); }

// ── keeping a file ───────────────────────────────────────────────────────────
// PDFs and rendered audio are the two things big enough that caching every one
// of them would be rude. They are kept per item, on request.
function rlKept(urls) { return rlAsk({ type: "kept", urls: urls }); }
function rlKeep(urls) { return rlAsk({ type: "keep", urls: urls }); }
function rlUnkeep(urls) { return rlAsk({ type: "unkeep", urls: urls }); }

// ── warming ──────────────────────────────────────────────────────────────────
// The list hands over the reader pages worth having on the train. One at a
// time, when the browser says it is idle, so it never competes with a tap.
function rlWarm(urls) {
  if (!urls || !urls.length || !rlOnline()) return;
  var go = function () { rlAsk({ type: "warm", urls: urls }); };
  if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 8000 });
  else setTimeout(go, 3000);
}

// ── what it all costs ────────────────────────────────────────────────────────
function rlStorageReport() {
  var el = document.getElementById("rl-store");
  if (!el) return;
  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    el.textContent = "No offline copy here: a worker needs https. Open the tailnet https address for one.";
    return;
  }
  rlAsk({ type: "storage" }).then(function (r) {
    if (!r) { el.textContent = "Offline copy: not ready yet."; return; }
    var line = "Offline copy: " + rlBytes(r.bytes) + ", " + r.pages + " item"
      + (r.pages === 1 ? "" : "s")
      + (r.updated ? ", updated " + rlClock(r.updated) : "") + ".";
    if (r.keptBytes) line += " Kept files: " + rlBytes(r.keptBytes) + ".";
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (est) {
        el.textContent = line + (est && est.quota
          ? " Browser quota " + rlBytes(est.quota) + ", " + rlBytes(est.usage || 0) + " used."
          : "");
      }, function () { el.textContent = line; });
    } else {
      el.textContent = line;
    }
  });
}

// ── registration ─────────────────────────────────────────────────────────────
// Only over https, and only ever at /reading: the rest of the dashboard is not
// a reading surface and has no business being taken over by a worker.
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.addEventListener("message", function (e) {
    var d = e.data || {};
    if (d.type === "fresh" && d.url && d.url.indexOf(location.pathname) >= 0) rlFresh();
  });
  navigator.serviceWorker.register("/reading/sw.js", { scope: "/reading" })
    .then(function () { return rlNavStatus(); })
    .catch(function () {});
} else if (!rlOnline()) {
  rlWhere.offline = "Offline.";
  rlRender();
}

window.addEventListener("online", function () {
  rlWhere.offline = "";
  rlRender();
  rlReplay();
});
window.addEventListener("offline", function () {
  rlWhere.offline = "Offline.";
  rlRender();
});

// ── the write queue ──────────────────────────────────────────────────────────
// A write that cannot reach the Mac is held here rather than lost. The page
// applies it at once and the note catches up when the network does.
//
// Conflicts are not resolved and do not need to be. Every one of these
// endpoints rewrites a single frontmatter key (or appends one line under
// ## Highlights / ## Notes) and leaves the rest of the file byte for byte, so
// two devices touching the same note usually touch different keys; where they
// touch the same key, the last writer wins, which for star or rating is the
// answer he would expect anyway. Nothing here tries to be cleverer than that.
//
// Schema v1. A change to the shape of a record bumps RL_DB_V and migrates in
// onupgradeneeded; records carry their own `v` too, so a replay can tell what
// it is looking at even if the store was written by an older page still open in
// another tab.
var RL_DB = "rl-queue";
var RL_DB_V = 1;
var RL_STORE = "writes";
var RL_MAX_TRIES = 3;

var rlDbP = null;
function rlDb() {
  if (rlDbP) return rlDbP;
  rlDbP = new Promise(function (resolve) {
    if (!window.indexedDB) { resolve(null); return; }
    var req;
    try { req = indexedDB.open(RL_DB, RL_DB_V); }
    catch (e) { resolve(null); return; }
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains(RL_STORE)) {
        db.createObjectStore(RL_STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { resolve(null); };
    req.onblocked = function () { resolve(null); };
  });
  return rlDbP;
}

function rlTx(mode, run) {
  return rlDb().then(function (db) {
    if (!db) return null;
    return new Promise(function (resolve) {
      var tx = db.transaction(RL_STORE, mode);
      var store = tx.objectStore(RL_STORE);
      var out = null;
      try { out = run(store); } catch (e) { resolve(null); return; }
      tx.oncomplete = function () {
        resolve(out && typeof out.result !== "undefined" ? out.result : null);
      };
      tx.onerror = function () { resolve(null); };
      tx.onabort = function () { resolve(null); };
    });
  });
}

var rlPending = [];          // what the line counts, refreshed after every change

function rlQueueLine() {
  if (!rlPending.length) return "";
  var stuck = rlPending.filter(function (r) { return r.stuck; });
  var live = rlPending.length - stuck.length;
  var out = "";
  if (live) out += live + " change" + (live === 1 ? "" : "s") + " waiting.";
  if (stuck.length) {
    out += (out ? " " : "") + stuck.length + " refused"
      + (stuck[0].error ? " (" + stuck[0].error + ")" : "") + ".";
  }
  return out;
}

// The page can watch the queue: the reader puts the same count in its bar.
var rlQueueWatchers = [];
function rlOnQueue(fn) { rlQueueWatchers.push(fn); fn(rlPending); }

function rlQueueRefresh() {
  return rlTx("readonly", function (s) { return s.getAll(); }).then(function (rows) {
    rlPending = rows || [];
    rlRender();
    rlQueueWatchers.forEach(function (fn) { try { fn(rlPending); } catch (e) {} });
    return rlPending;
  });
}

// Hold one write. `what` is only for the record: which of the endpoints it was,
// so a replay can collapse the ones worth collapsing.
function rlQueueAdd(path, body, what) {
  var rec = {
    v: 1, at: new Date().toISOString(),
    path: path, body: body, what: what || path,
    file: body && body.file ? body.file : "",
    tries: 0, error: "", stuck: false,
  };
  return rlTx("readwrite", function (s) { return s.add(rec); })
    .then(function () { return rlQueueRefresh(); })
    .then(function () { return rec; });
}

// Progress is the one write where only the last word matters, and the one that
// piles up: a long read offline can leave thirty of them. Keep the furthest per
// file and drop the rest before anything is sent.
// Progress is the one write where only the last word matters, and the one that
// piles up: a long read offline can leave thirty of them. Keep the furthest per
// file and drop the rest before anything is sent.
//
// Where the voice had got to piles up the same way, but "furthest" is the wrong
// rule for it — he is allowed to go back and listen to something again, and the
// note should say where he actually is. So that one keeps the last written
// rather than the largest.
function rlCollapse(rows) {
  var best = {}, last = {};
  rows.forEach(function (r) {
    if (r.what === "progress") {
      var p = r.body && Number(r.body.percent);
      if (!isFinite(p)) return;
      if (!best[r.file] || p > best[r.file].p) best[r.file] = { p: p, id: r.id };
      return;
    }
    if (r.what === "audio-at") last[r.file] = { id: r.id };
  });
  var drop = [];
  var keep = rows.filter(function (r) {
    var b = r.what === "progress" ? best[r.file] : r.what === "audio-at" ? last[r.file] : null;
    if (!b) return true;
    if (b.id === r.id) return true;
    drop.push(r.id);
    return false;
  });
  return { keep: keep, drop: drop };
}

function rlQueueDrop(ids) {
  if (!ids.length) return Promise.resolve(null);
  return rlTx("readwrite", function (s) { ids.forEach(function (id) { s.delete(id); }); });
}

function rlQueuePut(rec) {
  return rlTx("readwrite", function (s) { return s.put(rec); });
}

var rlReplaying = false;

// In order, one at a time, through the same endpoints the page uses. A network
// error means the Mac is still not there, so stop: the rest stay queued and the
// next `online` comes back for them. A refusal from the server is different —
// it is an answer, and an answer is kept with its reason rather than retried
// forever or dropped somewhere he cannot see it.
function rlReplay() {
  if (rlReplaying || !rlOnline()) return Promise.resolve(0);
  rlReplaying = true;
  var touched = {};
  var done = function (n) { rlReplaying = false; return n; };
  return rlQueueRefresh().then(function (rows) {
    var c = rlCollapse(rows);
    return rlQueueDrop(c.drop).then(function () { return c.keep; });
  }).then(function (rows) {
    var i = 0;
    function step() {
      if (i >= rows.length) return Promise.resolve();
      var rec = rows[i++];
      if (rec.stuck) return step();
      return fetch(rec.path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rec.body),
      }).then(function (r) {
        return r.json().catch(function () { return { ok: false, message: "HTTP " + r.status }; });
      }).then(function (j) {
        if (j && j.ok) {
          if (rec.file) touched[rec.file] = true;
          return rlQueueDrop([rec.id]).then(step);
        }
        rec.tries = (rec.tries || 0) + 1;
        rec.error = (j && j.message) || "refused";
        rec.stuck = rec.tries >= RL_MAX_TRIES;
        return rlQueuePut(rec).then(step);
      }, function (e) {
        if (rlNetworkError(e)) return Promise.resolve();   // still offline
        rec.tries = (rec.tries || 0) + 1;
        rec.error = String((e && e.message) || e);
        rec.stuck = rec.tries >= RL_MAX_TRIES;
        return rlQueuePut(rec).then(step);
      });
    }
    return step();
  }).then(function () {
    return rlQueueRefresh();
  }).then(function () {
    // The cached pages still say what the notes said before the replay. Throw
    // those away and take them again, or the next visit is the old state.
    var urls = Object.keys(touched).map(function (f) {
      return "/reading/item?f=" + encodeURIComponent(f);
    });
    if (!urls.length) return done(0);
    urls.push("/reading");
    return rlAsk({ type: "refresh", urls: urls }).then(function () { return done(urls.length); });
  }, function () { return done(0); });
}

// Whatever else the page is doing, the queue is the first thing to reconcile.
rlQueueRefresh().then(function (rows) { if (rows.length) rlReplay(); });
