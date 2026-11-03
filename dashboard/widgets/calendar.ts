// Calendar — shells to `gog calendar list`. Cached 5min.

import { shell } from "../lib/shell";

export function calendarWidget(opts: { gogBin: string; max?: number }) {
  let cache = { data: "", ts: 0 };
  const TTL = 5 * 60 * 1000;
  const max = opts.max ?? 5;

  return async function(): Promise<string> {
    if (Date.now() - cache.ts < TTL && cache.data) return cache.data;

    const { stdout, exitCode } = await shell(
      [opts.gogBin, "calendar", "list", "--max", String(max)],
      15_000
    );
    if (exitCode !== 0) return `<p style="color:var(--text3)">Calendar unavailable</p>`;

    const html = stdout
      .trim()
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => `<div class="cal-event">${l}</div>`)
      .join("") || `<p style="color:var(--text3)">No events today</p>`;

    cache = { data: html, ts: Date.now() };
    return html;
  };
}
