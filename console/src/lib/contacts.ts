/**
 * Address book for Send. Two sources, merged:
 *   1. ~/.config/kushconsole/contacts.json — people + explicit aliases (kept out of the repo;
 *      ships in the KushDarbar secrets bundle). Shape: { "<key>": { transport, to, label, account? } }
 *   2. ~/.claude/channels/fleet/registry.json — every fleet agent that carries a `bot` field becomes
 *      `@<name>` on Telegram automatically. Explicit entries win on key collisions.
 * "me" (Saved Messages) always exists.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";

export type Transport = "tgs" | "wacli" | "imsg" | "gog";

export type Contact = {
  key: string; // what follows the @, lowercase
  label: string;
  transport: Transport;
  to: string; // tgs: me | @bot · wacli: 91… · imsg: email/phone · gog: spaces/…
  account?: string; // gog: Workspace account (-a)
  fleet?: { name: string; machine: string; tmux: string };
};

export const CONTACTS_FILE = `${homedir()}/.config/kushconsole/contacts.json`;
export const REGISTRY_FILE = `${homedir()}/.claude/channels/fleet/registry.json`;

export const ME: Contact = {
  key: "me",
  label: "Saved Messages",
  transport: "tgs",
  to: "me",
};

export function transportLabel(t: Transport): string {
  return t === "tgs"
    ? "Telegram"
    : t === "wacli"
      ? "WhatsApp"
      : t === "imsg"
        ? "iMessage"
        : "Google Chat";
}

type RegistryAgent = {
  name: string;
  machine?: string;
  tmux?: string;
  bot?: string;
};

function mtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

let cache: { stamp: string; list: Contact[] } | null = null;

/** Merged, ordered list: explicit contacts first (file order), then fleet bots, then me. Re-read on file change. */
export function contacts(): Contact[] {
  const stamp = `${mtime(CONTACTS_FILE)}:${mtime(REGISTRY_FILE)}`;
  if (cache && cache.stamp === stamp) return cache.list;

  const out = new Map<string, Contact>();
  try {
    const raw = JSON.parse(readFileSync(CONTACTS_FILE, "utf8")) as Record<
      string,
      Omit<Contact, "key">
    >;
    for (const [k, v] of Object.entries(raw)) {
      const key = k.toLowerCase();
      if (!v || !v.transport || !v.to) continue;
      out.set(key, { ...v, key, label: v.label ?? k });
    }
  } catch {
    /* no file yet — fleet + me still work */
  }
  try {
    const reg = JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as {
      agents?: RegistryAgent[];
    };
    for (const a of reg.agents ?? []) {
      if (!a.bot) continue;
      const key = a.name.toLowerCase();
      const fleet = {
        name: a.name,
        machine: a.machine === "laptop" ? "mac" : (a.machine ?? "?"),
        tmux: a.tmux ?? a.name,
      };
      const existing = out.get(key);
      if (existing) {
        if (!existing.fleet) existing.fleet = fleet;
        continue;
      }
      out.set(key, {
        key,
        label: `${a.name} · ${fleet.machine}`,
        transport: "tgs",
        to: `@${a.bot.replace(/^@/, "")}`,
        fleet,
      });
    }
  } catch {
    /* no registry on this machine */
  }
  if (!out.has("me")) out.set("me", ME);
  const list = [...out.values()];
  cache = { stamp, list };
  return list;
}

export function findContact(key: string): Contact | undefined {
  const k = key.toLowerCase();
  return contacts().find((c) => c.key === k);
}

/** Contact for a fleet agent name (registry `bot`), if any. */
export function contactForAgent(name: string): Contact | undefined {
  const n = name.toLowerCase();
  return contacts().find((c) => c.fleet?.name.toLowerCase() === n);
}

export function matchContacts(prefix: string): Contact[] {
  const p = prefix.toLowerCase();
  if (!p) return contacts();
  return contacts().filter(
    (c) => c.key.startsWith(p) || c.label.toLowerCase().includes(p),
  );
}

export type SendRequest =
  | { mode: "pick"; prefix: string }
  | { mode: "compose"; contact: Contact; text: string }
  | { mode: "unknown"; key: string; text: string };

/** `@alice pick up milk` → compose · `@al` → pick · `@nobody hi` → unknown. null unless the bar starts with @. */
export function parseSend(bar: string): SendRequest | null {
  if (!bar.startsWith("@")) return null;
  const sp = bar.search(/\s/);
  if (sp === -1) return { mode: "pick", prefix: bar.slice(1) };
  const key = bar.slice(1, sp);
  const text = bar.slice(sp + 1);
  const contact = findContact(key);
  return contact
    ? { mode: "compose", contact, text }
    : { mode: "unknown", key, text };
}

/** URL that opens the chat in its native app; null when there is none. */
export function chatUrl(c: Contact, meName?: string | null): string | null {
  switch (c.transport) {
    case "tgs": {
      const u = c.to === "me" ? meName : c.to.replace(/^@/, "");
      return u ? `tg://resolve?domain=${u}` : null;
    }
    case "wacli":
      return `whatsapp://send?phone=${c.to.replace(/@.*$/, "").replace(/\D/g, "")}`;
    case "imsg":
      return `imessage://${c.to}`;
    case "gog": {
      const id = c.to.replace(/^spaces\//, "");
      return `https://chat.google.com/dm/${id}`;
    }
  }
}
