#!/usr/bin/env python3
"""Single-snapshot system stats for the eww sysmon widget.

Emits one line of JSON on stdout, and always emits *valid* JSON (the widget
renders nothing if a jq/json-access expression fails on an empty value).

Notes:
  * CPU percentages are computed from the delta since the previous run, using a
    state file in $XDG_RUNTIME_DIR. This mirrors conky's `$cpu` / `$top cpu`
    behaviour (instantaneous load, not a lifetime average).
  * All display formatting happens here so the yuck config stays declarative.
"""

from __future__ import annotations

import glob
import json
import os
import platform
import subprocess
import time

TOPN = 4
RUNDIR = os.environ.get("XDG_RUNTIME_DIR") or "/tmp"
STATE = os.path.join(RUNDIR, "eww-sysmon.state.json")
PAGE_SIZE = os.sysconf("SC_PAGE_SIZE")
USER_HZ = os.sysconf("SC_CLK_TCK")
# CPU percentages are deltas between polls; a very short window (e.g. right after
# a config reload) would produce wild numbers, so enforce a floor.
MIN_WINDOW = 0.5


# --------------------------------------------------------------------------- #
# formatting helpers
# --------------------------------------------------------------------------- #
def human(nbytes: float) -> str:
    """Binary size with 3 significant digits, matching conky ($mem/$swap/$fs_used)."""
    for unit, factor in (("TiB", 1 << 40), ("GiB", 1 << 30), ("MiB", 1 << 20), ("KiB", 1 << 10)):
        if abs(nbytes) >= factor:
            val = nbytes / factor
            decimals = 0 if val >= 100 else (1 if val >= 10 else 2)
            return f"{val:.{decimals}f}{unit}"
    return f"{int(nbytes)}B"


def uptime_short() -> str:
    """Conky's `uptime_short` shape: 3d 4h / 4h 5m / 5m 6s."""
    with open("/proc/uptime") as fh:
        secs = int(float(fh.read().split()[0]))
    days, rem = divmod(secs, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, seconds = divmod(rem, 60)
    if days:
        return f"{days}d {hours}h"
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m {seconds}s"


# --------------------------------------------------------------------------- #
# readers
# --------------------------------------------------------------------------- #
def read_cpu_times() -> list[int]:
    with open("/proc/stat") as fh:
        return [int(v) for v in fh.readline().split()[1:]]


def read_procs() -> tuple[dict[str, list[int]], dict[str, str]]:
    """{pid: [cpu_ticks, rss_bytes]} plus a parallel {pid: name} map."""
    procs: dict[str, list[int]] = {}
    names: dict[str, str] = {}
    for path in glob.iglob("/proc/[0-9]*"):
        pid = path.rsplit("/", 1)[1]
        try:
            with open(f"{path}/stat", "rb") as fh:
                data = fh.read()
            close = data.rfind(b")")
            comm = data[data.index(b"(") + 1:close].decode("utf-8", "replace")
            fields = data[close + 2:].split()
            ticks = int(fields[11]) + int(fields[12])
            with open(f"{path}/statm") as fh:
                pages = int(fh.read().split()[1])
        except (OSError, ValueError, IndexError):
            continue
        procs[pid] = [ticks, pages * PAGE_SIZE]
        names[pid] = comm
    return procs, names


def read_meminfo() -> dict[str, int]:
    mem: dict[str, int] = {}
    with open("/proc/meminfo") as fh:
        for line in fh:
            key, _, rest = line.partition(":")
            mem[key] = int(rest.split()[0]) * 1024
    return mem


def read_vram() -> tuple[int, int] | None:
    # AMD exposes VRAM usage directly through the DRM device in bytes.
    for card in sorted(glob.glob("/sys/class/drm/card*/device")):
        used_p = os.path.join(card, "mem_info_vram_used")
        total_p = os.path.join(card, "mem_info_vram_total")
        if os.path.exists(used_p) and os.path.exists(total_p):
            try:
                with open(used_p) as fh_u, open(total_p) as fh_t:
                    used, total = int(fh_u.read()), int(fh_t.read())
                if used >= 0 and total > 0:
                    return used, total
            except (OSError, ValueError):
                continue

    # NVIDIA reports memory in MiB; convert it to the same byte units as AMD.
    # A broken or absent driver must not block or break the rest of the widget.
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=1.5,
        )
    except (OSError, subprocess.SubprocessError):
        return None

    for line in result.stdout.splitlines():
        try:
            used, total = (int(value.strip()) for value in line.split(","))
        except ValueError:
            continue
        if used >= 0 and total > 0:
            return used * (1 << 20), total * (1 << 20)
    return None


# --------------------------------------------------------------------------- #
# snapshot / deltas
# --------------------------------------------------------------------------- #
def load_state() -> dict | None:
    try:
        with open(STATE) as fh:
            state = json.load(fh)
        if isinstance(state.get("cpu"), list) and isinstance(state.get("procs"), dict):
            return state
    except (OSError, ValueError):
        pass
    return None


def save_state(state: dict) -> None:
    tmp = f"{STATE}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w") as fh:
            json.dump(state, fh)
        os.replace(tmp, STATE)
    except OSError:
        pass


def collect() -> dict:
    now = time.monotonic()
    cpu_now = read_cpu_times()
    procs_now, names = read_procs()

    state = load_state()
    if state is None:
        # No previous sample: take a short second one so the very first render
        # already shows real numbers instead of zeros/empties.
        time.sleep(0.15)
        state = {"cpu": cpu_now, "procs": procs_now, "time": now}
        cpu_now = read_cpu_times()
        procs_now, names = read_procs()
        now = time.monotonic()

    elapsed = max(now - state.get("time", now), 1e-6)
    if elapsed < MIN_WINDOW:
        time.sleep(MIN_WINDOW - elapsed)
        cpu_now = read_cpu_times()
        procs_now, names = read_procs()
        now = time.monotonic()
        elapsed = max(now - state.get("time", now), 1e-6)

    prev_cpu = state["cpu"]
    prev_procs = state["procs"]

    # system-wide cpu: idle + iowait count as idle
    def idle_of(times: list[int]) -> int:
        return times[3] + (times[4] if len(times) > 4 else 0)

    d_total = sum(cpu_now) - sum(prev_cpu)
    d_idle = idle_of(cpu_now) - idle_of(prev_cpu)
    cpu_pct = 0.0 if d_total <= 0 else max(0.0, min(100.0, 100.0 * (d_total - d_idle) / d_total))

    # per-process cpu %: ticks / elapsed / USER_HZ * 100
    rows = []
    for pid, (ticks, rss) in procs_now.items():
        prev = prev_procs.get(pid)
        if prev is None:
            continue
        delta = ticks - prev[0]
        if delta > 0:
            rows.append((100.0 * delta / (elapsed * USER_HZ), names.get(pid, "?")))
    rows.sort(reverse=True)
    cpu_top = [{"n": name, "v": f"{pct:.2f}%"} for pct, name in rows[:TOPN]]

    mem = read_meminfo()
    mem_used = (
        mem.get("MemTotal", 0)
        - mem.get("MemFree", 0)
        - mem.get("Buffers", 0)
        - mem.get("Cached", 0)
        - mem.get("SReclaimable", 0)
    )
    mem_rows = sorted(
        ((rss, names.get(pid, "?")) for pid, (_ticks, rss) in procs_now.items()),
        reverse=True,
    )
    mem_top = [{"n": name, "v": human(rss)} for rss, name in mem_rows[:TOPN]]

    swap_total = mem.get("SwapTotal", 0)
    swap_used = swap_total - mem.get("SwapFree", 0)

    disk = os.statvfs("/")
    disk_total = disk.f_blocks * disk.f_frsize
    disk_free = disk.f_bavail * disk.f_frsize
    disk_used = disk_total - disk_free

    vram = read_vram()
    if vram:
        vram_used, vram_total = vram
        vram_pct = 0 if not vram_total else round(100 * vram_used / vram_total)
        vram_text = f"{vram_used / (1 << 30):.1f}G"
    else:
        vram_pct, vram_text = 0, "n/a"

    save_state({"cpu": cpu_now, "procs": procs_now, "time": now})

    return {
        "cpu": {"pct": f"{cpu_pct:.0f}%", "top": cpu_top},
        "mem": {"used": human(mem_used), "top": mem_top},
        "swap": {"used": human(swap_used), "free": human(mem.get("SwapFree", 0))},
        "vram": {"pct": vram_pct, "text": vram_text},
        "disk": {"pct": 0 if not disk_total else round(100 * disk_used / disk_total),
                 "used": human(disk_used)},
        "uptime": uptime_short(),
        "kernel": platform.release(),
    }


FALLBACK = {
    "cpu": {"pct": "n/a", "top": []},
    "mem": {"used": "n/a", "top": []},
    "swap": {"used": "n/a", "free": "n/a"},
    "vram": {"pct": 0, "text": "n/a"},
    "disk": {"pct": 0, "used": "n/a"},
    "uptime": "n/a",
    "kernel": "n/a",
}


def main() -> None:
    try:
        payload = collect()
    except Exception:  # never let the widget see invalid JSON
        payload = FALLBACK
    print(json.dumps(payload, separators=(",", ":")))


if __name__ == "__main__":
    main()
