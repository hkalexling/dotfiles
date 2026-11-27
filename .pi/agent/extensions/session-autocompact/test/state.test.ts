import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_NAME,
  createRecord,
  CUSTOM_TYPE,
  formatChangeText,
  formatFooterText,
  formatStatusText,
  formatThresholdChangeText,
  formatTokens,
  isValidThresholdTokens,
  MIN_THRESHOLD_TOKENS,
  parseRecord,
  parseTokenCount,
  readSessionPreference,
  shortSessionId,
  STATE_VERSION,
  STATUS_KEY,
  type EntryLike,
} from "../state.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";

function record(sessionId: string, enabled: boolean, id = "e"): EntryLike {
  return { type: "custom", id, customType: CUSTOM_TYPE, data: createRecord(sessionId, enabled) };
}

test("command, custom type, and status key are stable identifiers", () => {
  assert.equal(COMMAND_NAME, "autocompact");
  assert.equal(CUSTOM_TYPE, "session-autocompact");
  assert.equal(STATUS_KEY, "session-autocompact");
  assert.equal(STATE_VERSION, 2);
});

test("createRecord writes version + sessionId + enabled + thresholdTokens only", () => {
  assert.deepEqual(createRecord(SESSION, true), {
    version: 2,
    sessionId: SESSION,
    enabled: true,
    thresholdTokens: null,
  });
  assert.deepEqual(createRecord(SESSION, undefined, 150000), {
    version: 2,
    sessionId: SESSION,
    enabled: null,
    thresholdTokens: 150000,
  });
});

test("parseRecord accepts a version-2 record with or without a limit", () => {
  assert.deepEqual(parseRecord({ version: 2, sessionId: SESSION, enabled: true, thresholdTokens: 150000, extra: 1 }), {
    version: 2,
    sessionId: SESSION,
    enabled: true,
    thresholdTokens: 150000,
  });
  assert.deepEqual(parseRecord({ version: 2, sessionId: SESSION, enabled: null, thresholdTokens: 5000 }), {
    version: 2,
    sessionId: SESSION,
    enabled: null,
    thresholdTokens: 5000,
  });
  assert.deepEqual(parseRecord({ version: 2, sessionId: SESSION, enabled: false, thresholdTokens: null }), {
    version: 2,
    sessionId: SESSION,
    enabled: false,
    thresholdTokens: null,
  });
});

test("parseRecord accepts a version-1 record and keeps extra fields out", () => {
  const parsed = parseRecord({ version: 1, sessionId: SESSION, enabled: false, extra: "ignored" });
  assert.deepEqual(parsed, { version: 1, sessionId: SESSION, enabled: false });
});

test("parseRecord rejects every shape that must not be trusted", () => {
  const cases: unknown[] = [
    undefined,
    null,
    "on",
    42,
    [],
    {},
    { version: 2, sessionId: SESSION, enabled: true },
    { version: 2, sessionId: SESSION, enabled: "true", thresholdTokens: null },
    { version: 2, sessionId: SESSION, enabled: true, thresholdTokens: 0 },
    { version: 2, sessionId: SESSION, enabled: true, thresholdTokens: 999 },
    { version: 2, sessionId: SESSION, enabled: true, thresholdTokens: 1500.5 },
    { version: 2, sessionId: SESSION, enabled: true, thresholdTokens: "150k" },
    { version: 3, sessionId: SESSION, enabled: true, thresholdTokens: null },
    { version: "1", sessionId: SESSION, enabled: true },
    { sessionId: SESSION, enabled: true },
    { version: 1, enabled: true },
    { version: 1, sessionId: "", enabled: true },
    { version: 1, sessionId: 7, enabled: true },
    { version: 1, sessionId: SESSION, enabled: "true" },
    { version: 1, sessionId: SESSION, enabled: 1 },
    { version: 1, sessionId: SESSION },
  ];
  for (const value of cases) {
    assert.equal(parseRecord(value), null, `expected null for ${JSON.stringify(value)}`);
  }
});

test("readSessionPreference: no records means no session setting", () => {
  const result = readSessionPreference([{ type: "message", id: "m" }], SESSION);
  assert.deepEqual(result, { enabled: undefined, thresholdTokens: undefined, matches: 0, ignored: 0, foreign: 0 });
});

test("readSessionPreference: the last valid record for this session wins", () => {
  const onThenOff = readSessionPreference([record(SESSION, true), record(SESSION, false)], SESSION);
  assert.equal(onThenOff.enabled, false);
  assert.equal(onThenOff.matches, 2);

  const offThenOn = readSessionPreference([record(SESSION, false), record(SESSION, true)], SESSION);
  assert.equal(offThenOn.enabled, true);
});

test("readSessionPreference: a v1 record is still read, and the last snapshot carries the limit", () => {
  const v1 = { type: "custom", id: "v1", customType: CUSTOM_TYPE, data: { version: 1, sessionId: SESSION, enabled: true } };
  assert.deepEqual(readSessionPreference([v1], SESSION).enabled, true);
  assert.equal(readSessionPreference([v1], SESSION).thresholdTokens, undefined);

  const withLimit = { type: "custom", id: "l", customType: CUSTOM_TYPE, data: createRecord(SESSION, true, 120000) };
  const result = readSessionPreference([v1, withLimit], SESSION);
  assert.equal(result.enabled, true);
  assert.equal(result.thresholdTokens, 120000);

  const cleared = { type: "custom", id: "c", customType: CUSTOM_TYPE, data: createRecord(SESSION, true, undefined) };
  assert.equal(readSessionPreference([withLimit, cleared], SESSION).thresholdTokens, undefined);

  const limitOnly = { type: "custom", id: "o", customType: CUSTOM_TYPE, data: createRecord(SESSION, undefined, 90000) };
  const onlyLimit = readSessionPreference([limitOnly], SESSION);
  assert.equal(onlyLimit.enabled, undefined, "a limit-only record is not an on/off choice");
  assert.equal(onlyLimit.thresholdTokens, 90000);
});

test("parseTokenCount and formatTokens", () => {
  assert.equal(parseTokenCount("150000"), 150000);
  assert.equal(parseTokenCount("150_000"), 150000);
  assert.equal(parseTokenCount("150,000"), 150000);
  assert.equal(parseTokenCount("150k"), 150000);
  assert.equal(parseTokenCount("150K"), 150000);
  assert.equal(parseTokenCount("1.5m"), 1500000);
  assert.equal(parseTokenCount("0.5k"), 500);
  for (const bad of ["", "abc", "-5", "1.5", "1e5", "10kb", "k", "1.2345k"]) {
    assert.equal(parseTokenCount(bad), undefined, `expected undefined for ${bad}`);
  }
  assert.equal(isValidThresholdTokens(MIN_THRESHOLD_TOKENS), true);
  assert.equal(isValidThresholdTokens(MIN_THRESHOLD_TOKENS - 1), false);
  assert.equal(formatTokens(150000), "150k");
  assert.equal(formatTokens(1500000), "1.5M");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(undefined), "unknown");
});

test("readSessionPreference: records of other sessions are skipped, not inherited", () => {
  // /fork and /clone copy the parent session's entries into a new session file
  // with a new session id, so a forked session starts with no setting.
  const result = readSessionPreference([record(PARENT, true), record(PARENT, true)], SESSION);
  assert.equal(result.enabled, undefined);
  assert.equal(result.matches, 0);
  assert.equal(result.foreign, 2);
});

test("readSessionPreference: malformed records are ignored and counted, never trusted", () => {
  const result = readSessionPreference(
    [
      record(SESSION, true, "good"),
      { type: "custom", id: "bad1", customType: CUSTOM_TYPE, data: { version: 9, sessionId: SESSION, enabled: true } },
      { type: "custom", id: "bad2", customType: CUSTOM_TYPE, data: { sessionId: SESSION, enabled: "yes" } },
      { type: "custom", id: "bad3", customType: CUSTOM_TYPE },
    ],
    SESSION,
  );
  assert.equal(result.enabled, true, "the last valid record still applies");
  assert.equal(result.matches, 1);
  assert.equal(result.ignored, 3);
});

test("readSessionPreference: a newer malformed record does not resurrect an older one", () => {
  const result = readSessionPreference(
    [
      record(SESSION, true, "good"),
      { type: "custom", id: "bad", customType: CUSTOM_TYPE, data: { version: 1, sessionId: SESSION, enabled: "no" } },
    ],
    SESSION,
  );
  assert.equal(result.enabled, true);
  assert.equal(result.ignored, 1);
});

test("readSessionPreference: other extensions' custom entries are not ours", () => {
  const result = readSessionPreference(
    [{ type: "custom", id: "x", customType: "some-other-extension", data: createRecord(SESSION, true) }],
    SESSION,
  );
  assert.deepEqual(result, { enabled: undefined, thresholdTokens: undefined, matches: 0, ignored: 0, foreign: 0 });
});

test("readSessionPreference: entries on an abandoned branch still count (getEntries, not getBranch)", () => {
  // Append order of getEntries(): the record was appended on a branch that was
  // later abandoned by /tree navigation. The session-wide choice survives.
  const entries: EntryLike[] = [
    { type: "message", id: "u1" },
    record(SESSION, true, "rec-on-abandoned-branch"),
    { type: "message", id: "u2" },
    { type: "branch_summary", id: "bs" },
    { type: "message", id: "u3" },
  ];
  const branch = [entries[0], entries[2], entries[3], entries[4]];
  assert.equal(readSessionPreference(branch, SESSION).enabled, undefined);
  assert.equal(readSessionPreference(entries, SESSION).enabled, true);
});

test("shortSessionId shortens and survives missing ids", () => {
  assert.equal(shortSessionId(SESSION), "11111111");
  assert.equal(shortSessionId("abc"), "abc");
  assert.match(shortSessionId(""), /\(unknown\)/);
});

test("formatStatusText: enabled session says only this session is affected", () => {
  const text = formatStatusText({
    sessionId: SESSION,
    preference: true,
    honored: true,
    supported: true,
    effectiveEnabled: true,
    globalEnabled: false,
    settingsReadable: true,
  });
  assert.match(text, /auto-compact: ON for this session only/);
  assert.match(text, /set by \/autocompact on/);
  assert.match(text, /session setting recorded by this extension: on/);
  assert.match(text, /what Pi would use in this session \(effective\): on/);
  assert.match(text, /global compaction\.enabled: off \(this command never writes it; other sessions are not affected\)/);
  assert.match(text, /keeps its setting across \/resume and \/reload/);
  assert.match(text, /new sessions, \/fork and \/clone start without one/);
  assert.match(text, /reserveTokens, keepRecentTokens/);
  assert.match(text, /confirmed with the live Pi settings instance: yes/);
  assert.doesNotMatch(text, /WARNING/);
  assert.doesNotMatch(text, /unknown/);
});

test("formatStatusText: unconfirmed override warns instead of pretending", () => {
  const text = formatStatusText({
    sessionId: SESSION,
    preference: true,
    honored: false,
    supported: true,
    effectiveEnabled: false,
    globalEnabled: false,
    settingsReadable: true,
  });
  assert.match(text, /could not confirm/);
  assert.match(text, /confirmed with the live Pi settings instance: no/);
  assert.match(text, /WARNING/);
});

test("formatStatusText: session off explains the pin", () => {
  const text = formatStatusText({
    sessionId: SESSION,
    preference: false,
    honored: true,
    supported: true,
    effectiveEnabled: false,
    globalEnabled: true,
    settingsReadable: true,
  });
  assert.match(text, /auto-compact: OFF for this session only/);
  assert.match(text, /pinned by \/autocompact off/);
  assert.match(text, /global compaction\.enabled: on/);
  assert.match(text, /what Pi would use in this session \(effective\): off/);
});

test("formatStatusText: no session setting reports what the settings actually say", () => {
  const text = formatStatusText({
    sessionId: SESSION,
    preference: undefined,
    honored: false,
    supported: true,
    effectiveEnabled: false,
    globalEnabled: false,
    settingsReadable: true,
    foreignEntries: 2,
    ignoredEntries: 1,
  });
  assert.match(text, /off for this session \(11111111\) - no session setting; the settings disable it/);
  assert.match(text, /what Pi would use in this session \(effective\): off/);
  assert.match(text, /global compaction\.enabled: off/);
  assert.match(text, /skipped 2 record\(s\) belonging to other sessions/);
  assert.match(text, /ignored 1 unrecognized session-autocompact entry/);
  assert.doesNotMatch(text, /confirmed with the live Pi settings instance/);
  assert.doesNotMatch(text, /unknown/);
});

test("formatStatusText: a project override is shown separately from the global setting", () => {
  const text = formatStatusText({
    sessionId: SESSION,
    preference: undefined,
    honored: false,
    supported: true,
    effectiveEnabled: true,
    globalEnabled: false,
    projectEnabled: true,
    settingsReadable: true,
  });
  assert.match(text, /ON for this session \(11111111\) - no session setting; the settings enable it/);
  assert.match(text, /global compaction\.enabled: off/);
  assert.match(text, /project compaction\.enabled: on \(project settings file, not written by this command\)/);
});

test("formatStatusText: unreadable settings are reported as unknown, not guessed", () => {
  const text = formatStatusText({
    sessionId: SESSION,
    preference: undefined,
    honored: false,
    supported: true,
    settingsReadable: false,
  });
  assert.match(text, /auto-compact: unknown for this session/);
  assert.match(text, /the settings instance could not be read/);
  assert.match(text, /what Pi would use in this session \(effective\): unknown/);
  assert.match(text, /global compaction\.enabled: unknown/);
  assert.match(text, /reported as unknown rather than guessed/);
});

test("formatStatusText: unsupported builds fail closed and say nothing was written", () => {
  const text = formatStatusText({
    sessionId: SESSION,
    preference: undefined,
    honored: false,
    supported: false,
    unsupportedReason: "SettingsManager is not available in this Pi build",
    settingsReadable: false,
  });
  assert.match(text, /unavailable in this Pi build/);
  assert.match(text, /SettingsManager is not available/);
  assert.match(text, /nothing was changed and no setting was written/);
  assert.match(text, /global compaction\.enabled: unknown/);
  assert.doesNotMatch(text, /change it with: \/autocompact/);
});

test("formatChangeText: only the current session, global untouched", () => {
  const on = formatChangeText(
    { sessionId: SESSION, preference: true, honored: true, supported: true, globalEnabled: false },
    true,
  );
  assert.match(on, /ON for this session only/);
  assert.match(on, /Nothing was compacted now/);
  assert.match(on, /global compaction\.enabled stays off/);
  assert.match(on, /only this session \(11111111\) is affected/);
  assert.doesNotMatch(on, /WARNING/);

  const off = formatChangeText(
    { sessionId: SESSION, preference: false, honored: false, supported: true, globalEnabled: false },
    false,
  );
  assert.match(off, /OFF for this session only/);
  assert.match(off, /Manual \/compact still works/);
  assert.match(off, /WARNING: Pi did not confirm/);
});

test("formatChangeText: an effective value that disagrees is reported", () => {
  const text = formatChangeText(
    {
      sessionId: SESSION,
      preference: true,
      honored: true,
      supported: true,
      effectiveEnabled: false,
      globalEnabled: false,
      settingsReadable: true,
    },
    true,
  );
  assert.match(text, /WARNING: Pi reports the effective value as off/);
});

test("formatFooterText: status is visible only when enabled", () => {
  const enabled = { sessionId: SESSION, preference: true, honored: true, supported: true, globalEnabled: false };
  assert.equal(formatFooterText(enabled), "auto-compact: on (this session)");
  assert.equal(
    formatFooterText({ ...enabled, honored: false }),
    "auto-compact: on (unconfirmed)",
  );
  assert.equal(formatFooterText({ ...enabled, preference: false }), undefined);
  assert.equal(formatFooterText({ ...enabled, preference: undefined }), undefined);
  assert.equal(
    formatFooterText({ ...enabled, preference: undefined, supported: false }),
    undefined,
    "an unsupported build does not get a permanent footer note",
  );
  assert.equal(
    formatFooterText({ ...enabled, honored: false, supported: false }),
    "auto-compact: on (unconfirmed)",
    "a stored setting that could not be applied is shown as unconfirmed",
  );
});

test("formatStatusText: a session limit reports the trigger Pi uses", () => {
  const text = formatStatusText({
    sessionId: SESSION,
    preference: true,
    honored: true,
    supported: true,
    effectiveEnabled: true,
    globalEnabled: false,
    settingsReadable: true,
    thresholdTokens: 150000,
    thresholdConfirmed: true,
    modelLabel: "anthropic/claude",
    contextWindow: 1000000,
    nativeTriggerTokens: 983616,
    effectiveTriggerTokens: 150000,
    keepRecentTokens: 20000,
  });
  assert.match(text, /compaction limit for this session: 150k tokens \(150000\)/);
  assert.match(text, /Pi compacts once context exceeds: 150k tokens \(anthropic\/claude, 1M window\)/);
  assert.match(text, /reserveTokens is only ever raised/);
  assert.doesNotMatch(text, /WARNING/);
  assert.doesNotMatch(text, /no effect/);
});

test("formatStatusText: limit notes for no-effect, unconfirmed, no window, close to keepRecent", () => {
  const base = {
    sessionId: SESSION,
    preference: true,
    honored: true,
    supported: true,
    effectiveEnabled: true,
    globalEnabled: false,
    settingsReadable: true,
    keepRecentTokens: 20000,
  };
  const above = formatStatusText({
    ...base,
    thresholdTokens: 500000,
    thresholdConfirmed: true,
    contextWindow: 200000,
    nativeTriggerTokens: 183616,
    effectiveTriggerTokens: 183616,
  });
  assert.match(above, /has no effect with this model/);

  const unconfirmed = formatStatusText({ ...base, thresholdTokens: 100000, thresholdConfirmed: false, contextWindow: 200000 });
  assert.match(unconfirmed, /WARNING: could not confirm that Pi's threshold check sees this limit/);

  const noWindow = formatStatusText({ ...base, thresholdTokens: 100000 });
  assert.match(noWindow, /reports no context window/);

  const tight = formatStatusText({ ...base, thresholdTokens: 30000, thresholdConfirmed: true, contextWindow: 200000 });
  assert.match(tight, /close to keepRecentTokens \(20k\)/);

  const none = formatStatusText({ ...base, contextWindow: 200000, nativeTriggerTokens: 183616, effectiveTriggerTokens: 183616, modelLabel: "x/y" });
  assert.match(none, /compaction limit: none for this session/);
  assert.match(none, /Pi compacts once context exceeds: 183\.6k tokens \(x\/y, 200k window\)/);
  assert.match(none, /token budgets \(reserveTokens, keepRecentTokens\) and per-model overrides are unchanged/);
});

test("formatThresholdChangeText: set, cleared, and compaction off", () => {
  const set = formatThresholdChangeText({
    sessionId: SESSION,
    preference: true,
    honored: true,
    supported: true,
    thresholdTokens: 150000,
    thresholdConfirmed: true,
    contextWindow: 1000000,
    effectiveTriggerTokens: 150000,
  });
  assert.match(set, /limit set for this session: .* 150k tokens/);
  assert.doesNotMatch(set, /currently off/);
  assert.match(set, /only this session \(11111111\) is affected/);

  const off = formatThresholdChangeText({ sessionId: SESSION, preference: undefined, effectiveEnabled: false, honored: true, supported: true, thresholdTokens: 150000 });
  assert.match(off, /currently off for this session; the limit applies once it is on/);

  const cleared = formatThresholdChangeText({ sessionId: SESSION, preference: true, honored: true, supported: true });
  assert.match(cleared, /limit cleared/);
});

test("formatFooterText: shows the limit when set", () => {
  assert.equal(
    formatFooterText({ sessionId: SESSION, preference: true, honored: true, supported: true, thresholdTokens: 150000 }),
    "auto-compact: on @ 150k (this session)",
  );
});
