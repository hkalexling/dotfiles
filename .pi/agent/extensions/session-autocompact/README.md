# session-autocompact

Opt **one session** into Pi's native auto-compaction while the global
`compaction.enabled` setting stays `false`.

Nothing is compacted by turning it on: it only allows Pi's own threshold /
overflow checks to run in this session. Optionally, a per-session **compaction
limit** makes Pi's native threshold fire once the context exceeds a fixed token
count instead of near the model's full context window. Without a limit, token
budgets (`reserveTokens`, `keepRecentTokens`) and `compaction.modelOverrides`
are untouched. No global setting is ever written.

## Commands

| Command | Effect |
|---|---|
| `/autocompact` or `/autocompact status` | Reads the live settings instance, then reports this session's setting, what Pi would actually use here, the global value, and whether Pi confirmed the setting |
| `/autocompact on` | Pi's native scheduler is allowed for this session from the next context check |
| `/autocompact off` | This session is pinned off, even if the global setting changes later |
| `/autocompact on <tokens>` | Same as `on`, and sets the compaction limit in one step |
| `/autocompact limit <tokens>` | Sets the session's compaction limit (keeps the on/off choice) |
| `/autocompact limit off` | Clears the limit (`none`, `clear`, `reset` also work) |

`<tokens>` accepts `150000`, `150_000`, `150,000`, `150k`, `1.5m`; the minimum is
1k. While enabled, a footer status is shown: `auto-compact: on (this session)`,
or `auto-compact: on @ 150k (this session)` with a limit.

### Compaction limit

Pi's native check is `contextTokens > contextWindow - reserveTokens`. With a
limit, the bridge raises the `reserveTokens` that `getCompactionSettings(model)`
reports to `max(native reserveTokens, model.contextWindow - limit)`, so the same
native check fires at the limit. Consequences:

- it can only make compaction **earlier**; a limit at or above the model's native
  trigger has no effect (status says so);
- it follows model switches: the reserve is computed from whichever model Pi
  passes in;
- `keepRecentTokens`, overflow recovery, and the summary itself are unchanged
  (in Pi 1.5.2 / 1.6.0 these `reserveTokens` feed only the threshold check);
- a limit is independent of on/off: it is stored even while auto-compaction is
  off and applies once it is on, whether via this extension or the settings;
- a limit close to `keepRecentTokens` can make compaction repeat quickly; status
  warns about that;
- models that report no context window are left alone (Pi skips the threshold
  check for them anyway).

`/autocompact status` shows the limit and the trigger Pi actually uses for the
current model, e.g. `Pi compacts once context exceeds: 150k tokens
(anthropic/claude-opus, 1M window)`.
Every message says what changed for **this session only**. There is no
LLM-facing tool.

Example (`/autocompact status`, a session with no setting of its own):

```text
auto-compact: off for this session (11111111) - no session setting; the settings disable it
  what Pi would use in this session (effective): off
  global compaction.enabled: off (this command never writes it; other sessions are not affected)
  this session keeps its setting across /resume and /reload; new sessions, /fork and /clone start without one
  compaction limit: none for this session - Pi uses the model's context window minus reserveTokens
  Pi compacts once context exceeds: 111.6k tokens (provider/model, 128k window)
  this session keeps its setting across /resume and /reload; new sessions, /fork and /clone start without one
  token budgets (reserveTokens, keepRecentTokens) and per-model overrides are unchanged
  change it with: /autocompact [on [<tokens>]|off|limit <tokens>|limit off|status]
```

Values are only printed as `on`/`off` when they were actually read. When the
settings instance cannot be reached, status says `unknown` and says so, instead
of guessing `off`. A project `compaction.enabled`, when one exists, is shown on
its own line so a project override is not mistaken for the user's global setting.

## Behaviour

| Situation | Result |
|---|---|
| New session | No session setting → follows Pi's effective settings (off in a `compaction.enabled: false` setup) |
| `/autocompact on`, `off`, or `limit` | Stored as a durable custom entry `{ version: 2, sessionId, enabled, thresholdTokens }` (a full snapshot; `null` = unset) and re-applied on `/resume` and `/reload`. Older version-1 records `{ version: 1, sessionId, enabled }` are still read |
| `/fork`, `/clone` | No setting of their own: the copied records carry the parent's session id and are ignored, so a fork/clone follows the settings |
| `/tree` navigation | No effect: the reading scans all session entries (`getEntries`), not the current branch, so a session-wide choice is not undone by navigation |
| A record Pi cannot interpret | Ignored and counted in `/autocompact status`; never trusted |
| Settings saved, reloaded, or model switches | The session value still applies; token budgets follow Pi's own resolution |
| Two runtimes in one process (SDK use) | Each extension instance keeps its own session state in its factory closure; one session cannot apply, undo, or detach another session's setting |
| Manual `/compact` | Always available, on or off |

`off` is an explicit pin. Without a setting of its own a session simply follows
Pi's effective settings, so such sessions behave exactly like any other session.

## Why not `AgentSession.setAutoCompactionEnabled()`?

In Pi 1.5.2 that delegates to `SettingsManager.setCompactionEnabled()`, which
writes the **global** setting. There is no public setter for a session-scoped
value: `pi.getSettings()` returns a `structuredClone`, and
`applyOverrides()` is reset by the next settings save. `ctx.compact()` is a
manual compaction that aborts the active run, not the native scheduler.

`native-bridge.ts` therefore does the one implementation-sensitive trick:

1. briefly wrap `SettingsManager.prototype.getSettings`, call
   `pi.getSettings()`, capture `this`, and put the shared prototype back
   immediately (strictly synchronous, no `await`). A prototype that cannot be
   wrapped, or cannot be put back, is reported as a structured error instead of
   being left half-patched;
2. install **instance** overrides for `getCompactionEnabled` and `getSettings`
   that consult the session value. `getCompactionSettings()` calls
   `getCompactionEnabled()`, and every native threshold / overflow path calls
   `getCompactionSettings(model)`, so Pi's scheduler honours the session value.
   A third instance override on `getCompactionSettings(model)` applies the
   optional compaction limit by raising `reserveTokens` (see above); without a
   limit it passes Pi's result through unchanged;
3. on `session_shutdown` (and before any re-attach) put that instance's own
   properties back, reference-counted per attachment and identity-guarded, so a
   wrapper another actor installed over ours is never clobbered.

Installability is checked before anything changes (extensible instance, no
accessor own method, no non-configurable own method), and installation itself is
transactional: if a `defineProperty` fails part-way, the partial override and the
bookkeeping are rolled back and the failure is returned as a reason. The one
failure that has no return value — a restore that fails during `detach()` — is
handed to a `report` callback the extension shows as a warning. Several
attachments on one instance are independent; the first one that reports a boolean
decides, so a later attachment cannot silently override an earlier session.

Capture and attach are feature-checked and verified after attaching:
`getCompactionSettings()`, `getCompactionEnabled()`, and `getSettings()` must all
report the session value, the effective settings must be readable, and the global
value must be unchanged. Verification reads the effective settings *before* the
global ones, because a settings getter may normalize settings as a side effect.
With a limit, `getCompactionSettings(model)` for the current model must also
report the expected raised `reserveTokens`. If any assumption no longer holds,
the patch is removed and `/autocompact`
reports why instead of claiming a setting it cannot apply. `session_start` can
fire twice for one session replacement in this Pi version; attaching is
idempotent, and a previous attachment is dropped first.

## Version and shim risk

This targets Pi **1.5.2 / 1.6.0** behaviour (both have identical compaction
settings internals). If Pi changes its settings internals:

- the extension keeps loading (the class is looked up, not imported directly);
- `/autocompact` answers `unavailable in this Pi build` with the reason, changes
  nothing, and writes no setting;
- `/autocompact status` reports whatever values it can read and marks the rest
  `unknown`; it never presents an unreadable value as `off`.

If Pi stops exporting `SettingsManager` at all, the extension factory still
loads; only the bridge reports the limitation, and no setting value can be read.

## Files

| File | Role |
|---|---|
| `index.ts` | Extension entry: command, session lifecycle, status display, per-instance session state |
| `native-bridge.ts` | The only code that touches Pi internals; feature checks, transactional install/restore |
| `state.ts` | Pure, Pi-free state reading/validation and message formatting |
| `test/*.test.ts` | Unit tests plus isolated integration tests against the installed Pi |

Only `index.ts` is discovered; helper files are not loaded as extensions.

## Tests

```bash
cd ~/.pi/agent/extensions/session-autocompact
node --test test/*.test.ts
```

- `test/state.test.ts` — record validation (v1 and v2), token-count parsing,
  limit status/footer text, last-valid-record-wins, session
  filtering (fork/clone), abandoned-branch records, malformed entries, and status
  text for on/off/unset/project-override/unreadable/unsupported cases.
- `test/bridge.test.ts` — the limit moves a `shouldCompact`-equivalent trigger,
  only ever raises `reserveTokens`, is verified, and ignores invalid readers; capture and prototype restoration, structured failures
  for frozen, sealed, accessor, and non-configurable targets, rollback of a
  partial install, reported restore failures, per-attachment reference counting
  (including the same reader twice), no clobbering of another actor's wrapper,
  `getSettings` copy integrity, verification that rejects unreadable or invalid
  effective settings, global-vs-session views, and no lingering process-wide patch.
- `test/instances.test.ts` — loads the real `index.ts` twice in one process
  against two mock runtimes with real `SettingsManager` instances: one session's
  `on`, `off`, and shutdown cannot leak into or detach the other's setting.
- `test/cli.test.ts` — spawns the installed bundled CLI in a throwaway agent
  directory with a local dummy provider (no credentials, no network, no paid
  summary): command registration and discovery, default off with truthful status,
  `/autocompact on`, visible status, confirmed effective/global values, durable
  record, `/autocompact on 100k` applied to the real settings instance and
  restored after `/reload`, `limit off`, rejected bad limits, `/clone` default off with the parent's record ignored, `/new` off with
  no leftover patch, `/resume` restores, `/reload` restores, `/autocompact off`
  writes an explicit record, bad arguments change nothing, `settings.json` stays
  `compaction.enabled: false`.

`PI_AUTOCOMPACT_SKIP_CLI=1` skips the CLI test, and a missing bundled CLI skips
it too; both are reported as skipped tests, never as passing ones.
`test/instances.test.ts` skips itself the same way when the installed Pi package
is not found. Point the CLI test at another CLI with
`PI_AUTOCOMPACT_CLI=<path>`, and the package lookup with
`PI_AUTOCOMPACT_PACKAGE=<path>`.

### Typecheck (out of tree)

No `tsconfig.json` or devDependency is added to the extension. Type-check it from a
scratch directory with TypeScript 5.9 and `@types/node` installed there:

```jsonc
// /tmp/pi-autocompact-typecheck/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2023", "module": "nodenext", "moduleResolution": "nodenext",
    "strict": true, "noEmit": true, "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true, "skipLibCheck": true, "types": ["node"],
    "paths": {
      "@earendil-works/pi-coding-agent": ["<release>/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts"],
      "@earendil-works/pi-tui": ["<release>/node_modules/@earendil-works/pi-tui/dist/index.d.ts"]
    }
  },
  "include": ["<agent>/extensions/session-autocompact/**/*.ts"]
}
```

`npx tsc -p tsconfig.json` reports no errors against the installed Pi 1.6.0
declaration files.

## Known limitations

- The bridge depends on Pi 1.5.2's settings internals; if those change, the
  extension reports itself unavailable for that build instead of approximating.
- Reaching the live settings instance is a temporary synchronous wrap of
  `SettingsManager.prototype.getSettings`. It is restored immediately, and a
  wrap that could not be restored is reported rather than hidden.
- A session setting is applied by patching that session's settings instance; it
  is not a Pi setting, so it is not visible in `settings.json`, in other
  sessions, or in a Pi UI that reads global settings.
- Enabling it does not force a compaction; whether Pi compacts still depends on
  the model's context usage and Pi's thresholds.

## Installing

Files are already in `~/.pi/agent/extensions/session-autocompact/`. Run `/reload`
(or start a new Pi) to load them. Existing sessions start with no setting.
