// Tiny structured logger. Replaces ad-hoc console.log scattered across the codebase.
// Format: ISO-ts [LEVEL] [prefix] message

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const ACTIVE_LEVEL: Level = (process.env.DASHBOARD_LOG_LEVEL as Level) || "info";
const MIN = LEVELS[ACTIVE_LEVEL] ?? LEVELS.info;

function emit(level: Level, prefix: string, args: unknown[]): void {
  if (LEVELS[level] < MIN) return;
  const ts = new Date().toISOString();
  const tag = `[${level.toUpperCase()}]`;
  const pfx = prefix ? `[${prefix}]` : "";
  const stream = level === "error" ? console.error : console.log;
  stream(`${ts} ${tag} ${pfx}`, ...args);
}

export function log(prefix: string = "") {
  return {
    debug: (...args: unknown[]) => emit("debug", prefix, args),
    info:  (...args: unknown[]) => emit("info",  prefix, args),
    warn:  (...args: unknown[]) => emit("warn",  prefix, args),
    error: (...args: unknown[]) => emit("error", prefix, args),
  };
}

export const baseLog = log();
