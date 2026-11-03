#!/usr/bin/env python3
"""tgs — Telegram Saved Messages CLI (V0.1). See PRODUCT.md.

Two execution paths, same command handlers:
  warm: tgs -> unix socket -> tgsd (resident Telethon client)  ~30-50 ms
  cold: tgs -> Telethon in-process                            ~1-2 s, then spawns tgsd

Layout (~/.config/tgs, chmod 700):
  creds.json     api_id / api_hash            (chmod 600)
  tgs.session    Telethon session = account access (chmod 600)
  tgs.sock       daemon socket
  tgsd.log / tgsd.pid
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

CFG = Path(os.environ.get("TGS_HOME", Path.home() / ".config" / "tgs"))
CREDS = CFG / "creds.json"
SESSION = CFG / "tgs"  # Telethon appends .session
SOCK = CFG / "tgs.sock"
MEDIA_DIR = Path(os.environ.get("TGS_MEDIA_DIR", Path.home() / ".cache" / "tgs" / "media"))
REC_DIR = MEDIA_DIR.parent / "rec"
REC_PID = REC_DIR / "rec.pid"
STT = os.environ.get("TGS_STT") or str(Path.home() / ".claude" / "skills" / "voice-bridge" / "transcribe.sh")
FFMPEG = os.environ.get("TGS_FFMPEG") or next((p for p in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg") if os.path.exists(p)), "ffmpeg")
LOG = CFG / "tgsd.log"
PIDF = CFG / "tgsd.pid"
LOCK = CFG / "tgsd.lock"
LAUNCHD_LABEL = "com.example.tgsd"
PEER = "me"

EXIT_OK, EXIT_TG, EXIT_AUTH = 0, 1, 2


class AuthNeeded(Exception):
    pass


# ----------------------------------------------------------------- helpers
def load_creds() -> dict:
    if not CREDS.exists():
        raise AuthNeeded("no credentials — run: tgs login")
    return json.loads(CREDS.read_text())


def media_info(m) -> dict:
    """Classify real attachments. Link previews (MessageMediaWebPage) are NOT media."""
    from telethon.tl import types as t

    md = m.media
    info = {"media_type": None, "file_name": None, "mime": None, "size": None, "duration": None}
    if md is None or isinstance(md, t.MessageMediaWebPage):
        return info
    if isinstance(md, t.MessageMediaPhoto):
        info.update(media_type="photo", mime="image/jpeg")
        return info
    if isinstance(md, t.MessageMediaDocument) and md.document:
        doc = md.document
        info["mime"] = doc.mime_type
        info["size"] = doc.size
        kind = "document"
        for a in doc.attributes:
            if isinstance(a, t.DocumentAttributeFilename):
                info["file_name"] = a.file_name
            elif isinstance(a, t.DocumentAttributeSticker):
                kind = "sticker"
            elif isinstance(a, t.DocumentAttributeVideo):
                kind = "gif" if getattr(a, "round_message", False) is False and (doc.mime_type == "image/gif") else "video"
                info["duration"] = round(float(a.duration or 0)) or None
            elif isinstance(a, t.DocumentAttributeAudio):
                kind = "voice" if a.voice else "audio"
                info["duration"] = round(float(a.duration or 0)) or None
            elif isinstance(a, t.DocumentAttributeAnimated):
                kind = "gif"
        info["media_type"] = kind
        return info
    info["media_type"] = type(md).__name__.replace("MessageMedia", "").lower() or "other"
    return info


def fmt(m) -> dict:
    mi = media_info(m)
    return {
        "id": m.id,
        "date": m.date.astimezone().isoformat(timespec="minutes"),
        "text": m.message or "",
        "media": mi["media_type"] is not None,
        "edited": m.edit_date is not None,
        "pinned": bool(getattr(m, "pinned", False)),
        **mi,
    }


def oneline(s: str, n: int = 80) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def notify(title: str, body: str) -> None:
    body = body.replace('"', "'")
    subprocess.run(
        ["osascript", "-e", f'display notification "{body}" with title "{title}"'],
        capture_output=True,
    )


# ------------------------------------------------------- telethon handlers
async def make_client():
    from telethon import TelegramClient

    c = load_creds()
    # connection_retries=None: keep retrying forever (default 5 gave up for good after a
    # network blip on 2026-09-04 and the daemon sat "disconnected" until restarted).
    client = TelegramClient(str(SESSION), int(c["api_id"]), c["api_hash"],
                            connection_retries=None, retry_delay=5, auto_reconnect=True)
    await client.connect()
    if not await client.is_user_authorized():
        await client.disconnect()
        raise AuthNeeded("session not authorized — run: tgs login")
    return client


async def resolve_id(client, ref: str) -> int:
    ref = str(ref).strip()
    if ref.lstrip("-").isdigit() and int(ref) > 0:
        return int(ref)
    if ref == "last":
        ref = "-1"
    if ref.startswith("-") and ref[1:].isdigit():
        k = int(ref[1:])
        msgs = await client.get_messages(PEER, limit=k)
        if len(msgs) < k:
            raise ValueError(f"only {len(msgs)} saved messages; cannot resolve {ref}")
        return msgs[k - 1].id
    raise ValueError(f"bad message ref: {ref!r} (use an id, last, -1, -2 …)")


def parse_peer(to) -> str | int:
    """'me' | '@username' | username | numeric id → Telethon entity ref."""
    t = str(to or "").strip()
    if t in ("", "me", "@me", "saved"):
        return PEER
    if t.lstrip("-").isdigit():
        return int(t)
    return t.lstrip("@")


def fmt_dialog(d) -> dict:
    e = d.entity
    kind = "user" if getattr(e, "first_name", None) is not None else "channel" if getattr(e, "broadcast", False) else "group"
    if getattr(e, "bot", False):
        kind = "bot"
    return {
        "id": d.id,
        "name": d.name or "",
        "username": getattr(e, "username", None),
        "kind": kind,
        "unread": d.unread_count,
        "date": d.date.astimezone().isoformat(timespec="minutes") if d.date else None,
        "pinned": bool(d.pinned),
    }


async def deliver(client, peer, a: dict):
    """Text / --file / --voice to any peer. Shared by `add` (Saved) and `send`."""
    if a.get("voice"):
        from telethon.tl.types import DocumentAttributeAudio

        path = ensure_opus(a["voice"])
        dur = audio_duration(path)
        return await client.send_file(
            peer, path, caption=a.get("text") or None, voice_note=True,
            attributes=[DocumentAttributeAudio(duration=dur, voice=True)],
        )
    if a.get("file"):
        return await client.send_file(peer, a["file"], caption=a.get("text") or None)
    return await client.send_message(peer, a["text"])


async def run_command(client, cmd: str, a: dict, *, daemon: bool):
    if cmd == "ping":
        return {"pong": True, "daemon": daemon}
    if cmd == "doctor":
        t0 = time.perf_counter()
        me = await client.get_me()
        return {
            "user": f"@{me.username}" if me.username else me.first_name,
            "user_id": me.id,
            "latency_ms": round((time.perf_counter() - t0) * 1000),
            "daemon": daemon,
        }
    if cmd == "list":
        if a.get("pinned"):
            from telethon.tl.types import InputMessagesFilterPinned

            msgs = await client.get_messages(PEER, limit=a.get("n", 50), filter=InputMessagesFilterPinned)
            return [fmt(m) for m in msgs]
        msgs = await client.get_messages(PEER, limit=a.get("n", 5), offset_id=a.get("before") or 0)
        return [fmt(m) for m in msgs]
    if cmd == "transcribe":
        mid = await resolve_id(client, a["id"])
        engine = a.get("engine") or "sarvam"
        MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        txt = MEDIA_DIR / f"{mid}.{engine}.txt"
        if txt.exists() and not a.get("force"):
            return {"id": mid, "text": txt.read_text().strip(), "engine": engine, "cached": True}
        m = await client.get_messages(PEER, ids=mid)
        if m is None or media_info(m)["media_type"] not in ("voice", "audio", "video"):
            raise ValueError(f"message {mid} has no audio")
        existing = [p for p in MEDIA_DIR.glob(f"{mid}.*") if p.suffix not in (".txt", ".m4a") and "-thumb" not in p.name]
        path = str(existing[0]) if existing else await client.download_media(m, file=str(MEDIA_DIR / str(mid)))
        if not path:
            raise ValueError(f"download failed for {mid}")
        env = {**os.environ, "PATH": f"{os.environ.get('PATH', '')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"}
        r = subprocess.run([STT, path, "--engine", engine], capture_output=True, text=True, timeout=300, env=env)
        if r.returncode != 0:
            raise ValueError(f"stt failed ({engine}): {r.stderr.strip()[-200:]}")
        text = r.stdout.strip()
        txt.write_text(text)
        return {"id": mid, "text": text, "engine": engine, "cached": False}
    if cmd in ("pin", "unpin"):
        mid = await resolve_id(client, a["id"])
        if cmd == "pin":
            await client.pin_message(PEER, mid, notify=False)
        else:
            await client.unpin_message(PEER, mid)
        m = await client.get_messages(PEER, ids=mid)
        return fmt(m)
    if cmd == "search":
        msgs = await client.get_messages(PEER, limit=a.get("n", 10), search=a["q"])
        return [fmt(m) for m in msgs]
    if cmd == "show":
        mid = await resolve_id(client, a["id"])
        m = await client.get_messages(PEER, ids=mid)
        if m is None:
            raise ValueError(f"no message {mid}")
        return fmt(m)
    if cmd == "add":
        return fmt(await deliver(client, PEER, a))
    if cmd == "send":
        peer = parse_peer(a["to"])
        m = await deliver(client, peer, a)
        return {"to": a["to"], **fmt(m)}
    if cmd == "chats":
        dialogs = await client.get_dialogs(limit=a.get("n", 30))
        return [fmt_dialog(d) for d in dialogs]
    if cmd == "history":
        msgs = await client.get_messages(parse_peer(a["to"]), limit=a.get("n", 10))
        return [{**fmt(m), "out": bool(m.out)} for m in msgs]
    if cmd == "media":
        mid = await resolve_id(client, a["id"])
        m = await client.get_messages(PEER, ids=mid)
        if m is None or media_info(m)["media_type"] is None:
            raise ValueError(f"message {mid} has no media")
        thumb = bool(a.get("thumb"))
        out_dir = Path(a.get("out") or MEDIA_DIR)
        out_dir.mkdir(parents=True, exist_ok=True)
        # stable cache name: <id>[-thumb].<ext>; Telethon picks the extension when we pass a dir
        # cache lookup: the media dir also holds transcripts (<id>.<engine>.txt) and m4a
        # transcodes — never hand those to ffmpeg as a source
        stem_name = f"{mid}{'-thumb' if thumb else ''}"
        existing = [
            p for p in out_dir.glob(f"{stem_name}.*")
            if p.is_file() and p.suffix != ".txt" and p.name.count(".") == 1
            and (not thumb and "-thumb" not in p.name or thumb)
        ]
        existing.sort(key=lambda p: p.suffix == ".m4a")  # raw request → original file first
        if a.get("m4a"):
            m4a = out_dir / f"{stem_name}.m4a"
            if m4a.exists():
                return {"id": mid, "path": str(m4a), "cached": True}
            existing = [p for p in existing if p.suffix != ".m4a"]
        if existing:
            p0 = str(existing[0])
            return {"id": mid, "path": to_m4a(p0) if a.get("m4a") else p0, "cached": True}
        stem = out_dir / f"{mid}{'-thumb' if thumb else ''}"
        path = await client.download_media(m, file=str(stem), thumb=0 if thumb else None)
        if not path:
            raise ValueError(f"download failed for {mid}")
        if a.get("m4a"):
            return {"id": mid, "path": to_m4a(path), "cached": False}
        return {"id": mid, "path": str(path), "cached": False}
    if cmd == "edit":
        mid = await resolve_id(client, a["id"])
        m = await client.edit_message(PEER, mid, a["text"])
        return fmt(m)
    if cmd == "delete":
        ids = [await resolve_id(client, r) for r in a["ids"]]
        res = await client.delete_messages(PEER, ids)
        return {"ids": ids, "deleted": sum(r.pts_count for r in res)}
    if cmd == "forward":
        ids = [await resolve_id(client, r) for r in a["ids"]]
        sent = await client.forward_messages(parse_peer(a["to"]), ids, from_peer=PEER)
        sent = sent if isinstance(sent, list) else [sent]
        return {"to": a["to"], "ids": ids, "forwarded": [fmt(m) for m in sent if m is not None]}
    raise ValueError(f"unknown command {cmd}")


# ------------------------------------------------------------ audio helpers
def to_m4a(path: str) -> str:
    """Transcode (cached) to AAC/m4a so QuickTime, Quick Look and afplay can play it."""
    src = Path(path)
    if src.suffix.lower() in (".m4a", ".mp3", ".aac", ".wav", ".aiff"):
        return str(src)
    dst = src.with_suffix(".m4a")
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return str(dst)
    r = subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", str(src), "-vn", "-c:a", "aac", "-b:a", "96k", str(dst)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise ValueError(f"ffmpeg failed: {r.stderr.strip()[:200]}")
    return str(dst)


def audio_duration(path: str) -> int:
    """Seconds, via ffprobe. Telegram shows no length on a voice note unless we send it explicitly."""
    r = subprocess.run([FFMPEG.replace("ffmpeg", "ffprobe"), "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", path], capture_output=True, text=True)
    try:
        return max(1, round(float(r.stdout.strip())))
    except ValueError:
        return 1


def ensure_opus(path: str) -> str:
    """Telegram voice notes must be Opus in OGG for the waveform bubble. Convert anything else."""
    src = Path(os.path.expanduser(path))
    if not src.is_file():
        raise ValueError(f"no such file: {src}")
    probe = subprocess.run([FFMPEG.replace("ffmpeg", "ffprobe"), "-v", "error", "-select_streams", "a:0",
                            "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(src)], capture_output=True, text=True)
    if probe.stdout.strip() == "opus" and src.suffix.lower() in (".ogg", ".oga", ".opus"):
        return str(src)
    REC_DIR.mkdir(parents=True, exist_ok=True)
    dst = REC_DIR / (src.stem + ".ogg")
    r = subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", str(src), "-vn", "-c:a", "libopus", "-b:a", "32k",
                        "-ac", "1", "-application", "voip", str(dst)], capture_output=True, text=True)
    if r.returncode != 0:
        raise ValueError(f"ffmpeg failed: {r.stderr.strip()[:200]}")
    return str(dst)


def cmd_record(sub: str, seconds: int | None, device: str) -> dict:
    """Mic → Opus/OGG via ffmpeg avfoundation. start/stop are detached (pidfile); --seconds blocks."""
    import signal

    REC_DIR.mkdir(parents=True, exist_ok=True)
    if sub == "status":
        if REC_PID.exists():
            pid, path, t0 = REC_PID.read_text().split("\n")[:3]
            try:
                os.kill(int(pid), 0)
                return {"recording": True, "path": path, "seconds": round(time.time() - float(t0))}
            except OSError:
                REC_PID.unlink(missing_ok=True)
        return {"recording": False}
    if sub == "stop":
        if not REC_PID.exists():
            raise ValueError("not recording")
        pid, path, t0 = REC_PID.read_text().split("\n")[:3]
        try:
            os.kill(int(pid), signal.SIGINT)  # ffmpeg finalizes the file on SIGINT
            for _ in range(50):
                time.sleep(0.1)
                try:
                    os.kill(int(pid), 0)
                except OSError:
                    break
        finally:
            REC_PID.unlink(missing_ok=True)
        if not Path(path).exists() or Path(path).stat().st_size < 1000:
            raise ValueError("recording is empty — mic permission denied? (System Settings → Privacy → Microphone)")
        return {"path": path, "seconds": round(time.time() - float(t0))}
    # start
    if REC_PID.exists():
        st = cmd_record("status", None, device)
        if st.get("recording"):
            raise ValueError(f"already recording: {st['path']}")
    path = str(REC_DIR / f"rec-{time.strftime('%Y%m%d-%H%M%S')}.ogg")
    args = [FFMPEG, "-y", "-loglevel", "error", "-f", "avfoundation", "-i", f":{device}",
            "-ac", "1", "-c:a", "libopus", "-b:a", "32k", "-application", "voip"]
    if seconds:
        args += ["-t", str(seconds)]
    args.append(path)
    if seconds:
        r = subprocess.run(args, capture_output=True, text=True)
        if r.returncode != 0:
            raise ValueError(f"ffmpeg failed: {r.stderr.strip()[:200]}")
        return {"path": path, "seconds": seconds}
    proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=open(REC_DIR / "ffmpeg.err", "ab"), start_new_session=True)
    REC_PID.write_text(f"{proc.pid}\n{path}\n{time.time()}")
    return {"path": path, "pid": proc.pid, "recording": True}


# ----------------------------------------------------------------- daemon
def acquire_lock():
    """flock on tgsd.lock — the only reliable single-instance guard (launchd + self-spawn can race)."""
    import fcntl

    fh = open(LOCK, "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return None
    return fh


async def daemon_serve():
    lock = acquire_lock()
    if lock is None:
        print("tgsd already running (lock held) — exiting", flush=True)
        return
    client = await make_client()
    stop = asyncio.Event()

    async def handle(reader, writer):
        try:
            line = await reader.readline()
            if not line:
                return
            req = json.loads(line)
            cmd, args = req.get("cmd"), req.get("args", {})
            if cmd == "stop":
                resp = {"ok": True, "data": "stopping"}
                stop.set()
            else:
                try:
                    if not client.is_connected():   # Telethon gave up reconnecting: do it ourselves
                        print("tgsd: client disconnected, reconnecting", flush=True)
                        await client.connect()
                    resp = {"ok": True, "data": await run_command(client, cmd, args, daemon=True)}
                except AuthNeeded as e:
                    resp = {"ok": False, "error": str(e), "code": EXIT_AUTH}
                except Exception as e:  # noqa: BLE001
                    resp = {"ok": False, "error": f"{type(e).__name__}: {e}", "code": EXIT_TG}
            writer.write((json.dumps(resp) + "\n").encode())
            try:
                await writer.drain()
            except (ConnectionResetError, BrokenPipeError):
                pass
        finally:
            writer.close()

    if SOCK.exists():
        SOCK.unlink()
    server = await asyncio.start_unix_server(handle, path=str(SOCK))
    os.chmod(SOCK, 0o600)
    PIDF.write_text(str(os.getpid()))
    print(f"tgsd up pid={os.getpid()} sock={SOCK}", flush=True)
    try:
        async with server:
            await stop.wait()
    finally:
        await client.disconnect()
        for p in (SOCK, PIDF):
            p.unlink(missing_ok=True)
        print("tgsd down", flush=True)


def daemon_running() -> bool:
    return socket_request({"cmd": "ping"}, timeout=1.0) is not None


def launchd_loaded() -> bool:
    r = subprocess.run(["launchctl", "list", LAUNCHD_LABEL], capture_output=True)
    return r.returncode == 0


def spawn_daemon() -> None:
    if daemon_running():
        return
    if launchd_loaded():
        # launchd owns the daemon (KeepAlive). Kick it rather than racing it with our own process.
        subprocess.run(["launchctl", "kickstart", f"gui/{os.getuid()}/{LAUNCHD_LABEL}"], capture_output=True)
        return
    SOCK.unlink(missing_ok=True)
    with open(LOG, "ab") as log:
        subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "daemon", "run"],
            stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            start_new_session=True, close_fds=True,
        )


def cmd_daemon(sub: str) -> int:
    if sub == "run":
        asyncio.run(daemon_serve())
        return EXIT_OK
    if sub == "start":
        if daemon_running():
            print("tgsd already running")
            return EXIT_OK
        spawn_daemon()
        for _ in range(40):
            time.sleep(0.1)
            if daemon_running():
                print("tgsd started")
                return EXIT_OK
        print(f"tgsd did not come up — see {LOG}", file=sys.stderr)
        return EXIT_TG
    if sub == "stop":
        r = socket_request({"cmd": "stop"}, timeout=3.0)
        print("tgsd stopped" if r else "tgsd not running")
        if launchd_loaded():
            print("note: launchd KeepAlive will restart it; use `launchctl unload` to keep it down")
        return EXIT_OK
    if sub == "restart":
        if launchd_loaded():
            subprocess.run(["launchctl", "kickstart", "-k", f"gui/{os.getuid()}/{LAUNCHD_LABEL}"], check=False)
        else:
            socket_request({"cmd": "stop"}, timeout=3.0)
            time.sleep(0.5)
            spawn_daemon()
        for _ in range(150):
            time.sleep(0.1)
            if daemon_running():
                print("tgsd restarted")
                return EXIT_OK
        print(f"tgsd did not come back — see {LOG}", file=sys.stderr)
        return EXIT_TG
    if sub == "status":
        r = socket_request({"cmd": "ping"}, timeout=1.0)
        pid = PIDF.read_text().strip() if PIDF.exists() else "?"
        mgr = "launchd" if launchd_loaded() else "self-spawned"
        print(f"tgsd running pid={pid} ({mgr})" if r else "tgsd not running")
        return EXIT_OK if r else EXIT_TG
    if sub == "log":
        subprocess.run(["tail", "-n", "40", str(LOG)])
        return EXIT_OK
    raise SystemExit(f"unknown daemon subcommand {sub}")


# ------------------------------------------------------------- transport
def socket_request(req: dict, timeout: float = 15.0) -> dict | None:
    """Returns the daemon's response, or None if no daemon is reachable."""
    if not SOCK.exists():
        return None
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            s.connect(str(SOCK))
            s.sendall((json.dumps(req) + "\n").encode())
            buf = b""
            while not buf.endswith(b"\n"):
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf += chunk
        return json.loads(buf) if buf.strip() else None
    except (ConnectionRefusedError, FileNotFoundError, socket.timeout, OSError):
        return None


def cold_request(req: dict) -> dict:
    async def go():
        client = await make_client()
        try:
            return {"ok": True, "data": await run_command(client, req["cmd"], req.get("args", {}), daemon=False)}
        finally:
            await client.disconnect()

    try:
        return asyncio.run(go())
    except AuthNeeded as e:
        return {"ok": False, "error": str(e), "code": EXIT_AUTH}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "code": EXIT_TG}


def request(cmd: str, args: dict) -> dict:
    resp = socket_request({"cmd": cmd, "args": args})
    if resp is not None:
        return resp
    if launchd_loaded():
        # daemon is launchd-managed and probably (re)starting — wait for it rather than
        # opening the sqlite session concurrently (-> "database is locked")
        for _ in range(80):
            time.sleep(0.1)
            resp = socket_request({"cmd": cmd, "args": args})
            if resp is not None:
                return resp
    resp = cold_request({"cmd": cmd, "args": args})
    if resp.get("ok") or resp.get("code") != EXIT_AUTH:
        spawn_daemon()  # warm up for the next call
    return resp


# ----------------------------------------------------------------- login
PENDING = CFG / "pending-login.json"


def cmd_login(args) -> int:
    """Interactive (TTY) or two-step remote login.

    interactive:  tgs login                      # prompts for everything
    remote step1: tgs login --phone +<country code>...       # sends the code, remembers phone_code_hash
    remote step2: tgs login --code 12345 [--password 2fa]
    """
    CFG.mkdir(parents=True, exist_ok=True)
    os.chmod(CFG, 0o700)
    if daemon_running():
        socket_request({"cmd": "stop"}, timeout=3.0)
        time.sleep(0.5)

    if args.api_id and args.api_hash:
        creds = {"api_id": int(args.api_id), "api_hash": args.api_hash}
    elif CREDS.exists():
        creds = load_creds()
    else:
        print("Get these from https://my.telegram.org -> API development tools")
        creds = {"api_id": int(input("api_id: ").strip()), "api_hash": input("api_hash: ").strip()}
    CREDS.write_text(json.dumps(creds))
    os.chmod(CREDS, 0o600)

    from telethon import TelegramClient
    from telethon.errors import SessionPasswordNeededError

    client = TelegramClient(str(SESSION), creds["api_id"], creds["api_hash"])

    async def finish():
        me = await client.get_me()
        os.chmod(SESSION.with_suffix(".session"), 0o600)
        PENDING.unlink(missing_ok=True)
        print(f"logged in as @{me.username or me.first_name} (id {me.id})")
        print(f"session: {SESSION.with_suffix('.session')}")

    async def remote():
        await client.connect()
        if await client.is_user_authorized():
            await finish()
            return EXIT_OK
        if args.code:
            if not PENDING.exists():
                print("no pending login — run: tgs login --phone +NUMBER first", file=sys.stderr)
                return EXIT_TG
            pend = json.loads(PENDING.read_text())
            try:
                await client.sign_in(pend["phone"], args.code, phone_code_hash=pend["hash"])
            except SessionPasswordNeededError:
                if not args.password:
                    print("2FA enabled — rerun with --code CODE --password YOUR_2FA_PASSWORD", file=sys.stderr)
                    return EXIT_AUTH
                await client.sign_in(password=args.password)
            await finish()
            return EXIT_OK
        if args.phone:
            sent = await client.send_code_request(args.phone)
            PENDING.write_text(json.dumps({"phone": args.phone, "hash": sent.phone_code_hash}))
            os.chmod(PENDING, 0o600)
            print(f"code sent to {args.phone} via {type(sent.type).__name__}. next: tgs login --code CODE")
            return EXIT_OK
        return None

    try:
        rc = client.loop.run_until_complete(remote())
        if rc is not None:
            return rc
        # interactive path: Telethon prompts for phone / code / 2FA on the TTY
        client.start()
        client.loop.run_until_complete(finish())
        return EXIT_OK
    finally:
        if client.is_connected():
            r = client.disconnect()  # Telethon: coroutine, or None when syncified
            if asyncio.iscoroutine(r) or isinstance(r, asyncio.Future):
                client.loop.run_until_complete(r)


# ----------------------------------------------------------------- output
def render(cmd: str, data, as_json: bool) -> None:
    if as_json:
        print(json.dumps(data, ensure_ascii=False, indent=None))
        return
    if cmd == "send":
        print(f"sent {data['id']} → {data['to']}")
        return
    if cmd == "forward":
        print(f"forwarded {len(data['forwarded'])} → {data['to']}: {' '.join(map(str, data['ids']))}")
        return
    if cmd == "chats":
        for d in data:
            u = f" @{d['username']}" if d.get("username") else ""
            print(f"{d['id']:>15}  {d['kind']:<7} {oneline(d['name'], 32):<32}{u}  unread {d['unread']}")
        return
    if cmd in ("list", "search", "history"):
        if not data:
            print("(no messages)")
        for m in data:
            tag = f" [{m['media_type']}{': ' + m['file_name'] if m.get('file_name') else ''}]" if m["media"] else ""
            ed = "*" if m["edited"] else "📌" if m.get("pinned") else "›" if m.get("out") else " "
            print(f"{m['id']:>7}{ed} {m['date'][:16].replace('T', ' ')}  {oneline(m['text'])}{tag}")
    elif cmd == "show":
        print(f"# {data['id']}  {data['date']}{'  (edited)' if data['edited'] else ''}")
        print(data["text"] or "[media]")
    elif cmd in ("add", "edit", "pin", "unpin"):
        print(f"{ {'add': 'added', 'edit': 'edited', 'pin': 'pinned', 'unpin': 'unpinned'}[cmd] } {data['id']}")
    elif cmd == "delete":
        print(f"deleted {data['deleted']}: {' '.join(map(str, data['ids']))}")
    elif cmd == "media":
        print(data["path"])
    elif cmd == "transcribe":
        print(data["text"])
    elif cmd == "doctor":
        print(f"user     {data['user']} ({data['user_id']})")
        print(f"path     {'daemon' if data['daemon'] else 'cold'}")
        print(f"latency  {data['latency_ms']} ms (get_me round trip)")
    else:
        print(data)


def read_text_arg(text: str | None, clip: bool) -> str:
    if clip:
        return subprocess.run(["pbpaste"], capture_output=True, text=True).stdout
    if text is not None:
        return text
    if not sys.stdin.isatty():
        return sys.stdin.read()
    raise SystemExit("no text: pass an argument, pipe stdin, or use --clip")


def edit_in_editor(current: str) -> str:
    editor = os.environ.get("VISUAL") or os.environ.get("EDITOR") or "vi"
    with tempfile.NamedTemporaryFile("w+", suffix=".tgs.md", delete=False) as f:
        f.write(current)
        path = f.name
    subprocess.run([*editor.split(), path], check=True)
    new = Path(path).read_text()
    Path(path).unlink(missing_ok=True)
    return new


# ------------------------------------------------------------------- main
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="tgs", description="Telegram Saved Messages CLI")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    p.add_argument("--cold", action="store_true", help="bypass daemon (debug)")
    sp = p.add_subparsers(dest="cmd", required=True)

    s = sp.add_parser("login", help="one-time auth; writes creds + session")
    s.add_argument("--api-id")
    s.add_argument("--api-hash")
    s.add_argument("--phone", help="remote step 1: send login code to this number (+<country code>...)")
    s.add_argument("--code", help="remote step 2: the code Telegram sent")
    s.add_argument("--password", help="2FA password, only if asked")

    sp.add_parser("doctor", help="auth/connection/latency check")

    s = sp.add_parser("list", help="last N saved messages, newest first")
    s.add_argument("-n", type=int, default=5)
    s.add_argument("--before", type=int, help="page: only ids older than this")
    s.add_argument("--pinned", action="store_true", help="only pinned messages (up to -n, default 50)")

    s = sp.add_parser("search", help="server-side search within Saved")
    s.add_argument("q")
    s.add_argument("-n", type=int, default=10)

    s = sp.add_parser("show", help="full text of one message")
    s.add_argument("id", help="message id | last | -1 | -2 …")

    s = sp.add_parser("add", help="send text to Saved")
    s.add_argument("text", nargs="?")
    s.add_argument("--clip", action="store_true", help="use clipboard contents")
    s.add_argument("--file", help="attach a file; text becomes the caption")
    s.add_argument("--voice", help="send an audio file as a voice note (converted to Opus/OGG if needed)")
    s.add_argument("--bg", action="store_true", help="fire-and-forget; macOS notification on failure")
    s.add_argument("--notify-fail", action="store_true", help=argparse.SUPPRESS)

    s = sp.add_parser("send", help="send text/file/voice to any chat (me | @username | id)")
    s.add_argument("to", help="me | @username | numeric peer id")
    s.add_argument("text", nargs="?")
    s.add_argument("--clip", action="store_true", help="use clipboard contents")
    s.add_argument("--file", help="attach a file; text becomes the caption")
    s.add_argument("--voice", help="send an audio file as a voice note")

    s = sp.add_parser("forward", aliases=["fwd"], help="forward saved message(s) to a chat, Telegram-native (media kept)")
    s.add_argument("to", help="me | @username | numeric peer id")
    s.add_argument("ids", nargs="+", help="message ids | last | -1 | -2 …")

    s = sp.add_parser("chats", help="recent dialogs (id, kind, name, @username)")
    s.add_argument("-n", type=int, default=30)

    s = sp.add_parser("history", help="last N messages of a chat, newest first")
    s.add_argument("to", help="me | @username | numeric peer id")
    s.add_argument("-n", type=int, default=10)

    s = sp.add_parser("edit", help="edit a saved message")
    s.add_argument("id", help="message id | last | -1 | -2 …")
    s.add_argument("text", nargs="?", help="omit to open $EDITOR")

    s = sp.add_parser("media", help="download a message's attachment; prints the path")
    s.add_argument("id", help="message id | last | -1 …")
    s.add_argument("--thumb", action="store_true", help="smallest thumbnail instead of the full file")
    s.add_argument("--m4a", action="store_true", help="transcode audio to m4a for native playback (cached)")
    s.add_argument("--out", help=f"directory (default {MEDIA_DIR})")

    s = sp.add_parser("record", help="record a voice note from the mic (Opus/OGG)")
    s.add_argument("sub", choices=["start", "stop", "status"], nargs="?", default="start")
    s.add_argument("--seconds", type=int, help="blocking: record for N seconds then exit")
    s.add_argument("--device", default="0", help="avfoundation audio device index (default 0 = built-in mic)")

    s = sp.add_parser("transcribe", help="speech-to-text for a voice/audio message (cached)")
    s.add_argument("id", help="message id | last | -1 …")
    s.add_argument("--engine", choices=["sarvam", "deepgram"], default="sarvam")
    s.add_argument("--force", action="store_true", help="ignore the cached transcript")

    for name in ("pin", "unpin"):
        s = sp.add_parser(name, help=f"{name} a saved message")
        s.add_argument("id", help="message id | last | -1 …")

    s = sp.add_parser("delete", aliases=["rm"], help="delete saved message(s)")
    s.add_argument("ids", nargs="+", help="message ids | last | -1 | -2 …")

    s = sp.add_parser("daemon", help="tgsd control")
    s.add_argument("sub", choices=["start", "stop", "restart", "status", "run", "log"])
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    cmd = args.cmd

    if cmd == "login":
        return cmd_login(args)
    if cmd == "daemon":
        return cmd_daemon(args.sub)

    if cmd == "record":
        try:
            data = cmd_record(args.sub, args.seconds, args.device)
        except ValueError as e:
            print(f"tgs: {e}", file=sys.stderr)
            return EXIT_TG
        if args.json:
            print(json.dumps(data))
        elif data.get("recording"):
            print(f"recording → {data['path']}  (tgs record stop)")
        elif "seconds" in data:
            print(f"{data['path']}  ({data['seconds']}s)")
        else:
            print("not recording")
        return EXIT_OK
    if cmd in ("add", "send") and args.voice:
        req_args = {"text": (args.text or "").rstrip("\n"), "voice": os.path.expanduser(args.voice)}
    elif cmd in ("add", "send") and args.file:
        fpath = os.path.expanduser(args.file)
        if not os.path.isfile(fpath):
            raise SystemExit(f"no such file: {fpath}")
        text = (args.text or "").rstrip("\n")
        req_args = {"text": text, "file": fpath}
    elif cmd in ("add", "send"):
        text = read_text_arg(args.text, args.clip).rstrip("\n")
        if not text.strip():
            raise SystemExit("refusing to send empty text")
        if cmd == "add" and args.bg:
            subprocess.Popen(
                [sys.executable, os.path.abspath(__file__), "add", "--notify-fail", text],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            return EXIT_OK
        req_args = {"text": text}
    if cmd == "send":
        req_args["to"] = args.to
    if cmd in ("add", "send"):
        pass
    elif cmd in ("forward", "fwd"):
        cmd = "forward"
        req_args = {"to": args.to, "ids": args.ids}
    elif cmd == "chats":
        req_args = {"n": args.n}
    elif cmd == "history":
        req_args = {"to": args.to, "n": args.n}
    elif cmd == "edit":
        if args.text is None:
            cur = request("show", {"id": args.id}) if not args.cold else cold_request({"cmd": "show", "args": {"id": args.id}})
            if not cur.get("ok"):
                print(f"tgs: {cur.get('error')}", file=sys.stderr)
                return cur.get("code", EXIT_TG)
            new = edit_in_editor(cur["data"]["text"]).rstrip("\n")
            if new == cur["data"]["text"]:
                print("unchanged")
                return EXIT_OK
            req_args = {"id": cur["data"]["id"], "text": new}
        else:
            req_args = {"id": args.id, "text": args.text}
    elif cmd == "list":
        req_args = {"n": args.n, "before": args.before, "pinned": args.pinned}
    elif cmd in ("pin", "unpin"):
        req_args = {"id": args.id}
    elif cmd == "transcribe":
        req_args = {"id": args.id, "engine": args.engine, "force": args.force}
    elif cmd == "search":
        req_args = {"q": args.q, "n": args.n}
    elif cmd == "show":
        req_args = {"id": args.id}
    elif cmd in ("delete", "rm"):
        cmd = "delete"
        req_args = {"ids": args.ids}
    elif cmd == "media":
        req_args = {"id": args.id, "thumb": args.thumb, "out": args.out, "m4a": args.m4a}
    else:  # doctor
        req_args = {}

    resp = cold_request({"cmd": cmd, "args": req_args}) if args.cold else request(cmd, req_args)
    if not resp.get("ok"):
        msg = resp.get("error", "unknown error")
        if getattr(args, "notify_fail", False):
            notify("tgs: save failed", oneline(msg, 120))
        print(f"tgs: {msg}", file=sys.stderr)
        return resp.get("code", EXIT_TG)
    render(cmd, resp["data"], args.json)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
