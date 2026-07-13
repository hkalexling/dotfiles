/**
 * Prompt Snippets — insert saved text snippets into your prompt with a hotkey.
 *
 * Usage:
 *   - Press Ctrl+' while typing to open the snippet picker overlay.
 *   - ↑↓ to navigate, type to filter, Enter to insert at cursor, Esc to cancel.
 *   - Edit ~/.pi/agent/snippets.json to manage snippets (global).
 *   - Add .pi/snippets.json for project-local snippets (merged, overrides by label).
 *   - Run /reload after editing snippet files to pick up changes.
 *
 * File format:
 *   { "snippets": [{ "label": "Explain code", "text": "Please explain..." }] }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type SelectItem, SelectList, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface Snippet {
  label: string;
  text: string;
}

interface SnippetsConfig {
  snippets: Snippet[];
}

/**
 * Load snippets from global and project-local JSON files.
 * Project-local snippets override global snippets with the same label.
 */
function loadSnippets(cwd: string): Snippet[] {
  const globalPath = join(getAgentDir(), "snippets.json");
  const projectPath = join(cwd, CONFIG_DIR_NAME, "snippets.json");

  // Use a Map for deduplication by label (project overrides global)
  const merged = new Map<string, string>();

  function loadFile(path: string): void {
    if (!existsSync(path)) return;
    try {
      const config: SnippetsConfig = JSON.parse(readFileSync(path, "utf-8"));
      for (const s of config.snippets ?? []) {
        if (s.label && s.text) {
          merged.set(s.label, s.text);
        }
      }
    } catch (err) {
      console.error(`Failed to load snippets from ${path}: ${err}`);
    }
  }

  loadFile(globalPath);
  loadFile(projectPath);

  return [...merged.entries()].map(([label, text]) => ({ label, text }));
}

/**
 * Show an overlay SelectList of snippets. On selection, inject the snippet
 * text at the current cursor position in the prompt editor.
 */
async function showSnippetPicker(ctx: ExtensionContext, snippets: Snippet[]): Promise<void> {
  const items: SelectItem[] = snippets.map((s) => ({
    value: s.label,
    label: s.label,
    description: s.text.length > 70 ? `${s.text.slice(0, 67)}...` : s.text,
  }));

  const chosen = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    // Filter state (SelectList manages filteredItems but not the filter string)
    let filterText = "";

    const selectList = new SelectList(items, Math.min(items.length + 2, 12), {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    });
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);

    // Rendered once, cached unless invalidated
    let cachedWidth = -1;
    let cachedLines: string[] = [];

    function padLine(line: string, w: number): string {
      const vis = visibleWidth(line);
      return line + " ".repeat(Math.max(0, w - vis));
    }

    return {
      render: (w: number): string[] => {
        if (w === cachedWidth) return cachedLines;
        const th = theme;
        const lines: string[] = [];

        // Content width inside borders (reserve 2 chars for │ on each side)
        const innerW = Math.max(10, w - 2);

        // Helper: render a bordered row
        const row = (content: string) =>
          th.fg("border", "│") + padLine(content, innerW) + th.fg("border", "│");

        // Top border
        const topBar = "─".repeat(innerW);
        lines.push(th.fg("border", `╭${topBar}╮`));

        // Title
        lines.push(row(` ${th.fg("accent", th.bold("Insert Snippet"))}`));
        lines.push(row(""));

        // Filter / search bar
        const filterLabel = th.fg("muted", " Filter: ");
        const filterDisplay = filterText.length > 0
          ? filterText
          : th.fg("dim", "type to search...");
        const filterCursor = "█";
        const filterLine = ` ${filterLabel}${filterDisplay}${filterCursor}`;
        lines.push(row(padLine(filterLine, innerW)));

        // Separator
        lines.push(row(th.fg("border", "─".repeat(innerW))));

        // SelectList rendered inside the border
        const listLines = selectList.render(innerW);
        for (const listLine of listLines) {
          lines.push(row(listLine));
        }

        // Separator
        lines.push(row(th.fg("border", "─".repeat(innerW))));

        // Footer hints
        const hints = " ↑↓ navigate  │  enter insert  │  esc cancel ";
        lines.push(row(` ${truncateToWidth(th.fg("dim", hints), innerW - 1, "")}`));

        // Bottom border
        lines.push(th.fg("border", `╰${topBar}╯`));

        cachedWidth = w;
        cachedLines = lines;
        return lines;
      },

      invalidate: () => {
        selectList.invalidate();
        cachedWidth = -1;
        cachedLines = [];
      },

      handleInput: (data: string) => {
        // Navigation keys: pass through to SelectList
        if (
          matchesKey(data, Key.up) ||
          matchesKey(data, Key.down) ||
          matchesKey(data, Key.enter) ||
          matchesKey(data, Key.escape)
        ) {
          selectList.handleInput(data);
          cachedWidth = -1;
          tui.requestRender();
          return;
        }

        // Backspace: remove last filter character
        if (matchesKey(data, Key.backspace)) {
          if (filterText.length > 0) {
            filterText = filterText.slice(0, -1);
            selectList.setFilter(filterText);
          }
          cachedWidth = -1;
          tui.requestRender();
          return;
        }

        // Printable characters: append to filter
        if (data.length === 1 && data.charCodeAt(0) >= 32) {
          filterText += data;
          selectList.setFilter(filterText);
          cachedWidth = -1;
          tui.requestRender();
          return;
        }

        // Fall through for any other keys (ctrl+c, etc.)
        selectList.handleInput(data);
        cachedWidth = -1;
        tui.requestRender();
      },
    };
  }, {
    overlay: true,
    overlayOptions: {
      width: 64,
      minWidth: 40,
      anchor: "center",
    },
  });

  if (chosen === null) return;

  const snippet = snippets.find((s) => s.label === chosen);
  if (snippet) {
    ctx.ui.pasteToEditor(snippet.text);
  }
}

export default function (pi: ExtensionAPI) {
  let snippets: Snippet[] = [];

  // Register the hotkey (customizable via ~/.pi/agent/keybindings.json)
  pi.registerShortcut("ctrl+'", {
    description: "Insert prompt snippet",
    handler: async (ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy — wait for it to finish before inserting a snippet.", "warning");
        return;
      }

      if (snippets.length === 0) {
        const hintPath = join(getAgentDir(), "snippets.json");
        ctx.ui.notify(
          `No snippets defined. Create ${hintPath} and /reload.`,
          "warning",
        );
        return;
      }

      await showSnippetPicker(ctx, snippets);
    },
  });

  // Load snippets on session start
  pi.on("session_start", (_event, ctx) => {
    snippets = loadSnippets(ctx.cwd);
  });
}
