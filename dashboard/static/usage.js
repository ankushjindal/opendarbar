// /usage client: draws the charts from the JSON the page embeds, and wires the
// table (sort, row -> card), the probe buttons and the add-token flow.
// Charts are drawn here, not server-side, so they can use the real width of
// their container; a viewBox-scaled SVG stretches its text.
(function () {
  "use strict";
  var DATA = JSON.parse(document.getElementById("u-data").textContent);
  var C = DATA.colors;
  var WEEK = 7 * 86400;

  // ── time ───────────────────────────────────────────────────────────────
  function fmtTz(ts, tz, o) { return new Date(ts * 1000).toLocaleString("en-US", Object.assign({ timeZone: tz }, o)); }
  function istEt(ts) {
    return fmtTz(ts, "Asia/Kolkata", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) + " IST";
  }
  function dayLabel(ts) { return fmtTz(ts, "Asia/Kolkata", { weekday: "short" }); }

  // ── chart ──────────────────────────────────────────────────────────────
  var NS = "http://www.w3.org/2000/svg";
  function el(tag, attrs, text) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }

  // opts: {S, R, now, series:[{name,color,dash,width,opacity,points:[[ts,u]],proj:[ts,u]|null}], pace:bool, resetLabel:string}
  function drawChart(host, opts) {
    host.innerHTML = "";
    var W = Math.max(280, host.clientWidth), H = host.clientHeight || 200;
    var hasProj = opts.series.some(function (s) { return s.proj; });
    var L = 34, Rm = hasProj ? 78 : 12, T = 12, B = 26;
    var S = opts.S, R = opts.R, now = opts.now;
    var x = function (t) { return L + (t - S) / (R - S) * (W - L - Rm); };
    var y = function (u) { return T + (1 - Math.min(100, Math.max(0, u)) / 100) * (H - T - B); };
    var svg = el("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, class: "u-svg", role: "img", "aria-label": opts.label || "usage chart" });

    // elapsed shading
    if (now > S) svg.appendChild(el("rect", { x: x(S), y: T, width: x(Math.min(now, R)) - x(S), height: H - T - B, fill: "#ffffff", opacity: 0.025 }));
    // grid + y labels
    [0, 25, 50, 75, 100].forEach(function (g) {
      svg.appendChild(el("line", { x1: L, x2: W - Rm, y1: y(g), y2: y(g), stroke: "#262626" }));
      svg.appendChild(el("text", { x: L - 6, y: y(g) + 3.5, class: "u-ax", "text-anchor": "end" }, g + (g === 100 ? "%" : "")));
    });
    // day ticks (IST midnight boundaries inside the window)
    var d0 = new Date(S * 1000);
    var istMidnight = function (t) { // next IST midnight at or after t
      var p = fmtTz(t, "Asia/Kolkata", { hour: "numeric", minute: "2-digit", hour12: false }).split(":");
      var secs = (+p[0] % 24) * 3600 + (+p[1]) * 60;
      return t - secs + (secs ? 86400 : 0);
    };
    var dayCount = Math.round((R - S) / 86400);
    for (var t = istMidnight(S); t < R; t += 86400) {
      svg.appendChild(el("line", { x1: x(t), x2: x(t), y1: T, y2: H - B, stroke: "#222" }));
      if (dayCount <= 8 || Math.round((t - S) / 86400) % 2 === 0)
        svg.appendChild(el("text", { x: x(t) + 3, y: H - 8, class: "u-ax" }, dayLabel(t)));
    }
    // pace line
    if (opts.pace) {
      svg.appendChild(el("line", { x1: x(S), y1: y(0), x2: x(R), y2: y(100), stroke: C.pace, "stroke-dasharray": "4 4" }));
      svg.appendChild(el("text", { x: x(S + (R - S) * 0.5) + 5, y: y(50) + 12, class: "u-ax" }, "even pace"));
    }
    // series; projection labels sit right of the reset line, nudged apart
    var usedY = [];
    function freeY(yy) { for (var k = 0; k < 6; k++) { var hit = usedY.some(function (u) { return Math.abs(u - yy) < 12; }); if (!hit) break; yy += 12; } usedY.push(yy); return yy; }
    opts.series.forEach(function (s) {
      var pts = s.points.filter(function (p) { return p[0] >= S && p[0] <= R && p[1] != null; });
      if (!pts.length) return;
      var d = pts.map(function (p, i) { return (i ? "L" : "M") + x(p[0]).toFixed(1) + "," + y(p[1]).toFixed(1); }).join("");
      var a = { d: d, fill: "none", stroke: s.color, "stroke-width": s.width || 2, "stroke-linejoin": "round", "stroke-linecap": "round" };
      if (s.dash) a["stroke-dasharray"] = s.dash;
      if (s.opacity) a.opacity = s.opacity;
      svg.appendChild(el("path", a));
      var last = pts[pts.length - 1];
      if (s.proj) {
        svg.appendChild(el("line", { x1: x(last[0]), y1: y(last[1]), x2: x(s.proj[0]), y2: y(s.proj[1]), stroke: s.color, "stroke-width": 1.5, "stroke-dasharray": "2 4", opacity: 0.9 }));
        var ly = freeY(Math.max(T + 10, y(s.proj[1]) + 4));
        svg.appendChild(el("text", { x: x(s.proj[0]) + 6, y: ly, class: "u-ax", fill: s.color, style: "fill:" + s.color }, Math.round(s.proj[1]) + "% at reset"));
      }
      if (s.marker !== false) svg.appendChild(el("circle", { cx: x(last[0]), cy: y(last[1]), r: 4, fill: s.color, stroke: "#161616", "stroke-width": 2 }));
    });
    // now + reset lines
    if (now >= S && now <= R) svg.appendChild(el("line", { x1: x(now), x2: x(now), y1: T, y2: H - B, stroke: "#555", "stroke-dasharray": "2 2" }));
    if (opts.resetLabel) {
      svg.appendChild(el("line", { x1: x(R), x2: x(R), y1: T, y2: H - B, stroke: "#3a3a3a" }));
      svg.appendChild(el("text", { x: x(R) - 4, y: H - B - 4, class: "u-ax", "text-anchor": "end" }, opts.resetLabel));
    }
    // hover
    var hx = el("line", { x1: 0, x2: 0, y1: T, y2: H - B, stroke: "#999", style: "display:none" });
    svg.appendChild(hx);
    var hits = opts.series.filter(function (s) { return s.points.length; });
    var tip = host.parentNode.querySelector(".u-tip") || (function () { var d = document.createElement("div"); d.className = "u-tip"; host.parentNode.appendChild(d); return d; })();
    var ov = el("rect", { x: L, y: T, width: W - L - Rm, height: H - T - B, fill: "transparent" });
    ov.addEventListener("mousemove", function (e) {
      var bb = svg.getBoundingClientRect();
      var t = S + (e.clientX - bb.left - L) / (W - L - Rm) * (R - S);
      var lines = [], tsSel = null;
      hits.forEach(function (s) {
        var best = null;
        s.points.forEach(function (p) { if (p[0] <= R && (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t))) best = p; });
        if (!best || Math.abs(best[0] - t) > 2 * 3600) return;
        if (tsSel == null) tsSel = best[0];
        lines.push('<span class="u-sw" style="background:' + s.color + '"></span>' + s.name + " <b>" + (best[1] == null ? "—" : Math.round(best[1]) + "%") + "</b>");
      });
      if (tsSel == null) { hx.style.display = "none"; tip.style.display = "none"; return; }
      hx.setAttribute("x1", x(tsSel)); hx.setAttribute("x2", x(tsSel)); hx.style.display = "";
      tip.innerHTML = '<div class="u-tip-t">' + istEt(tsSel) + "</div>" + lines.join("<br>");
      tip.style.display = "block";
      var hb = host.getBoundingClientRect();
      var left = e.clientX - hb.left + 14; if (left + tip.offsetWidth > hb.width) left = e.clientX - hb.left - tip.offsetWidth - 14;
      tip.style.left = Math.max(0, left) + "px"; tip.style.top = (e.clientY - hb.top + 10) + "px";
    });
    ov.addEventListener("mouseleave", function () { hx.style.display = "none"; tip.style.display = "none"; });
    svg.appendChild(ov);
    host.appendChild(svg);
  }

  function seatSeries(s, withFive) {
    var out = [];
    if (s.limits.week) out.push({ name: "week", color: C.week, width: 2, points: s.hist.map(function (p) { return [p[0], p[1]]; }), proj: s.proj.week ? [s.anchor.R, s.proj.week.projected] : null });
    if (s.limits.fable) out.push({ name: "Fable week", color: C.fable, width: 2, dash: "7 3", points: s.hist.map(function (p) { return [p[0], p[2]]; }), proj: s.proj.fable ? [s.anchor.R, s.proj.fable.projected] : null });
    if (withFive) out.push({ name: "session 5h", color: C.five, width: 1.25, opacity: 0.6, marker: false, points: s.hist.map(function (p) { return [p[0], p[3]]; }) });
    return out;
  }

  function drawAll() {
    DATA.seats.forEach(function (s) {
      var host = document.querySelector('[data-chart="' + s.label + '"]');
      if (!host || !s.hasToken) return;
      if (!s.hist.length) { host.innerHTML = '<div class="u-nochart">first checkpoint lands on the hour</div>'; return; }
      drawChart(host, { S: s.anchor.S, R: s.anchor.R, now: DATA.now, pace: s.anchor.kind !== "none", resetLabel: s.anchor.kind === "none" ? "" : (s.anchor.kind === "fable" ? "Fable reset" : "reset"), series: seatSeries(s, true), label: s.name + " weekly usage" });
    });
    var cmp = document.getElementById("u-compare");
    if (cmp) {
      var ser = [];
      DATA.seats.forEach(function (s, i) {
        if (!s.hasToken || !s.limits.fable) return;
        ser.push({ name: s.name, color: DATA.palette[i % DATA.palette.length], width: 2, points: s.hist.map(function (p) { return [p[0], p[2]]; }) });
      });
      var leg = document.getElementById("u-compare-legend");
      leg.innerHTML = ser.map(function (s) { return '<span><i style="border-color:' + s.color + '"></i>' + s.name + "</span>"; }).join("");
      drawChart(cmp, { S: DATA.now - WEEK, R: DATA.now, now: DATA.now, pace: false, resetLabel: "", series: ser, label: "Fable week, every seat, last 7 days" });
    }
  }
  drawAll();
  var rt; function redraw() { clearTimeout(rt); rt = setTimeout(drawAll, 120); }
  window.addEventListener("resize", redraw);
  if (window.ResizeObserver) { var ro = new ResizeObserver(redraw); document.querySelectorAll(".u-chart").forEach(function (h) { ro.observe(h); }); }

  // ── table: sort + row -> card ──────────────────────────────────────────
  var tbl = document.getElementById("u-rows");
  function sortRows(key) {
    var rows = Array.prototype.slice.call(tbl.querySelectorAll(".u-tr[data-live]"));
    rows.sort(function (a, b) { return (+b.getAttribute("data-" + key) || -1) - (+a.getAttribute("data-" + key) || -1); });
    rows.forEach(function (r) { tbl.appendChild(r); });
    tbl.querySelectorAll(".u-tr:not([data-live])").forEach(function (r) { tbl.appendChild(r); });
    document.querySelectorAll("[data-sort]").forEach(function (b) { b.classList.toggle("u-on", b.getAttribute("data-sort") === key); });
    try { localStorage.setItem("u-sort", key); } catch (e) {}
  }
  document.querySelectorAll("[data-sort]").forEach(function (b) { b.addEventListener("click", function () { sortRows(b.getAttribute("data-sort")); }); });
  var saved = null; try { saved = localStorage.getItem("u-sort"); } catch (e) {}
  if (saved && document.querySelector('[data-sort="' + saved + '"]')) sortRows(saved);
  document.querySelectorAll(".u-tr[data-live]").forEach(function (r) {
    r.addEventListener("click", function (e) {
      if (e.target.closest("button,a,input")) return;
      var card = document.getElementById("card-" + r.getAttribute("data-label"));
      if (!card) return;
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      card.classList.add("u-flash"); setTimeout(function () { card.classList.remove("u-flash"); }, 1600);
    });
  });

  // ── actions ────────────────────────────────────────────────────────────
  function msg(l, t, good) {
    var m = document.querySelector('[data-msg-for="' + l + '"]');
    if (!m) return;
    m.textContent = t; m.style.color = good === false ? "#e66767" : good ? "#6ad36a" : "#999";
  }
  function post(p, b) {
    return fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) }).then(function (r) { return r.json(); });
  }
  document.querySelectorAll("[data-probe]").forEach(function (b) {
    b.addEventListener("click", function () {
      var l = b.getAttribute("data-probe"); b.disabled = true; msg(l, "probing…");
      post("/api/usage/probe", { label: l }).then(function (j) { msg(l, j.message, j.success); if (j.success) setTimeout(function () { location.reload(); }, 700); else b.disabled = false; });
    });
  });
  var all = document.getElementById("u-all");
  if (all) all.addEventListener("click", function () {
    all.disabled = true; all.textContent = "probing…";
    post("/api/usage/probe", {}).then(function (j) { all.textContent = j.message; setTimeout(function () { location.reload(); }, 900); });
  });
  document.querySelectorAll("[data-add]").forEach(function (b) {
    b.addEventListener("click", function () {
      var l = b.getAttribute("data-add"); b.disabled = true; msg(l, "starting sign-in… (up to 45s)");
      post("/api/usage/add", { label: l }).then(function (j) {
        msg(l, j.message, j.success); b.disabled = false;
        if (j.success && j.url) {
          var box = document.querySelector('[data-code-for="' + l + '"]');
          box.style.display = "flex"; box.querySelector("a").href = j.url; box.querySelector("input").focus();
          window.open(j.url, "_blank");
        }
      });
    });
  });
  document.querySelectorAll("[data-submit]").forEach(function (b) {
    b.addEventListener("click", function () {
      var l = b.getAttribute("data-submit"), box = document.querySelector('[data-code-for="' + l + '"]');
      var code = box.querySelector("input").value.trim(); if (!code) return;
      b.disabled = true; msg(l, "exchanging the code… (up to 60s)");
      post("/api/fleet/accounts/renew/code", { label: l, code: code }).then(function (j) {
        msg(l, j.message, j.success); b.disabled = false;
        if (j.success) post("/api/usage/probe", { label: l }).then(function () { location.reload(); });
      });
    });
  });
  document.querySelectorAll("[data-cancel]").forEach(function (b) {
    b.addEventListener("click", function () {
      var l = b.getAttribute("data-cancel");
      post("/api/usage/cancel", { label: l }).then(function (j) { msg(l, j.message, j.success); document.querySelector('[data-code-for="' + l + '"]').style.display = "none"; });
    });
  });
  document.querySelectorAll("[data-code-for] input").forEach(function (i) {
    i.addEventListener("keydown", function (e) { if (e.key === "Enter") i.parentNode.querySelector("[data-submit]").click(); });
  });

  // keep the page current without a push notification: reload every 10 min
  // unless a sign-in box is open.
  setInterval(function () {
    var open = Array.prototype.some.call(document.querySelectorAll("[data-code-for]"), function (b) { return b.style.display !== "none"; });
    if (!open) location.reload();
  }, 10 * 60 * 1000);
})();
