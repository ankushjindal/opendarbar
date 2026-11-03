// TEMP — unit-style check: synthetic command notifications drive the right
// SessionController → codex app-server mapping. No codex, no kushbot, no slot3.
import { SessionController } from "./bridge.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

// Mock codex recording every method call.
const calls: Array<{ m: string; args: any[] }> = [];
const mockCodex: any = {
  interrupt: (...a: any[]) => {
    calls.push({ m: "interrupt", args: a });
    return Promise.resolve({});
  },
  threadStart: (...a: any[]) => {
    calls.push({ m: "threadStart", args: a });
    return Promise.resolve("thread-NEW");
  },
  compact: (...a: any[]) => {
    calls.push({ m: "compact", args: a });
    return Promise.resolve({});
  },
  modelList: (...a: any[]) => {
    calls.push({ m: "modelList", args: a });
    return Promise.resolve([
      { id: "gpt-5-codex", hidden: false },
      { id: "o3", hidden: false },
      { id: "secret", hidden: true },
    ]);
  },
};
const replies: Array<{ chat_id: any; text: string }> = [];
const asks: Array<{ chat_id: any; question: string; options: string[] }> = [];
const reply = async (chat_id: any, text: string) => {
  replies.push({ chat_id, text });
};
const ask = async (chat_id: any, question: string, options: string[]) => {
  asks.push({ chat_id, question, options });
};

const CHAT = process.env.OWNER_CHAT_ID ?? "";
const cmd = (command: string, args = "") => ({ command, args, chat_id: CHAT, message_id: 1 });
const lastReply = () => replies[replies.length - 1]?.text ?? "";
const lastCall = () => calls[calls.length - 1];

async function run() {
  const ctl = new SessionController("thread-0", mockCodex, { persona: "P", cwd: "/tmp" }, reply, ask);

  console.log("/model haiku:");
  await ctl.handleCommand(cmd("model", "haiku"));
  check("sets model override", ctl.model === "haiku", `(got ${ctl.model})`);
  check("turnOverrides carries model", ctl.turnOverrides().model === "haiku");
  check("confirms to user", /haiku/.test(lastReply()));

  console.log("/effort high:");
  await ctl.handleCommand(cmd("effort", "high"));
  check("sets effort override", ctl.effort === "high", `(got ${ctl.effort})`);
  check("turnOverrides carries effort", ctl.turnOverrides().effort === "high");

  console.log("/stop with a running turn:");
  ctl.currentTurnId = "turn-XYZ";
  await ctl.handleCommand(cmd("stop"));
  check("calls turn/interrupt(threadId, turnId)", lastCall()?.m === "interrupt" && lastCall()?.args[0] === "thread-0" && lastCall()?.args[1] === "turn-XYZ", JSON.stringify(lastCall()));
  check("confirms interrupted", /interrupt/i.test(lastReply()));

  console.log("/stop with NO running turn:");
  ctl.currentTurnId = null;
  const callsBefore = calls.length;
  await ctl.handleCommand(cmd("stop"));
  check("does NOT call interrupt", calls.length === callsBefore);
  check("says nothing running", /nothing running/i.test(lastReply()));

  console.log("/compact:");
  await ctl.handleCommand(cmd("compact"));
  check("calls thread/compact/start(threadId)", lastCall()?.m === "compact" && lastCall()?.args[0] === "thread-0");

  console.log("/clear:");
  await ctl.handleCommand(cmd("clear"));
  check("calls threadStart (new thread)", calls.some((c) => c.m === "threadStart"));
  check("swaps in the new threadId", ctl.threadId === "thread-NEW", `(got ${ctl.threadId})`);
  check("confirms cleared", /cleared/i.test(lastReply()));

  console.log("/model (no arg) → model/list + ask buttons:");
  await ctl.handleCommand(cmd("model", ""));
  check("calls model/list", calls.some((c) => c.m === "modelList"));
  const lastAsk = asks[asks.length - 1];
  check("asks with visible model ids only", !!lastAsk && lastAsk.options.includes("gpt-5-codex") && lastAsk.options.includes("o3") && !lastAsk.options.includes("secret"), JSON.stringify(lastAsk));

  console.log("ask-tap reply → applies selection:");
  const consumed = ctl.tryHandleAskReply(cmd("model", ""), "[ask] Pick a codex model: → o3");
  check("consumes the ask reply", consumed === true);
  await new Promise((r) => setTimeout(r, 5)); // applyModel is fire-and-forget
  check("applies chosen model", ctl.model === "o3", `(got ${ctl.model})`);

  console.log("non-ask message is NOT consumed:");
  const notConsumed = ctl.tryHandleAskReply(cmd("model", ""), "hey what's up");
  check("regular message passes through to a turn", notConsumed === false);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
run();
