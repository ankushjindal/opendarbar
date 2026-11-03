// The reading list: filters, chips, search, keyboard, the add box.
// Loaded after common.js, which owns the theme switch and the ? overlay.
(function () {
  var listEl = document.getElementById("rl-list");
  var items = [].slice.call(listEl.querySelectorAll(".rl-item")).map(function (li) {
    var row = li.querySelector(".rl-row");
    return {
      el: li,
      q: ((row.textContent || "") + " " + (li.dataset.tags || "")).toLowerCase().replace(/\s+/g, " "),
      tags: (li.dataset.tags || "").toLowerCase().split(" ").filter(Boolean),
      meta: li.querySelector(".rl-meta"),
      prog: li.querySelector(".rl-prog")
    };
  });
  var state = { kind: "all", status: "unread", tag: "", len: "" };
  var terms = [], tagTerms = [], ratingTest = null, kindTerm = "";
  var urlQ = "";
  // ?theme=dark is the server's forced-dark override, not a filter; it is the
  // one thing in the query string the page did not put there and has to keep.
  var urlTheme = "";

  try {
    var saved = JSON.parse(localStorage.getItem("rl-filter") || "null");
    if (saved && saved.kind && saved.status) state = saved;
    // "Done" was renamed Archive; the stored value is unchanged so old saved
    // filters keep working, and an "archive" value maps onto it too
    if (state.status === "archive" || state.status === "archived") state.status = "done";
    // a filter saved before tags and length existed has neither key
    state.tag = state.tag || ""; state.len = state.len || "";
  } catch (e) {}

  // The address bar beats the last filter he used here. A link is a thing he
  // meant: one he sent himself, or one this page wrote a moment ago. Any one of
  // the five keys hands the whole state to the URL, so a link that says
  // ?status=done is the archive with everything else back at its default; a
  // bare /reading (the ?t= cache-buster counts as bare) leaves the stored
  // filter alone.
  try {
    var qs = new URLSearchParams(location.search);
    if (qs.has("kind") || qs.has("status") || qs.has("tag") || qs.has("len") || qs.has("q")) {
      state.kind = qs.get("kind") || "all";
      state.status = qs.get("status") || "unread";
      state.tag = (qs.get("tag") || "").toLowerCase();
      state.len = qs.get("len") || "";
      urlQ = qs.get("q") || "";
    }
    urlTheme = qs.get("theme") || "";
  } catch (e) {}

  // "words #tag r:5+ kind:book" all narrow together
  function parseQuery(raw) {
    terms = []; tagTerms = []; ratingTest = null; kindTerm = "";
    raw.toLowerCase().split(/\s+/).filter(Boolean).forEach(function (tok) {
      if (tok.charAt(0) === "#" && tok.length > 1) { tagTerms.push(tok.slice(1)); return; }
      var km = /^kind:([a-z]+)$/.exec(tok);
      if (km) { kindTerm = km[1].replace(/s$/, ""); return; }
      var m = /^r:(\d|none)(\+?)$/.exec(tok);
      if (m) {
        if (m[1] === "none" || m[1] === "0") ratingTest = function (r) { return !r; };
        else if (m[2]) { var lo = parseInt(m[1], 10); ratingTest = function (r) { return r >= lo; }; }
        else { var eq = parseInt(m[1], 10); ratingTest = function (r) { return r === eq; }; }
        return;
      }
      terms.push(tok);
    });
  }

  // Kind and status are the pool: what could be on this page at all. The tag
  // chips are counted over this and nothing narrower, so the row does not
  // reshuffle under his finger as he types in the search box or taps a tag.
  function inScope(it) {
    var d = it.el.dataset;
    if (state.kind !== "all" && d.kind !== state.kind) return false;
    if (state.status === "unread" && d.status !== "unread") return false;
    // In progress is a slice of Unread: started, not finished, still in the queue
    if (state.status === "progress") {
      var p = parseInt(d.progress || "0", 10);
      if (d.status !== "unread" || !(p > 0 && p < 100)) return false;
    }
    if (state.status === "starred" && d.star !== "1") return false;
    if (state.status === "done" && d.status !== "read" && d.status !== "skipped") return false;
    return true;
  }

  function matches(it) {
    if (!inScope(it)) return false;
    var d = it.el.dataset;
    if (state.tag && it.tags.indexOf(state.tag) < 0) return false;
    // a row with no bucket (length unknown) never matches a pressed length chip
    if (state.len && d.len !== state.len) return false;
    for (var i = 0; i < terms.length; i++) if (it.q.indexOf(terms[i]) < 0) return false;
    for (var j = 0; j < tagTerms.length; j++) if (it.tags.indexOf(tagTerms[j]) < 0) return false;
    if (ratingTest && !ratingTest(parseInt(d.rating || "0", 10))) return false;
    if (kindTerm && d.kind !== kindTerm) return false;
    return true;
  }

  var tagsEl = document.getElementById("rl-tags");
  var tagsOpen = false;

  function escAttr(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // The tags on offer are the ones the rows in scope actually carry, counted
  // here rather than read from Reading/tags.md: the taxonomy lists tags nothing
  // in the queue has any more, and a chip that empties the list is worse than
  // no chip. Folded by default: on the phone eight tags were three lines of
  // chips before the first title, so the row shows one word, "tags", until he
  // asks. The tag he is standing on is always on the row so he can step off it.
  function renderTags() {
    var counts = {}, i, j;
    for (i = 0; i < items.length; i++) {
      if (!inScope(items[i])) continue;
      for (j = 0; j < items[i].tags.length; j++) {
        counts[items[i].tags[j]] = (counts[items[i].tags[j]] || 0) + 1;
      }
    }
    var names = Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a] || (a < b ? -1 : a > b ? 1 : 0);
    });
    var show = tagsOpen ? names.slice() : (state.tag ? [state.tag] : []);
    if (state.tag && show.indexOf(state.tag) < 0) show.push(state.tag);
    var html = show.map(function (t) {
      return '<button type="button" class="rl-chip" data-v="' + escAttr(t) + '"'
        + ' aria-pressed="' + (state.tag === t) + '">' + escAttr(t)
        + '<span class="rl-tag-n">' + (counts[t] || 0) + '</span></button>';
    }).join("");
    if (names.length > show.length || tagsOpen) {
      html += '<button type="button" class="rl-chip" data-more="1" aria-pressed="' + tagsOpen + '">'
        + (tagsOpen ? "fewer tags" : "tags") + '</button>';
    }
    tagsEl.innerHTML = html;
  }

  // Where he is looking belongs in the address bar, so a list can be reloaded,
  // linked, or sent to himself and come back the same. Defaults stay out of it,
  // which is also what retires the ?t= cache-buster: it is not one of the five
  // keys, so it does not survive the first apply().
  function syncUrl() {
    try {
      var p = new URLSearchParams();
      if (state.kind !== "all") p.set("kind", state.kind);
      if (state.status !== "unread") p.set("status", state.status);
      if (state.tag) p.set("tag", state.tag);
      if (state.len) p.set("len", state.len);
      var q = qEl ? qEl.value.trim() : "";
      if (q) p.set("q", q);
      if (urlTheme) p.set("theme", urlTheme);
      var qs = p.toString();
      history.replaceState(null, "", "/reading" + (qs ? "?" + qs : ""));
    } catch (e) {}
  }

  function apply() {
    var shown = 0;
    var archive = state.status === "done";
    for (var i = 0; i < items.length; i++) {
      var ok = matches(items[i]);
      items[i].el.hidden = !ok;
      if (ok) {
        shown++;
        // the action is whichever direction this row can still go
        var act = items[i].el.querySelector(".rl-quick-done");
        if (act) act.textContent = items[i].el.dataset.status === "unread" ? "done" : "unread";
        // a rating only means something once he has read the thing, and in the
        // archive the best-rated should surface first
        var pct = parseInt(items[i].el.dataset.progress || "0", 10);
        var part = pct > 0 && pct < 100;
        items[i].meta.textContent = archive
          ? items[i].meta.dataset.done
          : items[i].meta.dataset.unread + (part ? " \u00b7 " + pct + "% read" : "");
        if (items[i].prog) {
          items[i].prog.hidden = !part;
          if (part) items[i].prog.firstChild.style.width = pct + "%";
        }
        items[i].el.style.order = archive ? String(7 - parseInt(items[i].el.dataset.rating || "0", 10)) : "";
      }
    }
    document.getElementById("rl-empty").hidden = shown > 0;
    var label = state.status === "unread" ? " unread"
      : state.status === "progress" ? " in progress"
      : state.status === "starred" ? " starred" : " archived";
    document.getElementById("rl-count").textContent = shown + label;
    ["kind", "status", "len"].forEach(function (g) {
      var chips = document.querySelectorAll("#rl-" + g + " .rl-chip");
      for (var j = 0; j < chips.length; j++) {
        chips[j].setAttribute("aria-pressed", chips[j].dataset.v === state[g] ? "true" : "false");
      }
    });
    renderTags();
    syncUrl();
    try { localStorage.setItem("rl-filter", JSON.stringify(state)); } catch (e) {}
  }

  ["kind", "status"].forEach(function (g) {
    document.getElementById("rl-" + g).addEventListener("click", function (e) {
      var b = e.target.closest(".rl-chip");
      if (!b) return;
      state[g] = b.dataset.v;
      focusIdx = -1;
      apply();
    });
  });

  // Length and tag are the two that toggle: one of three lengths, one tag, and
  // tapping the pressed one is how you get back out of it.
  document.getElementById("rl-len").addEventListener("click", function (e) {
    var b = e.target.closest(".rl-chip");
    if (!b) return;
    state.len = state.len === b.dataset.v ? "" : b.dataset.v;
    focusIdx = -1;
    apply();
  });

  tagsEl.addEventListener("click", function (e) {
    var b = e.target.closest(".rl-chip");
    if (!b) return;
    if (b.dataset.more) { tagsOpen = !tagsOpen; renderTags(); return; }
    state.tag = state.tag === b.dataset.v ? "" : b.dataset.v;
    focusIdx = -1;
    apply();
  });

  var qEl = document.getElementById("rl-q");
  var hintEl = document.getElementById("rl-hint");
  var qTimer = null;
  function hint() { hintEl.classList.toggle("on", document.activeElement === qEl && !qEl.value); }
  qEl.addEventListener("focus", hint);
  qEl.addEventListener("blur", hint);
  qEl.addEventListener("input", function () {
    hint();
    clearTimeout(qTimer);
    qTimer = setTimeout(function () { parseQuery(qEl.value.trim()); apply(); }, 150);
  });
  qEl.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    qEl.value = ""; parseQuery(""); apply(); hint();
  });

  // Opening a row hands the reader the exact order it is looking at, filters
  // and search and the archive's rating order included, so next and previous
  // walk the list he can see rather than a fresh unfiltered one.
  function rememberOrder() {
    try {
      var archive = state.status === "done";
      var vis = items.filter(function (it) { return !it.el.hidden; }).slice();
      if (archive) {
        vis.sort(function (a, b) {
          return (parseInt(b.el.dataset.rating || "0", 10) - parseInt(a.el.dataset.rating || "0", 10));
        });
      }
      sessionStorage.setItem("rl-order", JSON.stringify(vis.map(function (it) {
        return it.el.querySelector(".rl-star").dataset.file;
      })));
    } catch (e) {}
  }

  listEl.addEventListener("click", function (e) {
    var open = e.target.closest ? e.target.closest(".rl-row") : null;
    if (open) { rememberOrder(); return; }
    var star = e.target.closest ? e.target.closest(".rl-star") : null;
    if (star) {
      e.preventDefault();
      var next = star.getAttribute("aria-pressed") !== "true";
      var paintStar = function (on) {
        star.disabled = false;
        star.setAttribute("aria-pressed", String(on));
        // the row keeps its place until the next load, so an accidental tap is
        // one tap to undo even while the Starred filter is on
        star.closest(".rl-item").dataset.star = on ? "1" : "0";
      };
      if (!rlOnline()) return holdStar(star, next, paintStar);
      star.disabled = true;
      fetch("/api/reading/status", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: star.dataset.file, star: next })
      }).then(function (r) { return r.json(); }).then(function (j) {
        paintStar(j && j.note ? j.note.starred : next);
      }).catch(function (e) {
        star.disabled = false;
        if (rlNetworkError(e)) holdStar(star, next, paintStar);
      });
      return;
    }

    var done = e.target.closest ? e.target.closest(".rl-quick-done") : null;
    if (!done) return;
    e.preventDefault();
    var row = done.closest(".rl-item");
    var next = row.dataset.status === "unread" ? "read" : "unread";
    var paintDone = function (progress) {
      done.disabled = false;
      row.dataset.status = next;
      // one write did both: done is 100% through it, back in the queue is none
      row.dataset.progress = String(progress);
      apply();
    };
    if (!rlOnline()) return holdStatus(done, row, next, paintDone);
    done.disabled = true;
    fetch("/api/reading/status", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: done.dataset.file, status: next })
    }).then(function (r) { return r.json(); }).then(function (j) {
      done.disabled = false;
      if (!j || !j.ok) { done.textContent = "failed"; return; }
      paintDone(j.note ? j.note.progress : (next === "read" ? 100 : 0));
    }).catch(function (e) {
      done.disabled = false;
      if (rlNetworkError(e)) holdStatus(done, row, next, paintDone);
      else done.textContent = "failed";
    });
  });

  if (urlQ) { qEl.value = urlQ; parseQuery(urlQ); }
  apply();
  window.addEventListener("pageshow", function (e) { if (e.persisted) location.reload(); });

  // A note added a moment ago is the one thing he wants to see, so land on it.
  try {
    var fresh = sessionStorage.getItem("rl-fresh");
    if (fresh) {
      sessionStorage.removeItem("rl-fresh");
      state.kind = "all"; state.status = "unread"; state.tag = ""; state.len = "";
      qEl.value = ""; parseQuery(""); apply();
      window.scrollTo(0, 0);
      var row = items.filter(function (it) { return it.q.indexOf(fresh.toLowerCase()) >= 0; })[0];
      if (row) {
        row.el.classList.add("rl-fresh");
        setTimeout(function () { row.el.classList.remove("rl-fresh"); }, 2000);
      }
    }
  } catch (e) {}

  // ── keyboard ──
  var focusIdx = -1;
  function visible() { return items.filter(function (it) { return !it.el.hidden; }); }
  function focusRow(next) {
    var vis = visible();
    if (!vis.length) return;
    items.forEach(function (it) { it.el.classList.remove("rl-focus"); });
    focusIdx = Math.max(0, Math.min(vis.length - 1, focusIdx < 0 ? 0 : focusIdx + next));
    var el = vis[focusIdx].el;
    el.classList.add("rl-focus");
    el.scrollIntoView({ block: "nearest" });
  }
  function focused() {
    var vis = visible();
    return focusIdx >= 0 && vis[focusIdx] ? vis[focusIdx].el : null;
  }
  document.addEventListener("keydown", function (e) {
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key;
    if (keysEl.classList.contains("on")) {
      if (k === "Escape" || k === "?") { e.preventDefault(); keysOpen(false); }
      return;
    }
    if (k === "?") { e.preventDefault(); keysOpen(true); return; }
    if (k === "/") { e.preventDefault(); qEl.focus(); return; }
    if (k === "j") { e.preventDefault(); focusRow(focusIdx < 0 ? 0 : 1); return; }
    if (k === "k") { e.preventDefault(); focusRow(-1); return; }
    if (k === "Escape") {
      e.preventDefault();
      if (qEl.value) { qEl.value = ""; parseQuery(""); apply(); }
      else { items.forEach(function (it) { it.el.classList.remove("rl-focus"); }); focusIdx = -1; }
      return;
    }
    var row = focused();
    if ((k === "Enter" || k === "o") && row) { e.preventDefault(); row.querySelector(".rl-row").click(); return; }
    if (k === "e" && row) { e.preventDefault(); row.querySelector(".rl-quick-done").click(); return; }
    if (k === "s" && row) { e.preventDefault(); row.querySelector(".rl-star").click(); return; }
    var kinds = { "1": "all", "2": "article", "3": "video", "4": "tweet", "5": "document", "6": "book" };
    if (kinds[k]) { e.preventDefault(); state.kind = kinds[k]; focusIdx = -1; apply(); return; }
    var states = { u: "unread", i: "progress", t: "starred", a: "done" };
    if (states[k]) { e.preventDefault(); state.status = states[k]; focusIdx = -1; apply(); return; }
  });

  var addForm = document.getElementById("rl-add");
  var addToggle = document.getElementById("rl-add-toggle");
  var input = document.getElementById("rl-url");
  var msg = document.getElementById("rl-msg");
  var pod = document.getElementById("rl-pod");
  if (pod) pod.addEventListener("click", function () {
    if (pod.disabled) return;
    if (!rlOnline()) { msg.textContent = "Offline. Updating the podcast needs the Mac."; return; }
    pod.disabled = true;
    msg.textContent = "Updating the podcast feed...";
    fetch("/api/reading/podcast", { method: "POST" }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) { msg.textContent = "Podcast not updated: " + (j.error || "unknown error"); return; }
      var parts = [j.episodes + " episode" + (j.episodes === 1 ? "" : "s")];
      if (j.added.length) parts.push("+" + j.added.length + " new: " + j.added.join("; "));
      if (j.removed.length) parts.push("-" + j.removed.length + " removed");
      if (!j.added.length && !j.removed.length) parts.push("nothing changed");
      msg.textContent = "Podcast updated. " + parts.join(", ") + ".";
    }).catch(function () { msg.textContent = "Podcast not updated: could not reach the dashboard."; })
      .then(function () { pod.disabled = false; });
  });
  addToggle.addEventListener("click", function () {
    var on = !addForm.classList.contains("on");
    addForm.classList.toggle("on", on);
    addToggle.setAttribute("aria-expanded", String(on));
    if (on) input.focus();
  });
  addForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var u = input.value.trim();
    if (!u) return;
    // Saving a link is a fetch on the Mac, not a write to a note: there is
    // nothing to queue and nothing honest to show, so it waits for the network.
    if (!rlOnline()) { msg.textContent = "Offline. Saving a link needs the Mac."; return; }
    msg.textContent = "Fetching...";
    input.value = "";
    fetch("/api/reading/add", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: u })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) { msg.textContent = j.message || "Could not add that link."; return; }
      var tags = j.tags && j.tags.length ? " (tags: " + j.tags.join(", ") + ")" : "";
      msg.textContent = (j.duplicate ? "Already saved: " : "Queued: ") + j.title + tags;
      addForm.classList.remove("on");
      addToggle.setAttribute("aria-expanded", "false");
      try { sessionStorage.setItem("rl-fresh", j.title); } catch (e) {}
      setTimeout(function () { location.replace("/reading?t=" + Date.now()); }, 700);
    }).catch(function (e) {
      msg.textContent = rlNetworkError(e) ? "Offline. Saving a link needs the Mac." : "Could not reach the dashboard.";
    });
  });

  // ── offline ──
  // Star and Done are the two writes on this page. Offline they are refused
  // rather than half-applied: the row would say one thing and the note another.
  // Star and Done are the two writes on this page, and both are one frontmatter
  // key. Offline they are applied here and queued; the row says what the note
  // will say, and the header line says how many of those are still waiting.
  function holdStar(el, next, paint) {
    rlQueueAdd("/api/reading/status", { file: el.dataset.file, star: next }, "status");
    paint(next);
    return true;
  }
  function holdStatus(el, row, next, paint) {
    rlQueueAdd("/api/reading/status", { file: el.dataset.file, status: next }, "status");
    paint(next === "read" ? 100 : 0);
    return true;
  }

  // The queue, ready for the train: the worker takes the newest thirty unread
  // pieces one at a time while the browser is idle.
  rlWarm(RL.warm || []);
})();
