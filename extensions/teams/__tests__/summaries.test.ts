import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskSummaryPath } from "../tasks/summaries.ts";

const TEST_ROOT = join(tmpdir(), "pi-teams-summaries-test-tmp");
const TEAM_NAME = "summary-team";

afterEach(async () => {
  delete process.env.PI_TEAMS_ROOT;
  await rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.PI_TEAMS_ROOT = TEST_ROOT;
  await mkdir(TEST_ROOT, { recursive: true });
});

describe("taskSummaryPath", () => {
  it("rejects task ids containing path traversal segments or separators", () => {
    for (const taskId of ["../evil", "..\\evil", "pi/agents", "pi\\agents"]) {
      expect(() => taskSummaryPath(TEAM_NAME, taskId)).toThrow(
        `Task id "${taskId}" is invalid for a summary path`,
      );
    }
  });
});
