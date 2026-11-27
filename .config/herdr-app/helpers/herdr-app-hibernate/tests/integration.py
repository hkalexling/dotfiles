"""Exercise the workflow against a private Core and a temporary app state."""

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))


def check():
    from core import APP_DOCUMENT, APP_HOME, STATE, Core, locked_store, save_json

    def command(*args):
        run = subprocess.run([PROJECT / "herdr-hibernate", *args], capture_output=True, text=True)
        if run.returncode:
            raise RuntimeError(run.stderr)
        return json.loads(run.stdout)

    def shell(core, cwd, **labels):
        return core.call("terminal.run", cwd=str(cwd), keep=True, no_parent=True, labels=labels)["address"]

    def wait_for(predicate):
        for _ in range(60):
            result = predicate()
            if result:
                return result
            time.sleep(0.1)
        raise AssertionError("State did not settle")

    def space(sid, terminals):
        def pane(address, index):
            return {"type": "block", "id": sid + "p" + str(index), "content": {"terminal": address},
                    "size": {"weight": [0.35, 0.65][index % 2]}}
        tab = sid + "tab"
        return {"id": sid, "folder": str(root), "name": sid, "tabs": [
            {"id": tab, "name": sid, "root": {
                "id": tab, "type": "column",
                "children": [pane(a, i) for i, a in enumerate(terminals)],
            }}
        ]}

    root = STATE.parent
    with Core() as core:
        a = shell(core, root, **{"herdr.space": "active", "herdr.tab": "activetab"})
        b = shell(core, root, **{"herdr.space": "other", "herdr.tab": "othertab"})
        c = shell(core, root)
        active = space("active", [a])
        other = space("other", [b, c])
        core.call("doc.set", name=APP_DOCUMENT, version=0, value={"spaces": [other, active]})
        save_json(APP_HOME / "view.json", {"active": "active", "spaces": {"other": "othertab"},
                                         "tabs": {"othertab": {"focused": "otherp1"}}})
        wait_for(lambda: all(t.get("foreground") for t in core.terminals().values()))

    command("boot")
    command("hibernate", "other")
    assert [s["id"] for s in command("list")["spaces"]] == ["other"]
    with Core() as core:
        assert set(core.terminals()) == {a}
    restored = command("wake", "other")
    assert restored["tab"] == "othertab" and restored["focus"] == "otherp1"
    assert command("list")["spaces"] == []
    with Core() as core:
        _, doc = core.document()
        restored = doc["spaces"][0]
        assert restored["id"] == "other"
        assert [n["size"]["weight"] for n in restored["tabs"][0]["root"]["children"]] == [0.35, 0.65]
        assert len(core.terminals()) == 3
    print("PASS manual hibernate and wake preserve splits, focus and stop the original terminals")

    # hc's full stop kills the PTYs. A stale marker simulates the next OS boot.
    subprocess.run(["hc", "server", "stop"], check=True, capture_output=True)
    with Core() as core, locked_store(core) as store:
        store.data["boot"] = "previous-boot"
        store.save()
        wait_for(lambda: all(t.get("foreground") for t in core.terminals().values()))
    command("boot")
    assert [s["id"] for s in command("list")["spaces"]] == ["other"]
    with Core() as core:
        assert [w["id"] for w in core.document()[1]["spaces"]] == ["active"]
        assert len(core.terminals()) == 1
        running = set(core.terminals())
    command("boot")
    with Core() as core:
        assert set(core.terminals()) == running
    command("wake", "other")
    command("boot")
    assert command("list")["spaces"] == []
    with Core() as core:
        assert len(core.terminals()) == 3
    print("PASS isolated full Core stop and boot simulation restore only the last-used space")

    with Core() as core:
        wait_for(lambda: all(t.get("foreground") for t in core.terminals().values()))
    command("hibernate", "other")
    with Core() as core, locked_store(core) as store:
        before = core.document()
        running = set(core.terminals())
        store.data["imports"].append("other")
        store.save()
    assert command("delete", "other") == {"id": "other", "deleted": True}
    assert command("list")["spaces"] == []
    assert command("delete", "other") == {"id": "other", "deleted": False}
    with Core() as core, locked_store(core) as store:
        assert core.document() == before and set(core.terminals()) == running
        assert "other" in store.data["imports"]
    print("PASS deleting a hibernated space changes only the saved catalog")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="herdr-hib-") as tmp:
        root = Path(tmp)
        for key in ("HC_SOCKET", "HC_TERMINAL_SOCKET", "HC_TERMINAL_ID", "HC_TERMINAL_SESSION"):
            os.environ.pop(key, None)
        os.environ.update(HC_SESSION="hibernate-test", XDG_RUNTIME_DIR=str(root / "run"),
                          XDG_STATE_HOME=str(root / "xdg"), XDG_CONFIG_HOME=str(root / "config"),
                          HERDR_HIBERNATE_STATE=str(root / "state"), HERDR_APP_HOME=str(root / "app"))
        (root / "run").mkdir(mode=0o700)
        try:
            check()
        finally:
            subprocess.run(["hc", "server", "stop"], capture_output=True)
