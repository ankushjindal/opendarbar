// Kai's tasks.md widget (server only). Renders structured task list.

import { esc } from "../lib/html";

export function kaiTasksWidget(opts: { path: string }) {
  return async function(): Promise<string> {
    let content: string;
    try { content = await Bun.file(opts.path).text(); }
    catch { return `<p style="color:var(--text3)">No tasks file at ${esc(opts.path)}</p>`; }

    const lines = content.split("\n").slice(0, 40);
    return lines.map(ln => {
      if (ln.startsWith("# "))    return `<h3 style="margin:6px 0 2px;color:var(--text);font-size:13px;font-weight:500">${esc(ln.slice(2))}</h3>`;
      if (ln.startsWith("## "))   return `<h4 style="margin:4px 0 2px;color:var(--text2);font-size:12px;font-weight:500">${esc(ln.slice(3))}</h4>`;
      if (ln.startsWith("- [x] ")) return `<div style="text-decoration:line-through;color:var(--text3);font-size:12px">☑ ${esc(ln.slice(6))}</div>`;
      if (ln.startsWith("- [ ] ")) return `<div style="color:var(--text);font-size:12px">☐ ${esc(ln.slice(6))}</div>`;
      if (ln.startsWith("- "))     return `<div style="color:var(--text2);font-size:12px;padding-left:8px">• ${esc(ln.slice(2))}</div>`;
      if (ln.trim())                return `<div style="color:var(--text2);font-size:12px">${esc(ln)}</div>`;
      return "";
    }).join("");
  };
}
