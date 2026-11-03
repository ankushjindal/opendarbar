// Recent Claude Code sessions — 5-row preview, links to /sessions for the full browser.
// Used on both mac and server home dashboards.

import { readdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { timeAgo } from "./_helpers";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const RECENT_DAYS = 7;
const PREVIEW_LIMIT = 5;

interface Session {
  title: string;
  sid: string;
  mtime: number;
  cwd: string | null;
  filePath: string;
}

export async function sessionsWidget(): Promise<string> {
  const sessions: Session[] = [];
  try {
    const projects = await readdir(PROJECTS_DIR);
    for (const proj of projects) {
      const projPath = join(PROJECTS_DIR, proj);
      const projStat = await stat(projPath).catch(() => null);
      if (!projStat?.isDirectory()) continue;

      const files = await readdir(projPath).catch(() => []);
      for (const f of files) {
        if (!f.endsWith(".jsonl") || f.startsWith("agent-")) continue;
        const fPath = join(projPath, f);
        const fStat = await stat(fPath).catch(() => null);
        if (!fStat) continue;
        if (Date.now() - fStat.mtimeMs > RECENT_DAYS * 86400 * 1000) continue;

        try {
          const content = await Bun.file(fPath).text();
          let title: string | null = null;
          let cwd: string | null = null;
          for (const line of content.split("\n").slice(0, 100)) {
            if (!line.trim()) continue;
            try {
              const d = JSON.parse(line);
              if (!title && d.customTitle) title = d.customTitle;
              if (!cwd && d.cwd) cwd = d.cwd;
              if (title && cwd) break;
            } catch {}
          }
          if (title) {
            sessions.push({ title, sid: f.replace(".jsonl", ""), mtime: fStat.mtimeMs, cwd, filePath: fPath });
          }
        } catch {}
      }
    }
  } catch {}

  sessions.sort((a, b) => b.mtime - a.mtime);
  const top = sessions.slice(0, PREVIEW_LIMIT);
  if (top.length === 0) return `<p style="color:var(--text3)">No recent sessions</p>`;

  const browseLink = `<div style="margin-bottom:8px;font-size:12px"><a href="/sessions" style="color:var(--accent);text-decoration:none">📋 Browse all sessions →</a></div>`;

  const rows = top.map((s) => {
    const ago = timeAgo(s.mtime);
    const shortId = s.sid.slice(0, 8);
    const viewerHref = `/session?file=${encodeURIComponent(s.filePath)}`;
    const title = s.title.length > 50 ? s.title.slice(0, 50) + "…" : s.title;
    return `<div class="session">
      <div style="flex:1;min-width:0">
        <div class="session-title"><a href="${viewerHref}" style="color:var(--text);text-decoration:none">${title}</a></div>
        <div class="session-meta">${ago} · ${shortId}</div>
      </div>
    </div>`;
  }).join("");

  return browseLink + rows;
}
