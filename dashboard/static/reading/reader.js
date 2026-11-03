// The reader: progress, status, rating, tags, highlights, notes, the link
// pill, documents, Listen and the transcript that follows the player.
// window.RL carries what the server knew; common.js is loaded first.
(function () {
  var file = RL.file;
  var errEl = document.getElementById("rl-err");
  var bar = document.getElementById("rl-bar");

  // ── how far he has got ──
  // One number, 0 to 100, kept in the note rather than in this browser, so the
  // list can show it and the phone and the Mac agree about it. What counts
  // depends on the kind: for text it is how far down .rl-body he has been, so
  // his highlights, his notes and the bar underneath are not something still
  // to read; for a video it is the player; while Listen is speaking it is the
  // playhead. Whichever of them is furthest is what the note keeps, because the
  // server never lowers the number.
  var progKind = RL.kind;
  var serverPct = RL.progress;
  var unread = RL.unread;
  var progIn = document.getElementById("rl-prog-in");
  var progBody = document.querySelector(".rl-body");
  var progMain = document.querySelector("main");
  var best = serverPct, sent = serverPct, progTimer = null, lastSent = 0;

  function paintProgress() { if (progIn) progIn.style.width = best + "%"; }

  function flushProgress(leaving) {
    if (sent >= best) return;
    // A beacon fired at a network that is not there is a failure the page never
    // sees and the note never gets. Put the number in the queue instead; the
    // replay collapses every one of these to the furthest per file, so a whole
    // offline read costs the note exactly one write.
    if (!rlOnline()) {
      sent = best;
      rlQueueAdd("/api/reading/progress", { file: file, percent: best }, "progress");
      return;
    }
    var payload = JSON.stringify({ file: file, percent: best });
    sent = best;
    lastSent = Date.now();
    // The last write of a session is the one that matters, and it is made while
    // the page is being taken away, which is exactly when an ordinary fetch is
    // allowed to be cancelled.
    if (leaving && navigator.sendBeacon) {
      try {
        if (navigator.sendBeacon("/api/reading/progress", new Blob([payload], { type: "application/json" }))) return;
      } catch (e) {}
    }
    fetch("/api/reading/progress", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: payload, keepalive: true
    }).catch(function () {});
  }

  // At most one write every five seconds. Reading is not an event stream, and
  // the thing being written to is a file in his vault.
  function reportProgress(p) {
    p = Math.round(p);
    if (!(p > best)) return;
    best = Math.min(100, p);
    paintProgress();
    if (progTimer) return;
    progTimer = setTimeout(function () {
      progTimer = null;
      flushProgress(false);
    }, Math.max(0, 5000 - (Date.now() - lastSent)));
  }

  window.addEventListener("pagehide", function () { flushProgress(true); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushProgress(true);
  });

  // The bottom of the window against the bottom of the body. -1 means there is
  // nothing honest to measure: a video is measured at the player, a piece that
  // fits on one screen has no "how far in" at all, and a document being read as
  // a PDF is being read inside a frame this page cannot see into.
  function textPercent(y) {
    if (!progBody || progKind === "video" || progKind === "book") return -1;
    if (progMain && progMain.dataset.docMode === "pdf") return -1;
    var top = progBody.getBoundingClientRect().top + window.scrollY;
    var span = progBody.offsetHeight;
    if (span < window.innerHeight + 200) return -1;
    return (y + window.innerHeight - top) / span * 100;
  }
  function yForPercent(p) {
    var top = progBody.getBoundingClientRect().top + window.scrollY;
    return Math.max(0, Math.round(top + progBody.offsetHeight * p / 100 - window.innerHeight));
  }

  // Resume where he stopped. Only while the note is unread: once it is done,
  // opening it again should start at the top.
  var posKey = "rl-pos:" + file;
  function forgetPosition() { try { localStorage.removeItem(posKey); } catch (e) {} }
  var resumeEl = document.getElementById("rl-resume");
  function sayResume(p) {
    if (!resumeEl) return;
    resumeEl.textContent = "Resume at " + p + "%";
    resumeEl.hidden = false;
    // It and the sticky header are fixed to the same two pixels. This one is
    // the answer to something that just happened and goes away on its own, so
    // it has the top while it is up and the header waits for it.
    document.body.dataset.resume = "1";
    // It explains the jump; it is not a control. Long enough to read, short
    // enough that it does not become part of the page.
    setTimeout(function () {
      resumeEl.hidden = true;
      delete document.body.dataset.resume;
    }, 6000);
  }
  if (unread) {
    var saved = 0;
    try { saved = parseInt(localStorage.getItem(posKey) || "0", 10) || 0; } catch (e) {}
    // The local pointer is the exact pixel he stopped at on this device; the
    // note carries the furthest point he reached on any of them. The pixel wins
    // unless the note is genuinely ahead of it, and then the jump says so.
    var localPct = textPercent(saved);
    if (serverPct > 0 && serverPct < 100 && localPct >= 0 && serverPct > localPct + 2) {
      window.scrollTo(0, yForPercent(serverPct));
      sayResume(serverPct);
    } else if (saved > 60) {
      window.scrollTo(0, saved);
    }
  }
  paintProgress();

  var posTimer = null;
  window.addEventListener("scroll", function () {
    if (posTimer) return;
    posTimer = setTimeout(function () {
      posTimer = null;
      try { localStorage.setItem(posKey, String(Math.round(window.scrollY))); } catch (e) {}
      var p = textPercent(window.scrollY);
      if (p >= 0) reportProgress(p);
    }, 400);
  }, { passive: true });

  function fail(msg) {
    msg = String(msg || "unknown error");
    errEl.textContent = "Could not save. " + (msg.length > 140 ? msg.slice(0, 140) + "..." : msg);
  }

  // ── the note as this page understands it ──
  // The server owns the file; these are the same facts held here, so a write
  // made offline can be shown at once and still be the answer the server would
  // have given. The optimistic path updates them; the live path replaces them
  // with what came back.
  var localTags = (RL.tags || []).slice();
  var localHl = (RL.highlights || []).map(function (h) {
    return { text: h.text, notes: (h.notes || []).slice() };
  });
  var localNotes = (RL.notes || []).slice();

  // The same two-digit local stamp the server writes, so a note added offline
  // and one added online read identically under ## Notes.
  function nowStamp() {
    var d = new Date();
    var p = function (n) { return String(n).length < 2 ? "0" + n : String(n); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate())
      + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function findHl(text) {
    for (var i = 0; i < localHl.length; i++) if (localHl[i].text === text) return localHl[i];
    return null;
  }

  // What the server would have answered. null means this endpoint cannot be
  // guessed at and has to wait for the network: replacing a note's address and
  // saving a link both do work out there that no local copy stands in for.
  function optimistic(urlPath, payload) {
    if (urlPath === "/api/reading/status") {
      return { ok: true, offline: true, note: {
        starred: "star" in payload ? payload.star : star.getAttribute("aria-pressed") === "true",
        status: payload.status || doneBtn.dataset.status,
        rating: "rating" in payload ? (payload.rating || 0) : currentRating,
        progress: payload.status === "read" ? 100 : payload.status === "unread" ? 0 : best,
      } };
    }
    if (urlPath === "/api/reading/tags") {
      (payload.add || []).forEach(function (t) {
        var clean = String(t).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
        if (clean && localTags.indexOf(clean) < 0) localTags.push(clean);
      });
      (payload.remove || []).forEach(function (t) {
        var at = localTags.indexOf(t);
        if (at >= 0) localTags.splice(at, 1);
      });
      return { ok: true, offline: true, tags: localTags.slice() };
    }
    if (urlPath === "/api/reading/highlight") {
      if (payload.remove) {
        localHl = localHl.filter(function (h) { return h.text !== payload.remove; });
      } else {
        // The server snaps a selection to word edges; offline it is stored as
        // taken, and the replay writes the server's version over it.
        var text = collapse(payload.text);
        if (findHl(text)) return { ok: true, offline: true, duplicate: true, highlights: localHl.slice() };
        localHl.push({ text: text, notes: [] });
      }
      return { ok: true, offline: true, duplicate: false, highlights: localHl.slice() };
    }
    if (urlPath === "/api/reading/highlight-note") {
      var h = findHl(collapse(payload.highlight));
      if (h) h.notes.push(nowStamp() + " " + collapse(payload.note));
      return { ok: true, offline: true, highlights: localHl.slice() };
    }
    if (urlPath === "/api/reading/note") {
      localNotes.push(nowStamp() + " " + collapse(payload.text));
      return { ok: true, offline: true, notes: localNotes.slice() };
    }
    if (urlPath === "/api/reading/delete") return { ok: true, offline: true };
    return null;
  }

  // Queue it, paint it, and let the line say how many are waiting.
  function hold(urlPath, payload, onOk, onErr) {
    var j = optimistic(urlPath, payload);
    if (!j) {
      errEl.textContent = RL_OFFLINE_MSG;
      if (onErr) onErr();
      return;
    }
    rlQueueAdd(urlPath, Object.assign({ file: file }, payload), urlPath.split("/").pop());
    errEl.textContent = "";
    onOk(j);
  }

  // Every one of these used to swallow its failure, so a write that never
  // landed looked exactly like one that did. Now a failure is either an answer
  // from the server, which is shown, or no connection at all, which is held.
  function post(urlPath, payload, onOk, onErr) {
    errEl.textContent = "";
    if (!rlOnline()) { hold(urlPath, payload, onOk, onErr); return; }
    fetch(urlPath, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ file: file }, payload))
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, message: "HTTP " + r.status }; });
    }).then(function (j) {
      if (!j || !j.ok) { fail(j && j.message); if (onErr) onErr(); return; }
      // the server is the truth: take its lists back over the local ones
      if (j.tags) localTags = j.tags.slice();
      if (j.highlights) localHl = j.highlights.map(function (h) {
        return { text: h.text, notes: (h.notes || []).slice() };
      });
      if (j.notes) localNotes = j.notes.slice();
      onOk(j);
    }).catch(function (e) {
      // The connection was not there after all. Same answer as being offline.
      if (rlNetworkError(e)) { hold(urlPath, payload, onOk, onErr); return; }
      fail((e && e.message) || "no connection");
      if (onErr) onErr();
    });
  }
  function status(payload, onOk, onErr) { post("/api/reading/status", payload, onOk, onErr); }

  // ── list order, for next / previous and for what follows Done ──
  function listOrder(cb) {
    // what the list actually showed when he tapped through, if it is still here
    try {
      var stored = JSON.parse(sessionStorage.getItem("rl-order") || "null");
      if (Array.isArray(stored) && stored.indexOf(file) >= 0) return cb(stored);
    } catch (e) {}
    var f = { kind: "all", status: "unread", tag: "", len: "" };
    try {
      var sv = JSON.parse(localStorage.getItem("rl-filter") || "null");
      if (sv && sv.kind && sv.status) f = sv;
    } catch (e) {}
    var qs = "kind=" + encodeURIComponent(f.kind) + "&status=" + encodeURIComponent(f.status);
    if (f.tag) qs += "&tag=" + encodeURIComponent(f.tag);
    if (f.len) qs += "&len=" + encodeURIComponent(f.len);
    fetch("/api/reading/list?" + qs)
      .then(function (r) { return r.json(); })
      .then(function (j) { cb((j.items || []).map(function (x) { return x.file; })); })
      .catch(function () { cb([]); });
  }
  function goNeighbour(step) {
    listOrder(function (files) {
      var i = files.indexOf(file);
      var target = i < 0 ? files[0] : files[i + step];
      if (target) location.href = "/reading/item?f=" + encodeURIComponent(target);
    });
  }

  var doneBtn = document.getElementById("rl-done");

  // Putting something back in the queue is the inverse of finishing it, so it
  // is the same button rather than a second one. Undoing keeps you on the page:
  // you are presumably about to read it.
  function markUnread() {
    doneBtn.disabled = true;
    status({ status: "unread" }, function () {
      doneBtn.disabled = false;
      doneBtn.dataset.status = "unread";
      doneBtn.textContent = "Done";
      // Unread cleared the note's progress. Forget it here too, or the write on
      // the way out would hand back the number he just threw away.
      best = 0; sent = 0; forgetPosition(); paintProgress();
    }, function () { doneBtn.disabled = false; });
  }

  function markDone(thenNext) {
    if (doneBtn.dataset.status !== "unread") { markUnread(); return; }
    doneBtn.disabled = true;
    var after = function (target) {
      forgetPosition();
      doneBtn.textContent = "Saved";
      setTimeout(function () {
        // a cache buster so Safari cannot serve the list as it looked before
        location.replace(target || ("/reading?t=" + Date.now()));
      }, 300);
    };
    var give_up = function () { doneBtn.disabled = false; doneBtn.textContent = "Done"; };
    if (!thenNext) {
      status({ status: "read" }, function () { after(null); }, give_up);
      return;
    }
    listOrder(function (files) {
      var i = files.indexOf(file);
      var target = i >= 0 && files[i + 1] ? "/reading/item?f=" + encodeURIComponent(files[i + 1]) : null;
      status({ status: "read" }, function () { after(target); }, give_up);
    });
  }
  doneBtn.addEventListener("click", function () { markDone(false); });

  var star = document.getElementById("rl-star");
  function toggleStar() {
    var next = star.getAttribute("aria-pressed") !== "true";
    star.disabled = true;
    status({ star: next }, function (j) {
      star.disabled = false;
      star.setAttribute("aria-pressed", j && j.note ? String(j.note.starred) : String(next));
    }, function () { star.disabled = false; });
  }
  star.addEventListener("click", toggleStar);

  // ── rating ──
  var rateEl = document.getElementById("rl-rate");
  var rateText = document.getElementById("rl-rate-text");
  var rateSel = document.getElementById("rl-rate-select");
  var SHORT = RL.ratingShort;
  function paintRating(val) {
    rateEl.dataset.set = val ? "1" : "0";
    rateText.textContent = val ? SHORT[val] : "Rate";
    rateSel.value = val ? String(val) : "";
  }
  // The select has already moved by the time change fires, so the value it used
  // to hold is kept here rather than read back off the control.
  var currentRating = RL.rating;
  function setRating(r) {
    // 0 is "Clear rating"; pressing the number it already has also takes it off
    var next = (!r || r === currentRating) ? null : r;
    var before = currentRating;
    status({ rating: next }, function (j) {
      currentRating = j && j.note ? j.note.rating : (next || 0);
      paintRating(currentRating);
    }, function () { paintRating(before); });
  }
  rateSel.addEventListener("change", function () {
    setRating(parseInt(rateSel.value || "0", 10));
  });

  // ── book progress ──
  // Only on a book, where nothing can be measured: the picker sets the note's
  // progress outright (exact), lower included, and Not started clears it.
  var bpEl = document.getElementById("rl-bookprog");
  if (bpEl) {
    var bpText = document.getElementById("rl-bookprog-text");
    var bpSel = document.getElementById("rl-bookprog-select");
    var bpNow = serverPct;
    var paintBook = function (p) {
      bpEl.dataset.set = p ? "1" : "0";
      bpText.textContent = p ? p + "% read" : "Progress";
      bpSel.value = p ? String(p) : "";
      best = sent = p; paintProgress();
    };
    bpSel.addEventListener("change", function () {
      var p = parseInt(bpSel.value || "0", 10) || 0;
      var before = bpNow;
      post("/api/reading/progress", { percent: p, exact: true }, function (j) {
        bpNow = j && typeof j.progress === "number" ? j.progress : p;
        paintBook(bpNow);
      }, function () { paintBook(before); });
    });
  }

  // ── tags ──
  var tagsEl = document.getElementById("rl-tags");
  var tagAdd = document.getElementById("rl-tag-add");
  var tagInput = document.getElementById("rl-tag-input");
  // The sticky header shows the same row a second time when it is open. It
  // registers here rather than being reached into, so there is still one place
  // that knows what the tags are.
  var onTags = null;
  function renderTags(list) {
    [].slice.call(tagsEl.querySelectorAll(".rl-tag")).forEach(function (b) { b.remove(); });
    list.forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "rl-tag"; b.dataset.t = t; b.textContent = t;
      tagsEl.insertBefore(b, tagAdd);
    });
    if (onTags) onTags(list);
  }
  // Both places that add or drop a tag come through these, so both go the one
  // way to the server and both repaint both rows.
  function addTag(v, then) {
    post("/api/reading/tags", { add: [v] }, function (j) {
      renderTags(j.tags || []);
      if (then) then();
    });
  }
  function removeTag(t) {
    post("/api/reading/tags", { remove: [t] }, function (j) { renderTags(j.tags || []); });
  }
  tagsEl.addEventListener("click", function (e) {
    var b = e.target.closest(".rl-tag");
    if (!b) return;
    removeTag(b.dataset.t);
  });
  tagAdd.addEventListener("click", function () {
    tagInput.classList.add("on");
    tagInput.focus();
  });
  tagInput.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { tagInput.value = ""; tagInput.classList.remove("on"); return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    var v = tagInput.value.trim();
    if (!v) return;
    tagInput.value = "";
    addTag(v, function () { tagInput.classList.remove("on"); });
  });

  // ── copy markdown ──
  var copyBtn = document.getElementById("rl-copy");
  function copied() {
    copyBtn.textContent = "Copied";
    setTimeout(function () { copyBtn.textContent = "Copy"; }, 1000);
  }
  function copyMarkdown() {
    if (!rlOnline()) { fail("offline"); return; }
    fetch("/api/reading/markdown?f=" + encodeURIComponent(file))
      .then(function (r) { return r.text(); })
      .then(function (text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(copied, function () { legacyCopy(text); });
        } else { legacyCopy(text); }
      }).catch(function (e) { fail((e && e.message) || "copy failed"); });
  }
  function legacyCopy(text) {
    // older Safari has no clipboard API outside a very narrow gesture window
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); copied(); } catch (e) { fail("copy failed"); }
    document.body.removeChild(ta);
  }
  copyBtn.addEventListener("click", copyMarkdown);

  // ── delete, with the confirm in the bar rather than a browser dialog ──
  // The word now lives in the sheet behind the three dots, but the question it
  // asks still belongs in the bar, where his thumb already is. So the sheet
  // gets out of the way first and the bar asks underneath it.
  var delBtn = document.getElementById("rl-del");
  function askDelete(on) { bar.dataset.confirm = on ? "del" : "0"; }
  delBtn.addEventListener("click", function () { settingsOpen(false); askDelete(true); });
  document.getElementById("rl-del-no").addEventListener("click", function () { askDelete(false); });
  document.getElementById("rl-del-yes").addEventListener("click", function () {
    post("/api/reading/delete", {}, function () {
      forgetPosition();
      location.replace("/reading?t=" + Date.now());
    }, function () { askDelete(false); });
  });

  // ── replace: the note keeps his marks and takes on a different address ──
  // One reload afterwards. The note now says fetched: false, so the reader
  // answers with its waiting page and polls, the same as any fresh save.
  function goReplace(url, onErr) {
    post("/api/reading/replace", { url: url }, function () {
      forgetPosition();
      location.replace("/reading/item?f=" + encodeURIComponent(file) + "&t=" + Date.now());
    }, onErr);
  }

  // The bar's row, for a link that is not in the body to right-click.
  var repBtn = document.getElementById("rl-replace");
  var repUrl = document.getElementById("rl-rep-url");
  function askReplace(on) {
    bar.dataset.confirm = on ? "rep" : "0";
    if (on) { repUrl.value = ""; repUrl.disabled = false; repUrl.focus(); }
  }
  // Same as Delete: the sheet closes, then the bar grows the field.
  repBtn.addEventListener("click", function () { settingsOpen(false); askReplace(true); });
  document.getElementById("rl-rep-no").addEventListener("click", function () { askReplace(false); });
  function barReplace() {
    var v = repUrl.value.trim();
    if (!v) return;
    repUrl.disabled = true;
    goReplace(v, function () { repUrl.disabled = false; askReplace(false); });
  }
  document.getElementById("rl-rep-go").addEventListener("click", barReplace);
  repUrl.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { askReplace(false); return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    barReplace();
  });

  // The arXiv line under the byline is the same thing with the address known.
  var arxivLink = document.getElementById("rl-arxiv");
  if (arxivLink) arxivLink.addEventListener("click", function (e) {
    e.preventDefault();
    arxivLink.textContent = "Replacing\u2026";
    goReplace(arxivLink.href, function () { arxivLink.textContent = "Replace with the PDF"; });
  });

  // ── highlights ──
  var bodyEl = document.querySelector(".rl-body");
  var pill = document.getElementById("rl-pill");
  var pillMain = document.getElementById("rl-pill-main");
  var pillInput = document.getElementById("rl-pill-input");
  var hlHead = document.getElementById("rl-hl-h");
  var hlList = document.getElementById("rl-hl-list");
  var noteList = document.getElementById("rl-note-list");
  var noteForm = document.getElementById("rl-note-form");
  var noteText = document.getElementById("rl-note-text");
  var pending = "";          // the selection, if there is one
  var pendingRange = null;
  var anchored = "";         // the existing highlight the pill is attached to

  function esc2(x) {
    return String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function collapse(x) { return String(x).replace(/\s+/g, " ").trim(); }

  function hidePill() {
    pill.classList.remove("on");
    pill.dataset.mode = "main";
    pillInput.value = "";
    anchored = "";
  }

  // Above the thing it belongs to, unless that would put it off the top, in
  // which case below, where the iOS callout is not already sitting.
  function placePill(rect) {
    pill.classList.add("on");
    var w = pill.offsetWidth || 200;
    var above = rect.top - pill.offsetHeight - 10;
    pill.style.top = (above > 8 ? above : rect.bottom + 10) + "px";
    pill.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2)) + "px";
  }

  function pillButtons(items) {
    pillMain.innerHTML = "";
    items.forEach(function (it) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = it.label;
      if (it.muted) b.className = "rl-pill-muted";
      b.addEventListener("mousedown", function (e) { e.preventDefault(); });
      b.addEventListener("touchstart", function (e) { e.preventDefault(); }, { passive: false });
      b.addEventListener("click", it.run);
      pillMain.appendChild(b);
    });
  }

  function askNote(onSave) {
    pill.dataset.mode = "note";
    pillInput.value = "";
    pillInput.focus();
    pillInput.onkeydown = function (e) {
      if (e.key === "Escape") { hidePill(); return; }
      if (e.key !== "Enter") return;
      e.preventDefault();
      var v = pillInput.value.trim();
      if (!v) return;
      onSave(v);
    };
  }

  function renderHighlights(list) {
    hlList.innerHTML = list.map(function (h) {
      var notes = (h.notes || []).map(function (x) {
        var m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+([\s\S]*)$/.exec(x);
        return '<li class="rl-hl-note">' + (m ? '<span class="rl-note-when">' + esc2(m[1]) + "</span> " + esc2(m[2]) : esc2(x)) + "</li>";
      }).join("");
      return '<div class="rl-hl-item" data-h="' + esc2(h.text) + '">'
        + '<blockquote class="rl-hl">' + esc2(h.text) + "</blockquote>"
        + (notes ? '<ul class="rl-hl-notes">' + notes + "</ul>" : "")
        + '<span class="rl-hl-acts">'
        + '<button type="button" class="rl-hl-act" data-a="note">+ note</button>'
        + '<button type="button" class="rl-hl-act" data-a="remove">remove</button>'
        + "</span></div>";
    }).join("");
    hlHead.classList.toggle("rl-off", list.length === 0);
  }

  function renderNotes(list) {
    noteList.innerHTML = list.map(function (x) {
      var m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+([\s\S]*)$/.exec(x);
      var when = m ? m[1] : "";
      var text = m ? m[2] : x;
      return '<li class="rl-note">' + (when ? '<span class="rl-note-when">' + esc2(when) + "</span> " : "") + esc2(text) + "</li>";
    }).join("");
  }

  function tint(range, text) {
    if (!range) return;
    try {
      var m = document.createElement("mark");
      m.className = "rl-mark";
      m.dataset.h = text;
      m.appendChild(range.extractContents());
      range.insertNode(m);
    } catch (e) {}
    // The Range may have been cut through a sentence span; rebuild them.
    afterBodyEdit();
  }

  function dropMark(text) {
    [].slice.call(bodyEl.querySelectorAll("mark.rl-mark")).forEach(function (m) {
      if (m.dataset.h !== text) return;
      var parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    });
    afterBodyEdit();
  }

  function saveHighlight(text, range, then) {
    post("/api/reading/highlight", { text: text }, function (j) {
      renderHighlights(j.highlights || []);
      // the server snaps to word edges, so take the text it stored, not ours
      var stored = (j.highlights || []).map(function (h) { return h.text; });
      var landed = stored[stored.length - 1] || text;
      if (!j.duplicate) tint(range, landed);
      var sel = document.getSelection();
      if (sel) sel.removeAllRanges();
      if (then) then(landed);
    });
  }

  function offerHighlight() {
    if (!pending) return;
    var text = pending, range = pendingRange;
    pillButtons([]);
    saveHighlight(text, range, null);
    hidePill();
  }

  function offerHighlightNote() {
    if (!pending) return;
    var text = pending, range = pendingRange;
    saveHighlight(text, range, function (landed) {
      anchored = landed;
      askNote(function (note) {
        post("/api/reading/highlight-note", { highlight: landed, note: note }, function (j) {
          renderHighlights(j.highlights || []);
          hidePill();
        });
      });
    });
  }

  // A selection anywhere in the body, including inside a transcript cue.
  document.addEventListener("selectionchange", function () {
    var sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      if (pill.dataset.mode !== "note" && !anchored) hidePill();
      pending = ""; pendingRange = null;
      return;
    }
    var text = collapse(sel.toString());
    if (!text || text.length > 5000) return;
    var node = sel.getRangeAt(0).commonAncestorContainer;
    node = node.nodeType === 1 ? node : node.parentNode;
    if (!node || !bodyEl.contains(node)) return;

    var startEl = sel.getRangeAt(0).startContainer;
    startEl = startEl.nodeType === 1 ? startEl : startEl.parentNode;
    var cue = startEl && startEl.closest ? startEl.closest(".rl-cue") : null;
    if (cue) {
      var stampEl = cue.querySelector(".rl-cue-t");
      if (stampEl) text = stampEl.textContent.trim() + " \u00b7 " + text;
    }

    pending = text;
    pendingRange = sel.getRangeAt(0).cloneRange();
    anchored = "";
    pill.dataset.mode = "main";
    pillButtons([
      { label: "Highlight", run: offerHighlight },
      { label: "Highlight + note", run: offerHighlightNote }
    ]);
    placePill(sel.getRangeAt(0).getBoundingClientRect());
  });

  // Tapping a mark manages that highlight where it sits.
  bodyEl.addEventListener("click", function (e) {
    var m = e.target.closest ? e.target.closest("mark.rl-mark") : null;
    if (!m) return;
    var sel = document.getSelection();
    if (sel && !sel.isCollapsed) return;
    e.preventDefault();
    var text = m.dataset.h;
    anchored = text;
    pending = "";
    pill.dataset.mode = "main";
    pillButtons([
      { label: "note", run: function () {
          askNote(function (note) {
            post("/api/reading/highlight-note", { highlight: text, note: note }, function (j) {
              renderHighlights(j.highlights || []);
              hidePill();
            });
          });
        } },
      { label: "remove", run: function () {
          post("/api/reading/highlight", { remove: text }, function (j) {
            renderHighlights(j.highlights || []);
            dropMark(text);
            hidePill();
          });
        } },
      { label: "go to highlights", muted: true, run: function () {
          hidePill();
          var item = hlList.querySelector('[data-h="' + text.replace(/"/g, '\\"') + '"]');
          (item || hlList).scrollIntoView({ block: "center" });
        } }
    ]);
    placePill(m.getBoundingClientRect());
  });

  // The record at the bottom offers the same two things.
  hlList.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest(".rl-hl-act") : null;
    if (!b) return;
    var item = b.closest(".rl-hl-item");
    var text = item.dataset.h;
    if (b.dataset.a === "remove") {
      post("/api/reading/highlight", { remove: text }, function (j) {
        renderHighlights(j.highlights || []);
        dropMark(text);
      });
      return;
    }
    anchored = text;
    pill.dataset.mode = "main";
    pillButtons([]);
    placePill(b.getBoundingClientRect());
    askNote(function (note) {
      post("/api/reading/highlight-note", { highlight: text, note: note }, function (j) {
        renderHighlights(j.highlights || []);
        hidePill();
      });
    });
  });

  document.addEventListener("click", function (e) {
    if (pill.contains(e.target)) return;
    // A pill button that rebuilt the pill under itself is gone from the page by
    // the time this runs, so containment says no. That is not a tap outside.
    if (e.target && e.target.isConnected === false) return;
    if (e.target.closest && (e.target.closest("mark.rl-mark") || e.target.closest(".rl-hl-act"))) return;
    hidePill();
  });

  // ── a link inside the body ──
  // The same pill, over the link instead of over a selection: an arXiv listing
  // that should have been the PDF, a tweet pointing at the piece he actually
  // wants. Right-click on the Mac, half a second of stillness on a phone.
  //
  // The rule against the Highlight pill, so the two never argue: a gesture that
  // has produced a text selection belongs to the selection. On the desktop that
  // means a right-click with something selected goes to the browser's own menu
  // (he is copying, or searching). On a phone it means the long press that
  // Safari turned into a word selection raises Highlight as it always did, and
  // only a press that selected nothing is read as being about the link.
  var linkTimer = null, linkFrom = null, swallowClick = false;

  function linkUnder(el) {
    var a = el && el.closest ? el.closest("a[href]") : null;
    return a && bodyEl.contains(a) && /^https?:/i.test(a.href) ? a : null;
  }
  function hasSelection() {
    var sel = document.getSelection();
    return Boolean(sel && !sel.isCollapsed && sel.toString().trim());
  }
  function pillSays(text) {
    pillButtons([{ label: text, muted: true, run: hidePill }]);
  }
  function openLinkPill(a) {
    pending = ""; pendingRange = null; anchored = "";
    pill.dataset.mode = "main";
    var href = a.href;
    pillButtons([
      { label: "Queue", run: function () {
          pillSays("Queueing\u2026");
          post("/api/reading/add", { url: href }, function (j) {
            // stays on the page: he asked for it later, not now
            pillSays((j.duplicate ? "Already queued: " : "Queued: ") + (j.title || href));
            setTimeout(function () { if (pill.dataset.mode === "main") hidePill(); }, 2600);
          }, hidePill);
        } },
      { label: "Replace", run: function () {
          pillSays("Replacing\u2026");
          goReplace(href, hidePill);
        } },
      { label: "Open", muted: true, run: function () {
          hidePill();
          window.open(href, "_blank", "noopener");
        } }
    ]);
    placePill(a.getBoundingClientRect());
  }

  bodyEl.addEventListener("contextmenu", function (e) {
    var a = linkUnder(e.target);
    if (!a || hasSelection()) return;
    // only when the pill actually opens; every other right-click is the browser's
    e.preventDefault();
    openLinkPill(a);
  });

  function cancelLinkPress() {
    if (linkTimer) { clearTimeout(linkTimer); linkTimer = null; }
  }
  bodyEl.addEventListener("touchstart", function (e) {
    if (e.touches.length !== 1) return;
    var a = linkUnder(e.target);
    if (!a) return;
    linkFrom = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    cancelLinkPress();
    linkTimer = setTimeout(function () {
      linkTimer = null;
      if (hasSelection()) return;
      swallowClick = true;
      // Safari does not always send a click after a long press. Arm the
      // swallow for one gesture's worth of time, never indefinitely, or the
      // next real tap pays for a click that never came.
      setTimeout(function () { swallowClick = false; }, 800);
      openLinkPill(a);
    }, 500);
  }, { passive: true });
  bodyEl.addEventListener("touchmove", function (e) {
    if (!linkTimer || !linkFrom) return;
    var t = e.touches[0];
    if (Math.abs(t.clientX - linkFrom.x) > 10 || Math.abs(t.clientY - linkFrom.y) > 10) cancelLinkPress();
  }, { passive: true });
  bodyEl.addEventListener("touchend", cancelLinkPress);
  bodyEl.addEventListener("touchcancel", cancelLinkPress);

  // The tap that ends a long press must not follow the link, and must not count
  // as the tap outside that closes the pill we just opened.
  document.addEventListener("click", function (e) {
    if (!swallowClick) return;
    swallowClick = false;
    if (pill.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  noteForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var t = noteText.value.trim();
    if (!t) return;
    noteText.disabled = true;
    post("/api/reading/note", { text: t }, function (j) {
      noteText.disabled = false;
      noteText.value = "";
      renderNotes(j.notes || []);
    }, function () { noteText.disabled = false; });
  });
  // Enter submits where there is a keyboard; on a phone it should make a line
  // break and the button does the work.
  noteText.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (!window.matchMedia("(hover: hover)").matches) return;
    e.preventDefault();
    if (noteForm.requestSubmit) noteForm.requestSubmit();
    else noteForm.dispatchEvent(new Event("submit", { cancelable: true }));
  });

  // ── keyboard ──
  var awaitingDelete = false;
  // ── document fullscreen ──
  // The frame goes fullscreen through the API where the browser grants it to a
  // page element; where it does not, the frame is pinned over the page instead.
  var docEl = document.getElementById("rl-doc");
  var docFrame = docEl ? docEl.querySelector(".rl-doc-frame") : null;
  var docFull = null;
  var modeEl = document.getElementById("rl-mode");
  var mainEl = document.querySelector("main") || document.body;
  function setDocMode(m, remember) {
    if (!modeEl) return;
    mainEl.dataset.docMode = m;
    [].forEach.call(modeEl.querySelectorAll(".rl-chip"), function (b) {
      b.setAttribute("aria-pressed", b.dataset.v === m ? "true" : "false");
    });
    if (remember) { try { localStorage.setItem("rl-doc-mode", m); } catch (e) {} }
  }
  if (modeEl) {
    var savedMode = "read";
    try { savedMode = localStorage.getItem("rl-doc-mode") || "read"; } catch (e) {}
    setDocMode(savedMode === "pdf" ? "pdf" : "read", false);
    modeEl.addEventListener("click", function (e) {
      var b = e.target.closest(".rl-chip");
      if (b) setDocMode(b.dataset.v, true);
    });
  }
  function docUnpin() { if (docEl) docEl.classList.remove("rl-doc-pinned"); }
  if (docEl && docFrame) {
    docFull = function () {
      if (mainEl.dataset.docMode === "read") setDocMode("pdf", true);
      if (docEl.classList.contains("rl-doc-pinned")) { docUnpin(); return; }
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document); return;
      }
      var req = docFrame.requestFullscreen || docFrame.webkitRequestFullscreen;
      if (req) {
        try {
          var p = req.call(docFrame);
          if (p && p.catch) p.catch(function () { docEl.classList.add("rl-doc-pinned"); });
          return;
        } catch (err) {}
      }
      docEl.classList.add("rl-doc-pinned");
    };
    document.getElementById("rl-doc-full").addEventListener("click", docFull);
    document.getElementById("rl-doc-exit").addEventListener("click", docUnpin);
  }

  // ── the sheet behind the three dots ──
  // It holds two kinds of thing: what this note can be made to do (Keep
  // offline, Obsidian, Copy, Replace, Delete — each wired up elsewhere in this
  // file, by the same ids they had when they were words in the bar), and under
  // a rule the two site-wide switches, whose store lives in settings.js. This
  // is only the sheet; it sits under the three dots rather than in the
  // shortcuts overlay because these are things you do, not things you look up.
  var setEl = document.getElementById("rl-settings");
  var setOpenBtn = document.getElementById("rl-settings-open");
  function settingsOpen(on) {
    if (!setEl) return;
    setEl.classList.toggle("on", on);
    if (setOpenBtn) setOpenBtn.setAttribute("aria-expanded", String(on));
  }
  if (setEl && setOpenBtn) {
    var syncBox = document.getElementById("rl-set-scrollsync");
    RLSettings.on("scrollSync", function (v) { syncBox.checked = Boolean(v); });
    syncBox.addEventListener("change", function () { RLSettings.set("scrollSync", syncBox.checked); });
    var pinBox = document.getElementById("rl-set-pinplayer");
    if (pinBox) {
      RLSettings.on("pin-player", function (v) { pinBox.checked = v !== false; });
      pinBox.addEventListener("change", function () { RLSettings.set("pin-player", pinBox.checked); });
    }
    setOpenBtn.addEventListener("click", function () { settingsOpen(!setEl.classList.contains("on")); });
    document.getElementById("rl-settings-done").addEventListener("click", function () { settingsOpen(false); });
    setEl.addEventListener("click", function (e) { if (e.target === setEl) settingsOpen(false); });
  }

  // ── following a playhead ──
  // Two things on this page move with a playhead: the voice walking through the
  // sentences of an article, and a video walking through its transcript. They
  // want the same behaviour, and he asked for it once, so there is one of it.
  //
  // The rule is that it never fights him. It puts the active line a third of
  // the way down and then leaves it alone; the moment a scroll arrives that we
  // did not cause it lets go and offers the way back; and if he scrolls back to
  // the line himself it takes over again without being asked, because having to
  // press a button to resume something you have already done by hand is the
  // kind of small rudeness that makes a feature not worth having.
  var followBtn = document.getElementById("rl-follow");

  function makeFollower() {
    var enabled = true, on = true, el = null, mine = 0, settle = null;

    function paint() { if (followBtn) followBtn.hidden = !enabled || on || !el; }

    function place(e) {
      var r = e.getBoundingClientRect();
      var want = Math.max(0, window.scrollY + r.top - window.innerHeight / 3);
      mine = Date.now();
      try { window.scrollTo({ top: want, behavior: "smooth" }); }
      catch (err) { window.scrollTo(0, want); }
    }

    // Only the top of the line is asked about. Using the bottom as well would
    // mean a paragraph taller than the comfortable band could never satisfy the
    // test, and the page would scroll itself forever trying.
    function settled(e) {
      var top = e.getBoundingClientRect().top;
      return top > window.innerHeight * 0.04 && top < window.innerHeight * 0.62;
    }

    window.addEventListener("scroll", function () {
      if (!enabled || !el) return;
      if (Date.now() - mine < 700) return;    // our own smooth scroll, still arriving
      if (on) { on = false; paint(); }
      if (settle) clearTimeout(settle);
      settle = setTimeout(function () {
        settle = null;
        if (!enabled || on || !el) return;
        if (settled(el)) { on = true; paint(); }
      }, 450);
    }, { passive: true });

    if (followBtn) followBtn.addEventListener("click", function () {
      on = true;
      if (el) place(el);
      paint();
    });

    return {
      enable: function (v) { enabled = Boolean(v); if (!enabled) on = true; paint(); },
      // What is active now. Scrolls only when the line has drifted out of the
      // band, so a sentence that is already comfortably on screen does not drag
      // the page a few pixels every time the voice moves on.
      show: function (e) {
        el = e || null;
        if (!enabled || !on || !el) { paint(); return; }
        if (!settled(el)) place(el);
        paint();
      },
      // After a seek: go there whether or not it was nearly right.
      jump: function (e) {
        el = e || null;
        if (enabled && on && el) place(el);
        paint();
      },
      clear: function () { el = null; paint(); }
    };
  }

  var follower = makeFollower();
  RLSettings.on("scrollSync", function (v) { follower.enable(v); });

  // ── sentences on the page ──
  // A cue is {i, s, t}: block, sentence within it, seconds. The block is an
  // element the page already has. The sentence is not, so while a rendering is
  // playing the reader makes one — walking the text nodes of each block and
  // wrapping each sentence in a span. Only while playing: with nothing playing
  // the body is byte for byte the HTML the server sent, which is what the
  // selection, the highlight pill, the marks and the long-press on a link are
  // all written against.
  //
  // Where a sentence ends is not decided here. That rule is in sentences.js and
  // is shared with the preparer on the server, because a cue that says
  // "sentence three" and a page that counted four of them is worse than no
  // sentence highlight at all.
  var BLOCK_SEL = ".rl-body .md p, .rl-body .md h2, .rl-body .md h3, .rl-body .md li";
  var NESTED_SEL = "p, h2, h3, li";
  var sentOn = false;

  function skipEl(el) {
    var t = el.tagName;
    if (t === "SCRIPT" || t === "STYLE") return true;
    return Boolean(el.classList && el.classList.contains("rl-pg"));
  }

  // The block's characters, each remembering the text node it came from. A
  // space goes in where every tag was, because that is exactly what the
  // preparer's tag-stripping regex leaves behind, and the two strings have to
  // have the same shape or the sentence offsets land in the wrong place.
  function blockChars(block) {
    var out = [];
    (function walk(el) {
      for (var n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) {
          var s = n.nodeValue;
          for (var k = 0; k < s.length; k++) out.push({ c: s.charAt(k), node: n, off: k });
          continue;
        }
        if (n.nodeType !== 1) continue;
        // A page mark reads as "page 14" in the middle of a sentence, so the
        // preparer drops it whole and so does this.
        if (skipEl(n)) { out.push({ c: " ", node: null, off: 0 }); continue; }
        out.push({ c: " ", node: null, off: 0 });
        walk(n);
        out.push({ c: " ", node: null, off: 0 });
      }
    })(block);
    return out;
  }

  // The same string the preparer built: URLs gone, whitespace collapsed,
  // trimmed — plus, for every character of it, where in the block it came from.
  function normalizeBlock(chars) {
    var raw = "";
    for (var k = 0; k < chars.length; k++) raw += chars[k].c;
    var gone = new Uint8Array(raw.length);
    var re = rlSentences.urlRe(), m;
    while ((m = re.exec(raw)) !== null) {
      for (var g = m.index; g < m.index + m[0].length; g++) gone[g] = 1;
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    // A run of whitespace becomes one space, and that space remembers the
    // position of a real whitespace character in the run — not the position of
    // the letter after it. Pointing it at the letter would make the space and
    // the letter claim the same character, which splits every word in the
    // paragraph into its own span.
    var text = "", map = [], space = false, spaceAt = -1;
    for (var i = 0; i < raw.length; i++) {
      var c = raw.charAt(i);
      var ws = c === " " || c === "\n" || c === "\t" || c === "\r" || c === " ";
      if (gone[i] || ws) {
        if (text.length > 0) {
          if (!space) { space = true; spaceAt = ws ? i : -1; }
          else if (spaceAt < 0 && ws) spaceAt = i;
        }
        continue;
      }
      if (space) { text += " "; map.push(spaceAt >= 0 ? spaceAt : i); space = false; }
      text += c; map.push(i);
    }
    return { text: text, map: map };
  }

  function wrapBlock(block, i) {
    // A list item that wraps its own paragraph is a container, not a line. The
    // preparer leaves it silent for the same reason; the paragraph inside is
    // its own block and gets its own spans.
    if (block.querySelector(NESTED_SEL)) return;
    var chars = blockChars(block);
    var n = normalizeBlock(chars);
    if (!n.text) return;
    var rs = rlSentences.ranges(n.text);
    var pieces = [];
    for (var s = 0; s < rs.length; s++) {
      var a = rs[s][0], b = rs[s][1];
      while (a < b && n.text.charAt(a) === " ") a++;
      while (b > a && n.text.charAt(b - 1) === " ") b--;
      var cur = null;
      for (var k = a; k < b; k++) {
        var ch = chars[n.map[k]];
        // A character that came from no node is one of the spaces standing in
        // for a tag. A sentence crossing a link or a mark simply becomes two
        // spans carrying the same numbers.
        if (!ch || !ch.node) { cur = null; continue; }
        if (cur && cur.node === ch.node && cur.to === ch.off) { cur.to = ch.off + 1; continue; }
        cur = { node: ch.node, from: ch.off, to: ch.off + 1, s: s };
        pieces.push(cur);
      }
    }
    // Back to front, so every cut still has the offsets in front of it intact:
    // splitText keeps the prefix in the original node.
    for (var p = pieces.length - 1; p >= 0; p--) {
      var pc = pieces[p], node = pc.node;
      if (pc.to < node.nodeValue.length) node.splitText(pc.to);
      var mid = pc.from > 0 ? node.splitText(pc.from) : node;
      var span = document.createElement("span");
      span.className = "rl-sent";
      span.dataset.i = String(i);
      span.dataset.s = String(pc.s);
      mid.parentNode.insertBefore(span, mid);
      span.appendChild(mid);
    }
  }

  function wrapSentences() {
    if (sentOn) return;
    sentOn = true;
    var list = document.querySelectorAll(BLOCK_SEL);
    for (var i = 0; i < list.length; i++) {
      try { wrapBlock(list[i], i); } catch (e) {}
    }
  }

  function unwrapSentences() {
    if (!sentOn) return;
    sentOn = false;
    var spans = bodyEl.querySelectorAll("span.rl-sent");
    for (var k = 0; k < spans.length; k++) {
      var s = spans[k], p = s.parentNode;
      while (s.firstChild) p.insertBefore(s.firstChild, s);
      p.removeChild(s);
    }
    // Puts the text nodes back the way they were, so what is left is the body
    // the page was served.
    bodyEl.normalize();
  }

  // Highlighting rewrites the body around a Range, which leaves the spans that
  // Range cut through cloned and half-empty. Rather than teach the highlight
  // machinery about sentences, throw the spans away and make them again — they
  // are derived from the text, so remaking them is the cheap repair.
  var remarkSentences = null;    // the player puts its own repaint here
  function afterBodyEdit() {
    if (!sentOn) return;
    unwrapSentences();
    wrapSentences();
    if (remarkSentences) remarkSentences();
  }

  // ── Listen ──
  // The control does three things, in this order: say what a rendering would
  // cost, make it, and play what has already been made. Nothing here blocks the
  // page; a render runs on the server and is asked after.
  var listenEl = document.getElementById("rl-listen");
  var listenToggle = null;
  var togglePlay = null;
  var stepSentence = null;
  // What the sticky header's Listen does, and how it knows what to call itself.
  // Both are set below, inside the player, so the header borrows the machinery
  // rather than growing a second copy of it.
  var headerListen = null;
  var audioState = null;
  var onAudioState = null;
  if (listenEl) {
    var VOICE_LABELS = RL.voices;
    var voiceSel = document.getElementById("rl-voice-select");
    var voiceText = document.getElementById("rl-voice-text");
    var goBtn = document.getElementById("rl-listen-go");
    var estEl = document.getElementById("rl-listen-est");
    var msgEl = document.getElementById("rl-listen-msg");
    var savedBox = document.getElementById("rl-saved");
    var makeBox = document.getElementById("rl-make");
    var moreBtn = document.getElementById("rl-listen-more");
    var askEl = document.getElementById("rl-listen-ask");
    var listenBtn = document.getElementById("rl-listen-open");
    var lastEst = null;
    var pollTimer = null;

    // The voice he used last is the voice he wants next.
    var voice = RL.defaultVoice;
    try { var v0 = localStorage.getItem("rl-voice"); if (v0 && VOICE_LABELS[v0]) voice = v0; } catch (e) {}
    voiceSel.value = voice;
    voiceText.textContent = VOICE_LABELS[voice];

    function attr(x) { return esc2(x).split('"').join("&quot;"); }
    function firstName(label) { return String(label).split(" (")[0]; }
    // The same clock savedRowHtml prints on the server, so a row drawn here and
    // one that came with the page read identically.
    function rlClock(sec) {
      var n = Math.max(0, Math.round(sec)), h = Math.floor(n / 3600);
      var m = Math.floor((n % 3600) / 60), s = n % 60;
      return (h ? h + ":" + ("0" + m).slice(-2) : String(m)) + ":" + ("0" + s).slice(-2);
    }
    function setMsg(t) { msgEl.textContent = t || ""; }

    function estimate() {
      estEl.textContent = "";
      lastEst = null;
      if (!rlOnline()) { setMsg("Offline. What is already saved still plays."); return; }
      fetch("/api/reading/audio/estimate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: file, voice: voice })
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j || !j.ok) { setMsg((j && j.message) || "Could not estimate."); return; }
        lastEst = j;
        // Two bills, and the second one is Deepgram's whatever the voice is:
        // listening back to the rendering is what puts a real time on every
        // sentence. Saying so is cheaper than him finding it on an invoice.
        estEl.textContent = j.minutes + " min, about " + j.cost + " with " + firstName(j.label)
          + (j.alignCost ? " + " + j.alignCost + " to sync the words" : "");
      }).catch(function (e) { setMsg((e && e.message) || "no connection"); });
    }

    function shortDay(iso) {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }

    // Same shape savedRowHtml writes on the server, so a rendering made just now
    // and one that was already there are the same row.
    function paintSaved(list) {
      list = list || [];
      savedBox.innerHTML = list.map(function (s) {
        var mins = Math.max(1, Math.round(s.seconds / 60));
        var at = Number(s.at) || 0;
        var where = at > 20 && at < s.seconds - 10 ? ", at " + rlClock(at) : "";
        var what = "Saved: " + s.label + ", " + mins + " min"
          + (s.partial ? ", first 30 min" : "") + ", " + shortDay(s.created) + where;
        return '<div class="rl-saved-row" data-voice="' + attr(s.voice) + '" data-url="' + attr(s.url)
          + '" data-cues="' + attr(s.cuesUrl) + '" data-at="' + at
          + '" data-label="' + attr(s.label) + '" data-secs="' + (Math.round(s.seconds) || 0) + '">'
          + '<span class="rl-saved-name">' + esc2(what) + "</span>"
          + '<button type="button" class="rl-saved-act" data-a="play">Play</button>'
          + '<a class="rl-saved-act" href="' + attr(s.url) + '&download=1" download>Download</a></div>';
      }).join("");
      moreBtn.hidden = list.length === 0;
      makeBox.hidden = list.length > 0;
    }

    function poll() {
      if (pollTimer) return;
      pollTimer = setInterval(function () {
        fetch("/api/reading/audio/state?f=" + encodeURIComponent(file) + "&voice=" + encodeURIComponent(voice))
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (!j || !j.ok) return;
            if (j.state === "queued") { setMsg("Queued."); return; }
            if (j.state === "running") {
              setMsg("Rendering, " + j.done + " of " + (j.total || "?") + " parts");
              return;
            }
            clearInterval(pollTimer); pollTimer = null;
            goBtn.disabled = false;
            if (j.state === "failed") { setMsg(j.message || "Rendering failed."); return; }
            setMsg("");
            paintSaved(j.saved);
          }).catch(function () {});
      }, 1500);
    }

    function makeAudio(limitSeconds) {
      listenEl.dataset.confirm = "0";
      // Rendering is a job on the Mac that costs money; there is nothing to
      // queue and nothing to guess at, so it waits for the network.
      if (!rlOnline()) { setMsg("Offline. Making audio needs the Mac."); return; }
      goBtn.disabled = true;
      setMsg("Queued.");
      fetch("/api/reading/audio/render", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: file, voice: voice, limitSeconds: limitSeconds || 0 })
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j || !j.ok) { goBtn.disabled = false; setMsg((j && j.message) || "Could not start."); return; }
        poll();
      }).catch(function (e) { goBtn.disabled = false; setMsg((e && e.message) || "no connection"); });
    }

    goBtn.addEventListener("click", function () {
      if (!lastEst) { estimate(); return; }
      if (!lastEst.long) { makeAudio(0); return; }
      askEl.textContent = "That is " + lastEst.minutes + " min, about " + lastEst.cost + ".";
      listenEl.dataset.confirm = "1";
    });

    document.getElementById("rl-listen-confirm").addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest(".rl-listen-act") : null;
      if (!b) return;
      if (b.dataset.a === "cancel") { listenEl.dataset.confirm = "0"; return; }
      makeAudio(b.dataset.a === "first" ? RL.longSeconds : 0);
    });

    voiceSel.addEventListener("change", function () {
      voice = voiceSel.value;
      voiceText.textContent = VOICE_LABELS[voice] || voice;
      try { localStorage.setItem("rl-voice", voice); } catch (e) {}
      listenEl.dataset.confirm = "0";
      setMsg("");
      estimate();
    });

    moreBtn.addEventListener("click", function () { makeBox.hidden = false; estimate(); });

    listenToggle = function () {
      var on = listenEl.dataset.open !== "1";
      listenEl.dataset.open = on ? "1" : "0";
      listenBtn.setAttribute("aria-expanded", String(on));
      if (!on) return;
      if (!makeBox.hidden) estimate();
      // A render started before a reload is still going on the server.
      fetch("/api/reading/audio/state?f=" + encodeURIComponent(file) + "&voice=" + encodeURIComponent(voice))
        .then(function (r) { return r.json(); })
        .then(function (j) { if (j && (j.state === "queued" || j.state === "running")) { goBtn.disabled = true; poll(); } })
        .catch(function () {});
    };
    listenBtn.addEventListener("click", listenToggle);
    // ── the player ──
    // The <audio> element is still the engine and is still what the browser
    // hands to the lock screen; everything visible is ours. He listens on a
    // walk, so the controls that matter are the ones a thumb finds without
    // looking: back fifteen, the sentence either side, and a play button big
    // enough to hit.
    var wrap = document.getElementById("rl-audio");
    var au = document.getElementById("rl-audio-el");
    var nameEl = document.getElementById("rl-audio-name");
    var speeds = document.getElementById("rl-speeds");
    var playBtn = document.getElementById("rl-audio-play");
    var seekEl = document.getElementById("rl-audio-seek");
    var atEl = document.getElementById("rl-audio-at");
    var leftEl = document.getElementById("rl-audio-left");
    var closeBtn = document.getElementById("rl-audio-close");

    var cues = [], cueStarts = [], blocks = [], sentBy = {};
    var curCue = -1, curBlock = -1, curSpans = [];
    var sentenceMode = false, posKeyAudio = "", playingVoice = "", scrubbing = false;

    // The bar is not a fixed height: an error line appears, and the Delete
    // confirm and the Replace field swap in. Measure it so the player sits on
    // it, never over it.
    function measureBar() {
      document.documentElement.style.setProperty("--rl-bar-h",
        Math.round(bar.getBoundingClientRect().height) + "px");
      document.documentElement.style.setProperty("--rl-audio-h",
        wrap.hidden ? "0px" : Math.round(wrap.getBoundingClientRect().height) + "px");
    }
    measureBar();
    window.addEventListener("resize", measureBar);

    function fmt(sec) {
      if (!isFinite(sec) || sec < 0) sec = 0;
      var n = Math.round(sec), h = Math.floor(n / 3600);
      var m = Math.floor((n % 3600) / 60), s = n % 60;
      return (h ? h + ":" + ("0" + m).slice(-2) : String(m)) + ":" + ("0" + s).slice(-2);
    }

    var rate = 1;
    try { rate = parseFloat(localStorage.getItem("rl-audio-rate") || "1") || 1; } catch (e) {}
    function paintRate() {
      [].forEach.call(speeds.querySelectorAll("button"), function (b) {
        b.setAttribute("aria-pressed", parseFloat(b.dataset.r) === rate ? "true" : "false");
      });
      au.playbackRate = rate;
      position();
    }
    speeds.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("button") : null;
      if (!b) return;
      rate = parseFloat(b.dataset.r);
      try { localStorage.setItem("rl-audio-rate", String(rate)); } catch (e2) {}
      paintRate();
    });

    // A cue's i is an index into this list. reading-audio.ts counts the same
    // four tags off the same rendered HTML, which is what keeps them in step.
    function readBlocks() { blocks = [].slice.call(document.querySelectorAll(BLOCK_SEL)); }

    // Every span carrying a given block and sentence, so a sentence that runs
    // through a link or a highlight lights up in one piece.
    function readSentences() {
      sentBy = {};
      var all = bodyEl.querySelectorAll("span.rl-sent");
      for (var k = 0; k < all.length; k++) {
        var key = all[k].dataset.i + ":" + all[k].dataset.s;
        (sentBy[key] = sentBy[key] || []).push(all[k]);
      }
    }

    // Swept off the document rather than off the pointers. Putting the body
    // back the way it was found is the whole contract of Close, and a pointer
    // that has drifted (a rewrap, a rendering swapped for another) would leave
    // a hairline behind on a page nothing is playing on.
    function clearMarks() {
      var was = bodyEl.querySelectorAll(".rl-said, .rl-now");
      for (var k = 0; k < was.length; k++) was[k].classList.remove("rl-said", "rl-now");
      curBlock = -1; curSpans = [];
    }

    // Mark cue k, and let the follower know what is live. Split from the timing
    // so a rewrap after a highlight can repaint without pretending the playhead
    // moved.
    function paintCue(scroll) {
      var c = curCue >= 0 ? cues[curCue] : null;
      var wasBlock = curBlock, wasSpans = curSpans;
      var bi = c ? c.i : -1;
      var spans = c && sentenceMode ? (sentBy[c.i + ":" + c.s] || []) : [];

      if (wasBlock !== bi && wasBlock >= 0 && blocks[wasBlock]) blocks[wasBlock].classList.remove("rl-said");
      for (var k = 0; k < wasSpans.length; k++) wasSpans[k].classList.remove("rl-now");
      curBlock = bi; curSpans = spans;
      if (bi >= 0 && blocks[bi]) blocks[bi].classList.add("rl-said");
      for (var j = 0; j < spans.length; j++) spans[j].classList.add("rl-now");

      var live = spans[0] || (bi >= 0 ? blocks[bi] : null);
      if (scroll === "jump") follower.jump(live);
      else follower.show(live);
    }
    remarkSentences = function () { readSentences(); paintCue(false); };

    function markAt(k, how) {
      if (k === curCue) { if (how === "jump") paintCue("jump"); return; }
      curCue = k;
      paintCue(how);
    }

    function cueAt(t) {
      var lo = 0, hi = cueStarts.length - 1, found = -1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (cueStarts[mid] <= t) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      return found;
    }

    // ── where he is in it ──
    // Kept in two places on purpose. localStorage is the fine pointer for this
    // browser; the note is the coarse one every device can see, and it is what
    // survives the service worker handing him yesterday's copy of the page.
    var posSaveAt = 0, noteSaveAt = 0, noteSaved = 0;

    function keepPosition(force) {
      if (!posKeyAudio || !(au.currentTime > 0)) return;
      var now = Date.now();
      if (!force && now - posSaveAt < 3000) return;
      posSaveAt = now;
      try { localStorage.setItem(posKeyAudio, String(Math.round(au.currentTime))); } catch (e) {}
      // The note is the coarse pointer, and writing it is rewriting a file in
      // his vault: once a minute while the voice runs, and then whenever he
      // actually leaves — pause, Close, the tab going away. An hour of
      // listening costs the note sixty writes instead of seven hundred, and the
      // number he comes back to is never more than a minute stale.
      if (!playingVoice) return;
      if (!force && (now - noteSaveAt < 60000 || Math.abs(au.currentTime - noteSaved) < 20)) return;
      noteSaveAt = now;
      noteSaved = au.currentTime;
      var body = { file: file, voice: playingVoice, seconds: Math.round(au.currentTime) };
      if (!rlOnline()) { rlQueueAdd("/api/reading/audio/at", body, "audio-at"); return; }
      var payload = JSON.stringify(body);
      if (force && navigator.sendBeacon) {
        try {
          if (navigator.sendBeacon("/api/reading/audio/at", new Blob([payload], { type: "application/json" }))) return;
        } catch (e) {}
      }
      fetch("/api/reading/audio/at", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: payload, keepalive: true
      }).catch(function () {});
    }
    window.addEventListener("pagehide", function () { keepPosition(true); });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") keepPosition(true);
    });

    // ── the lock screen ──
    // This is where he actually is when it matters: a phone in a pocket, on a
    // walk, with AirPods in. Without this the controls there do nothing useful
    // and a double tap skips to a track that does not exist.
    function media(label) {
      if (!("mediaSession" in navigator)) return;
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: RL.title || "Reading",
          artist: label || "",
          album: "Reading",
          artwork: [{ src: "/static/reading-icon-512.png", sizes: "512x512", type: "image/png" }]
        });
      } catch (e) {}
      var acts = [
        ["play", function () { play(); }],
        ["pause", function () { au.pause(); }],
        ["seekbackward", function (d) { nudge(-(d && d.seekOffset ? d.seekOffset : 15)); }],
        ["seekforward", function (d) { nudge(d && d.seekOffset ? d.seekOffset : 15); }],
        ["seekto", function (d) { if (d && typeof d.seekTime === "number") seek(d.seekTime, true); }],
        ["previoustrack", function () { step(-1); }],
        ["nexttrack", function () { step(1); }]
      ];
      acts.forEach(function (a) {
        try { navigator.mediaSession.setActionHandler(a[0], a[1]); } catch (e) {}
      });
    }

    function position() {
      if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
      if (!(au.duration > 0)) return;
      try {
        navigator.mediaSession.setPositionState({
          duration: au.duration,
          playbackRate: au.playbackRate || 1,
          position: Math.min(au.currentTime, au.duration)
        });
      } catch (e) {}
    }

    // ── transport ──
    function play() {
      var p = au.play();
      if (p && p.catch) p.catch(function () {});
    }
    function paintPlaying() {
      var on = !au.paused && !au.ended;
      playBtn.dataset.on = on ? "1" : "0";
      playBtn.setAttribute("aria-label", on ? "Pause" : "Play");
      playBtn.setAttribute("title", on ? "Pause" : "Play");
      if (onAudioState) onAudioState();
      if ("mediaSession" in navigator) {
        try { navigator.mediaSession.playbackState = on ? "playing" : "paused"; } catch (e) {}
      }
    }
    function seek(t, andPlay) {
      if (!(au.duration > 0)) return;
      au.currentTime = Math.max(0, Math.min(t, au.duration - 0.2));
      if (cueStarts.length) markAt(cueAt(au.currentTime), "jump");
      paintTime();
      if (andPlay) play();
    }
    function nudge(by) { seek(au.currentTime + by, false); }

    // The sentence before or after the one being spoken. Going back inside the
    // current sentence first would mean pressing it twice to get anywhere, so
    // "previous" means the previous one unless he is more than a moment into
    // this one, which is what every other player does with a track.
    function step(dir) {
      if (!cueStarts.length) return;
      var k = cueAt(au.currentTime);
      if (dir < 0) k = (k > 0 && au.currentTime - cueStarts[k] < 1.5) ? k - 1 : Math.max(k, 0);
      else k = Math.min(k + 1, cueStarts.length - 1);
      if (k < 0) k = 0;
      seek(cueStarts[k] + 0.01, !au.paused);
      markAt(k, "jump");
    }

    playBtn.addEventListener("click", function () { if (au.paused) play(); else au.pause(); });
    document.getElementById("rl-audio-back").addEventListener("click", function () { nudge(-15); });
    document.getElementById("rl-audio-fwd").addEventListener("click", function () { nudge(15); });
    document.getElementById("rl-audio-prev").addEventListener("click", function () { step(-1); });
    document.getElementById("rl-audio-next").addEventListener("click", function () { step(1); });

    seekEl.addEventListener("input", function () {
      scrubbing = true;
      if (au.duration > 0) {
        var t = au.duration * (seekEl.value / 10000);
        atEl.textContent = fmt(t);
        leftEl.textContent = "-" + fmt(au.duration - t);
      }
    });
    seekEl.addEventListener("change", function () {
      scrubbing = false;
      if (au.duration > 0) seek(au.duration * (seekEl.value / 10000), false);
    });

    function paintTime() {
      if (!(au.duration > 0)) { atEl.textContent = "0:00"; leftEl.textContent = "0:00"; return; }
      if (!scrubbing) seekEl.value = String(Math.round(au.currentTime / au.duration * 10000));
      atEl.textContent = fmt(au.currentTime);
      leftEl.textContent = "-" + fmt(au.duration - au.currentTime);
    }

    au.addEventListener("play", function () { paintPlaying(); position(); });
    au.addEventListener("pause", function () { paintPlaying(); keepPosition(true); });
    au.addEventListener("loadedmetadata", function () { paintTime(); position(); measureBar(); });
    au.addEventListener("ratechange", position);
    au.addEventListener("seeked", position);

    au.addEventListener("timeupdate", function () {
      // Pausing fires one more of these after the fact, which would put the
      // marks back on a body that has just been handed back to the reader.
      if (wrap.hidden) return;
      // Being read to is reading: while the voice runs, the playhead is how far
      // in he is, and it is usually further than the scroll.
      if (au.duration > 0) reportProgress(au.currentTime / au.duration * 100);
      paintTime();
      if (cueStarts.length) markAt(cueAt(au.currentTime), false);
      keepPosition(false);
    });
    au.addEventListener("ended", function () {
      paintPlaying();
      follower.clear();
      try { localStorage.removeItem(posKeyAudio); } catch (e) {}
    });

    // Put it away. The body goes back to being the body — no spans, no marks,
    // no padding held for a player that is not there.
    function closePlayer() {
      keepPosition(true);
      wrap.hidden = true;
      au.pause();
      clearMarks();
      curCue = -1;
      follower.clear();
      unwrapSentences();
      bodyEl.classList.remove("rl-audio-on");
      wrap.hidden = true;
      delete document.body.dataset.audio;
      [].forEach.call(savedBox.querySelectorAll(".rl-saved-row"), function (r) { r.dataset.playing = "0"; });
      measureBar();
      if (onAudioState) onAudioState();
    }
    closeBtn.addEventListener("click", closePlayer);

    // The saved row says the whole sentence — voice, provider, minutes, the day
    // it was made. The player says as little as will still tell him what he is
    // listening to, because Close has to fit on the same line as this and the
    // rest of it is already on the row in the panel above.
    function shortLabel(row) {
      var secs = Number(row.dataset.secs) || 0;
      var at = Number(row.dataset.at) || 0;
      // A page out of the worker's cache can predate these attributes; fall
      // back to the row's own sentence rather than saying " · 0 min".
      if (!row.dataset.label || !secs) {
        var el = row.querySelector(".rl-saved-name");
        return el ? el.textContent.split("Saved: ").join("") : "";
      }
      var out = firstName(row.dataset.label) + " · " + Math.max(1, Math.round(secs / 60)) + " min";
      // Same rule the saved row uses for "at 12:34", so the two never disagree.
      if (at > 20 && at < secs - 10) out += " · at " + rlClock(at);
      return out;
    }

    function playRow(row) {
      var url = row.dataset.url;
      var name = row.querySelector(".rl-saved-name");
      var label = name ? name.textContent.split("Saved: ").join("") : "";
      nameEl.textContent = shortLabel(row);
      playingVoice = row.dataset.voice || "";
      [].forEach.call(savedBox.querySelectorAll(".rl-saved-row"), function (r) {
        r.dataset.playing = r === row ? "1" : "0";
      });
      media(VOICE_LABELS[playingVoice] || label);

      if (au.getAttribute("src") !== url) {
        au.src = url;
        posKeyAudio = "rl-audio-pos:" + url;
        cues = []; cueStarts = []; sentenceMode = false;
        clearMarks(); curCue = -1; follower.clear();
        unwrapSentences();
        fetch(row.dataset.cues).then(function (r) { return r.json(); }).then(function (j) {
          // v1 sidecars have one cue per paragraph and no sentence in them; the
          // page stays at paragraph resolution for those rather than pretending
          // the first sentence of each is the whole thing.
          sentenceMode = (j.v || 1) >= 2;
          cues = (j.cues || []).map(function (c) { return { i: c.i, s: c.s || 0, t: c.t }; });
          cueStarts = cues.map(function (c) { return c.t; });
          if (sentenceMode) wrapSentences();
          readBlocks();
          readSentences();
          bodyEl.classList.add("rl-audio-on");
          if (cueStarts.length) markAt(cueAt(au.currentTime), "jump");
        }).catch(function () { readBlocks(); });

        // Where he stopped: this browser's pointer and the note's, whichever is
        // further, and never the very end of it.
        var here = 0, there = Number(row.dataset.at) || 0;
        try { here = parseFloat(localStorage.getItem(posKeyAudio) || "0") || 0; } catch (e) {}
        var at = Math.max(here, there);
        au.addEventListener("loadedmetadata", function once() {
          au.removeEventListener("loadedmetadata", once);
          if (at > 2 && at < au.duration - 3) { au.currentTime = at; paintTime(); }
        });
      }
      wrap.hidden = false;
      document.body.dataset.audio = "1";
      measureBar();
      paintRate();
      paintPlaying();
      paintTime();
      play();
    }

    savedBox.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest(".rl-saved-act") : null;
      if (!b || b.dataset.a !== "play") return;
      playRow(b.closest(".rl-saved-row"));
    });

    // Tapping a sentence reads from there; tapping a paragraph that has no
    // sentence spans (an old rendering) still moves to the paragraph.
    bodyEl.addEventListener("click", function (e) {
      if (!cues.length || !e.target.closest) return;
      var sel = document.getSelection();
      if (sel && !sel.isCollapsed) return;
      if (e.target.closest("mark.rl-mark") || e.target.closest("a")) return;
      var block = e.target.closest(BLOCK_SEL);
      if (!block) return;
      var idx = blocks.indexOf(block);
      if (idx < 0) return;
      var span = sentenceMode ? e.target.closest(".rl-sent") : null;
      var want = span ? Number(span.dataset.s) : 0;
      var fallback = -1;
      for (var k = 0; k < cues.length; k++) {
        if (cues[k].i !== idx) continue;
        if (fallback < 0) fallback = k;
        if (cues[k].s === want) { fallback = k; break; }
      }
      if (fallback < 0) return;
      seek(cues[fallback].t + 0.01, true);
      markAt(fallback, "jump");
    });

    togglePlay = function () {
      if (wrap.hidden) return false;
      if (au.paused) play(); else au.pause();
      return true;
    };
    stepSentence = function (dir) {
      if (wrap.hidden || !cueStarts.length) return false;
      step(dir);
      return true;
    };

    // The header asks for the most useful thing available where he is standing,
    // in this order: if the player is up it is the play button, so pause and
    // resume it; if a rendering is saved it starts that one, and playRow
    // already begins it at whichever of the note's pointer and this browser's
    // is further, which is the whole point of not having to go up to the panel;
    // and only when there is nothing made yet does it do what the Listen
    // control at the top does, and put that control where he can see it.
    headerListen = function () {
      if (togglePlay()) return;
      var row = savedBox.querySelector(".rl-saved-row");
      if (row) { playRow(row); return; }
      if (listenEl.dataset.open !== "1") listenToggle();
      try { listenEl.scrollIntoView({ block: "center", behavior: calmMotion() ? "auto" : "smooth" }); }
      catch (e) { listenEl.scrollIntoView(); }
    };
    audioState = function () {
      if (wrap.hidden) return "off";
      return (au.paused || au.ended) ? "paused" : "playing";
    };

    // A page served from the worker's cache can be older than the rendering it
    // is describing: he listened to twenty minutes of the Hyperliquid piece,
    // came back, and was offered to make audio that already existed. The rows
    // are the server's answer, so ask the server for them rather than trusting
    // the HTML that arrived.
    (function refreshSaved() {
      if (!rlOnline()) return;
      fetch("/api/reading/audio/state?f=" + encodeURIComponent(file))
        .then(function (r) { return r.json(); })
        .then(function (j) { if (j && j.ok) paintSaved(j.saved); })
        .catch(function () {});
    })();
  }


  // The same count as the header line, where his thumb is. A word, not a badge.
  var queuedEl = document.getElementById("rl-queued");
  if (queuedEl) {
    rlOnQueue(function (rows) {
      var n = rows.length;
      queuedEl.hidden = n === 0;
      if (n) queuedEl.textContent = n + " waiting";
    });
  }

  // ── keep offline ──
  // A PDF is eleven megabytes and a rendering is a few, so neither is cached
  // just because the page was opened. The word appears only where there is
  // something to keep and only where a worker can keep it, and it says what it
  // is holding, because the size is the whole reason this is a decision.
  var keepBtn = document.getElementById("rl-keep");
  if (keepBtn && RL.heavy && RL.heavy.length) {
    var keepBusy = false;
    function paintKeep(r) {
      var on = Boolean(r && r.kept);
      keepBtn.hidden = false;
      keepBtn.setAttribute("aria-pressed", String(on));
      keepBtn.textContent = on ? "Kept " + rlBytes(r.bytes) : "Keep offline";
    }
    rlKept(RL.heavy).then(function (r) { if (r) paintKeep(r); });
    keepBtn.addEventListener("click", function () {
      if (keepBusy) return;
      var on = keepBtn.getAttribute("aria-pressed") === "true";
      if (!on && !rlOnline()) { errEl.textContent = "Offline. Keeping a file needs the Mac."; return; }
      keepBusy = true;
      keepBtn.textContent = on ? "Removing…" : "Keeping…";
      (on ? rlUnkeep(RL.heavy) : rlKeep(RL.heavy)).then(function () {
        return rlKept(RL.heavy);
      }).then(function (r) {
        keepBusy = false;
        paintKeep(r);
      }, function () {
        keepBusy = false;
        errEl.textContent = "Could not change what is kept.";
        keepBtn.textContent = on ? "Kept" : "Keep offline";
      });
    });
  }

  // Asked of the machine rather than assumed. A reveal that slides and a page
  // that flies to the top are both movement he did not ask for, and he may
  // have said so at the system level.
  function calmMotion() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch (e) { return false; }
  }

  // ── the header that follows him down ──
  // What he asked for: "if you scroll back up, then i want to see a header
  // somehow so that the page i am reading is clear, and clicking on it - we go
  // right back up." So: nothing at all while the h1 is on the screen, because
  // the h1 already is this header and louder; then the rule every phone reader
  // has converged on — out of the way while he reads forward, back the instant
  // he scrolls up. Reading forward is a thing you do for minutes at a time and
  // a bar across the top of it is a bar across a line of the text; scrolling
  // up is almost always a question ("what is this", "where was I"), and the
  // answer to that question is exactly what this holds.
  var stick = document.getElementById("rl-sticky");
  if (stick) (function () {
    var row = document.getElementById("rl-sticky-row");
    var titleBtn = document.getElementById("rl-sticky-back");
    var listenTop = document.getElementById("rl-sticky-listen");
    var tagTop = document.getElementById("rl-sticky-tag");
    var tagList = document.getElementById("rl-sticky-taglist");
    var tagBox = document.getElementById("rl-sticky-tag-input");
    var h1 = document.querySelector(".rl-h1");

    // A thumb resting on a phone is never still, and a flick that ends has a
    // few pixels of overshoot in it. Twenty-four is under one line of the body
    // text (18px at 1.6, so 29), which makes the rule easy to say: nudge it up
    // by less than a line and nothing happens; move it by a line and the header
    // is there. Small enough that a deliberate scroll up never feels ignored.
    var STEP = 24;
    var shown = false, lastY = window.scrollY, anchorY = window.scrollY, queued = false;

    function paint(on) {
      if (on === shown) return;
      shown = on;
      stick.dataset.show = on ? "1" : "0";
      // Whatever he was half-way through typing up there is not a thing to
      // leave open off the screen.
      if (!on) tagOpen(false);
    }

    // The real title is still on the screen, so there is nothing to say. The
    // fallback matters for the wait page's shape and for a note with no h1.
    function past() {
      return h1 ? h1.getBoundingClientRect().bottom < 0 : window.scrollY > 240;
    }

    // Stopped at the end. There is no text below to cover, and the thing he
    // most likely wants next is the way back up.
    function atBottom() {
      var doc = document.documentElement;
      return window.scrollY + window.innerHeight >= doc.scrollHeight - 4;
    }

    function look() {
      queued = false;
      var y = Math.max(0, window.scrollY);
      var d = y - lastY;
      lastY = y;
      if (!past()) { anchorY = y; paint(false); return; }
      if (atBottom()) { anchorY = y; paint(true); return; }
      if (!d) return;
      var run = y - anchorY;
      // He has turned round. The run starts again from the turn, so scrolling
      // up needs the same twenty-four pixels whether or not he had been going
      // down for a while first.
      if ((d > 0 && run < 0) || (d < 0 && run > 0)) { anchorY = y - d; run = d; }
      if (run > STEP) { anchorY = y; paint(false); }
      else if (run < -STEP) { anchorY = y; paint(true); }
    }

    function later() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(look);
    }
    window.addEventListener("scroll", later, { passive: true });
    window.addEventListener("resize", later);
    look();

    // ── the way back up ──
    // The whole line, not a chevron: the title of the thing is the most
    // obvious home on a reading page, and a second control for it would be a
    // second control. Anything in the right-hand group is a control and is
    // left alone.
    function toTop() {
      try { window.scrollTo({ top: 0, behavior: calmMotion() ? "auto" : "smooth" }); }
      catch (e) { window.scrollTo(0, 0); }
    }
    row.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest(".rl-sticky-acts")) return;
      toTop();
    });
    titleBtn.addEventListener("click", toTop);

    // ── Listen, from where he is ──
    if (listenTop) {
      listenTop.addEventListener("click", function () { if (headerListen) headerListen(); });
      // The word is the next thing it will do, which is the only labelling of a
      // play button anyone has ever read correctly.
      onAudioState = function () {
        var st = audioState ? audioState() : "off";
        listenTop.textContent = st === "playing" ? "Pause" : st === "paused" ? "Play" : "Listen";
        listenTop.dataset.on = st === "playing" ? "1" : "0";
      };
      onAudioState();
    }

    // ── tagging, from where he is ──
    // A second view of the one tag row: the same chips, tapped to drop, and an
    // input that goes to the same addTag. renderTags repaints both.
    var known = (RL.tags || []).slice();

    function paintTagList(list) {
      tagList.innerHTML = "";
      list.forEach(function (t) {
        var b = document.createElement("button");
        b.type = "button"; b.className = "rl-tag"; b.dataset.t = t; b.textContent = t;
        tagList.appendChild(b);
      });
    }

    function tagOpen(on) {
      stick.dataset.tag = on ? "1" : "0";
      tagTop.setAttribute("aria-expanded", String(on));
      if (!on) { tagBox.value = ""; tagBox.blur(); return; }
      paintTagList(known);
      tagBox.focus();
    }

    onTags = function (list) {
      known = list;
      if (stick.dataset.tag === "1") paintTagList(list);
    };

    tagTop.addEventListener("click", function () {
      tagOpen(stick.dataset.tag !== "1");
    });
    tagList.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest(".rl-tag") : null;
      if (b) removeTag(b.dataset.t);
    });
    tagBox.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); tagOpen(false); return; }
      if (e.key !== "Enter") return;
      e.preventDefault();
      var v = tagBox.value.trim();
      if (!v) { tagOpen(false); return; }
      tagBox.value = "";
      addTag(v);
    });
  })();

  document.addEventListener("keydown", function (e) {
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key;
    if (keysEl.classList.contains("on")) {
      if (k === "Escape" || k === "?") { e.preventDefault(); keysOpen(false); }
      return;
    }
    if (awaitingDelete) {
      awaitingDelete = false;
      if (k === "y") { e.preventDefault(); document.getElementById("rl-del-yes").click(); return; }
      askDelete(false);
    }
    if (k === "?") { e.preventDefault(); keysOpen(true); return; }
    if (k === "e") { e.preventDefault(); markDone(true); return; }
    if (k === "s") { e.preventDefault(); toggleStar(); return; }
    if (k === "n" || k === "]") { e.preventDefault(); goNeighbour(1); return; }
    if (k === "p" || k === "[") { e.preventDefault(); goNeighbour(-1); return; }
    if (k === "o") {
      var src = document.getElementById("rl-open");
      if (src) { e.preventDefault(); window.open(src.href, "_blank", "noopener"); }
      return;
    }
    if (k === "h") { e.preventDefault(); offerHighlight(); return; }
    if (k === "H") { e.preventDefault(); offerHighlightNote(); return; }
    if (k === "c") { e.preventDefault(); copyMarkdown(); return; }
    if (k === "f" && docFull) { e.preventDefault(); docFull(); return; }
    if (k === "v" && modeEl) { e.preventDefault(); setDocMode(mainEl.dataset.docMode === "pdf" ? "read" : "pdf", true); return; }
    if (k === "Escape" && docEl && docEl.classList.contains("rl-doc-pinned")) { e.preventDefault(); docUnpin(); return; }
    if (setEl && setEl.classList.contains("on")) {
      if (k === "Escape") { e.preventDefault(); settingsOpen(false); }
      return;
    }
    if (k === "l" && listenToggle) { e.preventDefault(); listenToggle(); return; }
    if (k === " " && togglePlay && togglePlay()) { e.preventDefault(); return; }
    if (k === "," && stepSentence && stepSentence(-1)) { e.preventDefault(); return; }
    if (k === "." && stepSentence && stepSentence(1)) { e.preventDefault(); return; }
    if (k === "d") { e.preventDefault(); askDelete(true); awaitingDelete = true; return; }
    if (k === "Escape" || k === "b") { e.preventDefault(); location.href = "/reading"; return; }
    if (k >= "0" && k <= "7") { e.preventDefault(); setRating(parseInt(k, 10)); return; }
  });

  // ── the player at the top ──
  // Reading along means the picture has to still be there, so once its slot has
  // left the top of the screen the picture is pinned there and shrunk to about
  // a quarter of the height, and the rest of the screen is words. The slot
  // stays its full size in the flow, so nothing below it moves when it shrinks.
  // Only the class is set here; every size is in reader.css, in vh, so a turn
  // of the phone or a URL bar sliding away re-answers it without being asked.
  var pinEl = document.getElementById("rl-player");
  if (pinEl) (function () {
    var hideBtn = document.getElementById("rl-pin-hide");
    var pinned = false, put = false, wanted = true, queued = false;

    function paint() {
      var on = wanted && pinned;
      pinEl.classList.toggle("rl-pin", on);
      pinEl.classList.toggle("rl-pin-off", on && put);
      // Whether the picture is at the top of the screen, which is a different
      // question from whether he asked for the shrink-and-Hide behaviour:
      // `position: sticky` is in the stylesheet and the setting never turns it
      // off. The sticky header asks this one, because what matters to it is
      // that there is already a picture up there saying what this is.
      pinEl.classList.toggle("rl-pin-top", pinned);
      if (hideBtn) hideBtn.textContent = put ? "Show" : "Hide";
    }
    function look() {
      queued = false;
      var now = pinEl.getBoundingClientRect().top <= 0;
      if (now === pinned) return;
      pinned = now;
      // back at the top: the player is in the flow again, and a Hide that
      // belonged to that pass down the page is spent
      if (!pinned) put = false;
      paint();
    }
    function later() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(look);
    }
    window.addEventListener("scroll", later, { passive: true });
    window.addEventListener("resize", later);
    look();
    requestAnimationFrame(function () { pinEl.classList.add("rl-pin-ready"); });

    if (hideBtn) hideBtn.addEventListener("click", function () { put = !put; paint(); });

    // Whether the player pins at all is a setting the whole site shares, when
    // the store is there; on its own this page pins, which is what the setting
    // defaults to. The store may be defined after this file, so ask twice.
    function ask() {
      var S = window.RLSettings;
      if (!S) return false;
      if (S.on) S.on("pin-player", function (v) { wanted = v !== false; paint(); });
      else if (S.get) { wanted = S.get("pin-player", true) !== false; paint(); }
      return true;
    }
    if (!ask()) setTimeout(ask, 0);
  })();

  // ── transcript following the player ──
  var cuesEl = document.getElementById("rl-cues");
  if (!cuesEl) return;
  var cueEls = [].slice.call(cuesEl.querySelectorAll(".rl-cue"));
  var starts = cueEls.map(function (el) { return parseFloat(el.dataset.t); });

  var player = null, timer = null, active = -1;

  // The furthest point the note knows, put into the player as soon as it can
  // say how long the video is. Cued, not played: seekTo on a player that has
  // not started would start it, so the pause goes with it, and the browser's
  // own autoplay policy is the second belt.
  var videoResumed = false;
  function resumeVideo() {
    if (videoResumed) return;
    videoResumed = true;
    if (!unread || !(serverPct > 0 && serverPct < 100)) return;
    if (!player || !player.getDuration || !player.seekTo) return;
    var dur = player.getDuration();
    if (!(dur > 0)) return;
    player.seekTo(dur * serverPct / 100, true);
    if (player.pauseVideo) player.pauseVideo();
    sayResume(serverPct);
    // the player answers with the old time for a moment after a seek, so the
    // cue under it is marked once it has caught up
    setTimeout(tick, 600);
  }

  window.onYouTubeIframeAPIReady = function () {
    player = new YT.Player("rl-yt", {
      host: "https://www.youtube-nocookie.com",
      videoId: RL.videoId,
      // controls on, and said out loud: a picture he cannot pause is not a player
      playerVars: { enablejsapi: 1, playsinline: 1, rel: 0, modestbranding: 1, controls: 1 },
      events: {
        onReady: function () { resumeVideo(); tick(); },
        onStateChange: function (e) {
          if (e.data === 1) { if (!timer) timer = setInterval(tick, 500); }
          else { if (timer) { clearInterval(timer); timer = null; } tick(); }
        }
      }
    });
  };

  function indexAt(t) {
    var lo = 0, hi = starts.length - 1, found = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (starts[mid] <= t) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return found;
  }
  function tick() {
    if (!player || !player.getCurrentTime) return;
    // Watching is reading: how far into the video he is, whether or not the
    // cue under the player has changed.
    var dur = player.getDuration ? player.getDuration() : 0;
    if (dur > 0) reportProgress(player.getCurrentTime() / dur * 100);
    var i = indexAt(player.getCurrentTime());
    if (i === active) return;
    if (active >= 0 && cueEls[active]) cueEls[active].classList.remove("on");
    active = i;
    if (i < 0) { follower.clear(); return; }
    cueEls[i].classList.add("on");
    // The same follower the voice uses, so "Scroll to sync" means one thing on
    // this page and the button back is the same button.
    follower.show(cueEls[i]);
  }

  cuesEl.addEventListener("click", function (e) {
    // a click that ended a text selection is a highlight, not a seek
    var sel = document.getSelection();
    if (sel && !sel.isCollapsed) return;
    var li = e.target.closest ? e.target.closest(".rl-cue") : null;
    if (!li || !player || !player.seekTo) return;
    player.seekTo(parseFloat(li.dataset.t), true);
    player.playVideo();
    // mark it at once: playback can be refused (a phone on low power, a
    // browser holding back autoplay) and the tap should still land somewhere
    setTimeout(tick, 250);
  });
})();
