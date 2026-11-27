// @ts-nocheck
/**
 * Pi workers in classic Herdr tabs or Herdr App/Core terminals.
 *
 * Two surfaces, one extension:
 * - The `subagent` tool registers the complete agent-facing interface:
 *   spawn / prompt / wait / status / read / close / interrupt. It starts an
 *   interactive Pi terminal, submits the prompt, and returns a handle.
 * - The listener sends completion notifications for this session's workers
 *   and renders a live "N running" widget above the editor. It also tracks workers spawned
 *   through the manual bash fallback (skill/manual.md) too.
 *
 * Design notes:
 * - Classic uses the session tag in each worker's name and pane events. Core identifies
 *   workers by their owner session label and parent terminal.
 * - When a turn settles it reads the worker's session JSONL
 *   and injects a notification with
 *   `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`,
 *   which wakes an idle parent. Tool calls waiting on a worker are resolved
 *   instead of notified.
 * - A blocking wait (`wait`, `prompt wait:true`, `spawn background:false`)
 *   releases early when an inbound message is queued for the parent: pi drains
 *   steering input only once the current tool-call batch finishes, so holding
 *   the wait would hold the message. See `createMessageInterruptController`.
 * - While a self-compaction is scheduled (`self-compaction:hold`), those
 *   notifications are held and flushed as plain transcript entries after the
 *   navigation: a follow-up in that window would keep the parent's run alive
 *   and prevent `agent_settled`, so the compaction would never dispatch.
 * - The command-text heuristic only suppresses duplicate notifications for the
 *   manual bash path (`herdr agent prompt --wait` / `herdr agent wait`).
 */

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { createCoreBackend } from "./core.ts";
import {
  buildPiFlags,
  capText,
  closeNudgeText,
  collectWorkerTree,
  createHoldController,
  createMessageInterruptController,
  describeUsage,
  extractLastTurn,
  formatCleanupLine,
  modelRef,
  parseAgentMarkdown,
  parseJsonlEntries,
  resolveSpawnConfig,
  sessionIdFromPath,
  uniqueWorkerName,
  workerLabel,
  workerSessionTag,
} from "./lib.ts";

const execFileAsync = promisify(execFile);

const HERDR_ENV = process.env.HERDR_ENV;
const SOCKET_PATH = process.env.HERDR_SOCKET_PATH;
const HERDR_WORKSPACE_ID = process.env.HERDR_WORKSPACE_ID;
const HERDR_BIN = process.env.HERDR_BIN_PATH || "herdr";
const SOCKET_ENDPOINT =
  process.platform === "win32" && SOCKET_PATH
    ? `\\\\.\\pipe\\${SOCKET_PATH}`
    : SOCKET_PATH;

const SETTLE_DEBOUNCE_MS = 500;
// How often a blocking wait checks for inbound messages that should release it.
const MESSAGE_POLL_MS = 200;
// How long one observed steer may still release a wait. Bounds the damage if a
// token outlives the message it came from; see createMessageInterruptController.
const MESSAGE_TOKEN_TTL_MS = 10_000;
const RESULT_TAIL_BYTES = 1 << 20; // 1 MiB
const SUMMARY_MAX = 700;
const FOREGROUND_GRACE_MS = 3000;
const RECONNECT_MS = 2000;
const WIDGET_KEY = "herdr-subagents";
const WIDGET_TICK_MS = 1000;
const RECENT_MS = 60_000;
const WIDGET_MAX_ROWS = 8;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Coordination with the self-compaction extension: it emits this channel while a
// `self_compact` request is scheduled but has not navigated yet.
const HOLD_CHANNEL = "self-compaction:hold";
const HOLD_TTL_MS = 120_000;
const HOLD_MAX_QUEUE = 50;
const CLEANUP_MAX = 5;

const MAX_CONCURRENT_DEFAULT = 4;
const MAX_DEPTH_DEFAULT = 2;
const DEFAULT_WAIT_MS = 600_000;
const MAX_WAIT_MS = 900_000;
const START_TIMEOUT_MS = 90_000;

function agentDir() {
  return (
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")
  );
}

export default function (pi) {
  const core = createCoreBackend();
  if (!core && (HERDR_ENV !== "1" || !SOCKET_PATH)) {
    return;
  }

  let sessionTag = "";
  let owner = "";
  let publishedSession;
  let publishQueue = Promise.resolve();
  let socket = null;
  let connected = false;
  let reconnectTimer = null;
  let buffer = "";
  let shuttingDown = false;
  let ui = null;
  let widgetTimer = null;
  let resyncTimer = null;

  /** paneId -> worker state */
  const workers = new Map();
  /** paneIds currently being resolved via `herdr agent get` */
  const registering = new Set();
  const classicPaneSockets = new Map();
  /** worker name -> { toolCallIds } for manual-bash foreground waits */
  const foregroundWaits = new Map();
  /** worker name -> Set<resolve> for tool calls blocking on a settle */
  const waiters = new Map();
  /** in-flight tool spawns (counted against the concurrency cap) */
  let spawning = 0;
  const spawningNames = new Set();
  /** holds notifications while a self-compaction is pending; see HOLD_CHANNEL */
  const hold = createHoldController({
    send: (message) => pi.sendMessage(message, { triggerTurn: false }),
    defaultTtlMs: HOLD_TTL_MS,
    maxQueue: HOLD_MAX_QUEUE,
  });

  // ---------------------------------------------------------------- herdr CLI

  async function herdrExec(args, timeout = 30000) {
    try {
      const { stdout, stderr } = await execFileAsync(HERDR_BIN, args, {
        timeout,
        encoding: "utf8",
      });
      let doc = null;
      try {
        doc = JSON.parse(stdout);
      } catch {
        // non-JSON output is fine for some commands
      }
      return { ok: true, stdout, stderr, doc };
    } catch (err) {
      const stdout = err && err.stdout ? String(err.stdout) : "";
      const stderr = err && err.stderr ? String(err.stderr) : "";
      let doc = null;
      try {
        doc = JSON.parse(stdout);
      } catch {
        // no structured error
      }
      return {
        ok: false,
        stdout,
        stderr,
        doc,
        message: (err && err.message) || "herdr command failed",
      };
    }
  }

  function herdrErrorText(res) {
    if (res && res.doc && res.doc.error) {
      const e = res.doc.error;
      return `${e.code || "error"}${e.message ? `: ${e.message}` : ""}`;
    }
    return (
      (res && (res.stderr || res.stdout || res.message)) || "unknown herdr error"
    );
  }

  async function herdrJson(args) {
    const res = await herdrExec(args, 8000);
    return res.ok ? res.doc : null;
  }

  async function paneTail(paneId, lines = 25) {
    const res = await herdrExec(
      [
        "pane",
        "read",
        String(paneId),
        "--source",
        "recent-unwrapped",
        "--lines",
        String(lines),
      ],
      8000,
    );
    return (res.stdout || "").trim().split("\n").slice(-lines).join("\n");
  }

  async function agentGet(target) {
    if (core) return core.get(target).catch(() => null);
    const doc = await herdrJson(["agent", "get", String(target)]);
    return doc && doc.result && doc.result.agent ? doc.result.agent : null;
  }

  async function agentList() {
    if (core) return core.list();
    const doc = await herdrJson(["agent", "list"]);
    return doc?.result?.agents || null;
  }

  function workerTree(agents, root) {
    if (core) return owner ? core.tree(agents || [], root ? null : owner, root) : [];
    return collectWorkerTree(agents || [], sessionTag);
  }

  function isOwned(info) {
    if (!owner || !info?.name) return false;
    if (core) return info.owner === owner && info.parent === core.parent;
    return Boolean(workerLabel(info.name, sessionTag));
  }

  // ------------------------------------------------------------------- socket

  function globalSubscriptions() {
    return [
      { type: "pane.agent_detected" },
      { type: "pane.closed" },
      { type: "pane.exited" },
    ];
  }

  function send(obj) {
    if (!socket || !connected) {
      return;
    }
    try {
      socket.write(JSON.stringify(obj) + "\n");
    } catch {
      // connection teardown is handled by the close event
    }
  }

  function sendSubscribe(subscriptions, id) {
    if (!subscriptions.length) {
      return;
    }
    send({
      id: id || `hd-sub-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      method: "events.subscribe",
      params: { subscriptions },
    });
  }

  function sendPaneSubscribe(paneId) {
    if (core || shuttingDown || classicPaneSockets.has(paneId)) return;
    // Classic Herdr treats a subscription as the last request on its socket.
    const stream = net.createConnection(SOCKET_ENDPOINT);
    classicPaneSockets.set(paneId, stream);
    stream.setEncoding("utf8");
    let pending = "";
    stream.on("connect", () => stream.write(JSON.stringify({
      id: `hd-pane:${paneId}`,
      method: "events.subscribe",
      params: { subscriptions: [{ type: "pane.agent_status_changed", pane_id: paneId }] },
    }) + "\n"));
    stream.on("data", (chunk) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop();
      for (const line of lines) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.error?.code === "pane_not_found") removeWorker(paneId);
        else if (msg.event) handleEvent(msg.event, msg.data || {});
      }
    });
    stream.on("error", () => {});
    stream.on("close", () => {
      if (classicPaneSockets.get(paneId) === stream) classicPaneSockets.delete(paneId);
    });
  }

  function closePaneSubscription(paneId) {
    const stream = classicPaneSockets.get(paneId);
    if (!stream) return;
    classicPaneSockets.delete(paneId);
    stream.destroy();
  }

  function subscribeAll() {
    if (core) {
      send({ jsonrpc: "2.0", id: "core-events", method: "events.subscribe", params: core.subscription });
      return;
    }
    sendSubscribe(globalSubscriptions());
    for (const paneId of workers.keys()) {
      sendPaneSubscribe(paneId);
    }
  }

  function connect() {
    if (shuttingDown) {
      return;
    }
    if (socket && !socket.destroyed) {
      return;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const s = net.createConnection(core?.endpoint || SOCKET_ENDPOINT);
    socket = s;
    buffer = "";
    s.setEncoding("utf8");
    s.on("connect", () => {
      connected = true;
      subscribeAll();
    });
    s.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) {
          continue;
        }
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (core) {
          handleCoreMessage(msg, s);
        } else if (msg && msg.event) {
          handleEvent(String(msg.event), msg.data || {});
        }
      }
    });
    s.on("error", () => {});
    s.on("close", () => {
      if (socket === s) {
        socket = null;
        connected = false;
      }
      if (!shuttingDown) {
        // Reconcile any workers whose status changed while the stream was down.
        if (owner) {
          void resyncWorkers();
        }
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, RECONNECT_MS);
          if (reconnectTimer.unref) {
            reconnectTimer.unref();
          }
        }
      }
    });
  }

  function handleCoreMessage(message, connection) {
    if (message?.id === "core-events") {
      if (message.error) connection.destroy();
      else syncWorkers((message.result?.terminals || []).map(core.worker));
      return;
    }
    if (message?.method === "missed") {
      const snapshot = message.params?.terminals;
      if (Array.isArray(snapshot)) syncWorkers(snapshot.map(core.worker));
      else void resyncWorkers();
      return;
    }
    if (message?.method !== "event") return;
    const { type, terminal, data } = message.params;
    if (type === "created") {
      const info = core.worker(data);
      if (isOwned(info)) track(info);
    } else if (type === "status" && typeof data?.status?.state === "string") {
      onStatusChanged(terminal, data.status.state);
    } else if (["finished", "removed", "lost"].includes(type)) {
      removeWorker(terminal);
    }
  }

  function removeWorker(paneId) {
    const w = workers.get(paneId);
    if (!w) {
      return;
    }
    if (w.settleTimer) {
      clearTimeout(w.settleTimer);
    }
    closePaneSubscription(paneId);
    workers.delete(paneId);
    resolveWaiters(w.name, {
      status: "removed",
      info: null,
      sessionPath: undefined,
      result: null,
      durationMs: null,
      removed: true,
    });
    renderWidget();
  }

  function handleEvent(name, data) {
    const type = data.type || name;
    switch (type) {
      case "pane_agent_detected":
      case "pane.agent_detected":
        void onAgentDetected(data.pane_id, data.agent, Boolean(data.released));
        break;
      case "pane.agent_status_changed":
      case "pane_agent_status_changed":
        onStatusChanged(data.pane_id, data.agent_status);
        break;
      case "pane_closed":
      case "pane.closed":
      case "pane_exited":
      case "pane.exited": {
        const paneId = data.pane_id || (data.pane && data.pane.pane_id);
        if (paneId) {
          removeWorker(paneId);
        }
        break;
      }
    }
  }

  // ---------------------------------------------------------------- discovery

  async function onAgentDetected(paneId, agentKind, released) {
    if (!paneId || released) {
      return;
    }
    if (agentKind && agentKind !== "pi") {
      return;
    }
    if (workers.has(paneId) || registering.has(paneId)) {
      return;
    }
    registering.add(paneId);
    try {
      // Name registration can race the detection event; retry briefly.
      for (let attempt = 0; attempt < 5; attempt++) {
        const info = await agentGet(paneId);
        if (info && info.name) {
          if (isOwned(info) && (!info.agent || info.agent === "pi")) {
            registerWorker(paneId, info.name, null, info.agent_status || "idle");
          }
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      registering.delete(paneId);
    }
  }

  /**
   * Reconcile tracked workers with herdr's live agent list. This is the
   * safety net for events we can never receive: pane.closed/pane.exited do not
   * fire for tab closes, and a silently dead socket misses everything. Runs on
   * session start and on a slow timer.
   */
  async function resyncWorkers() {
    const requestedOwner = owner;
    const agents = await agentList().catch(() => null);
    if (agents && requestedOwner === owner && !shuttingDown) syncWorkers(agents);
  }

  function track(info) {
    const w = registerWorker(info.pane_id, info.name, info.tab_id, info.agent_status || "idle");
    w.tabId = info.tab_id || w.tabId;
    w.spaceId = info.space_id || w.spaceId;
    if (core || info.agent_session?.value) w.sessionPath = info.agent_session?.value;
    w.leaf = info.leaf ?? w.leaf;
    return w;
  }

  function syncWorkers(agents) {
    const live = new Map();
    for (const a of agents) {
      if (!a || a.agent !== "pi" || !a.pane_id || !isOwned(a)) continue;
      live.set(a.pane_id, a);
    }
    for (const paneId of [...workers.keys()]) {
      if (!live.has(paneId) && !spawningNames.has(workers.get(paneId).name)) {
        removeWorker(paneId);
      }
    }
    for (const [paneId, a] of live) {
      const w = track(a);
      sendPaneSubscribe(paneId);
      if (a.agent_status && a.agent_status !== w.status) {
        // Event was missed (dead socket, reload, race): replay it through the
        // normal path so settle notifications still fire exactly once.
        onStatusChanged(paneId, a.agent_status);
      }
    }
  }

  // --------------------------------------------------- self-compaction hold

  const unsubscribeHold = pi.events.on(HOLD_CHANNEL, (data) => {
    hold.onEvent(data);
  });

  // ------------------------------------------------ inbound-message release

  const interrupts = createMessageInterruptController({
    tokenTtlMs: MESSAGE_TOKEN_TTL_MS,
  });

  // Observational only: returning "continue" leaves the message untouched, and
  // transforms from other extensions still chain.
  pi.on("input", (event) => {
    interrupts.observe({
      streamingBehavior: event && event.streamingBehavior,
      text: event && event.text,
    });
    return { action: "continue" };
  });

  pi.on("agent_start", () => {
    // A steer seen during an earlier run has already been delivered; do not let
    // it arm a release in this one.
    interrupts.reset();
  });

  // ------------------------------------------------- status tracking & notify

  function onStatusChanged(paneId, status) {
    const w = workers.get(paneId);
    if (!w || w.status === status) {
      return;
    }
    w.status = status;
    w.lastChange = Date.now();
    renderWidget();
    if (status === "working") {
      w.sawWorking = true;
      w.nudgedClose = false;
      w.workingSince = Date.now();
      if (w.settleTimer) {
        clearTimeout(w.settleTimer);
        w.settleTimer = null;
      }
      return;
    }
    scheduleSettle(w);
  }

  function settled(status) {
    return status === "done" || status === "idle" ||
      Boolean(core && (status === "blocked" || status === "error"));
  }

  function scheduleSettle(w) {
    if (!w.sawWorking || !settled(w.status) || w.submitting) {
      return;
    }
    if (w.settleTimer) {
      return;
    }
    w.settleTimer = setTimeout(() => {
      w.settleTimer = null;
      void notifySettled(w, w.paneId);
    }, SETTLE_DEBOUNCE_MS);
    if (w.settleTimer.unref) {
      w.settleTimer.unref();
    }
  }

  async function notifySettled(w, paneId) {
    if (w.submitting || !w.sawWorking || !settled(w.status)) return;
    w.sawWorking = false;
    const info = await agentGet(paneId);
    if (shuttingDown || workers.get(paneId) !== w || w.sawWorking) return;
    if (info) track(info);
    const sessionPath = w.sessionPath;
    const result = sessionPath ? readLastAssistant(sessionPath) : null;
    const durationMs = w.workingSince ? Date.now() - w.workingSince : null;
    const outcome = {
      status: (info && info.agent_status) || w.status || "done",
      info,
      sessionPath,
      result,
      durationMs,
    };
    if (resolveWaiters(w.name, outcome)) {
      // A tool call is blocking on this settle and reports the result inline.
      return;
    }
    if (foregroundWaits.has(w.name)) {
      // The parent is already blocking on this worker (manual bash --wait /
      // agent wait); it receives the result inline, so skip the notification.
      foregroundWaits.delete(w.name);
      return;
    }
    const content = formatNotification(
      w.name,
      paneId,
      info,
      sessionPath,
      result,
      durationMs,
    );
    const message = {
      customType: "herdr-worker-notification",
      content,
      display: true,
      details: {
        name: w.name,
        paneId,
        tabId: info && info.tab_id,
        sessionPath,
        durationMs,
        usage: result && result.usage,
        lastTextAt: result && result.lastTextAt,
      },
    };
    if (hold.push({ name: w.name, message })) {
      return;
    }
    try {
      pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
    } catch {
      // never let notification delivery break the session
    }
  }

  function readLastAssistant(file) {
    try {
      const size = fs.statSync(file).size;
      const start = Math.max(0, size - RESULT_TAIL_BYTES);
      const length = size - start;
      if (length <= 0) {
        return null;
      }
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(length);
      try {
        fs.readSync(fd, buf, 0, length, start);
      } finally {
        fs.closeSync(fd);
      }
      let text = buf.toString("utf8");
      if (start > 0) {
        const nl = text.indexOf("\n");
        if (nl >= 0) {
          text = text.slice(nl + 1);
        }
      }
      const lines = text.split("\n");
      const { summary, usage, lastTextAt, stopReason } = extractLastTurn(
        parseJsonlEntries(lines),
      );
      return { summary, usage, lastTextAt, stopReason };
    } catch {
      return null;
    }
  }

  /** Full names of tracked workers that are settled and still open. */
  function openSettledNames(exclude) {
    return [...workers.values()]
      .filter(
        (w) =>
          w.name !== exclude &&
          // workingSince > 0: the worker has actually run at least once, so a
          // freshly spawned, not-yet-started sibling is not listed.
          w.workingSince &&
          !w.sawWorking &&
          (w.status === "done" || w.status === "idle"),
      )
      .map((w) => w.name);
  }

  function formatNotification(name, paneId, info, sessionPath, result, durationMs) {
    const lines = ["<task-notification>"];
    const attrs = [
      `worker="${name}"`,
      `status="${info?.agent_status || workers.get(paneId)?.status || "done"}"`,
      `${core ? "terminal" : "pane"}="${paneId}"`,
    ];
    if (info && info.tab_id) {
      attrs.push(`tab="${info.tab_id}"`);
    }
    if (durationMs != null) {
      attrs.push(`duration="${(durationMs / 1000).toFixed(1)}s"`);
    }
    lines.push(`  <worker ${attrs.join(" ")}/>`);
    if (result && result.summary) {
      const body =
        result.summary.length > SUMMARY_MAX
          ? `${result.summary.slice(0, SUMMARY_MAX)}…`
          : result.summary;
      const at = result.lastTextAt ? ` at="${result.lastTextAt}"` : "";
      lines.push(`  <summary${at}>`);
      lines.push(
        body
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n"),
      );
      lines.push("  </summary>");
    } else {
      lines.push(
        "  <summary>(no assistant text after the last prompt; the run may have ended on tool calls - read the transcript or terminal output)</summary>",
      );
    }
    if (result && result.stopReason) {
      lines.push(`  <run stopReason="${result.stopReason}"/>`);
    }
    const u = result && result.usage;
    if (u) {
      const cost =
        u.cost && u.cost.total != null ? u.cost.total.toFixed(4) : "?";
      lines.push(
        `  <usage input="${u.input ?? "?"}" output="${u.output ?? "?"}" total="${u.totalTokens ?? "?"}" cost="${cost}"/>`,
      );
    }
    if (sessionPath) {
      lines.push(`  <transcript path="${sessionPath}"/>`);
    }
    const open = openSettledNames(name);
    const cleanup = formatCleanupLine(open, CLEANUP_MAX);
    if (cleanup) {
      lines.push(cleanup);
    }
    lines.push(
      "  <note>If you already received this worker's result inline (foreground --wait), ignore this notification.</note>",
    );
    lines.push("</task-notification>");
    return lines.join("\n");
  }

  // ------------------------------------------------------------ status widget

  function shortName(name) {
    return workerLabel(name, sessionTag) || name;
  }

  function renderWidget() {
    if (!ui) {
      return;
    }
    const now = Date.now();
    const entries = [];
    for (const w of workers.values()) {
      if (
        w.status === "working" ||
        w.status === "blocked" ||
        now - (w.lastChange || 0) < RECENT_MS
      ) {
        entries.push(w);
      }
    }
    if (entries.length === 0) {
      try {
        ui.setWidget(WIDGET_KEY, undefined);
      } catch {
        // stale UI context after a reload; nothing to clear
      }
      stopWidgetLoop();
      return;
    }
    const rank = (w) =>
      w.status === "working" ? 0 : w.status === "blocked" ? 1 : 2;
    entries.sort(
      (a, b) => rank(a) - rank(b) || (b.lastChange || 0) - (a.lastChange || 0),
    );
    const count = (s) => entries.filter((w) => w.status === s).length;
    const parts = [`${count("working")} running`];
    if (count("blocked")) {
      parts.push(`${count("blocked")} blocked`);
    }
    if (count("idle")) {
      parts.push(`${count("idle")} idle`);
    }
    if (count("done")) {
      parts.push(`${count("done")} done`);
    }
    const lines = [`● Subagents · ${parts.join(" · ")}`];
    const shown = entries.slice(0, WIDGET_MAX_ROWS);
    shown.forEach((w, i) => {
      const branch = i === shown.length - 1 ? "└─" : "├─";
      let icon = "○";
      if (w.status === "working") {
        icon = SPINNER[Math.floor(now / 120) % SPINNER.length];
      } else if (w.status === "blocked") {
        icon = "⚠";
      } else if (w.status === "done") {
        icon = "✓";
      } else if (w.status === "unknown") {
        icon = "?";
      }
      let suffix = "";
      if (w.status === "working" && w.workingSince) {
        suffix = `  ${Math.max(0, Math.round((now - w.workingSince) / 1000))}s`;
      }
      lines.push(`${branch} ${icon} ${shortName(w.name)}${suffix}`);
    });
    if (entries.length > shown.length) {
      lines.push(`   +${entries.length - shown.length} more`);
    }
    try {
      ui.setWidget(WIDGET_KEY, lines);
    } catch {
      // stale UI context after a reload; the next session_start recaptures ui
    }
    ensureWidgetLoop();
  }

  function ensureWidgetLoop() {
    if (widgetTimer) {
      return;
    }
    widgetTimer = setInterval(renderWidget, WIDGET_TICK_MS);
    if (widgetTimer.unref) {
      widgetTimer.unref();
    }
  }

  function stopWidgetLoop() {
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = null;
    }
  }

  // ------------------------------------------- foreground suppression heuristic

  pi.on("tool_call", (event, ctx) => {
    if (ctx && ctx.ui && ctx.ui !== ui) {
      ui = ctx.ui;
      renderWidget();
    }
    if (core || !event || event.toolName !== "bash") {
      return;
    }
    const cmd = event.input && event.input.command;
    if (typeof cmd !== "string") {
      return;
    }
    if (!/herdr\s+agent\s+(prompt|wait)\b/.test(cmd)) {
      return;
    }
    const isWait = /--wait\b/.test(cmd) || /herdr\s+agent\s+wait\b/.test(cmd);
    if (!isWait) {
      return;
    }
    for (const w of workers.values()) {
      if (!w.name || !cmd.includes(w.name)) {
        continue;
      }
      let entry = foregroundWaits.get(w.name);
      if (!entry) {
        entry = { toolCallIds: new Set() };
        foregroundWaits.set(w.name, entry);
      }
      entry.toolCallIds.add(event.toolCallId);
    }
  });

  pi.on("tool_result", (event) => {
    if (!event || event.toolName !== "bash" || !event.toolCallId) {
      return;
    }
    for (const [name, entry] of foregroundWaits) {
      if (!entry.toolCallIds.has(event.toolCallId)) {
        continue;
      }
      // Keep suppression alive just past the settle debounce, then release so
      // a timed-out wait cannot swallow a later background notification.
      const timer = setTimeout(() => {
        entry.toolCallIds.delete(event.toolCallId);
        if (entry.toolCallIds.size === 0) {
          foregroundWaits.delete(name);
        }
      }, FOREGROUND_GRACE_MS);
      if (timer.unref) {
        timer.unref();
      }
    }
  });

  // ---------------------------------------------------------- model-facing tool

  function textResult(text, details) {
    return {
      content: [{ type: "text", text }],
      details: details === undefined ? undefined : details,
    };
  }

  function findWorker(id) {
    const key = String(id || "");
    if (!key) {
      return null;
    }
    for (const w of workers.values()) {
      if (w.name === key || w.paneId === key) {
        return w;
      }
    }
    return null;
  }

  function registerWorker(paneId, name, tabId, status = "idle") {
    let w = workers.get(paneId);
    if (w) {
      return w;
    }
    w = {
      paneId,
      name,
      tabId: tabId || null,
      sawWorking: status === "working",
      workingSince: status === "working" ? Date.now() : 0,
      settleTimer: null,
      status,
      lastChange: Date.now(),
      leaf: false,
      sessionPath: undefined,
      /** one-time close hint already attached to a consumed result */
      nudgedClose: false,
    };
    workers.set(paneId, w);
    sendPaneSubscribe(paneId);
    renderWidget();
    return w;
  }

  async function requireWorker(id) {
    const existing = findWorker(id);
    if (existing) {
      return existing;
    }
    const info = await agentGet(String(id || ""));
    if (info?.pane_id && info.name && (!core || isOwned(info))) {
      return track(info);
    }
    throw new Error(
      `Unknown worker "${id}". Use action "status" to list tracked workers.`,
    );
  }

  function addWaiter(name, resolve) {
    let set = waiters.get(name);
    if (!set) {
      set = new Set();
      waiters.set(name, set);
    }
    set.add(resolve);
    return () => {
      const current = waiters.get(name);
      if (!current) {
        return;
      }
      current.delete(resolve);
      if (!current.size) {
        waiters.delete(name);
      }
    };
  }

  function resolveWaiters(name, outcome) {
    const set = waiters.get(name);
    if (!set || !set.size) {
      return false;
    }
    waiters.delete(name);
    for (const resolve of set) {
      try {
        resolve(outcome);
      } catch {
        // a waiter callback must never break settle handling
      }
    }
    return true;
  }

  function waitForSettle(name, timeoutMs, signal, ctx) {
    return new Promise((resolve, reject) => {
      let poll = null;
      const removeWaiter = addWaiter(name, (outcome) => {
        cleanup();
        resolve(outcome);
      });
      const cleanup = () => {
        clearTimeout(timer);
        if (poll) {
          clearInterval(poll);
          poll = null;
        }
        removeWaiter();
        if (signal && signal.removeEventListener) {
          signal.removeEventListener("abort", onAbort);
        }
      };
      const onAbort = () => {
        cleanup();
        reject(
          new Error(`Wait for ${name} was aborted; the worker keeps running.`),
        );
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out after ${timeoutMs} ms waiting for ${name} to settle; the worker keeps running (use action "read" or "status").`,
          ),
        );
      }, timeoutMs);
      if (timer.unref) {
        timer.unref();
      }
      if (signal && signal.addEventListener) {
        signal.addEventListener("abort", onAbort);
        if (signal.aborted) onAbort();
      }
      // Release for an inbound message instead of sitting on it. Both halves of
      // the gate matter: the token says the message is steering input (a queued
      // follow-up is not delivered at the tool boundary), and
      // hasPendingMessages() says pi has already enqueued it, so the boundary
      // drain sees it once this tool call returns. The released waiter is gone,
      // so the worker's later settle arrives as a normal notification.
      if (ctx && typeof ctx.hasPendingMessages === "function") {
        poll = setInterval(() => {
          if (!interrupts.armed() || !ctx.hasPendingMessages()) {
            return;
          }
          const hit = interrupts.consume();
          if (!hit) {
            return;
          }
          cleanup();
          resolve({ interrupted: true, preview: hit.preview });
        }, MESSAGE_POLL_MS);
        if (poll.unref) {
          poll.unref();
        }
      }
    });
  }

  /**
   * A released wait is not a worker failure: the worker keeps running and its
   * result still arrives through the settle notification. The message that
   * caused the release follows this result in the same run, so say what to do
   * with it and how to resume — without re-sending work to the worker.
   */
  function interruptedText(w, hit, note) {
    const elapsed = w.workingSince
      ? ` (${Math.round((Date.now() - w.workingSince) / 1000)}s)`
      : "";
    return [
      `worker ${w.name} is still ${w.status}${elapsed}: wait released early because you have an inbound message.`,
      hit && hit.preview ? `incoming: ${hit.preview}` : "",
      note || "the worker is still running — do not spawn or prompt it again.",
      `the message arrives with this result, so handle it now; resume waiting with subagent({action:"wait", id:"${w.name}"}).`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  function waitTimeoutMs(params) {
    const raw = Number(params && params.timeoutMs);
    if (!Number.isFinite(raw) || raw <= 0) {
      return DEFAULT_WAIT_MS;
    }
    return Math.min(Math.max(1000, raw), MAX_WAIT_MS);
  }

  /**
   * Append a one-time cleanup hint to a consumed worker result. Nudges at most
   * once per settle cycle; the flag resets on the next `working` transition.
   */
  function withCloseNudge(w, text, status) {
    const settled = status === "done" || status === "idle";
    if (!settled || w.nudgedClose) {
      return text;
    }
    w.nudgedClose = true;
    return `${text}\n\n${closeNudgeText(w.name)}`;
  }

  function formatWorkerOutcome(w, outcome, note) {
    const status = outcome && !outcome.removed ? outcome.status : "removed";
    const lines = [`worker ${w.name} status=${status}${note ? ` (${note})` : ""}`];
    if (outcome && outcome.durationMs != null) {
      lines.push(`duration: ${(outcome.durationMs / 1000).toFixed(1)}s`);
    }
    const result = outcome ? outcome.result : null;
    lines.push("");
    if (result && result.summary) {
      lines.push(capText(result.summary));
      if (result.lastTextAt) {
        lines.push(`lastTextAt: ${result.lastTextAt}`);
      }
    } else {
      lines.push(
        "(no assistant text after the last prompt; the run may have ended on tool calls — read the transcript or pane)",
      );
    }
    if (result) {
      lines.push(describeUsage(result.usage));
      if (result.stopReason) {
        lines.push(`stopReason: ${result.stopReason}`);
      }
    }
    const sessionPath = outcome && outcome.sessionPath;
    if (sessionPath) {
      lines.push(`transcript: ${sessionPath}`);
    }
    return lines.join("\n");
  }

  function readSubagentsJson(agentName) {
    try {
      const file = path.join(agentDir(), "subagents.json");
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const agents =
        data && typeof data.agents === "object" && data.agents ? data.agents : {};
      let agentEntry = null;
      const lowered = String(agentName).toLowerCase();
      for (const [key, value] of Object.entries(agents)) {
        if (key.toLowerCase() === lowered && value && typeof value === "object") {
          agentEntry = value;
          break;
        }
      }
      return {
        defaultModel:
          typeof data.defaultModel === "string" ? data.defaultModel : undefined,
        defaultThinking:
          typeof data.defaultThinking === "string"
            ? data.defaultThinking
            : undefined,
        agent: agentEntry,
      };
    } catch {
      return {};
    }
  }

  function findCustomAgent(agentName, cwd) {
    const dirs = [
      path.join(String(cwd || process.cwd()), ".pi", "agents"),
      path.join(agentDir(), "agents"),
    ];
    const target = `${String(agentName).toLowerCase()}.md`;
    for (const dir of dirs) {
      try {
        const entry = fs.readdirSync(dir).find((f) => f.toLowerCase() === target);
        if (entry) {
          return parseAgentMarkdown(
            fs.readFileSync(path.join(dir, entry), "utf8"),
          );
        }
      } catch {
        // missing dir is fine
      }
    }
    return null;
  }

  async function spawnWorker(params, ctx, signal) {
    const prompt = String(params.prompt || "").trim();
    if (!prompt) {
      throw new Error('spawn requires a non-empty "prompt".');
    }
    if (!owner) throw new Error("The Pi session has not initialized yet.");
    const depth = Number.parseInt(process.env.PI_SUBAGENT_DEPTH || "0", 10) || 0;
    const maxDepth = Number.isFinite(Number(params.maxDepth))
      ? Number(params.maxDepth)
      : MAX_DEPTH_DEFAULT;
    if (depth >= maxDepth) {
      throw new Error(
        `Nesting depth limit reached (depth ${depth}, max ${maxDepth}). Spawn from a shallower session or pass a higher maxDepth.`,
      );
    }
    const maxConcurrent = Number.isFinite(Number(params.maxConcurrent))
      ? Math.max(1, Number(params.maxConcurrent))
      : MAX_CONCURRENT_DEFAULT;
    const active = [...workers.values()].filter((w) =>
      !spawningNames.has(w.name) && ["working", "blocked", "starting"].includes(w.status),
    ).length + spawning;
    if (active >= maxConcurrent) {
      throw new Error(
        `Concurrency limit reached (${active} active of ${maxConcurrent}). Wait for a worker to settle or raise maxConcurrent.`,
      );
    }
    const agentName = String(params.agent || "general-purpose");
    const cfg = resolveSpawnConfig({
      agent: agentName,
      overrides: {
        model: params.model || undefined,
        thinking: params.thinking || undefined,
        tools: params.tools || undefined,
        inheritContext: params.inheritContext,
      },
      json: readSubagentsJson(agentName),
      custom: findCustomAgent(agentName, ctx && ctx.cwd),
      parentModel: modelRef(ctx && ctx.model) || process.env.PI_MODEL,
      parentThinking:
        (ctx && ctx.thinkingLevel) || process.env.PI_REASONING_LEVEL,
    });
    if ("error" in cfg) {
      throw new Error(cfg.error);
    }
    const leaf = params.leaf === true;
    const cwd = String(params.cwd || (ctx && ctx.cwd) || process.cwd());
    const existingNames = [...workers.values()]
      .map((w) => w.name)
      .concat([...spawningNames]);
    const name = uniqueWorkerName(sessionTag, String(params.label || agentName), existingNames);
    spawningNames.add(name);
    spawning += 1;
    let info;
    let submitted = false;
    try {
      const env = {
        PI_SUBAGENT_DEPTH: String(depth + 1),
        PI_SUBAGENT_PARENT: name,
        ...(leaf ? { PI_SUBAGENT_LEAF: "1" } : {}),
      };
      const flags = buildPiFlags(cfg);
      if (cfg.inheritContext) {
        const forkSession = ctx?.sessionManager?.getSessionFile() || process.env.PI_SESSION_FILE;
        if (!forkSession) {
          throw new Error(
            "inheritContext requested but the parent session file is unavailable (ephemeral session?).",
          );
        }
        flags.push("--fork", forkSession);
      }
      if (leaf) flags.push("--exclude-tools", "subagent");

      if (core) {
        info = await core.start({ name, cwd, flags, env, owner, leaf });
      } else {
        info = await createClassicWorker(name, cwd, env);
      }
      const { pane_id: paneId, tab_id: tabId } = info;
      try {
        if (core) await core.ready(paneId, START_TIMEOUT_MS);
        else await startClassicWorker(name, paneId, flags);
      } catch (error) {
        const tail = await (core ? core.tail(paneId, 30) : paneTail(paneId, 30)).catch(() => "");
        throw new Error(`Pi startup failed: ${error.message}. Terminal output:\n${tail || "(empty)"}`);
      }
      const live = await agentGet(paneId);
      const w = track({ ...(live || info), leaf });
      // A Core send can fail after input was queued. Keep the tab so it can be inspected.
      if (core) submitted = true;
      const { pending } = await submitPrompt(w, prompt, params.background === false, params, signal, ctx);
      submitted = true;
      const handle = {
        id: name,
        [core ? "terminal" : "pane"]: paneId,
        tab: tabId || null,
        ...(w.spaceId ? { space: w.spaceId } : {}),
        agent: cfg.agent,
        model: cfg.model || null,
        thinking: cfg.thinking || null,
        leaf,
        sessionPath: w.sessionPath || null,
      };
      if (pending) {
        const outcome = await pending;
        if (outcome.interrupted) {
          return textResult(
            interruptedText(w, outcome, `the worker is already spawned and running; id: ${w.name}.`),
            {
              ...handle,
              action: "spawn",
              foreground: true,
              interrupted: true,
              status: w.status,
              incoming: outcome.preview || null,
            },
          );
        }
        return textResult(
          withCloseNudge(w, formatWorkerOutcome(w, outcome), outcome.status),
          {
            ...handle,
            sessionPath: outcome.sessionPath || handle.sessionPath,
            action: "spawn",
            foreground: true,
            result: outcome.result,
          },
        );
      }
      return textResult(
        [
          `spawned ${name} (${cfg.agent}${cfg.model ? `, ${cfg.model}` : ""}${
            cfg.thinking ? `, thinking ${cfg.thinking}` : ""
          }${leaf ? ", leaf" : ""})`,
          `${core ? "terminal" : "pane"}: ${paneId}${tabId ? `  tab: ${tabId}` : ""}`,
          w.sessionPath ? `transcript: ${w.sessionPath}` : "transcript: (pending)",
          "background: you will be notified when it settles.",
        ].join("\n"),
        { ...handle, action: "spawn", foreground: false },
      );
    } catch (error) {
      if (info && !submitted) {
        try {
          await closeTerminal(info.pane_id, info.tab_id);
          removeWorker(info.pane_id);
        } catch (cleanupError) {
          throw new Error(`${error.message}. Could not close ${name}: ${cleanupError.message}`);
        }
      }
      throw error;
    } finally {
      spawning -= 1;
      spawningNames.delete(name);
    }
  }

  async function createClassicWorker(name, cwd, env) {
    const res = await herdrExec([
      "tab", "create", "--workspace", HERDR_WORKSPACE_ID, "--cwd", cwd,
      "--label", `pi-worker:${name}`, "--no-focus",
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    ], 15000);
    const tabId = res.doc?.result?.tab?.tab_id;
    const paneId = res.doc?.result?.root_pane?.pane_id;
    if (!res.ok || !tabId || !paneId) {
      throw new Error(`tab create failed: ${herdrErrorText(res)}`);
    }
    return { name, pane_id: paneId, tab_id: tabId, agent_status: "starting" };
  }

  async function startClassicWorker(name, pane, flags) {
    const res = await herdrExec([
      "agent", "start", name, "--kind", "pi", "--pane", pane,
      "--timeout", String(START_TIMEOUT_MS), "--", ...flags, "--name", name,
    ], START_TIMEOUT_MS + 30000);
    if (!res.ok) throw new Error(herdrErrorText(res));
  }

  async function submitPrompt(w, text, wait, params, signal, ctx) {
    if (w.submitting) throw new Error(`Another prompt is being submitted to ${w.name}.`);
    w.submitting = true;
    try {
      if (core) {
        const reply = await core.prompt(w.paneId, text);
        if (workers.get(w.paneId) !== w) {
          throw new Error(`${w.name} exited while the prompt was being submitted.`);
        }
        if (reply.started === false && reply.status !== "working" && !w.sawWorking) {
          throw new Error(`${w.name} did not report starting the prompt. Inspect its terminal before retrying.`);
        }
        if (!w.sawWorking && reply.started === true) onStatusChanged(w.paneId, "working");
        const info = await agentGet(w.paneId);
        if (info) {
          track(info);
          onStatusChanged(w.paneId, info.agent_status);
        }
      } else {
        const res = await herdrExec(["agent", "prompt", w.name, text], 30000);
        if (!res.ok) {
          const tail = await paneTail(w.paneId, 30);
          throw new Error(`prompt rejected: ${herdrErrorText(res)}. Pane output:\n${tail || "(empty)"}`);
        }
        w.sawWorking = true;
        w.workingSince = Date.now();
        w.lastChange = Date.now();
      }
      w.nudgedClose = false;
      renderWidget();
      return {
        pending: wait ? waitForSettle(w.name, waitTimeoutMs(params), signal, ctx) : null,
      };
    } finally {
      w.submitting = false;
      scheduleSettle(w);
    }
  }

  async function promptWorker(params, signal, ctx) {
    const w = await requireWorker(params.id);
    const text = String(params.text || "").trim();
    if (!text) {
      throw new Error('prompt requires non-empty "text".');
    }
    const { pending } = await submitPrompt(w, text, params.wait, params, signal, ctx);
    if (pending) {
      const outcome = await pending;
      if (outcome.interrupted) {
        return textResult(
          interruptedText(w, outcome, "the prompt was already delivered — do not send it again."),
          {
            action: "prompt",
            id: w.name,
            interrupted: true,
            status: w.status,
            incoming: outcome.preview || null,
          },
        );
      }
      return textResult(
        withCloseNudge(w, formatWorkerOutcome(w, outcome), outcome.status),
        { action: "prompt", id: w.name, result: outcome.result },
      );
    }
    return textResult(
      `prompted ${w.name}; it will notify you when it settles.`,
      { action: "prompt", id: w.name },
    );
  }

  async function waitWorker(params, signal, ctx) {
    const w = await requireWorker(params.id);
    if (!w.submitting && !w.sawWorking && settled(w.status)) {
      const info = await agentGet(w.paneId);
      if (info) track(info);
      const sessionPath = w.sessionPath;
      const result = sessionPath ? readLastAssistant(sessionPath) : null;
      const outcome = {
        status: w.status,
        info,
        sessionPath,
        result,
        durationMs: null,
      };
      return textResult(
        withCloseNudge(
          w,
          formatWorkerOutcome(w, outcome, "already settled"),
          outcome.status,
        ),
        { action: "wait", id: w.name, result },
      );
    }
    const outcome = await waitForSettle(w.name, waitTimeoutMs(params), signal, ctx);
    if (outcome.interrupted) {
      return textResult(interruptedText(w, outcome), {
        action: "wait",
        id: w.name,
        interrupted: true,
        status: w.status,
        incoming: outcome.preview || null,
      });
    }
    return textResult(
      withCloseNudge(w, formatWorkerOutcome(w, outcome), outcome.status),
      { action: "wait", id: w.name, result: outcome.result },
    );
  }

  function statusText() {
    if (!workers.size) {
      return "no tracked workers";
    }
    const now = Date.now();
    return [...workers.values()]
      .sort((a, b) => (b.lastChange || 0) - (a.lastChange || 0))
      .map((w) => {
        const elapsed =
          w.status === "working" && w.workingSince
            ? ` ${Math.round((now - w.workingSince) / 1000)}s`
            : "";
        return `${w.name}  ${w.status}${elapsed}  ${core ? "terminal" : "pane"}=${w.paneId}${
          w.tabId ? ` tab=${w.tabId}` : ""
        }${w.leaf ? " leaf" : ""}`;
      })
      .join("\n");
  }

  async function readWorker(params) {
    const w = await requireWorker(params.id);
    const info = await agentGet(w.paneId);
    if (info) track(info);
    const sessionPath = w.sessionPath;
    if (!sessionPath) {
      throw new Error(`No session file found for ${w.name} yet.`);
    }
    const result = readLastAssistant(sessionPath);
    const status = (info && info.agent_status) || w.status;
    return textResult(
      withCloseNudge(
        w,
        formatWorkerOutcome(w, { status, info, sessionPath, result, durationMs: null }),
        status,
      ),
      { action: "read", id: w.name, result },
    );
  }

  async function closeWorker(params) {
    const w = await requireWorker(params.id);
    const info = await agentGet(core ? w.paneId : w.name);
    const tabId = (info && info.tab_id) || w.tabId;
    const sessionPath =
      (info && info.agent_session ? info.agent_session.value : undefined) ||
      w.sessionPath;
    if (params.force !== true && (core || sessionPath)) {
      const agents = await agentList() || [];
      const descendants = core
        ? workerTree(agents, w.paneId).map(({ agent }) => agent)
        : agents.filter((a) => workerLabel(a?.name, workerSessionTag(sessionIdFromPath(sessionPath))));
      const busy = descendants.filter((a) =>
        ["working", "blocked", "starting"].includes(a.agent_status));
      if (busy.length) {
        throw new Error(
          `Refusing to close ${w.name}: ${busy.length} descendant(s) still active (${busy
            .map((a) => a.name)
            .join(", ")}). Pass force:true to close anyway.`,
        );
      }
    }
    await closeTerminal(w.paneId, tabId);
    removeWorker(w.paneId);
    return textResult(
      `closed ${w.name}${tabId ? ` (tab ${tabId})` : ""}.`,
      { action: "close", id: w.name },
    );
  }

  async function closeTerminal(paneId, tabId) {
    if (core) await core.close(paneId);
    else if (tabId) {
      const res = await herdrExec(["tab", "close", tabId], 8000);
      if (!res.ok) throw new Error(`tab close failed: ${herdrErrorText(res)}`);
    }
  }

  async function interruptWorker(params) {
    const w = await requireWorker(params.id);
    if (core) {
      const { outcome } = await core.interrupt(w.paneId);
      return textResult(`interrupt for ${w.name}: ${outcome}.`, { action: "interrupt", id: w.name, outcome });
    }
    const res = await herdrExec(["agent", "send-keys", w.name, "esc"], 8000);
    if (!res.ok) {
      throw new Error(`interrupt failed: ${herdrErrorText(res)}`);
    }
    return textResult(
      `sent Esc to ${w.name} (aborts the current run; the worker stays alive).`,
      { action: "interrupt", id: w.name },
    );
  }

  /**
   * Close every worker this session spawned, plus their nested descendants.
   * Deepest-first so no descendant is orphaned by its parent's tab closing.
   */
  async function clearWorkerTree() {
    const tree = workerTree(await agentList());
    const closed = [];
    const failed = [];
    for (const entry of tree) {
      const a = entry.agent;
      try {
        await closeTerminal(a.pane_id, a.tab_id);
        if (a.pane_id) {
          removeWorker(a.pane_id);
        }
        closed.push(a.name);
      } catch (err) {
        failed.push(`${a.name}: ${(err && err.message) || err}`);
      }
    }
    return { closed, failed, total: tree.length };
  }

  async function runClear(ctx) {
    const tree = workerTree(await agentList());
    if (!tree.length) {
      ctx.ui.notify("No subagents spawned by this session", "info");
      return;
    }
    const names = tree.map((entry) => entry.agent.name);
    const ok = await ctx.ui.confirm(
      "Clear subagents?",
      `Close ${tree.length} subagent(s)?\n${names.join(", ")}`,
    );
    if (!ok) {
      return;
    }
    const { closed, failed } = await clearWorkerTree();
    if (failed.length) {
      ctx.ui.notify(
        `Closed ${closed.length}; failed: ${failed.join("; ")}`,
        "error",
      );
    } else {
      ctx.ui.notify(
        `Closed ${closed.length} subagent(s): ${closed.join(", ")}`,
        "info",
      );
    }
  }

  async function listWorkerTreeText() {
    const tree = workerTree(await agentList());
    if (!tree.length) {
      return "no subagents spawned by this session";
    }
    return tree
      .map((entry) => {
        const a = entry.agent;
        return `${a.name}  ${a.agent_status || "?"}${
          entry.depth ? `  depth=${entry.depth}` : ""
        }`;
      })
      .join("\n");
  }

  pi.registerCommand("subagents", {
    description:
      "List subagents spawned by this session; /subagents clear closes them all",
    getArgumentCompletions: (argPrefix) => {
      const filtered = ["clear"].filter((value) =>
        value.startsWith(String(argPrefix || "").toLowerCase()),
      );
      return filtered.length
        ? filtered.map((value) => ({ value, label: value }))
        : null;
    },
    handler: async (args, ctx) => {
      if (String(args || "").trim().toLowerCase() === "clear") {
        await runClear(ctx);
        return;
      }
      ctx.ui.notify(await listWorkerTreeText(), "info");
    },
  });

  pi.registerCommand("clear-subagents", {
    description: "Close all subagents spawned by this session (with confirmation)",
    handler: async (_args, ctx) => {
      await runClear(ctx);
    },
  });

  const subagentTool = defineTool({
    name: "subagent",
    label: "Subagent",
    promptSnippet:
      "Spawn and manage Pi worker subagents (spawn/prompt/wait/read/close).",
    promptGuidelines: [
      "Keep a settled subagent open when you expect to prompt it again — e.g. ask a reviewer to re-review after you fix its findings, or hand your review comments back to the worker. Close it once its role in the task is finished and you will not prompt it again: subagent({action:'close', id}). Close superseded workers when you spawn their replacement.",
      "A blocking wait can release early with interrupted:true because an inbound message arrived. Handle that message — it reaches you just after this result — then resume with subagent({action:'wait', id}); never re-prompt or re-spawn the worker.",
    ],
    description: [
      "Spawn and manage Pi workers (subagents). Each worker has its own context window, tools, model, and session. Herdr App lists workers under the parent terminal. Classic Herdr opens separate tabs in the parent workspace.",
      'Actions: "spawn" starts Pi and sends the task, then returns a worker ID. Background workers (default) notify you with a <task-notification> when they settle. "prompt" steers a running worker or continues its session. Set wait:true to wait for the result. "wait" waits for a tracked worker to settle. "status" lists tracked workers. "read" returns the latest assistant text, usage, and transcript path. "close" closes one worker and refuses while its nested workers are active unless force:true. "clear" closes this session\'s workers and their nested workers. "interrupt" stops the current turn and keeps the worker open.',
      "Nesting is allowed by default (depth cap 2): workers inherit this tool. Pass leaf:true to make a worker unable to delegate (it gets no subagent tool and PI_SUBAGENT_LEAF=1).",
      "A blocking wait (\"wait\", prompt wait:true, spawn background:false) releases early when an inbound message arrives for you, so the message is delivered in the same turn instead of after the wait ends; the worker keeps running and you can wait again.",
      "Prompt tips: include the working directory, constraints, what to report, and end with a request for a concise final summary; add 'do not delegate further' only when you want a leaf.",
    ].join(" "),
    parameters: Type.Object({
      action: StringEnum([
        "spawn",
        "prompt",
        "wait",
        "status",
        "read",
        "close",
        "clear",
        "interrupt",
      ]),
      id: Type.Optional(
        Type.String({ description: "Worker name, Core terminal ID, or classic pane ID." }),
      ),
      prompt: Type.Optional(
        Type.String({ description: "spawn: the task prompt for the worker." }),
      ),
      text: Type.Optional(
        Type.String({ description: "prompt: the text to send (steer or continue)." }),
      ),
      agent: Type.Optional(
        Type.String({
          description:
            'spawn: agent type, e.g. "general-purpose" (default), "Explore", "Plan", or a custom .pi/agents/<name>.md type.',
        }),
      ),
      label: Type.Optional(
        Type.String({
          description: "spawn: short slug for the worker name (defaults to the agent type).",
        }),
      ),
      model: Type.Optional(Type.String({ description: "spawn: model id override." })),
      thinking: Type.Optional(
        Type.String({ description: "spawn: thinking level override." }),
      ),
      tools: Type.Optional(
        Type.String({
          description:
            'spawn: tool allowlist override, e.g. "read,grep,find,ls" or "none".',
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            "spawn: working directory for the worker (defaults to the current directory).",
        }),
      ),
      background: Type.Optional(
        Type.Boolean({
          description:
            "spawn: true (default) returns immediately and notifies on settle; false blocks and returns the result.",
        }),
      ),
      leaf: Type.Optional(
        Type.Boolean({ description: "spawn: true forbids the worker from delegating further." }),
      ),
      inheritContext: Type.Optional(
        Type.Boolean({
          description:
            "spawn: true forks your session into the worker (requires a persistent session).",
        }),
      ),
      maxDepth: Type.Optional(
        Type.Number({ description: "spawn: nesting depth cap for children (default 2)." }),
      ),
      maxConcurrent: Type.Optional(
        Type.Number({ description: "spawn: concurrent worker cap (default 4)." }),
      ),
      wait: Type.Optional(
        Type.Boolean({
          description:
            "prompt: true blocks until the worker settles and returns its result. Releases early if an inbound message arrives.",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description: "close: true closes even if nested descendants are active.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description:
            "wait/foreground spawn: how long this call blocks before failing (default 600000, max 900000). The worker keeps running after a timeout. A block also releases early if an inbound message arrives.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      switch (params.action) {
        case "spawn":
          return await spawnWorker(params, ctx, signal);
        case "prompt":
          return await promptWorker(params, signal, ctx);
        case "wait":
          return await waitWorker(params, signal, ctx);
        case "status": {
          if (params.id) {
            const w = await requireWorker(params.id);
            return textResult(
            `${w.name}  ${w.status}  ${core ? "terminal" : "pane"}=${w.paneId}${w.tabId ? ` tab=${w.tabId}` : ""}`,
              { action: "status", id: w.name },
            );
          }
          return textResult(statusText(), {
            action: "status",
            workers: [...workers.values()].map((w) => ({
              id: w.name,
              status: w.status,
              [core ? "terminal" : "pane"]: w.paneId,
              tab: w.tabId,
            })),
          });
        }
        case "read":
          return await readWorker(params);
        case "close":
          return await closeWorker(params);
        case "clear": {
          const { closed, failed } = await clearWorkerTree();
          return textResult(
            closed.length || failed.length
              ? `closed ${closed.length} subagent(s)${closed.length ? `: ${closed.join(", ")}` : ""}${
                  failed.length ? `\nfailed: ${failed.join("; ")}` : ""
                }`
              : "no subagents to clear",
            { action: "clear", closed, failed },
          );
        }
        case "interrupt":
          return await interruptWorker(params);
        default:
          throw new Error(`Unknown subagent action "${params.action}".`);
      }
    },
  });

  if (process.env.PI_SUBAGENT_LEAF !== "1") pi.registerTool(subagentTool);

  // ----------------------------------------------------------------- lifecycle

  function publishSession(ctx) {
    if (!core || !process.env.PI_SUBAGENT_PARENT || ctx?.mode !== "tui") return;
    const file = ctx?.sessionManager?.getSessionFile() || "";
    publishQueue = publishQueue.then(async () => {
      if (file !== publishedSession && !shuttingDown) {
        await core.publishSession(file);
        publishedSession = file;
      }
    }).catch(() => {
      // Try again on the next session or agent event.
    });
  }

  if (core) {
    pi.on("agent_start", (_event, ctx) => publishSession(ctx));
    pi.on("agent_settled", (_event, ctx) => publishSession(ctx));
  }

  pi.on("session_start", async (event, ctx) => {
    // A reload/session replacement drops any half-armed hold.
    hold.drop();
    if (ctx && ctx.mode && ctx.mode !== "tui") {
      return;
    }
    if (ctx && ctx.ui) {
      ui = ctx.ui;
    }
    const sessionId =
      (ctx &&
        ctx.sessionManager &&
        ctx.sessionManager.getSessionId &&
        ctx.sessionManager.getSessionId()) ||
      process.env.PI_SESSION_ID;
    if (!sessionId) {
      return;
    }
    if (owner && owner !== sessionId) {
      // A new session replaced the old one; drop its workers.
      for (const paneId of workers.keys()) removeWorker(paneId);
      foregroundWaits.clear();
    }
    owner = sessionId;
    sessionTag = workerSessionTag(sessionId);
    publishSession(ctx);
    connect();
    void resyncWorkers();
    if (resyncTimer) {
      clearInterval(resyncTimer);
    }
    resyncTimer = setInterval(() => {
      void resyncWorkers();
    }, 30000);
    if (resyncTimer.unref) {
      resyncTimer.unref();
    }
  });

  pi.on("session_shutdown", () => {
    shuttingDown = true;
    hold.drop();
    try {
      unsubscribeHold();
    } catch {
      // the event bus may already be torn down
    }
    stopWidgetLoop();
    if (resyncTimer) {
      clearInterval(resyncTimer);
      resyncTimer = null;
    }
    if (ui) {
      try {
        ui.setWidget(WIDGET_KEY, undefined);
      } catch {
        // UI may already be torn down
      }
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    for (const w of workers.values()) {
      if (w.settleTimer) {
        clearTimeout(w.settleTimer);
      }
    }
    for (const paneId of classicPaneSockets.keys()) closePaneSubscription(paneId);
    foregroundWaits.clear();
    if (socket) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      socket = null;
      connected = false;
    }
  });
}
