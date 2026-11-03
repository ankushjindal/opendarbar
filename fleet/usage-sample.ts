#!/usr/bin/env bun
// Hourly checkpoint for the /usage dashboard: probe every seat with a stored
// token (1-token Fable call each) and append the readings to
// ~/kai/state/usage-history.jsonl. Run by kushdarbar-usage-sample.timer.
import { sampleAll } from "../dashboard/lib/usage";

const out = await sampleAll("timer");
for (const s of out) {
  const f = s.scoped?.oi ? `${Math.round(s.scoped.oi.u)}%` : "?";
  console.log(`${s.label.padEnd(14)} http=${s.http} 5h=${s.five ? Math.round(s.five.u) + "%" : "?"} week=${s.week ? Math.round(s.week.u) + "%" : "?"} fable=${f}${s.err ? "  ERR " + s.err : ""}`);
}
