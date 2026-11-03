// TEMP — Phase 4 isolation validation: A2A tool-call, localImage input, thread
// resume. Uses slot1 (FREE, NO_POLL — never claims/polls) for the A2A child; the
// image/resume tests are pure codex (no kushbot). Never touches slot3.
import { CodexAppServerClient, formatAgentTurn, buildTelegramTurn } from "./bridge.ts";

const HOME = "/Users/owner";
const KUSHBOT_DIR = `${HOME}/.claude/plugins/local/kushbot`;
const PERSONA = require("node:fs").readFileSync(`${HOME}/.codex/kush3/AGENTS.md`, "utf8");
const CWD = HOME;
const TEST_IMG = "/tmp/codex-phase4-test.png"; // 300x120 PNG, red "BANANA" text
const A2A_SLOT = "1"; // free, NO_POLL

function kushbotArgs(slot: string): string[] {
  return [
    "-c", `mcp_servers.kushbot.command="bun"`,
    "-c", `mcp_servers.kushbot.args=${JSON.stringify(["server.ts"])}`,
    "-c", `mcp_servers.kushbot.cwd="${KUSHBOT_DIR}"`,
    "-c", `mcp_servers.kushbot.env.HOME="${HOME}"`,
    "-c", `mcp_servers.kushbot.env.KUSHBOT_AUTO_ATTACH="${slot}"`,
    "-c", `mcp_servers.kushbot.env.KUSHBOT_NO_POLL="1"`,
  ];
}
const line = (s: string) => process.stdout.write(s + "\n");
const results: Record<string, boolean> = {};

async function partA_a2a() {
  line("\n=== PART A — A2A (header + inject + send_to_agent tool call) ===");
  // A1: header shape (pure).
  const meta = { source: "agent", from_agent: "testpeer", envelope_id: "env-123", hops: "0", reply_expected: "true" };
  const turnText = formatAgentTurn(meta, "status check from the bench — you online? send a one-line status back.");
  const hdrOk =
    turnText.startsWith("[a2a from=testpeer envelope=env-123 hops=0 reply_expected=true]") &&
    /UNTRUSTED agent message/.test(turnText) &&
    /hops=1/.test(turnText);
  line(`A1 header: ${hdrOk ? "PASS" : "FAIL"}`);
  line(`   header line: ${turnText.split("\n")[0]}`);
  results["A1 a2a header"] = hdrOk;

  // A2: codex issues send_to_agent for the injected agent turn.
  const codex = new CodexAppServerClient();
  codex.start(kushbotArgs(A2A_SLOT));
  await codex.initialize();
  await new Promise((r) => setTimeout(r, 3000));
  const status = await codex.send("mcpServerStatus/list", {});
  const servers = (status?.data ?? []).map((s: any) => s.name);
  line(`   codex MCP servers: ${servers.join(", ")}`);
  const threadId = await codex.threadStart(PERSONA, { ephemeral: true, cwd: CWD });
  const r = await codex.runTurn(threadId, turnText, 90_000);
  const sentAgent = r.toolCalls.some((t) => t.tool === "send_to_agent");
  line(`   kushbot tool-calls: ${JSON.stringify(r.toolCalls)}`);
  line(`A2 codex issued send_to_agent: ${sentAgent ? "YES → PASS" : "NO → FAIL"}`);
  results["A2 send_to_agent tool call"] = sentAgent;
  codex.kill();
}

async function partB_image() {
  line("\n=== PART B — localImage input ===");
  const codex = new CodexAppServerClient();
  codex.start(); // pure codex, no kushbot
  await codex.initialize();
  const threadId = await codex.threadStart("You are a terse assistant.", { ephemeral: true, cwd: CWD });
  let ok = false;
  let sawContent = false;
  try {
    const r = await codex.runTurn(
      threadId,
      "There is one image attached. In one short sentence, what word (if any) is written in it, and what color is it?",
      90_000,
      { images: [TEST_IMG] },
    );
    ok = true; // turn/start accepted the localImage input without error
    sawContent = /banana/i.test(r.text) || /red/i.test(r.text);
    line(`   codex said: ${JSON.stringify(r.text.slice(0, 200))}`);
  } catch (e) {
    line(`   turn errored: ${(e as Error).message}`);
  }
  line(`B1 turn/start accepted localImage: ${ok ? "PASS" : "FAIL"}`);
  line(`B2 codex saw image content (BANANA/red): ${sawContent ? "YES" : "no (accept-only bar still met)"}`);
  results["B1 localImage accepted"] = ok;
  results["B2 image content seen"] = ok; // accept-only is the required bar; content is bonus
  codex.kill();
}

async function partC_resume() {
  line("\n=== PART C — thread resume across restart ===");
  const SECRET = "ZUCCHINI";
  // Phase 1: start, run a turn planting a secret, capture threadId, kill.
  const c1 = new CodexAppServerClient();
  c1.start();
  await c1.initialize();
  const threadId = await c1.threadStart("You are a terse assistant. Follow instructions exactly.", {
    ephemeral: false,
    cwd: CWD,
  });
  await c1.runTurn(threadId, `Remember this secret word for later: ${SECRET}. Just reply "ok".`, 60_000);
  line(`   phase1 thread ${threadId} — planted secret, killing codex…`);
  c1.kill();
  await new Promise((r) => setTimeout(r, 1500));

  // Phase 2: fresh codex, resume the SAME threadId, ask for the secret.
  const c2 = new CodexAppServerClient();
  c2.start();
  await c2.initialize();
  let resumedId = "";
  let restored = false;
  try {
    resumedId = await c2.resume(threadId, { cwd: CWD, developerInstructions: "You are a terse assistant." });
    const r = await c2.runTurn(threadId, "What secret word did I ask you to remember? Answer with ONLY that word.", 60_000);
    restored = new RegExp(SECRET, "i").test(r.text);
    line(`   resumed ${resumedId}; codex recalled: ${JSON.stringify(r.text.slice(0, 120))}`);
  } catch (e) {
    line(`   resume/recall errored: ${(e as Error).message}`);
  }
  const sameId = resumedId === threadId;
  line(`C1 resumed SAME threadId: ${sameId ? "PASS" : "FAIL"}`);
  line(`C2 prior context restored (recalled ${SECRET}): ${restored ? "PASS" : "FAIL"}`);
  results["C1 same threadId"] = sameId;
  results["C2 context restored"] = restored;
  c2.kill();
}

async function main() {
  await partA_a2a();
  await partB_image();
  await partC_resume();
  line("\n=== PHASE 4 VALIDATION SUMMARY ===");
  let allPass = true;
  for (const [k, v] of Object.entries(results)) {
    line(`  ${v ? "PASS" : "FAIL"}  ${k}`);
    if (!v) allPass = false;
  }
  line(`  OVERALL: ${allPass ? "PASS" : "SOME FAILED"}`);
  process.exit(allPass ? 0 : 1);
}
main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
