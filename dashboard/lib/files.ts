// File browser, viewer, inline editor, and recents tracker.
// FILES_ROOT is the only directory exposed via /files/* /raw/* /download/* /api/save/*.
// Set by device bootstrap (mac=HOME, server=HOME/monorepo).

import { readdir, stat, mkdir } from "fs/promises";
import { join, resolve, extname, basename, dirname } from "path";
import { layout, md } from "./html";

let FILES_ROOT: string = "";

export function setFilesRoot(p: string): void {
  if (!p) throw new Error("setFilesRoot: empty path");
  FILES_ROOT = p;
}

export function getFilesRoot(): string {
  if (!FILES_ROOT) throw new Error("getFilesRoot: not initialised — call setFilesRoot() first");
  return FILES_ROOT;
}

const MAX_ENTRIES = 200;
const RECENTS_PATH = "./data/recents.json";
const RECENTS_MAX = 5;

async function recordRecent(abs: string): Promise<void> {
  // Fire-and-forget: prepend abs path (deduped), keep last RECENTS_MAX. Never throw.
  try {
    await mkdir("./data", { recursive: true });
    let list: { path: string; at: string }[] = [];
    try {
      list = JSON.parse(await Bun.file(RECENTS_PATH).text()) || [];
    } catch {}
    list = list.filter((r) => r.path !== abs);
    list.unshift({ path: abs, at: new Date().toISOString() });
    list = list.slice(0, RECENTS_MAX);
    await Bun.write(RECENTS_PATH, JSON.stringify(list, null, 2));
  } catch {}
}

export async function readRecents(): Promise<{ path: string; at: string }[]> {
  try {
    return JSON.parse(await Bun.file(RECENTS_PATH).text()) || [];
  } catch {
    return [];
  }
}

const TEXT_EXTS = new Set([
  ".md", ".txt", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs",
  ".json", ".csv", ".sh", ".bash", ".zsh", ".yaml", ".yml", ".toml",
  ".xml", ".plist", ".html", ".css", ".sql", ".graphql", ".swift",
  ".kt", ".lua", ".rb", ".java", ".c", ".cpp", ".h", ".hpp", ".env",
  ".conf", ".cfg", ".ini", ".log", ".jsonl",
]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"]);

function safePath(urlPath: string): string | null {
  const rel = decodeURIComponent(
    urlPath.replace(/^\/files\/?/, "").replace(/^\/download\/?/, "").replace(/^\/raw\/?/, "")
  );
  const abs = resolve(FILES_ROOT, rel);
  if (!abs.startsWith(FILES_ROOT)) return null;
  return abs;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function timeAgo(mtime: Date): string {
  const d = new Date(mtime);
  return d.toLocaleDateString("en-IN", { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function breadcrumb(absPath: string, withCopy = false): string {
  const rel = absPath.replace(FILES_ROOT, "").replace(/^\//, "");
  const parts = rel.split("/").filter(Boolean);
  let crumbs = `<a href="/files/">~</a>`;
  let href = "/files";
  for (let i = 0; i < parts.length; i++) {
    href += "/" + encodeURIComponent(parts[i]);
    crumbs += ` / <a href="${href}">${parts[i]}</a>`;
  }
  const copyBtn = withCopy
    ? ` <button class="copy-link-btn" onclick="(function(b){var u=window.location.href;if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(u).then(function(){b.textContent='✓';setTimeout(function(){b.textContent='⎘'},1400)})}else{var t=document.createElement('textarea');t.value=u;t.style.position='fixed';t.style.opacity='0';document.body.appendChild(t);t.focus();t.select();try{document.execCommand('copy');b.textContent='✓';setTimeout(function(){b.textContent='⎘'},1400)}catch(e){}document.body.removeChild(t)}})(this)" title="Copy link">⎘</button>`
    : "";
  return `<div class="breadcrumb">${crumbs}${copyBtn}</div>`;
}

export async function fileBrowser(urlPath: string): Promise<Response> {
  const abs = safePath(urlPath);
  if (!abs) return new Response("Forbidden", { status: 403 });

  let st;
  try { st = await stat(abs); } catch { return new Response("Not found", { status: 404 }); }

  if (st.isDirectory()) return dirListing(abs);
  return fileView(abs);
}

async function dirListing(abs: string): Promise<Response> {
  const entries = await readdir(abs, { withFileTypes: true });
  const items: { name: string; isDir: boolean; size: number; mtime: Date }[] = [];

  for (const e of entries.slice(0, MAX_ENTRIES + 50)) {
    if (e.name.startsWith(".") && e.name !== ".claude") continue;
    try {
      const s = await stat(join(abs, e.name));
      items.push({ name: e.name, isDir: s.isDirectory(), size: s.size, mtime: s.mtime });
    } catch { continue; }
  }

  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const rel = abs.replace(FILES_ROOT, "").replace(/^\//, "");
  const truncated = items.length > MAX_ENTRIES;
  const display = items.slice(0, MAX_ENTRIES);

  const rows = display.map((item) => {
    const icon = item.isDir ? "📁" : "📄";
    const href = `/files/${rel ? rel + "/" : ""}${encodeURIComponent(item.name)}`;
    const dlHref = item.isDir ? "" : `/download/${rel ? rel + "/" : ""}${encodeURIComponent(item.name)}`;
    return `<tr>
      <td class="file-name">${icon} <a href="${href}">${item.name}</a></td>
      <td class="file-size">${item.isDir ? "—" : humanSize(item.size)}</td>
      <td class="file-date">${timeAgo(item.mtime)}</td>
      <td class="file-dl">${item.isDir ? "" : `<a href="${dlHref}">↓</a>`}</td>
    </tr>`;
  }).join("");

  const body = `
    ${breadcrumb(abs)}
    <table class="file-table">
      <thead><tr><th>Name</th><th>Size</th><th>Modified</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${truncated ? `<p style="color:var(--text3);margin-top:12px">Showing ${MAX_ENTRIES} of ${items.length} entries</p>` : ""}
  `;
  return layout(rel || "Home", body);
}

async function fileView(abs: string): Promise<Response> {
  const ext = extname(abs).toLowerCase();
  const name = basename(abs);
  const rel = abs.replace(FILES_ROOT, "").replace(/^\//, "");
  const dir = dirname(rel);
  recordRecent(abs);

  const isText = TEXT_EXTS.has(ext);
  const editBtn = isText
    ? `<button class="action-btn" onclick="toggleEditor()">✎ Edit</button>`
    : "";
  const actions = `<div class="file-actions">
    <a href="/files/${dir}" class="action-btn">← Back</a>
    <a href="/download/${rel}" class="action-btn">↓ Download</a>
    <a href="/raw/${rel}" class="action-btn" target="_blank">Raw</a>
    ${editBtn}
  </div>`;

  if (IMAGE_EXTS.has(ext)) {
    return layout(name, `${breadcrumb(abs, true)}${actions}<div class="file-viewer"><img src="/raw/${rel}" alt="${name}"></div>`);
  }

  if (ext === ".pdf") {
    return layout(name, `${breadcrumb(abs, true)}${actions}<div class="file-viewer"><p>PDF file — <a href="/raw/${rel}" target="_blank">Open in browser</a></p></div>`);
  }

  if (isText) {
    try {
      const content = await Bun.file(abs).text();
      const escaped = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const rendered = ext === ".md" ? md(content) : `<pre>${escaped}</pre>`;
      const editorScript = `
<script>
let editorOpen = false;
function toggleEditor() {
  editorOpen = !editorOpen;
  document.getElementById('file-view').style.display = editorOpen ? 'none' : '';
  document.getElementById('file-editor').style.display = editorOpen ? '' : 'none';
  document.querySelector('.action-btn[onclick="toggleEditor()"]').textContent = editorOpen ? '✕ Cancel' : '✎ Edit';
}
async function saveFile() {
  const content = document.getElementById('editor-textarea').value;
  const btn = document.getElementById('save-btn');
  btn.textContent = 'Saving…';
  btn.disabled = true;
  try {
    const res = await fetch('/api/save/${encodeURIComponent(rel)}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const j = await res.json();
    if (j.success) { location.reload(); }
    else { btn.textContent = 'Error: ' + j.message; btn.disabled = false; }
  } catch (e) { btn.textContent = 'Failed'; btn.disabled = false; }
}
</script>`;
      const editorHtml = `
<div id="file-editor" style="display:none">
  <textarea id="editor-textarea" class="file-editor-textarea">${escaped}</textarea>
  <div class="editor-actions">
    <button id="save-btn" class="action-btn save-btn" onclick="saveFile()">💾 Save</button>
    <button class="action-btn" onclick="toggleEditor()">✕ Cancel</button>
  </div>
</div>
<div id="file-view">${rendered}</div>
${editorScript}`;
      return layout(name, `${breadcrumb(abs, true)}${actions}<div class="file-viewer">${editorHtml}</div>`);
    } catch {
      return layout(name, `${breadcrumb(abs, true)}${actions}<div class="file-viewer"><p>Could not read file</p></div>`);
    }
  }

  const s = await stat(abs);
  return layout(name, `${breadcrumb(abs, true)}${actions}<div class="file-viewer"><p>${name} — ${humanSize(s.size)}</p></div>`);
}

export async function fileDownload(urlPath: string): Promise<Response> {
  const abs = safePath(urlPath);
  if (!abs) return new Response("Forbidden", { status: 403 });
  const file = Bun.file(abs);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, {
    headers: {
      "Content-Disposition": `attachment; filename="${basename(abs)}"`,
      "Content-Type": "application/octet-stream",
    },
  });
}

export async function fileRaw(urlPath: string): Promise<Response> {
  const abs = safePath(urlPath);
  if (!abs) return new Response("Forbidden", { status: 403 });
  const file = Bun.file(abs);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file);
}

/**
 * Validate a path for /api/save/<rel> POSTs. Returns abs path if safe, null otherwise.
 * Caller resolves rel against FILES_ROOT and checks containment.
 */
export function safeSavePath(rel: string): string | null {
  const decoded = decodeURIComponent(rel);
  const abs = resolve(FILES_ROOT, decoded);
  if (!abs.startsWith(FILES_ROOT)) return null;
  return abs;
}
