// A mic button for the status bar. Click: start dictating into the focused
// terminal. While recording, click again: stop and insert. Right-click: settings.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { openOverlay, run, shared, theme } from "herdr";

export default class DictationButton extends View {
  render() {
    const t = theme();
    const state = shared("dictation.state") ?? "idle";
    const recording = state === "recording";
    const busy = state === "starting" || state === "transcribing";
    const color = recording ? t.blocked : busy ? t.accent : t.muted;
    const label = recording ? "Stop & insert" : busy ? (state === "starting" ? "Starting…" : "Transcribing…") : "Dictate";
    const icon = svg("mods/dictation/mic.svg").size(13).text_color(color);
    return h_flex().id("dictation-button").size_full().px(10).gap(6).items_center().justify_center()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(color)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => {
        if (recording) run("dictation.stop");
        else if (!busy) run("mod.open", { name: "dictation" });
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "dictation-settings", kind: "dialog", width: 520 });
      })
      .child(recording ? icon.loop("opacity", { from: 0.35, to: 1, period: 1100 }) : icon)
      .child(div().child(label));
  }
}
