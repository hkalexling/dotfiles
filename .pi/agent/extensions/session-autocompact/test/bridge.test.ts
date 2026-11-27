import { test } from "node:test";
import assert from "node:assert/strict";

import {
  attachSessionCompactionOverride,
  captureSettingsManager,
  globalCompactionEnabled,
  applyCompactionThreshold,
  readSettingViews,
  readThresholdView,
  settingsManagerSupportError,
  verifySessionCompactionOverride,
  verifySessionCompactionThreshold,
  type BridgeResult,
  type SettingsManagerLike,
} from "../native-bridge.ts";

/** Stand-in for a Pi 1.5.2 SettingsManager instance: same method shapes. */
class FakeSettingsManager {
  globalCompaction = { enabled: false };
  projectCompaction: { enabled?: boolean } = {};
  getSettingsCalls = 0;

  getSettings() {
    this.getSettingsCalls += 1;
    return structuredClone({ compaction: structuredClone(this.globalCompaction) });
  }

  getGlobalSettings() {
    return structuredClone({ compaction: structuredClone(this.globalCompaction) });
  }

  getProjectSettings() {
    return structuredClone({ compaction: structuredClone(this.projectCompaction) });
  }

  getCompactionEnabled() {
    return Boolean(this.getSettings().compaction?.enabled);
  }

  getCompactionSettings(model?: unknown) {
    const enabled = this.getCompactionEnabled();
    return { enabled, reserveTokens: model === "gpt-5" ? 8000 : 16384, keepRecentTokens: 20000 };
  }
}

function fake(overrides: { global?: boolean; project?: boolean } = {}): FakeSettingsManager {
  const manager = new FakeSettingsManager();
  manager.globalCompaction = { enabled: overrides.global ?? false };
  if (overrides.project !== undefined) {
    manager.projectCompaction = { enabled: overrides.project };
  }
  return manager;
}

function ok<T>(result: BridgeResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected success, got: ${result.error}`);
  }
  return result.value;
}

test("settingsManagerSupportError describes what is missing", () => {
  const error = settingsManagerSupportError(
    { getSettings: () => ({}) },
    "the session settings instance",
  );
  assert.ok(error);
  assert.match(error, /getCompactionEnabled/);
  assert.match(error, /getCompactionSettings/);
  assert.match(error, /Pi 1\.5\.x/);

  assert.match(settingsManagerSupportError(() => {}, "SettingsManager")!, /has no prototype\/instance methods/);
  assert.match(settingsManagerSupportError({}, "SettingsManager")!, /missing getSettings/);
  assert.equal(settingsManagerSupportError(FakeSettingsManager, "SettingsManager"), undefined);
});

test("settingsManagerSupportError treats accessor methods as unsupported", () => {
  class WithAccessor extends FakeSettingsManager {}
  Object.defineProperty(WithAccessor.prototype, "getCompactionEnabled", {
    get: () => false,
    configurable: true,
    enumerable: false,
  });
  const error = settingsManagerSupportError(WithAccessor, "SettingsManager");
  assert.ok(error);
  assert.match(error, /getCompactionEnabled \(accessor\)/);
});

test("captureSettingsManager returns a structured error when the class is unsupported", () => {
  const result = captureSettingsManager(Object, () => ({}));
  assert.equal(result.ok, false);
  assert.match(result.error, /missing getSettings/);
});

test("captureSettingsManager reports a frozen prototype instead of throwing", () => {
  class Manager extends FakeSettingsManager {
    override getSettings() {
      return super.getSettings();
    }
  }
  Object.freeze(Manager.prototype);
  const before = Object.getOwnPropertyDescriptor(Manager.prototype, "getSettings");

  const result = captureSettingsManager(Manager, () => undefined);

  assert.equal(result.ok, false);
  assert.match(result.error, /cannot be wrapped temporarily/);
  assert.match(result.error, /not reachable/);
  assert.deepEqual(Object.getOwnPropertyDescriptor(Manager.prototype, "getSettings"), before);
});

test("captureSettingsManager reaches the live instance and restores the prototype", () => {
  const original = FakeSettingsManager.prototype.getSettings;
  const instance = fake({ global: true });
  const settings = { getSettings: () => instance.getSettings() };

  const captured = ok(
    captureSettingsManager(FakeSettingsManager, () => settings.getSettings()),
  );

  assert.equal(captured, instance);
  assert.notEqual(captured, settings);
  assert.equal(FakeSettingsManager.prototype.getSettings, original);
  assert.equal(captured.getCompactionEnabled(), true);
});

test("captureSettingsManager restores the prototype even if pi.getSettings() throws", () => {
  const original = FakeSettingsManager.prototype.getSettings;
  const captured = captureSettingsManager(FakeSettingsManager, () => {
    throw new Error("boom");
  });
  assert.equal(captured.ok, false);
  assert.match(captured.error, /pi\.getSettings\(\) failed/);
  assert.equal(FakeSettingsManager.prototype.getSettings, original);
});

test("captureSettingsManager reports a prototype it could not put back", () => {
  class Hostile extends FakeSettingsManager {
    override getSettings() {
      return super.getSettings();
    }
  }
  const original = Hostile.prototype.getSettings;
  const instance = new Hostile();

  const result = captureSettingsManager(Hostile, () => {
    // Reach the instance first, then make the property impossible to restore.
    const settings = instance.getSettings();
    Object.defineProperty(Hostile.prototype, "getSettings", {
      value: function foreign() {
        return {};
      },
      configurable: false,
      writable: false,
    });
    return settings;
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /could not restore getSettings/);
  assert.match(result.error, /was left on SettingsManager\.prototype/);
  assert.notEqual(Hostile.prototype.getSettings, original, "the foreign method is left in place, as reported");
});

test("captureSettingsManager fails closed when no instance is reached", () => {
  const result = captureSettingsManager(FakeSettingsManager, () => undefined);
  assert.equal(result.ok, false);
  assert.match(result.error, /never reached SettingsManager\.prototype\.getSettings/);
});

test("attach writes nothing and does not change the global setting", () => {
  const manager = fake({ global: false });
  const settingsBefore = structuredClone(manager.globalCompaction);
  const callsBefore = manager.getSettingsCalls;

  const handle = ok(attachSessionCompactionOverride(manager, { read: () => undefined }));

  assert.equal(manager.getCompactionEnabled(), false);
  assert.deepEqual(structuredClone(manager.globalCompaction), settingsBefore);
  assert.ok(manager.getSettingsCalls >= callsBefore, "reading settings is allowed, writing is not");
  assert.equal(verifySessionCompactionOverride(manager, false, false).ok, true);
  handle.detach();
});

test("the override is visible through getCompactionEnabled and getSettings", () => {
  const manager = fake({ global: false });
  const handle = ok(attachSessionCompactionOverride(manager, { read: () => true }));

  assert.equal(manager.getCompactionEnabled(), true);
  assert.equal((manager.getSettings() as { compaction: { enabled: boolean } }).compaction.enabled, true);

  handle.detach();
  assert.equal(manager.getCompactionEnabled(), false);
  assert.equal((manager.getSettings() as { compaction: { enabled: boolean } }).compaction.enabled, false);
});

test("the native getCompactionSettings path sees the session value", () => {
  const manager = fake({ global: false });
  const handle = ok(attachSessionCompactionOverride(manager, { read: () => true }));

  assert.equal(verifySessionCompactionOverride(manager, true, false).ok, true);
  assert.equal(manager.getCompactionSettings("gpt-5")?.reserveTokens, 8000);
  assert.equal(manager.getCompactionSettings("unknown-model")?.reserveTokens, 16384);
  assert.equal(manager.getCompactionSettings()?.keepRecentTokens, 20000);

  handle.detach();
  assert.equal(manager.getCompactionSettings()?.enabled, false);
});

test("verify reads the effective settings before comparing the global value", () => {
  const order: string[] = [];
  const manager = {
    getCompactionEnabled: () => {
      order.push("enabled");
      return true;
    },
    getCompactionSettings: () => {
      order.push("native");
      return { enabled: true };
    },
    getSettings: () => {
      order.push("settings");
      // Reading the effective settings normalizes the global view in this fake.
      manager.globalCompaction.enabled = true;
      return { compaction: { enabled: true } };
    },
    getGlobalSettings: () => {
      order.push("global");
      return { compaction: structuredClone(manager.globalCompaction) };
    },
    globalCompaction: { enabled: false },
  };

  const result = verifySessionCompactionOverride(manager as SettingsManagerLike, true, false);
  assert.equal(result.ok, false);
  assert.match(result.error!, /global compaction\.enabled changed from false to true/);
  assert.deepEqual(order, ["native", "enabled", "settings", "global"]);
});

test("verifySessionCompactionOverride rejects settings it cannot read", () => {
  const throwing = {
    getCompactionEnabled: () => true,
    getCompactionSettings: () => ({ enabled: true }),
    getSettings: () => {
      throw new Error("broken");
    },
  };
  const result = verifySessionCompactionOverride(throwing as SettingsManagerLike, true, undefined);
  assert.equal(result.ok, false);
  assert.match(result.error!, /getSettings\(\) threw: broken/);

  const missing = {
    getCompactionEnabled: () => true,
    getCompactionSettings: () => ({ enabled: true }),
    getSettings: () => ({}),
  };
  const missingResult = verifySessionCompactionOverride(missing as SettingsManagerLike, true, undefined);
  assert.equal(missingResult.ok, false);
  assert.match(missingResult.error!, /does not report compaction\.enabled/);

  const nonBoolean = {
    getCompactionEnabled: () => true,
    getCompactionSettings: () => ({ enabled: true }),
    getSettings: () => ({ compaction: { enabled: "yes" } }),
  };
  const nonBooleanResult = verifySessionCompactionOverride(nonBoolean as SettingsManagerLike, true, undefined);
  assert.equal(nonBooleanResult.ok, false);
  assert.match(nonBooleanResult.error!, /not a boolean/);

  const noNativeView = {
    getCompactionEnabled: () => true,
    getSettings: () => ({ compaction: { enabled: true } }),
  };
  const nativeResult = verifySessionCompactionOverride(noNativeView as SettingsManagerLike, true, undefined);
  assert.equal(nativeResult.ok, false);
  assert.match(nativeResult.error!, /getCompactionSettings\(\)\.enabled did not report/);
});

test("the override is not inherited by a different settings instance", () => {
  const first = ok(attachSessionCompactionOverride(fake({ global: false }), { read: () => true }));
  const other = fake({ global: false });
  first.detach();
  assert.equal(other.getCompactionEnabled(), false);
});

test("attaching to a plain object or a non-instance fails", () => {
  const result = attachSessionCompactionOverride(
    { getSettings: () => ({}), getCompactionEnabled: () => false } as SettingsManagerLike,
    { read: () => true },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /missing getCompactionSettings/);

  const noRead = attachSessionCompactionOverride(fake({}), {} as never);
  assert.equal(noRead.ok, false);
  assert.match(noRead.error, /requires a read\(\) function/);

  const settingsValue = fake({});
  Object.defineProperty(settingsValue, "getSettings", { value: 1, configurable: true });
  const wrong = attachSessionCompactionOverride(settingsValue as SettingsManagerLike, { read: () => true });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /getSettings/);
});

test("a sealed settings instance fails with a reason and no residual change", () => {
  const manager = fake({ global: false });
  Object.preventExtensions(manager);

  const result = attachSessionCompactionOverride(manager, { read: () => true });

  assert.equal(result.ok, false);
  assert.match(result.error, /sealed or frozen/);
  assert.equal(manager.getCompactionEnabled(), false);
  assert.equal(Object.getOwnPropertySymbols(manager).length, 0);
});

test("a frozen settings instance fails with a reason and no residual change", () => {
  const manager = fake({ global: false });
  Object.freeze(manager);

  const result = attachSessionCompactionOverride(manager, { read: () => true });

  assert.equal(result.ok, false);
  assert.match(result.error, /sealed or frozen/);
  assert.equal(Object.isFrozen(manager), true);
  assert.equal(Object.getOwnPropertySymbols(manager).length, 0);
});

test("a non-configurable own method is refused before anything is installed", () => {
  for (const name of ["getSettings", "getCompactionEnabled"] as const) {
    const manager = fake({ global: false });
    const before = manager.getCompactionEnabled();
    Object.defineProperty(manager, name, {
      value: (manager as unknown as Record<string, unknown>)[name],
      configurable: false,
    });
    const ownBefore = Object.getOwnPropertyDescriptor(manager, name)!;
    const other = name === "getSettings" ? "getCompactionEnabled" : "getSettings";

    const result = attachSessionCompactionOverride(manager, { read: () => true });

    assert.equal(result.ok, false);
    assert.match(result.error, new RegExp(`non-configurable own ${name}\\(\\)`));
    assert.equal(manager.getCompactionEnabled(), before, "no partial override was left installed");
    assert.deepEqual(Object.getOwnPropertyDescriptor(manager, name), ownBefore, "the pre-existing own method is untouched");
    assert.equal(Object.getOwnPropertyDescriptor(manager, other), undefined, "nothing else was installed");
    assert.equal(Object.getOwnPropertySymbols(manager).length, 0, "no bookkeeping was left behind");
  }
});

test("an accessor own method is refused", () => {
  const manager = fake({ global: false });
  Object.defineProperty(manager, "getSettings", {
    get: () => ({ compaction: { enabled: false } }),
    configurable: true,
  });

  const result = attachSessionCompactionOverride(manager, { read: () => true });
  assert.equal(result.ok, false);
  assert.match(result.error, /getSettings \(accessor\)/);
  assert.ok(Object.getOwnPropertyDescriptor(manager, "getSettings")?.get, "the accessor was left as it was");
  assert.equal(Object.getOwnPropertySymbols(manager).length, 0);
});

test("a partial install is rolled back and reported", () => {
  const target = fake({ global: false });
  const host = new Proxy(target, {
    defineProperty(inner, property, descriptor) {
      if (property === "getSettings") {
        throw new Error("denied by test");
      }
      return Reflect.defineProperty(inner, property, descriptor);
    },
  }) as unknown as SettingsManagerLike;

  const result = attachSessionCompactionOverride(host, { read: () => true });

  assert.equal(result.ok, false);
  assert.match(result.error, /partially installed getCompactionEnabled and rolled back/);
  assert.match(result.error, /denied by test/);
  assert.equal(target.getCompactionEnabled(), false, "the partial override was removed again");
  assert.equal(Object.getOwnPropertyDescriptor(target, "getCompactionEnabled"), undefined);
  assert.equal(Object.getOwnPropertySymbols(target).length, 0);
});

test("a failed restore during detach is reported instead of swallowed", () => {
  const manager = fake({ global: false });
  const problems: string[] = [];
  const handle = ok(attachSessionCompactionOverride(manager, { read: () => true, report: (message) => problems.push(message) }));
  assert.equal(manager.getCompactionEnabled(), true);

  // Something makes our installed method impossible to remove between attach and detach.
  Object.defineProperty(manager, "getCompactionEnabled", {
    value: manager.getCompactionEnabled,
    configurable: false,
  });
  handle.detach();

  const descriptor = Object.getOwnPropertyDescriptor(manager, "getCompactionEnabled");
  assert.ok(descriptor, "the override could not be removed");
  assert.equal(descriptor.configurable, false);
  assert.equal(manager.getCompactionEnabled(), false, "the leftover override no longer applies a session setting");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /could not fully restore the session settings instance/);
  assert.match(problems[0], /could not restore getCompactionEnabled\(\)/);
  // getSettings was removed successfully, and the bookkeeping is gone.
  assert.equal(Object.getOwnPropertyDescriptor(manager, "getSettings"), undefined);
  assert.equal(Object.getOwnPropertySymbols(manager).length, 0);
});

test("each attachment counts separately, even the same reader function", () => {
  const manager = fake({ global: false });
  const read = () => true;
  const a = ok(attachSessionCompactionOverride(manager, { read }));
  const b = ok(attachSessionCompactionOverride(manager, { read }));

  assert.equal(manager.getCompactionEnabled(), true);

  a.detach();
  assert.equal(a.attached, false);
  assert.equal(b.attached, true);
  assert.equal(manager.getCompactionEnabled(), true, "the second attachment is still active");
  assert.equal((manager.getSettings() as { compaction: { enabled: boolean } }).compaction.enabled, true);

  b.detach();
  assert.equal(manager.getCompactionEnabled(), false);
  assert.equal(Object.getOwnPropertyDescriptor(manager, "getSettings"), undefined);

  // Idempotent detach does not restore anything twice.
  b.detach();
  assert.equal(manager.getCompactionEnabled(), false);
});

test("an attachment keeps working while another actor wraps our method", () => {
  const manager = fake({ global: false });
  const handle = ok(attachSessionCompactionOverride(manager, { read: () => true }));
  assert.equal(manager.getCompactionEnabled(), true);

  const ourGetSettings = manager.getSettings;
  const ourEnabled = manager.getCompactionEnabled;
  Object.defineProperty(manager, "getSettings", {
    value: function wrapped(this: FakeSettingsManager) {
      const settings = ourGetSettings.call(this);
      (settings as { note?: string }).note = "added by another actor";
      return settings;
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(manager, "getCompactionEnabled", {
    value: function wrappedEnabled(this: FakeSettingsManager) {
      return ourEnabled.call(this);
    },
    configurable: true,
    writable: true,
  });

  assert.equal(manager.getCompactionEnabled(), true, "the outer wrapper kept our behaviour");
  assert.equal((manager.getSettings() as { note?: string }).note, "added by another actor");

  handle.detach();

  // Our methods are not removed because they are no longer the outermost ones:
  // the outer wrapper still works, and it now sees no session setting.
  assert.equal(manager.getCompactionEnabled(), false, "the session setting is gone");
  assert.equal((manager.getSettings() as { note?: string }).note, "added by another actor", "the other actor's wrapper is intact");

  // Removing the outer wrapper reveals the untouched instance again.
  delete (manager as unknown as Record<string, unknown>).getCompactionEnabled;
  delete (manager as unknown as Record<string, unknown>).getSettings;
  assert.equal(manager.getCompactionEnabled(), false);
});

test("detach restores the instance when the last attachment is removed", () => {
  const manager = fake({ global: false });
  const settingsBefore = structuredClone(manager.getSettings());

  const read = () => true;
  const a = ok(attachSessionCompactionOverride(manager, { read }));
  const b = ok(attachSessionCompactionOverride(manager, { read }));
  assert.equal(manager.getCompactionEnabled(), true);

  a.detach();
  assert.equal(a.attached, false);
  assert.equal(b.attached, true);
  assert.equal(manager.getCompactionEnabled(), true);

  b.detach();
  assert.equal(b.attached, false);
  assert.deepEqual(structuredClone(manager.getSettings()), settingsBefore);
  assert.equal(Object.getOwnPropertyDescriptor(manager, "getSettings"), undefined);
  assert.equal(Object.getOwnPropertyDescriptor(manager, "getCompactionEnabled"), undefined);
});

test("a detached attachment reports the value it was asked for", () => {
  const manager = fake({ global: false });
  const handle = ok(attachSessionCompactionOverride(manager, { read: () => true }));
  handle.detach();
  assert.equal(manager.getCompactionEnabled(), false);
  assert.equal((manager.getSettings() as { compaction: { enabled: boolean } }).compaction.enabled, false);
});

test("globalCompactionEnabled reads the user's own setting, not the session view", () => {
  const manager = fake({ global: false });
  const handle = ok(attachSessionCompactionOverride(manager, { read: () => true }));

  assert.equal(globalCompactionEnabled(manager), false);
  assert.equal(globalCompactionEnabled(undefined), undefined);

  manager.globalCompaction.enabled = true;
  assert.equal(globalCompactionEnabled(manager), true);

  handle.detach();
});

test("readSettingViews reports what the instance actually says", () => {
  const off = fake({ global: false });
  assert.deepEqual(
    {
      readable: readSettingViews(off).readable,
      effective: readSettingViews(off).effective,
      global: readSettingViews(off).global,
      project: readSettingViews(off).project,
    },
    { readable: true, effective: false, global: false, project: undefined },
  );

  const onWithProject = fake({ global: true, project: false });
  const second = readSettingViews(onWithProject);
  assert.equal(second.effective, true);
  assert.equal(second.global, true);
  assert.equal(second.project, false);

  const handle = ok(attachSessionCompactionOverride(off, { read: () => true }));
  const third = readSettingViews(off);
  assert.equal(third.effective, true, "the session view is what Pi would use");
  assert.equal(third.global, false, "the global value is unchanged");
  handle.detach();
});

test("readSettingViews says when nothing can be read and never throws", () => {
  const none = readSettingViews(undefined);
  assert.equal(none.readable, false);
  assert.match(none.problems[0], /not reachable/);

  const broken = {
    getCompactionEnabled: () => {
      throw new Error("boom");
    },
    getSettings: () => ({ compaction: "nope" }),
    getGlobalSettings: () => {
      throw new Error("unavailable");
    },
  } as unknown as SettingsManagerLike;

  const views = readSettingViews(broken);
  assert.equal(views.readable, false);
  assert.equal(views.effective, undefined);
  assert.equal(views.global, undefined);
  assert.ok(views.problems.some((problem) => /getCompactionEnabled\(\) threw: boom/.test(problem)));
  assert.ok(views.problems.some((problem) => /getGlobalSettings\(\) threw: unavailable/.test(problem)));
});

test("several attachments on one instance are independent; the first registered reader decides", () => {
  const manager = fake({ global: false });
  const a = ok(attachSessionCompactionOverride(manager, { read: () => true }));
  const b = ok(attachSessionCompactionOverride(manager, { read: () => false }));

  assert.equal(manager.getCompactionEnabled(), true, "the first registered reader decides");

  a.detach();
  assert.equal(manager.getCompactionEnabled(), false, "with the first gone, the remaining reader decides");

  b.detach();
  assert.equal(manager.getCompactionEnabled(), false);
  assert.equal(Object.getOwnPropertyDescriptor(manager, "getCompactionEnabled"), undefined);
  assert.equal(Object.getOwnPropertySymbols(manager).length, 0);
});

const MODEL_200K = { provider: "p", id: "m", contextWindow: 200000 };

test("applyCompactionThreshold only ever raises reserveTokens and needs a context window", () => {
  const base = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
  assert.deepEqual(applyCompactionThreshold(base, MODEL_200K, 100000), { ...base, reserveTokens: 100000 });
  assert.equal(applyCompactionThreshold(base, MODEL_200K, 190000), base, "a limit above the native trigger changes nothing");
  assert.equal(applyCompactionThreshold(base, MODEL_200K, undefined), base);
  assert.equal(applyCompactionThreshold(base, undefined, 100000), base, "no model, no window");
  assert.equal(applyCompactionThreshold(base, { contextWindow: 0 }, 100000), base);
  const noReserve = { enabled: true };
  assert.equal(applyCompactionThreshold(noReserve, MODEL_200K, 100000), noReserve, "no numeric reserveTokens, nothing to raise");
  assert.equal(base.reserveTokens, 16384, "the source object was not mutated");
});

test("the threshold override moves Pi's native shouldCompact trigger to the limit", () => {
  const manager = fake({ global: false });
  let limit: number | undefined = 100000;
  const handle = ok(attachSessionCompactionOverride(manager, { read: () => true, readThreshold: () => limit }));

  // Pi: contextTokens > contextWindow - reserveTokens
  const shouldCompact = (tokens: number) => {
    const settings = manager.getCompactionSettings(MODEL_200K)!;
    return settings.enabled! && tokens > MODEL_200K.contextWindow - (settings as { reserveTokens: number }).reserveTokens;
  };
  assert.equal(shouldCompact(99999), false);
  assert.equal(shouldCompact(100001), true);
  assert.equal(manager.getCompactionSettings(MODEL_200K)?.keepRecentTokens, 20000, "keepRecentTokens is untouched");
  assert.equal(verifySessionCompactionThreshold(manager, MODEL_200K, 100000).confirmed, true);

  const view = readThresholdView(manager, MODEL_200K);
  assert.equal(view.nativeTriggerTokens, 200000 - 16384);
  assert.equal(view.triggerTokens, 100000);

  // Changing the reader's value takes effect immediately; clearing restores native.
  limit = undefined;
  assert.equal(shouldCompact(150000), false);
  assert.equal((manager.getCompactionSettings(MODEL_200K) as { reserveTokens: number }).reserveTokens, 16384);

  handle.detach();
  assert.equal(Object.getOwnPropertyDescriptor(manager, "getCompactionSettings"), undefined, "the override was removed");
});

test("a limit without an on/off preference leaves enabled to the settings", () => {
  const manager = fake({ global: false });
  const handle = ok(attachSessionCompactionOverride(manager, { read: () => undefined, readThreshold: () => 100000 }));
  assert.equal(manager.getCompactionEnabled(), false);
  assert.equal((manager.getCompactionSettings(MODEL_200K) as { reserveTokens: number }).reserveTokens, 100000);
  handle.detach();
});

test("verifySessionCompactionThreshold catches an override that is not applied", () => {
  const manager = fake({ global: false });
  const handle = ok(attachSessionCompactionOverride(manager, { read: () => true, readThreshold: () => undefined }));
  const result = verifySessionCompactionThreshold(manager, MODEL_200K, 100000);
  assert.equal(result.ok, false);
  assert.match(result.error!, /reserveTokens reported 16384, expected 100000/);

  const noWindow = verifySessionCompactionThreshold(manager, undefined, 100000);
  assert.deepEqual(noWindow, { ok: true, confirmed: false });
  handle.detach();
});

test("an invalid or throwing threshold reader never breaks Pi's settings access", () => {
  for (const readThreshold of [() => -5, () => 1.5, () => Number.NaN, () => { throw new Error("boom"); }]) {
    const manager = fake({ global: false });
    const handle = ok(attachSessionCompactionOverride(manager, { read: () => true, readThreshold: readThreshold as () => number }));
    assert.equal((manager.getCompactionSettings(MODEL_200K) as { reserveTokens: number }).reserveTokens, 16384);
    handle.detach();
  }
  const bad = attachSessionCompactionOverride(fake({}), { read: () => true, readThreshold: 5 as never });
  assert.equal(bad.ok, false);
});
