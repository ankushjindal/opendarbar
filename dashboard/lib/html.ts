// Shared HTML chrome: layout, widget card, markdown renderer. Nav links are device-provided
// (set via setNavLinks during bootstrap).

import type { NavLink } from "../device/types";

let NAV_LINKS: NavLink[] = [];

export function setNavLinks(links: NavLink[]): void {
  NAV_LINKS = links;
}

// `opts.fullTitle` replaces the default "<title> — Dashboard"; `opts.head` adds
// extra tags (a page-specific favicon, say); `opts.stylesheet` moves the global
// sheet to another address — /reading serves its own hashed copy from inside
// the service worker's scope, because a sheet at /static/ could never come out
// of the offline cache. All optional, so every existing caller is unchanged.
// The dashboard's own icon (gauge on navy, 18 Oct 2026). A page that brings its
// own rel="icon" in opts.head (/reading does) keeps it instead of this one.
const DEFAULT_ICONS =
  `<link rel="icon" type="image/svg+xml" href="/static/icons/dashboard.svg">`
  + `<link rel="icon" type="image/png" sizes="192x192" href="/static/icons/dashboard-192.png">`
  + `<link rel="apple-touch-icon" sizes="180x180" href="/static/icons/dashboard-180.png">`;

export function layout(
  title: string,
  body: string,
  opts?: { fullTitle?: string; head?: string; stylesheet?: string }
): Response {
  const nav = NAV_LINKS.map(
    (l) => `<a href="${l.href}" class="nav-link">${l.label}</a>`
  ).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${opts?.fullTitle ?? `${title} — Dashboard`}</title>
  <link rel="stylesheet" href="${opts?.stylesheet ?? "/static/style.css"}">
  ${(opts?.head ?? "").includes('rel="icon"') ? "" : DEFAULT_ICONS}
  ${opts?.head ?? ""}
</head>
<body>
  <nav class="top-nav">${nav}</nav>
  <main>${body}</main>
</body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export function widgetCard(id: string, title: string, body: string): string {
  return `<section class="widget" data-widget="${id}">
  <h2 class="widget-title">${title}</h2>
  <div class="widget-body">${body}</div>
</section>`;
}

// Escape HTML entities — exported for widgets that build raw HTML.
export function esc(s: unknown): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Markdown → HTML via marked (GFM mode: tables, task lists, fenced code, links)
import { marked } from "marked";
marked.setOptions({ gfm: true, breaks: false });

export function md(text: string): string {
  return `<div class="md">${marked.parse(text) as string}</div>`;
}
