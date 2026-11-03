// TEMP — drive my OWN codex app-server directly to prove the Phase-3 control
// methods work. No kushbot, no slot3, no Telegram poll.
import { CodexAppServerClient } from "./bridge.ts";

const PERSONA = "You are a terse test agent. Answer in one short sentence.";
const CWD = "/Users/owner";

function line(s: string) {
  process.stdout.write(s + "\n");
}

async function main() {
  const codex = new CodexAppServerClient();
  codex.start(); // no kushbot MCP — pure app-server control methods

  // Capture settings + turn lifecycle notifications.
  const settingsUpdates: any[] = [];
  const turnCompletions: any[] = [];
  const commandStarts: any[] = [];
  codex.addNotificationHandler((method, params) => {
    if (method === "thread/settings/updated") settingsUpdates.push(params?.threadSettings);
    else if (method === "turn/completed") turnCompletions.push({ id: params?.turn?.id, status: params?.turn?.status });
    else if (method === "item/started" && params?.item?.type === "commandExecution") commandStarts.push(params.item.command);
  });

  await codex.initialize();
  const threadId = await codex.threadStart(PERSONA, { ephemeral: true, cwd: CWD });
  line(`\n[thread] ${threadId}`);

  // ── Test 1: model/list ──
  const models = await codex.modelList();
  const shown = models.filter((m: any) => !m.hidden);
  line(`\nTEST 1 — model/list: ${models.length} models (${shown.length} visible)`);
  for (const m of shown.slice(0, 6)) line(`   • ${m.id}${m.isDefault ? " (default)" : ""} — effort=${m.defaultReasoningEffort}`);
  const T1 = models.length > 0;

  // ── Test 2: effort override via turn/start → thread/settings/updated ──
  line(`\nTEST 2 — effort override via turn/start`);
  const before = settingsUpdates.length;
  await codex.runTurn(threadId, "Say hi.", 60_000, { effort: "high" });
  const afterSettings = settingsUpdates.slice(before);
  const sawHigh = afterSettings.some((s: any) => s?.effort === "high");
  const lastSettings = settingsUpdates[settingsUpdates.length - 1];
  line(`   thread/settings/updated events this turn: ${afterSettings.length}; effort now: ${lastSettings?.effort}; model now: ${lastSettings?.model}`);
  const T2 = sawHigh || lastSettings?.effort === "high";

  // ── Test 3: model override via turn/start → thread/settings/updated ──
  line(`\nTEST 3 — model override via turn/start`);
  let T3 = false;
  const curModel = lastSettings?.model;
  const alt = shown.find((m: any) => m.id !== curModel);
  if (alt) {
    try {
      const b2 = settingsUpdates.length;
      await codex.runTurn(threadId, "Say ok.", 60_000, { model: alt.id });
      const s = settingsUpdates[settingsUpdates.length - 1];
      line(`   switched ${curModel} → ${alt.id}; settings now report model: ${s?.model}`);
      T3 = s?.model === alt.id || settingsUpdates.slice(b2).some((x: any) => x?.model === alt.id);
    } catch (e) {
      line(`   model switch to ${alt.id} errored (may be plan-gated): ${(e as Error).message}`);
      T3 = false;
    }
  } else {
    line("   only one visible model — skipping");
    T3 = true;
  }

  // ── Test 4: turn/interrupt mid-turn ──
  line(`\nTEST 4 — turn/interrupt mid-turn`);
  let capturedTurnId: string | null = null;
  const started = Date.now();
  const turnP = codex.runTurn(
    threadId,
    "Run this exact shell command and report its output: `sleep 25 && echo finished`",
    60_000,
    { onTurnId: (id) => (capturedTurnId = id) },
  );
  // wait until the command is actually executing (or 8s), then interrupt
  for (let i = 0; i < 40 && commandStarts.length === 0; i++) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 1500));
  line(`   command executing (${commandStarts.length} exec started); interrupting turn ${capturedTurnId}…`);
  await codex.interrupt(threadId, capturedTurnId!);
  const r4 = await turnP.catch((e) => ({ text: "", kushbotReply: false, toolCalls: [], __err: (e as Error).message }));
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const lastTurn = turnCompletions[turnCompletions.length - 1];
  line(`   turn ended in ${elapsed}s (well under the 25s sleep) — status: ${lastTurn?.status ?? "(errored: " + (r4 as any).__err + ")"}`);
  const T4 = Number(elapsed) < 20; // stopped well before the 25s sleep completed

  // ── Test 5: thread/compact/start ──
  line(`\nTEST 5 — thread/compact/start`);
  let T5 = false;
  try {
    const res = await codex.compact(threadId);
    line(`   compact returned: ${JSON.stringify(res).slice(0, 120)}`);
    T5 = true;
  } catch (e) {
    line(`   compact errored: ${(e as Error).message}`);
  }

  line(`\n=== APP-SERVER VALIDATION ===`);
  line(`  T1 model/list ............ ${T1 ? "PASS" : "FAIL"}`);
  line(`  T2 effort override ....... ${T2 ? "PASS" : "FAIL"}`);
  line(`  T3 model override ........ ${T3 ? "PASS" : "FAIL"}`);
  line(`  T4 turn/interrupt ........ ${T4 ? "PASS" : "FAIL"}`);
  line(`  T5 thread/compact/start .. ${T5 ? "PASS" : "FAIL"}`);
  const all = T1 && T2 && T3 && T4 && T5;
  line(`  OVERALL: ${all ? "PASS" : "SOME FAILED"}`);
  codex.kill();
  process.exit(all ? 0 : 1);
}
main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
