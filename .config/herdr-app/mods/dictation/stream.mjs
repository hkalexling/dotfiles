// Live dictation: mic -> OpenAI Realtime transcription (WebSocket) -> state file.
//
//   node stream.mjs <state.json> <recorder argv as JSON>
//
// Writes <state.json> atomically as it goes:
//   { status: "connecting" | "live" | "finishing" | "done" | "error" | "cancelled",
//     text, error?, seconds }
// SIGINT: stop the mic, commit, wait for the final transcript, then "done".
// SIGTERM: cancel at once.
// Config: ~/.config/herdr-dictation/config.json (api_key, live_model, language, prompt, delay).
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";

const [statePath, recorderJson] = process.argv.slice(2);
const recorderArgv = JSON.parse(recorderJson);
const cfgPath = os.homedir() + "/.config/herdr-dictation/config.json";
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch {}
const apiKey = cfg.api_key || process.env.OPENAI_API_KEY || "";
const baseUrl = (cfg.base_url || "https://api.openai.com/v1").replace(/^http/, "ws").replace(/\/$/, "");
const MAX_MS = 10 * 60 * 1000;

const state = { status: "connecting", text: "", seconds: 0 };
const started = Date.now();
function save() {
  state.seconds = Math.round((Date.now() - started) / 100) / 10;
  const tmp = statePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, statePath);
}
let exiting = false;
function exit(code = 0) {
  if (exiting) return;
  exiting = true;
  try { rec?.kill("SIGINT"); } catch {}
  try { ws?.close(); } catch {}
  save();
  setTimeout(() => process.exit(code), 50);
}
function fail(msg) { state.status = "error"; state.error = msg; exit(1); }

save();
if (!apiKey) fail("No OpenAI API key. Open Dictation settings to add one.");

// Audio before the session is ready is kept and sent once it is.
const pending = [];
let ready = false;
let sentBytes = 0;
function sendAudio(buf) {
  sentBytes += buf.length;
  ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: buf.toString("base64") }));
}

const rec = spawn(recorderArgv[0], recorderArgv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
let recErr = "";
rec.stderr.on("data", (d) => { recErr += d; });
rec.on("error", (e) => fail(`Microphone recorder failed: ${e.message}`));
rec.stdout.on("data", (buf) => {
  if (ready && ws.readyState === 1) sendAudio(buf);
  else pending.push(buf);
});
const recClosed = new Promise((resolve) => rec.on("close", (code) => {
  if (state.status === "connecting" || state.status === "live") {
    if (!stopping) fail(`Microphone stopped (code ${code}). ${recErr.trim()}`.trim());
  }
  resolve();
}));

const transcription = { model: cfg.live_model || "gpt-live-transcribe", delay: cfg.delay || "low" };
if (cfg.language) transcription.languages = String(cfg.language).split(/[,\s]+/).filter(Boolean);
if (cfg.prompt) transcription.prompt = cfg.prompt;

const ws = new WebSocket(`${baseUrl}/realtime?intent=transcription`, { headers: { Authorization: `Bearer ${apiKey}` } });
ws.onopen = () => {
  ws.send(JSON.stringify({
    type: "session.update",
    session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24000 }, transcription, turn_detection: null } } },
  }));
};
let finalTimer = null;
ws.onmessage = (m) => {
  let e;
  try { e = JSON.parse(m.data); } catch { return; }
  switch (e.type) {
    case "session.updated":
      if (ready) break;
      ready = true;
      if (state.status === "connecting") state.status = "live";
      for (const b of pending.splice(0)) sendAudio(b);
      save();
      if (stopping) commit();
      break;
    case "conversation.item.input_audio_transcription.delta":
      state.text += e.delta || "";
      save();
      break;
    case "conversation.item.input_audio_transcription.completed":
      if (typeof e.transcript === "string" && e.transcript.trim()) state.text = e.transcript;
      if (stopping) { state.status = "done"; exit(0); }
      break;
    case "error": {
      const msg = e.error?.message || JSON.stringify(e.error);
      // An empty buffer on commit just means there was nothing to transcribe.
      if (stopping && /buffer/i.test(msg)) { state.status = "done"; exit(0); }
      else fail(`OpenAI: ${msg}`);
      break;
    }
  }
};
ws.onerror = (e) => { if (!exiting) fail(`Connection failed: ${e.message || "WebSocket error"}`); };
ws.onclose = (e) => {
  if (exiting) return;
  if (stopping) { state.status = "done"; exit(0); }
  else fail(`Connection closed (${e.code}${e.reason ? ": " + e.reason : ""})`);
};

let stopping = false;
async function stop() {
  if (stopping || exiting) return;
  stopping = true;
  state.status = "finishing";
  save();
  try { rec.kill("SIGINT"); } catch {}
  await Promise.race([recClosed, new Promise((r) => setTimeout(r, 1000))]);
  if (ready) commit();
  // Never hang: settle with what we have.
  finalTimer = setTimeout(() => { state.status = "done"; exit(0); }, 15000);
}
function commit() {
  if (sentBytes < 4800) { state.status = "done"; exit(0); return; } // < 0.1 s of audio
  ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
}

process.on("SIGINT", stop);
process.on("SIGTERM", () => { state.status = "cancelled"; exit(0); });
process.on("SIGHUP", () => { state.status = "cancelled"; exit(0); });
setTimeout(stop, MAX_MS);
setInterval(() => { if (!exiting && state.status === "live") save(); }, 1000); // keep `seconds` ticking
