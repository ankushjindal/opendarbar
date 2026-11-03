// System health widget (uptime, load, memory, disk). Linux-first.

import { shell } from "../lib/shell";
import { readFile } from "fs/promises";
import { esc } from "../lib/html";

export function systemWidget(opts: { rootMount?: string }) {
  const root = opts.rootMount || "/";
  return async function(): Promise<string> {
    const [uptime, load, mem, disk] = await Promise.all([
      readUptime(),
      readLoad(),
      readMemory(),
      readDisk(root),
    ]);
    return `
      <div style="font-size:12px;color:var(--text2,#b8b8be);line-height:1.55">
        <div>⏱ <span style="color:var(--text3)">uptime:</span> ${esc(uptime)}</div>
        <div>📊 <span style="color:var(--text3)">load:</span> ${esc(load)}</div>
        <div>💾 <span style="color:var(--text3)">mem:</span> ${esc(mem)}</div>
        <div>🗄 <span style="color:var(--text3)">disk:</span> ${esc(disk)}</div>
      </div>`;
  };
}

async function readUptime(): Promise<string> {
  const { stdout } = await shell(["uptime", "-p"]);
  return stdout.trim() || "?";
}

async function readLoad(): Promise<string> {
  try {
    const text = await readFile("/proc/loadavg", "utf8");
    const [l1, l5, l15] = text.trim().split(/\s+/);
    return `${l1} / ${l5} / ${l15}`;
  } catch { return "—"; }
}

async function readMemory(): Promise<string> {
  const { stdout } = await shell(["free", "-m"]);
  const line = stdout.split("\n").find(l => l.toLowerCase().startsWith("mem:"));
  if (!line) return "?";
  const parts = line.trim().split(/\s+/);
  const total = +parts[1];
  const used = +parts[2];
  if (!total) return "?";
  const pct = Math.round((used / total) * 100);
  return `${used}/${total} MB (${pct}%)`;
}

async function readDisk(mount: string): Promise<string> {
  const { stdout } = await shell(["df", "-h", mount]);
  const line = stdout.split("\n")[1];
  if (!line) return "?";
  const parts = line.trim().split(/\s+/);
  // Filesystem Size Used Avail Use% Mounted
  return `${parts[2]} / ${parts[1]} (${parts[4]})`;
}
