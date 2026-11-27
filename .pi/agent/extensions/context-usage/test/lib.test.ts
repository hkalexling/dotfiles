import { test } from "node:test";
import assert from "node:assert/strict";
import { formatContextUsage, formatTokenCount } from "../lib.ts";

test("formatTokenCount renders k/M suffixes", () => {
  assert.equal(formatTokenCount(500), "500");
  assert.equal(formatTokenCount(1500), "1.5k");
  assert.equal(formatTokenCount(384_000), "384.0k");
  assert.equal(formatTokenCount(1_000_000), "1.0M");
  assert.equal(formatTokenCount(1_048_576), "1.0M");
  assert.equal(formatTokenCount(Number.NaN), "?");
  assert.equal(formatTokenCount(-1), "?");
});

test("formatContextUsage renders tokens, window, and percent", () => {
  const { text, details } = formatContextUsage(
    { tokens: 257_494, contextWindow: 1_000_000, percent: 25.7 },
    { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    "max",
  );
  assert.match(text, /context: 257\.5k \/ 1\.0M \(25\.7%\)/);
  assert.match(text, /model: opencode-go\/deepseek-v4\.1-flash/);
  assert.match(text, /thinking: max/);
  assert.deepEqual(details, {
    tokens: 257_494,
    contextWindow: 1_000_000,
    percent: 25.7,
    model: "opencode-go/deepseek-v4.1-flash",
    thinkingLevel: "max",
  });
});

test("formatContextUsage computes percent when absent", () => {
  const { text, details } = formatContextUsage({
    tokens: 50_000,
    contextWindow: 200_000,
    percent: null,
  });
  assert.match(text, /\(25\.0%\)/);
  assert.equal(details.percent, 25);
  assert.equal(details.model, "unknown");
});

test("formatContextUsage reports unknown tokens right after compaction", () => {
  const { text, details } = formatContextUsage(
    { tokens: null, contextWindow: 1_000_000, percent: null },
    { id: "m" },
  );
  assert.match(text, /unknown until the next response/);
  assert.match(text, /context window: 1\.0M/);
  assert.equal(details.tokens, null);
  assert.equal(details.contextWindow, 1_000_000);
});

test("formatContextUsage handles missing usage", () => {
  const { text, details } = formatContextUsage(undefined, null, null);
  assert.match(text, /context: unknown \(no active model/);
  assert.equal(details.contextWindow, null);
  assert.equal(details.model, "unknown");
});
