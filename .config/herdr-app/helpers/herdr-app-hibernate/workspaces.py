"""Checkpoint, hibernate and wake local Herdr App spaces."""

import copy
import os
import shutil
import sys
import time
import uuid
from collections import defaultdict, deque
from pathlib import Path

from capture import (
    AGENT_NAMES, SHELLS, WORKER_LEAF, WORKER_OWNER, WORKER_SESSION,
    explicit_record, foreground, pi_session_header, pi_worker, session_ref,
)
from core import (
    APP_DOCUMENT, APP_HOME, CORE_ADDRESS, HOME, STATE, Error, RpcError, boot_id,
    process_active, process_info, read_json,
)

MEMBERSHIP = ("herdr.space", "herdr.tab")
OPERATION = "hibernate.operation"
SLOT = "hibernate.slot"
HIBERNATE_BLOCKERS = {
    "working": "is still working. Try again after the current turn finishes.",
    "blocked": "is waiting for input. Resolve the prompt before hibernating the space.",
    "error": "reported an error. Check the terminal before hibernating the space.",
}


def terminal_slots(space):
    """Yield mutable terminal references, preserving all other layout data."""
    def walk(node):
        if node.get("type") not in {"block", "row", "column", "stack"}:
            raise Error("Unsupported Herdr App layout node")
        if (content := node.get("content")) and "terminal" in content:
            yield node["id"], content
        for floating in node.get("floating", []):
            if "terminal" in floating.get("content", {}):
                yield floating["id"], floating["content"]
        for child in node.get("children", []):
            yield from walk(child)

    for tab in space["tabs"]:
        for pane, content in walk(tab["root"]):
            if not CORE_ADDRESS.fullmatch(content["terminal"]):
                raise Error("This add-on handles spaces on the local Core")
            yield tab["id"], pane, content


def current_space(doc, space_id):
    return next((space for space in doc["spaces"] if space["id"] == space_id), None)


def installed_view():
    return read_json(APP_HOME / "view.json", {}) or {}


def terminal_cookie(terminal):
    pid = terminal.get("pid")
    info = process_info(pid)
    return [terminal["created_ms"], pid, info[1] if info else None]


def check_hibernate_terminal(address, name, status, has_session):
    terminal = f"{address} ({name or 'unknown program'})"
    if status in HIBERNATE_BLOCKERS:
        raise Error(f"{terminal} {HIBERNATE_BLOCKERS[status]}")
    if name in SHELLS:
        return
    if not has_session:
        if name in AGENT_NAMES:
            raise Error(f"{terminal} has no verified resume reference. Reopen the conversation "
                        "with its session ID or file before hibernating it.")
        raise Error(f"{terminal} has a foreground program. Return to its shell before hibernating.")
    if status not in {"idle", "done"}:
        raise Error(f"Core cannot verify that {terminal} is idle.")


def capture_terminal(item, record):
    _, pid = foreground(item)
    if not (record and process_active(record) and record["pid"] == pid
            and record["terminal_created"] == item["created_ms"]):
        record = explicit_record(item)
    return {
        "terminal": item["address"],
        "cwd": (item.get("foreground") or {}).get("cwd") or item.get("cwd") or str(HOME),
        "session": record,
    }


def layout_owners(doc):
    owners = defaultdict(set)
    for space in doc["spaces"]:
        if not space.get("machine"):
            for _, _, content in terminal_slots(space):
                owners[content["terminal"]].add(space["id"])
    return owners


def capture_workers(space_id, panes, terminals, records, owners, verify):
    nodes = {pane["terminal"]: pane for pane in panes.values()}
    links = defaultdict(list)
    for item in terminals.values():
        if item.get("parent"):
            links[item["parent"]].append(item)
    queue = deque(nodes)
    seen = set()
    workers = {}
    while queue:
        parent = queue.popleft()
        for item in links[parent]:
            address = item["address"]
            if address in seen:
                continue
            seen.add(address)
            label_owner = item["labels"].get("herdr.space")
            if owners.get(address, set()) - {space_id} or (label_owner and label_owner != space_id):
                if verify:
                    raise Error(f"Child terminal {address} belongs to another space.")
                continue
            name, _ = foreground(item)
            status = (item.get("status") or {}).get("state")
            spec = nodes.get(address) or capture_terminal(item, records.get(address))
            worker = pi_worker(item, nodes[parent].get("session"), spec["session"]) if name == "pi" else None
            if verify and address not in nodes:
                if status in HIBERNATE_BLOCKERS:
                    check_hibernate_terminal(address, name, status, bool(worker))
                if not worker:
                    raise Error(f"Child terminal {address} has no verified Pi worker session to save.")
                check_hibernate_terminal(address, name, status, True)
                if not Path(spec["session"]["cwd"]).is_dir():
                    raise Error(f"Child terminal {address} has a missing working directory.")
            if worker:
                workers[address] = spec | {"worker": worker}
                if address not in nodes:
                    nodes[address] = spec
                    queue.append(address)
    return workers


def capture_space(space, terminals, records, view, index, previous=None, verify=False, owners=None):
    panes = {}
    old_panes = (previous or {}).get("panes", {})
    for _, pane, content in terminal_slots(space):
        address = content["terminal"]
        item = terminals.get(address)
        previous_pane = old_panes.get(pane, {})
        if item is None:
            if verify:
                raise Error(f"{address} is changing or unavailable")
            if previous_pane.get("terminal") == address:
                panes[pane] = previous_pane
                continue
            panes[pane] = {"terminal": address, "cwd": space.get("folder") or str(HOME)}
            continue
        spec = capture_terminal(item, records.get(address))
        if verify:
            name, _ = foreground(item)
            status = (item.get("status") or {}).get("state")
            check_hibernate_terminal(address, name, status, bool(spec["session"]))
        panes[pane] = spec
    selected = (view.get("spaces") or {}).get(space["id"])
    return {
        "space": space, "panes": panes, "index": index, "tab": selected,
        "workers": capture_workers(space["id"], panes, terminals, records, owners or {}, verify),
        "focus": (view.get("tabs", {}).get(selected) or {}).get("focused"),
        "zoom": (view.get("tabs", {}).get(selected) or {}).get("zoomed"),
    }


def checkpoint(core, store):
    _, doc = core.document()
    actual = core.terminals()
    view = installed_view()
    data = store.data
    owners = layout_owners(doc)
    latest = {
        space["id"]: capture_space(space, actual, data["records"], view, index,
                                   data["live"].get(space["id"]), owners=owners)
        for index, space in enumerate(doc["spaces"])
    }
    active = view.get("active")
    if active not in latest:
        active = data["active"] if data["active"] in latest else next(iter(latest), None)
    records = {address: record for address, record in data["records"].items()
               if address in actual and process_active(record)}
    for address, item in actual.items():
        if address not in records and (record := explicit_record(item)):
            records[address] = record
    if (data["live"], data["active"], data["records"]) != (latest, active, records):
        data.update(live=latest, active=active, records=records)
        store.save()


def replace_space(core, expected, replacement, index):
    target = (replacement or expected)["id"]
    for _ in range(6):
        version, doc = core.document()
        old = current_space(doc, target)
        if old == replacement:
            return
        if old != expected:
            raise Error("The space layout changed during the operation")
        if old is not None:
            index = doc["spaces"].index(old)
            doc["spaces"].remove(old)
        if replacement is not None:
            doc["spaces"].insert(index, replacement)
        try:
            core.call("doc.set", name=APP_DOCUMENT, value=doc, version=version)
            return
        except RpcError as error:
            if error.kind != "conflict":
                raise
    raise Error("The layout changed repeatedly; try again")


def recorded_terminal(core, address, facts):
    if not CORE_ADDRESS.fullmatch(address):
        raise Error("Unsupported terminal address in operation")
    terminal = core.terminal(address)
    if terminal and facts["boot"] == boot_id() and terminal_cookie(terminal) == facts["cookie"]:
        return terminal
    return None


def candidates(snapshot, terminals, expected=None):
    # Stop saved children before the parent whose exit would also end them.
    known = list(reversed(snapshot.get("workers", {})))
    for space in (snapshot["space"], expected):
        if space:
            known.extend(c["terminal"] for _, _, c in terminal_slots(space))
    return {address: {
        "boot": boot_id(), "cookie": terminal_cookie(terminals[address]),
        "labels": {k: v for k, v in terminals[address]["labels"].items() if k in MEMBERSHIP},
    } for address in dict.fromkeys(known) if address in terminals}


def drop_terminal(core, address, facts):
    if recorded_terminal(core, address, facts):
        try:
            core.call("terminal.kill", terminal=address)
        except RpcError as error:
            if error.kind not in {"not_found", "finished"}:
                raise


def clear_membership(core, operation):
    for address, facts in operation["kill"].items():
        if facts["labels"] and recorded_terminal(core, address, facts):
            core.call("terminal.label", terminal=address, labels={k: "" for k in facts["labels"]})


def restore_membership(core, operation):
    for address, facts in operation["kill"].items():
        if facts["labels"] and recorded_terminal(core, address, facts):
            core.call("terminal.label", terminal=address, labels=facts["labels"])


def finish_sleep(core, store, op):
    space_id = op["snapshot"]["space"]["id"]
    if op["phase"] == "detach":
        try:
            clear_membership(core, op)
            if op["expected"]:
                replace_space(core, op["expected"], None, op["snapshot"]["index"])
        except Error:
            _, doc = core.document()
            if current_space(doc, space_id) is not None:
                restore_membership(core, op)
                del store.data["pending"]
                store.save()
            raise
        op["phase"] = "stop"
        store.data["parked"][space_id] = op["snapshot"]
        store.save()
    for address, facts in op["kill"].items():
        drop_terminal(core, address, facts)
    store.data["live"].pop(space_id, None)
    del store.data["pending"]
    store.save()


def begin_sleep(core, store, snapshot, expected, terminals):
    op = {
        "type": "sleep", "phase": "detach", "snapshot": snapshot, "expected": expected,
        "kill": candidates(snapshot, terminals, expected),
    }
    store.data["pending"] = op
    store.save()
    finish_sleep(core, store, op)


def sleep_space(core, store, space_id):
    _, doc = core.document()
    space = current_space(doc, space_id)
    if space is None:
        raise Error("The selected local space is unavailable")
    owners = layout_owners(doc)
    view = installed_view()
    index = doc["spaces"].index(space)
    # Read the whole tree again immediately before journaling so a newly busy or new child wins.
    capture_space(space, core.terminals(), store.data["records"], view, index,
                  verify=True, owners=owners)
    current = core.terminals()
    snap = capture_space(space, current, store.data["records"], view, index,
                         verify=True, owners=owners)
    begin_sleep(core, store, snap, space, current)
    return {"id": space_id, "name": space.get("name") or space.get("folder") or space_id}


def prepared_launch(pane, active_records, space_folder):
    record = pane.get("session")
    cwd = pane.get("cwd") or str(HOME)
    if record is None:
        return (cwd if Path(cwd).is_dir() else str(HOME)), None, None
    ref = session_ref(record.get("agent"), record.get("value"), record.get("cwd"))
    if not ref:
        return (cwd if Path(cwd).is_dir() else str(HOME)), None, "Invalid session reference"
    cwd = ref["cwd"]
    warning = None
    if not Path(cwd).is_dir():
        if ref["agent"] != "pi" or not space_folder or not Path(space_folder).is_dir():
            return str(HOME), None, f"Working directory is missing: {cwd}"
        warning = f"Restoring Pi in {space_folder} because its working directory is missing: {cwd}"
        cwd = space_folder
    if ref["agent"] == "pi" and not Path(ref["value"]).is_file():
        return cwd, None, "Pi session file is missing"
    if (ref["agent"], ref["value"]) in active_records:
        return cwd, None, "This conversation is already open in another terminal"
    bins = read_json(STATE / "programs.json", {}) or {}
    executable = bins.get(ref["agent"]) or shutil.which(ref["agent"])
    if not executable or not os.access(executable, os.X_OK):
        return cwd, None, f"{ref['agent']} executable is unavailable"
    args = ([executable, "--session", ref["value"]] if ref["agent"] == "pi"
            else [executable, "--no-daemon", "resume", ref["value"]])
    return cwd, args, warning


def wake_slots(snapshot, space):
    workers = snapshot.get("workers", {})
    slots = {}
    for _, pane, content in terminal_slots(space):
        spec = snapshot["panes"][pane]
        address = spec["terminal"]
        slots[address] = (pane, workers.get(address, spec), content)
    for address, spec in workers.items():
        slots.setdefault(address, ("worker:" + address, spec, None))

    ordered = {}

    def add(address):
        if address in ordered:
            return ordered[address]
        slot, spec, content = slots[address]
        worker = spec.get("worker")
        parent = add(worker["parent"]) if worker else None
        entry = (slot, spec, content, parent[0] if parent else None, parent[4] + 1 if parent else 0)
        ordered[address] = entry
        return entry

    for address in slots:
        add(address)
    return ordered.values()


def pi_resume_argv(terminal, record):
    argv = terminal.get("argv") or []
    helper = str(Path(__file__).with_name("herdr-hibernate"))
    return bool(record and record.get("agent") == "pi"
                and (argv[1:3] == ["--session", record["value"]]
                     or (argv[1:4] == [helper, "launch", "--"]
                         and argv[-2:] == ["--session", record["value"]])))


def run_terminal(core, op, entry, used, parent, names):
    slot, spec, content, _, depth = entry
    worker = spec.get("worker")
    folder = None if worker else op["snapshot"]["space"].get("folder")
    cwd, args, warning = prepared_launch(spec, used, folder)
    if worker:
        if not parent:
            warning = "The parent Pi session could not be restored"
        elif worker["name"] in names:
            warning = "The worker name is already in use"
        if warning:
            warning = f'{worker["name"]}: {warning}'
            args = None
    if warning:
        op["warnings"][slot] = warning
    else:
        op["warnings"].pop(slot, None)
    if not args and content is None:
        return None, False
    helper = str(Path(__file__).with_name("herdr-hibernate"))
    argv = [sys.executable, helper, "launch", "--", *args] if args else []
    params = {
        "argv": argv, "cwd": cwd, "keep": True, "no_parent": True, "no_notify": True,
        "labels": {OPERATION: op["id"], SLOT: slot},
    }
    env = {}
    if args and (agent_home := spec["session"].get("agent_home")):
        home_key = "CODEX_HOME" if spec["session"]["agent"] == "codex" else "PI_CODING_AGENT_DIR"
        env[home_key] = agent_home
    if args and worker:
        params.update(argv=[*args, *worker["flags"]],
                      name=worker["name"], parent=parent, no_parent=False,
                      keep=content is not None, outlive_parent=worker["outlive_parent"])
        params["labels"].update({WORKER_OWNER: worker["owner"], WORKER_SESSION: spec["session"]["value"]})
        env.update(PI_SUBAGENT_PARENT=worker["name"], PI_SUBAGENT_DEPTH=str(depth))
        if worker.get("path"):
            env["PATH"] = worker["path"]
        if worker["leaf"]:
            params["labels"][WORKER_LEAF] = env["PI_SUBAGENT_LEAF"] = "1"
    if env:
        params["env"] = env
    result = core.call("terminal.run", **params)
    address = result["address"]
    if args:
        ref = spec["session"]
        used.add((ref["agent"], ref["value"]))
        if worker:
            names.add(worker["name"])
    return address, bool(args and spec["session"]["agent"] == "pi")


def missing_pi_session_cwd(record):
    cwd = pi_session_header(record).get("cwd")
    if isinstance(cwd, str) and Path(cwd).is_absolute() and not Path(cwd).exists():
        return cwd
    return None


def continue_pi_sessions(core, staged):
    pending = {}
    for spec, terminal in staged:
        record = spec.get("session")
        if pi_resume_argv(terminal, record) and (missing := missing_pi_session_cwd(record)):
            pending[terminal["address"]] = (missing, terminal["cwd"])

    # Pi can ask to continue every time an old session's original directory is gone.
    # Accept only its selected Continue entry, while the staged pane is still detached.
    deadline = time.monotonic() + 6
    while pending and time.monotonic() < deadline:
        for address, (missing, destination) in list(pending.items()):
            terminal = core.terminal(address)
            prompt = f"Session cwd does not exist: {missing}"
            status = (terminal or {}).get("status") or {}
            expected_question = (status.get("app") == "pi" and status.get("state") == "blocked"
                                 and status.get("kind") == "question" and status.get("msg") == prompt)
            if not terminal or (status and not expected_question):
                del pending[address]
                continue
            front = terminal.get("foreground") or {}
            if foreground(terminal)[0] != "pi" or front.get("cwd") != destination:
                continue
            screen = core.call("terminal.read", terminal=address, lines=0)["text"]
            lines = set(line.strip() for line in screen.splitlines())
            if {prompt, f"→ Continue in {destination} (asks again next time)"} <= lines:
                core.call("terminal.keys", terminal=address, keys=["enter"])
                del pending[address]
        if pending:
            time.sleep(0.15)


def finish_wake(core, store, op):
    snap = op["snapshot"]
    space = copy.deepcopy(snap["space"])
    actual = core.terminals()
    used = {(r["agent"], r["value"]) for address, r in store.data["records"].items()
            if address in actual and process_active(r)}
    if op["phase"] == "launch":
        # Recover a launch whose RPC succeeded just before the helper was interrupted.
        staged = {t["labels"][SLOT]: t for t in actual.values()
                  if t["labels"].get(OPERATION) == op["id"] and SLOT in t["labels"]}
        names = {t.get("name") for t in actual.values()}
        parents = {}
        op["staged"] = {}
        for entry in wake_slots(snap, space):
            slot, spec, content, parent_slot, _ = entry
            ref = spec.get("session")
            worker = spec.get("worker")
            parent, owner = parents.get(parent_slot, (None, None))
            if worker and owner != worker["owner"]:
                parent = None
            if terminal := staged.get(slot):
                address = terminal["address"]
                started = pi_resume_argv(terminal, ref)
                if ref and (started or (ref["agent"] == "codex" and terminal["argv"][-1:] == [ref["value"]])):
                    used.add((ref["agent"], ref["value"]))
            else:
                address, started = run_terminal(core, op, entry, used, parent, names)
            if started:
                parents[slot] = (address, pi_session_header(ref).get("id"))
            if address:
                op["staged"][slot] = address
            if content is not None:
                content["terminal"] = address
            store.save()
        op["replacement"] = space
        op["phase"] = "attach"
        store.save()
    space = op["replacement"]
    if op["phase"] == "attach":
        staged = []
        for slot, spec, content, _, _ in wake_slots(snap, space):
            address = op["staged"].get(slot)
            if not address:
                continue
            terminal = core.terminal(address)
            if terminal is None:
                if content is None:
                    op["warnings"][slot] = f'{spec["worker"]["name"]} exited during restore'
                    continue
                op["phase"] = "launch"
                store.save()
                raise Error("A restored terminal exited before attachment; retry to recreate it")
            if terminal.get("reason") == "spawn_pending":
                raise Error("Core is still starting a restored terminal")
            staged.append((spec, terminal))
        try:
            _, doc = core.document()
            if current_space(doc, space["id"]) != space:
                continue_pi_sessions(core, staged)
            clear_membership(core, op)
            replace_space(core, op["expected"], space, snap["index"])
        except Error:
            _, doc = core.document()
            if current_space(doc, space["id"]) != space:
                restore_membership(core, op)
            raise
        op["phase"] = "cleanup"
        store.save()
    # Set adoption labels only after the split tree is visible to the app.
    for tab, _, content in terminal_slots(space):
        core.call("terminal.label", terminal=content["terminal"],
                  labels={"herdr.space": space["id"], "herdr.tab": tab})
    for address, facts in op["kill"].items():
        drop_terminal(core, address, facts)
    if op.get("boot"):
        store.data["boot_restored"] = op["boot"]
    store.data["parked"].pop(space["id"], None)
    del store.data["pending"]
    store.save()
    return {key: snap.get(key) for key in ("tab", "focus", "zoom")} | {
        "id": space["id"], "warnings": snap.get("import_warnings", []) + list(op["warnings"].values()),
    }


def begin_wake(core, store, snapshot, expected=None, terminals=None, boot=None):
    op = {
        "type": "wake", "phase": "launch", "id": uuid.uuid4().hex, "snapshot": snapshot,
        "expected": expected, "kill": candidates(snapshot, terminals or {}, expected),
        "staged": {}, "warnings": {}, "boot": boot,
    }
    store.data["pending"] = op
    store.save()
    return finish_wake(core, store, op)


def recover_pending(core, store):
    op = store.data.get("pending")
    if op is None:
        return None
    if op["type"] == "sleep":
        return finish_sleep(core, store, op)
    return finish_wake(core, store, op)


def normal_shells(snapshot, expected, actual):
    for address in candidates(snapshot, actual, expected):
        terminal = actual[address]
        name, _ = foreground(terminal)
        if not name and not terminal.get("pid") and terminal.get("reason") != "spawn_pending":
            continue
        if not name or terminal.get("reason") == "spawn_pending":
            raise Error("Waiting for Core to identify recovered terminals")
        if name not in SHELLS or terminal.get("status"):
            return False
    return True


def reconcile_boot(core, store):
    data = store.data
    boot = boot_id()
    if data["boot"] == boot:
        return
    if data["boot"] is None:
        checkpoint(core, store)
    else:
        snapshots = list(data["live"].values())
        active = data["active"]
        for snapshot in snapshots:
            space_id = snapshot["space"]["id"]
            _, doc = core.document()
            expected = current_space(doc, space_id)
            actual = core.terminals()
            if not normal_shells(snapshot, expected, actual):
                print(f"Boot left {space_id} alone because it already contains a running program", file=sys.stderr)
                continue
            if space_id != active:
                begin_sleep(core, store, snapshot, expected, actual)
            elif data.get("boot_restored") != boot:
                result = begin_wake(core, store, snapshot, expected, actual, boot=boot)
                for warning in result["warnings"]:
                    print(warning, file=sys.stderr)
    data["boot"] = boot
    store.save()
    checkpoint(core, store)


def launch(args):
    # The interactive shell gives the agent its own foreground process group,
    # then stays available when the agent exits, as in Herdr App's launcher.
    shell = os.environ.get("SHELL") or "/bin/sh"
    name = Path(shell).name
    if name == "fish":
        os.execv(shell, [shell, "-ic", "command $argv[2..]; exec $argv[1] -i", shell, *args])
    runner = shell if name in {"bash", "dash", "ksh", "sh", "zsh"} else "/bin/sh"
    os.execv(runner, [runner, "-ic", '"$@"; exec "$0" -i', shell, *args])
