/**
 * No System Pip — block `pip install --break-system-packages` and other
 * system-wide Python installs, steer agents toward `uv` + venv.
 *
 * Scope (broad, hard-block):
 *  - always: --break-system-packages (pip / uv / python -m pip)
 *  - always: UV_BREAK_SYSTEM_PACKAGES=1 / PIP_BREAK_SYSTEM_PACKAGES=1 env bypass
 *  - always: sudo pip / sudo python -m pip / sudo uv pip
 *  - always: `uv pip install --system` / `uv pip sync --system`
 *  - broad: bare `pip install` / `python -m pip install` outside a venv
 *           (allowed when $VIRTUAL_ENV is active or the command clearly
 *            references a venv, e.g. `.venv/bin/pip`, `source .venv/bin/activate`)
 *
 * Allowed (by design):
 *  - `uv venv`, `uv run`, `uv run --with <pkg>`, plain `uv pip install`
 *    (uv resolves to a project venv, not system python, unless --system)
 *  - `pip install` *inside* an activated venv
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const UV_GUIDANCE = [
  "Blocked: system-wide pip install is disabled on this machine.",
  "",
  "Never use --break-system-packages, sudo pip, or bare `pip install` outside a venv.",
  "It writes to /usr/lib/python*/site-packages and breaks pacman-managed packages.",
  "",
  "Use uv instead:",
  "  uv venv .venv && source .venv/bin/activate && uv pip install <pkg>",
  "  # or one-shot without activating:",
  "  uv run --with <pkg> script.py",
  "  # or if a .venv already exists, reuse it:",
  "  source .venv/bin/activate && uv pip install <pkg>",
].join("\n");

function hasVenvIndicator(command: string): boolean {
  return (
    /\.venv\b/.test(command) ||
    /\/venv\//.test(command) ||
    /\bVIRTUAL_ENV\b/.test(command) ||
    /\bactivate\b/.test(command) ||
    /--python\s+\S*\.?venv/i.test(command) ||
    /\bUV_PYTHON\s*=/i.test(command)
  );
}

function pipInstallPattern(command: string): boolean {
  // pip / pip3 / pip3.14 install ...
  if (/\bpip3?\b(?:\s*\S+)?\s+.*\binstall\b/i.test(command)) return true;
  // python [-m] pip install ... (covers python, python3, /usr/bin/python3, .venv/bin/python)
  if (/\bpython\d*(?:\.\d+)?\b\s+-m\s+pip\b.*\binstall\b/i.test(command)) return true;
  return false;
}

function checkCommand(command: string): string | null {
  const hasPipOrUv =
    /\bpip\b/i.test(command) || /\buv\b/i.test(command) || /\bpython\b/i.test(command);

  // 1. Explicit --break-system-packages with pip/uv/python context
  if (/--break-system-packages/i.test(command) && hasPipOrUv) {
    return "flag `--break-system-packages` detected";
  }

  // 2. Env-var bypasses: PIP_BREAK_SYSTEM_PACKAGES=1 / UV_BREAK_SYSTEM_PACKAGES=1 / UV_SYSTEM_PYTHON=1
  if (
    /(PIP_BREAK_SYSTEM_PACKAGES|UV_BREAK_SYSTEM_PACKAGES)\s*=\s*1/i.test(command) ||
    /UV_SYSTEM_PYTHON\s*=\s*1/i.test(command)
  ) {
    return "env bypass for system packages detected";
  }

  // 3. sudo pip / sudo uv pip
  if (/\bsudo\b.*\b(pip|uv\s+pip)\b/i.test(command)) {
    return "`sudo` + pip detected";
  }

  // 4. uv pip --system (install or sync)
  if (/\buv\s+pip\s+(install|sync)\b/i.test(command) && /\B--system\b/.test(command)) {
    return "`uv pip --system` detected";
  }

  // 5. uv pip with explicit system interpreter
  if (
    /\buv\s+pip\s+(install|sync)\b/i.test(command) &&
    /--python\s+\S*\/usr\/bin\/python/i.test(command)
  ) {
    return "`uv pip` targeting /usr/bin/python detected";
  }

  // 6. pip --target / --prefix pointing at system paths
  if (
    hasPipOrUv &&
    /--(target|prefix)\s*=?\s*["']?\/usr/i.test(command)
  ) {
    return "pip --target/--prefix into /usr detected";
  }

  // 7. Bare pip install outside a venv (`uv pip` handled above — plain
  // `uv pip install` without --system resolves to a project venv, allow it)
  if (/\buv\s+pip\b/i.test(command)) return null;
  if (pipInstallPattern(command)) {
    // Inside an activated venv (pi inherited $VIRTUAL_ENV) bare pip is safe —
    // PIP_REQUIRE_VIRTUALENV would allow it too. Only the patterns above
    // (--break-system-packages, --system, sudo) stay blocked there.
    if (process.env.VIRTUAL_ENV) return null;
    // Command that clearly provisions/uses a venv is fine.
    if (hasVenvIndicator(command)) return null;
    return "bare `pip install` outside a virtualenv detected";
  }

  return null;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("bash", event)) return undefined;

    const command = event.input.command as string | undefined;
    if (!command || typeof command !== "string") return undefined;

    const hit = checkCommand(command);
    if (hit) {
      return {
        block: true,
        reason: `${UV_GUIDANCE}\n\n( matched: ${hit} )`,
      };
    }

    return undefined;
  });
}
