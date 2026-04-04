# jCodeMunch Extension for Pi

AST-based code symbol indexing and retrieval for pi. Wraps [jcodemunch-mcp](https://github.com/jgravelle/jcodemunch-mcp) to let the model retrieve exact symbols (functions, classes, methods) instead of reading entire files.

## Token Savings

| Task                     | Without index | With index | Savings |
|--------------------------|---------------|------------|---------|
| Explore repo structure   | ~200k tokens  | ~2k tokens | ~99%    |
| Find a specific function | ~40k tokens   | ~200 tokens| ~99.5%  |
| Read one implementation  | ~40k tokens   | ~500 tokens| ~98.7%  |
| Understand module API    | ~15k tokens   | ~800 tokens| ~94.7%  |

## Prerequisites

- Python 3.10+
- jcodemunch-mcp package

```bash
pip install jcodemunch-mcp
```

## Installation

Copy this directory to your pi extensions folder:

```bash
cp -r extensions/jcodemunch ~/.pi/agent/extensions/
```

Or load directly:

```bash
pi -e ./extensions/jcodemunch/jcodemunch.ts
```

## How It Works

1. On session start, the extension auto-indexes the current project (incrementally -- fast if nothing changed).
2. After writes/edits, the index is updated incrementally at the end of each agent turn.
3. The model can search symbols, read exact implementations, and explore file outlines without loading entire files.

The extension calls jcodemunch-mcp's Python library via a thin CLI bridge (`cli.py`), avoiding the MCP protocol entirely.

## Tools

| Tool | Description |
|------|-------------|
| `index_project` | Index or re-index the current project. Auto-runs on session start. |
| `search_symbols` | Search symbols by name, kind, language, file pattern. |
| `get_symbol` | Retrieve full source of a symbol by ID. |
| `get_symbols` | Batch retrieve multiple symbols. |
| `file_outline` | Get symbol hierarchy for a file (signatures, no source). |
| `repo_outline` | High-level project overview (directories, languages, symbol counts). |

## Commands

| Command | Description |
|---------|-------------|
| `/reindex` | Force a full re-index of the current project. |

## Supported Languages

Python, JavaScript, TypeScript, Go, Rust, Java, PHP, Dart, C#, C.

## Workflow

The index tools complement pi's built-in `read`, `grep`, and `find`:

1. Use `search_symbols` to find relevant code by name or kind
2. Use `get_symbol` to read exact implementations
3. Use `file_outline` to understand a file's API surface before reading it
4. Fall back to `read` when full file context is needed (imports, surrounding code)

## Status Line

The extension shows index status in pi's status bar:
- During indexing: `indexing...`
- After indexing: `387 symbols / 42 files`
- On error: `index failed` or `not installed`

## Configuration

The extension uses default settings that work for most projects:

- **AI summaries**: Disabled by default (avoids extra API calls). To enable, edit `jcodemunch.ts` and remove the `--no-ai` flag from `indexProject()`.
- **Index storage**: Uses jcodemunch's default location (`~/.code-index/`).
- **File limits**: jcodemunch indexes up to 500 source files per project, prioritizing `src/`, `lib/`, etc.
- **Incremental indexing**: Enabled by default. Only changed files are re-parsed.

## Licensing

This extension is MIT-licensed (same as pi). The underlying jcodemunch-mcp package uses a dual license: free for non-commercial use, paid commercial license required otherwise. See [jcodemunch-mcp LICENSE](https://github.com/jgravelle/jcodemunch-mcp) for details.
