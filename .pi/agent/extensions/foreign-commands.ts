import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Foreign Commands — Loads Claude Code (.claude/commands/*.md) and
 * OpenCode (.opencode/commands/*.md) slash commands as pi prompt templates.
 *
 * Deduplicates by resolving symlinks to real paths, so mirrored commands
 * don't show up twice. .claude/commands/ is treated as canonical; .opencode/commands/
 * is only registered when it contributes at least one unique file.
 */
export default function (pi: ExtensionAPI) {
  pi.on("resources_discover", async (event, _ctx) => {
    const promptPaths: string[] = [];

    const claudeDir = resolve(event.cwd, ".claude", "commands");
    const opencodeDir = resolve(event.cwd, ".opencode", "commands");

    // Collect md files from a directory, resolved to real paths
    const getRealPaths = (dir: string): Set<string> => {
      if (!existsSync(dir)) return new Set();
      const real = new Set<string>();
      try {
        for (const entry of readdirSync(dir)) {
          if (entry.endsWith(".md")) {
            real.add(realpathSync(resolve(dir, entry)));
          }
        }
      } catch {
        // Permission errors, missing dir, etc. — skip
      }
      return real;
    };

    const claudeReal = getRealPaths(claudeDir);
    const opencodeReal = getRealPaths(opencodeDir);

    // Register .claude/commands/ if it has any files
    if (claudeReal.size > 0) {
      promptPaths.push(claudeDir);
    }

    // Register .opencode/commands/ only if it has files NOT already covered
    // by .claude/commands/ (i.e., non-symlink, OpenCode-only commands)
    const uniqueOpenCode = [...opencodeReal].filter((p) => !claudeReal.has(p));
    if (uniqueOpenCode.length > 0) {
      promptPaths.push(opencodeDir);
    }

    return promptPaths.length > 0 ? { promptPaths } : undefined;
  });
}
