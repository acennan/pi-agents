/**
 * jDocMunch Extension for Pi
 *
 * Wraps jdocmunch-mcp's Python indexer to provide section-level
 * documentation indexing and retrieval. Reduces token consumption by
 * letting the model retrieve exact documentation sections instead of
 * reading entire files.
 *
 * Prerequisites:
 *   pip install jdocmunch-mcp
 *
 * Usage:
 *   Copy this directory to ~/.pi/agent/extensions/ or .pi/extensions/
 *   Or load directly: pi -e ./extensions/jdocmunch/jdocmunch.ts
 *
 * Tools registered:
 *   index_docs           - Index documentation in the current project
 *   search_sections      - Search documentation sections by query
 *   get_section          - Retrieve full content of a section by ID
 *   get_sections         - Batch retrieve multiple sections
 *   get_toc              - Flat table of contents for indexed docs
 *   get_toc_tree         - Nested TOC tree grouped by document
 *   get_document_outline - Section hierarchy for one document
 *
 * Commands:
 *   /reindex-docs - Force a full re-index of the project's documentation
 *   /list_repos   - List all available indexed repositories
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

/** The repo identifier jdocmunch uses for local folders: "local/<dirname>". */
function repoId(cwd: string): string {
  return `local/${basename(cwd)}`;
}

interface CallResult {
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * Call the jdocmunch CLI bridge and parse the JSON response.
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
 * Check whether jdocmunch-mcp is importable by Python.
 */
async function checkInstalled(pi: ExtensionAPI): Promise<boolean> {
  const result = await pi.exec("python3", ["-c", "import jdocmunch_mcp"], {
    timeout: 10_000,
  });
  return result.code === 0;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _indexed = false;
let indexing = false;

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function jdocmunchExtension(pi: ExtensionAPI) {
  // -----------------------------------------------------------------------
  // Index the project's documentation
  // -----------------------------------------------------------------------

  async function indexDocs(
    ctx: ExtensionContext,
    options?: { incremental?: boolean; signal?: AbortSignal },
  ): Promise<CallResult> {
    if (indexing) {
      return { error: "Indexing already in progress" };
    }

    indexing = true;
    const theme = ctx.ui.theme;
    ctx.ui.setStatus("jdocmunch", theme.fg("accent", "indexing docs..."));

    try {
      const args = ["index_local", ctx.cwd, "--no-ai"];
      if (options?.incremental) {
        args.push("--incremental");
      }

      const result = await callCli(pi, args, {
        signal: options?.signal,
        timeout: 300_000,
        cwd: ctx.cwd,
      });

      if (result.error) {
        ctx.ui.setStatus("jdocmunch", theme.fg("error", "index failed"));
        return result;
      }

      _indexed = true;
      const changed = (result.changed as number) ?? 0;
      const newFiles = (result.new as number) ?? 0;
      const deleted = (result.deleted as number) ?? 0;
      ctx.ui.setStatus(
        "jdocmunch",
        theme.fg(
          "success",
          `jdocmunch: changed/${changed}, newFiles/${newFiles}, deleted/${deleted}`,
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
        "jdocmunch-mcp is not installed. Install with: pip install jdocmunch-mcp",
        "warning",
      );
      ctx.ui.setStatus(
        "jdocmunch",
        ctx.ui.theme.fg("warning", "not installed"),
      );
      return;
    }

    const result = await indexDocs(ctx, { incremental: false });
    if (result.error) {
      ctx.ui.notify(`Doc index: ${result.error}`, "warning");
    }
  });

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  pi.registerCommand("jdocmunch:reindex-docs", {
    description: "Force a full re-index of the project's documentation",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Re-indexing documentation...", "info");
      const result = await indexDocs(ctx);
      if (result.error) {
        ctx.ui.notify(`Re-index failed: ${result.error}`, "error");
      } else {
        ctx.ui.notify(`Re-index complete: ${result.message}`, "info");
      }
    },
  });

  pi.registerCommand("jdocmunch:list_repos", {
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
        lines.push(`    section_count: ${r.section_count ?? "?"}`);
        lines.push(`    doc_count: ${r.doc_count ?? "?"}`);
        lines.push(`    doc_types: ${JSON.stringify(r.doc_types ?? {})}`);
        lines.push(`    indexed_at: ${r.indexed_at ?? "?"}`);
        lines.push(`    index_version: ${r.index_version ?? "?"}`);
      }
      lines.push(`\n${result.count} repo(s)`);

      ctx.ui.notify(`${lines.join("\n")}`, "info");
    },
  });

  // -----------------------------------------------------------------------
  // Tools
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "index_docs",
    label: "Index Documentation",
    description:
      "Index documentation files (.md, .mdx, .txt, .rst) in the current project. Extracts sections by heading hierarchy for structured retrieval. Auto-runs on session start.",
    promptSnippet:
      "Index the current project's documentation for section-level retrieval.",
    promptGuidelines: [
      "Documentation is auto-indexed on session start. Only call index_docs if documentation files have changed externally.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const result = await indexDocs(ctx, {
        signal: signal ?? undefined,
      });

      if (result.error) {
        throw new Error(result.error);
      }

      const summary = [
        `Indexed ${result.section_count ?? 0} sections across ${result.file_count ?? 0} documentation files.`,
      ];
      if (result.doc_types) {
        const types = Object.entries(result.doc_types as Record<string, number>)
          .map(([ext, count]) => `${ext}: ${count}`)
          .join(", ");
        summary.push(`Document types: ${types}`);
      }

      return {
        content: [{ type: "text", text: summary.join("\n") }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "search_sections",
    label: "Search Sections",
    description:
      "Search documentation sections with weighted scoring. Returns summaries only (no content). Use get_section to retrieve full content of matching sections.",
    promptSnippet:
      "Search documentation sections by query. Returns summaries; use get_section for full content.",
    promptGuidelines: [
      "Use search_sections to find relevant documentation before reading entire files.",
      "Use the section IDs from search results with get_section to retrieve full content.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Search query (matches titles, summaries, tags, content)",
      }),
      doc_path: Type.Optional(
        Type.String({
          description:
            "Filter to a specific document path (e.g., 'docs/config.md')",
        }),
      ),
      max_results: Type.Optional(
        Type.Number({ description: "Maximum results to return (default: 10)" }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const repo = repoId(ctx.cwd);
      const args = ["search_sections", repo, params.query];

      if (params.doc_path) {
        args.push("--doc-path", params.doc_path);
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
              text: `No sections found matching "${params.query}".`,
            },
          ],
          details: result,
        };
      }

      const lines = results.map((sec) => {
        const parts = [
          `[${sec.level}] ${sec.title}`,
          `  id: ${sec.id}`,
          `  doc: ${sec.doc_path}`,
        ];
        if (sec.summary) {
          parts.push(`  summary: ${sec.summary}`);
        }
        return parts.join("\n");
      });

      const header = `Found ${results.length} section(s) matching "${params.query}":`;
      const text = [header, "", ...lines].join("\n");

      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "get_section",
    label: "Get Section",
    description:
      "Retrieve the full content of a documentation section by its ID. Uses O(1) byte-offset seeking. Use after search_sections or get_toc to read exact sections.",
    promptSnippet: "Retrieve full content of a documentation section by ID.",
    promptGuidelines: [
      "Use get_section to read exact documentation sections instead of reading full files.",
      "Section IDs come from search_sections, get_toc, or get_document_outline results.",
    ],
    parameters: Type.Object({
      section_id: Type.String({
        description:
          "Section ID in the format repo::doc_path::slug#level (from search_sections, get_toc, etc.)",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const repo = repoId(ctx.cwd);
      const args = ["get_section", repo, params.section_id];

      const result = await callCli(pi, args, {
        signal: signal ?? undefined,
        cwd: ctx.cwd,
      });

      if (result.error) {
        throw new Error(result.error as string);
      }

      const section = result.section as Record<string, unknown> | undefined;
      if (!section) {
        throw new Error("No section data in response");
      }

      const parts: string[] = [];
      parts.push(`# ${section.title} (level ${section.level})`);
      parts.push(`ID: ${section.id}`);
      parts.push(`Document: ${section.doc_path}`);
      if (section.summary) {
        parts.push(`Summary: ${section.summary}`);
      }
      parts.push("");
      parts.push(section.content as string);

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "get_sections",
    label: "Get Sections (batch)",
    description:
      "Batch retrieve full content of multiple documentation sections by their IDs. More efficient than calling get_section repeatedly.",
    promptSnippet: "Batch retrieve content of multiple documentation sections.",
    promptGuidelines: [
      "Use get_sections when you need to read multiple related documentation sections at once.",
    ],
    parameters: Type.Object({
      section_ids: Type.Array(Type.String(), {
        description: "List of section IDs to retrieve",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const repo = repoId(ctx.cwd);
      const args = ["get_sections", repo, ...params.section_ids];

      const result = await callCli(pi, args, {
        signal: signal ?? undefined,
        cwd: ctx.cwd,
      });

      if (result.error) {
        throw new Error(result.error as string);
      }

      const sections = (result.sections ?? []) as Array<
        Record<string, unknown>
      >;

      const parts: string[] = [];

      for (const item of sections) {
        if (item.error) {
          parts.push(`--- ERROR: ${item.error} ---`);
          parts.push("");
          continue;
        }
        const sec = item.section as Record<string, unknown>;
        parts.push(
          `--- ${sec.title} (level ${sec.level}, ${sec.doc_path}) ---`,
        );
        parts.push(`ID: ${sec.id}`);
        parts.push("");
        parts.push(sec.content as string);
        parts.push("");
      }

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "get_toc",
    label: "Table of Contents",
    description:
      "Get a flat table of contents for all indexed documentation. Returns section titles and summaries in document order, without content. Use to discover available sections before retrieving them.",
    promptSnippet:
      "Flat table of contents for indexed documentation (no content).",
    promptGuidelines: [
      "Use get_toc to discover what documentation sections are available before searching or retrieving.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const repo = repoId(ctx.cwd);
      const args = ["get_toc", repo];

      const result = await callCli(pi, args, {
        signal: signal ?? undefined,
        cwd: ctx.cwd,
      });

      if (result.error) {
        throw new Error(result.error as string);
      }

      const sections = (result.sections ?? []) as Array<
        Record<string, unknown>
      >;

      if (sections.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No sections found. The documentation may need indexing (/reindex-docs).",
            },
          ],
          details: result,
        };
      }

      const lines = sections.map((sec) => {
        const indent = "  ".repeat((sec.level as number) ?? 0);
        const parts = [`${indent}${sec.title}`];
        parts.push(`${indent}  id: ${sec.id}`);
        parts.push(`${indent}  doc: ${sec.doc_path}`);
        if (sec.summary && sec.summary !== sec.title) {
          parts.push(`${indent}  summary: ${sec.summary}`);
        }
        return parts.join("\n");
      });

      const header = `Table of Contents (${sections.length} sections):`;
      const text = [header, "", ...lines].join("\n");

      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "get_toc_tree",
    label: "TOC Tree",
    description:
      "Get a nested table of contents tree grouped by document. Shows the heading hierarchy without content. Useful for understanding documentation structure.",
    promptSnippet: "Nested documentation TOC tree grouped by document.",
    promptGuidelines: [
      "Use get_toc_tree to understand the hierarchical structure of documentation before diving in.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const repo = repoId(ctx.cwd);
      const args = ["get_toc_tree", repo];

      const result = await callCli(pi, args, {
        signal: signal ?? undefined,
        cwd: ctx.cwd,
      });

      if (result.error) {
        throw new Error(result.error as string);
      }

      const documents = (result.documents ?? []) as Array<
        Record<string, unknown>
      >;

      if (documents.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No documents found. The documentation may need indexing (/reindex-docs).",
            },
          ],
          details: result,
        };
      }

      function formatNode(
        node: Record<string, unknown>,
        indent: number,
      ): string[] {
        const prefix = "  ".repeat(indent);
        const lines = [`${prefix}[${node.level}] ${node.title}`];
        if (node.id) {
          lines.push(`${prefix}  id: ${node.id}`);
        }
        if (node.summary && node.summary !== node.title) {
          lines.push(`${prefix}  summary: ${node.summary}`);
        }
        const children = (node.children ?? []) as Array<
          Record<string, unknown>
        >;
        for (const child of children) {
          lines.push(...formatNode(child, indent + 1));
        }
        return lines;
      }

      const parts: string[] = [];
      for (const doc of documents) {
        parts.push(`=== ${doc.doc_path} ===`);
        const sections = (doc.sections ?? []) as Array<Record<string, unknown>>;
        for (const sec of sections) {
          parts.push(...formatNode(sec, 0));
        }
        parts.push("");
      }

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "get_document_outline",
    label: "Document Outline",
    description:
      "Get the section hierarchy for a single documentation file. Shows titles, levels, and summaries without content. Use to understand a document's structure before retrieving specific sections.",
    promptSnippet: "Section hierarchy for one document (no content).",
    promptGuidelines: [
      "Use get_document_outline to understand a document's structure before reading specific sections.",
      "Use the section IDs from the outline with get_section to retrieve content.",
    ],
    parameters: Type.Object({
      doc_path: Type.String({
        description:
          "Path to the document relative to the project root (e.g., 'docs/guide.md')",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const repo = repoId(ctx.cwd);
      const args = ["get_document_outline", repo, params.doc_path];

      const result = await callCli(pi, args, {
        signal: signal ?? undefined,
        cwd: ctx.cwd,
      });

      if (result.error) {
        throw new Error(result.error as string);
      }

      const sections = (result.sections ?? []) as Array<
        Record<string, unknown>
      >;

      if (sections.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No sections found in ${params.doc_path}. The file may not exist or the documentation may need indexing (/reindex-docs).`,
            },
          ],
          details: result,
        };
      }

      const lines = sections.map((sec) => {
        const indent = "  ".repeat((sec.level as number) ?? 0);
        const parts = [`${indent}[${sec.level}] ${sec.title}`];
        parts.push(`${indent}  id: ${sec.id}`);
        if (sec.summary && sec.summary !== sec.title) {
          parts.push(`${indent}  summary: ${sec.summary}`);
        }
        return parts.join("\n");
      });

      const header = `${params.doc_path} (${sections.length} sections):`;
      const text = [header, "", ...lines].join("\n");

      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });
}
