export async function shell(
  cmd: string[],
  timeout = 10000,
  opts?: { cwd?: string }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", cwd: opts?.cwd });
  const timer = setTimeout(() => proc.kill(), timeout);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  // Must await exit before reading exitCode — otherwise it can still be null
  // (→ coerced to 1) even on success, breaking exitCode-based callers.
  await proc.exited;
  clearTimeout(timer);
  return { stdout, stderr, exitCode: proc.exitCode ?? 1 };
}
