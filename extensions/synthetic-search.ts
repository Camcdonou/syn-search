/**
 * Synthetic Search Extension
 *
 * Adds a web search tool and command using Synthetic's Search API.
 * The LLM can control result detail via `detail_level`:
 *   - "summary"  → title + URL + date only (~50 tokens/result)
 *   - "snippet"  → + 300-char text excerpt (default, ~100 tokens/result)
 *   - "full"     → complete untruncated text (LLM opts in for deep reads)
 *
 * Output is truncated at 2000 lines / 50KB as a safety net. When truncated,
 * full output is saved to a temp file and the LLM is told to use `read` on it.
 *
 * Environment: SYNTHETIC_API_KEY must be set.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, TruncationResult } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const DETAIL_LEVELS = ["summary", "snippet", "full"] as const;

const TOOL_PARAMS = Type.Object({
	query: Type.String({ description: "Search query terms" }),
	detail_level: Type.Optional(
		StringEnum(DETAIL_LEVELS, {
			description:
				"Result detail: 'summary' = title+URL only, 'snippet' = +300-char text (default), 'full' = complete text. Use 'full' when you need full context from results.",
		}),
	),
	max_results: Type.Optional(
		Type.Number({
			description: "Max results to return (1-10, default 5)",
			minimum: 1,
			maximum: 10,
		}),
	),
});

type ToolParams = {
	query: string;
	detail_level?: "summary" | "snippet" | "full";
	max_results?: number;
};

interface SearchResult {
	url: string;
	title: string;
	text: string;
	published?: string;
}

interface SyntheticSearchDetails {
	query: string;
	detailLevel: "summary" | "snippet" | "full";
	resultCount: number;
	totalAvailable: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SYNTHETIC_ENDPOINT = "https://api.synthetic.new/v2/search";
const DEFAULT_DETAIL_LEVEL = "snippet";
const DEFAULT_MAX_RESULTS = 5;
const SNIPPET_MAX_CHARS = 300;

function truncateSnippet(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	// Try to break at a word boundary near the limit
	const truncated = text.slice(0, maxChars);
	const lastSpace = truncated.lastIndexOf(" ");
	if (lastSpace > maxChars * 0.7) {
		return truncated.slice(0, lastSpace) + "…";
	}
	return truncated + "…";
}

function formatDate(iso?: string): string {
	if (!iso) return "Unknown";
	try {
		return new Date(iso).toISOString().slice(0, 10);
	} catch {
		return iso;
	}
}

function formatResult(
	result: SearchResult,
	index: number,
	detailLevel: "summary" | "snippet" | "full",
): string {
	let text = `${index + 1}. **${result.title}**\n`;
	text += `   URL: ${result.url}\n`;
	text += `   Published: ${formatDate(result.published)}`;

	if (detailLevel === "snippet" && result.text) {
		text += `\n   > ${truncateSnippet(result.text, SNIPPET_MAX_CHARS)}`;
	} else if (detailLevel === "full" && result.text) {
		text += `\n   > ${result.text}`;
	}

	return text;
}

function formatOutput(
	query: string,
	results: SearchResult[],
	totalAvailable: number,
	detailLevel: "summary" | "snippet" | "full",
): string {
	const lines: string[] = [];
	lines.push(`Search results for "${query}" (${results.length} of ${totalAvailable} results, detail: ${detailLevel}):`);
	lines.push("");

	for (let i = 0; i < results.length; i++) {
		lines.push(formatResult(results[i], i, detailLevel));
		lines.push("");
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function syntheticSearchExtension(pi: ExtensionAPI) {
	// ----- Tool -----

	pi.registerTool({
		name: "synthetic_search",
		label: "Synthetic Search",
		description: `Search the web via Synthetic's Search API. Returns top results with titles, URLs, and text snippets. Use detail_level='full' for complete text. Output truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full output saved to temp file when exceeded.`,
		promptSnippet: "Search the web for information using Synthetic Search",
		promptGuidelines: [
			"Use this tool when you need to find current information on the web.",
			"Use detail_level='summary' for quick overview, 'snippet' (default) for balanced results, or 'full' for complete text.",
			"If output is truncated, use the read tool on the temp file path shown in the truncation notice to see full results.",
		],
		parameters: TOOL_PARAMS,

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const query = params.query;
			const detailLevel = params.detail_level ?? DEFAULT_DETAIL_LEVEL;
			const maxResults = Math.min(Math.max(params.max_results ?? DEFAULT_MAX_RESULTS, 1), 10);

			// --- Check API key ---
			const apiKey = process.env.SYNTHETIC_API_KEY;
			if (!apiKey) {
				throw new Error(
					"SYNTHETIC_API_KEY environment variable is not set. Export it with: export SYNTHETIC_API_KEY=your-key",
				);
			}

			// --- Stream progress ---
			onUpdate?.({
				content: [{ type: "text", text: `Searching for "${query}"...` }],
			});

			// --- Call API ---
			let response: Response;
			try {
				response = await fetch(SYNTHETIC_ENDPOINT, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ query }),
					signal,
				});
			} catch (err) {
				if ((err as Error).name === "AbortError") {
					throw new Error("Search request was cancelled.");
				}
				throw new Error(
					`Synthetic API network error: ${(err as Error).message}. Check your internet connection.`,
				);
			}

			// --- Handle HTTP errors ---
			if (!response.ok) {
				const errorBody = await response.text().catch(() => "");
				switch (response.status) {
					case 401:
						throw new Error(
							`Synthetic API returned 401 Unauthorized. Check your SYNTHETIC_API_KEY. ${errorBody}`,
						);
					case 429:
						throw new Error(
							`Synthetic API rate limit exceeded (429). Wait a moment and try again. ${errorBody}`,
						);
					default:
						throw new Error(
							`Synthetic API request failed (${response.status}): ${errorBody || response.statusText}`,
						);
				}
			}

			// --- Parse response ---
			let data: { results?: SearchResult[] };
			try {
				data = (await response.json()) as { results?: SearchResult[] };
			} catch {
				throw new Error("Synthetic API returned invalid JSON.");
			}

			const allResults = data.results ?? [];
			const totalAvailable = allResults.length;

			// --- Tier 1: limit result count ---
			const results = allResults.slice(0, maxResults);

			if (results.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No results found for: "${query}". Try different search terms.`,
						},
					],
					details: {
						query,
						detailLevel,
						resultCount: 0,
						totalAvailable: 0,
					} as SyntheticSearchDetails,
				};
			}

			// --- Tier 2: format with detail_level (per-result truncation happens inside formatResult) ---
			const formatted = formatOutput(query, results, totalAvailable, detailLevel);

			// --- Tier 3: overall output truncation (safety net) ---
			const truncation = truncateHead(formatted, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			const details: SyntheticSearchDetails = {
				query,
				detailLevel,
				resultCount: results.length,
				totalAvailable,
			};

			let resultText = truncation.content;

			if (truncation.truncated) {
				// Save full formatted output to temp file
				const tempDir = await mkdtemp(join(tmpdir(), "pi-synthetic-"));
				const tempFile = join(tempDir, "search-results.txt");
				await withFileMutationQueue(tempFile, async () => {
					await writeFile(tempFile, formatted, "utf8");
				});

				details.truncation = truncation;
				details.fullOutputPath = tempFile;

				const truncatedLines = truncation.totalLines - truncation.outputLines;
				const truncatedBytes = truncation.totalBytes - truncation.outputBytes;

				resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				resultText += ` ${truncatedLines} lines (${formatSize(truncatedBytes)}) omitted.`;
				resultText += ` Full output saved to: ${tempFile} — use the read tool to view it.]`;
			}

			return {
				content: [{ type: "text", text: resultText }],
				details,
			};
		},

		// ----- Custom rendering -----

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("🔍 synthetic_search "));
			text += theme.fg("accent", `"${args.query}"`);
			if (args.detail_level && args.detail_level !== DEFAULT_DETAIL_LEVEL) {
				text += theme.fg("dim", ` (${args.detail_level})`);
			}
			if (args.max_results && args.max_results !== DEFAULT_MAX_RESULTS) {
				text += theme.fg("dim", ` max:${args.max_results}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			const details = result.details as SyntheticSearchDetails | undefined;

			if (isPartial) {
				return new Text(theme.fg("warning", "🔍 Searching..."), 0, 0);
			}

			if (!details) {
				return new Text(theme.fg("dim", "Done"), 0, 0);
			}

			// Error results
			if (result.isError) {
				const content = result.content[0];
				const errMsg = content?.type === "text" ? content.text.slice(0, 80) : "Error";
				return new Text(theme.fg("error", `✗ ${errMsg}`), 0, 0);
			}

			// No results
			if (details.resultCount === 0) {
				return new Text(theme.fg("dim", "⚠ No results"), 0, 0);
			}

			// Collapsed: compact summary
			let text = theme.fg("success", `✓ ${details.resultCount} results`);
			if (details.detailLevel !== DEFAULT_DETAIL_LEVEL) {
				text += theme.fg("dim", ` (${details.detailLevel})`);
			}
			if (details.truncation?.truncated) {
				text += theme.fg("warning", " (truncated)");
			}

			// Expanded: show formatted results
			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const lines = content.text.split("\n").slice(0, 20);
					for (const line of lines) {
						text += `\n${theme.fg("dim", line)}`;
					}
					const totalLines = content.text.split("\n").length;
					if (totalLines > 20) {
						text += `\n${theme.fg("muted", "... (use read tool on temp file for full output)")}`;
					}
				}

				if (details.fullOutputPath) {
					text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// ----- Command -----

	pi.registerCommand("synthetic-search", {
		description: "Search the web via Synthetic Search",
		handler: async (args, ctx) => {
			let query = args?.trim();
			if (!query) {
				query = (await ctx.ui.input("Search query:", "Enter search terms...")) ?? "";
			}
			if (!query) {
				ctx.ui.notify("No query provided.", "warning");
				return;
			}

			// Route as a user message so the LLM decides how to invoke the tool
			pi.sendUserMessage(`Search the web for: ${query}`);
		},
	});
}
