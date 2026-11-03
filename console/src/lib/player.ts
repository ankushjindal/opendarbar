/**
 * One audio player for the whole command process.
 *
 * Rules: playback must survive pushing a view (⌘↵, edit form) but stop when the console is
 * closed. Raycast keeps the command's Node process warm after the window closes, so we can't
 * rely on process exit; instead every view we render registers itself with `useViewAlive()`.
 * When the last one unmounts and nothing mounts within GRACE_MS, the console is closed → kill.
 * A push swaps views within the same tick, so it never trips the timer.
 *
 * afplay runs under a sh wrapper in its own process group as a backstop: if this process is
 * ever SIGKILLed, the wrapper notices the parent is gone and kills afplay anyway.
 */
import { spawn } from "node:child_process";
import { useEffect } from "react";

const GRACE_MS = 500;
const PLAYER_SH =
  '/usr/bin/afplay "$0" & p=$!; while kill -0 $p 2>/dev/null && kill -0 $PPID 2>/dev/null; do sleep 0.3; done; kill $p 2>/dev/null';

let pid: number | null = null;
let onEnd: (() => void) | null = null;
let views = 0;
let killTimer: ReturnType<typeof setTimeout> | null = null;

export function stopPlayer(): void {
  if (pid) {
    try {
      process.kill(-pid, "SIGTERM"); // whole group: sh + afplay
    } catch {
      /* already exited */
    }
    pid = null;
  }
  onEnd = null;
}

/** Starts playing `path`; `ended` fires when playback finishes on its own. */
export function startPlayer(path: string, ended: () => void): void {
  stopPlayer();
  const p = spawn("/bin/sh", ["-c", PLAYER_SH, path], {
    stdio: "ignore",
    detached: true,
  });
  p.unref();
  pid = p.pid ?? null;
  onEnd = ended;
  p.on("exit", () => {
    if (pid === p.pid) {
      pid = null;
      const cb = onEnd;
      onEnd = null;
      cb?.();
    }
  });
}

export function isPlaying(): boolean {
  return pid !== null;
}

/** Call once in every view component the console renders (root list, forms, detail). */
export function useViewAlive(): void {
  useEffect(() => {
    views++;
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    return () => {
      views--;
      if (views <= 0) {
        views = 0;
        killTimer = setTimeout(() => {
          killTimer = null;
          if (views === 0) stopPlayer();
        }, GRACE_MS);
      }
    };
  }, []);
}
