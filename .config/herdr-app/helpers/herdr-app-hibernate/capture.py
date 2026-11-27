"""Capture IDs from Pi and Codex, using the actual foreground process as provenance."""

import json
import os
import re
import time
import uuid
from pathlib import Path

from core import CORE_ADDRESS, Core, Error, ancestor, boot_id, locked_store, process_info

SHELLS = {"bash", "dash", "fish", "nu", "sh", "zsh"}
AGENT_NAMES = {"pi": "pi", "codex": "codex", "codex-tui": "codex"}
WORKER_OWNER = "pi.subagent.owner"
WORKER_SESSION = "pi.subagent.session"
WORKER_LEAF = "pi.subagent.leaf"


def foreground(terminal):
    front = terminal.get("foreground") or {}
    return Path(front.get("name") or "").name.lstrip("-"), front.get("pid")


def session_ref(agent, value, cwd):
    if not isinstance(value, str) or not isinstance(cwd, str) or not Path(cwd).is_absolute():
        return None
    if "\0" in cwd or "\0" in value:
        return None
    if agent == "pi" and Path(value).is_absolute() and value.endswith(".jsonl"):
        return {"agent": agent, "value": value, "cwd": cwd}
    if agent == "codex":
        try:
            if str(uuid.UUID(value)) == value.lower():
                return {"agent": agent, "value": value.lower(), "cwd": cwd}
        except ValueError:
            pass
    return None


def process_env(pid, name):
    prefix = os.fsencode(name) + b"="
    try:
        for variable in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0"):
            if variable.startswith(prefix):
                return os.fsdecode(variable[len(prefix):])
    except OSError:
        pass
    return None


def explicit_record(terminal):
    """An explicit resume argv already identifies the session before any hook fires."""
    name, pid = foreground(terminal)
    front = terminal.get("foreground") or {}
    args = front.get("argv") or []
    cwd = front.get("cwd") or terminal.get("cwd")
    agent = AGENT_NAMES.get(name)
    if not agent or not args or not pid:
        return None
    # Require an unambiguous, exact option shape. Fresh sessions use the hook.
    argv = args[1:]
    if agent == "codex":
        argv = argv[1:] if argv[:1] == ["--no-daemon"] else argv
        if len(argv) != 2 or argv[0] != "resume":
            return None
    elif len(argv) != 2 or argv[0] != "--session":
        return None
    record = session_ref(agent, argv[1], cwd)
    info = process_info(pid)
    if not record or not info:
        return None
    if agent == "codex":
        home = process_env(pid, "CODEX_HOME")
        if home and Path(home).is_absolute():
            record["agent_home"] = home
    return record | {"pid": pid, "ticks": info[1], "boot": boot_id(),
                     "terminal_created": terminal["created_ms"]}


def pi_session_header(record):
    if not record or record.get("agent") != "pi":
        return {}
    try:
        with Path(record["value"]).open("rb") as session:
            header = json.loads(session.readline(65536))
    except (OSError, ValueError):
        return {}
    return header if isinstance(header, dict) and header.get("type") == "session" else {}


def pi_worker_flags(argv):
    """Keep the subagent extension's launch options, replacing its session selection."""
    retained = {"--model", "--thinking", "--tools", "--exclude-tools",
                "--system-prompt", "--append-system-prompt"}
    replaced = {"--name", "--fork", "--session"}
    flags = []
    args = iter(argv)
    for option in args:
        if option == "--no-tools":
            flags.append(option)
            continue
        value = next(args, None)
        if value is None or option not in retained | replaced:
            return None
        if option in retained:
            flags.extend((option, value))
    return flags


def pi_worker(terminal, parent_session, session):
    labels = terminal["labels"]
    name = terminal.get("name") or ""
    owner = labels.get(WORKER_OWNER)
    if not owner or owner != pi_session_header(parent_session).get("id"):
        return None
    if not re.fullmatch(r"[a-z0-9_.-]{1,32}", name) or not pi_session_header(session).get("id"):
        return None
    if labels.get(WORKER_SESSION) not in (None, "", session["value"]):
        return None
    flags = pi_worker_flags((terminal.get("argv") or [])[1:])
    if flags is None:
        return None
    return {
        "parent": terminal["parent"], "name": name, "owner": owner, "flags": flags,
        "leaf": labels.get(WORKER_LEAF) == "1", "outlive_parent": not terminal["die_with_parent"],
        "path": process_env(session["pid"], "PATH"),
    }


def capture_hook(agent, payload):
    address = os.environ.get("HC_TERMINAL_ID", "")
    terminal_socket = os.environ.get("HC_TERMINAL_SOCKET")
    if not terminal_socket or not CORE_ADDRESS.fullmatch(address):
        return {"recorded": False}
    if agent == "codex":
        if payload.get("hook_event_name") not in (None, "SessionStart"):
            return {"recorded": False}
        value = payload.get("session_id")
    else:
        value = payload.get("file")
    record = session_ref(agent, value, payload.get("cwd"))
    clear = agent == "pi" and value is None
    if not record and not clear:
        return {"recorded": False}
    with Core(terminal_socket) as core:
        # Core learns the foreground asynchronously after the terminal starts.
        for _ in range(12):
            terminal = core.terminal(address)
            if not terminal:
                return {"recorded": False}
            name, pid = foreground(terminal)
            if name in AGENT_NAMES and AGENT_NAMES[name] == agent and ancestor(os.getppid(), pid):
                break
            time.sleep(0.15)
        else:
            return {"recorded": False, "reason": "hook does not belong to the foreground agent"}
        if agent == "pi" and payload.get("pid") != pid:
            return {"recorded": False}
        argv = (terminal.get("foreground") or {}).get("argv") or []
        if agent == "codex" and any(a in {"exec", "e", "review", "app-server"} for a in argv[1:2]):
            return {"recorded": False}
        home_key = "CODEX_HOME" if agent == "codex" else "PI_CODING_AGENT_DIR"
        if record and (home := os.environ.get(home_key)) and Path(home).is_absolute():
            record["agent_home"] = home
        info = process_info(pid)
        if not info:
            return {"recorded": False}
        with locked_store(core) as store:
            if record:
                record.update(pid=pid, ticks=info[1], boot=boot_id(), terminal_created=terminal["created_ms"])
                store.data["records"][address] = record
            else:
                store.data["records"].pop(address, None)
            for snapshot in store.data["live"].values():
                for pane in snapshot["panes"].values():
                    if pane["terminal"] == address:
                        pane["session"] = record
            store.save()
    return {"recorded": True}
