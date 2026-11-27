"""Install the hibernation mods and extend the installed app's command palette."""

import hashlib
import json
import os
import tempfile
from pathlib import Path

from core import APP_HOME, Error, read_json, save_json

PROJECT = Path(__file__).resolve().parent
PALETTE = "workspace-command-palette"
GENERATED = b"// herdr-app-hibernate generated palette sha256: "
OLD_BINDINGS = {
    "ctrl-b shift-u": "mod.open:workspace-hibernate",
    "ctrl-b shift-z": "mod.open:workspace-hibernate-current",
    "ctrl-shift-u": "mod.open:workspace-hibernate",
}


def palette_files():
    source = APP_HOME / "frame/palette/main.js"
    contents = source.read_text()
    anchor = "const NAMED = [\n"
    if contents.count(anchor) != 1:
        raise Error(f"Unsupported command palette at {source}")
    entries = [
        ["mod.open", {"name": "workspace-hibernate-current"}, "Space",
         "Hibernate current space", "hibernate workspace sleep suspend"],
        ["mod.open", {"name": "workspace-hibernate"}, "Space",
         "Wake hibernated space…", "wake workspace restore resume"],
    ]
    additions = "".join(f"  {json.dumps(entry, ensure_ascii=False)},\n" for entry in entries)
    body = contents.replace(anchor, anchor + additions, 1).encode()
    manifest = {
        "place": "none", "title": "Command palette",
        "overlay": {"kind": "popup", "at": "top", "offset": 60, "width": 620, "height": 0.85},
    }
    return {
        "main.js": GENERATED + hashlib.sha256(body).hexdigest().encode() + b"\n" + body,
        "mod.json": (json.dumps(manifest, indent=2) + "\n").encode(),
    }


def generated_palette(contents):
    header, _, body = contents.partition(b"\n")
    return header == GENERATED + hashlib.sha256(body).hexdigest().encode()


def plan_app_ui():
    path = APP_HOME / "keys.json"
    keys = read_json(path, {})
    bindings = keys.setdefault("global", {})
    for key, action in OLD_BINDINGS.items():
        if bindings.get(key) == action:
            del bindings[key]
    for key, action in read_json(PROJECT / "keys.json")["global"].items():
        current = bindings.get(key)
        stock_palette = key == "ctrl-shift-p" and current == "app.palette"
        if current is not None and current != action and not stock_palette:
            raise Error(f"{key} is already bound in {path}")
        bindings[key] = action

    mods = {}
    palette = APP_HOME / "mods" / PALETTE
    for directory in sorted((PROJECT / "mods").iterdir()):
        for name in ("main.js", "mod.json"):
            mods[APP_HOME / "mods" / directory.name / name] = (directory / name).read_bytes()
    mods.update({palette / name: content for name, content in palette_files().items()})
    for target, content in mods.items():
        if not target.exists():
            continue
        old = target.read_bytes()
        if old != content and not (target == palette / "main.js" and generated_palette(old)):
            raise Error(f"Refusing to replace {target}")
    return path, keys, mods


def apply_app_ui(path, keys, mods, backup):
    # Let the app discover its new mod before the shortcut can invoke it.
    for target, content in mods.items():
        if target.exists() and target.read_bytes() == content:
            continue
        target.parent.mkdir(exist_ok=True, parents=True)
        fd, temporary = tempfile.mkstemp(prefix=".install-", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(content)
            os.replace(temporary, target)
        finally:
            Path(temporary).unlink(missing_ok=True)
    old = read_json(path)
    if old != keys:
        if old is not None:
            save_json(backup / path.name, old)
        save_json(path, keys)
