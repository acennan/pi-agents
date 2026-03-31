# Project Guidelines

---

## jcodemunch Integration

Use jcodemunch-mcp for code lookup whenever available. Prefer symbol search, outlines, and targeted retrieval over reading full files.

### Step 0 — Always resolve the repo first

Before any retrieval, confirm the repo is indexed:

```
resolve_repo: { "path": "/absolute/path/to/project" }
```

- If it returns a repo ID: proceed directly to retrieval.
- If it says not indexed: call `index_folder` first, then retry.

For GitHub repos, use `index_repo` with `"url": "owner/repo"`.

You only need to index once. Subsequent calls reuse the stored index.

---

### Core retrieval loop (the main pattern)

Most code-reading tasks follow this three-step loop:

```
1. search_symbols  { "repo": "...", "query": "funcName", "kind": "function" }
   → get back a list of matching symbols with IDs

2. get_symbol_source  { "repo": "...", "symbol_id": "src/auth.py::authenticate#function" }
   → get back only that function's source

3. (Optional) get_context_bundle  { "repo": "...", "symbol_id": "..." }
   → get the function + its imports in one call
```

Symbol IDs have the format `{file_path}::{qualified_name}#{kind}`, e.g.:
- `src/main.py::UserService#class`
- `src/main.py::UserService.login#method`
- `src/utils.py::authenticate#function`

---

### Important behaviours

**Use outline before source.** For files you haven't seen: `get_file_outline` first to see the API surface, then `get_symbol_source` for only what you need. Don't speculatively fetch symbols you might not need.

**Batch when possible.** `get_symbol_source` accepts `symbol_ids[]` for multiple symbols in one call. `get_file_outline` accepts `file_paths[]`. `find_importers` and `find_references` accept arrays too.

**Token budget tools.** For large contexts, prefer `get_ranked_context` or `get_context_bundle` with `token_budget=` to automatically keep responses within a target size.

**When not to use jcodemunch.** If you need to *edit* a file, use the standard Read/Edit tools — jcodemunch is read-only retrieval. Also use native tools if the project is not indexed and cannot easily be indexed (e.g., a single throwaway script).

**Index freshness.** For long-running sessions or after significant edits, call `check_freshness` to confirm the index reflects current HEAD. If the watcher is running, `wait_for_fresh` blocks until the reindex completes.

---

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| `resolve_repo` says not indexed | Call `index_folder { "path": "..." }` first |
| Results seem stale after edits | `check_freshness` → if stale, `index_folder { "incremental": true }` or `index_file` for a single file |
| No results from `search_symbols` | Try `fuzzy=true` or broaden the query; check `language=` filter isn't too narrow |
| Index is very old | `invalidate_cache` then `index_folder { "incremental": false }` for a full rebuild |
