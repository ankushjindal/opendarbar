import {
  Action,
  ActionPanel,
  Alert,
  Color,
  confirmAlert,
  Form,
  Icon,
  Keyboard,
  List,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useCachedState } from "@raycast/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Contact, contactForAgent } from "./lib/contacts";
import {
  ageOf,
  fetchStatus,
  fleetAction,
  fleetPing,
  fleetSpawn,
  isParent,
  MACHINES,
  type FleetAction,
  type FleetAgent,
  type FleetStatus,
  type Machine,
} from "./lib/fleet";
import { useViewAlive } from "./lib/player";
import SendForm from "./send-form";

/**
 * KushConsole · Fleet (0.3) — who's alive on both machines, poke them.
 *
 *   rows        → one per agent, Mac + server sections, read from each dashboard's /api/fleet/status
 *   ↵           → message the agent's Telegram bot (SendForm) · ⌘T open its chat in Telegram
 *   ⌘R restart · ⌘⇧R restart fresh · ⌃X stop (kill + park) · ⌘⇧P park/unpark · ⌘⇧I ping
 *   ⌘L log (dashboard /fleet) · ⌘D open dashboard · ⌘⇧C copy tmux attach command · ⌘⇧N spawn (Mac)
 *   bar         → Raycast's own filtering on name / lease / model
 *   cached      → last snapshot paints instantly; refetch on open, ⌘R on a section, every 30 s
 */
type Snap = Partial<Record<Machine["key"], FleetStatus>>;

const SPAWN_DIRS = [
  { label: "monorepo", dir: "~/work/monorepo" },
  { label: "~ (home)", dir: "~" },
  { label: "KushDarbar", dir: "~/.claude/plugins/local/kushbot" },
];

function pctColor(n: number | null): Color {
  if (n == null) return Color.SecondaryText;
  return n >= 85 ? Color.Red : n >= 70 ? Color.Orange : Color.SecondaryText;
}

function stateIcon(a: FleetAgent) {
  if (a.parked)
    return { source: Icon.CircleFilled, tintColor: Color.SecondaryText };
  if (!a.up) return { source: Icon.Circle, tintColor: Color.Red };
  if (
    a.claim === "stale" ||
    (a.lease && a.kind !== "pool" && a.lease !== a.kind && a.lease !== "parent")
  )
    return { source: Icon.CircleFilled, tintColor: Color.Orange };
  return { source: Icon.CircleFilled, tintColor: Color.Green };
}

function SpawnForm({ m, onDone }: { m: Machine; onDone: () => void }) {
  useViewAlive();
  const { pop } = useNavigation();
  const [busy, setBusy] = useState(false);
  async function submit(v: { engine: string; dir: string; slot: string }) {
    setBusy(true);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Spawning ${v.engine} on ${m.label}…`,
    });
    try {
      const home = process.env.HOME ?? "";
      const r = await fleetSpawn(m, {
        engine: v.engine,
        dir: v.dir.replace(/^~/, home),
        slot: v.slot ? parseInt(v.slot, 10) : undefined,
      });
      toast.style = r.success ? Toast.Style.Success : Toast.Style.Failure;
      toast.title = r.message;
      if (r.success) {
        onDone();
        pop();
      }
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Spawn failed";
      toast.message = (e as Error).message;
    } finally {
      setBusy(false);
    }
  }
  return (
    <Form
      isLoading={busy}
      navigationTitle={`New session · ${m.label}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Spawn" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="engine" title="Engine" defaultValue="claude">
        <Form.Dropdown.Item value="claude" title="claude — normal session" />
        <Form.Dropdown.Item value="codex" title="codex — codex-bridge son" />
        <Form.Dropdown.Item value="dcg" title="dcg — GPT/Grok via gateway" />
      </Form.Dropdown>
      <Form.Dropdown
        id="dir"
        title="Directory"
        defaultValue={SPAWN_DIRS[0].dir}
      >
        {SPAWN_DIRS.map((d) => (
          <Form.Dropdown.Item key={d.dir} value={d.dir} title={d.label} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown id="slot" title="Slot" defaultValue="">
        <Form.Dropdown.Item value="" title="auto" />
        {[1, 2, 3].map((s) => (
          <Form.Dropdown.Item key={s} value={String(s)} title={`slot ${s}`} />
        ))}
      </Form.Dropdown>
    </Form>
  );
}

export default function Command() {
  useViewAlive();
  const { push } = useNavigation();
  const [snap, setSnap] = useCachedState<Snap>("fleet:status", {});
  const [errors, setErrors] = useState<Partial<Record<Machine["key"], string>>>(
    {},
  );
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    await Promise.all(
      MACHINES.map(async (m) => {
        try {
          const st = await fetchStatus(m);
          if (my !== seq.current) return;
          setSnap((cur) => ({ ...cur, [m.key]: st }));
          setErrors((cur) => ({ ...cur, [m.key]: undefined }));
        } catch (e) {
          if (my !== seq.current) return;
          const err = e as Error;
          setErrors((cur) => ({
            ...cur,
            [m.key]:
              err.name === "TimeoutError" ? "unreachable (4 s)" : err.message,
          }));
        }
      }),
    );
    if (my === seq.current) setLoading(false);
  }, [setSnap]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const act = useCallback(
    async (m: Machine, a: FleetAgent, action: FleetAction, fresh = false) => {
      if (action !== "unpark") {
        const label = `${action}${fresh ? " fresh" : ""}`;
        const ok = await confirmAlert({
          title: `${label} ${a.name} on ${m.label}?`,
          message:
            action === "stop"
              ? "Kills the session and parks it. Transcript kept; restart resumes."
              : action === "restart" && isParent(a)
                ? "PARENT — resumes its session but interrupts anything mid-turn."
                : fresh
                  ? "New session; the old transcript stays on disk."
                  : action === "park"
                    ? "Watchdog stops alerting for it."
                    : "Kill + resume the same session.",
          primaryAction: {
            title: label,
            style:
              action === "stop" || fresh
                ? Alert.ActionStyle.Destructive
                : Alert.ActionStyle.Default,
          },
        });
        if (!ok) return;
      }
      const toast = await showToast({
        style: Toast.Style.Animated,
        title: `${action}${fresh ? " fresh" : ""} ${a.name}…`,
        message: "restart can take ~1 min",
      });
      try {
        // server: restart → fleet-ctl start (kill+resume); fresh rides on it.
        // mac: macctl only honours --fresh on `start`, so a fresh restart is stop → start --fresh.
        let r;
        if (fresh && m.key === "mac" && action === "restart") {
          const s = await fleetAction(m, "stop", a.name);
          if (!s.success) throw new Error(s.message);
          r = await fleetAction(m, "start", a.name, true);
        } else r = await fleetAction(m, action, a.name, fresh);
        toast.style = r.success ? Toast.Style.Success : Toast.Style.Failure;
        toast.title = r.message || (r.success ? "done" : "failed");
        toast.message = undefined;
        if (r.success) setTimeout(() => void refresh(), 2500);
      } catch (e) {
        toast.style = Toast.Style.Failure;
        toast.title = `${action} failed`;
        toast.message = (e as Error).message;
      }
    },
    [refresh],
  );

  const ping = useCallback(async (m: Machine, a: FleetAgent) => {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Pinging ${a.name}…`,
      message: "injects a probe turn, waits for the echo (~1 min max)",
    });
    try {
      const r = await fleetPing(m, a.name);
      toast.style = r.success ? Toast.Style.Success : Toast.Style.Failure;
      toast.title = r.message || (r.success ? "pong" : "no reply");
      toast.message = undefined;
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Ping failed";
      toast.message = (e as Error).message;
    }
  }, []);

  const message = useCallback(
    (c: Contact) => {
      push(
        <SendForm
          to={c}
          onSent={() =>
            void showToast({
              style: Toast.Style.Success,
              title: `Delivered to ${c.label}`,
              message: "reply lands in Telegram",
            })
          }
        />,
      );
    },
    [push],
  );

  const attachCmd = (m: Machine, a: FleetAgent, c?: Contact) => {
    const tmux = a.tmuxName ?? c?.fleet?.tmux ?? a.name;
    return m.key === "mac"
      ? `tmux attach -t ${tmux}`
      : `ssh -t server tmux attach -t ${tmux}`;
  };

  const machineActions = (m: Machine) => (
    <ActionPanel.Section title={m.label}>
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={refresh}
      />
      <Action.OpenInBrowser
        title={`Open ${m.label} Dashboard`}
        url={`${m.url}/fleet`}
        shortcut={{ modifiers: ["cmd"], key: "d" }}
      />
      {m.key === "mac" && (
        <Action
          title="Spawn New Session…"
          icon={Icon.Plus}
          shortcut={{ modifiers: ["cmd", "shift"], key: "n" }}
          onAction={() => push(<SpawnForm m={m} onDone={refresh} />)}
        />
      )}
    </ActionPanel.Section>
  );

  const row = (m: Machine, a: FleetAgent) => {
    const c = contactForAgent(a.name);
    const parent = isParent(a);
    const sub = [
      a.kind ?? (parent ? "parent" : "standing"),
      a.lease && a.lease !== a.kind && a.lease !== "parent" ? a.lease : null,
      a.claim === "stale" ? "claim stale" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <List.Item
        key={`${m.key}:${a.name}`}
        icon={stateIcon(a)}
        title={a.name + (parent ? " ★" : "")}
        subtitle={sub}
        keywords={[a.lease, a.model, a.kind ?? "", m.label].filter(Boolean)}
        accessories={[
          ...(a.outbox
            ? [
                {
                  tag: { value: `outbox ${a.outbox}`, color: Color.Blue },
                  tooltip: "unread agent mail",
                },
              ]
            : []),
          ...(a.model ? [{ text: a.model, tooltip: "model" }] : []),
          {
            text: {
              value: a.ctx == null ? "—" : `ctx ${Math.round(a.ctx)}%`,
              color: pctColor(a.ctx),
            },
            tooltip: "context used",
          },
          ...(a.fiveH != null
            ? [
                {
                  text: {
                    value: `5h ${Math.round(a.fiveH)}%`,
                    color: pctColor(a.fiveH),
                  },
                  tooltip: "5-hour usage window",
                },
              ]
            : []),
          {
            text: a.parked ? "parked" : a.up ? "up" : "down",
            tooltip: a.session ? `session ${a.session.slice(0, 8)}` : undefined,
          },
        ]}
        actions={
          <ActionPanel>
            <ActionPanel.Section title={`${a.name} · ${m.label}`}>
              {c ? (
                <Action
                  title={`Message ${c.to}`}
                  icon={Icon.Message}
                  onAction={() => message(c)}
                />
              ) : (
                <Action.OpenInBrowser
                  title="Open in Dashboard"
                  url={`${m.url}/fleet`}
                />
              )}
              {c && (
                <Action.Open
                  title="Open Bot Chat in Telegram"
                  target={`tg://resolve?domain=${c.to.replace(/^@/, "")}`}
                  icon={Icon.Airplane}
                  shortcut={{ modifiers: ["cmd"], key: "t" }}
                />
              )}
              {a.parked ? (
                <>
                  <Action
                    title="Unpark"
                    icon={Icon.Play}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
                    onAction={() => act(m, a, "unpark")}
                  />
                  <Action
                    title="Start"
                    icon={Icon.Power}
                    shortcut={Keyboard.Shortcut.Common.Refresh}
                    onAction={() => act(m, a, "start")}
                  />
                  <Action
                    title="Start Fresh"
                    icon={Icon.Bolt}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
                    onAction={() => act(m, a, "start", true)}
                  />
                </>
              ) : (
                <>
                  <Action
                    title="Restart (Resume)"
                    icon={Icon.ArrowClockwise}
                    shortcut={Keyboard.Shortcut.Common.Refresh}
                    onAction={() => act(m, a, "restart")}
                  />
                  <Action
                    title="Restart Fresh"
                    icon={Icon.Bolt}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
                    onAction={() => act(m, a, "restart", true)}
                  />
                  {a.kind !== "pool" && (
                    <Action
                      title="Ping"
                      icon={Icon.Signal3}
                      shortcut={{ modifiers: ["cmd", "shift"], key: "i" }}
                      onAction={() => ping(m, a)}
                    />
                  )}
                  {!parent && (
                    <Action
                      title="Park"
                      icon={Icon.Pause}
                      shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
                      onAction={() => act(m, a, "park")}
                    />
                  )}
                  {!parent && (
                    <Action
                      title="Stop (Kill + Park)"
                      icon={Icon.Stop}
                      style={Action.Style.Destructive}
                      shortcut={{ modifiers: ["ctrl"], key: "x" }}
                      onAction={() => act(m, a, "stop")}
                    />
                  )}
                </>
              )}
              <Action.OpenInBrowser
                title="Log (Dashboard)"
                url={`${m.url}/fleet#${a.name}`}
                shortcut={{ modifiers: ["cmd"], key: "l" }}
              />
              <Action.CopyToClipboard
                title="Copy Tmux Attach Command"
                content={attachCmd(m, a, c)}
                shortcut={Keyboard.Shortcut.Common.Copy}
              />
              {a.session && (
                <Action.CopyToClipboard
                  title="Copy Session ID"
                  content={a.session}
                />
              )}
            </ActionPanel.Section>
            {machineActions(m)}
          </ActionPanel>
        }
      />
    );
  };

  const sections = MACHINES.map((m) => {
    const st = snap[m.key];
    const err = errors[m.key];
    if (!st && !err) return null;
    const up = st ? st.agents.filter((a) => a.up).length : 0;
    const title = st
      ? `${m.label} · ${up}/${st.agents.length} up · watchdog ${ageOf(st.watchdog.lastCycle)} · ${st.watchdog.alerts6h} alerts 6h${err ? " · stale" : ""}`
      : m.label;
    return (
      <List.Section key={m.key} title={title}>
        {err && (
          <List.Item
            key={`${m.key}:err`}
            icon={{ source: Icon.WifiDisabled, tintColor: Color.SecondaryText }}
            title={
              st
                ? `${m.label} ${err} — showing last snapshot`
                : `${m.label} ${err}`
            }
            actions={<ActionPanel>{machineActions(m)}</ActionPanel>}
          />
        )}
        {st?.agents.map((a) => row(m, a))}
      </List.Section>
    );
  });

  return (
    <List
      isLoading={loading}
      navigationTitle="KushConsole · Fleet"
      searchBarPlaceholder="filter agents · ↵ message · ⌘R restart · ⌃X stop · ⌘⇧P park"
      actions={<ActionPanel>{machineActions(MACHINES[0])}</ActionPanel>}
    >
      {sections}
      {!loading && MACHINES.every((m) => !snap[m.key] && !errors[m.key]) && (
        <List.EmptyView icon={Icon.Network} title="No fleet data yet" />
      )}
    </List>
  );
}
