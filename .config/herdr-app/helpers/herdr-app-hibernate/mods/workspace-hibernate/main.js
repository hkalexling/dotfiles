import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { checking, closeOverlay, exec, home, notify, props, run, spaces, theme } from "herdr";

const helper = () => home() + "/.local/bin/herdr-hibernate";
const ROW_HEIGHT = 44;
const VISIBLE_ROWS = 7;

export default class WakePicker extends View {
  init(_props, cx) {
    this.catalog = [];
    this.position = 0;
    this.query = "";
    this.busy = false;
    this.scroll = ScrollHandle.new();
    this.deleteFocus = cx.focus_handle();
    this.deleteTarget = null;
    this.searchMounted = false;
    this.input = InputState.new({ placeholder: "Search spaces, folders or tabs" });
    this.input.on("change", (_event, cx) => {
      this.query = this.input.value().toLowerCase().trim();
      this.position = 0;
      this.scroll.scroll_to_item(0);
      cx.notify();
    });
    this.input.on("submit", (_event, cx) => this.wake(this.rows()[this.position], cx));
    this.input.focus();
    if (checking()) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const result = await exec(helper(), ["list"]);
        if (result.code !== 0) throw new Error(result.stderr.trim());
        this.catalog = JSON.parse(result.stdout).spaces;
      } catch (error) {
        this.error = String(error);
      }
      this.busy = false;
      cx.notify();
    });
  }

  rows() {
    const tokens = this.query.split(/\s+/).filter(Boolean);
    return this.catalog.filter((space) => {
      const text = [space.name, space.folder, ...space.tabs].join(" ").toLowerCase();
      return tokens.every((token) => text.includes(token));
    });
  }

  wake(space, cx) {
    if (this.busy || this.deleteTarget || !space || checking()) return;
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await exec(helper(), ["wake", space.id], { timeout: 120000 });
        if (result.code !== 0) throw new Error(result.stderr.trim());
        const restored = JSON.parse(result.stdout);
        this.catalog = this.catalog.filter((row) => row.id !== space.id);
        this.selectWhenVisible(restored, 30, cx);
      } catch (error) {
        this.error = String(error);
        this.busy = false;
        cx.notify();
      }
    });
  }

  confirmDelete(space, cx) {
    if (this.busy || !space) return;
    this.deleteTarget = space;
    this.error = null;
    this.deleteFocus.focus();
    cx.notify();
  }

  closeDelete(cx) {
    if (this.busy) return;
    this.deleteTarget = null;
    this.error = null;
    this.searchMounted = false;
    this.input.focus();
    cx.notify();
  }

  deleteSpace(cx) {
    const space = this.deleteTarget;
    if (this.busy || !space || checking()) return;
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await exec(helper(), ["delete", space.id]);
        if (result.code !== 0) throw new Error(result.stderr.trim().replace(/^herdr-hibernate: /, ""));
        const selected = this.rows()[this.position]?.id;
        this.catalog = this.catalog.filter((row) => row.id !== space.id);
        const rows = this.rows();
        const index = rows.findIndex((row) => row.id === selected);
        this.position = index === -1 ? Math.max(0, Math.min(this.position, rows.length - 1)) : index;
        this.scroll.scroll_to_item(this.position);
      } catch (error) {
        this.error = error.message || String(error);
        this.busy = false;
        cx.notify();
        return;
      }
      this.busy = false;
      this.closeDelete(cx);
    });
  }

  selectWhenVisible(restored, remaining, cx) {
    if (!spaces().some((space) => space.id === restored.id)) {
      if (remaining > 0) {
        cx.timer.after(100, (cx) => this.selectWhenVisible(restored, remaining - 1, cx));
        return;
      }
      notify({ title: "Space woken", body: "Select it from the spaces sidebar when it appears." });
    } else {
      run("space.select", { id: restored.id });
      if (restored.tab) run("tab.select", { id: restored.tab });
      if (restored.focus) run("pane.focus", { pane: restored.focus });
      if (restored.zoom) run("pane.zoom", { pane: restored.zoom });
    }
    if (restored.warnings.length) {
      notify({ title: "Some agents opened as shells", body: restored.warnings.join("\n"), level: "warning" });
    }
    closeOverlay(props().overlay);
  }

  renderDelete(t) {
    const space = this.deleteTarget;
    return v_flex().id("confirm-delete-space").w_full().p(16).gap(12).bg(t.popover)
      .track_focus(this.deleteFocus)
      .on_key_down((event, cx) => {
        if (event.key !== "enter") return;
        cx.stop_propagation();
        this.deleteSpace(cx);
      })
      .child(div().text_size(16).font_semibold().text_color(t.foreground).child(`Delete “${space.name}”?`))
      .child(div().text_size(12).text_color(t.muted).child(space.folder))
      .child(div().text_size(13).text_color(t.foreground).child("This removes the saved layout from the wake picker."))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(h_flex().justify_end().gap(8).text_size(13)
        .child(div().id("cancel-delete-space").px(12).py(6).rounded(5).bg(t.raised).text_color(t.foreground)
          .cursor_pointer().hover((style) => style.bg(t.hover))
          .on_click((_, cx) => this.closeDelete(cx)).child("Cancel"))
        .child(div().id("delete-space").px(12).py(6).rounded(5).bg(t.solid).text_color(t.solid_foreground)
          .cursor_pointer().hover((style) => style.opacity(0.88))
          .on_click((_, cx) => this.deleteSpace(cx)).child(this.busy ? "Deleting…" : "Delete")));
  }

  render(cx) {
    const t = theme();
    if (this.deleteTarget) return this.renderDelete(t);
    const rows = this.rows();
    return v_flex().w_full().min_h(0).gap(10).p(16).bg(t.popover)
      .on_key_down((event, cx) => {
        if (event.key === "escape") {
          closeOverlay(props().overlay);
        } else if (event.key === "d" && event.modifiers.control) {
          this.confirmDelete(rows[this.position], cx);
        } else if (rows.length && (event.key === "up" || event.key === "down")) {
          const step = event.key === "up" ? -1 : 1;
          this.position = (this.position + step + rows.length) % rows.length;
          this.scroll.scroll_to_item(this.position);
          cx.notify();
        } else {
          return;
        }
        cx.stop_propagation();
      })
      .child(h_flex().flex_none().items_center().justify_between()
        .child(div().text_size(16).font_semibold().text_color(t.foreground).child("Wake a hibernated space"))
        .when(!this.busy && !this.error, (el) => el.child(
          div().text_size(12).text_color(t.muted).child(`${rows.length} / ${this.catalog.length}`),
        )))
      .child(h_flex().id("wake-search").h(34).flex_none().px(8)
        .rounded(5).border_1().border_color(t.accent).bg(t.background)
        .on_size_change(() => {
          if (this.searchMounted) return;
          this.searchMounted = true;
          this.input.focus();
        })
        .child(Input.new(this.input).flex_1().h_full()))
      .when(this.busy, (el) => el.child(div().text_color(t.muted).child("Loading…")))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .when(!this.busy && !this.error && !rows.length, (el) =>
        el.child(div().text_color(t.muted).child(this.query ? "No matching spaces" : "No hibernated spaces")))
      .when(rows.length > 0, (el) => el.child(v_flex().id("hibernated-space-list")
        .h(Math.min(rows.length, VISIBLE_ROWS) * ROW_HEIGHT).min_h(0)
        .overflow_y_scrollbar().track_scroll(this.scroll).children(rows.map((space, index) =>
          h_flex().id(space.id).h(ROW_HEIGHT).flex_none().rounded(5).px(8).gap(10).items_center()
            .bg(index === this.position ? t.selected : t.popover)
            .hover((style) => style.bg(t.hover)).cursor_pointer()
            .on_click((_, cx) => this.wake(space, cx))
            .child(v_flex().flex_1().min_w(0)
              .child(div().truncate().text_color(t.foreground).child(space.name))
              .child(div().truncate().text_size(11).text_color(t.muted).child(space.folder)))
            .when(space.agents > 0, (el) => el.child(div().text_color(t.dim)
              .child(space.agents === 1 ? "1 agent" : space.agents + " agents"))),
        ))));
  }
}
