// Dictation: speak, see the words appear live, paste them into the terminal
// that had focus (pi, Codex, Claude Code, or any program).
//
// Opened as a popup by `mod.open {name: "dictation"}` (ctrl-shift-d, the
// status-bar mic button).
//   Enter / ctrl-shift-d   stop and insert the text
//   Shift-Enter            insert and press Enter (submit)
//   Esc / click outside    cancel
// Modes (settings "mode"): "live" (default) streams to OpenAI Realtime
// (gpt-live-transcribe) and shows text as you speak; "batch" records, then
// transcribes with the file model.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, checking, closeOverlay, exec, focused, hc, home, nextCommand, notify, openOverlay, props, readTextFile, run, setShared, theme } from "herdr";

const helper = () => appHome() + "/mods/dictation/dictate.py";
const configPath = () => home() + "/.config/herdr-dictation/config.json";

async function dictate(cmd) {
  const r = await exec("python3", [helper(), cmd], { timeout: 120000 });
  let out = {};
  try { out = JSON.parse(r.stdout.trim().split("\n").pop() || "{}"); } catch { out = { error: (r.stderr || r.stdout).trim() || `helper exited ${r.code}` }; }
  if (r.code !== 0 && !out.error) out.error = (r.stderr || "").trim() || `helper exited ${r.code}`;
  return out;
}

export default class Dictation extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.state = "starting"; // starting | recording | transcribing | error
    this.error = null;
    this.seconds = 0;
    this.text = "";
    this.live = true;
    this.livePath = null;
    this.finished = false;
    const f = focused();
    this.target = f?.terminal ?? null;
    this.pane = f?.pane ?? null;
    this.handle.focus();
    cx.timer.after(200, () => this.handle.focus());
    if (checking()) return;
    setShared("dictation.state", "starting");
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (this.state === "error") this.cancel();
        else if (c === "stop") this.finish(false, cx);
        else if (c === "send") this.finish(true, cx);
        else if (c === "cancel") this.cancel();
      }
    });
    if (!this.target) { this.fail("Focus a terminal first, then start dictation."); return; }
    cx.spawn(async (cx) => {
      try { this.live = (JSON.parse((await readTextFile(configPath())) || "{}").mode ?? "live") !== "batch"; } catch {}
      const r = await dictate(this.live ? "live-start" : "start");
      if (r.error) { this.fail(r.error); cx.notify(); return; }
      this.livePath = r.state ?? null;
      this.started = Date.now();
      if (!this.live) this.setState("recording");
      cx.notify();
    });
    // Live: follow the helper's state file (partial transcript, status).
    this.poll = cx.timer.every(this.live ? 150 : 1000, async (cx) => {
      if (this.started) this.seconds = Math.floor((Date.now() - this.started) / 1000);
      if (this.live && this.livePath && (this.state === "starting" || this.state === "recording")) {
        const r = await exec("cat", [this.livePath]).catch(() => null);
        let st = null;
        try { st = r && r.code === 0 ? JSON.parse(r.stdout) : null; } catch {}
        if (st) {
          if (st.status === "error") { this.fail(st.error || "Live dictation failed."); exec("python3", [helper(), "cancel"]); }
          else {
            if (st.status === "live" && this.state === "starting") this.setState("recording");
            this.text = (st.text || "").trimStart();
          }
        }
      }
      cx.notify();
    });
  }

  fail(msg) { this.state = "error"; this.error = msg; setShared("dictation.state", "idle"); }

  // The status-bar button reads this.
  setState(s) { this.state = s; setShared("dictation.state", s === "error" ? "idle" : s); }

  finish(submit, cx) {
    // Live: allow stopping while still connecting; audio is buffered.
    if (this.state !== "recording" && !(this.live && this.state === "starting" && this.livePath)) return;
    this.setState("transcribing");
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await dictate(this.live ? "live-stop" : "stop");
      if (r.error) { this.fail(r.error); cx.notify(); return; }
      this.finished = true;
      const text = (r.text || "").trim();
      // Insert before closing: closing this overlay cancels its tasks.
      if (text) await this.insert(text, submit, cx);
      else notify({ title: "Dictation", body: "Heard nothing.", level: "warning", timeout: 3000 });
      setShared("dictation.state", "idle");
      closeOverlay(props().overlay);
    });
  }

  // Bracketed paste through the clipboard: the same path as Ctrl+Shift+V, so
  // every agent TUI treats it as typed text. The old clipboard text comes back after.
  async insert(text, submit, cx) {
    const previous = cx.read_from_clipboard();
    cx.write_to_clipboard(text);
    await cx.sleep(60);
    if (this.pane) run("pane.focus", { pane: this.pane });
    else run("pane.focus", { terminal: this.target });
    await cx.sleep(60);
    run("terminal.paste", {});
    await cx.sleep(300);
    if (previous !== undefined) cx.write_to_clipboard(previous);
    // Enter goes through the core after the paste settles; fire and forget.
    if (submit) hc(["keys", this.target, "enter"]);
  }

  cancel() {
    if (this.finished) return;
    this.finished = true;
    setShared("dictation.state", "idle");
    exec("python3", [helper(), "cancel"]);
    closeOverlay(props().overlay);
  }

  async close() {
    if (checking()) return;
    setShared("dictation.state", "idle");
    if (!this.finished) await exec("python3", [helper(), "cancel"]);
  }

  key(e, cx) {
    const k = e.keystroke;
    if (k === "escape") { this.cancel(); cx.stop_propagation(); return; }
    if (this.state === "error" && (k === "enter" || k === "ctrl-shift-d")) { this.cancel(); cx.stop_propagation(); return; }
    if (k === "enter" || k === "ctrl-shift-d") { this.finish(false, cx); cx.stop_propagation(); return; }
    if (k === "shift-enter") { this.finish(true, cx); cx.stop_propagation(); return; }
  }

  openSettings() {
    this.cancel();
    openOverlay({ mod: "dictation-settings", kind: "dialog", width: 520 });
  }

  render() {
    const t = theme();
    const mmss = `${Math.floor(this.seconds / 60)}:${String(this.seconds % 60).padStart(2, "0")}`;
    const kbd = (s) => div().px(6).py(1).rounded(4).bg(t.raised).border_1().border_color(t.border).text_size(11).text_color(t.muted).child(s);
    const hint = (keys, label) => h_flex().gap(5).items_center().child(kbd(keys)).child(div().text_size(11.5).text_color(t.dim).child(label));
    const button = (id, label, primary, fn) => h_flex().id(id).h(28).px(12).items_center().rounded(7)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12).cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(fn).child(label);

    let dot, title;
    if (this.state === "recording") {
      dot = div().size(10).rounded(5).bg(t.blocked).loop("opacity", { from: 0.35, to: 1, period: 1100 });
      title = `Listening…  ${mmss}`;
    } else if (this.state === "error") {
      dot = div().size(10).rounded(5).bg(t.blocked);
      title = "Dictation failed";
    } else {
      dot = div().text_size(13).text_color(t.accent).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90);
      title = this.state === "starting" ? (this.live ? "Connecting…" : "Starting microphone…") : (this.live ? "Finishing…" : "Transcribing…");
    }

    const showText = this.live && this.state !== "error";
    return v_flex().id("dictation").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().p(16).gap(12).bg(t.popover).text_color(t.foreground)
      .child(h_flex().gap(10).items_center()
        .child(dot)
        .child(div().flex_1().text_size(14).font_semibold().child(title))
        .child(div().id("dict-gear").text_size(11.5).text_color(t.dim).cursor_pointer()
          .hover((s) => s.text_color(t.foreground)).on_click(() => this.openSettings()).child("Settings")))
      .when(showText, (el) => el.child(
        div().w_full().min_h(64).max_h(220).overflow_y_scroll().p(10).rounded(8)
          .bg(t.background).border_1().border_color(t.border)
          .text_size(14).line_height("20px")
          .text_color(this.text ? t.foreground : t.dim)
          .child(this.text || (this.state === "recording" ? "Start speaking…" : "…"))))
      .when(this.state === "error", (el) => el
        .child(div().text_size(12.5).text_color(t.muted).child(this.error ?? ""))
        .child(h_flex().gap(8).justify_end()
          .child(button("dict-close", "Close", false, () => this.cancel()))
          .child(button("dict-settings", "Open settings", true, () => this.openSettings()))))
      .when(this.state !== "error", (el) => el
        .child(h_flex().gap(14).flex_wrap()
          .child(hint("Enter", "insert"))
          .child(hint("Shift+Enter", "insert & send"))
          .child(hint("Esc", "cancel"))));
  }
}
