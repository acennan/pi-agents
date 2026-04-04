#!/usr/bin/env python3
"""Thin CLI wrapper around jdocmunch-mcp for use by pi extensions.

Avoids the MCP protocol entirely. Each subcommand calls the underlying
jdocmunch tool function directly and prints JSON to stdout.

Usage:
    python cli.py index_local /path/to/docs [--no-ai]
    python cli.py search_sections <repo> <query> [--doc-path ...] [--max-results N]
    python cli.py get_section <repo> <section_id> [--verify]
    python cli.py get_sections <repo> <id1> <id2> ...
    python cli.py get_toc <repo>
    python cli.py get_toc_tree <repo>
    python cli.py get_document_outline <repo> <doc_path>
    python cli.py list_repos
"""

import json
import sys


def _print_json(data: dict) -> None:
    json.dump(data, sys.stdout, indent=2)
    sys.stdout.write("\n")
    sys.stdout.flush()


def _error(msg: str) -> None:
    _print_json({"error": msg})
    sys.exit(1)


def cmd_index_local(args: list[str]) -> None:
    if not args:
        _error("Usage: index_local <path> [--no-ai]")

    from jdocmunch_mcp.tools.index_local import index_local

    path = args[0]
    use_ai = "--no-ai" not in args

    result = index_local(path=path, use_ai_summaries=use_ai)
    _print_json(result)


def cmd_search_sections(args: list[str]) -> None:
    if len(args) < 2:
        _error("Usage: search_sections <repo> <query> [--doc-path P] [--max-results N]")

    from jdocmunch_mcp.tools.search_sections import search_sections

    repo = args[0]
    query = args[1]

    doc_path = None
    max_results = 10

    i = 2
    while i < len(args):
        if args[i] == "--doc-path" and i + 1 < len(args):
            doc_path = args[i + 1]
            i += 2
        elif args[i] == "--max-results" and i + 1 < len(args):
            max_results = int(args[i + 1])
            i += 2
        else:
            i += 1

    result = search_sections(
        repo=repo,
        query=query,
        doc_path=doc_path,
        max_results=max_results,
    )
    _print_json(result)


def cmd_get_section(args: list[str]) -> None:
    if len(args) < 2:
        _error("Usage: get_section <repo> <section_id> [--verify]")

    from jdocmunch_mcp.tools.get_section import get_section

    repo = args[0]
    section_id = args[1]
    verify = "--verify" in args

    result = get_section(repo=repo, section_id=section_id, verify=verify)
    _print_json(result)


def cmd_get_sections(args: list[str]) -> None:
    if len(args) < 2:
        _error("Usage: get_sections <repo> <id1> [id2] ...")

    from jdocmunch_mcp.tools.get_sections import get_sections

    repo = args[0]
    section_ids = args[1:]

    result = get_sections(repo=repo, section_ids=section_ids)
    _print_json(result)


def cmd_get_toc(args: list[str]) -> None:
    if not args:
        _error("Usage: get_toc <repo>")

    from jdocmunch_mcp.tools.get_toc import get_toc

    result = get_toc(repo=args[0])
    _print_json(result)


def cmd_get_toc_tree(args: list[str]) -> None:
    if not args:
        _error("Usage: get_toc_tree <repo>")

    from jdocmunch_mcp.tools.get_toc_tree import get_toc_tree

    result = get_toc_tree(repo=args[0])
    _print_json(result)


def cmd_get_document_outline(args: list[str]) -> None:
    if len(args) < 2:
        _error("Usage: get_document_outline <repo> <doc_path>")

    from jdocmunch_mcp.tools.get_document_outline import get_document_outline

    result = get_document_outline(repo=args[0], doc_path=args[1])
    _print_json(result)


def cmd_list_repos(args: list[str]) -> None:
    from jdocmunch_mcp.tools.list_repos import list_repos

    result = list_repos()
    _print_json(result)


def cmd_delete_index(args: list[str]) -> None:
    if not args:
        _error("Usage: delete_index <repo>")

    from jdocmunch_mcp.tools.delete_index import delete_index

    result = delete_index(repo=args[0])
    _print_json(result)


COMMANDS = {
    "index_local": cmd_index_local,
    "search_sections": cmd_search_sections,
    "get_section": cmd_get_section,
    "get_sections": cmd_get_sections,
    "get_toc": cmd_get_toc,
    "get_toc_tree": cmd_get_toc_tree,
    "get_document_outline": cmd_get_document_outline,
    "list_repos": cmd_list_repos,
    "delete_index": cmd_delete_index,
}


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        cmds = ", ".join(sorted(COMMANDS))
        _error(f"Usage: cli.py <command> [args...]\nCommands: {cmds}")

    cmd_name = sys.argv[1]
    handler = COMMANDS.get(cmd_name)
    if not handler:
        _error(f"Unknown command: {cmd_name}. Available: {', '.join(sorted(COMMANDS))}")

    try:
        handler(sys.argv[2:])
    except ImportError as e:
        _error(f"jdocmunch-mcp is not installed: {e}")
    except Exception as e:
        _error(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
