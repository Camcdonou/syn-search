# 🔍 pi-synthetic-search

A [Pi](https://github.com/badlogic/pi-mono) extension that adds web search using [Synthetic's Search API](https://synthetic.new).

## Features

- **`synthetic_search` tool** — callable by the LLM during conversations
- **`/synthetic-search` command** — quick keyboard-driven entry point
- **3-tier payload control** to protect your context window:
  - **Result count limit** — caps at 5 results by default (configurable, max 10)
  - **`detail_level` parameter** — LLM chooses its own tradeoff:
    - `summary` — title + URL + date only (~50 tokens/result)
    - `snippet` *(default)* — + 300-char text excerpt (~100 tokens/result)
    - `full` — complete untruncated text (LLM opts in for deep reads)
  - **Overall truncation** — safety net at 2000 lines / 50KB; full output saved to a temp file the LLM can `read`
- **Graceful error handling** — missing key, 401, 429, network failures
- **Abort-aware** — respects Pi's escape/cancel signal during in-flight requests
- **Custom TUI rendering** — compact collapsed view, expandable results

## Setup

### 1. Get a Synthetic API key

Sign up at [synthetic.new](https://synthetic.new) and grab your API key (starts with `syn_`).

### 2. Set the environment variable

```bash
export SYNTHETIC_API_KEY="syn_your_key_here"
```

Add this to your `.zshrc` / `.bashrc` to persist it.

### 3. Install the extension

**Option A — pi install (recommended)**

```bash
pi install git:github.com/<username>/syn-search
```

Restart pi or run `/reload`. That's it.

**Option B — Manual copy (global)**

```bash
cp extensions/synthetic-search.ts ~/.pi/agent/extensions/
```

Pi auto-discovers extensions from `~/.pi/agent/extensions/`. Just restart pi or run `/reload`.

**Option C — Manual copy (project-local)**

```bash
mkdir -p .pi/extensions
cp extensions/synthetic-search.ts .pi/extensions/
```

**Option D — One-off test**

```bash
pi -e git:github.com/<username>/syn-search
```

## Usage

### Tool (LLM calls it)

Just ask pi anything that needs web search:

```
Search the web for the latest TypeScript 5.x features
```

The LLM will call `synthetic_search` with `detail_level: "snippet"` (default).

For deep reads, tell pi you need full context:

```
Search for "Rust async patterns" with full detail — I need the complete content
```

### Command (you type it)

```
/synthetic-search Rust async patterns
```

If you omit the query, pi prompts you for one.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | *(required)* | Search terms |
| `detail_level` | `"summary"` \| `"snippet"` \| `"full"` | `"snippet"` | Result detail level |
| `max_results` | number | `5` | Max results to return (1–10) |

## Output format

```
Search results for "query" (5 of 23 results, detail: snippet):

1. **Result Title**
   URL: https://example.com/page
   Published: 2025-11-05
   > First 300 characters of text content…

2. ...
```

When output exceeds 2000 lines or 50KB, it's truncated with a notice:

```
[Output truncated: showing 1210 of 8954 lines (48.8KB of 297.3KB).
 7744 lines (248.5KB) omitted.
 Full output saved to: /tmp/pi-synthetic-abc123/search-results.txt
 — use the read tool to view it.]
```

The LLM can then use Pi's built-in `read` tool on that path to access the full output.

## Why 3-tier payload control?

Synthetic's Search API can return very large text fields — a single result for "docs for curl" returned **257K characters** (~64K tokens). That would blow past most context windows instantly.

| Mode | Output size | Tokens (est.) | Use case |
|------|------------|---------------|----------|
| `summary` | ~500B | ~150 | Quick scan — "does anything relevant exist?" |
| `snippet` | ~2KB | ~550 | Default — enough to judge relevance |
| `full` | Up to 300KB+ | ~66K+ | Deep dive — only when you need full content |

The LLM decides. It starts with snippets, then re-calls with `detail_level: "full"` only when it needs to. The overall truncation safety net catches edge cases, and the temp file ensures nothing is ever lost.

## Error handling

| Scenario | Behavior |
|----------|----------|
| `SYNTHETIC_API_KEY` not set | Throws with setup instructions |
| Invalid API key (401) | Throws with key-check guidance |
| Rate limited (429) | Throws with retry advice |
| Network failure | Throws with connection guidance |
| Empty results | Returns informational message (not an error) |
| Request cancelled (Esc) | Throws `"Search request was cancelled."` |

All errors are thrown from `execute`, which sets `isError: true` in the tool result so the LLM knows the search failed and can react accordingly.

## Requirements

- [Pi](https://github.com/badlogic/pi-mono) (`npm install -g @mariozechner/pi-coding-agent`)
- A [Synthetic](https://synthetic.new) API key
- Node.js 18+ (for built-in `fetch`)

## License

MIT
