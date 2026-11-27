/**
 * Two extension instances in one process must not share session state.
 *
 * The factory keeps its session preference per closure on purpose: the Pi SDK can
 * construct several runtimes in one process, and a module-level `live` would let
 * one session's `/autocompact on` leak into another session or be detached by
 * another session's shutdown. This test loads the real `index.ts` twice against
 * two mock ExtensionAPI objects with real `SettingsManager` instances, so it
 * checks the factory itself rather than a reimplementation of it.
 *
 * It skips itself (as a skipped test, not a passing one) when the installed Pi
 * package cannot be found.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(testDir, "..");
const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");

function installedPackage(): string | undefined {
  const fromEnv = process.env.PI_AUTOCOMPACT_PACKAGE;
  if (fromEnv) {
    return existsSync(join(fromEnv, "package.json")) ? resolve(fromEnv) : undefined;
  }
  try {
    const version = readFileSync(join(agentDir, "install", "current-version"), "utf8").trim();
    if (!version) {
      return undefined;
    }
    const pkg = join(
      agentDir,
      "install",
      "releases",
      version,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    return existsSync(join(pkg, "package.json")) ? pkg : undefined;
  } catch {
    return undefined;
  }
}

type Handler = (event: unknown, ctx: unknown) => void | Promise<void>;

interface Harness {
  sessionId: string;
  manager: {
    getSettings(): unknown;
    getCompactionEnabled(): boolean;
    getCompactionSettings?: () => { enabled?: boolean };
    getGlobalSettings(): unknown;
  };
  entries: Record<string, unknown>[];
  notices: string[];
  statusTexts: (string | undefined)[];
  pi: Record<string, unknown>;
  start: () => Promise<void>;
  shutdown: () => Promise<void>;
  run: (args: string) => Promise<void>;
  noticeText: () => string;
}

function harness(sessionId: string, SettingsManager: { inMemory(s?: object): Harness["manager"] }): Harness {
  const manager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const entries: Record<string, unknown>[] = [];
  const events = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => void | Promise<void> }>();
  const notices: string[] = [];
  const statusTexts: (string | undefined)[] = [];

  const ctx = {
    hasUI: true,
    ui: {
      notify: (text: string) => {
        notices.push(text);
      },
      setStatus: (_key: string, text?: string) => {
        statusTexts.push(text);
      },
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => entries,
    },
  };

  const pi = {
    on: (event: string, handler: Handler) => {
      events.set(event, handler);
      return () => {};
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => void | Promise<void> }) => {
      commands.set(name, options);
    },
    getSettings: () => manager.getSettings(),
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
  };

  return {
    sessionId,
    manager,
    entries,
    notices,
    statusTexts,
    pi,
    start: async () => {
      const handler = events.get("session_start");
      assert.ok(handler, "the extension did not register session_start");
      await handler({ reason: "startup" }, ctx);
    },
    shutdown: async () => {
      const handler = events.get("session_shutdown");
      assert.ok(handler, "the extension did not register session_shutdown");
      await handler({ reason: "quit" }, ctx);
    },
    run: async (args: string) => {
      const command = commands.get("autocompact");
      assert.ok(command, "the extension did not register /autocompact");
      await command.handler(args, ctx);
    },
    noticeText: () => notices.join("\n"),
  };
}

test("two extension instances in one process keep separate session settings", async (t) => {
  const pkg = installedPackage();
  if (pkg === undefined) {
    t.skip("the installed @earendil-works/pi-coding-agent package was not found");
    return;
  }

  // Load the real index.ts from a scratch directory that resolves the same
  // installed package, so the copy uses the same SettingsManager class.
  const dir = mkdtempSync(join(tmpdir(), "pi-session-autocompact-instances-"));
  for (const name of ["index.ts", "state.ts", "native-bridge.ts"]) {
    copyFileSync(join(extensionDir, name), join(dir, name));
  }
  mkdirSync(join(dir, "node_modules", "@earendil-works"), { recursive: true });
  symlinkSync(pkg, join(dir, "node_modules", "@earendil-works", "pi-coding-agent"), "dir");

  const runtime = await import(pathToFileURL(join(pkg, "dist", "index.js")).href);
  const copy = await import(pathToFileURL(join(dir, "index.ts")).href);
  const factory = copy.default as (pi: unknown) => void;
  assert.equal(typeof factory, "function", "index.ts does not export a factory");

  const a = harness("11111111-1111-4111-8111-111111111111", runtime.SettingsManager);
  const b = harness("22222222-2222-4222-8222-222222222222", runtime.SettingsManager);

  factory(a.pi);
  factory(b.pi);

  await a.start();
  await a.run("on");
  assert.equal(a.manager.getCompactionEnabled(), true, "instance A did not apply its session setting");

  await b.start();
  assert.equal(a.manager.getCompactionEnabled(), true, "B starting undid A's session setting");
  assert.equal(b.manager.getCompactionEnabled(), false, "B started with A's session setting");

  // B pins itself off; A keeps its own decision.
  await b.run("off");
  assert.equal(b.manager.getCompactionEnabled(), false);
  assert.equal(a.manager.getCompactionEnabled(), true, "B's choice changed A's");

  // B's teardown must not detach A's attachment.
  await b.shutdown();
  assert.equal(a.manager.getCompactionEnabled(), true, "B's session_shutdown detached A's override");
  assert.match(b.noticeText(), /OFF for this session only/);
  assert.equal(
    b.statusTexts.filter((text) => String(text ?? "").includes("auto-compact")).length,
    0,
    "a session pinned off published a persistent status",
  );

  await a.run("status");
  assert.match(a.noticeText(), /auto-compact: ON for this session only \(11111111\)/);
  assert.match(a.noticeText(), /what Pi would use in this session \(effective\): on/);
  assert.match(a.noticeText(), /global compaction\.enabled: off/);
  assert.match(a.noticeText(), /confirmed with the live Pi settings instance: yes/);
  assert.ok(
    a.statusTexts.some((text) => String(text ?? "").includes("auto-compact: on")),
    "instance A published no visible status",
  );

  await a.run("off");
  assert.equal(a.manager.getCompactionEnabled(), false);
  assert.equal(b.manager.getCompactionEnabled(), false);

  await a.shutdown();
  assert.equal(a.manager.getCompactionEnabled(), false, "A left its override on its settings instance");
});
