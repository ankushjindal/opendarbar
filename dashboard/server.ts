// home-dashboard bootstrap. Device-aware: same checkout runs on Mac + server.
//
// Layout overview:
//   device/  — detection + per-device configs (widgets, routes, paths, hostname)
//   lib/     — shared infra (html, files, shell, log, session viewer)
//   widgets/ — one widget per file; device configs pick which to load
//   pages/   — multi-route view modules (sessions index, server detail pages)
//   static/  — global CSS
//
// Common routes (all devices): /  /api/widget/*  /api/save/*  /files/*  /raw/*  /download/*
//                              /static/*  /session*  /sessions
// Device-specific routes mounted via device.routes (mac taildrop API, server /detail/* /logs/*).

import { resolve } from "path";

import { detect } from "./device";
import { layout, widgetCard, setNavLinks } from "./lib/html";
import { fileBrowser, fileDownload, fileRaw, setFilesRoot, safeSavePath } from "./lib/files";
import { sessionRoute } from "./lib/session";
import { sessionReply } from "./lib/session-reply";
import { sessionsIndex } from "./pages/sessions-index";
import { tgSessionsPage } from "./pages/tg-sessions";
import { fleetRoutes } from "./lib/fleet";
import { usageRoutes } from "./lib/usage";
import { sync as podcastSync, type SyncResult } from "../fleet/podcast/podcast-sync";
import { renewStart, renewCancel } from "./lib/accounts";
import { baseLog } from "./lib/log";

const dev = detect();
let podcastRun: Promise<SyncResult> | null = null;

// ── wire shared state ──
setFilesRoot(dev.filesRoot);
setNavLinks(dev.navLinks);

const WIDGETS = Object.fromEntries(dev.widgets.map((w) => [w.id, w]));
const WIDGET_TIMEOUT_MS = 4000;

async function runWidgetWithTimeout(fn: () => Promise<string> | string): Promise<string> {
  return Promise.race([
    Promise.resolve().then(fn),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve(`<p style="color:var(--text3)">Loading…</p>`), WIDGET_TIMEOUT_MS)
    ),
  ]);
}

async function dashboardPage(): Promise<Response> {
  const cards = await Promise.all(
    dev.widgets.map(async (w) => {
      try {
        const body = await runWidgetWithTimeout(w.fn);
        return widgetCard(w.id, w.title, body);
      } catch (e) {
        baseLog.error(`widget ${w.id}:`, e);
        return widgetCard(w.id, w.title, `<p style="color:var(--red)">Error</p>`);
      }
    })
  );

  const body = `
    <div class="dashboard">${cards.join("")}</div>
    <script>
      document.querySelectorAll("[data-widget]").forEach(el => {
        const name = el.dataset.widget;
        if (name === "actions") return;
        setInterval(async () => {
          try {
            const res = await fetch("/api/widget/" + name);
            if (res.ok) el.querySelector(".widget-body").innerHTML = await res.text();
          } catch {}
        }, 60000);
      });
      async function doAction(name, data) {
        const r = document.getElementById("action-result");
        if (r) { r.textContent = "Running..."; }
        try {
          const res = await fetch("/api/action/" + name, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(typeof data === "object" && data !== null ? data : { path: data }),
          });
          const j = await res.json();
          if (r) { r.textContent = j.message; r.style.color = j.success ? "var(--green)" : "var(--red)"; }
        } catch (e) { if (r) { r.textContent = "Request failed"; r.style.color = "var(--red)"; } }
      }
    </script>
  `;
  return layout("Dashboard", body);
}

// The one handler, so a second listener below serves exactly the same thing.
const serveOptions = {
  hostname: dev.hostname,
  port: dev.port,
  idleTimeout: 30,
  async fetch(req: Request) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Common routes (always mounted) ────────────────────────────────────
    if (path === "/" || path === "") return dashboardPage();

    if (path.startsWith("/api/widget/")) {
      const name = path.replace("/api/widget/", "");
      const w = WIDGETS[name];
      if (!w) return new Response("Not found", { status: 404 });
      try {
        const html = await w.fn();
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      } catch (e) {
        baseLog.error(`/api/widget/${name}:`, e);
        return new Response("Error", { status: 500 });
      }
    }

    if (path.startsWith("/api/action/") && req.method === "POST") {
      const name = path.replace("/api/action/", "");
      let body: any = {};
      try { body = await req.json(); } catch {}
      if (!dev.action) return Response.json({ success: false, message: "Actions not supported on this device" }, { status: 404 });
      const result = await dev.action(name, body);
      if (!result) return Response.json({ success: false, message: `Unknown action: ${name}` }, { status: 404 });
      return Response.json(result);
    }

    if (path.startsWith("/api/save/") && req.method === "POST") {
      const rel = path.replace("/api/save/", "");
      const abs = safeSavePath(rel);
      if (!abs) return Response.json({ success: false, message: "Forbidden" }, { status: 403 });
      try {
        const body = await req.json();
        await Bun.write(abs, (body as any).content ?? "");
        return Response.json({ success: true });
      } catch (e: any) {
        return Response.json({ success: false, message: e.message });
      }
    }

    // Claude usage (lib/usage.ts) — server only: it owns the seat token store.
    if ((path === "/usage" || path.startsWith("/api/usage/")) && dev.fleet?.machine === "server") {
      const acc = dev.fleet.accounts;
      const res = await usageRoutes(path, req, acc ? {
        start: (l) => renewStart(acc, l),
        cancel: (l) => renewCancel(l),
      } : null);
      if (res) return res;
    }

    // Darbar Reading podcast feed (fleet/podcast) — server only. The Mac reading
    // page's "Update podcast" button reaches this through the Mac server, so it
    // is tailnet-only like the rest of :3456. One sync at a time.
    if (path.startsWith("/api/podcast/") && dev.fleet?.machine === "server") {
      if (path === "/api/podcast/sync" && req.method === "POST") {
        podcastRun ??= podcastSync().catch((e: any) => ({ ok: false, episodes: 0, added: [], removed: [], error: e.message, at: new Date().toISOString() }) as SyncResult)
          .finally(() => { podcastRun = null; });
        return Response.json(await podcastRun);
      }
      if (path === "/api/podcast/state") {
        try { return Response.json({ ok: true, running: !!podcastRun, last: JSON.parse(await Bun.file("/home/owner/kai/state/podcast/last-sync.json").text()) }); }
        catch { return Response.json({ ok: true, running: !!podcastRun, last: null }); }
      }
    }

    // Fleet cockpit (mounted only when the device has a FleetBackend) ──────
    if (path === "/fleet" || path.startsWith("/api/fleet/")) {
      if (dev.fleet) {
        const res = await fleetRoutes(path, req, dev.fleet);
        if (res) return res;
      }
      // fall through: server serves its own /fleet via dev.routes until migrated
    }

    // Telegram session control (mounted only when the device has a TgProvider) ─
    if (path.startsWith("/api/tg/") || path === "/tg") {
      if (!dev.tg) return new Response("Telegram control not supported on this device", { status: 404 });
      if (path === "/tg") return tgSessionsPage(dev.tg);
      if (path === "/api/tg/pool") return Response.json(await dev.tg.poolStatus());
      if (path === "/api/tg/spawn" && req.method === "POST") {
        let b: any = {}; try { b = await req.json(); } catch {}
        try { return Response.json(await dev.tg.spawn({ dir: b.dir, bindingId: b.slot || undefined })); }
        catch (e: any) { return Response.json({ success: false, message: e.message }); }
      }
      if (path === "/api/tg/detach" && req.method === "POST") {
        let b: any = {}; try { b = await req.json(); } catch {}
        return Response.json(await dev.tg.detach({ bindingId: b.slot }));
      }
      if (path === "/api/tg/kill" && req.method === "POST") {
        let b: any = {}; try { b = await req.json(); } catch {}
        if (!dev.tg.kill) return Response.json({ success: false, message: "kill not supported" }, { status: 404 });
        return Response.json(await dev.tg.kill({ bindingId: b.slot }));
      }
      if (path === "/api/tg/attach" && req.method === "POST") {
        let b: any = {}; try { b = await req.json(); } catch {}
        if (!dev.tg.attach) return Response.json({ success: false, message: "attach not supported" }, { status: 404 });
        return Response.json(await dev.tg.attach({ claudePid: b.claudePid, bindingId: b.slot || undefined }));
      }
      return new Response("Not found", { status: 404 });
    }

    // Fleet cockpit (server) — /fleet page via device routes; action API here.
    if (path === "/api/fleet/action" && req.method === "POST") {
      let b: any = {}; try { b = await req.json(); } catch {}
      try {
        const { fleetAction } = await import("./pages/server/fleet");
        return Response.json(await fleetAction(b.action, b.name, { fresh: b.fresh, brief: b.brief }));
      } catch (e: any) { return Response.json({ success: false, message: e.message }); }
    }

    // Continue a session from the compact chat view (claude -p --resume)
    if (path === "/api/session/reply" && req.method === "POST") {
      let b: any = {}; try { b = await req.json(); } catch {}
      return Response.json(await sessionReply(b.file, b.message));
    }

    // Sessions browser (top-level CC session index)
    if (path === "/sessions") return sessionsIndex(url, dev.tg, dev.sessionRoots);

    // Claude Code session viewer
    if (path === "/session" || path.startsWith("/session/")) return sessionRoute(url, dev.tg, dev.sessionRoots);

    // File browser
    if (path.startsWith("/files")) return fileBrowser(path);
    if (path.startsWith("/download/")) return fileDownload(path);
    if (path.startsWith("/raw/")) return fileRaw(path);

    // Static assets. A ?v= in the address is a content hash put there by the
    // page that linked it, so that copy is good forever; anything asked for
    // without one is revalidated, which is what style.css has always done.
    // The fund page (static/fund) lives on the Mac only since 28 Oct 2026; server sends callers there.
    if (path.startsWith("/static/fund") && dev.fleet?.machine === "server") {
      return Response.redirect(`https://laptop.TAILNET.ts.net:8443${path}`, 302);
    }
    if (path.startsWith("/static/")) {
      const file = Bun.file(`./static/${path.replace("/static/", "")}`);
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      return new Response(file, {
        headers: {
          "Cache-Control": url.searchParams.has("v")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        },
      });
    }

    // Device-specific routes ────────────────────────────────────────────
    if (dev.routes) {
      const res = await dev.routes(url, req);
      if (res) return res;
    }

    return new Response("Not found", { status: 404 });
  },
};

Bun.serve(serveOptions);

// Tailscale Serve on this machine cannot hairpin to the machine's own Tailscale
// IP (the proxy leg hangs), so the HTTPS front door needs a loopback listener.
// Loopback is not LAN-reachable, so the Tailscale-IP-only rule above still
// holds: nothing off this Mac can reach it except through Tailscale.
if (dev.hostname !== "127.0.0.1" && dev.hostname !== "0.0.0.0" && dev.hostname !== "localhost") {
  try {
    Bun.serve({ ...serveOptions, hostname: "127.0.0.1" });
    baseLog.info(`Dashboard [${dev.name}] also on http://127.0.0.1:${dev.port} for the HTTPS front door`);
  } catch (e) {
    baseLog.error("loopback listener failed:", e);
  }
}

baseLog.info(`Dashboard [${dev.name}] running at http://${dev.hostname}:${dev.port}`);
