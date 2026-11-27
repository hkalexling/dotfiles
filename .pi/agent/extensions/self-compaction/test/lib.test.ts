import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectCandidates,
  contentToText,
  countDropped,
  entryPreview,
  resolveAnchor,
  type EntryLike,
} from "../lib.ts";

const branch: EntryLike[] = [
  { id: "root", parentId: null, type: "model_change" },
  {
    id: "sys",
    parentId: "root",
    type: "message",
    message: { role: "system", content: [{ type: "text", text: "system prompt" }] },
  },
  {
    id: "u1",
    parentId: "sys",
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "first task alpha" }] },
  },
  {
    id: "a1",
    parentId: "u1",
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "working on alpha" },
        { type: "toolCall", id: "t", name: "read", arguments: {} },
      ],
    },
  },
  {
    id: "t1",
    parentId: "a1",
    type: "message",
    message: { role: "toolResult", content: [{ type: "text", text: "file contents" }] },
  },
  {
    id: "u2",
    parentId: "t1",
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "second task beta" }] },
  },
  {
    id: "a2",
    parentId: "u2",
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "done beta" }] },
  },
  { id: "bs", parentId: "a2", type: "branch_summary", summary: "summary of gamma" },
  {
    id: "u3",
    parentId: "bs",
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "third task gamma" }] },
  },
];

test("contentToText handles strings, text parts, and ignores non-text parts", () => {
  assert.equal(contentToText("hello"), "hello");
  assert.equal(
    contentToText([
      { type: "text", text: "a" },
      { type: "toolCall", id: "x" },
      { type: "text", text: "b" },
    ]),
    "a\nb",
  );
  assert.equal(contentToText(undefined), "");
  assert.equal(contentToText(42), "");
});

test("collectCandidates: user scope selects only user messages", () => {
  const candidates = collectCandidates(branch, "user");
  assert.deepEqual(
    candidates.map((c) => c.id),
    ["u1", "u2", "u3"],
  );
  assert.equal(candidates[0].kind, "user");
  assert.match(candidates[1].preview, /second task beta/);
});

test("collectCandidates: all scope excludes system and bookkeeping entries", () => {
  const candidates = collectCandidates(branch, "all");
  assert.deepEqual(
    candidates.map((c) => c.id),
    ["u1", "a1", "t1", "u2", "a2", "bs", "u3"],
  );
  assert.equal(candidates[5].kind, "branch-summary");
});

test("resolveAnchor: positive indices count from the oldest candidate", () => {
  const first = resolveAnchor(branch, "0", "user");
  assert.ok(first.ok);
  assert.equal(first.candidate.id, "u1");
  assert.equal(first.index, 0);
  assert.equal(first.total, 3);

  const second = resolveAnchor(branch, "1", "user");
  assert.ok(second.ok);
  assert.equal(second.candidate.id, "u2");
});

test("resolveAnchor: negative indices count back from the newest candidate", () => {
  const last = resolveAnchor(branch, "-1", "user");
  assert.ok(last.ok);
  assert.equal(last.candidate.id, "u3");

  const beforeLast = resolveAnchor(branch, "-2", "user");
  assert.ok(beforeLast.ok);
  assert.equal(beforeLast.candidate.id, "u2");

  const oldest = resolveAnchor(branch, "-3", "user");
  assert.ok(oldest.ok);
  assert.equal(oldest.candidate.id, "u1");
});

test("resolveAnchor: out-of-range indices are errors with candidate hints", () => {
  const high = resolveAnchor(branch, "3", "user");
  assert.ok(!high.ok);
  assert.match(high.error, /out of range/);
  assert.match(high.error, /\[0\] user:/);

  const low = resolveAnchor(branch, "-4", "user");
  assert.ok(!low.ok);
  assert.match(low.error, /out of range/);
});

test("resolveAnchor: unique search phrase resolves (case-sensitive)", () => {
  const unique = resolveAnchor(branch, "second task", "user");
  assert.ok(unique.ok);
  assert.equal(unique.candidate.id, "u2");

  const upper = resolveAnchor(branch, "SECOND TASK", "user");
  assert.ok(!upper.ok);
  assert.match(upper.error, /no entry/);
});

test("resolveAnchor: absent search phrase reports candidates", () => {
  const missing = resolveAnchor(branch, "does-not-exist", "user");
  assert.ok(!missing.ok);
  assert.match(missing.error, /no entry on the active branch matched/);
  assert.match(missing.error, /Candidates \(oldest first\)/);
});

test("resolveAnchor: ambiguous search phrase reports the matching indices", () => {
  const ambiguous = resolveAnchor(branch, "task", "user");
  assert.ok(!ambiguous.ok);
  assert.match(ambiguous.error, /ambiguous anchor/);
  assert.match(ambiguous.error, /indices 0, 1, 2/);
});

test("resolveAnchor: empty anchor and empty scope are errors", () => {
  const empty = resolveAnchor(branch, "   ", "user");
  assert.ok(!empty.ok);
  assert.match(empty.error, /empty/);

  const noCandidates = resolveAnchor(
    [{ id: "root", parentId: null, type: "model_change" }],
    "0",
    "user",
  );
  assert.ok(!noCandidates.ok);
  assert.match(noCandidates.error, /no candidates/);
});

test("countDropped: user target drops the target and everything after it", () => {
  const u2 = branch.find((e) => e.id === "u2")!;
  // new leaf = t1 (index 4); abandoned: u2, a2, bs, u3
  assert.equal(countDropped(branch, u2), 4);
});

test("countDropped: non-user target keeps the target", () => {
  const a2 = branch.find((e) => e.id === "a2")!;
  // new leaf = a2 (index 6); abandoned: bs, u3
  assert.equal(countDropped(branch, a2), 2);

  const bs = branch.find((e) => e.id === "bs")!;
  assert.equal(countDropped(branch, bs), 1);
});

test("countDropped: first user message drops the whole branch", () => {
  const u1 = branch.find((e) => e.id === "u1")!;
  // new leaf = sys (index 1); abandoned: u1, a1, t1, u2, a2, bs, u3
  assert.equal(countDropped(branch, u1), 7);
});

test("entryPreview truncates long text", () => {
  const long: EntryLike = {
    id: "x",
    parentId: null,
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "x".repeat(500) }] },
  };
  const preview = entryPreview(long);
  assert.ok(preview.length < 120);
  assert.match(preview, /…/);
});
