
## Dictation mod (added 2025-11-25)
- `mods/dictation/` (popup, ctrl-shift-d) records with `dictate.py` (pw-record → OpenAI /audio/transcriptions) and pastes into the focused terminal via clipboard + `terminal.paste` (clipboard restored after). Shift+Enter also presses Enter via `hc keys`.
- `mods/dictation-settings/` edits `~/.config/herdr-dictation/config.json` (0600): api_key, model, source, language, prompt. Falls back to $OPENAI_API_KEY.
- keys.json: `global.ctrl-shift-d` and section `mod:dictation` (enter/ctrl-shift-d → stop, shift-enter → send).
- Test without OpenAI: `"fake_text": "..."` in config or HERDR_DICTATION_FAKE env.
- `mods/dictation-button/`: mic button at the right end of the status bar in `layouts/limits.json` (block `dictation-button` inside row `status-row`). Click: start / stop & insert; right-click: settings. Reads shared `dictation.state` (idle|starting|recording|transcribing), set by the dictation mod.
- Live mode (default, config `mode: "live"`): `dictate.py live-start` spawns `node stream.mjs` (pw-record raw 24 kHz → wss://api.openai.com/v1/realtime?intent=transcription, model gpt-live-transcribe, `delay` low); partial text in $XDG_RUNTIME_DIR/herdr-dictation/live.json, polled by the popup every 150 ms; `live-stop` = SIGINT → commit → final transcript. `mode: "batch"` keeps the old record-then-transcribe path. Test hook: config `live_recorder` argv.
- Paste uses the Wayland clipboard: only works while the Herdr window is focused.
