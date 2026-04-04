import { describe, expect, it } from "vitest";
import { CommandRouter } from "../command-router.ts";

describe("CommandRouter", () => {
  function makeRouter() {
    const router = new CommandRouter();
    router.register("create", {
      description: "Create a new team",
      handler: async (args) => `create called with: ${args}`,
    });
    router.register("stop", {
      description: "Stop the active team",
      handler: async (_args) => undefined,
    });
    return router;
  }

  describe("dispatch", () => {
    it("routes to the matching subcommand handler", async () => {
      const router = makeRouter();
      const result = await router.dispatch("create --name my-team");
      expect(result).toBe("create called with: --name my-team");
    });

    it("passes the remainder after the subcommand name as args", async () => {
      const router = makeRouter();
      // Leading/trailing whitespace on the full input is trimmed; interior
      // whitespace between the subcommand and its arguments is preserved.
      const result = await router.dispatch("create   extra args  ");
      expect(result).toBe("create called with:   extra args");
    });

    it("passes an empty string as args when no remainder follows", async () => {
      const router = makeRouter();
      const result = await router.dispatch("create");
      expect(result).toBe("create called with: ");
    });

    it("returns undefined when the handler returns undefined", async () => {
      const router = makeRouter();
      const result = await router.dispatch("stop");
      expect(result).toBeUndefined();
    });

    it("returns a help message for an unrecognised subcommand", async () => {
      const router = makeRouter();
      const result = await router.dispatch("unknown");
      expect(result).toContain("Unknown subcommand");
      expect(result).toContain('"unknown"');
    });

    it("returns help text when called with an empty string", async () => {
      const router = makeRouter();
      const result = await router.dispatch("");
      expect(result).toContain("/team subcommands");
    });

    it("returns help text when called with whitespace only", async () => {
      const router = makeRouter();
      const result = await router.dispatch("   ");
      expect(result).toContain("/team subcommands");
    });
  });

  describe("getCompletions", () => {
    it("returns matching subcommand names for a given prefix", () => {
      const router = makeRouter();
      const items = router.getCompletions("cr");
      expect(items).not.toBeNull();
      expect(items?.map((i) => i.value)).toContain("create");
    });

    it("returns all subcommands for an empty prefix", () => {
      const router = makeRouter();
      const items = router.getCompletions("");
      expect(items?.length).toBeGreaterThanOrEqual(2);
    });

    it("returns null when no subcommands match the prefix", () => {
      const router = makeRouter();
      const items = router.getCompletions("xyz");
      expect(items).toBeNull();
    });
  });

  describe("register", () => {
    it("throws when the same name is registered twice", () => {
      const router = new CommandRouter();
      router.register("create", {
        description: "first",
        handler: async () => undefined,
      });
      expect(() =>
        router.register("create", {
          description: "second",
          handler: async () => undefined,
        }),
      ).toThrow("already registered");
    });
  });

  describe("list", () => {
    it("returns subcommands in registration order", () => {
      const router = makeRouter();
      // "help" is registered first by the extension entry point, but here
      // we only use makeRouter() which registers create then stop.
      const names = router.list().map((s) => s.name);
      expect(names).toEqual(["create", "stop"]);
    });
  });

  describe("help subcommand", () => {
    it("includes registered subcommand names in the help text", async () => {
      const router = makeRouter();
      const help = await router.dispatch("");
      expect(help).toContain("create");
      expect(help).toContain("stop");
    });
  });
});
