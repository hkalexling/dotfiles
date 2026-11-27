import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPiFlags,
  capText,
  closeNudgeText,
  collectWorkerTree,
  createHoldController,
  createMessageInterruptController,
  extractLastTurn,
  formatCleanupLine,
  latestHeldPerWorker,
  modelRef,
  normalizeMessagePreview,
  parseAgentMarkdown,
  parseJsonlEntries,
  resolveSpawnConfig,
  sessionIdFromPath,
  slugify,
  uniqueWorkerName,
  workerLabel,
  workerSessionTag,
} from "../lib.ts";

const assistantText = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "message",
  timestamp: "2026-01-01T00:00:01Z",
  message: { role: "assistant", content: [{ type: "text", text }], ...extra },
});

test("workerSessionTag uses 12 alphanumerics and parses UUIDs", () => {
  assert.equal(workerSessionTag("01a0f347-784e-73fa-b5e6-1db06cd860fc"), "w01a0f347784e");
  assert.equal(workerSessionTag("ABC_123"), "wabc123");
  assert.equal(workerSessionTag("—"), "w");
});

test("sessionIdFromPath strips timestamp prefix and extension", () => {
  assert.equal(
    sessionIdFromPath("/home/x/.pi/agent/sessions/--tmp--/2026-09-30T17-05-42-478Z_01a0f347-784e.jsonl"),
    "01a0f347-784e",
  );
});

test("uniqueWorkerName puts the readable label before the session ID", () => {
  assert.equal(slugify("Auth Fix: login!!"), "auth-fix-login");
  const tag = "w01a0f347784e";
  assert.equal(uniqueWorkerName(tag, "Auth Fix", []), `auth-fix-${tag}`);
  assert.equal(uniqueWorkerName(tag, "auth", [`auth-${tag}`, `auth-2-${tag}`]), `auth-3-${tag}`);
  assert.equal(uniqueWorkerName(tag, "123", []), `worker-123-${tag}`);
  const longLabel = "a".repeat(40);
  const long = uniqueWorkerName(tag, longLabel, []);
  assert.equal(long, `${"a".repeat(18)}-${tag}`);
  assert.equal(uniqueWorkerName(tag, longLabel, [long]), `${"a".repeat(16)}-2-${tag}`);
});

test("workerLabel recognizes both formats for the same session", () => {
  const tag = "w01a0f347784e";
  assert.equal(workerLabel(`auth-2-${tag}`, tag), "auth-2");
  assert.equal(workerLabel(`${tag}-auth-2`, tag), "auth-2");
  assert.equal(workerLabel(`auth-${tag}-unrelated`, tag), undefined);
  assert.equal(workerLabel(`-${tag}`, tag), undefined);
});

test("parseAgentMarkdown reads known keys and ignores max_turns", () => {
  const parsed = parseAgentMarkdown(
    [
      "---",
      "description: Reviewer",
      "model: anthropic/claude-haiku",
      "thinking: low",
      "tools: read, grep",
      "prompt_mode: replace",
      "inherit_context: true",
      "max_turns: 40",
      "---",
      "You are a reviewer.",
    ].join("\n"),
  );
  assert.deepEqual(parsed.frontmatter, {
    description: "Reviewer",
    model: "anthropic/claude-haiku",
    thinking: "low",
    tools: "read, grep",
    promptMode: "replace",
    inheritContext: true,
  });
  assert.equal(parsed.body, "You are a reviewer.");
});

test("parseAgentMarkdown handles files without frontmatter", () => {
  const parsed = parseAgentMarkdown("Just a body.");
  assert.deepEqual(parsed.frontmatter, {});
  assert.equal(parsed.body, "Just a body.");
});

test("resolveSpawnConfig applies precedence and built-in prompts", () => {
  const cfg = resolveSpawnConfig({
    agent: "Explore",
    overrides: {},
    json: { defaultModel: "default/m", defaultThinking: "medium" },
    custom: null,
    parentModel: "parent/m",
    parentThinking: "high",
  });
  assert.ok(!("error" in cfg));
  if ("error" in cfg) return;
  assert.equal(cfg.model, "default/m");
  assert.equal(cfg.thinking, "medium");
  assert.equal(cfg.tools, "read,bash,grep,find,ls");
  assert.match(String(cfg.systemPrompt), /read-only codebase exploration/);
  assert.equal(cfg.promptMode, "append");
});

test("resolveSpawnConfig: explicit > json agent > default > frontmatter > parent", () => {
  const custom = parseAgentMarkdown(
    ["---", "model: fm/m", "thinking: minimal", "---", "body"].join("\n"),
  );
  const cfg = resolveSpawnConfig({
    agent: "custom",
    overrides: { model: "explicit/m" },
    json: { defaultModel: "default/m", defaultThinking: "medium", agent: { thinking: "low" } },
    custom,
    parentModel: "parent/m",
    parentThinking: "high",
  });
  assert.ok(!("error" in cfg));
  if ("error" in cfg) return;
  assert.equal(cfg.model, "explicit/m");
  assert.equal(cfg.thinking, "low");
  assert.equal(cfg.systemPrompt, "body");
  assert.equal(cfg.promptMode, "append");
});

test("resolveSpawnConfig rejects unknown types", () => {
  const cfg = resolveSpawnConfig({ agent: "nope", overrides: {}, json: {}, custom: null });
  assert.ok("error" in cfg);
});

test("buildPiFlags maps config to CLI flags", () => {
  const flags = buildPiFlags(
    {
      agent: "x",
      model: "m/m",
      thinking: "low",
      tools: "read,grep",
      systemPrompt: "S",
      promptMode: "append",
      inheritContext: true,
    },
    { forkSession: "/tmp/s.jsonl" },
  );
  assert.deepEqual(flags, [
    "--model",
    "m/m",
    "--thinking",
    "low",
    "--tools",
    "read,grep",
    "--append-system-prompt",
    "S",
    "--fork",
    "/tmp/s.jsonl",
  ]);
});

test("extractLastTurn ignores stale text when the latest run ended on tool calls", () => {
  const entries = parseJsonlEntries([
    JSON.stringify({ type: "message", message: { role: "user", content: "first" } }),
    JSON.stringify(assistantText("OLD ANSWER", { usage: { input: 1 }, stopReason: "stop" })),
    JSON.stringify({ type: "message", message: { role: "user", content: "second" } }),
    JSON.stringify({
      type: "message",
      timestamp: "2026-01-01T00:00:09Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
        usage: { input: 2 },
        stopReason: "toolUse",
      },
    }),
    JSON.stringify({ type: "message", message: { role: "toolResult", content: [] } }),
  ]);
  const result = extractLastTurn(entries);
  assert.equal(result.summary, null);
  assert.deepEqual(result.usage, { input: 2 });
  assert.equal(result.stopReason, "toolUse");
  assert.equal(result.lastTextAt, null);
});

test("extractLastTurn returns the closing summary of the latest run", () => {
  const entries = parseJsonlEntries([
    JSON.stringify({ type: "message", message: { role: "user", content: "first" } }),
    JSON.stringify(assistantText("OLD ANSWER")),
    JSON.stringify({ type: "message", message: { role: "user", content: "second" } }),
    JSON.stringify(
      assistantText("NEW ANSWER", { usage: { input: 3 }, stopReason: "stop" }),
    ),
  ]);
  const result = extractLastTurn(entries);
  assert.equal(result.summary, "NEW ANSWER");
  assert.equal(result.lastTextAt, "2026-01-01T00:00:01Z");
  assert.deepEqual(result.usage, { input: 3 });
});

test("parseJsonlEntries skips corrupt tail lines", () => {
  const entries = parseJsonlEntries(['{"type":"message"}', '{"partial', "", "junk"]);
  assert.equal(entries.length, 1);
});

test("capText truncates with a pointer", () => {
  const out = capText("x".repeat(50), 10);
  assert.match(out, /truncated 40 chars/);
});

test("collectWorkerTree finds direct workers and nested descendants, deepest first", () => {
  const parentTag = workerSessionTag("aaaaaaaaaaaa1111");
  const agents = [
    {
      name: `parent-${parentTag}`,
      agent: "pi",
      agent_session: { value: "/s/2026-01-01T00-00-00Z_bbbbbbbbbbbb2222.jsonl" },
      tab_id: "wA:t1",
      pane_id: "wA:p1",
      agent_status: "working",
    },
    {
      name: "wbbbbbbbbbbbb-child",
      agent: "pi",
      agent_session: { value: "/s/2026-01-01T00-00-01Z_cccccccccccc3333.jsonl" },
      tab_id: "wA:t2",
      pane_id: "wA:p2",
      agent_status: "working",
    },
    {
      name: "grand-wcccccccccccc",
      agent: "pi",
      agent_session: { value: "/s/2026-01-01T00-00-02Z_dddddddddddd4444.jsonl" },
      tab_id: "wA:t3",
      pane_id: "wA:p3",
      agent_status: "idle",
    },
    { name: "w999999999999-other", agent: "pi", tab_id: "wA:t4", pane_id: "wA:p4" },
    { name: `claude-${parentTag}`, agent: "claude", tab_id: "wA:t5", pane_id: "wA:p5" },
    { name: "unnamed-pane", agent: "pi", tab_id: "wA:t6", pane_id: "wA:p6" },
  ];
  const tree = collectWorkerTree(agents, parentTag);
  assert.deepEqual(
    tree.map((entry) => [entry.agent.name, entry.depth]),
    [
      ["grand-wcccccccccccc", 2],
      ["wbbbbbbbbbbbb-child", 1],
      [`parent-${parentTag}`, 0],
    ],
  );
});

test("collectWorkerTree ignores unrelated and non-pi agents", () => {
  const tag = workerSessionTag("eeeeeeeeeeee5555");
  const tree = collectWorkerTree(
    [
      { name: "wffffffffffff-x", agent: "pi", pane_id: "p1" },
      { name: `codex-${tag}`, agent: "codex", pane_id: "p2" },
      { name: `${tag}-ok`, agent: "pi", pane_id: "p3" },
    ],
    tag,
  );
  assert.deepEqual(tree.map((entry) => entry.agent.name), [`${tag}-ok`]);
});

test("modelRef builds provider/model refs for --model", () => {
  assert.equal(modelRef(undefined), undefined);
  assert.equal(modelRef({ id: "m" }), "m");
  assert.equal(modelRef({ id: "m", provider: "p" }), "p/m");
  assert.equal(modelRef({ id: "p/m", provider: "p" }), "p/m");
});

test("latestHeldPerWorker keeps only the newest notification per worker", () => {
  const queue = [
    { name: "a", message: 1 },
    { name: "b", message: 2 },
    { name: "a", message: 3 },
    { name: "c", message: 4 },
  ];
  // First-seen order is preserved; the value is the worker's newest message.
  assert.deepEqual(latestHeldPerWorker(queue), [
    { name: "a", message: 3 },
    { name: "b", message: 2 },
    { name: "c", message: 4 },
  ]);
  assert.deepEqual(latestHeldPerWorker([]), []);
});

test("formatCleanupLine lists open settled workers and caps the list", () => {
  assert.equal(formatCleanupLine([]), null);
  const one = formatCleanupLine(["w-a"]);
  assert.match(one, /open="1"/);
  assert.match(one, /w-a/);
  assert.match(one, /subagent\(\{action:"close"/);

  const many = formatCleanupLine(["a", "b", "c", "d", "e", "f", "g"], 5);
  assert.match(many, /open="7"/);
  assert.match(many, /\+2 more/);
  assert.match(many, /will not prompt again/);
  assert.ok(!many.includes("f"));
});

test("closeNudgeText names the worker and keeps follow-up prompts open", () => {
  const text = closeNudgeText("w01a-verify");
  assert.match(text, /w01a-verify/);
  assert.match(text, /action:"close"/);
  assert.match(text, /will not prompt it again/);
  assert.match(text, /follow-up/);
});

test("hold controller queues while held and flushes the newest per worker", () => {
  const sent: string[] = [];
  const hold = createHoldController<string>({ send: (m) => sent.push(m) });
  assert.equal(hold.push({ name: "a", message: "a1" }), false);
  hold.onEvent({ on: true, id: "sc-1" });
  assert.equal(hold.holding(), true);
  assert.equal(hold.push({ name: "a", message: "a1" }), true);
  assert.equal(hold.push({ name: "b", message: "b1" }), true);
  assert.equal(hold.push({ name: "a", message: "a2" }), true);
  assert.equal(hold.queued(), 3);
  hold.onEvent({ on: false, id: "sc-1" });
  assert.equal(hold.holding(), false);
  assert.deepEqual(sent, ["a2", "b1"]);
});

test("hold controller TTL flushes instead of starving notifications", async () => {
  const sent: string[] = [];
  const hold = createHoldController<string>({ send: (m) => sent.push(m) });
  hold.onEvent({ on: true, ttlMs: 20 });
  hold.push({ name: "a", message: "late" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(hold.holding(), false);
  assert.deepEqual(sent, ["late"]);
});

test("hold controller drop discards the queue without sending", () => {
  const sent: string[] = [];
  const hold = createHoldController<string>({ send: (m) => sent.push(m) });
  hold.onEvent({ on: true });
  hold.push({ name: "a", message: "x" });
  hold.drop();
  assert.equal(hold.holding(), false);
  assert.equal(hold.queued(), 0);
  assert.deepEqual(sent, []);
});

test("hold controller caps the queue at maxQueue", () => {
  const sent: string[] = [];
  const hold = createHoldController<string>({ send: (m) => sent.push(m), maxQueue: 2 });
  hold.onEvent({ on: true });
  for (const name of ["a", "b", "c"]) {
    hold.push({ name, message: name });
  }
  hold.onEvent({ on: false });
  assert.deepEqual(sent, ["b", "c"]);
});

test("hold controller ignores malformed events", () => {
  const sent: string[] = [];
  const hold = createHoldController<string>({ send: (m) => sent.push(m) });
  hold.onEvent(null);
  hold.onEvent("nope");
  hold.onEvent({ on: false });
  assert.equal(hold.holding(), false);
  assert.deepEqual(sent, []);
});

// ------------------------------------------------ inbound-message release

test("steer input arms one release and carries a preview", () => {
  const interrupts = createMessageInterruptController();
  interrupts.observe({ streamingBehavior: "steer", text: "stop and fix the tests" });
  assert.equal(interrupts.armed(), true);
  assert.deepEqual(interrupts.consume(), { preview: "stop and fix the tests" });
  assert.equal(interrupts.armed(), false);
});

test("follow-up and idle input never arm a release", () => {
  const interrupts = createMessageInterruptController();
  interrupts.observe({ streamingBehavior: "followUp", text: "and then summarize" });
  interrupts.observe({ text: "typed while idle" });
  interrupts.observe({});
  assert.equal(interrupts.armed(), false);
  assert.equal(interrupts.consume(), null);
});

test("claims are one at a time and match delivery order", () => {
  const interrupts = createMessageInterruptController();
  interrupts.observe({ streamingBehavior: "steer", text: "first" });
  interrupts.observe({ streamingBehavior: "steer", text: "second" });
  assert.equal(interrupts.tokens(), 2);
  assert.deepEqual(interrupts.consume(), { preview: "first" });
  assert.deepEqual(interrupts.consume(), { preview: "second" });
  assert.equal(interrupts.consume(), null);
});

test("a burst cannot arm more releases than the cap", () => {
  const interrupts = createMessageInterruptController({ maxTokens: 3 });
  for (let i = 0; i < 10; i++) {
    interrupts.observe({ streamingBehavior: "steer", text: `msg ${i}` });
  }
  assert.equal(interrupts.tokens(), 3);
});

test("reset forgets tokens and previews for a new run", () => {
  const interrupts = createMessageInterruptController();
  interrupts.observe({ streamingBehavior: "steer", text: "stale" });
  interrupts.reset();
  assert.equal(interrupts.armed(), false);
  interrupts.observe({ streamingBehavior: "steer", text: "fresh" });
  assert.deepEqual(interrupts.consume(), { preview: "fresh" });
});

test("a steer without text still arms a release with an empty preview", () => {
  const interrupts = createMessageInterruptController();
  interrupts.observe({ streamingBehavior: "steer", text: "   " });
  assert.deepEqual(interrupts.consume(), { preview: "" });
});

test("normalizeMessagePreview flattens whitespace and caps length", () => {
  assert.equal(normalizeMessagePreview("  a\n\tb  "), "a b");
  assert.equal(normalizeMessagePreview(undefined), "");
  assert.equal(normalizeMessagePreview("x".repeat(10), 5), "xxxx…");
});

test("tokens expire so a stale steer cannot release a later wait", () => {
  let now = 1_000;
  const interrupts = createMessageInterruptController({ tokenTtlMs: 500, now: () => now });
  interrupts.observe({ streamingBehavior: "steer", text: "already delivered" });
  assert.equal(interrupts.tokens(), 1);
  now += 501;
  assert.equal(interrupts.armed(), false);
  assert.equal(interrupts.consume(), null);
});

test("the queue cap keeps the newest steers", () => {
  const interrupts = createMessageInterruptController({ maxTokens: 3 });
  for (let i = 0; i < 10; i++) {
    interrupts.observe({ streamingBehavior: "steer", text: `msg ${i}` });
  }
  assert.equal(interrupts.tokens(), 3);
  assert.deepEqual(interrupts.consume(), { preview: "msg 7" });
});
