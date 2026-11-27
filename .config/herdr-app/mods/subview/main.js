import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { checking, closeOverlay, exec, home, props, run, theme } from "herdr";

// Use the same default provider list as the PWA and CLI. Only send an explicit
// filter when temporarily skipping rate-limited providers.
const API = "http://127.0.0.1:8787/api/limits";
// Its CLI is the fallback: same numbers, and it refreshes expired tokens too.
const CLI = () => `${home()}/.local/bin/subview`;
const PANEL_REFRESH_MS = 60_000;
const CHIP_REFRESH_MS = 15 * 60_000;
const RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 50_000;
const PADDING = 16;
const OK = new Set(["ok", "allowed", "active", ""]);

// One window of data shared by every copy of this mod, so the sidebar chip and
// the open panel agree and only one of them fetches. Plain data: host calls
// belong to a copy, never to module scope.
let cache = { at: null, providers: [], error: null, retryAt: 0 };
let lastAttemptAt = -Infinity;
let pending = null;
const cacheWaiters = new Set();

function readProviders(report) {
  if (!Array.isArray(report?.providers)) throw new Error("Invalid Subview limits report");
  return report.providers;
}

async function grab(filter) {
  const url = filter ? `${API}?providers=${encodeURIComponent(filter.join(","))}` : API;
  let response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (network) {
    // Fall back only when there was no server response. The CLI still writes a
    // valid report on exit 1 when one of the providers has an error.
    const result = await exec(CLI(), ["--json", ...(filter ?? [])]);
    if (!result.stdout?.trim()) throw new Error(result.stderr?.trim() || network.message);
    return readProviders(JSON.parse(result.stdout));
  }
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  }
  return readProviders(await response.json());
}

function mergeProviders(providers, filter, now) {
  const previous = new Map(cache.providers.map((p) => [p.provider, p]));
  const updated = providers.map((p) => {
    // Subview sends upstream errors inside the provider's JSON, not as the
    // HTTP status of /api/limits. Keep any last known limits on a 429.
    if (!/\bHTTP 429\b/.test(p.error ?? "")) return p;
    const last = previous.get(p.provider);
    return {
      ...(last?.windows?.length ? last : p),
      error: p.error,
      retryAt: now + RATE_LIMIT_BACKOFF_MS,
    };
  });
  if (!filter) return updated;
  const byId = new Map(updated.map((p) => [p.provider, p]));
  return cache.providers.map((p) => byId.get(p.provider) ?? p);
}

function pausedUntil() {
  const retries = cache.providers.map((p) => p.retryAt ?? 0);
  const allProvidersPausedUntil = retries.length ? Math.min(...retries) : 0;
  return Math.max(cache.retryAt, allProvidersPausedUntil);
}

function nextPollAt(interval) {
  return Math.max(lastAttemptAt + interval, pausedUntil(), pending?.deadline ?? 0);
}

function notifyViews() {
  for (const wake of cacheWaiters) wake();
  cacheWaiters.clear();
}

function finish(job, report, error, timedOut = false) {
  // A late reply from a timed-out request cannot overwrite newer limits.
  if (pending !== job) return;
  pending = null;
  if (timedOut) job.task?.cancel();
  else job.timeout?.cancel();
  if (error) {
    cache = {
      ...cache,
      error: String(error?.message ?? error),
      retryAt: error?.status === 429 ? Date.now() + RATE_LIMIT_BACKOFF_MS : 0,
    };
  } else {
    const at = Date.now();
    cache = { at, providers: report, error: null, retryAt: 0 };
  }
  notifyViews();
}

function expire(job) {
  finish(job, null, new Error("Limits refresh timed out"), true);
}

function load(cx, interval, force = false) {
  const now = Date.now();
  if (pending && now >= pending.deadline) {
    // Check the deadline on entry in case the host never delivered the timer.
    const { timeout } = pending;
    expire(pending);
    timeout?.cancel();
  }
  if (pending || now < (force ? pausedUntil() : nextPollAt(interval))) return;

  const filter = cache.providers.some((p) => p.retryAt > now)
    ? cache.providers.filter((p) => !(p.retryAt > now)).map((p) => p.provider)
    : null;
  lastAttemptAt = now;
  const job = { deadline: now + REQUEST_TIMEOUT_MS, task: null, timeout: null };
  pending = job;
  notifyViews();
  try {
    // Keep both the request and its timeout alive if the initiating view closes.
    job.timeout = cx.timer.after(REQUEST_TIMEOUT_MS, () => expire(job), { owner: null });
    job.task = cx.spawn(async () => {
      try {
        const providers = await grab(filter);
        if (pending === job) finish(job, mergeProviders(providers, filter, Date.now()), null);
      } catch (error) {
        finish(job, null, error);
      }
    }, { owner: null });
  } catch (error) {
    finish(job, null, error);
  }
}

function tone(t, left) {
  if (left < 20) return t.blocked;
  if (left < 50) return t.working;
  return t.done;
}

function tightest(providers) {
  let lowest;
  for (const p of providers) {
    if (p.error) continue;
    for (const w of p.windows ?? []) {
      if (!Number.isFinite(w.left_percent)) continue;
      if (!lowest || w.left_percent < lowest.left) {
        lowest = { provider: p.name, label: w.label, left: w.left_percent };
      }
    }
  }
  return lowest;
}

function providerError(provider) {
  if (!provider.retryAt) return provider.error;
  const minutes = Math.ceil((provider.retryAt - Date.now()) / 60_000);
  const cached = provider.windows?.length ? " · showing cached limits" : "";
  return `Rate limited (HTTP 429)${cached}${minutes > 0 ? ` · paused for ${minutes}m` : ""}`;
}

function resetText(window) {
  const stamp = window.resets_at && new Date(window.resets_at).getTime();
  if (!stamp) return "reset time unknown";
  const ms = stamp - Date.now();
  if (ms <= 0) return "resetting now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const span = days ? `${days}d ${String(hours).padStart(2, "0")}h` : `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `resets in ${span}`;
}

function updatedText() {
  if (cache.at === null) return cache.error ? "not yet updated" : "loading…";
  const seconds = Math.max(0, Math.round((Date.now() - cache.at) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export default class Subview extends View {
  init(_props, cx) {
    this.size = null;
    this.handle = cx.focus_handle();
    this.focused = false;
    this.closed = false;
    this.wake = null;
    if (checking()) return;

    // Each copy redraws in its own view context when the shared report changes.
    cx.spawn(async (cx) => {
      while (!this.closed) {
        await new Promise((wake) => {
          this.wake = wake;
          cacheWaiters.add(wake);
        });
        this.wake = null;
        if (!this.closed) cx.notify();
      }
    });

    const panel = Boolean(props()?.overlay);
    const interval = panel ? PANEL_REFRESH_MS : CHIP_REFRESH_MS;
    if (panel) this.focus(cx);
    cx.spawn(async (cx) => {
      load(cx, interval, panel);
      while (!this.closed) {
        // Schedule from the last shared attempt, never wait on the network.
        await cx.sleep(Math.max(1, nextPollAt(interval) - Date.now()));
        if (!this.closed) load(cx, interval);
      }
    });
  }

  close() {
    this.closed = true;
    if (this.wake) {
      cacheWaiters.delete(this.wake);
      this.wake();
    }
  }

  // The window overlay takes its own keyboard so Esc closes it; the docked
  // chip never does, so typing keeps going to the terminals.
  focus(cx) {
    if (this.focused) return;
    this.focused = true;
    cx.spawn(async (cx) => {
      this.handle.focus();
      cx.notify();
    });
  }

  // The sidebar chip shows the tightest window across your subscriptions.
  renderChip(t) {
    const worst = tightest(cache.providers);
    const source = worst
      ? `${worst.provider} · ${worst.label}: ${Math.round(worst.left)}% left (last result)`
      : "Open subscription limits";
    return h_flex()
      .id("subview-chip")
      .tooltip(source)
      .size_full()
      .px(14)
      .gap(7)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      .cursor_pointer()
      .hover((style) => style.bg(t.hover))
      .on_click(() => run("mod.open", { name: "subview" }))
      .child(svg("mods/subview/gauge.svg").size(13))
      .child(div().child("limits"))
      .child(
        h_flex()
          .gap(4)
          .children(
            cache.providers.map((p) => {
              const low = tightest([p]);
              return div()
                .id(`subview-dot-${p.provider}`)
                .size(6)
                .rounded(3)
                .bg(low ? tone(t, low.left) : t.dim);
            }),
          ),
      )
      .child(div().flex_1())
      .when(Boolean(worst && cache.error), (el) => el.child(div().text_size(10.5).text_color(t.dim).child("stale")))
      .when(Boolean(worst), (el) => el.child(
        div()
          .text_size(11.8)
          .font_semibold()
          .text_color(tone(t, worst.left))
          .child(`${Math.round(worst.left)}%`),
      ));
  }

  renderWindow(t) {
    const inner = Math.max(80, (this.size?.width ?? 460) - PADDING * 2);
    return v_flex()
      .id("subview-root")
      .size_full()
      .min_h(0)
      .p(PADDING)
      .gap(12)
      .bg(t.surface)
      .text_size(13)
      .track_focus(this.handle)
      .on_size_change((size, cx) => {
        this.size = size;
        cx.notify();
      })
      .on_key_down((event, cx) => {
        if (event.key !== "escape") return;
        cx.stop_propagation();
        closeOverlay(props()?.overlay);
      })
      .child(
        h_flex()
          .flex_none()
          .items_center()
          .gap(10)
          .child(svg("mods/subview/gauge.svg").size(15).text_color(t.accent))
          .child(v_flex().flex_1().min_w(0).child(
            div().text_size(15).font_semibold().text_color(t.foreground).child("Subscription limits"),
          ))
          .child(div().id("subview-refresh").px(8).py(4).rounded(5).flex_none().bg(t.raised)
            .text_size(11.5).text_color(t.muted).cursor_pointer().hover((style) => style.bg(t.hover))
            .on_click((_event, cx) => load(cx, PANEL_REFRESH_MS, true))
            .child(pending ? "Refreshing…" : "Refresh"))
          .child(div().id("subview-close").size(24).flex_none().rounded(5).items_center().justify_center()
            .text_color(t.muted).cursor_pointer().hover((style) => style.bg(t.hover))
            .on_click(() => closeOverlay(props()?.overlay)).child(svg("mods/subview/x.svg").size(13))),
      )
      .when(cache.error, (el) => el.child(
        div().text_size(11.5).text_color(t.working).child(
          cache.at === null ? cache.error : `Last report: ${updatedText()} · ${cache.error}`,
        ),
      ))
      .when(!cache.providers.length && !cache.error, (el) => el.child(
        div().text_color(t.muted).child("Loading limits…"),
      ))
      .child(
        v_flex().flex_1().min_h(0).gap(10).overflow_y_scrollbar()
          .children(cache.providers.map((provider) => this.renderProvider(t, provider, inner))),
      )
      .child(
        div().flex_none().text_size(10.5).text_color(t.dim)
          .child(`${cache.at === null ? "No report yet" : `Last checked ${updatedText()}`} · checks every minute while open · Esc to close`),
      );
  }

  renderProvider(t, provider, inner) {
    const left = provider.windows ?? [];
    return v_flex()
      .id(`subview-provider-${provider.provider}`)
      .w_full()
      .flex_none()
      .p(12)
      .gap(11)
      .rounded(10)
      .border_1()
      .border_color(t.border)
      .bg(t.background)
      .child(
        v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().items_center().gap(8)
            .child(div().text_size(14).font_semibold().text_color(t.foreground).child(provider.name))
            .when(Boolean(provider.plan), (el) => el.child(
              h_flex().px(7).py(1).rounded(999).bg(t.raised).text_size(10).text_color(t.muted)
                .child(String(provider.plan).toUpperCase()),
            )))
          .when(Boolean(provider.account), (el) => el.child(
            div().truncate().text_size(11).text_color(t.dim).child(provider.account),
          )),
      )
      .when(Boolean(provider.error), (el) => el.child(
        div().text_size(12).text_color(t.blocked).child(providerError(provider)),
      ))
      .when(!provider.error && !left.length, (el) => el.child(
        div().text_size(12).text_color(t.dim).child("No limit data reported."),
      ))
      .children(left.map((window) => this.renderWindow_(t, window, inner)));
  }

  renderWindow_(t, window, inner) {
    const percent = Math.max(0, Math.min(100, window.left_percent ?? 0));
    const color = tone(t, percent);
    const status = window.status && !OK.has(String(window.status).toLowerCase()) ? window.status : null;
    return v_flex()
      .w_full()
      .flex_none()
      .gap(5)
      .child(
        h_flex().items_center().gap(8)
          .child(div().text_size(10.5).font_semibold().text_color(t.muted)
            .child(String(window.label ?? "current").toUpperCase()))
          .when(Boolean(status), (el) => el.child(
            h_flex().px(7).py(1).rounded(999).border_1().border_color(t.blocked)
              .text_size(10).text_color(t.blocked).child(String(status)),
          ))
          .child(div().flex_1())
          .child(div().text_size(13).font_semibold().text_color(color)
            .child(`${Math.round(percent)}% left`)),
      )
      .child(
        h_flex().w(inner).h(6).rounded(3).bg(t.raised)
          .child(div().h(6).w(Math.max(2, Math.round((inner * percent) / 100))).rounded(3).bg(color)),
      )
      .child(div().text_size(10.5).text_color(t.dim).child(resetText(window)));
  }

  render() {
    const t = theme();
    return props()?.overlay ? this.renderWindow(t) : this.renderChip(t);
  }
}
