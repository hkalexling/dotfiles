/**
 * No Full-Disk Search — Linux-only guard against high-IO recursive scans.
 *
 * Cost-based, NOT sandbox-based: scanning outside the cwd is fine
 * (e.g. `rg foo /opt/myapp/conf`), but recursive scans rooted at
 * high-fanout locations hang the agent and thrash disk:
 *   /  /home  /root  ~  /etc  /usr  /var  /opt(bare)  /tmp(bare)
 *   /srv  /boot  /mnt  /media  /run  /snap  /var/lib/docker
 *   and NEVER: /proc  /sys  /dev (virtual FS — hangs even bounded)
 *
 * Hooked tools (bash + user `!` commands):
 *   find | grep -r | rg | ag | ack | fd | ls -R | tree | du | ncdu |
 *   updatedb | journalctl (unbounded) | cat-family globs | dd from /dev/*
 *
 * Piping to head/tail/sort/wc/tee/... is NOT a bound: walkers only emit
 * matching lines (truncating consumers are data-dependent), and buffering
 * consumers read to EOF before producing anything. Only real bounds count:
 * a leaf dir, -maxdepth<=2, or timeout <=120s. The same rule covers device
 * files: unbounded reads of /dev/zero etc. are blocked regardless of pipes.
 *
 * Instead of rejecting silently, every block returns copy-paste scoped
 * alternatives (leaf dir + -maxdepth/-xdev/timeout/head).
 *
 * Test without running anything:  /search-guard test <command>
 * Full self-test suite:           /search-guard selftest
 *                                 (or run: node no-fulldisk-search.ts)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { posix as posixPath } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------- config

const LINUX_NEVER_SCAN = ["/proc", "/sys", "/dev"];

const LINUX_HIGH_IO_ROOTS = new Set([
  "/",
  "/home",
  "/root",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/var",
  "/var/log",
  "/var/cache",
  "/var/spool",
  "/var/lib",
  "/var/lib/docker",
  "/var/tmp",
  "/opt",
  "/srv",
  "/boot",
  "/tmp",
  "/mnt",
  "/media",
  "/run",
  "/snap",
]);

const HOME_SINGLE_RE = /^\/home\/[^/]+$/; // /home/alice is still huge

/** `timeout <= 2m` is a real wall-clock bound; anything longer is not. */
const MAX_EXEMPT_TIMEOUT_S = 120;

/** Infinite/special device files — reading unbounded hangs or fills memory. */
const INFINITE_DEVICES = new Set([
  "/dev/zero",
  "/dev/urandom",
  "/dev/random",
  "/dev/full",
  "/dev/mem",
  "/dev/kmem",
  "/dev/port",
  "/proc/kcore",
  "/proc/kmsg",
]);

/** Commands that stream-read their operands; unbounded device args hang them. */
const STREAM_READER_BINS = new Set([
  // cat family (also flagged for filesystem globs)
  "cat", "head", "tail", "less", "more", "bat", "tac", "nl", "strings",
  // other readers that consume an infinite device forever
  "wc", "od", "xxd", "hexdump", "base64", "base32",
  "md5sum", "sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum",
  "cksum", "sum", "cp", "pv", "sort", "grep", "egrep", "fgrep",
  "sed", "awk", "cut", "tr",
]);

/** Downstream pipe commands people mistake for cost bounds. */
const TRUNCATING_CONSUMERS = new Set(["head", "cut", "fold", "fmt"]);
const BUFFERING_CONSUMERS = new Set([
  "sort", "wc", "uniq", "tac", "shuf", "sponge", "tee", "comm",
  "join", "column", "xargs", "parallel", "tail",
]);

const SEARCH_POLICY =
  "Disk-search policy (Linux): never run recursive scans from high-IO roots " +
  "(/, /home, /root, ~, /etc, /usr, /var, bare /opt /srv /tmp /mnt, or /proc /sys /dev). " +
  "Scope to a leaf dir (e.g. /var/log/<app>, /opt/<app>, /tmp/<job>) and bound with " +
  "-maxdepth 2-3, -xdev, timeout <=120, 2>/dev/null, | head -50. " +
  "Piping to head/tail/sort/wc/tee does NOT make a high-IO root safe: walkers emit only " +
  "matching lines (data-dependent) and buffering consumers read to EOF first. " +
  "Never read infinite device files (/dev/zero, /dev/urandom, ...) unbounded. " +
  "Prefer rg/fd scoped to the project.";

const STATUS_TEXT = [
  "search-guard (linux): cost-based blocking.",
  "NEVER recursive: /proc /sys /dev (even with -maxdepth).",
  "HIGH-IO roots (block unbounded): /, /home, /root, ~, /etc, /usr,",
  "  /var (+/log /cache /lib/docker), bare /opt /srv /tmp /mnt /media /run /snap.",
  "Leaf dirs outside cwd are ALLOWED: /opt/<app>, /var/log/<app>, /tmp/<job>.",
  `Exemptions for HIGH roots: -maxdepth<=2, -L<=2 (tree), timeout <=${MAX_EXEMPT_TIMEOUT_S}s.`,
  "NO downstream command exempts (head/tail/sort/wc/uniq/tee/xargs/...):",
  "  truncating consumers are data-dependent; sort/wc/tail/tee read to EOF.",
  "Infinite device reads need a bound (head/tail -c/-n, od -N, xxd -l, timeout).",
  "Usage: /search-guard test <command> | /search-guard selftest",
].join("\n");

// ---------------------------------------------------------------- types

export interface SearchGuardHit {
  segment: string;
  summary: string;
  feedback: string;
}

// ---------------------------------------------------------------- path helpers

function defaultHome(): string {
  return process.env.HOME ?? homedir() ?? "/root";
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const q = s[0];
    if ((q === '"' || q === "'") && s[s.length - 1] === q) return s.slice(1, -1);
  }
  return s;
}

function normalizeAbs(p: string): string {
  let n = p.replace(/\/{2,}/g, "/");
  if (n.length > 1) n = n.replace(/\/+$/, "");
  return n || "/";
}

/** Resolve a raw shell token to an absolute path using curDir for relatives. */
function resolveToken(raw: string, curDir: string, home: string): string {
  let p = stripQuotes(raw.trim());
  p = p
    .replace(/^\$HOME(?=\/|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|$)/, home)
    .replace(/^\$(PWD)(?=\/|$)/, curDir)
    .replace(/^\$\{PWD\}(?=\/|$)/, curDir);
  if (p === "~" || p.startsWith("~/")) p = home + p.slice(1);
  if (p === "/*" || p === "/**" || p === "/**/*") return "/";
  if (p.endsWith("/*") && p.startsWith("/")) {
    return normalizeAbs(p.slice(0, -2) || "/");
  }
  if (!p.startsWith("/")) {
    if (p === "." || p === "") return normalizeAbs(curDir);
    return normalizeAbs(posixPath.resolve(curDir, p));
  }
  return normalizeAbs(p);
}

function isNeverScan(abs: string): boolean {
  return LINUX_NEVER_SCAN.some((r) => abs === r || abs.startsWith(r + "/"));
}

function isHighCostRoot(abs: string, home: string): boolean {
  if (isNeverScan(abs)) return true;
  if (LINUX_HIGH_IO_ROOTS.has(abs)) return true;
  if (abs === normalizeAbs(home)) return true;
  if (HOME_SINGLE_RE.test(abs)) return true;
  return false;
}

// ---------------------------------------------------------------- shell splitting

/** Split a command line on unquoted ; & | newline (keeps each pipeline stage separate). */
function splitSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let sq = false;
  let dq = false;
  let bs = false;
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (bs) {
      cur += c;
      bs = false;
      continue;
    }
    if (c === "\\" && !sq) {
      cur += c;
      bs = true;
      continue;
    }
    if (c === "'" && !dq) {
      sq = !sq;
      cur += c;
      continue;
    }
    if (c === '"' && !sq) {
      dq = !dq;
      cur += c;
      continue;
    }
    if (!sq && !dq) {
      if (c === "\n" || c === ";") {
        push();
        continue;
      }
      if (c === "&" && cmd[i + 1] === "&") {
        push();
        i++;
        continue;
      }
      if (c === "|" && cmd[i + 1] === "|") {
        push();
        i++;
        continue;
      }
      if (c === "|") {
        push();
        continue;
      }
      if (c === "&") {
        push();
        continue;
      }
    }
    cur += c;
  }
  push();
  return out;
}

/** Collect inner $(...) / `...` bodies so obfuscated scans are still caught. */
function collectBodies(cmd: string): string[] {
  const bodies: string[] = [cmd];
  const dollar = /\$\(\s*([^()]|\([^()]*\))*\)/g;
  let m: RegExpExecArray | null;
  while ((m = dollar.exec(cmd)) !== null) {
    bodies.push(m[0].slice(2, -1));
  }
  const backtick = /`([^`]+)`/g;
  while ((m = backtick.exec(cmd)) !== null) {
    bodies.push(m[1]);
  }
  return bodies;
}

/** Downstream pipe consumers in a command line (for block feedback only). */
function pipeConsumers(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(/\|(?!\|)\s*([A-Za-z0-9_./-]+)/g)) {
    const bin = binName(m[1]);
    if (bin && !out.includes(bin)) out.push(bin);
  }
  return out;
}

/** Explain why a downstream pipe command failed to bound the scan. */
function consumerNote(command: string): string | undefined {
  const consumers = pipeConsumers(command);
  if (consumers.length === 0) return undefined;
  const c = consumers[0];
  let why: string;
  if (BUFFERING_CONSUMERS.has(c)) {
    why = `\`${c}\` reads every line before producing output, so truncating its output does not stop the walk`;
  } else if (TRUNCATING_CONSUMERS.has(c)) {
    why = `\`${c}\` exits only after N matching lines/bytes appear — a scan with no matches still runs to completion`;
  } else {
    why = `\`${c}\` keeps reading until the upstream walk finishes, so it does not bound it`;
  }
  return `Note: piping to \`${c}\` does not bound this scan — ${why}.`;
}

/** Wrapper commands stripped before tool detection. */
const WRAPPER_BINS = new Set([
  "sudo", "doas", "env", "time", "nice", "ionice", "nohup", "setsid",
  "stdbuf", "unshare", "command", "builtin", "timeout",
]);

/** Option flags that consume a following value (so it is not mistaken for argv[0]). */
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "--user", "-g", "--group", "-p", "--prompt", "-C", "--close-from", "-h", "--host", "-r", "--role", "-t", "--type", "-D", "--chdir", "-R", "--chroot", "-U", "--other-user"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "--unset", "-S", "--split-string", "-C", "--chdir"]),
  time: new Set(["-f", "--format", "-o", "--output"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"]),
  timeout: new Set(["-k", "--kill-after", "-s", "--signal"]),
  stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
};

/** Parse a coreutils duration token (5, 15s, 2m, 1h) into seconds. */
function parseDuration(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/^(\d+(?:\.\d+)?)([smhd]?)$/i);
  if (!m) return null;
  const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return parseFloat(m[1]) * (mult[(m[2] || "s").toLowerCase()] ?? 1);
}

/**
 * Strip sudo/env/nice/timeout/VAR= prefixes using a token walk so option
 * values (nice -n 10, env -u HOME, timeout -k 5) are not mistaken for the
 * wrapped command. Returns the wrapped argv plus the timeout duration found.
 */
function stripWrappers(segment: string): { argv: string[]; timeoutSeconds: number | null } {
  let argv = tokenize(segment);
  let timeoutSeconds: number | null = null;
  for (;;) {
    let changed = false;
    while (argv.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) {
      argv = argv.slice(1);
      changed = true;
    }
    // Leading output redirects (`2>/dev/null find /`)
    if (!changed && argv.length > 0 && /^\d*>>?$/.test(argv[0])) {
      argv = argv.slice(2);
      changed = true;
    }
    if (!changed && argv.length > 0 && /^\d*>>?[^>]/.test(argv[0])) {
      argv = argv.slice(1);
      changed = true;
    }
    if (!changed && argv.length > 0 && WRAPPER_BINS.has(binName(argv[0]))) {
      const bin = binName(argv[0]);
      const valueFlags = WRAPPER_VALUE_FLAGS[bin] ?? new Set<string>();
      let i = 1;
      while (i < argv.length) {
        const t = argv[i];
        if (t === "--") {
          i++;
          break;
        }
        if (!t.startsWith("-") || t === "-") break;
        const eq = t.indexOf("=");
        const name = eq >= 0 ? t.slice(0, eq) : t;
        if (bin === "env" && (name === "-S" || name === "--split-string")) {
          // `env -S 'cmd ...'` splits the string and runs it: splice it back in.
          if (eq >= 0) {
            argv = [...argv.slice(0, i), ...tokenize(t.slice(eq + 1)), ...argv.slice(i + 1)];
            continue;
          }
          if (argv[i + 1] !== undefined) {
            argv = [...argv.slice(0, i), ...tokenize(argv[i + 1]), ...argv.slice(i + 2)];
            continue;
          }
        }
        if (valueFlags.has(name) && eq < 0) {
          i += 2; // flag plus its separate value
          continue;
        }
        if (!name.startsWith("--") && name.length > 2 && valueFlags.has("-" + name[name.length - 1])) {
          i += 2; // combined short flags ending in a value flag: -iu root
          continue;
        }
        i += 1; // plain flag, or attached value like -n5/-oL
      }
      if (bin === "timeout") {
        timeoutSeconds = parseDuration(argv[i]);
        if (i < argv.length) i += 1; // consume the duration token
      }
      argv = argv.slice(i);
      changed = true;
    }
    if (!changed) break;
  }
  return { argv, timeoutSeconds };
}

/** Quote-aware argv split. */
function tokenize(segment: string): string[] {
  const out: string[] = [];
  let cur = "";
  let sq = false;
  let dq = false;
  let bs = false;
  const push = () => {
    if (cur) out.push(cur);
    cur = "";
  };
  for (const c of segment) {
    if (bs) {
      cur += c;
      bs = false;
      continue;
    }
    if (c === "\\" && !sq) {
      bs = true;
      continue;
    }
    if (c === "'" && !dq) {
      sq = !sq;
      continue;
    }
    if (c === '"' && !sq) {
      dq = !dq;
      continue;
    }
    if (!sq && !dq && /\s/.test(c)) {
      push();
      continue;
    }
    cur += c;
  }
  push();
  return out;
}

function binName(argv0: string): string {
  const b = argv0.split("/").pop() ?? argv0;
  return b.toLowerCase();
}

function maxdepthOf(segment: string): number | null {
  const m =
    segment.match(/(?:^|\s)(?:-maxdepth|--max-depth|-d)\s*=?\s*(\d+)/) ??
    segment.match(/(?:^|\s)-L\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ---------------------------------------------------------------- feedback

function buildFeedback(opts: {
  segment: string;
  why: string;
  cwd: string;
  rewrite?: string;
  picks: string[];
  note?: string;
}): string {
  const seg =
    opts.segment.length > 200 ? opts.segment.slice(0, 200) + "…" : opts.segment;
  const lines = [
    `Blocked: \`${seg}\``,
    "",
    opts.why,
  ];
  if (opts.note) lines.push("", opts.note);
  lines.push("", "Use instead (scoped to a leaf dir, bounded):");
  if (opts.rewrite && opts.rewrite !== opts.segment) {
    const rw =
      opts.rewrite.length > 200 ? opts.rewrite.slice(0, 200) + "…" : opts.rewrite;
    lines.push(`  ${rw}`);
  }
  for (const p of opts.picks.slice(0, 2)) lines.push(`  ${p}`);
  lines.push("", `cwd: ${opts.cwd} — prefer \`.\` or a leaf like /var/log/<app>, /opt/<app>, /tmp/<job>.`);
  return lines.join("\n");
}

function scopedRewrite(
  segment: string,
  rawPaths: string[],
): string | undefined {
  let out = segment;
  let changed = false;
  for (const raw of rawPaths) {
    if (!raw) continue;
    const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // token replace (covers "/", "/*", quoted paths)
    const simple = new RegExp(`(^|\\s)${esc}(?=\\s|$)`);
    if (simple.test(out)) {
      out = out.replace(simple, "$1.");
      changed = true;
    }
  }
  if (!changed) return undefined;
  if (!/2>\/dev\/null/.test(out)) out += " 2>/dev/null";
  if (!/\|\s*(head|tail)\b/.test(out)) out += " | head -50";
  return out;
}

// ---------------------------------------------------------------- device reads

function isGlobRead(raw: string): boolean {
  return (
    raw.includes("/**") ||
    raw === "/*" ||
    /^\/\*(\/|$)/.test(raw) ||
    /\/(proc|sys|dev)\/\*/.test(raw)
  );
}

/** Native "read only N bytes/lines" flags that make a device read finite. */
const NATIVE_READ_BOUND_FLAGS: Record<string, string[]> = {
  head: ["-c", "-n", "--bytes", "--lines"],
  tail: ["-c", "-n", "--bytes", "--lines"],
  od: ["-N", "--read-bytes"],
  xxd: ["-l"],
  hexdump: ["-n"],
};

const TAIL_FOLLOW_FLAGS = new Set([
  "-f",
  "-F",
  "--follow",
  "--follow=name",
  "--follow=descriptor",
]);

function hasNativeReadBound(bin: string, rest: string[]): boolean {
  const flags = NATIVE_READ_BOUND_FLAGS[bin];
  if (!flags) return false;
  if (bin === "tail" && rest.some((t) => TAIL_FOLLOW_FLAGS.has(t))) return false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if ((bin === "head" || bin === "tail") && /^-\d+$/.test(t)) return true;
    for (const f of flags) {
      if (t === f) {
        const v = rest[i + 1];
        if (v !== undefined && /^\d+[kKmMgG]?[bB]?$/.test(v)) return true;
      } else if (t.startsWith(f + "=") && /^\d/.test(t.slice(f.length + 1))) {
        return true;
      } else if (f.length === 2 && t.startsWith(f) && t.length > 2 && /^\d/.test(t.slice(2))) {
        return true;
      }
    }
  }
  return false;
}

/** Operand paths plus stdin-redirect targets (`wc < /dev/zero`, `wc </dev/zero`). */
function readCandidates(rest: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "<") {
      const next = rest[i + 1];
      if (next) {
        out.push(next);
        i++;
      }
      continue;
    }
    if (/^\d*</.test(t)) {
      const inline = t.replace(/^\d*</, "");
      if (inline) {
        out.push(inline);
        continue;
      }
      const next = rest[i + 1];
      if (next) {
        out.push(next);
        i++;
      }
      continue;
    }
    if (t.startsWith("-") && t.length > 1) continue;
    out.push(t);
  }
  return out;
}

function checkDeviceReads(
  bin: string,
  argv: string[],
  curDir: string,
  home: string,
  boundedTimeout: boolean,
): SegHit | null {
  if (!STREAM_READER_BINS.has(bin) || bin === "dd") return null;
  const rest = argv.slice(1);
  const candidates = readCandidates(rest);
  if (candidates.length === 0) return null;
  const boundOk = boundedTimeout || hasNativeReadBound(bin, rest);
  for (const tok of candidates) {
    const raw = stripQuotes(tok);
    if (isGlobRead(raw)) {
      return {
        summary: `${bin} over a filesystem glob`,
        why: `${bin} ${raw} expands to thousands of files (or infinite virtual files) — scope to explicit paths.`,
        rawPaths: [tok],
        rewritePicks: [`${bin} /var/log/<app>/<file>`, `${bin} <leaf>/* 2>/dev/null | head -50`],
      };
    }
    const abs = resolveToken(raw, curDir, home);
    if (INFINITE_DEVICES.has(abs) && !boundOk) {
      return {
        summary: `${bin} on an infinite device file`,
        why: `${bin} ${abs} never ends — it streams forever; no downstream pipe bounds it.`,
        rawPaths: [tok],
        rewritePicks: [
          `head -c 1K ${abs} 2>/dev/null  # bounded read`,
          `timeout ${MAX_EXEMPT_TIMEOUT_S} ${bin} ${abs}  # bounded by wall clock`,
        ],
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------- per-tool checks

interface SegHit {
  summary: string;
  why: string;
  rawPaths: string[];
  rewritePicks: string[];
}

function nonFlagArgs(tokens: string[], skipValueFor: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") continue;
    if (t.startsWith("-") && t.length > 1) {
      const name = t.split("=")[0];
      if (!t.includes("=") && skipValueFor.has(name)) i++; // consume value
      continue;
    }
    out.push(t);
  }
  return out;
}

/** True when the search pattern comes from -e/-f, so no positional pattern is expected. */
function patternFlagUsed(tokens: string[], longForms: string[], shortLetters: string[]): boolean {
  for (const t of tokens) {
    if (t === "--") break;
    if (t.startsWith("--")) {
      if (longForms.includes(t.split("=")[0])) return true;
      continue;
    }
    if (t.startsWith("-") && t.length > 1 && /^[A-Za-z]+$/.test(t.slice(1))) {
      if (shortLetters.some((c) => t.includes(c))) return true;
    }
  }
  return false;
}

const GREP_VALUE_FLAGS = new Set([
  "-e",
  "-f",
  "--regexp",
  "--file",
  "--include",
  "--exclude",
  "--exclude-dir",
  "-m",
  "--max-count",
]);
const RG_VALUE_FLAGS = new Set([
  "-e",
  "--regexp",
  "-f",
  "--file",
  "-g",
  "--glob",
  "--iglob",
  "-t",
  "--type",
  "--type-add",
  "-m",
  "--max-count",
  "--max-depth",
  "-A",
  "-B",
  "-C",
  "--after-context",
  "--before-context",
  "--context",
]);

function checkSegment(
  segment: string,
  curDir: string,
  home: string,
): SegHit | null {
  const { argv, timeoutSeconds } = stripWrappers(segment);
  if (argv.length === 0) return null;
  const core = argv.join(" ");
  const bin = binName(argv[0]);
  const rest = argv.slice(1);
  const maxd = maxdepthOf(core);
  const boundedDepth = maxd !== null && maxd <= 2;
  const boundedTimeout =
    timeoutSeconds !== null && timeoutSeconds > 0 && timeoutSeconds <= MAX_EXEMPT_TIMEOUT_S;
  const exemptHigh = boundedTimeout || boundedDepth;

  const deviceHit = checkDeviceReads(bin, argv, curDir, home, boundedTimeout);
  if (deviceHit) return deviceHit;

  const classify = (
    rawPaths: string[],
    opts?: { defaultToCur?: boolean },
  ): { abs: string; raw: string }[] => {
    const raws = rawPaths.length > 0 ? rawPaths : opts?.defaultToCur ? ["."] : [];
    return raws.map((raw) => ({
      raw,
      abs: resolveToken(raw, curDir, home),
    }));
  };

  const hitFor = (
    found: { abs: string; raw: string }[],
    rawPaths: string[],
    summary: string,
    whyNever: string,
    whyHigh: string,
    picks: string[],
  ): SegHit | null => {
    const never = found.filter((f) => isNeverScan(f.abs));
    if (never.length > 0) {
      return {
        summary,
        why: `${whyNever} (${never.map((n) => n.abs).join(", ")}) — read a single file instead.`,
        rawPaths: never.map((n) => n.raw),
        rewritePicks: picks,
      };
    }
    const high = found.filter((f) => isHighCostRoot(f.abs, home));
    if (high.length > 0 && !exemptHigh) {
      return {
        summary,
        why: `${whyHigh} (${high.map((h) => h.abs).join(", ")}) — full traversal hangs and thrashes disk.`,
        rawPaths: high.map((h) => h.raw),
        rewritePicks: picks,
      };
    }
    return null;
  };

  // ---- find
  if (bin === "find") {
    // skip global opts, then leading paths
    let i = 0;
    const paths: string[] = [];
    while (i < rest.length) {
      const t = rest[i];
      if (t === "-H" || t === "-L" || t === "-P" || t === "-D" || t === "-O") {
        i++;
        continue;
      }
      if (
        (t === "-maxdepth" ||
          t === "-mindepth" ||
          t === "-regextype" ||
          t === "--max-depth") &&
        i + 1 < rest.length
      ) {
        i += 2;
        continue;
      }
      if (t.startsWith("-") || t === "(" || t === "!" || t === ",") break;
      paths.push(t);
      i++;
    }
    const found = classify(paths, { defaultToCur: true });
    return hitFor(
      found,
      paths.length > 0 ? paths : ["."],
      "find from high-IO root",
      "find must never walk virtual FS",
      "find from a high-IO root walks 100k+ files plus /proc loops and docker overlayfs",
      [
        "find /var/log/<app> -xdev -maxdepth 3 -type f -name '<name>' 2>/dev/null | head -50",
        "fd '<name>' /opt/<app>  # or: rg --files <leaf> | rg '<name>'",
      ],
    );
  }

  // ---- grep family (recursive only)
  if (
    bin === "grep" ||
    bin === "egrep" ||
    bin === "fgrep" ||
    bin === "zgrep"
  ) {
    if (!/(^|\s)-(?:[a-zA-Z]*[rR]|--recursive)/.test(core) && !core.includes("--recursive")) {
      return null; // single-file grep is cheap
    }
    const args = nonFlagArgs(rest, GREP_VALUE_FLAGS);
    const explicitPattern = patternFlagUsed(rest, ["--regexp", "--file"], ["e", "f"]);
    if (!explicitPattern && args.length === 0) return null; // no pattern at all
    const paths = explicitPattern ? args : args.slice(1); // otherwise first non-flag is the pattern
    const found = classify(paths, { defaultToCur: paths.length === 0 });
    const rFlag = /(^|\s)-[a-zA-Z]*R/.test(core);
    return hitFor(
      found,
      paths.length > 0 ? paths : ["."],
      "recursive grep from high-IO root",
      "recursive grep must never read /proc /sys /dev",
      `recursive grep reads every file's contents${rFlag ? " (-R follows symlinks into /proc/self loops — worse)" : ""}`,
      [
        `rg '<pattern>' /opt/<app> --max-files 200 | head -50`,
        `grep -rn '<pattern>' ./src --include='*.ts' | head -50`,
      ],
    );
  }

  // ---- rg / ag / ack (recursive by default)
  if (bin === "rg" || bin === "ag" || bin === "ack") {
    const args = nonFlagArgs(rest, RG_VALUE_FLAGS);
    const explicitPattern = patternFlagUsed(rest, ["--regexp", "--file"], ["e", "f"]);
    let paths: string[];
    if (core.includes("--files")) {
      paths = args;
    } else {
      if (!explicitPattern && args.length === 0) return null; // no pattern: rg errors
      paths = explicitPattern ? args : args.slice(1);
    }
    const found = classify(paths, { defaultToCur: true });
    return hitFor(
      found,
      paths.length > 0 ? paths : ["."],
      `${bin} from high-IO root`,
      `${bin} must never walk virtual FS`,
      `${bin} from a high-IO root has no .gitignore to save it and reads the whole machine`,
      [
        `${bin} '<pattern>' /opt/<app> --max-files 200 | head -50`,
        `${bin} '<pattern>' . | head -50`,
      ],
    );
  }

  // ---- fd / fdfind
  if (bin === "fd" || bin === "fdfind") {
    let end = rest.length;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "-x" || rest[i] === "--exec" || rest[i] === ";") {
        end = i;
        break;
      }
    }
    const args = nonFlagArgs(
      rest.slice(0, end),
      new Set(["-d", "--max-depth", "-e", "--extension", "-t", "--type", "-E", "--exclude"]),
    );
    const paths = args.slice(1);
    const found = classify(paths, { defaultToCur: true });
    return hitFor(
      found,
      paths.length > 0 ? paths : ["."],
      `${bin} from high-IO root`,
      `${bin} must never walk virtual FS`,
      `${bin} from a high-IO root enumerates the whole machine`,
      [`${bin} '<name>' /opt/<app> -d 4 | head -50`, `${bin} '<name>' . | head -50`],
    );
  }

  // ---- ls (recursive only)
  if (bin === "ls") {
    if (!/(^|\s)-(?:[a-zA-Z]*R|--recursive)/.test(core)) return null; // plain ls is cheap
    const args = nonFlagArgs(rest, new Set(["--color", "--time-style"]));
    const found = classify(args, { defaultToCur: true });
    return hitFor(
      found,
      args.length > 0 ? args : ["."],
      "ls -R from high-IO root",
      "ls -R must never walk virtual FS",
      "ls -R materializes every pathname and floods context",
      ["ls -R /opt/<app> | head -100", "tree -L 2 <leaf>  # or: fd -t f <leaf> | head -50"],
    );
  }

  // ---- tree (always recursive)
  if (bin === "tree") {
    const args = nonFlagArgs(rest, new Set(["-L", "-P", "-I"]));
    const found = classify(args, { defaultToCur: true });
    return hitFor(
      found,
      args.length > 0 ? args : ["."],
      "tree from high-IO root",
      "tree must never walk virtual FS",
      "tree renders every directory and floods context",
      ["tree -L 2 /opt/<app> | head -100", "fd -t d <leaf> -d 2 | head -50"],
    );
  }

  // ---- du / ncdu (summing still walks everything; no depth exemption)
  if (bin === "du" || bin === "ncdu") {
    const args = nonFlagArgs(
      rest,
      new Set(["-d", "--max-depth", "--threshold", "--exclude", "-B", "-b", "--block-size"]),
    );
    const found = classify(args, { defaultToCur: true });
    const never = found.filter((f) => isNeverScan(f.abs));
    if (never.length > 0) {
      return {
        summary: `${bin} on virtual FS`,
        why: `${bin} on virtual FS (${never.map((n) => n.abs).join(", ")}) reports nonsense — use df -h instead.`,
        rawPaths: never.map((n) => n.raw),
        rewritePicks: ["df -h", "du -d 1 -h <leaf> | sort -h"],
      };
    }
    const high = found.filter((f) => isHighCostRoot(f.abs, home));
    if (high.length > 0 && !boundedTimeout) {
      return {
        summary: `${bin} from high-IO root`,
        why: `${bin} from a high-IO root (${high.map((h) => h.abs).join(", ")}) stats 100k+ files — -s does not save you, it still walks everything.`,
        rawPaths: high.map((h) => h.raw),
        rewritePicks: ["du -d 1 -h /var/log/<app> 2>/dev/null | sort -h", "du -sh <leaf>/* 2>/dev/null | sort -h | head"],
      };
    }
    return null;
  }

  // ---- updatedb (the indexer itself IS the IO storm)
  if (bin === "updatedb" || bin === "mlocate.db" || bin === "plocate-build") {
    return {
      summary: "updatedb re-indexes the disk",
      why: "updatedb re-indexes the whole disk — the IO storm itself. Use fd/rg scoped to a leaf instead.",
      rawPaths: [],
      rewritePicks: ["fd '<name>' /opt/<app>", "rg --files <leaf> | rg '<name>'"],
    };
  }

  // ---- journalctl without bounds (Linux log firehose)
  if (bin === "journalctl") {
    const bounded =
      /--since\b|--until\b|\s-S\b|\s-U\b|\s-n\b|--lines[=\s]|-n\s*\d/.test(core);
    if (!bounded) {
      return {
        summary: "unbounded journalctl",
        why: "unbounded journalctl can dump GBs of logs — always bound it.",
        rawPaths: [],
        rewritePicks: [
          `journalctl -u <service> --since "1h ago" --no-pager | head -100`,
          "journalctl -n 200 --no-pager  # last 200 lines only",
        ],
      };
    }
    return null;
  }

  // ---- dd with unbounded /dev reads or destructive writes
  if (bin === "dd") {
    let ifVal: string | null = null;
    let ofVal: string | null = null;
    let hasCount = false;
    for (const t of rest) {
      const m = t.match(/^([a-z]+)=(.*)$/i);
      if (!m) continue;
      const k = m[1].toLowerCase();
      if (k === "if") ifVal = stripQuotes(m[2]);
      if (k === "of") ofVal = stripQuotes(m[2]);
      if (k === "count") hasCount = true;
    }
    if (
      ofVal &&
      /^\/dev\/(sd|hd|vd|nvme|xvd|mmcblk|disk|mapper)/.test(ofVal)
    ) {
      return {
        summary: "dd writing to a block device",
        why: `dd of=${ofVal} writes raw to a disk — destructive and never what an agent wants.`,
        rawPaths: [],
        rewritePicks: ["dd if=<file> of=/tmp/<out> bs=4M status=progress", "# ask the user before touching block devices"],
      };
    }
    if (
      ifVal &&
      /^\/(dev\/(zero|urandom|random|full|kmsg|mem|kmem|port|sda|hda|vda|xvd|nvme|mmcblk)|proc\/(kcore|kmsg))/.test(
        resolveToken(ifVal, curDir, home),
      ) &&
      !hasCount
    ) {
      return {
        summary: "unbounded dd from a device file",
        why: `dd if=${ifVal} without count= streams until the disk fills or forever.`,
        rawPaths: [],
        rewritePicks: ["dd if=<file> of=/tmp/<out> bs=4M count=10 status=progress", "head -c 10M <file> > /tmp/<out>"],
      };
    }
    return null;
  }

  return null;
}

const SHELL_BINS = new Set(["sh", "bash", "dash", "zsh", "ksh", "mksh"]);
const MAX_SHELL_DEPTH = 3;

/** Extract the command string from `sh -c '<cmd>'` style invocations. */
function shellCommandArg(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--") break;
    if (!t.startsWith("-") || t === "-") break;
    if (/^-[a-z]*c[a-z]*$/i.test(t)) return argv[i + 1] ?? null;
  }
  return null;
}

function checkCommandDepth(
  command: string,
  cwd: string,
  home: string,
  depth: number,
): SearchGuardHit | null {
  if (!command || !command.trim()) return null;
  const cur0 = cwd && cwd.startsWith("/") ? normalizeAbs(cwd) : "/home";
  for (const body of collectBodies(command)) {
    let curDir = cur0;
    for (const segment of splitSegments(body)) {
      const { argv } = stripWrappers(segment);
      if (argv.length > 0 && binName(argv[0]) === "cd") {
        const arg = argv[1];
        if (arg && arg !== "-" && arg !== "--") {
          curDir = resolveToken(stripQuotes(arg), curDir, home);
        } else if (argv.length === 1) {
          curDir = normalizeAbs(home);
        }
        continue;
      }
      if (depth < MAX_SHELL_DEPTH && argv.length > 0 && SHELL_BINS.has(binName(argv[0]))) {
        const inner = shellCommandArg(argv);
        if (inner) {
          const innerHit = checkCommandDepth(inner, curDir, home, depth + 1);
          if (innerHit) return innerHit;
          continue;
        }
      }
      const hit = checkSegment(segment, curDir, home);
      if (hit) {
        const rewrite = scopedRewrite(segment.trim(), hit.rawPaths);
        return {
          segment: segment.trim(),
          summary: hit.summary,
          feedback: buildFeedback({
            segment: segment.trim(),
            why: hit.why,
            cwd: cur0,
            rewrite,
            picks: hit.rewritePicks,
            note: consumerNote(command),
          }),
        };
      }
    }
  }
  return null;
}

/** Main entry: scan a full bash command. Returns the first hit. */
export function checkSearchCommand(
  command: string,
  cwd: string,
  home: string = defaultHome(),
): SearchGuardHit | null {
  return checkCommandDepth(command, cwd, home, 0);
}

// ---------------------------------------------------------------- self-test

export interface SearchGuardTestCase {
  cmd: string;
  expect: "block" | "allow";
  cwd?: string;
  why?: string;
}

const TEST_CWD = "/tmp/proj";

export const SELF_TESTS: SearchGuardTestCase[] = [
  // user's original case + downstream consumers are never bounds
  { cmd: "find / -name '*.log'", expect: "block", why: "bare high-IO root" },
  { cmd: "find / -name '*.log' | head -5", expect: "block", why: "head is data-dependent" },
  { cmd: "find / | head 5", expect: "block", why: "head is data-dependent" },
  { cmd: "find / | tail -5", expect: "block", why: "tail reads to EOF" },
  { cmd: "find / | tail -f", expect: "block", why: "tail -f never ends" },
  { cmd: "find / | sort | head -5", expect: "block", why: "sort reads to EOF first" },
  { cmd: "find / | sort", expect: "block" },
  { cmd: "find / | wc -l", expect: "block" },
  { cmd: "find / | uniq | head", expect: "block" },
  { cmd: "find / | tac | head", expect: "block" },
  { cmd: "find / | tee /tmp/x | head", expect: "block" },
  { cmd: "find / | xargs -0 rm", expect: "block" },
  { cmd: "find / | cat | head", expect: "block", why: "cat is a passthrough" },
  { cmd: "find / | head -n 1000000", expect: "block", why: "huge head count is not a bound" },
  // cross-segment leakage is gone
  { cmd: "find / ; echo done | head -1", expect: "block" },
  { cmd: "find / && cat /etc/hosts | head -1", expect: "block" },
  // every recursive tool
  { cmd: "du / | head", expect: "block" },
  { cmd: "du / | sort -h | head", expect: "block" },
  { cmd: "du / -d 1 | head", expect: "block", why: "depth does not bound du" },
  { cmd: "tree / | head -20", expect: "block" },
  { cmd: "ls -R / | head", expect: "block" },
  { cmd: "rg pattern / | head -5", expect: "block" },
  { cmd: "fd pattern / | head", expect: "block" },
  { cmd: "grep -r foo / | head -5", expect: "block" },
  // never-scan + depth
  { cmd: "find /proc -maxdepth 2 | head -1", expect: "block", why: "/proc is never exempt" },
  { cmd: "find / -maxdepth 3", expect: "block", why: "depth 3 is not a bound" },
  // timeout cap 120s
  { cmd: "timeout 121 find /", expect: "block" },
  { cmd: "timeout 600 find /", expect: "block" },
  { cmd: "timeout 0 find /", expect: "block", why: "0 disables the timeout in GNU timeout" },
  { cmd: "timeout infinity find /", expect: "block" },
  { cmd: "timeout -k 5 300 find /", expect: "block" },
  // wrapper parsing
  { cmd: "nice -n 10 find /", expect: "block" },
  { cmd: "env -u HOME find /", expect: "block" },
  { cmd: "sudo -u root find /", expect: "block" },
  { cmd: "sudo -iu root find /", expect: "block", why: "combined short flags" },
  { cmd: "env -S 'find /'", expect: "block", why: "env -S splits and runs the string" },
  { cmd: "env --split-string='find /'", expect: "block", why: "env --split-string= form" },
  { cmd: "rg -e foo / | head", expect: "block", why: "pattern via -e, / is a path" },
  { cmd: "grep -r -e foo /", expect: "block", why: "pattern via -e, / is a path" },
  { cmd: "2>/dev/null find /proc/kcore", expect: "block", why: "leading output redirect" },
  // shell indirection
  { cmd: "sh -c 'find / | head -5'", expect: "block" },
  { cmd: "sudo sh -c 'find / | head'", expect: "block" },
  // pathless recursive tools in a high-IO cwd
  { cmd: "cd / && rg pattern", expect: "block" },
  { cmd: "cd / && fd", expect: "block" },
  { cmd: "cd /home/example && fd -e ts", expect: "block" },
  { cmd: "cd / && grep -r foo", expect: "block" },
  // infinite devices
  { cmd: "cat /dev/zero", expect: "block" },
  { cmd: "tail /dev/zero", expect: "block" },
  { cmd: "tail -f -n 5 /dev/zero", expect: "block", why: "follow never ends" },
  { cmd: "head /dev/urandom", expect: "block" },
  { cmd: "wc /dev/zero", expect: "block" },
  { cmd: "od /dev/urandom", expect: "block" },
  { cmd: "sort < /dev/zero", expect: "block" },
  { cmd: "cp /dev/zero /tmp/fill", expect: "block" },
  { cmd: "md5sum < /dev/zero", expect: "block" },
  { cmd: "dd if=/dev/zero", expect: "block" },
  { cmd: "dd of=/dev/sda", expect: "block" },
  // allowed: real bounds
  { cmd: "find / -maxdepth 2", expect: "allow" },
  { cmd: "find / -maxdepth 2 | head", expect: "allow" },
  { cmd: "tree -L 2 /", expect: "allow" },
  { cmd: "find /var/log/myapp -maxdepth 3 -type f 2>/dev/null | head -50", expect: "allow" },
  { cmd: "rg pattern ./src | head -20", expect: "allow" },
  { cmd: "du -sh /var/log/myapp/* 2>/dev/null | head", expect: "allow" },
  { cmd: "timeout 120 find /", expect: "allow", why: "cap boundary" },
  { cmd: "timeout 2m find /", expect: "allow", why: "2m = 120s boundary" },
  { cmd: "timeout 5 tail /dev/zero", expect: "allow", why: "timeout bounds a device read" },
  { cmd: "head -c 100 /dev/urandom", expect: "allow" },
  { cmd: "tail -n 5 /dev/urandom", expect: "allow" },
  { cmd: "od -N 100 /dev/urandom", expect: "allow" },
  { cmd: "xxd -l 100 /dev/zero", expect: "allow" },
  { cmd: "head -n 5 /var/log/syslog", expect: "allow" },
  { cmd: "cd /tmp/proj && rg pattern", expect: "allow" },
  { cmd: "nice -n 10 find /tmp/proj -maxdepth 2", expect: "allow" },
  { cmd: "sh -c 'find . -maxdepth 2'", expect: "allow" },
  { cmd: "find /tmp/proj -name '*.ts' | head", expect: "allow" },
  { cmd: "grep -rn foo ./src --include='*.ts' | head -50", expect: "allow" },
  { cmd: "ls -R /tmp/proj | head", expect: "allow" },
  { cmd: "journalctl -n 200 --no-pager", expect: "allow" },
  { cmd: "du -d 1 -h /var/log/myapp", expect: "allow" },
];

export function runSelfTests(): {
  total: number;
  pass: number;
  failed: SearchGuardTestCase[];
} {
  const failed: SearchGuardTestCase[] = [];
  let pass = 0;
  for (const t of SELF_TESTS) {
    const blocked = checkSearchCommand(t.cmd, t.cwd ?? TEST_CWD) !== null;
    if (blocked === (t.expect === "block")) pass++;
    else failed.push(t);
  }
  return { total: SELF_TESTS.length, pass, failed };
}

// ---------------------------------------------------------------- extension wiring

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const e = event as unknown as {
      toolName?: string;
      input?: { command?: unknown };
    };
    if (e.toolName !== "bash") return undefined;
    if (typeof e.input?.command !== "string") return undefined;
    const hit = checkSearchCommand(e.input.command, ctx.cwd);
    if (hit) {
      return { block: true, reason: `${hit.feedback}\n\n(matched: ${hit.summary})` };
    }
    return undefined;
  });

  pi.on("user_bash", (event) => {
    const e = event as unknown as { command?: unknown; cwd?: unknown };
    if (typeof e.command !== "string") return undefined;
    const cwd = typeof e.cwd === "string" ? e.cwd : process.cwd();
    const hit = checkSearchCommand(e.command, cwd);
    if (hit) {
      return {
        result: {
          output: `${hit.feedback}\n\n(matched: ${hit.summary})`,
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
    return undefined;
  });

  pi.on("before_agent_start", async (event) => {
    const e = event as unknown as { systemPrompt?: string };
    return { systemPrompt: `${e.systemPrompt ?? ""}\n\n${SEARCH_POLICY}` };
  });

  pi.registerCommand("search-guard", {
    description: "Show disk-search guard policy, test a command, or run self-tests",
    handler: async (args, ctx) => {
      const text = (args ?? "").trim();
      if (text.startsWith("selftest")) {
        const r = runSelfTests();
        if (r.failed.length === 0) {
          ctx.ui.notify(`search-guard self-tests: ${r.pass}/${r.total} passed.`, "info");
        } else {
          const shown = r.failed
            .slice(0, 5)
            .map((f) => `${f.expect === "block" ? "should block" : "should allow"}: ${f.cmd}`)
            .join("\n");
          ctx.ui.notify(
            `search-guard self-tests: ${r.pass}/${r.total} passed; ${r.failed.length} failed:\n${shown}`,
            "warning",
          );
        }
        return;
      }
      if (text.startsWith("test")) {
        const rest = text.replace(/^test\s+/, "");
        if (!rest) {
          ctx.ui.notify("Usage: /search-guard test <command>", "warning");
          return;
        }
        const hit = checkSearchCommand(rest, ctx.cwd);
        ctx.ui.notify(
          hit ? `BLOCKED (${hit.summary}):\n${hit.feedback}` : `ALLOWED: ${rest}`,
          hit ? "warning" : "info",
        );
        return;
      }
      ctx.ui.notify(STATUS_TEXT, "info");
    },
  });
}

// ---------------------------------------------------------------- direct-run self-test

const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const r = runSelfTests();
  for (const f of r.failed) {
    console.error(
      `FAIL: expected ${f.expect} for \`${f.cmd}\`${f.why ? `  (${f.why})` : ""}`,
    );
  }
  console.log(`search-guard self-tests: ${r.pass}/${r.total} passed`);
  process.exit(r.failed.length > 0 ? 1 : 0);
}
