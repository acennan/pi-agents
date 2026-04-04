# jDocMunch Extension for Pi

Section-level documentation indexing and retrieval for pi. Wraps [jdocmunch-mcp](https://github.com/jgravelle/jdocmunch-mcp) to let the model retrieve exact documentation sections instead of reading entire files.

## Token Savings

| Task                          | Without index | With index | Savings |
|-------------------------------|---------------|------------|---------|
| Find a configuration section  | ~12,000 tokens| ~400 tokens| ~97%    |
| Browse documentation structure| ~40,000 tokens| ~800 tokens| ~98%    |
| Explore a full doc set        | ~100,000 tokens| ~2k tokens| ~98%    |

## Prerequisites

- Python 3.10+
- jdocmunch-mcp package

```bash
pip install jdocmunch-mcp
```

## Installation

Copy this directory to your pi extensions folder:

```bash
cp -r extensions/jdocmunch ~/.pi/agent/extensions/
```

Or load directly:

```bash
pi -e ./extensions/jdocmunch/jdocmunch.ts
```

## How It Works

1. On session start, the extension auto-indexes documentation files in the current project directory.
2. The model can search sections, read exact content, and browse the heading hierarchy without loading entire files.
3. Sections are identified by stable IDs based on file path, heading text, and heading level.

The extension calls jdocmunch-mcp's Python library via a thin CLI bridge (`cli.py`), avoiding the MCP protocol entirely.

## Tools

| Tool | Description |
|------|-------------|
| `index_docs` | Index documentation files in the current project. Auto-runs on session start. |
| `search_sections` | Search sections by query (returns summaries, not content). |
| `get_section` | Retrieve full content of a section by ID. |
| `get_sections` | Batch retrieve multiple sections. |
| `get_toc` | Flat table of contents in document order. |
| `get_toc_tree` | Nested TOC tree grouped by document. |
| `get_document_outline` | Section hierarchy for a single document. |

## Commands

| Command | Description |
|---------|-------------|
| `/reindex-docs` | Force a full re-index of the project's documentation. |

## Supported Formats

| Format     | Extensions             |
|------------|------------------------|
| Markdown   | `.md`, `.markdown`     |
| MDX        | `.mdx`                 |
| Plain text | `.txt`                 |
| RST        | `.rst`                 |

## Workflow

1. Use `get_toc` or `get_toc_tree` to discover available documentation sections
2. Use `search_sections` to find sections matching a query
3. Use `get_section` to read the full content of a specific section
4. Fall back to `read` when you need the raw file (e.g., for non-text content)

## Status Line

The extension shows index status in pi's status bar:
- During indexing: `indexing docs...`
- After indexing: `42 sections / 8 docs`
- On error: `index failed` or `not installed`

## Configuration

The extension uses default settings that work for most projects:

- **AI summaries**: Disabled by default (avoids extra API calls). To enable, edit `jdocmunch.ts` and remove the `--no-ai` flag from `indexDocs()`.
- **Index storage**: Uses jdocmunch's default location (`~/.doc-index/`).
- **File limits**: jdocmunch indexes up to 500 documentation files per project.

## Licensing

This extension is MIT-licensed (same as pi). The underlying jdocmunch-mcp package uses a dual license: free for non-commercial use, paid commercial license required otherwise. See [jdocmunch-mcp LICENSE](https://github.com/jgravelle/jdocmunch-mcp) for details.
