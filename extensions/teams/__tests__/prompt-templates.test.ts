import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const TEMPLATE_CASES = [
  [
    "docs/code-prompt.md",
    "extensions/teams/config/prompt-templates/code-prompt.md",
  ],
  [
    "docs/simplify-prompt.md",
    "extensions/teams/config/prompt-templates/simplify-prompt.md",
  ],
  [
    "docs/review-prompt.md",
    "extensions/teams/config/prompt-templates/review-prompt.md",
  ],
  [
    "docs/test-prompt.md",
    "extensions/teams/config/prompt-templates/test-prompt.md",
  ],
] as const;

describe("bundled team prompt templates", () => {
  for (const [sourcePath, bundledPath] of TEMPLATE_CASES) {
    it(`matches ${sourcePath}`, async () => {
      await expect(readFile(bundledPath, "utf8")).resolves.toBe(
        await readFile(sourcePath, "utf8"),
      );
    });
  }
});
