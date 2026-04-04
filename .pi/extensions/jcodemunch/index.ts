/**
 * jCodeMunch Extension for Pi
 *
 * Wraps jcodemunch-mcp's Python indexer to provide AST-based code symbol
 * indexing and retrieval. Reduces token consumption by letting the model
 * retrieve exact symbols instead of reading entire files.
 *
 * Prerequisites:
 *   pip install jcodemunch-mcp
 *
 * Usage:
 *   Copy this directory to ~/.pi/agent/extensions/ or .pi/extensions/
 *   Or load directly: pi -e ./extensions/jcodemunch/jcodemunch.ts
 *
 * Tools registered:
 *   index_project  - Index the current project (auto-runs on session start)
 *   search_symbols - Search for symbols by name, kind, language
 *   get_symbol     - Retrieve full source of a symbol by ID
 *   get_symbols    - Batch retrieve multiple symbols
 *   file_outline   - Get symbol hierarchy for a file
 *
 * Commands:
 *   /reindex - Force a full re-index of the current project
 *   /list_repos - List all available indexed repositories
 *   /repo_outline - Display a high-level project overview
 *   /invalidate - Invalidate the current cache and regenerate
 */

import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the path to cli.py relative to this extension file. */
function cliPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "cli.py");
}

/** The repo identifier jcodemunch uses for local folders: "local/<dirname>". */
function repoId(cwd: string): string {
  return `local/${basename(cwd)}`;
}

interface CallResult {
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * Call the jcodemunch CLI bridge and parse the JSON response.
 * Uses pi.exec() so abort signals and timeouts are handled.
 */
async function callCli(
  pi: ExtensionAPI,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
): Promise<CallResult> {
  const result = await pi.exec("python3", [cliPath(), ...args], {
    signal: options?.signal,
    timeout: options?.timeout ?? 120_000,
    cwd: options?.cwd,
  });

  if (result.code !== 0) {
    // Try to parse stderr or stdout for a JSON error from the CLI
    const output = result.stdout || result.stderr;
    try {
      const parsed = JSON.parse(output);
      if (parsed.error) {
        return parsed as CallResult;
      }
    } catch {
      // Not JSON
    }
    return {
      error: `CLI exited with code ${result.code}: ${output.slice(0, 500)}`,
    };
  }

  try {
    return JSON.parse(result.stdout) as CallResult;
  } catch {
    return { error: `Invalid JSON from CLI: ${result.stdout.slice(0, 500)}` };
  }
}

/**
 * Check whether jcodemunch-mcp is importable by Python.
 */
async function checkInstalled(pi: ExtensionAPI): Promise<boolean> {
  const result = await pi.exec("python3", ["-c", "import jcodemunch_mcp"], {
    timeout: 10_000,
  });
  return result.code === 0;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let indexed = false;
let indexing = false;

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function jcodemunchExtension(pi: ExtensionAPI) {
  // -----------------------------------------------------------------------
  // Index the project (or re-index incrementally)
  // -----------------------------------------------------------------------

  async function indexProject(
    ctx: ExtensionContext,
    options?: { incremental?: boolean; signal?: AbortSignal },
  ): Promise<CallResult> {
    if (indexing) {
      return { error: "Indexing already in progress" };
    }

    indexing = true;
    const theme = ctx.ui.theme;
    ctx.ui.setStatus("jcodemunch", theme.fg("accent", "indexing code..."));

    try {
      const args = ["index_folder", ctx.cwd];
      if (options?.incremental) {
        args.push("--incremental");
      }
      args.push("--no-ai"); // Skip AI summaries to avoid extra API calls

      const result = await callCli(pi, args, {
        signal: options?.signal,
        timeout: 300_000, // 5 minutes for large projects
        cwd: ctx.cwd,
      });

      if (result.error) {
        ctx.ui.setStatus("jcodemunch", theme.fg("error", "index failed"));
        return result;
      }

      indexed = true;
      const fileCount = (result.file_count as number) ?? 0;
      const symbolCount = (result.symbol_count as number) ?? 0;
      const fileSummary = (result.file_summary_count as number) ?? 0;
      ctx.ui.setStatus(
        "jcodemunch",
        theme.fg(
          "dim",
          `jcodemunch: files/${fileCount}, symbols/${symbolCount}, summaries/${fileSummary}`,
        ),
      );
      return result;
    } finally {
      indexing = false;
    }
  }

  // -----------------------------------------------------------------------
  // Session lifecycle
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    const installed = await checkInstalled(pi);
    if (!installed) {
      ctx.ui.notify(
        "jcodemunch-mcp is not installed. Install with: pip install jcodemunch-mcp",
        "warning",
      );
      ctx.ui.setStatus(
        "jcodemunch",
        ctx.ui.theme.fg("warning", "not installed"),
      );
      return;
    }

    // Incremental index on session start (fast if nothing changed)
    const result = await indexProject(ctx, { incremental: false });

    if (result.error) {
      ctx.ui.notify(`Code index: ${result.error}`, "warning");
    }
  });

  // Re-index after writes/edits so the index stays fresh
  pi.on("tool_result", async (event, _ctx) => {
    if (!indexed) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    if (event.isError) return;

    // Mark for lazy re-index. We don't block the tool result.
    // The next search/outline call will see the updated index.
    // Debounce: index at most once per agent turn via turn_end.
    needsReindex = true;
  });

  let needsReindex = false;

  pi.on("turn_end", async (_event, ctx) => {
    if (!needsReindex || !indexed) return;
    needsReindex = false;

    // Incremental re-index in the background
    const result = await indexProject(ctx, { incremental: true });
    if (result.error) {
      // Silent -- don't spam the user with re-index failures
      const theme = ctx.ui.theme;
      ctx.ui.setStatus("jcodemunch", theme.fg("warning", "reindex failed"));
    }
  });

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  pi.registerCommand("jcodemunch:reindex", {
    description: "Force a full re-index of the current project",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Re-indexing project...", "info");
      const result = await indexProject(ctx, { incremental: false });
      if (result.error) {
        ctx.ui.notify(`Re-index failed: ${result.error}`, "error");
      } else {
        const symbols = (result.symbol_count as number) ?? 0;
        const files = (result.file_count as number) ?? 0;
        ctx.ui.notify(
          `Re-index complete: ${symbols} symbols across ${files} files`,
          "info",
        );
      }
    },
  });

  pi.registerCommand("jcodemunch:list_repos", {
    description: "List all indexed repositories",
    handler: async (_args, ctx) => {
      const cliArgs = ["list_repos"];

      const result = await callCli(pi, cliArgs, {
        signal: undefined,
        cwd: ctx.cwd,
      });

      if (result.error) {
        ctx.ui.notify(
          `An error occured listing repos: ${result.error}`,
          "error",
        );
        return;
      }

      if (result.count === 0) {
        ctx.ui.notify(`No indexed repositories found.`, "info");
      }

      const lines: string[] = [];
      for (const r of result.repos) {
        lines.push(`• ${r.repo}`);
        lines.push(`    file_count: ${r.file_count ?? "?"}`);
        lines.push(`    symbol_count: ${r.symbol_count ?? "?"}`);
        lines.push(`    languages: ${JSON.stringify(r.languages ?? {})}`);
        lines.push(`    indexed_at: ${r.indexed_at ?? "?"}`);
        lines.push(`    index_version: ${r.index_version ?? "?"}`);
      }
      lines.push(`\n${result.count} repo(s)`);

      ctx.ui.notify(`${lines.join("\n")}`, "info");
    },
  });

  pi.registerCommand("jcodemunch:invalidate", {
    description: "Invalidate the current cache",
    handler: async (args, ctx) => {
      const cliArgs = ["invalidate", args];

      const result = await callCli(pi, cliArgs, {
        signal: undefined,
        cwd: ctx.cwd,
      });

      if (result.error) {
        ctx.ui.notify(
          `An error occured invalidating the cache: ${result.error}`,
          "error",
        );
      }

      ctx.ui.notify(`invalidated`, "info");
    },
  });

  pi.registerCommand("jcodemunch:repo_outline", {
    description:
      "Show high-level overview of an indexed repository (dirs, languages, symbol counts)",
    handler: async (_args, ctx) => {
      const codeMunchRepoName = await getCodeMunchRepoName(ctx.cwd);
      const cliArgs = ["repo_outline", codeMunchRepoName];

      const result = await callCli(pi, cliArgs, {
        signal: undefined,
        cwd: ctx.cwd,
      });

      if (result.error) {
        ctx.ui.notify(
          `An error occured getting repo outline: ${result.error}`,
          "error",
        );
        return;
      }

      const parts: string[] = [];
      if (result.repo) parts.push(`• ${result.repo}`);
      if (result.indexed_at) parts.push(`    Indexed at: ${result.indexed_at}`);
      if (result.file_count !== null)
        parts.push(`    Files: ${result.file_count}`);
      if (result.symbol_count !== null)
        parts.push(`    Symbols: ${result.symbol_count}`);
      if (result.languages) {
        const langs = Object.entries(result.languages)
          .map(([lang, count]) => `      ${lang}: ${count}`)
          .join("\n");
        parts.push(`    Languages:\n${langs}`);
      }
      if (result.symbol_kinds) {
        const kinds = Object.entries(result.symbol_kinds)
          .map(([kind, count]) => `      ${kind}: ${count}`)
          .join("\n");
        parts.push(`    Symbol kinds:\n${kinds}`);
      }
      if (result.directories) {
        const dirs = Object.entries(result.directories)
          .map(([dir, count]) => `      ${dir} (${count} files)`)
          .join("\n");
        parts.push(`    Directories:\n${dirs}`);
      }
      if (result.staleness_warning) {
        parts.push(`    ⚠️  ${result.staleness_warning}`);
      }
      if (result._meta) {
        const m = result._meta;
        const metaLines = [`      timing: ${m.timing_ms ?? "?"}ms`];
        if (m.tokens_saved !== null)
          metaLines.push(`      tokens saved: ${m.tokens_saved}`);
        if (m.total_tokens_saved !== null)
          metaLines.push(`      total tokens saved: ${m.total_tokens_saved}`);
        parts.push(`    Meta:\n${metaLines.join("\n")}`);
      }

      ctx.ui.notify(`${parts.join("\n")}`, "info");
    },
  });

  async function getCodeMunchRepoName(folderPath: string): Promise<string> {
    // 1. Encode the string as UTF-8
    const msgUint8 = new TextEncoder().encode(folderPath);
    // 2. Generate the SHA-1 hash
    const hashBuffer = await crypto.subtle.digest("SHA-1", msgUint8);
    // 3. Convert the buffer to a hex string
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    // 4. Append the first 8 characters to the repo name
    return `${repoId(folderPath)}-${hashHex.slice(0, 8)}`;
  }

  // -----------------------------------------------------------------------
  // Tools
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "index_project",
    label: "Index Project",
    description:
      "Index or re-index the current project's source code. Extracts symbols (functions, classes, methods, constants, types) for fast retrieval. Use before search_symbols or file_outline if the index is stale.",
    promptSnippet:
      "Index the current project's source code for symbol-level retrieval. Usually auto-runs on session start.",
    promptGuidelines: [
      "The project is auto-indexed on session start. Only call index_project if you suspect the index is stale after external changes.",
    ],
    parameters: Type.Object({
      incremental: Type.Optional(
        Type.Boolean({
          description: "If true, only re-index changed files. Default: true.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await indexProject(ctx, {
        incremental: params.incremental ?? true,
        signal: signal ?? undefined,
      });

      if (result.error) {
        throw new Error(result.error);
      }

      const summary = [
        `Indexed ${result.symbol_count ?? 0} symbols across ${result.file_count ?? 0} files.`,
      ];
      if (result.languages) {
        const langs = Object.entries(result.languages as Record<string, number>)
          .map(([lang, count]) => `${lang}: ${count}`)
          .join(", ");
        summary.push(`Languages: ${langs}`);
      }
      if (result.incremental) {
        summary.push(
          `Incremental: ${result.changed ?? 0} changed, ${result.new ?? 0} new, ${result.deleted ?? 0} deleted.`,
        );
      }

      return {
        content: [{ type: "text", text: summary.join("\n") }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "search_symbols",
    label: "Search Symbols",
    description:
      "Search for code symbols (functions, classes, methods, constants, types) across the indexed project. Returns matching symbols with signatures and summaries. Use this before reading entire files to find the exact code you need.",
    promptSnippet:
      "Search for code symbols by name, kind, or language. More efficient than reading entire files.",
    promptGuidelines: [
      "Use search_symbols to find specific functions, classes, or methods before reading entire files.",
      "Use the symbol IDs from search results with get_symbol to retrieve full source code.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "Search query (matches symbol names, signatures, summaries)",
      }),
      kind: Type.Optional(
        Type.String({
          description:
            "Filter by symbol kind: function, class, method, constant, type",
        }),
      ),
      language: Type.Optional(
        Type.String({
          description:
            "Filter by language: python, javascript, typescript, go, rust, java, php, dart, csharp, c",
        }),
      ),
      file_pattern: Type.Optional(
        Type.String({
          description: "Glob pattern to filter files (e.g., 'src/**/*.ts')",
        }),
      ),
      max_results: Type.Optional(
        Type.Number({
          description: "Maximum results to return (default: 20, max: 100)",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const repo = repoId(ctx.cwd);
      const args = ["search_symbols", repo, params.query];

      if (params.kind) {
        args.push("--kind", params.kind);
      }
      if (params.language) {
        args.push("--language", params.language);
      }
      if (params.file_pattern) {
        args.push("--file-pattern", params.file_pattern);
      }
      if (params.max_results !== undefined) {
        args.push("--max-results", String(params.max_results));
      }

      const result = await callCli(pi, args, {
        signal: signal ?? undefined,
        cwd: ctx.cwd,
      });

      if (result.error) {
        throw new Error(result.error as string);
      }

      const results = (result.results ?? []) as Array<Record<string, unknown>>;
      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No symbols found matching "${params.query}".`,
            },
          ],
          details: result,
        };
      }

      const lines = results.map((sym) => {
        const parts = [
          `${sym.kind} ${sym.name}`,
          `  file: ${sym.file}:${sym.line}`,
          `  id: ${sym.id}`,
          `  signature: ${sym.signature}`,
        ];
        if (sym.summary) {
          parts.push(`  summary: ${sym.summary}`);
        }
        return parts.join("\n");
      });

      const header = `Found ${results.length} symbol(s) matching "${params.query}":`;
      const text = [header, "", ...lines].join("\n");

      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "get_symbol",
    label: "Get Symbol",
    description:
      "Retrieve the full source code of a specific symbol by its ID. Use after search_symbols or file_outline to read exact implementations without loading entire files.",
    promptSnippet:
      "Retrieve full source of a symbol by ID. O(1) byte-offset seeking.",
    promptGuidelines: [
      "Use get_symbol to read exact function/class implementations instead of reading full files.",
      "Symbol IDs come from search_symbols or file_outline results.",
    ],
    parameters: Type.Object({
      symbol_id: Type.String({
        description:
          "Symbol ID in the format file_path::qualified_name#kind (from search_symbols or file_outline)",
      }),
      context_lines: Type.Optional(
        Type.Number({
          description:
            "Number of surrounding lines to include for context (default: 0, max: 50)",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const repo = repoId(ctx.cwd);
      const args = ["get_symbol", repo, params.symbol_id];

      if (params.context_lines !== undefined) {
        args.push("--context-lines", String(params.context_lines));
      }

      const result = await callCli(pi, args, {
        signal: signal ?? undefined,
        cwd: ctx.cwd,
      });

      if (result.error) {
        throw new Error(result.error as string);
      }

      const parts: string[] = [];

      // Header
      parts.push(
        `${result.kind} ${result.name} (${result.file}:${result.line}-${result.end_line})`,
      );
      parts.push(`ID: ${result.id}`);
      if (result.signature) {
        parts.push(`Signature: ${result.signature}`);
      }
      parts.push("");

      // Context before
      if (result.context_before) {
        parts.push("--- context before ---");
        parts.push(result.context_before as string);
        parts.push("--- symbol source ---");
      }

      // Source
      parts.push(result.source as string);

      // Context after
      if (result.context_after) {
        parts.push("--- context after ---");
        parts.push(result.context_after as string);
      }

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "get_symbols",
    label: "Get Symbols (batch)",
    description:
      "Batch retrieve full source code of multiple symbols by their IDs. More efficient than calling get_symbol repeatedly.",
    promptSnippet: "Batch retrieve source of multiple symbols in one call.",
    promptGuidelines: [
      "Use get_symbols when you need to read multiple related symbols (e.g., all methods of a class).",
    ],
    parameters: Type.Object({
      symbol_ids: Type.Array(Type.String(), {
        description: "List of symbol IDs to retrieve",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const repo = repoId(ctx.cwd);
      const args = ["get_symbols", repo, ...params.symbol_ids];

      const result = await callCli(pi, args, {
        signal: signal ?? undefined,
        cwd: ctx.cwd,
      });

      if (result.error) {
        throw new Error(result.error as string);
      }

      const symbols = (result.symbols ?? []) as Array<Record<string, unknown>>;
      const errors = (result.errors ?? []) as Array<Record<string, unknown>>;

      const parts: string[] = [];

      for (const sym of symbols) {
        parts.push(
          `--- ${sym.kind} ${sym.name} (${sym.file}:${sym.line}-${sym.end_line}) ---`,
        );
        parts.push(`ID: ${sym.id}`);
        parts.push("");
        parts.push(sym.source as string);
        parts.push("");
      }

      if (errors.length > 0) {
        parts.push("--- errors ---");
        for (const err of errors) {
          parts.push(`${err.id}: ${err.error}`);
        }
      }

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "file_outline",
    label: "File Outline",
    description:
      "Get the symbol hierarchy for a file: all functions, classes, methods with their signatures. Does not include source code. Use to understand a file's API surface before reading it.",
    promptSnippet:
      "Get symbol hierarchy for a file (signatures, no source). Use before reading a file.",
    promptGuidelines: [
      "Use file_outline to understand a file's API surface before reading the full file.",
      "Use the symbol IDs from the outline with get_symbol to retrieve specific implementations.",
    ],
    parameters: Type.Object({
      file_path: Type.String({
        description:
          "Path to the file relative to the project root (e.g., 'src/main.py')",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const repo = repoId(ctx.cwd);
      const args = ["file_outline", repo, params.file_path];

      const result = await callCli(pi, args, {
        signal: signal ?? undefined,
        cwd: ctx.cwd,
      });

      if (result.error) {
        throw new Error(result.error as string);
      }

      const symbols = (result.symbols ?? []) as Array<Record<string, unknown>>;

      if (symbols.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No symbols found in ${params.file_path}. The file may not contain supported language constructs, or the project may need re-indexing (/reindex).`,
            },
          ],
          details: result,
        };
      }

      function formatSymbol(
        sym: Record<string, unknown>,
        indent: number,
      ): string[] {
        const prefix = "  ".repeat(indent);
        const lines = [
          `${prefix}${sym.kind} ${sym.name} (line ${sym.line})`,
          `${prefix}  id: ${sym.id}`,
          `${prefix}  signature: ${sym.signature}`,
        ];
        if (sym.summary) {
          lines.push(`${prefix}  summary: ${sym.summary}`);
        }
        const children = (sym.children ?? []) as Array<Record<string, unknown>>;
        for (const child of children) {
          lines.push(...formatSymbol(child, indent + 1));
        }
        return lines;
      }

      const header = `${params.file_path} (${result.language ?? "unknown"}, ${symbols.length} top-level symbols):`;
      const body = symbols.flatMap((sym) => formatSymbol(sym, 0));

      return {
        content: [{ type: "text", text: [header, "", ...body].join("\n") }],
        details: result,
      };
    },
  });
}
