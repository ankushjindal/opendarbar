/**
 * One `sendTo()` for every transport. Each branch shells out to the CLI that already owns that
 * channel (tgs, wacli, imsg, gog) — the console never talks to a network itself.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { type Contact, transportLabel } from "./contacts";
import { tgs, type SavedMessage } from "./tgs";

const execFileP = promisify(execFile);

export type SendOpts = { file?: string; voice?: boolean };
export type SendResult = { id?: string; message?: SavedMessage };

export class SendError extends Error {}

async function cli(
  bin: string,
  args: string[],
  timeout = 120_000,
): Promise<string> {
  try {
    const { stdout } = await execFileP(bin, args, {
      timeout,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        HOME: homedir(),
        PATH: `${process.env.PATH ?? ""}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:${homedir()}/bin`,
      },
    });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; message: string; code?: string };
    if (err.code === "ENOENT") throw new SendError(`${bin} not installed`);
    throw new SendError((err.stderr || err.message).trim().slice(0, 300));
  }
}

export async function sendTo(
  c: Contact,
  text: string,
  opts: SendOpts = {},
): Promise<SendResult> {
  const body = text.replace(/\s+$/, "");
  if (!body.trim() && !opts.file) throw new SendError("Nothing to send");

  switch (c.transport) {
    case "tgs": {
      const m = await tgs.send(c.to, body || undefined, opts);
      return { id: String(m.id), message: c.to === "me" ? m : undefined };
    }
    case "wacli": {
      const args = opts.file
        ? [
            "send",
            "file",
            "--to",
            c.to,
            "--file",
            opts.file,
            ...(body ? ["--caption", body] : []),
          ]
        : ["send", "text", "--to", c.to, "--message", body];
      const out = await cli("wacli", ["--json", ...args]);
      return { id: idFrom(out) };
    }
    case "imsg": {
      const args = ["send", "--to", c.to, "--service", "imessage", "--json"];
      // imsg's parser reads a value starting with "-" as an option ("Missing value for option
      // text") and has no --text= form, so a bulleted message gets an invisible word joiner.
      if (body)
        args.push("--text", body.startsWith("-") ? `\u2060${body}` : body);
      if (opts.file) args.push("--file", opts.file);
      const out = await cli("imsg", args);
      return { id: idFrom(out) };
    }
    case "gog": {
      if (opts.file)
        throw new SendError(`${transportLabel("gog")} is text only here`);
      // --text=… not --text …: gog (kong) rejects a value that starts with "-", e.g. "- point one".
      const args = [
        "chat",
        "messages",
        "send",
        c.to,
        `--text=${body}`,
        "--json",
      ];
      if (c.account) args.push("-a", c.account);
      const out = await cli("gog", args);
      return { id: idFrom(out) };
    }
  }
}

function idFrom(stdout: string): string | undefined {
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>;
    const v = j.id ?? j.messageId ?? j.message_id ?? j.name ?? j.resource;
    return v == null ? undefined : String(v);
  } catch {
    return undefined;
  }
}
