import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getProcessRole,
  getTeamName,
  isLeader,
  isMemberAgent,
} from "../roles.ts";

describe("roles", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PI_TEAM_ROLE;
    delete process.env.PI_TEAM_NAME;
  });

  afterEach(() => {
    // Restore only the keys we touched.
    for (const key of ["PI_TEAM_ROLE", "PI_TEAM_NAME"]) {
      if (key in originalEnv) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  describe("getProcessRole", () => {
    it("returns leader when PI_TEAM_ROLE is not set", () => {
      expect(getProcessRole()).toBe("leader");
    });

    it("returns leader when PI_TEAM_ROLE is explicitly set to leader", () => {
      process.env.PI_TEAM_ROLE = "leader";
      expect(getProcessRole()).toBe("leader");
    });

    it.each([
      "code",
      "simplify",
      "review",
      "test",
      "commit",
    ] as const)("returns %s when PI_TEAM_ROLE is set to %s", (role) => {
      process.env.PI_TEAM_ROLE = role;
      expect(getProcessRole()).toBe(role);
    });

    it('returns "unknown" for an unrecognised PI_TEAM_ROLE value', () => {
      process.env.PI_TEAM_ROLE = "unknown-role";
      expect(getProcessRole()).toBe("unknown");
    });
  });

  describe("isLeader", () => {
    it("returns true when PI_TEAM_ROLE is unset", () => {
      expect(isLeader()).toBe(true);
    });

    it("returns false when PI_TEAM_ROLE is code", () => {
      process.env.PI_TEAM_ROLE = "code";
      expect(isLeader()).toBe(false);
    });

    it("returns false when PI_TEAM_ROLE is an unknown value", () => {
      process.env.PI_TEAM_ROLE = "unknown-role";
      expect(isLeader()).toBe(false);
    });
  });

  describe("isMemberAgent", () => {
    it("returns false when PI_TEAM_ROLE is unset", () => {
      expect(isMemberAgent()).toBe(false);
    });

    it("returns true when PI_TEAM_ROLE is a member role", () => {
      process.env.PI_TEAM_ROLE = "review";
      expect(isMemberAgent()).toBe(true);
    });

    it("returns true when PI_TEAM_ROLE is an unknown value", () => {
      process.env.PI_TEAM_ROLE = "unknown-role";
      expect(isMemberAgent()).toBe(true);
    });
  });

  describe("getTeamName", () => {
    it("returns undefined when PI_TEAM_NAME is not set", () => {
      expect(getTeamName()).toBeUndefined();
    });

    it("returns the team name when PI_TEAM_NAME is set", () => {
      process.env.PI_TEAM_NAME = "my-team";
      expect(getTeamName()).toBe("my-team");
    });
  });
});
