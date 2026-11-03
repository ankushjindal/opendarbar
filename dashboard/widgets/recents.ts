// Recently viewed files (from data/recents.json maintained by lib/files.ts).

import { readRecents, getFilesRoot } from "../lib/files";
import { esc } from "../lib/html";
import { ageIso } from "./_helpers";

export async function recentsWidget(): Promise<string> {
  const list = await readRecents();
  if (!list.length) {
    return `<p style="color:var(--text3);font-size:12px">no recent files yet — click any file in the browser</p>`;
  }
  const root = getFilesRoot();
  return list.map((r) => {
    const rel = r.path.replace(root, "").replace(/^\//, "");
    const name = rel.split("/").pop() || rel;
    const parent = rel.includes("/") ? rel.split("/").slice(0, -1).join("/") : "";
    const href = `/files/${rel.split("/").map(encodeURIComponent).join("/")}`;
    return `<div class="li" style="font-size:12px;margin-bottom:4px">
      <a href="${href}" style="color:var(--text)">${esc(name)}</a>
      ${parent ? `<span style="color:var(--text3);font-size:11px"> — ${esc(parent)}</span>` : ""}
      <span style="color:var(--text3);font-size:11px;float:right">${esc(ageIso(r.at))}</span>
    </div>`;
  }).join("");
}
