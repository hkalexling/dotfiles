import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { checking, closeOverlay, exec, home, notify, props, spaces, theme } from "herdr";

export default class HibernateCurrent extends View {
  init(_props, cx) {
    this.error = null;
    if (checking()) return;
    const current = spaces().find((space) => space.active);
    cx.spawn(async (cx) => {
      try {
        if (!current || current.machine) throw new Error("Select a space on this computer first.");
        const result = await exec(home() + "/.local/bin/herdr-hibernate", ["hibernate", current.id], {
          timeout: 120000,
        });
        if (result.code !== 0) {
          throw new Error(result.stderr.trim().replace(/^herdr-hibernate: /, ""));
        }
        notify({ title: "Space hibernated", body: current.name });
        closeOverlay(props().overlay);
      } catch (error) {
        this.error = error.message || "The hibernation helper failed.";
        cx.notify();
      }
    });
  }

  render() {
    const t = theme();
    return v_flex().w_full().gap(14).p(18).bg(t.popover).text_color(t.foreground)
      .child(div().font_semibold().child(this.error ? "Could not hibernate space" : "Saving the current space…"))
      .when(Boolean(this.error), (el) => el
        .child(div().text_color(t.muted).child(this.error))
        .child(h_flex().justify_end().child(div().id("close-hibernate-error")
          .px(12).py(6).rounded(5).bg(t.raised).cursor_pointer()
          .hover((style) => style.bg(t.hover))
          .on_click(() => closeOverlay(props().overlay))
          .child("Close"))));
  }
}
