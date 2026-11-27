"""Open synthetic conversations with the real agents, without submitting prompts."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))


def run(root):
    from capture import WORKER_LEAF, WORKER_OWNER, WORKER_SESSION, process_env
    from core import APP_DOCUMENT, APP_HOME, Core, Error, locked_store, save_json
    from install import entrypoint_files, install_entrypoints
    from workspaces import capture_space, checkpoint

    cwd = str(root / "repo")
    Path(cwd).mkdir()
    pi_cwd = root / "temporary-review"
    pi_cwd.mkdir()
    codex_home = root / "codex"
    pi_home = root / "pi"
    transcripts = codex_home / "sessions" / datetime.now().strftime("%Y/%m/%d")
    transcripts.mkdir(parents=True)
    (codex_home / "config.toml").write_text(f'[projects."{cwd}"]\ntrust_level = "trusted"\n')
    (codex_home / "auth.json").write_text(json.dumps({"OPENAI_API_KEY": "isolated-test-placeholder"}))
    pi_home.mkdir()
    pi_id, worker_id, leaf_id, *codex_ids = [str(uuid.uuid4()) for _ in range(5)]
    now = datetime.now(timezone.utc)
    stamp = now.isoformat(timespec="milliseconds")
    pi_file = root / "fixture.jsonl"
    worker_file = root / "worker.jsonl"
    leaf_file = root / "leaf.jsonl"

    def jsonl(file, *lines):
        file.write_text("".join(json.dumps(line) + "\n" for line in lines))

    def pi_fixture(file, session_id, folder, marker):
        jsonl(file, {"type": "session", "version": 3, "id": session_id, "timestamp": stamp, "cwd": folder}, {
            "type": "message", "id": "cb34000a", "parentId": None, "timestamp": stamp,
            "message": {"role": "user", "content": [{"type": "text", "text": marker}],
                        "timestamp": int(now.timestamp() * 1000)},
        }, {
            "type": "message", "id": "cb34000b", "parentId": "cb34000a", "timestamp": stamp,
            "message": {"role": "assistant", "content": [{"type": "text", "text": "Fixture response"}],
                        "api": "openai-responses", "provider": "openai", "model": "gpt-5.4",
                        "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
                                  "totalTokens": 0, "cost": {"input": 0, "output": 0, "cacheRead": 0,
                                                             "cacheWrite": 0, "total": 0}},
                        "stopReason": "stop", "timestamp": int(now.timestamp() * 1000)},
        })

    pi_fixture(pi_file, pi_id, str(pi_cwd), "hibernation-fixture-pi")
    pi_fixture(worker_file, worker_id, cwd, "hibernation-fixture-worker")
    pi_fixture(leaf_file, leaf_id, cwd, "hibernation-fixture-leaf")

    pi = shutil.which("pi")
    codex = shutil.which("codex")
    for index, thread in enumerate(codex_ids):
        path = transcripts / f"rollout-{now.strftime('%Y-%m-%dT%H-%M-%S')}-{thread}.jsonl"
        message = f"hibernation-fixture-codex-{index}"
        jsonl(path, {"timestamp": stamp, "type": "session_meta", "payload": {
            "id": thread, "session_id": thread, "timestamp": stamp, "cwd": cwd,
            "originator": "codex-tui", "cli_version": "0.171.0", "source": "cli",
            "model_provider": "openai",
        }}, {"timestamp": stamp, "type": "event_msg", "payload": {
            "type": "task_started", "turn_id": thread,
            "model_context_window": 272000, "collaboration_mode_kind": "default",
        }}, {"timestamp": stamp, "type": "event_msg", "payload": {
            "type": "user_message", "message": message, "images": [], "local_images": [],
            "text_elements": [],
        }}, {"timestamp": stamp, "type": "response_item", "payload": {
            "type": "message", "role": "user",
            "content": [{"type": "input_text", "text": message}],
        }}, {"timestamp": stamp, "type": "event_msg", "payload": {
            "type": "task_complete", "turn_id": thread, "last_agent_message": "Fixture response",
        }})

    executable = root / "bin/herdr-hibernate"
    extension = pi_home / "extensions/capture.ts"
    install_entrypoints(entrypoint_files(executable, extension))
    assert executable.is_file() and not executable.is_symlink()
    assert extension.is_file() and not extension.is_symlink()
    initial = {
        "PI_CODING_AGENT_DIR": str(pi_home), "CODEX_HOME": str(codex_home),
        "HERDR_HIBERNATE_HELPER": str(executable),
        "HERDR_HIBERNATE_STATE": os.environ["HERDR_HIBERNATE_STATE"],
        "OPENAI_API_KEY": "isolated-test-placeholder",
        "PI_SKIP_VERSION_CHECK": "1",
    }
    os.environ.update(initial)
    with Core() as core:
        args = [[pi, "--session", str(pi_file)]]
        args += [[codex, "--no-daemon", "resume", thread] for thread in codex_ids]
        addresses = [core.call("terminal.run", cwd=folder, argv=argv, keep=True, no_parent=True,
                               env=initial, size={"cols": 110, "rows": 32})["address"]
                     for folder, argv in zip([str(pi_cwd), cwd, cwd, cwd], args)]
        for _ in range(100):
            terminals = [core.terminal(address) for address in addresses]
            with locked_store(core) as store:
                checkpoint(core, store)
                records = [store.data["records"].get(address, {}) for address in addresses]
            if records[0].get("value") == str(pi_file) and [r.get("value") for r in records[1:]] == codex_ids:
                break
            time.sleep(0.1)
        else:
            for address, terminal in zip(addresses, terminals):
                print(address, terminal and terminal.get("foreground"), terminal and terminal.get("status"))
                print(core.call("terminal.read", terminal=address, lines=20).get("text", "")[-2000:])
            raise AssertionError("Native terminals did not report the three exact references")
        def wait_for_transcript(address, marker):
            for _ in range(60):
                text = core.call("terminal.read", terminal=address, lines=64).get("text", "")
                if marker in text:
                    return
                time.sleep(0.1)
            raise AssertionError(f"{marker} did not appear in {address}: {text[-500:]}")

        for index, address in enumerate(addresses):
            marker = "hibernation-fixture-pi" if index == 0 else f"hibernation-fixture-codex-{index - 1}"
            wait_for_transcript(address, marker)

        def space(sid, addresses):
            return {"id": sid, "folder": cwd, "name": sid, "tabs": [{
                "id": sid + "tab", "name": sid, "root": {
                    "type": "row", "id": sid + "row",
                    "children": [{"type": "block", "id": sid + "p" + str(i),
                                  "content": {"terminal": addr}} for i, addr in enumerate(addresses)],
                },
            }]}
        active = space("active", addresses[:2])
        core.call("doc.set", name=APP_DOCUMENT, value={
            "spaces": [space("other", addresses[2:]), active],
        }, version=0)
        save_json(APP_HOME / "view.json", {"active": "active"})

        def start_worker(name, parent, owner, file, flags, leaf=False):
            labels = {WORKER_OWNER: owner, WORKER_SESSION: str(file)}
            if leaf:
                labels[WORKER_LEAF] = "1"
            return core.call("terminal.run", name=name, parent=parent, no_notify=True, labels=labels,
                             cwd=cwd, argv=[pi, "--session", str(file), *flags], env=initial)["address"]

        worker = start_worker("fixture-worker", addresses[0], pi_id, worker_file, ["--thinking", "high"])
        leaf = start_worker("fixture-leaf", worker, worker_id, leaf_file, ["--exclude-tools", "subagent"], leaf=True)
        for address, marker in [(worker, "hibernation-fixture-worker"), (leaf, "hibernation-fixture-leaf")]:
            ready = core.call("terminal.wait", terminal=address, timeout=15)
            assert ready["status"] in {"idle", "done"}, ready
            wait_for_transcript(address, marker)
        with locked_store(core) as store:
            checkpoint(core, store)
            assert set(store.data["live"]["active"]["workers"]) == {worker, leaf}
            busy = core.terminals()
            busy[leaf]["status"] = {"app": "pi", "state": "working"}
            try:
                capture_space(active, busy, store.data["records"], {}, 1, verify=True)
            except Error as error:
                assert f"{leaf} (pi) is still working" in str(error)
            else:
                raise AssertionError("A busy nested worker did not block hibernation")
    print("PASS real Pi extension capture and two distinct native Codex resumes in one directory")

    def command(*args):
        result = subprocess.run([executable, *args], capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    def simulate_reboot(remove_cwd=False):
        subprocess.run(["hc", "server", "stop"], check=True, capture_output=True)
        if remove_cwd:
            pi_cwd.rmdir()
        with Core() as core, locked_store(core) as store:
            store.data["boot"] = "simulated-earlier-boot"
            store.data.pop("boot_restored", None)
            store.save()
        for _ in range(30):
            try:
                command("boot")
                return
            except AssertionError as error:
                if "Waiting for Core" not in str(error):
                    raise
                time.sleep(0.2)
        raise AssertionError("Core did not finish booting")

    def check_workers(core, pi_address):
        by_name = {t["name"]: t for t in core.terminals().values()}
        worker = by_name["fixture-worker"]
        leaf = by_name["fixture-leaf"]
        assert worker["parent"] == pi_address and leaf["parent"] == worker["address"]
        assert worker["labels"][WORKER_OWNER] == pi_id and leaf["labels"][WORKER_OWNER] == worker_id
        assert leaf["labels"][WORKER_LEAF] == "1"
        for child, file, marker in [(worker, worker_file, "worker"), (leaf, leaf_file, "leaf")]:
            assert child["labels"][WORKER_SESSION] == str(file)
            assert "herdr.tab" not in child["labels"] and "herdr.space" not in child["labels"]
            assert child["die_with_parent"] and not child["keep"] and not child["notify"]
            wait_for_transcript(child["address"], f"hibernation-fixture-{marker}")
        assert process_env(worker["pid"], "PI_SUBAGENT_DEPTH") == "1"
        assert process_env(leaf["pid"], "PI_SUBAGENT_DEPTH") == "2"
        assert process_env(leaf["pid"], "PI_SUBAGENT_LEAF") == "1"
        assert "--thinking" in worker["argv"] and "--exclude-tools" in leaf["argv"]

    command("boot")
    command("hibernate", "active")
    listing = command("list")["spaces"]
    assert listing[0]["id"] == "active" and listing[0]["agents"] == 4
    with Core() as core:
        assert not {addresses[0], worker, leaf} & core.terminals().keys()
    restored = command("wake", "active")
    assert restored["warnings"] == []
    with Core() as core:
        current = next(s for s in core.document()[1]["spaces"] if s["id"] == "active")
        address = current["tabs"][0]["root"]["children"][0]["content"]["terminal"]
        check_workers(core, address)
    command("hibernate", "other")
    command("wake", "other")
    with Core() as core:
        reopened = core.document()[1]["spaces"][0]
        child = reopened["tabs"][0]["root"]["children"][0]["content"]["terminal"]
        wait_for_transcript(child, "hibernation-fixture-codex-1")
        with locked_store(core) as store:
            checkpoint(core, store)
            assert store.data["live"]["other"]["panes"]["otherp0"]["session"]["value"] == codex_ids[1]
    for remove_cwd in (True, False):
        simulate_reboot(remove_cwd)
        assert [row["id"] for row in command("list")["spaces"]] == ["other"]
        with Core() as core:
            doc = core.document()[1]
            assert [row["id"] for row in doc["spaces"]] == ["active"]
            nodes = doc["spaces"][0]["tabs"][0]["root"]["children"]
            for node, marker in zip(nodes, ["hibernation-fixture-pi", "hibernation-fixture-codex-0"]):
                wait_for_transcript(node["content"]["terminal"], marker)
            pi_address = nodes[0]["content"]["terminal"]
            assert core.terminal(pi_address)["foreground"]["cwd"] == cwd
            check_workers(core, pi_address)
            assert len(core.terminals()) == 4
            for _ in range(60):
                with locked_store(core) as store:
                    checkpoint(core, store)
                    record = store.data["live"]["active"]["panes"]["activep0"]["session"]
                if record and record["value"] == str(pi_file) and record["cwd"] == cwd:
                    break
                time.sleep(0.1)
            else:
                raise AssertionError("Pi's original session was not checkpointed from the workspace")
    assert json.loads(pi_file.read_text().splitlines()[0])["cwd"] == str(pi_cwd)
    command("wake", "other")
    with Core() as core:
        other = next(row for row in core.document()[1]["spaces"] if row["id"] == "other")
        addr = other["tabs"][0]["root"]["children"][0]["content"]["terminal"]
        wait_for_transcript(addr, "hibernation-fixture-codex-1")
    print("PASS real agent conversations and nested Pi workers after manual wake and two cold boots")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="herdr-native-") as temporary:
        root = Path(temporary)
        for key in ("HC_SOCKET", "HC_TERMINAL_SOCKET", "HC_TERMINAL_ID", "HC_TERMINAL_SESSION"):
            os.environ.pop(key, None)
        os.environ.update(HC_SESSION="hibernate-native", XDG_RUNTIME_DIR=str(root / "run"),
                          XDG_STATE_HOME=str(root / "xdg"), XDG_CONFIG_HOME=str(root / "config"),
                          HERDR_HIBERNATE_STATE=str(root / "state"), HERDR_APP_HOME=str(root / "app"),
                          SHELL="/bin/zsh", ZDOTDIR=str(root))
        (root / ".zshrc").touch()
        (root / "run").mkdir(mode=0o700)
        try:
            run(root)
        finally:
            subprocess.run(["hc", "server", "stop"], capture_output=True)
