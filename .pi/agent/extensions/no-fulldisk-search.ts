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
 * Instead of rejecting silently, every block returns copy-paste scoped
 * alternatives (leaf dir + -maxdepth/-xdev/timeout/head).
 *
 * Test without running anything:  /search-guard test <command>
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { posix as posixPath } from "node:path";

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

const SEARCH_POLICY =
  "Disk-search policy (Linux): never run recursive scans from high-IO roots " +
  "(/, /home, /root, ~, /etc, /usr, /var, bare /opt /srv /tmp /mnt, or /proc /sys /dev). " +
  "Scope to a leaf dir (e.g. /var/log/<app>, /opt/<app>, /tmp/<job>) and bound with " +
  "-maxdepth 2-3, -xdev, timeout 15, 2>/dev/null, | head -50. Prefer rg/fd scoped to the project.";

const STATUS_TEXT = [
  "search-guard (linux): cost-based blocking.",
  "NEVER recursive: /proc /sys /dev (even with -maxdepth).",
  "HIGH-IO roots (block unbounded): /, /home, /root, ~, /etc, /usr,",
  "  /var (+/log /cache /lib/docker), bare /opt /srv /tmp /mnt /media /run /snap.",
  "Leaf dirs outside cwd are ALLOWED: /opt/<app>, /var/log/<app>, /tmp/<job>.",
  "Exemptions for HIGH roots: -maxdepth<=2, -L<=2 (tree), timeout ..., | head/tail.",
  "Usage: /search-guard test <command>",
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

function hasPipeToHead(fullCommand: string): boolean {
  return /\|\s*(head|tail)\b/.test(fullCommand);
}

/** Strip sudo/env/time/nice/timeout/VAR= prefixes; report timeout presence. */
function stripWrappers(segment: string): { core: string; hadTimeout: boolean } {
  let s = segment.trim();
  let hadTimeout = false;
  for (;;) {
    const before = s;
    if (/^timeout(\s+-\S+)*\s+\S+\s+/i.test(s)) {
      hadTimeout = true;
      s = s.replace(/^timeout(\s+-\S+)*\s+\S+\s+/i, "");
    }
    s = s
      .replace(/^(sudo|env|time|nohup)\b\s+(-\S+\s+)*/i, "")
      .replace(/^(nice|ionice|stdbuf|unshare|command|builtin)\b\s+(-\S+\s+)*/i, "")
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+/, "")
      .trim();
    if (s === before) break;
  }
  return { core: s, hadTimeout };
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
}): string {
  const seg =
    opts.segment.length > 200 ? opts.segment.slice(0, 200) + "…" : opts.segment;
  const lines = [
    `Blocked high-IO disk scan: \`${seg}\``,
    "",
    opts.why,
    "",
    "Use instead (scoped to a leaf dir, bounded):",
  ];
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
  fullCommand: string,
): SegHit | null {
  const { core, hadTimeout } = stripWrappers(segment);
  if (!core) return null;
  const tokens = tokenize(core);
  if (tokens.length === 0) return null;
  const bin = binName(tokens[0]);
  const rest = tokens.slice(1);
  const boundedPipe = hasPipeToHead(fullCommand);
  const maxd = maxdepthOf(core);
  const boundedDepth = maxd !== null && maxd <= 2;
  const exemptHigh = hadTimeout || boundedPipe || boundedDepth;

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
    if (args.length === 0) return null;
    const paths = args.slice(1); // first non-flag is the pattern
    if (paths.length === 0) return null; // `grep -r /` => pattern "/", scans cwd
    const found = classify(paths);
    const rFlag = /(^|\s)-[a-zA-Z]*R/.test(core);
    return hitFor(
      found,
      paths,
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
    let paths: string[];
    if (core.includes("--files")) {
      paths = args;
    } else {
      if (args.length === 0) return null; // scans cwd
      paths = args.slice(1);
      if (paths.length === 0) return null;
    }
    const found = classify(paths);
    return hitFor(
      found,
      paths,
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
    if (args.length === 0) return null;
    const paths = args.slice(1);
    if (paths.length === 0) return null;
    const found = classify(paths);
    return hitFor(
      found,
      paths,
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
    if (high.length > 0 && !hadTimeout && !boundedPipe) {
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

  // ---- cat-family: globs over virtual/root FS, or hanging device files
  if (
    bin === "cat" ||
    bin === "head" ||
    bin === "tail" ||
    bin === "less" ||
    bin === "more" ||
    bin === "bat" ||
    bin === "tac" ||
    bin === "nl" ||
    bin === "strings"
  ) {
    const hangFiles = new Set([
      "/dev/zero",
      "/dev/urandom",
      "/dev/random",
      "/proc/kcore",
      "/proc/kmsg",
    ]);
    for (const t of rest) {
      if (t.startsWith("-")) continue;
      const raw = stripQuotes(t);
      if (
        raw.includes("/**") ||
        raw === "/*" ||
        /^\/\*(\/|$)/.test(raw) ||
        /\/(proc|sys|dev)\/\*/.test(raw)
      ) {
        return {
          summary: `${bin} over a filesystem glob`,
          why: `${bin} ${raw} expands to thousands of files (or infinite virtual files) — scope to explicit paths.`,
          rawPaths: [t],
          rewritePicks: [`${bin} /var/log/<app>/<file>`, `${bin} <leaf>/* 2>/dev/null | head -50`],
        };
      }
      const abs = resolveToken(t, curDir, home);
      if (hangFiles.has(abs)) {
        return {
          summary: `${bin} on an infinite device file`,
          why: `${bin} ${abs} never ends — it streams forever.`,
          rawPaths: [t],
          rewritePicks: [`ls -la ${abs}`, "head -c 1K <file>  # bounded read"],
        };
      }
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

/** Main entry: scan a full bash command. Returns the first hit. */
export function checkSearchCommand(
  command: string,
  cwd: string,
  home: string = defaultHome(),
): SearchGuardHit | null {
  if (!command || !command.trim()) return null;
  const cur0 = cwd && cwd.startsWith("/") ? normalizeAbs(cwd) : "/home";
  for (const body of collectBodies(command)) {
    let curDir = cur0;
    for (const segment of splitSegments(body)) {
      const { core } = stripWrappers(segment);
      const cdMatch = core.match(/^cd(?:\s+(.*))?$/);
      if (cdMatch) {
        const arg = (cdMatch[1] ?? "").trim().split(/\s+/)[0];
        if (arg && arg !== "-" && arg !== "--") {
          curDir = resolveToken(stripQuotes(arg), curDir, home);
        } else if (!arg) {
          curDir = normalizeAbs(home);
        }
        continue;
      }
      const hit = checkSegment(segment, curDir, home, command);
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
          }),
        };
      }
    }
  }
  return null;
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
    description: "Show disk-search guard policy, or test a command",
    handler: async (args, ctx) => {
      const rest = (args ?? "").trim().replace(/^test\s+/, "");
      if ((args ?? "").trim().startsWith("test")) {
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
