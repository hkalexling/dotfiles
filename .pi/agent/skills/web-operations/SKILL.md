---
name: web-operations
description: Guides tool choice for web search, URL fetching, documentation lookup, browser testing, and web debugging. Use before performing web operations.
---

# Web Operations Tool Selection

Use this skill whenever you need to search the web, fetch a URL, read live documentation, test a web UI, reproduce browser behavior, or debug a web application.

## Decision Matrix

### Use Exa MCP for general web search and fetching

Use Exa MCP when the task is:

- searching the web
- finding latest/current documentation
- researching APIs, libraries, releases, or public facts
- fetching a user-provided link for reading
- getting a quick page summary/content extraction

Examples:

- “Find the latest Next.js docs for middleware”
- “Search for current Stripe webhook docs”
- “Fetch this URL and summarize it”

Default to Exa for general web content.

### Use curl/wget only when raw or local files are needed

Use `curl` or `wget` when:

- Exa returns incomplete, truncated, malformed, or insufficient content
- the page/file must be saved locally for repeated inspection
- the content is a raw file, archive, schema, script, binary, or generated artifact
- exact bytes matter

Unless the user explicitly requests another location, download files to:

```bash
/tmp
```

Do not clutter the current repository with downloaded web content unless the user asked for that.

### Use Chrome DevTools MCP for implementation testing/debugging

Use Chrome DevTools MCP when the task is:

- testing a local or deployed web implementation
- reproducing a UI bug
- inspecting console errors
- checking network requests
- validating DOM behavior
- debugging frontend state, rendering, or browser runtime issues

Chrome DevTools MCP is not for general web searching or casual URL fetching.

Good uses:

- “Open my local app and test the login flow”
- “Reproduce this frontend bug”
- “Check the console/network errors”
- “Verify the UI change works”

Bad uses:

- “Search the web”
- “Find the latest docs”
- “Fetch this blog post”

### Do not use agent-browser extension unless explicitly asked

Do not use the agent-browser extension by default for:

- web searching
- documentation lookup
- fetching URLs
- ordinary browser testing
- normal debugging

The agent-browser extension exists for cases where sites block automated browsers, including the browser automation used by Chrome DevTools MCP.

If a site blocks automated browser access, suggest this workflow to the user:

1. The user launches their own Chromium manually with remote debugging enabled, for example:

   ```bash
   chromium --remote-debugging-port=9222
   ```

2. The user logs in or opens the target site themselves if needed.
3. The user gives the agent the remote debugging port.
4. The agent uses the agent-browser extension to connect to that user-controlled Chromium instance.

Only use agent-browser after the user explicitly asks for this workflow or provides the remote debugging setup details.

## Quick Selection Rules

- Need search/docs/current public info? Use Exa MCP.
- Need to fetch a user-provided link? Start with Exa MCP.
- Need exact/raw/local file content? Use curl/wget, saving to `/tmp` by default.
- Need to test or debug a web app? Use Chrome DevTools MCP.
- Site blocks automation and user opts in? Use agent-browser with user-launched Chromium remote debugging.
