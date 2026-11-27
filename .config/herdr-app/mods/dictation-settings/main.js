// Dictation settings: OpenAI API key, model, microphone, language, prompt.
// Saved to ~/.config/herdr-dictation/config.json (folder 0700, file 0600).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { appHome, checking, closeOverlay, exec, home, props, readTextFile, theme, writeTextFile } from "herdr";

const MODELS = ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"];
const MODES = [["live", "Live (see words as you speak)"], ["batch", "After recording"]];
const DELAYS = ["minimal", "low", "medium", "high"];
const configPath = () => home() + "/.config/herdr-dictation/config.json";
const helper = () => appHome() + "/mods/dictation/dictate.py";

async function helperRun(cmd) {
  const r = await exec("python3", [helper(), cmd], { timeout: 30000 });
  try { return JSON.parse(r.stdout.trim().split("\n").pop() || "{}"); } catch { return { error: (r.stderr || r.stdout).trim() }; }
}

export default class DictationSettings extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.raw = null;
    this.cfg = {};
    this.model = MODELS[0];
    this.source = "";
    this.mode = "live";
    this.delay = "low";
    this.sources = [];
    this.status = null; // {ok, text}
    this.busy = false;
    this.key = InputState.new({ placeholder: "sk-… (blank: use $OPENAI_API_KEY)" });
    this.key.set_masked(true);
    this.lang = InputState.new({ placeholder: "auto (or en, de, ja…)" });
    this.prompt = InputState.new({ placeholder: "Words to spell right: Herdr, Codex, pnpm…" });
    for (const i of [this.key, this.lang, this.prompt]) i.on("submit", (_e, cx) => this.save(cx, false));
    this.key.focus();
    if (checking()) return;
    cx.spawn(async (cx) => {
      this.raw = await readTextFile(configPath());
      try { this.cfg = this.raw ? JSON.parse(this.raw) : {}; } catch { this.cfg = {}; }
      if (this.cfg.api_key) this.key.set_value(this.cfg.api_key);
      if (this.cfg.language) this.lang.set_value(this.cfg.language);
      if (this.cfg.prompt) this.prompt.set_value(this.cfg.prompt);
      if (this.cfg.model) this.model = this.cfg.model;
      this.source = this.cfg.source ?? "";
      this.mode = this.cfg.mode ?? "live";
      this.delay = this.cfg.delay ?? "low";
      cx.notify();
      const s = await helperRun("sources");
      this.sources = s.sources ?? [];
      cx.notify();
    });
  }

  async write() {
    const cfg = {
      ...this.cfg,
      api_key: this.key.value().trim(),
      model: this.model,
      language: this.lang.value().trim(),
      prompt: this.prompt.value().trim(),
      source: this.source,
      mode: this.mode,
      delay: this.delay,
    };
    await helperRun("secure"); // folder 0700 before the key lands in it
    const text = JSON.stringify(cfg, null, 2) + "\n";
    const current = await readTextFile(configPath());
    await writeTextFile(configPath(), text, current);
    await helperRun("secure"); // file 0600
    this.cfg = cfg;
  }

  save(cx, test) {
    if (this.busy) return;
    this.busy = true;
    this.status = { ok: true, text: test ? "Testing key…" : "Saving…" };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.write();
        if (test) {
          const r = await helperRun("test-key");
          this.status = r.error ? { ok: false, text: r.error } : { ok: true, text: `Key works with ${this.model}.` };
        } else {
          closeOverlay(props().overlay);
          return;
        }
      } catch (e) {
        this.status = { ok: false, text: String(e?.message ?? e) };
      }
      this.busy = false;
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const label = (s) => div().pt(12).pb(6).text_size(11.5).text_color(t.dim).child(s);
    const field = (state) => Input.new(state).h(34).px(10).rounded(8).border_1().border_color(t.input)
      .bg(t.background).text_size(12.5).text_color(t.foreground);
    const chip = (id, text, on, fn) => div().id(id).px(10).py(5).rounded(7).border_1()
      .border_color(on ? t.accent : t.input).bg(on ? t.selected : t.raised)
      .text_size(12).text_color(on ? t.foreground : t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(fn).child(text);
    const button = (id, text, primary, fn) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(fn).child(text);
    const mics = [{ name: "", description: "System default" }, ...this.sources];

    return v_flex().id("dictation-settings").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .w_full().p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child("Dictation settings"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(label("OpenAI API key"))
      .child(field(this.key))
      .child(div().pt(5).text_size(11).text_color(t.dim).child("Stored in ~/.config/herdr-dictation/config.json (readable only by you)."))
      .child(label("Mode"))
      .child(h_flex().gap(6).flex_wrap().children(MODES.map(([m, text]) =>
        chip(`mode-${m}`, text, this.mode === m, (_e, cx) => { this.mode = m; cx.notify(); }))))
      .when(this.mode === "live", (el) => el
        .child(label("Live latency (gpt-live-transcribe): lower shows words sooner, higher is more accurate"))
        .child(h_flex().gap(6).flex_wrap().children(DELAYS.map((d) =>
          chip(`delay-${d}`, d, this.delay === d, (_e, cx) => { this.delay = d; cx.notify(); })))))
      .when(this.mode === "batch", (el) => el
        .child(label("Model"))
        .child(h_flex().gap(6).flex_wrap().children(MODELS.map((m, i) =>
          chip(`model-${i}`, m, this.model === m, (_e, cx) => { this.model = m; cx.notify(); })))))
      .child(label("Microphone"))
      .child(v_flex().gap(4).children(mics.map((s, i) =>
        chip(`mic-${i}`, s.description, this.source === s.name, (_e, cx) => { this.source = s.name; cx.notify(); }))))
      .child(label("Language (ISO code, optional; live mode accepts several: en, de)"))
      .child(field(this.lang))
      .child(label("Vocabulary hint (optional)"))
      .child(field(this.prompt))
      .when(Boolean(this.status), (el) => el.child(div().pt(12).text_size(12)
        .text_color(this.status.ok ? t.muted : t.blocked).child(this.status.text)))
      .child(h_flex().pt(18).gap(8).justify_end()
        .child(button("ds-cancel", "Cancel", false, () => closeOverlay(props().overlay)))
        .child(button("ds-test", "Save & test key", false, (_e, cx) => this.save(cx, true)))
        .child(button("ds-save", "Save", true, (_e, cx) => this.save(cx, false))));
  }
}
