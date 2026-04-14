# 🔍 pi-synthetic-search

A [Pi](https://github.com/badlogic/pi-mono) extension that adds web search using [Synthetic's Search API](https://synthetic.new).

## Features

- **`synthetic_search` tool** — callable by the LLM during conversations
- **`/synthetic-search` command** — quick keyboard-driven entry point
- **4-tier payload control** to protect your context window:
  - **Result count limit** — caps at 5 results by default (configurable, max 10)
  - **`detail_level` parameter** — LLM chooses its own tradeoff:
    - `summary` — title + URL + date only (~50 tokens/result)
    - `snippet` — + 300-char text excerpt (~100 tokens/result)
    - `ai-summary` — full text sent to AI summarizer with optional focus prompt (~300-500 tokens total)
    - `full` — complete untruncated text (LLM opts in for deep reads)
  - **`summary_prompt` parameter** — when using `ai-summary`, the LLM can provide conversation context to focus the summarizer on what matters
  - **Overall truncation** — safety net at 2000 lines / 50KB; full output saved to a temp file the LLM can `read`
- **AI Summarizer** — uses Synthetic's chat completions API (`GLM-4.7-Flash`) to condense search results into focused, query-relevant summaries. Costs ~$0.003/call.
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
pi install git:github.com/Camcdonou/syn-search
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
pi -e git:github.com/Camcdonou/syn-search
```

## Usage

### Tool (LLM calls it)

Just ask pi anything that needs web search:

```
Search the web for the latest TypeScript 5.x features
```

The LLM will call `synthetic_search` with `detail_level: "snippet"` (default).

For focused, substantive answers, use `ai-summary` with context:

```
Search for "passport.js OAuth strategies" with ai-summary detail, focusing on refresh token rotation
```

The LLM will call:

```json
{
  "query": "passport.js OAuth strategies",
  "detail_level": "ai-summary",
  "summary_prompt": "The user is debugging a refresh token rotation issue with passport-google-oauth20. Extract info about token rotation, session serialization, or refresh token handling."
}
```

For deep reads with raw content, tell pi you need full text:

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
| `detail_level` | `"summary"` \| `"snippet"` \| `"ai-summary"` \| `"full"` | `"snippet"` | Result detail level |
| `summary_prompt` | string | *(none)* | Context/instructions for the AI summarizer (only used with `ai-summary`). Tells the summarizer what to focus on based on conversation context. |
| `max_results` | number | `5` | Max results to return (1–10) |

## Output format

### Standard modes (summary, snippet, full)

```
Search results for "query" (5 of 23 results, detail: snippet):

1. **Result Title**
   URL: https://example.com/page
   Published: 2025-11-05
   > First 300 characters of text content…

2. ...
```

### AI Summary mode

```
AI Summary for "passport.js OAuth strategies" (5 of 23 results, detail: ai-summary):

### Refresh Token Rotation
Passport.js does not handle token rotation natively. You must implement
the logic to exchange a refresh token for a new access token.

### Refresh Token Handling
When the initial authentication callback runs, ensure you store the
`refreshToken` returned by the provider.

```js
function(accessToken, refreshToken, profile, done) {
  // Make sure you store the refreshToken somewhere!
  User.findOrCreate(..., function(err, user) {
    if (err) { return done(err); }
    done(null, user);
  });
});
```
...
```

### Truncation notice

When output exceeds 2000 lines or 50KB, it's truncated with a notice:

```
[Output truncated: showing 1210 of 8954 lines (48.8KB of 297.3KB).
 7744 lines (248.5KB) omitted.
 Full output saved to: /tmp/pi-synthetic-abc123/search-results.txt
 — use the read tool to view it.]
```

The LLM can then use Pi's built-in `read` tool on that path to access the full output.

## Why 4-tier payload control?

Synthetic's Search API can return very large text fields — a single result for "docs for curl" returned **257K characters** (~64K tokens). That would blow past most context windows instantly.

| Mode | Output size | Tokens (est.) | Use case |
|------|------------|---------------|----------|
| `summary` | ~500B | ~150 | Quick scan — "does anything relevant exist?" |
| `snippet` | ~2KB | ~550 | Relevance check — "is this worth digging into?" |
| `ai-summary` | ~1-3KB | ~300-500 | **Real questions** — focused, context-aware extraction |
| `full` | Up to 300KB+ | ~66K+ | Deep dive — only when you need raw/uncompressed content |

The LLM decides. It starts with `ai-summary` for substantive queries (providing `summary_prompt` from conversation context), uses `snippet`/`summary` for quick checks, and only reaches for `full` when it truly needs raw content. The overall truncation safety net catches edge cases, and the temp file ensures nothing is ever lost.

## AI Summarizer

When `detail_level` is `ai-summary`:

1. The extension fetches **full search results** from the Search API
2. It sends them to Synthetic's chat completions API (`hf:zai-org/GLM-4.7-Flash`) for summarization
3. The summarizer receives the query, the full results, and optionally the `summary_prompt` from the LLM
4. It returns a focused summary tailored to the query and user context

**Same API key** — both the search API and the summarizer use `SYNTHETIC_API_KEY`. No extra setup.

**Model:** `GLM-4.7-Flash` — the cheapest and fastest model on Synthetic. Purpose-built for basic tasks like summarization. Not a reasoning model (we use `reasoning_effort: "low"` to skip the thinking step and get direct output).

**Cost:** ~$0.003 per summarization call (at $0.10/mtok input, $0.50/mtok output).

**`summary_prompt`** is the key design choice. Without it, the summarizer only has the search query as context. With it, the main LLM can encode *why* it's searching and *what angle* matters:

```json
{
  "query": "Docker multi-stage builds",
  "detail_level": "ai-summary",
  "summary_prompt": "User is trying to reduce a Node.js Docker image from 1.2GB to under 200MB. Focus on layer caching, Alpine vs Debian, and COPY vs ADD patterns."
}
```

This makes the summarizer a lightweight sub-agent — the main AI delegates research focus, and the summarizer returns only what's relevant.

**Limitation:** The summarizer doesn't have the full conversation history, only what the main LLM encodes in `summary_prompt`. This is a deliberate tradeoff — it keeps costs and latency low while giving the LLM enough control to steer the summary.

## Error handling

| Scenario | Behavior |
|----------|----------|
| `SYNTHETIC_API_KEY` not set | Throws with setup instructions |
| Invalid API key (401) | Throws with key-check guidance |
| Rate limited (429) | Throws with retry advice |
| Network failure | Throws with connection guidance |
| Empty results | Returns informational message (not an error) |
| Request cancelled (Esc) | Throws `"Search request was cancelled."` or `"Summarization request was cancelled."` |
| Summarizer returns empty content | Throws with fallback suggestion (`detail_level='full'`) |

All errors are thrown from `execute`, which sets `isError: true` in the tool result so the LLM knows the search failed and can react accordingly.

## Requirements

- [Pi](https://github.com/badlogic/pi-mono) (`npm install -g @mariozechner/pi-coding-agent`)
- A [Synthetic](https://synthetic.new) API key
- Node.js 18+ (for built-in `fetch`)

## License

MIT
