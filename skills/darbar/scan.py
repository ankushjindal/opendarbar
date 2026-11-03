#!/usr/bin/env python3
"""darbar scanner — deterministic FACTS, zero judgment (judgment lives in SKILL.md).

Usage:
  python3 scan.py --domain server|bots|git|all        # run on the machine you're on
  ssh server 'python3 - --domain all' < scan.py  # run on server from Mac, no install

Output: one JSON object on stdout. Every check is exception-guarded — a broken
check yields {"error": "..."} for that key, never a dead scan.
"""
import argparse, glob, hashlib, json, os, platform, re, shutil, subprocess, sys, time

IS_MAC = platform.system() == "Darwin"
HOME = os.path.expanduser("~")
NOW = time.time()


def sh(cmd, timeout=10):
    """Run a shell command, return (rc, stdout). Never raises."""
    try:
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout or "").strip()
    except Exception as e:
        return -1, f"ERR:{e}"


def guard(fn):
    try:
        return fn()
    except Exception as e:
        return {"error": str(e)[:200]}


def age_h(ts):
    return round((NOW - ts) / 3600, 1)


# ---------------------------------------------------------------- server ----

def srv_disk():
    du = shutil.disk_usage("/")
    return {"pct_used": round(du.used / du.total * 100), "free_gb": round(du.free / 2**30, 1)}


def srv_ram():
    if IS_MAC:
        _, ms = sh("sysctl -n hw.memsize")
        total = int(ms)
        _, vm = sh("vm_stat")
        page = 16384 if "16384" in vm.splitlines()[0] else 4096
        free = sum(int(re.search(r"(\d+)\.", l).group(1))
                   for l in vm.splitlines() if l.startswith(("Pages free", "Pages inactive")))
        return {"pct_used": round((1 - free * page / total) * 100)}
    with open("/proc/meminfo") as f:
        mi = dict(re.findall(r"(\w+):\s+(\d+)", f.read()))
    return {"pct_used": round((1 - int(mi["MemAvailable"]) / int(mi["MemTotal"])) * 100)}


def srv_load():
    l1, l5, l15 = os.getloadavg()
    return {"load1": round(l1, 2), "cores": os.cpu_count()}


def srv_uptime():
    if IS_MAC:
        _, out = sh("sysctl -n kern.boottime")
        m = re.search(r"sec = (\d+)", out)
        boot = int(m.group(1))
    else:
        with open("/proc/uptime") as f:
            boot = NOW - float(f.read().split()[0])
    return {"days": round((NOW - boot) / 86400, 1)}


def srv_tailscale():
    ts_bin = shutil.which("tailscale") or "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    rc, out = sh(f'"{ts_bin}" status --json', timeout=8)
    if rc != 0:
        return {"error": out[:120]}
    d = json.loads(out)
    peer_want = "laptop" if not IS_MAC else "server"
    peer_online = None
    for p in (d.get("Peer") or {}).values():
        if peer_want in (p.get("HostName", "") + p.get("DNSName", "")):
            peer_online = bool(p.get("Online"))
    return {"self_online": bool((d.get("Self") or {}).get("Online")), "peer": peer_want, "peer_online": peer_online}


def srv_gateway():
    keyf = os.path.join(HOME, ".cli-proxy-api", "client-key.txt")
    if not os.path.exists(keyf):
        return {"installed": False}
    import urllib.request
    key = open(keyf).read().strip()
    req = urllib.request.Request("http://127.0.0.1:8317/v1/models", headers={"x-api-key": key})
    try:
        body = json.load(urllib.request.urlopen(req, timeout=4))
        return {"installed": True, "up": True, "models": len(body.get("data", []))}
    except Exception as e:
        return {"installed": True, "up": False, "error": str(e)[:120]}


def srv_services():
    out = {}
    if IS_MAC:
        rc, _ = sh("curl -sf -m 3 -o /dev/null http://127.0.0.1:3456/")
        out["dashboard_3456"] = "up" if rc == 0 else "down"
        rc, o = sh("launchctl list | grep com.kush.claude-data-backup")
        out["backup_launchagent"] = "loaded" if rc == 0 else "NOT LOADED"
    else:
        for unit in ["cliproxyapi.service"]:
            _, st = sh(f"systemctl --user is-active {unit}")
            out[unit] = st
        _, failed = sh("systemctl --user --failed --plain --no-legend | wc -l")
        out["failed_user_units"] = int(failed or 0)
        _, failed_sys = sh("systemctl --failed --plain --no-legend 2>/dev/null | wc -l")
        out["failed_system_units"] = int(failed_sys or 0)
    return out


def srv_watchdog():
    if IS_MAC:
        return {"n/a": True}
    _, out = sh("systemctl --user list-timers fleet-watchdog.timer --no-pager --no-legend")
    flags = []
    for f in glob.glob(os.path.expanduser("~/kai/state/maint-*")):
        try:
            exp = int(open(f).read().strip() or 0)
        except ValueError:
            exp = 0
        flags.append({"flag": os.path.basename(f), "valid": exp > NOW,
                      "expires_in_h": age_h(NOW) if exp <= NOW else round((exp - NOW) / 3600, 1)})
    return {"timer": out[:100] or "MISSING", "maint_flags": flags}


def srv_backups():
    out = {}
    logs = {"mac_claude+codex": "~/kush/logs/claude-data-backup.log"} if IS_MAC else {
        "claude-data-server": "~/kai/logs/claude-data-server-backup.log",
        "codex-data-server": "~/kai/logs/codex-data-server-backup.log"}
    for name, lp in logs.items():
        lp = os.path.expanduser(lp)
        _, tail = sh(f"tail -1 '{lp}' 2>/dev/null")
        out[name] = {"last_log": tail[:160] or "NO LOG"}
    repos = [os.path.join(HOME, ".claude"), os.path.join(HOME, ".codex")] if IS_MAC else [
        os.path.join(HOME, "claude-data-server"), os.path.join(HOME, "codex-data-server")]
    for r in repos:
        rc, ct = sh(f"git -C '{r}' log -1 --format=%ct 2>/dev/null")
        out.setdefault(os.path.basename(r), {})["last_commit_age_h"] = age_h(int(ct)) if rc == 0 and ct.isdigit() else None
    return out


def srv_oat():
    if IS_MAC:
        return {"n/a": True}
    _, out = sh("tail -2 ~/kai/logs/oat-probe.log 2>/dev/null || ls ~/kai/logs | grep -i oat")
    return {"tail": out[:200] or "no oat log found"}


def domain_server():
    return {
        "disk": guard(srv_disk), "ram": guard(srv_ram), "load": guard(srv_load),
        "uptime": guard(srv_uptime), "tailscale": guard(srv_tailscale),
        "gateway": guard(srv_gateway), "services": guard(srv_services),
        "watchdog": guard(srv_watchdog), "backups": guard(srv_backups), "oat": guard(srv_oat),
    }


# ------------------------------------------------------------------ bots ----

def pane_info(tmux):
    rc, _ = sh(f"tmux has-session -t {tmux} 2>/dev/null")
    if rc != 0:
        return {"tmux": False}
    _, pane = sh(f"tmux capture-pane -t {tmux} -p -S -12 2>/dev/null")
    lines = [l for l in pane.splitlines() if l.strip()]
    model = None
    for l in reversed(lines):
        m = re.match(r"\s*((?:gpt|grok|claude)-[A-Za-z0-9.-]+|Fable|Opus(?: [\d.]+)?|Sonnet(?: [\d.]+)?|Haiku(?: [\d.]+)?)(?::[a-z]+)?\s*\|", l)
        if m and "|" in l:
            model = m.group(1).strip()
            break
    return {"tmux": True, "busy": "esc to interrupt" in pane.lower(),
            "pane_model": model, "pane_tail": lines[-2:] if lines else []}


def claude_pid_via_tmux(tmux):
    """Mac: shared HOME makes env-matching ambiguous — walk the pane's process
    tree instead (pane shell → ... → claude, max depth 3)."""
    _, ppid = sh(f"tmux list-panes -t {tmux} -F '#{{pane_pid}}' 2>/dev/null | head -1")
    frontier = [ppid.strip()] if ppid.strip().isdigit() else []
    for _ in range(3):
        nxt = []
        for p in frontier:
            _, cmd = sh(f"ps -o command= -p {p} 2>/dev/null", timeout=5)
            if "claude" in cmd:
                return int(p)
            _, kids = sh(f"pgrep -P {p} 2>/dev/null", timeout=5)
            nxt += kids.split()
        frontier = nxt
    return None


def proc_for_home(home, tmux=None):
    """Find claude pid + engine (linux: /proc envs by HOME; mac: pane tree + ps eww)."""
    if IS_MAC:
        pid = claude_pid_via_tmux(tmux) if tmux else None
        if not pid:
            return {"pid": None, "engine": None}
        _, env = sh(f"ps eww -p {pid} 2>/dev/null", timeout=5)
        gw = "ANTHROPIC_BASE_URL=http://127.0.0.1:8317" in env
        return {"pid": pid, "engine": "gateway" if gw else "claude"}
    for pdir in glob.glob("/proc/[0-9]*"):
        try:
            with open(f"{pdir}/cmdline", "rb") as f:
                cmd = f.read().decode(errors="replace")
            if "claude" not in cmd or "--dangerously" not in cmd:
                continue
            with open(f"{pdir}/environ", "rb") as f:
                env = f.read().decode(errors="replace")
            if f"\0HOME={home}\0" in env or env.startswith(f"HOME={home}\0"):
                gw = "ANTHROPIC_BASE_URL=http://127.0.0.1:8317" in env
                return {"pid": int(os.path.basename(pdir)), "engine": "gateway" if gw else "claude"}
        except Exception:
            continue
    return {"pid": None, "engine": None}


def pollers_for_home(home):
    """ALL bun pids running this home's kushbot (normally 2: `bun run` wrapper
    + child). The claim pid is one of them."""
    plugin = os.path.join(home, ".claude/plugins/local/kushbot")
    if IS_MAC:
        rc, out = sh(f"pgrep -f '{plugin}'")
        return [int(p) for p in out.split()] if rc == 0 else []
    pids = []
    for pdir in glob.glob("/proc/[0-9]*"):
        try:
            if os.readlink(f"{pdir}/cwd") == plugin:
                pids.append(int(os.path.basename(pdir)))
        except Exception:
            continue
    return pids


def newest_session(home):
    js = glob.glob(os.path.join(home, ".claude/projects/*/*.jsonl"))
    if not js:
        return None, None
    latest = max(js, key=os.path.getmtime)
    return os.path.basename(latest)[:-6], age_h(os.path.getmtime(latest))


def status_cache(sid):
    f = f"/tmp/.claude_status_{sid}.json"
    if sid and os.path.exists(f):
        try:
            d = json.load(open(f))
            return {"model": d.get("model"), "ctx_pct": d.get("ctx_pct"), "five_h_pct": d.get("five_h_pct")}
        except Exception:
            pass
    return {}


def bot_record(name, home, tmux, parked=False):
    rec = {"name": name, "home": home, "tmux_name": tmux, "parked": parked}
    rec.update(guard(lambda: pane_info(tmux)))
    rec.update(guard(lambda: proc_for_home(home, tmux=tmux)))
    rec["poller_pids"] = guard(lambda: pollers_for_home(home))
    claim_f = os.path.join(home, ".claude/channels/telegram/claimed_by.pid")
    if not os.path.exists(claim_f) and IS_MAC:
        claim_f = None  # mac slots carry their own claim files, handled by caller
    if claim_f and os.path.exists(claim_f):
        try:
            cpid = int(open(claim_f).read().strip())
            alive = (sh(f"kill -0 {cpid} 2>/dev/null && echo y")[1] == "y")
            pollers = rec.get("poller_pids") or []
            rec["claim"] = {"pid": cpid, "alive": alive,
                            "matches_poller": cpid in pollers if isinstance(pollers, list) else None}
        except Exception as e:
            rec["claim"] = {"error": str(e)[:80]}
    try:
        sid, act_h = newest_session(home)
    except Exception:
        sid, act_h = None, None
    rec["session_id"] = sid
    rec["last_activity_h"] = act_h
    rec.update(guard(lambda: status_cache(sid)))
    rec["creds_present"] = os.path.exists(os.path.join(home, ".claude/.credentials.json"))
    if not IS_MAC:
        mf = os.path.expanduser(f"~/kai/state/maint-{name}")
        if os.path.exists(mf):
            try:
                exp = int(open(mf).read().strip() or 0)
            except ValueError:
                exp = 0
            rec["maint_flag"] = {"valid": exp > NOW}
    return rec


def domain_bots():
    bots = []
    if IS_MAC:
        # slot pool: slot0 = kc parent, slots 1-3 = sons in tmux kush<N>
        for n in range(4):
            sdir = os.path.join(HOME, f".claude/channels/kushbots/slot{n}")
            if not os.path.isdir(sdir):
                continue
            rec = {"name": f"slot{n}" if n else "kush(kc)", "slot": n,
                   "token_present": os.path.exists(os.path.join(sdir, ".env"))}
            cf = os.path.join(sdir, "claimed_by.pid")
            if os.path.exists(cf):
                try:
                    cpid = int(open(cf).read().strip())
                    alive = sh(f"kill -0 {cpid} 2>/dev/null && echo y")[1] == "y"
                    rec["claim"] = {"pid": cpid, "alive": alive}
                except Exception as e:
                    rec["claim"] = {"error": str(e)[:80]}
            else:
                rec["claim"] = None
            if n:
                for tname in (f"kush{n}", f"kush-slot{n}"):
                    if sh(f"tmux has-session -t {tname} 2>/dev/null")[0] == 0:
                        rec.update(pane_info(tname))
                        rec["tmux_name"] = tname
                        rec.update(proc_for_home(HOME, tmux=tname))
                        break
                else:
                    rec["tmux"] = False
            bots.append(guard(lambda r=rec: r) or rec)
        # codex-bridge sons
        for t in sh("tmux ls -F '#{session_name}' 2>/dev/null")[1].splitlines():
            if t.startswith("codex-slot"):
                bots.append({"name": t, "engine": "codex", **pane_info(t)})
        # STANDING Mac agents (munshi pattern, laptop edition — e.g. reddit-hunter):
        # registry-driven, own HOME, managed by fleet/macctl + launchd fleet-ensure.
        try:
            reg = json.load(open(os.path.join(HOME, ".claude/channels/fleet/registry.json")))
            for a in reg.get("agents", []):
                if a.get("machine") != "laptop" or not a.get("home"):
                    continue
                if a["home"] == HOME or not a.get("spawn"):
                    continue  # pool/kc entries — not standing agents
                bots.append(guard(lambda a=a: bot_record(
                    a["name"], a["home"], a.get("tmux", a["name"]), a.get("parked", False))))
        except Exception as e:
            bots.append({"name": "mac-standing-agents", "error": str(e)[:120]})
    else:
        reg = json.load(open(os.path.join(HOME, ".claude/channels/fleet/registry.json")))
        for a in reg.get("agents", []):
            if a.get("machine") not in (None, "server") or not a.get("home"):
                continue  # entries for other machines (e.g. Mac kc) live here for A2A only
            bots.append(guard(lambda a=a: bot_record(
                a["name"], a.get("home", HOME), a.get("tmux", a["name"]), a.get("parked", False))))
    return {"bots": bots}


# ------------------------------------------------------------------- git ----

def repo_status(path, deep=False):
    path = os.path.expanduser(path)
    if not os.path.isdir(path):
        return {"path": path, "missing": True}
    rec = {"path": path}
    _, rec["branch"] = sh(f"git -C '{path}' rev-parse --abbrev-ref HEAD 2>/dev/null")
    rc, dirty = sh(f"git -C '{path}' status --porcelain 2>/dev/null")
    dl = [l for l in dirty.splitlines() if l.strip()]
    rec["dirty_count"] = len(dl)
    rec["dirty"] = dl[:20]
    rc, ab = sh(f"git -C '{path}' rev-list --left-right --count HEAD...@{{upstream}} 2>/dev/null")
    if rc == 0 and ab:
        ahead, behind = ab.split()
        rec["ahead"], rec["behind"] = int(ahead), int(behind)
    _, ct = sh(f"git -C '{path}' log -1 --format=%ct 2>/dev/null")
    rec["last_commit_age_h"] = age_h(int(ct)) if ct.isdigit() else None
    if deep:
        _, subs = sh(f"git -C '{path}' submodule status 2>/dev/null", timeout=20)
        rec["submodules"] = [{"raw": l.strip(), "drift": l[:1] in "+-U"} for l in subs.splitlines() if l.strip()]
    return rec


def _tree_hash(root):
    """Hash the full kushbot SOURCE SET, not just server.ts.

    Since the 2026-07-14 split the server is server.ts + src/*.ts, and every boot
    runs `bun install && bun server.ts` — so package.json and bun.lock are part of
    the deployed artifact too. Hashing only server.ts would call a home "in sync"
    while its src/ was missing or a generation behind, which is the exact state
    that boots into `Cannot find module './src/config'` and leaves a son deaf.
    """
    h = hashlib.md5()
    files = ["server.ts", "package.json", "bun.lock"] + sorted(
        os.path.relpath(f, root) for f in glob.glob(os.path.join(root, "src", "*.ts"))
    )
    seen = 0
    for rel in files:
        f = os.path.join(root, rel)
        if not os.path.exists(f):
            continue
        seen += 1
        h.update(rel.encode())
        h.update(b"\0")
        h.update(open(f, "rb").read())
    return h.hexdigest(), seen


def kushdarbar_drift():
    """server: do the per-home plugin copies match the repo? (whole source set)"""
    repo = os.path.expanduser("~/kai/KushDarbar")
    if IS_MAC or not os.path.exists(os.path.join(repo, "server.ts")):
        return {"n/a": True}
    ref, ref_n = _tree_hash(repo)
    stale, missing_src = [], []
    homes = glob.glob(os.path.expanduser("~/*-home/.claude/plugins/local/kushbot")) + \
            [os.path.expanduser("~/.claude/plugins/local/kushbot")]
    for home in homes:
        if not os.path.exists(os.path.join(home, "server.ts")):
            continue
        # A home carrying the NEW server.ts with NO src/ cannot boot. Call that out
        # separately from ordinary staleness — it is a broken son, not an old one.
        if not glob.glob(os.path.join(home, "src", "*.ts")):
            if os.path.exists(os.path.join(repo, "src")):
                missing_src.append(home)
                continue
        h, _ = _tree_hash(home)
        if h != ref:
            stale.append(home)
    return {
        "repo_hash": ref[:8],
        "files_hashed": ref_n,
        "stale_copies": stale,
        "missing_src": missing_src,   # BOOT-BREAKING if non-empty
    }


def domain_git(deep_sk=True):
    if IS_MAC:
        repos = {
            "monorepo": repo_status("~/work/monorepo", deep=deep_sk),
            "KushDarbar": repo_status("~/.claude/plugins/local/kushbot"),
            "claude-data": repo_status("~/.claude"),
            "codex-data": repo_status("~/.codex"),
        }
    else:
        repos = {
            "monorepo": repo_status("~/monorepo", deep=deep_sk),
            "KushDarbar": repo_status("~/kai/KushDarbar"),
            "claude-data-server": repo_status("~/claude-data-server"),
            "codex-data-server": repo_status("~/codex-data-server"),
        }
    return {"repos": repos, "kushdarbar_home_copies": guard(kushdarbar_drift)}


# ------------------------------------------------------------------ main ----

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", default="all", choices=["server", "bots", "git", "all"])
    args = ap.parse_args()
    out = {"machine": "mac" if IS_MAC else "server", "ts": int(NOW), "scanner": "darbar/1"}
    if args.domain in ("server", "all"):
        out["server"] = guard(domain_server)
    if args.domain in ("bots", "all"):
        out["bots"] = guard(domain_bots)
    if args.domain in ("git", "all"):
        out["git"] = guard(domain_git)
    print(json.dumps(out, indent=1))
