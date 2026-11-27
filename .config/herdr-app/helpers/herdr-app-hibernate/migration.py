"""Convert the classic plugin's hibernated snapshots without starting terminals."""

import hashlib
import json
import math
import os
import socket
from pathlib import Path

from capture import session_ref
from core import Error, HOME, read_json

CLASSIC = Path(os.environ.get("XDG_STATE_HOME", HOME / ".local/state")) / (
    "herdr/plugins/alex.workspace-hibernate/hibernated"
)


def convert(data):
    seed = hashlib.sha256(f"classic:{data['id']}".encode()).hexdigest()[:24]
    panes = {}
    warnings = list(data.get("warnings", []))
    tabs = []
    focused = {}
    if data["schema_version"] != 1 or not data["tabs"]:
        raise ValueError("Unsupported classic snapshot")

    def node(old, wake, stem):
        kind = old["type"]
        if kind == "pane":
            pane = f"p{stem}"
            if old.get("pane_id"):
                focused[old["pane_id"]] = pane
            terminal = f"t{stem}"
            cwd = old.get("cwd") or data.get("cwd") or str(HOME)
            instruction = next(wake)
            record = None
            if instruction:
                agent = instruction["agent"]
                value = instruction["session"]
                if agent == "codex":
                    value = value.removeprefix("codex:")
                record = session_ref(agent, value, cwd)
                if record is None:
                    warnings.append(f"{agent} reference in {pane} needs manual recovery")
            panes[pane] = {"terminal": terminal, "cwd": cwd, "session": record}
            return {"id": pane, "type": "block", "content": {"terminal": terminal}}
        if kind != "split" or old.get("direction") not in {"down", "right"}:
            raise ValueError("Unknown classic split layout")
        ratio = float(old["ratio"])
        if not math.isfinite(ratio) or not 0 < ratio < 1:
            raise ValueError("Invalid classic split ratio")
        first = node(old["first"], wake, f"{stem}a")
        second = node(old["second"], wake, f"{stem}b")
        first["size"], second["size"] = {"weight": ratio}, {"weight": 1 - ratio}
        axis = "row" if old["direction"] == "right" else "column"
        return {"id": f"s{stem}", "type": axis, "children": [first, second]}

    for index, tab in enumerate(data["tabs"]):
        stem = f"{seed}z{index}z"
        tab_id = f"tb{stem}"
        wake = iter(tab["wake"])
        root = node(tab["root"], wake, stem)
        if next(wake, False) is not False:
            raise ValueError("Classic snapshot has extra pane references")
        if root["type"] == "block":
            root = {"id": tab_id, "type": "row", "children": [root]}
        tabs.append({"id": tab_id, "name": tab.get("label") or "", "root": root})
    selected = max(0, min(int(data.get("active_tab_index", 0)), len(tabs) - 1))
    active_tab = data["tabs"][selected]
    focus = focused.get(active_tab.get("focused_pane_id"))
    return {
        "space": {"id": f"sp{seed}", "name": data.get("label") or "Workspace",
                  "folder": data.get("cwd") or str(HOME), "tabs": tabs},
        "panes": panes, "index": 999999, "tab": tabs[selected]["id"], "focus": focus,
        "zoom": focus if active_tab.get("zoomed") else None,
        "import_warnings": warnings, "hibernated_at": data.get("hibernated_at"),
    }


def read_classic_snapshots(directory):
    snapshots = []
    errors = []
    for path in sorted(directory.glob("*.json")):
        try:
            snapshots.append(convert(read_json(path)))
        except (ValueError, KeyError, TypeError, StopIteration, OSError) as error:
            errors.append({"file": path.name, "error": str(error) or "Missing pane reference"})
    return snapshots, errors


def classic_call(endpoint, method, **params):
    request = {"id": "herdr-hibernate-import", "method": method, "params": params}
    with socket.socket(socket.AF_UNIX) as conn:
        conn.settimeout(10)
        conn.connect(str(endpoint))
        conn.sendall(json.dumps(request).encode() + b"\n")
        with conn.makefile("rb") as stream:
            line = stream.readline(4 * 1024 * 1024)
    if not line:
        raise Error(f"Classic Herdr disconnected during {method}")
    response = json.loads(line)
    if "error" in response:
        raise Error(response["error"].get("message", f"Classic Herdr failed during {method}"))
    return response["result"]


def classic_panes(node):
    if node["type"] == "pane":
        yield node
    else:
        yield from classic_panes(node["first"])
        yield from classic_panes(node["second"])


def classic_agent(pane):
    agent = pane.get("agent")
    reported = pane.get("agent_session") or {}
    if not agent or reported.get("agent") != agent or reported.get("source") != f"herdr:{agent}":
        return agent, None
    cwd = pane.get("foreground_cwd") or pane.get("cwd")
    ref = session_ref(agent, reported.get("value"), cwd)
    if ref and agent == "pi" and not Path(ref["value"]).is_file():
        ref = None
    return agent, ref


def capture_live_classic(endpoint, workspace):
    workspace_id = workspace["workspace_id"]
    listing = classic_call(endpoint, "tab.list", workspace_id=workspace_id)["tabs"]
    panes = {
        pane["pane_id"]: pane
        for pane in classic_call(endpoint, "pane.list", workspace_id=workspace_id)["panes"]
    }
    tabs = []
    warnings = []
    seen = set()
    active = 0
    for tab in sorted(listing, key=lambda item: item["number"]):
        tab_id = tab["tab_id"]
        if tab_id == workspace.get("active_tab_id"):
            active = len(tabs)
        layout = classic_call(endpoint, "layout.export", tab_id=tab_id)["layout"]
        wake = []
        for leaf in classic_panes(layout["root"]):
            pane_id = leaf["pane_id"]
            if pane_id not in panes or panes[pane_id]["tab_id"] != tab_id or pane_id in seen:
                raise Error("A pane moved while reading the workspace")
            seen.add(pane_id)
            pane = panes[pane_id]
            cwd = pane.get("foreground_cwd") or leaf.get("cwd") or pane.get("cwd")
            if cwd:
                leaf["cwd"] = cwd
            agent, ref = classic_agent(pane)
            if agent and not ref:
                warnings.append(f"{pane_id} ({agent}) had no verified session reference")
            wake.append({"agent": agent, "session": ref["value"]} if ref else None)
        tabs.append({
            "label": tab.get("label"), "root": layout["root"], "wake": wake,
            "focused_pane_id": layout.get("focused_pane_id"), "zoomed": layout.get("zoomed"),
        })
    if seen != panes.keys():
        raise Error("The workspace panes changed during capture")
    cwd = next((pane["cwd"] for pane in classic_panes(tabs[0]["root"]) if pane.get("cwd")), str(HOME))
    return convert({
        "schema_version": 1, "id": f"live:{endpoint}:{workspace_id}",
        "label": workspace.get("label"), "cwd": cwd, "tabs": tabs,
        "active_tab_index": active, "warnings": warnings,
    })


def read_live_classic():
    if os.environ.get("HERDR_ENV") != "1":
        raise Error("Run the live import from inside a classic Herdr pane")
    config = Path(os.environ.get("HERDR_CONFIG_PATH", HOME / ".config/herdr/config.toml"))
    endpoint = Path(os.environ.get("HERDR_SOCKET_PATH") or config.with_name("herdr.sock")).resolve()
    workspaces = classic_call(endpoint, "workspace.list")["workspaces"]
    snapshots = []
    errors = []
    for workspace in workspaces:
        try:
            snapshots.append(capture_live_classic(endpoint, workspace))
        except (Error, ValueError, KeyError, TypeError, IndexError, OSError) as error:
            errors.append({"workspace": workspace["workspace_id"], "error": str(error)})
    return snapshots, errors


def save_imports(snapshots, errors, store=None):
    result = {"ready": len(snapshots), "imported": 0, "errors": errors, "spaces": []}
    imported = set(store.data["imports"]) if store else set()
    for snapshot in snapshots:
        space = snapshot["space"]
        key = space["id"]
        result["spaces"].append({"id": key, "name": space["name"], "folder": space["folder"],
                                 "tabs": len(space["tabs"]), "panes": len(snapshot["panes"]),
                                 "agents": sum(bool(pane.get("session")) for pane in snapshot["panes"].values()),
                                 "warnings": snapshot["import_warnings"]})
        if store and key not in imported:
            store.data["parked"][key] = snapshot
            imported.add(key)
            result["imported"] += 1
    if store and result["imported"]:
        store.data["imports"] = sorted(imported)
        store.save()
    return result
