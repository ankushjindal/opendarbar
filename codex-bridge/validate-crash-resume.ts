// TEMP — prove resume restores CONTEXT after a real SIGKILL crash (once the
// thread has a turn, codex has flushed it to disk). No kushbot, no slot3.
import { CodexAppServerClient } from "./bridge.ts";
import { execSync } from "node:child_process";

const CWD = "/Users/owner";
const SECRET = "MANGO";
const line = (s: string) => process.stdout.write(s + "\n");

async function main() {
  // Phase 1: start, run a turn (forces codex to persist the thread), then SIGKILL.
  const c1 = new CodexAppServerClient();
  c1.start();
  await c1.initialize();
  const threadId = await c1.threadStart("You are a terse assistant.", { ephemeral: false, cwd: CWD });
  await c1.runTurn(threadId, `Remember this word for later: ${SECRET}. Reply "ok".`, 60_000);
  const pid = c1.childPid;
  line(`phase1 thread ${threadId}, codex pid ${pid} — SIGKILL (simulate crash)…`);
  try {
    execSync(`kill -9 ${pid}`);
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 1500));

  // Phase 2: fresh codex, resume the SAME threadId, ask for the secret.
  const c2 = new CodexAppServerClient();
  c2.start();
  await c2.initialize();
  let resumedId = "";
  let restored = false;
  try {
    resumedId = await c2.resume(threadId, { cwd: CWD, developerInstructions: "You are a terse assistant." });
    const r = await c2.runTurn(threadId, "What word did I ask you to remember? Answer with ONLY that word.", 60_000);
    restored = new RegExp(SECRET, "i").test(r.text);
    line(`resumed ${resumedId}; codex recalled: ${JSON.stringify(r.text.slice(0, 100))}`);
  } catch (e) {
    line(`resume/recall errored: ${(e as Error).message}`);
  }
  c2.kill();
  const sameId = resumedId === threadId;
  line(`\nCRASH-RESUME (SIGKILL after a turn):`);
  line(`  same threadId ...... ${sameId ? "PASS" : "FAIL"}`);
  line(`  context restored ... ${restored ? "PASS" : "FAIL"} (recalled ${SECRET})`);
  process.exit(sameId && restored ? 0 : 1);
}
main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
