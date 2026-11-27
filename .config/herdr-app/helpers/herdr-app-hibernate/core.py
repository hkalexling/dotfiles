"""Core transport and the private, atomic state used by the workspace helper."""

import contextlib
import fcntl
import json
import os
import re
import select
import socket
import subprocess
import tempfile
from pathlib import Path

HOME = Path.home()
STATE = Path(os.environ.get("HERDR_HIBERNATE_STATE", Path(os.environ.get(
    "XDG_STATE_HOME", HOME / ".local/state")) / "herdr-app-hibernate"))
APP_HOME = Path(os.environ.get("HERDR_APP_HOME", Path(os.environ.get(
    "XDG_CONFIG_HOME", HOME / ".config")) / "herdr-app"))
APP_DOCUMENT = "herdr-app"
CORE_ADDRESS = re.compile(r"t[0-9a-z]+\Z")
SPACE_ID = re.compile(r"[a-zA-Z0-9_.-]{1,100}\Z")
BOOT_ID = Path("/proc/sys/kernel/random/boot_id")


class Error(RuntimeError):
    pass


class RpcError(Error):
    def __init__(self, error):
        super().__init__(error.get("message", "Core RPC failed"))
        self.kind = (error.get("data") or {}).get("kind")


def read_json(path, default=None):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def save_json(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temp).unlink(missing_ok=True)


class Core:
    def __init__(self, terminal_socket=None):
        self.process = None
        self.socket = None
        self.sequence = 0
        if terminal_socket:
            self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.socket.settimeout(10)
            try:
                self.socket.connect(terminal_socket)
            except OSError:
                self.socket.close()
                raise
            self.input = self.output = self.socket.makefile("rwb")
        else:
            env = {k: v for k, v in os.environ.items() if not k.startswith("HC_TERMINAL_")}
            self.process = subprocess.Popen(
                [os.environ.get("HERDR_HIBERNATE_HC", "hc"), "connect"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env,
            )
            self.input = self.process.stdin
            self.output = self.process.stdout

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.input.close()
        self.output.close()
        if self.process:
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        if self.socket:
            self.socket.close()

    def call(self, method, **params):
        self.sequence += 1
        request = {"jsonrpc": "2.0", "id": self.sequence, "method": method, "params": params}
        self.input.write(json.dumps(request).encode() + b"\n")
        self.input.flush()
        if self.process and not select.select([self.output], [], [], 20)[0]:
            raise Error(f"Timed out waiting for {method}")
        line = self.output.readline(4 * 1024 * 1024)
        if not line:
            raise Error(f"Core disconnected during {method}")
        response = json.loads(line)
        if response.get("id") != self.sequence:
            raise Error(f"Unexpected Core response during {method}")
        if "error" in response:
            raise RpcError(response["error"])
        return response["result"]

    def document(self):
        result = self.call("doc.get", name=APP_DOCUMENT)
        doc = result["value"]
        if doc is None:
            doc = {"spaces": []}
        if not isinstance(doc, dict) or not isinstance(doc.get("spaces"), list):
            raise Error("Unsupported Herdr App layout document")
        return result["version"], doc

    def terminals(self):
        return {t["address"]: t for t in self.call("terminal.list")["terminals"]
                if CORE_ADDRESS.fullmatch(t["address"])}

    def terminal(self, address):
        try:
            item = self.call("terminal.get", terminal=address)
            return item if item["state"] == "live" else None
        except RpcError as error:
            if error.kind == "not_found":
                return None
            raise


class Store:
    def __init__(self, core):
        identity = core.call("server.status")["core"]["id"]
        if not re.fullmatch(r"[a-f0-9]{32}", identity):
            raise Error("Unsupported Core identity")
        self.path = STATE / f"{identity}.json"
        self.data = read_json(self.path, {
            "schema": 1, "boot": None, "active": None, "live": {},
            "parked": {}, "records": {}, "imports": [],
        })
        if self.data.get("schema") != 1:
            raise Error("Unsupported hibernation state version")

    def save(self):
        save_json(self.path, self.data)


@contextlib.contextmanager
def locked_store(core):
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE / "lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield Store(core)


def boot_id():
    return BOOT_ID.read_text().strip()


def process_info(pid):
    if not isinstance(pid, int) or pid < 1:
        return None
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
        fields = raw[raw.rindex(")") + 2:].split()
        return int(fields[1]), int(fields[19])
    except (OSError, ValueError, IndexError):
        return None


def process_active(record):
    info = process_info(record.get("pid"))
    return record.get("boot") == boot_id() and info is not None and info[1] == record.get("ticks")


def ancestor(child, parent):
    while child and child > 1:
        if child == parent:
            return True
        info = process_info(child)
        child = info[0] if info else None
    return False
