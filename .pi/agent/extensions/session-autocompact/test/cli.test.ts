/**
 * Isolated integration test against the installed Pi CLI.
 *
 * It runs the real extension in a throwaway agent directory with a dummy local
 * provider, so no credentials, no network, and no paid summarization are used:
 * only extension commands and session replacement are exercised. Skip it with
 * PI_AUTOCOMPACT_SKIP_CLI=1; it also skips itself when the bundled CLI is absent.
 * Both cases are reported as skipped tests, never as passing ones.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(testDir, "..");
const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");

const REQUEST_TIMEOUT_MS = 45_000;

function bundledCli(): string | undefined {
  const fromEnv = process.env.PI_AUTOCOMPACT_CLI;
  if (fromEnv) {
    return existsSync(fromEnv) ? fromEnv : undefined;
  }
  try {
    const version = readFileSync(join(agentDir, "install", "current-version"), "utf8").trim();
    if (!version) {
      return undefined;
    }
    const cli = join(
      agentDir,
      "install",
      "releases",
      version,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "bundle",
      "cli.js",
    );
    return existsSync(cli) ? cli : undefined;
  } catch {
    return undefined;
  }
}

/** Minimal line-delimited JSON-RPC client for `pi --mode rpc`. */
class RpcClient {
  #child: ChildProcessWithoutNullStreams;
  #buffer = "";
  #seq = 0;
  #stderr: string[] = [];
  #killed = false;

  notices: Record<string, unknown>[] = [];
  statusEvents: Record<string, unknown>[] = [];
  extensionErrors: Record<string, unknown>[] = [];

  constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr.push(chunk);
    });
  }

  stderrText(): string {
    return this.#stderr.join("");
  }

  async send(type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = String(++this.#seq);
    this.#child.stdin.write(`${JSON.stringify({ type, id, ...payload })}\n`);

    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const line = this.#takeLine();
      if (line !== undefined) {
        const message = this.#handle(JSON.parse(line), id);
        if (message !== undefined) {
          return message;
        }
        continue;
      }
      if (this.#child.exitCode !== null) {
        throw new Error(`Pi exited with code ${this.#child.exitCode}: ${this.stderrText()}`);
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
    }
    throw new Error(`timeout waiting for ${type}: ${this.stderrText()}`);
  }

  #takeLine(): string | undefined {
    const index = this.#buffer.indexOf("\n");
    if (index < 0) {
      return undefined;
    }
    const line = this.#buffer.slice(0, index);
    this.#buffer = this.#buffer.slice(index + 1);
    return line.trim() ? line : "";
  }

  #handle(message: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
    if (message.type === "extension_error") {
      this.extensionErrors.push(message);
      throw new Error(`extension_error: ${JSON.stringify(message)}`);
    }
    if (message.type === "extension_ui_request") {
      if (message.method === "notify") {
        this.notices.push(message);
      } else if (message.method === "setStatus") {
        this.statusEvents.push(message);
      }
      return undefined;
    }
    if (message.id === id && message.type === "response") {
      if (message.success !== true) {
        throw new Error(`${String(message.command)} failed: ${JSON.stringify(message.error ?? message)}`);
      }
      return (message.data as Record<string, unknown>) ?? {};
    }
    return undefined;
  }

  noticeText(): string {
    return this.notices.map((notice) => String(notice.message ?? "")).join("\n");
  }

  /** Notices added since `index`, so an assertion cannot match an earlier reply. */
  noticeTextFrom(index: number): string {
    return this.notices.slice(index).map((notice) => String(notice.message ?? "")).join("\n");
  }

  /** Poll get_state until no run is active. */
  async waitForIdle(deadlineMs = 30_000): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      const state = await this.send("get_state");
      if (state.isStreaming !== true && (state.pendingMessageCount ?? 0) === 0 && state.isCompacting !== true) {
        return;
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
    }
    throw new Error(`the run did not settle: ${this.stderrText()}`);
  }

  close(): void {
    try {
      this.#child.stdin.end();
    } catch {
      // ignore
    }
    if (!this.#killed) {
      this.#killed = true;
      this.#child.kill("SIGTERM");
    }
  }
}

test("bundled CLI: /autocompact is session scoped, persisted, and never global", async (t) => {
  if (process.env.PI_AUTOCOMPACT_SKIP_CLI === "1") {
    t.skip("PI_AUTOCOMPACT_SKIP_CLI=1");
    return;
  }
  const cli = bundledCli();
  if (cli === undefined) {
    t.skip("the bundled Pi CLI was not found");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "pi-session-autocompact-"));
  const configDir = join(root, "config");
  const cwd = join(root, "workspace");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  const settingsPath = join(configDir, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        compaction: { enabled: false },
        retry: { enabled: false },
        defaultProvider: "autocompact-probe",
        defaultModel: "dummy",
        // Loaded the way an installed extension is loaded: a configured directory
        // that resolves to its index.ts, with the built-in MCP extension off.
        extensions: ["-builtin:mcp", extensionDir],
      },
      null,
      2,
    ),
  );

  // A local dummy provider keeps startup model resolution credential-free and
  // network-free; no prompt in this test reaches a model.
  const dummyProviderPath = join(root, "dummy-provider.ts");
  writeFileSync(
    dummyProviderPath,
    `import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";\n` +
      `export default function (pi: ExtensionAPI) {\n` +
      `  pi.registerProvider("autocompact-probe", {\n` +
      `    api: "openai-completions",\n` +
      `    baseUrl: "http://127.0.0.1:1",\n` +
      `    apiKey: "unused",\n` +
      `    models: [{ id: "dummy", name: "Dummy", reasoning: false, input: ["text"],\n` +
      `      contextWindow: 128000, maxTokens: 4096,\n` +
      `      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],\n` +
      `  });\n` +
      `}\n`,
  );

  // Test-only helper: /reload is not an RPC command, so reload is triggered
  // through ctx.reload() from a harness extension.
  const reloadHarnessPath = join(root, "reload-harness.ts");
  writeFileSync(
    reloadHarnessPath,
    `import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";\n` +
      `export default function (pi: ExtensionAPI) {\n` +
      `  pi.registerCommand("test-reload", {\n` +
      `    description: "internal: run ctx.reload() for the integration test",\n` +
      `    handler: async (_args, ctx) => { await ctx.reload(); },\n` +
      `  });\n` +
      `}\n`,
  );

  const child = spawn(
    process.execPath,
    [
      cli,
      "--mode",
      "rpc",
      "--offline",
      "-e",
      dummyProviderPath,
      "-e",
      reloadHarnessPath,
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-approve",
    ],
    {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        PI_CODING_AGENT_DIR: configDir,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        TERM: "dumb",
      },
    },
  );
  const rpc = new RpcClient(child);

  try {
    // 1. Default off with the global setting off, and the command is available.
    const initial = await rpc.send("get_state");
    assert.equal(initial.autoCompactionEnabled, false);
    const sessionId = String(initial.sessionId);
    const sessionFile = String(initial.sessionFile);
    assert.ok(sessionId && sessionFile, `expected a persisted session: ${JSON.stringify(initial)}`);

    const commands = (await rpc.send("get_commands")).commands as { name: string; sourceInfo?: { path?: string } }[];
    const autocompactCommands = commands.filter((command) => command.name.startsWith("autocompact"));
    assert.equal(autocompactCommands.length, 1, `expected exactly one /autocompact: ${JSON.stringify(autocompactCommands)}`);
    assert.equal(autocompactCommands[0].name, "autocompact", "a name suffix means it was loaded more than once");
    assert.ok(
      String(autocompactCommands[0].sourceInfo?.path ?? "").endsWith(join("session-autocompact", "index.ts")),
      `unexpected command source: ${JSON.stringify(autocompactCommands[0].sourceInfo)}`,
    );

    // 2. Status works with no arguments and reports the values it actually read.
    const status = await rpc.send("prompt", { message: "/autocompact status" });
    assert.equal(status.disposition, "handled");
    assert.match(rpc.noticeText(), /auto-compact: off for this session \([0-9a-f]{8}\) - no session setting; the settings disable it/);
    assert.match(rpc.noticeText(), /what Pi would use in this session \(effective\): off/);
    assert.match(rpc.noticeText(), /global compaction\.enabled: off \(this command never writes it/);
    assert.doesNotMatch(rpc.noticeText(), /unknown/);
    assert.doesNotMatch(rpc.noticeText(), /session setting recorded by this extension/);
    assert.equal((await rpc.send("get_state")).autoCompactionEnabled, false, "status changed nothing");

    // 3. on turns Pi's own native flag on for this session only.
    const on = await rpc.send("prompt", { message: "/autocompact on" });
    assert.equal(on.disposition, "handled");
    assert.equal((await rpc.send("get_state")).autoCompactionEnabled, true, "Pi's get_state disagrees");
    assert.match(rpc.noticeText(), /ON for this session only/);
    assert.match(rpc.noticeText(), /only this session \(\w{8}\) is affected/);
    assert.ok(
      rpc.statusEvents.some(
        (event) => event.method === "setStatus" && String(event.statusText ?? "").includes("auto-compact: on"),
      ),
      "no visible status was published when enabled",
    );

    // 3b. Status confirms the session value and the untouched global value.
    const beforeStatus = rpc.notices.length;
    assert.equal((await rpc.send("prompt", { message: "/autocompact status" })).disposition, "handled");
    const statusText = rpc.noticeTextFrom(beforeStatus);
    assert.match(statusText, /auto-compact: ON for this session only/);
    assert.match(statusText, /session setting recorded by this extension: on/);
    assert.match(statusText, /confirmed with the live Pi settings instance: yes/);
    assert.match(statusText, /what Pi would use in this session \(effective\): on/);
    assert.match(statusText, /global compaction\.enabled: off/);

    // 4. The setting is durable in the session as version + sessionId + enabled.
    const entries = (await rpc.send("get_entries")).entries as Record<string, unknown>[];
    const records = entries.filter((entry) => entry.customType === "session-autocompact");
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].data, { version: 2, sessionId, enabled: true, thresholdTokens: null });

    // 4b. Pi creates the session file only once the session holds a user or
    // assistant message, so send one prompt. The dummy provider points at a port
    // that refuses connections: the turn fails immediately, with no credentials,
    // network, retries, or paid tokens.
    const started = await rpc.send("prompt", { message: "reach the dummy provider" });
    assert.equal(started.disposition, "started");
    await rpc.waitForIdle();
    assert.ok(existsSync(sessionFile), `expected the session file to exist: ${sessionFile}`);

    // 5. /clone copies the parent's records into a new session id: default off.
    const cloned = await rpc.send("clone");
    assert.equal(cloned.cancelled, false);
    const cloneState = await rpc.send("get_state");
    assert.notEqual(String(cloneState.sessionId), sessionId);
    assert.equal(cloneState.autoCompactionEnabled, false, "a cloned session must not inherit the setting");
    const cloneEntries = (await rpc.send("get_entries")).entries as Record<string, unknown>[];
    assert.ok(
      cloneEntries.some(
        (entry) =>
          entry.customType === "session-autocompact" &&
          (entry.data as { sessionId?: string }).sessionId === sessionId,
      ),
      "expected the copied parent record in the cloned session",
    );
    assert.equal((await rpc.send("prompt", { message: "/autocompact status" })).disposition, "handled");
    assert.match(rpc.noticeText(), /skipped 1 record\(s\) belonging to other sessions/);

    // 6. A new session starts with no session setting and no leftover patch.
    await rpc.send("new_session");
    const fresh = await rpc.send("get_state");
    assert.notEqual(String(fresh.sessionId), sessionId);
    assert.equal(fresh.autoCompactionEnabled, false);
    const beforeFresh = rpc.notices.length;
    assert.equal((await rpc.send("prompt", { message: "/autocompact status" })).disposition, "handled");
    const freshText = rpc.noticeTextFrom(beforeFresh);
    assert.match(freshText, /off for this session \([0-9a-f]{8}\) - no session setting; the settings disable it/);
    assert.match(freshText, /global compaction\.enabled: off/);
    assert.doesNotMatch(freshText, /session setting recorded by this extension/);
    assert.doesNotMatch(freshText, /unknown/);

    // 7. Resuming the original session restores its setting.
    await rpc.send("switch_session", { sessionPath: sessionFile });
    const resumed = await rpc.send("get_state");
    assert.equal(String(resumed.sessionId), sessionId);
    assert.equal(resumed.autoCompactionEnabled, true, "the session setting was not restored on resume");
    assert.ok(
      rpc.statusEvents.filter((event) => event.method === "setStatus" && String(event.statusText ?? "").includes("auto-compact: on"))
        .length >= 2,
      "the restored session did not publish its status again",
    );

    // 8. /reload restores the session setting in the reloaded runtime.
    assert.equal((await rpc.send("prompt", { message: "/test-reload" })).disposition, "handled");
    await rpc.waitForIdle();
    const reloaded = await rpc.send("get_state");
    assert.equal(String(reloaded.sessionId), sessionId, "reload must stay in the same session");
    assert.equal(reloaded.autoCompactionEnabled, true, "the session setting was not restored after reload");

    // 9. off writes an explicit record and Pi's flag follows it.
    assert.equal((await rpc.send("prompt", { message: "/autocompact off" })).disposition, "handled");
    assert.equal((await rpc.send("get_state")).autoCompactionEnabled, false);
    const afterOff = (await rpc.send("get_entries")).entries as Record<string, unknown>[];
    const lastRecord = afterOff.filter((entry) => entry.customType === "session-autocompact").at(-1);
    assert.deepEqual(lastRecord?.data, { version: 2, sessionId, enabled: false, thresholdTokens: null });

    // 10. A bad argument changes nothing.
    assert.equal((await rpc.send("prompt", { message: "/autocompact sideways" })).disposition, "handled");
    assert.equal((await rpc.send("get_state")).autoCompactionEnabled, false);
    assert.match(rpc.noticeText(), /unknown argument: sideways/);

    // 10b. on <tokens> sets a session compaction limit that the real settings
    // instance applies to the current model (128k window -> trigger at 100k).
    const beforeLimit = rpc.notices.length;
    assert.equal((await rpc.send("prompt", { message: "/autocompact on 100k" })).disposition, "handled");
    assert.equal((await rpc.send("get_state")).autoCompactionEnabled, true);
    assert.match(rpc.noticeTextFrom(beforeLimit), /compaction limit for this session: 100k tokens/);
    const limitRecords = ((await rpc.send("get_entries")).entries as Record<string, unknown>[]).filter(
      (entry) => entry.customType === "session-autocompact",
    );
    assert.deepEqual(limitRecords.at(-1)?.data, { version: 2, sessionId, enabled: true, thresholdTokens: 100000 });

    // The limit survives /reload and Pi's threshold sits at the limit.
    assert.equal((await rpc.send("prompt", { message: "/test-reload" })).disposition, "handled");
    await rpc.waitForIdle();
    const beforeLimitStatus = rpc.notices.length;
    assert.equal((await rpc.send("prompt", { message: "/autocompact status" })).disposition, "handled");
    const limitStatus = rpc.noticeTextFrom(beforeLimitStatus);
    assert.match(limitStatus, /compaction limit for this session: 100k tokens \(100000\)/);
    assert.match(limitStatus, /Pi compacts once context exceeds: 100k tokens \(autocompact-probe\/dummy, 128k window\)/);
    assert.doesNotMatch(limitStatus, /WARNING/);

    // limit off clears it; the native trigger comes back (128000 - 16384).
    assert.equal((await rpc.send("prompt", { message: "/autocompact limit off" })).disposition, "handled");
    const beforeCleared = rpc.notices.length;
    assert.equal((await rpc.send("prompt", { message: "/autocompact status" })).disposition, "handled");
    const clearedStatus = rpc.noticeTextFrom(beforeCleared);
    assert.match(clearedStatus, /compaction limit: none for this session/);
    assert.match(clearedStatus, /Pi compacts once context exceeds: 111\.6k tokens/);

    // Bad limits change nothing.
    assert.equal((await rpc.send("prompt", { message: "/autocompact limit 12abc" })).disposition, "handled");
    assert.match(rpc.noticeText(), /invalid token count: 12abc/);
    assert.equal((await rpc.send("prompt", { message: "/autocompact limit 10" })).disposition, "handled");
    assert.match(rpc.noticeText(), /compaction limit must be at least 1k tokens/);

    // 11. Nothing global was written, and no helper file was loaded as an extension.
    assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).compaction.enabled, false);
    assert.deepEqual(rpc.extensionErrors, []);
    assert.doesNotMatch(
      rpc.stderrText(),
      /Failed to load extension|does not export a valid factory|session-autocompact\/(state|native-bridge)\.ts/,
    );
  } finally {
    rpc.close();
    for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt += 1) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 40));
    }
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
});
