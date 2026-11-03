// POST /api/session/reply — continue a Claude Code session from the dashboard
// (the compact chat view) via `claude -p --resume`, returning the reply inline.
//
// Scope/safety (v1): conversational continuation only. We DON'T pass
// --dangerously-skip-permissions; an appended system prompt tells the agent not to
// use tools (a denied tool would abort the headless run). For real work, talk to a
// live session over Telegram instead. Cost note: from 2026-06-15, `claude -p` draws
// from a separate Agent-SDK credit pool on subscription plans.

import { resolve, join, basename } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, statSync } from "fs";
import { shell } from "./shell";

const HOME = homedir();
const PROJECTS_DIR = join(HOME, ".claude", "projects");

// A session open in a terminal / on Telegram is a separate live process: `claude -p
// --resume` appends to its transcript file but the running process never sees it (its
// own in-memory state) — confusing + risks branching the transcript. We can't reach
// a live process from outside, so we refuse when the session looks active. There's no
// lock to read; the only signal is recent file mtime. We exclude our OWN recent writes
// (so multi-turn web chat on an idle session keeps working).
const LIVE_WINDOW_MS = 90_000;
const lastWebWrite = new Map<string, number>();

function findClaude(): string {
  for (const c of [join(HOME, ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude"]) {
    if (existsSync(c)) return c;
  }
  return "claude";
}
const CLAUDE_BIN = findClaude();

const CHAT_SYSTEM_PROMPT =
  "You are being messaged from a read-only dashboard chat view. Respond conversationally and concisely. " +
  "Do not call tools or make edits in this turn; if the request needs tools or file changes, say it should be run in the live session instead.";

export interface SessionReplyResult {
  success: boolean;
  reply?: string;
  message?: string;
  cost?: number;
  sessionId?: string;
}

export async function sessionReply(file: string, message: string): Promise<SessionReplyResult> {
  if (!message || !message.trim()) return { success: false, message: "empty message" };

  const abs = resolve(file);
  if (!abs.startsWith(PROJECTS_DIR + "/") || !abs.endsWith(".jsonl") || !existsSync(abs)) {
    return { success: false, message: "invalid session file" };
  }
  const sessionId = basename(abs).replace(/\.jsonl$/, "");

  // Refuse if the session looks live (recent mtime not explained by our own writes).
  let mtimeMs = 0;
  try { mtimeMs = statSync(abs).mtimeMs; } catch {}
  const ageMs = Date.now() - mtimeMs;
  const mineRecent = Date.now() - (lastWebWrite.get(sessionId) || 0) < LIVE_WINDOW_MS;
  if (mtimeMs && ageMs < LIVE_WINDOW_MS && !mineRecent) {
    return {
      success: false,
      message: `This session is active right now (updated ${Math.round(ageMs / 1000)}s ago). A web reply can't reach a session that's open in a terminal or on Telegram — reply there instead. Web reply works on sessions that aren't currently open.`,
    };
  }

  // Derive cwd from the jsonl head (first entry carrying cwd), so CLAUDE.md /
  // relative context resolves like the original session.
  let cwd = HOME;
  try {
    const head = readFileSync(abs, "utf8").slice(0, 65536);
    for (const ln of head.split("\n")) {
      if (!ln.trim()) continue;
      try {
        const d = JSON.parse(ln);
        if (d.cwd) { cwd = d.cwd; break; }
      } catch { /* skip partial/last line */ }
    }
  } catch { /* fall back to HOME */ }
  if (!existsSync(cwd)) cwd = HOME;

  const res = await shell(
    [CLAUDE_BIN, "-p", message, "--resume", sessionId, "--output-format", "json", "--append-system-prompt", CHAT_SYSTEM_PROMPT],
    180_000,
    { cwd }
  );

  if (res.exitCode !== 0) {
    const tail = (res.stderr || res.stdout || "").trim().split("\n").slice(-2).join(" ").slice(0, 300);
    return {
      success: false,
      message: `couldn't continue this session — it may be live in a terminal or on Telegram. ${tail ? "(" + tail + ")" : ""}`,
    };
  }
  try {
    const d = JSON.parse(res.stdout);
    if (d.is_error) return { success: false, message: (d.result || "the session returned an error").slice(0, 400) };
    lastWebWrite.set(sessionId, Date.now()); // so multi-turn web chat doesn't trip the live-guard
    return { success: true, reply: d.result ?? "", cost: d.total_cost_usd, sessionId: d.session_id };
  } catch (e: any) {
    return { success: false, message: "couldn't parse the reply: " + (e?.message || e) };
  }
}
