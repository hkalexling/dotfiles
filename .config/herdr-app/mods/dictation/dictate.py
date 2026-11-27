#!/usr/bin/env python3
"""Herdr dictation helper: record from the microphone, transcribe with OpenAI.

Commands (each prints one JSON object on stdout):
  start            start recording in the background
  stop             stop recording and transcribe -> {"text": "..."}
  cancel           stop recording and discard it
  status           {"recording": bool, "seconds": float}
  sources          list microphones -> {"sources": [{name, description}]}
  test-key         check the API key against OpenAI -> {"ok": true}
  live-start       stream mic to OpenAI Realtime; partial text in live.json
  live-stop        finish the live session -> {"text": "..."}
  secure           create the config folder 0700 / config file 0600

Config: ~/.config/herdr-dictation/config.json (mode 0600), written by the
dictation-settings mod. OPENAI_API_KEY in the environment is the fallback key.
The key never appears in argv.
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

CONFIG = os.path.expanduser("~/.config/herdr-dictation/config.json")
STATE = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or "/tmp", "herdr-dictation")
PID = os.path.join(STATE, "rec.pid")
WAV = os.path.join(STATE, "rec.wav")
STARTED = os.path.join(STATE, "rec.started")
MAX_SECONDS = 600

DEFAULTS = {
    "api_key": "",
    "model": "gpt-4o-transcribe",
    "language": "",
    "prompt": "",
    "source": "",
    "base_url": "https://api.openai.com/v1",
}


def out(obj, code=0):
    print(json.dumps(obj))
    sys.exit(code)


def fail(msg):
    out({"error": msg}, 1)


def config():
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG) as f:
            cfg.update({k: v for k, v in json.load(f).items() if v is not None})
    except FileNotFoundError:
        pass
    except Exception as e:
        fail(f"Bad config {CONFIG}: {e}")
    if not cfg.get("api_key"):
        cfg["api_key"] = os.environ.get("OPENAI_API_KEY", "")
    return cfg


def read_pid():
    try:
        with open(PID) as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)
        return pid
    except Exception:
        return None


def stop_recorder():
    pid = read_pid()
    if pid:
        try:
            os.killpg(pid, signal.SIGINT)
        except ProcessLookupError:
            pass
        for _ in range(60):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            # reap if it is our zombie (it is not: it was detached), so just poll
            time.sleep(0.05)
        else:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    for p in (PID,):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass


def cmd_start():
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    stop_recorder()
    try:
        os.remove(WAV)
    except FileNotFoundError:
        pass
    cfg = config()
    if not cfg["api_key"] and not cfg.get("fake_text"):
        fail("No OpenAI API key. Open Dictation settings (command palette) to add one.")
    if shutil.which("pw-record"):
        argv = ["pw-record", "--rate", "16000", "--channels", "1", "--format", "s16"]
        if cfg.get("source"):
            argv += ["--target", cfg["source"]]
        argv.append(WAV)
    elif shutil.which("parecord"):
        argv = ["parecord", "--rate=16000", "--channels=1", "--format=s16le", "--file-format=wav"]
        if cfg.get("source"):
            argv.append(f"--device={cfg['source']}")
        argv.append(WAV)
    elif shutil.which("ffmpeg"):
        argv = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "pulse",
                "-i", cfg.get("source") or "default", "-ac", "1", "-ar", "16000", WAV]
    else:
        fail("No recorder found: install pipewire (pw-record), pulseaudio-utils or ffmpeg.")
    argv = ["timeout", "-s", "INT", str(MAX_SECONDS)] + argv
    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, start_new_session=True)
    with open(PID, "w") as f:
        f.write(str(proc.pid))
    with open(STARTED, "w") as f:
        f.write(str(time.time()))
    time.sleep(0.15)
    if proc.poll() is not None:
        fail(f"Recorder exited at once (code {proc.returncode}). Check the microphone in Dictation settings.")
    out({"recording": True, "pid": proc.pid})


def multipart(fields, file_field, filename, data):
    boundary = uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; '
                  f'filename="{filename}"\r\nContent-Type: audio/wav\r\n\r\n').encode())
    parts.append(data)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def api_error(e):
    try:
        body = json.loads(e.read().decode())
        msg = body.get("error", {}).get("message") or str(body)
    except Exception:
        msg = str(e)
    return f"OpenAI {e.code}: {msg}"


def cmd_stop():
    started = None
    try:
        with open(STARTED) as f:
            started = float(f.read())
    except Exception:
        pass
    stop_recorder()
    if not os.path.exists(WAV):
        fail("Nothing was recorded.")
    with open(WAV, "rb") as f:
        data = f.read()
    os.remove(WAV)
    # 16 kHz mono s16 = 32000 bytes/s; under ~0.3 s of audio is nothing.
    if len(data) < 10000:
        fail("No audio captured. Pick another microphone in Dictation settings.")
    cfg = config()
    if os.environ.get("HERDR_DICTATION_FAKE") or cfg.get("fake_text"):  # testing without OpenAI
        out({"text": os.environ.get("HERDR_DICTATION_FAKE") or cfg["fake_text"]})
    fields = {"model": cfg["model"], "response_format": "json"}
    if cfg.get("language"):
        fields["language"] = cfg["language"].replace(",", " ").split()[0]
    if cfg.get("prompt"):
        fields["prompt"] = cfg["prompt"]
    body, ctype = multipart(fields, "file", "dictation.wav", data)
    req = urllib.request.Request(cfg["base_url"].rstrip("/") + "/audio/transcriptions", data=body, method="POST",
                                 headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=110) as r:
            text = json.loads(r.read().decode()).get("text", "")
    except urllib.error.HTTPError as e:
        fail(api_error(e))
    except Exception as e:
        fail(f"Transcription failed: {e}")
    out({"text": text.strip(), "seconds": round(time.time() - started, 1) if started else None})


def cmd_cancel():
    cmd_live_kill()
    stop_recorder()
    try:
        os.remove(WAV)
    except FileNotFoundError:
        pass
    out({"cancelled": True})


def cmd_status():
    pid = read_pid()
    secs = 0.0
    if pid:
        try:
            with open(STARTED) as f:
                secs = time.time() - float(f.read())
        except Exception:
            pass
    out({"recording": bool(pid), "seconds": round(secs, 1)})


def cmd_sources():
    try:
        r = subprocess.run(["pactl", "-f", "json", "list", "sources"], capture_output=True, text=True, timeout=5)
        items = json.loads(r.stdout)
        srcs = [{"name": s["name"], "description": s.get("description") or s["name"]}
                for s in items if not s["name"].endswith(".monitor")]
    except Exception as e:
        fail(f"Could not list microphones: {e}")
    out({"sources": srcs})


def cmd_test_key():
    cfg = config()
    if not cfg["api_key"]:
        fail("No API key set.")
    model = (cfg.get("live_model") or "gpt-live-transcribe") if cfg.get("mode", "live") != "batch" else cfg["model"]
    req = urllib.request.Request(cfg["base_url"].rstrip("/") + "/models/" + model,
                                 headers={"Authorization": f"Bearer {cfg['api_key']}"})
    try:
        with urllib.request.urlopen(req, timeout=15):
            pass
    except urllib.error.HTTPError as e:
        fail(api_error(e))
    except Exception as e:
        fail(f"Could not reach OpenAI: {e}")
    out({"ok": True})


LIVE_PID = os.path.join(STATE, "live.pid")
LIVE_STATE = os.path.join(STATE, "live.json")
STREAM = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stream.mjs")


def live_recorder(cfg):
    if cfg.get("live_recorder"):  # testing / custom: argv printing s16le 24 kHz mono on stdout
        return cfg["live_recorder"]
    src = cfg.get("source") or ""
    if shutil.which("pw-record"):
        argv = ["pw-record", "--rate", "24000", "--channels", "1", "--format", "s16", "--raw"]
        if src:
            argv += ["--target", src]
        return argv + ["-"]
    if shutil.which("parec"):
        argv = ["parec", "--raw", "--format=s16le", "--rate=24000", "--channels=1"]
        if src:
            argv.append(f"--device={src}")
        return argv
    if shutil.which("ffmpeg"):
        return ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", src or "default",
                "-ac", "1", "-ar", "24000", "-f", "s16le", "-"]
    fail("No recorder found: install pipewire (pw-record), pulseaudio-utils or ffmpeg.")


def live_pid():
    try:
        with open(LIVE_PID) as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)
        return pid
    except Exception:
        return None


def read_live():
    try:
        with open(LIVE_STATE) as f:
            return json.load(f)
    except Exception:
        return {}


def cmd_live_start():
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    cmd_live_kill()
    cfg = config()
    if not cfg["api_key"]:
        fail("No OpenAI API key. Open Dictation settings to add one.")
    node = shutil.which("node") or "/usr/bin/node"
    if not os.path.exists(node):
        fail("Live dictation needs Node.js 22+ (node). Switch Mode to 'After recording' in settings.")
    proc = subprocess.Popen([node, STREAM, LIVE_STATE, json.dumps(live_recorder(cfg))],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            start_new_session=True)
    with open(LIVE_PID, "w") as f:
        f.write(str(proc.pid))
    out({"live": True, "pid": proc.pid, "state": LIVE_STATE})


def cmd_live_stop():
    pid = live_pid()
    if pid:
        os.kill(pid, signal.SIGINT)
        for _ in range(400):  # up to 20 s for the final transcript
            if live_pid() is None:
                break
            time.sleep(0.05)
        else:
            cmd_live_kill(quiet=True)
    st = read_live()
    if st.get("status") == "error":
        fail(st.get("error") or "Live dictation failed.")
    out({"text": (st.get("text") or "").strip(), "seconds": st.get("seconds")})


def cmd_live_kill(quiet=True):
    pid = live_pid()
    if pid:
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    for p in (LIVE_PID, LIVE_STATE):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass


def cmd_secure():
    """Create the config folder 0700 and make the config file 0600."""
    d = os.path.dirname(CONFIG)
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    if os.path.exists(CONFIG):
        os.chmod(CONFIG, 0o600)
    out({"ok": True, "path": CONFIG})


COMMANDS = {"live-start": cmd_live_start, "live-stop": cmd_live_stop, "secure": cmd_secure, "start": cmd_start, "stop": cmd_stop, "cancel": cmd_cancel, "status": cmd_status,
            "sources": cmd_sources, "test-key": cmd_test_key}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        fail("usage: dictate.py " + "|".join(COMMANDS))
    COMMANDS[sys.argv[1]]()
