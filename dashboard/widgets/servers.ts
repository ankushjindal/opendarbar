// Active servers — lists TCP listeners reachable from a Tailscale client.

import { shell } from "../lib/shell";

const SKIP_PROCESSES = new Set([
  "rapportd", "ControlCe", "sharingd", "identitysv", "remoted",
  "cupsd", "mDNSRespo", "bun",
]);
const SKIP_PORTS = new Set([3456, 5000, 7000, 22, 88, 445, 548, 631, 5353]);

type OpenPort = { pid: string; proc: string; port: number; host: string };

async function listOpenPortsMac(tailscaleIp: string): Promise<OpenPort[]> {
  const { stdout } = await shell(["lsof", "-iTCP", "-sTCP:LISTEN", "-P", "-n"]);
  if (!stdout.trim()) return [];

  const lines = stdout.trim().split("\n").slice(1);
  const seen = new Set<string>();
  const out: OpenPort[] = [];

  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 9) continue;
    const proc = parts[0];
    const pid = parts[1];
    const name = parts[8];

    const m = name.match(/^(.+):(\d+)$/);
    if (!m) continue;
    const host = m[1];
    const port = parseInt(m[2], 10);

    if (host !== "*" && host !== tailscaleIp) continue;
    if (SKIP_PROCESSES.has(proc)) continue;
    if (SKIP_PORTS.has(port)) continue;

    const key = `${proc}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ pid, proc, port, host });
  }

  out.sort((a, b) => a.port - b.port);
  return out;
}

async function listOpenPortsLinux(tailscaleIp: string): Promise<OpenPort[]> {
  const { stdout } = await shell(["ss", "-ltnpH"]);
  if (!stdout.trim()) return [];

  const out: OpenPort[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    // ss -ltnpH: State Recv-Q Send-Q LocalAddr:Port PeerAddr:Port [users:(("proc",pid=N,fd=X))]
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const local = parts[3];
    const m = local.match(/^(.+):(\d+)$/);
    if (!m) continue;
    const host = m[1] === "0.0.0.0" || m[1] === "::" ? "*" : m[1];
    const port = parseInt(m[2], 10);
    if (host !== "*" && host !== tailscaleIp) continue;
    if (SKIP_PORTS.has(port)) continue;

    const procMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    const proc = procMatch ? procMatch[1] : "?";
    const pid = procMatch ? procMatch[2] : "?";
    if (SKIP_PROCESSES.has(proc)) continue;

    const key = `${proc}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pid, proc, port, host });
  }
  out.sort((a, b) => a.port - b.port);
  return out;
}

const titleCache = new Map<number, { title: string | null; ts: number }>();
const TITLE_TTL_MS = 5 * 60 * 1000;

async function probeHttpTitle(port: number): Promise<string | null> {
  const cached = titleCache.get(port);
  if (cached && Date.now() - cached.ts < TITLE_TTL_MS) return cached.title;

  const deadline = new Promise<null>((res) => setTimeout(() => res(null), 500));
  const work = (async (): Promise<string | null> => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 400);
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal, redirect: "manual" });
      clearTimeout(t);
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("html")) return ct.split(";")[0] || null;
      const reader = res.body?.getReader();
      if (!reader) return null;
      let bytes = new Uint8Array(0);
      const readDeadline = Date.now() + 300;
      while (bytes.length < 8192 && Date.now() < readDeadline) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((r) =>
            setTimeout(() => r({ done: true, value: undefined }), 150)
          ),
        ]);
        if (chunk.done || !chunk.value) break;
        const merged = new Uint8Array(bytes.length + chunk.value.length);
        merged.set(bytes);
        merged.set(chunk.value, bytes.length);
        bytes = merged;
      }
      try { reader.cancel(); } catch {}
      const html = new TextDecoder().decode(bytes);
      const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      return m ? m[1].trim().slice(0, 60) : null;
    } catch {
      return null;
    }
  })();

  const title = await Promise.race([work, deadline]);
  titleCache.set(port, { title, ts: Date.now() });
  return title;
}

export function serversWidget(opts: { tailscaleIp: string; platform: "mac" | "linux" }) {
  return async function(): Promise<string> {
    const ports = opts.platform === "mac"
      ? await listOpenPortsMac(opts.tailscaleIp)
      : await listOpenPortsLinux(opts.tailscaleIp);
    if (ports.length === 0) return `<p style="color:var(--text3)">No reachable servers</p>`;

    const rows = await Promise.all(
      ports.map(async (p) => {
        const title = await probeHttpTitle(p.port);
        const url = `http://${opts.tailscaleIp}:${p.port}/`;
        const label = title ? title : `${p.proc} · pid ${p.pid}`;
        return `<div class="device">
          <span class="dot online"></span>
          <span><strong><a href="${url}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">:${p.port}</a></strong> <span style="color:var(--text3)">${label}</span></span>
          <span style="color:var(--text3);margin-left:auto;font-size:11px">${p.proc}</span>
        </div>`;
      })
    );
    return rows.join("");
  };
}
