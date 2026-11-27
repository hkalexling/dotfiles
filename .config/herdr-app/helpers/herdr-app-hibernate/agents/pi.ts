import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function hibernate(pi: ExtensionAPI) {
  if (!process.env.HC_TERMINAL_ID || !process.env.HC_TERMINAL_SOCKET) return;
  const helper = process.env.HERDR_HIBERNATE_HELPER || join(homedir(), ".local/bin/herdr-hibernate");
  let recorded: string | null | undefined;
  let pending = false;
  let queued: { file: string | null; cwd: string } | undefined;

  function send() {
    if (pending || !queued) return;
    const { file, cwd } = queued;
    queued = undefined;
    if (file === recorded) return;
    pending = true;
    const child = spawn(helper, ["hook", "pi"], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stdin.on("error", () => {});
    child.on("error", () => {});
    child.on("close", (code) => {
      try {
        if (code === 0 && JSON.parse(output).recorded) recorded = file;
      } catch {
        // Retry on the next session or agent event.
      }
      pending = false;
      send();
    });
    child.stdin.end(JSON.stringify({ file, cwd, pid: process.pid }));
  }

  function record(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    const file = ctx.sessionManager.getSessionFile();
    queued = { file: file && existsSync(file) ? file : null, cwd: ctx.cwd };
    send();
  }

  pi.on("session_start", (_event, ctx) => record(ctx));
  pi.on("agent_start", (_event, ctx) => record(ctx));
  pi.on("agent_settled", (_event, ctx) => record(ctx));
}
