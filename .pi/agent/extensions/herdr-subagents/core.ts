import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const OWNER = "pi.subagent.owner";
const SESSION = "pi.subagent.session";
const LEAF = "pi.subagent.leaf";

export function createCoreBackend() {
  const parent = process.env.HC_TERMINAL_ID;
  const endpoint = process.env.HC_TERMINAL_SOCKET;
  if (!parent || !endpoint) return null;

  function call(method, params = {}, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(endpoint);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.setTimeout(timeout, () => socket.destroy(new Error(`Core timed out during ${method}`)));
      socket.once("error", reject);
      socket.once("close", () => reject(new Error(`Core disconnected during ${method}`)));
      socket.once("connect", () => {
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
      });
      socket.on("data", (chunk) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, end));
          if (response.error) {
            throw Object.assign(new Error(response.error.message), { kind: response.error.data?.kind });
          }
          resolve(response.result);
        } catch (error) {
          reject(error);
        } finally {
          socket.destroy();
        }
      });
    });
  }

  function worker(terminal) {
    const labels = terminal?.labels;
    if (terminal?.state !== "live" || !terminal.name || !labels?.[OWNER]) return null;
    return {
      agent: "pi",
      name: terminal.name,
      pane_id: terminal.address,
      tab_id: labels["herdr.tab"],
      space_id: labels["herdr.space"],
      agent_status: terminal.status?.state || "starting",
      agent_session: labels[SESSION] ? { value: labels[SESSION] } : undefined,
      leaf: labels[LEAF] === "1",
      parent: terminal.parent,
      owner: labels[OWNER],
    };
  }

  async function get(terminal) {
    try {
      return worker(await call("terminal.get", { terminal }));
    } catch (error) {
      if (error.kind === "not_found") return null;
      throw error;
    }
  }

  async function list() {
    const result = await call("terminal.list");
    return result.terminals.map(worker).filter(Boolean);
  }

  async function start({ name, cwd, flags, env, owner, leaf }) {
    // The App renders Core children under their parent. A herdr.space label
    // would also give the worker a separate top-level tab.
    const labels = { [OWNER]: owner, ...(leaf ? { [LEAF]: "1" } : {}) };
    return worker(await call("terminal.run", {
      argv: [...piCommand(), ...flags, "--name", name],
      name,
      cwd,
      parent,
      caller: parent,
      no_notify: true,
      labels,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.PI_CODING_AGENT_DIR ? { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR } : {}),
        ...env,
      },
    }, 20000));
  }

  async function ready(terminal, timeout) {
    const result = await call("terminal.wait", { terminal, timeout: timeout / 1000 }, timeout + 3000);
    if (!result.ended || result.reason !== "status" || !["idle", "done"].includes(result.status)) {
      throw new Error(`Pi did not become ready (${result.status || result.reason})`);
    }
  }

  async function close(terminal) {
    try {
      await call("terminal.kill", { terminal, caller: parent }, 15000);
    } catch (error) {
      if (!["not_found", "finished"].includes(error.kind)) throw error;
    }
    try {
      await call("terminal.rm", { terminal });
    } catch (error) {
      if (error.kind !== "not_found") throw error;
    }
  }

  function tree(agents, owner, root = parent) {
    const found = new Set([root]);
    const entries = [];
    let parents = new Set([root]);
    for (let depth = 0; parents.size > 0; depth++) {
      const next = new Set();
      for (const agent of agents) {
        if (!parents.has(agent.parent) || found.has(agent.pane_id)) continue;
        if (depth === 0 && owner && agent.owner !== owner) continue;
        found.add(agent.pane_id);
        next.add(agent.pane_id);
        entries.push({ agent, depth });
      }
      parents = next;
    }
    return entries.reverse();
  }

  return {
    parent, endpoint, worker, get, list, start, ready, close, tree,
    subscription: { children_of: parent },
    publishSession: (file) => call("terminal.label", { terminal: parent, labels: { [SESSION]: file || "" } }),
    prompt: (terminal, text) => call("terminal.send", { terminal, text, caller: parent }, 75000),
    interrupt: (terminal) => call("terminal.interrupt", { terminal }, 15000),
    tail: async (terminal, lines) => {
      const result = await call("terminal.read", { terminal, lines, caller: parent });
      return result.text.trim().split("\n").slice(-lines).join("\n");
    },
  };
}

function piCommand() {
  const root = process.env.PI_MANAGED_INSTALL_ROOT;
  const launcher = root && path.resolve(root, "../bin/pi");
  if (launcher && fs.existsSync(launcher)) return [launcher];
  const entry = process.argv[1];
  if (entry && path.isAbsolute(entry) && /\.[cm]?js$/.test(entry) && fs.existsSync(entry)) {
    return [process.execPath, entry];
  }
  return path.basename(process.execPath).replace(/\.exe$/, "") === "pi" ? [process.execPath] : ["pi"];
}
