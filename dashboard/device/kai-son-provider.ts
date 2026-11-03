// server one-bot TgProvider — the @example_son1_bot son session.
//
// server uses the official telegram plugin (one bot per session), NOT the kushbot pool.
// So there is exactly ONE binding: a persistent "kai-son" tmux session whose bot token
// lives in <sonHome>/.claude/channels/telegram/. Liveness = the plugin's bot.pid.
// spawn = (re)launch the son (HOME-overridden so it picks up the son's bot). close/detach
// = stop it (claude ignores SIGHUP/SIGTERM, so SIGKILL the claude pid). No graceful
// detach + no attach-existing (that needs the kushbot request-watcher, which is Mac-only).

import { join } from "path";
import { readFileSync } from "fs";
import { shell } from "../lib/shell";
import {
  isPidAlive,
  resolveClaude,
  tmuxSessions,
  sleep,
  TMUX,
  type TgProvider,
  type TgBinding,
  type TgPoolStatus,
  type TgCapabilities,
  type TgSpawnResult,
  type TgActionResult,
  type TgMatch,
} from "../lib/tg";

export interface KaiSonOpts {
  sonHome: string; // HOME for the son (its own .claude/channels/telegram/.env = the @kai1 token)
  botUsername: string; // "example_son1_bot"
  tmuxSession: string; // "kai-son"
  dir: string; // working dir the son runs in
  claudeBin: string; // absolute claude path on server
}

export function kaiSonProvider(o: KaiSonOpts): TgProvider {
  const deepLink = `https://t.me/${o.botUsername}?start=dash`;
  const botPidFile = join(o.sonHome, ".claude/channels/telegram/bot.pid");

  const botPid = (): number | null => {
    try {
      const p = parseInt(readFileSync(botPidFile, "utf8").trim(), 10);
      return Number.isFinite(p) ? p : null;
    } catch {
      return null;
    }
  };
  const alive = (): boolean => {
    const p = botPid();
    return !!(p && isPidAlive(p));
  };

  async function poolStatus(): Promise<TgPoolStatus> {
    const tmux = await tmuxSessions();
    const live = alive();
    const binding: TgBinding = {
      id: "kai-son",
      label: "kai-son",
      botUsername: o.botUsername,
      deepLink,
      state: live ? "claimed" : "free",
      session: live ? { cwd: o.dir, tmuxSession: tmux.names.has(o.tmuxSession) ? o.tmuxSession : null } : undefined,
    };
    return { bindings: [binding], unbound: [], tmuxAvailable: tmux.available };
  }

  async function spawn(): Promise<TgSpawnResult> {
    if (alive()) throw new Error("the son is already running — close it first to restart");
    // HOME-override so the telegram plugin reads the son's own bot token. Approved channel
    // (not dev-channels) → no interactive channel prompt; --dangerously-skip-permissions
    // + --add-dir avoids the trust/permission prompts.
    const inner =
      `export HOME=${JSON.stringify(o.sonHome)}; cd ${JSON.stringify(o.dir)}; ` +
      `exec ${o.claudeBin} --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official --add-dir ${JSON.stringify(o.dir)}`;
    await shell([TMUX, "kill-session", "-t", o.tmuxSession]);
    const res = await shell([TMUX, "new-session", "-d", "-s", o.tmuxSession, "-c", o.dir, "/bin/zsh", "-i", "-c", inner], 15000);
    if (res.exitCode !== 0) throw new Error(`tmux new-session failed: ${res.stderr.trim() || "unknown"}`);
    return {
      bindingId: "kai-son",
      botUsername: o.botUsername,
      deepLink,
      tmuxSession: o.tmuxSession,
      dir: o.dir,
      message: `Started kai-son in ${o.dir} → @${o.botUsername}. Give it ~20s to connect, then DM it.`,
    };
  }

  // server has no graceful detach (official plugin, no request-watcher), so detach == close.
  async function closeSession(): Promise<TgActionResult> {
    const bp = botPid();
    const wasAlive = !!(bp && isPidAlive(bp));
    if (!wasAlive && !(await tmuxSessions()).names.has(o.tmuxSession)) {
      return { success: true, message: "kai-son is already stopped." };
    }
    let claudePid: number | undefined;
    if (wasAlive) { try { claudePid = (await resolveClaude(bp!))?.claudePid; } catch {} }
    await shell([TMUX, "kill-session", "-t", o.tmuxSession]);
    if (claudePid) { try { process.kill(claudePid, "SIGKILL"); } catch {} } // claude survives SIGHUP/SIGTERM
    if (bp) { try { process.kill(bp, "SIGTERM"); } catch {} }
    await sleep(800);
    if (bp && isPidAlive(bp)) { try { process.kill(bp, "SIGKILL"); } catch {} }
    return { success: true, message: "Stopped kai-son — session ended." };
  }

  async function matchSession({ cwd }: { cwd: string }): Promise<TgMatch | null> {
    if (!cwd || cwd === "—") return null;
    const b = (await poolStatus()).bindings[0];
    return b.state === "claimed" && b.session?.cwd === cwd ? { binding: b, confidence: "cwd-guess" } : null;
  }

  function capabilities(): TgCapabilities {
    return { canSpawn: true, detachMode: "kill-session", canAttachExisting: false, spawnTargets: [{ label: "monorepo", path: o.dir }] };
  }

  return { poolStatus, spawn, detach: closeSession, kill: closeSession, capabilities, matchSession };
}
