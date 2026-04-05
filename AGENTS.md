# Project Guidelines

---

## Project Documentation

Project documentation is a work in progress, and all the files are currently in the ./docs folder.

---

**IMPORTANT:** If there is any ambiguity in what you need to do, or if you are unsure of the best way to proceed, _ALWAYS_ ask for clarification. _DO NOT_ make assumptions or decide for yourself the best way to proceed.

---
## Workflow

### Code Workflow
1. **Claim**: Use `br update <id> --status=in_progress` to get the next task
2. **Orient**: Read @docs/TEAMS-IMPLEMENTATION.md to get an overall understanding of the project architecture. Consider this a guideline that can be deviated from slightly if it produces a better quality solution
3. **Work**: Implement the task using the notes in the description field
4. **Quality**: Use `bun run check` and `bun run typecheck` to ensure the code is of the required quality and is type-safe
5. **Test**: Ensure sufficient tests are added to cover the new functionality and that all tests pass
6. **Git**: Ensure all new and modified files are staged in git

### Review Workflow
1. **Important:** DO NOT MODIFY ANY FILES
2. **Find**: Use the user-supplied identifier to load the task from beads
3. **Changes**: All file changes will be currently staged in git
4. **Work**: Review the changes against the notes in the task description field
5. **Clarifcation**: If additional clarification is required, use @docs/TEAMS-PROPOSAL and @docs/TEAMS-INPLEMENTATION
6. **Report**: Inform the user of any issues found, along with their severity

### Commit Workflow
1. **Important:** DO NOT MODIFY ANY SOURCE CODE FILES
2. **Find**: Use the user-supplied identifier to load the task from beads
3. **Git**: Commit the changes against the implemenation identifier found in the task external reference field. Include a summary of the changes in the commit body, and both task and implementation identifiers in the commit footer. 
4. **Complete**: Use `br close <id>` to close the beads task
5. **Sync**: Always run `br sync --flush-only` at the session end

## Development Environment

### Runtime and tooling
- Runtime: Bun (see packageManager in package.json for the pinned version).

### TypeScript
- Write strict, idiomatic TS
- No `any` (use `unknown`, generics, or proper types).
- Prefer type to interface; use interface only when extending or implementing is needed.
- Prefer immutability where practical.
- Narrow with type guards; avoid assertions and ! except as a last resort.
- Prefer exhaustive handling for unions.
- Treat caught errors as unknown and narrow before use.

### Bun
- Prefer async/await; never swallow rejections.
- Avoid module top-level side effects (I/O, network, reading env, global mutations) unless explicitly intended.
- Env vars: validate centrally; read at runtime.
- Error handling: rethrow with context; preserve cause when available; don't throw strings.
- Library code should not log.
- Guard CLI entry points that also export functions so Vitest doesn't execute it on import. 

### Testing (Vitest)
- New logic requires tests unless truly trivial (types-only, re-exports, comments/formatting).
- Tests must be deterministic and isolated; avoid shared mutable state.
- Prefer behavioural tests; mock sparingly.
- No committed .only/.skip (unless explicitly justified).
- Bug fixes must include a regression test.
- Avoid snapshots unless they add clear value and are stable.

### Style, docs, and security
- Follow existing formatting/lint; keep functions small and readable.
- Prefer named exports.
- Update docs/comments when behaviour changes (comments explain "why", not "what").
- Never log secrets; validate/sanitise external inputs (paths/URLs/user data).

## SDK (pi-mono) Integration

When information is needed from the pi-mono SDK, then use the following documents:
- ./docs/pi-mono/README-agent.md
- ./docs/pi-mono/README-ai.md
- ./docs/pi-mono/README-coding-agent.md
- ./docs/pi-mono/README-tui.md

If these do not answer the question, or more details are required, then the SDK repo is available under the relative directory `../pi-mono/packages`. 

## jcodemunch Integration

Use jcodemunch-mcp for code lookup whenever available. Prefer symbol search, outlines, and targeted retrieval over reading full files.

## jdocmunch Integration

Use jdocmunch-mcp for local document lookup whenever available. Supports the following document types: `.md`, `.json`, `.yaml`, and `.xml`.

## Beads Integration

This project uses [beads_rust](https://github.com/Dicklesworthstone/beads_rust) (`br`) for issue trackingIssues are stored in `.beads/` and tracked in git.

### br Commands for Issue Management

```bash
br ready              # Show issues ready to work (no blockers)
br list --status=open # All open issues
br show <id>          # Full issue details with dependencies
br create --title="..." --type=task --priority=2
br update <id> --status=in_progress
br close <id> --reason="Completed"
br close <id1> <id2>  # Close multiple issues at once
br sync --flush-only  # Export DB to JSONL
```
