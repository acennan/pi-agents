/**
 * Teams extension entry point.
 *
 * Registers the `/team` command family with the Pi extension API.
 * All team commands are rejected when this process is a member agent
 * rather than the leader session.
 *
 * Subcommand implementations (create, start, stop, …) are registered by
 * subsequent tasks (TF-02 onwards) via the shared CommandRouter instance.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CommandRouter } from "./command-router.ts";
import { getTeamName, isMemberAgent } from "./roles.ts";

export default function teamsExtension(pi: ExtensionAPI): void {
  const router = new CommandRouter();

  // Register the built-in `help` subcommand. Additional subcommands will be
  // registered by later tasks via the router exported below.
  router.register("help", {
    description: "Show available /team subcommands",
    handler: async (_args) => {
      // Dispatch with empty string triggers the router's help text.
      return router.dispatch("");
    },
  });

  pi.registerCommand("team", {
    description: "Manage coding teams (create, start, stop, …)",

    getArgumentCompletions: (prefix: string) => {
      if (isMemberAgent()) return null;
      return router.getCompletions(prefix);
    },

    handler: async (args, ctx) => {
      // Reject team commands in member-agent processes.
      if (isMemberAgent()) {
        const teamName = getTeamName();
        const context = teamName
          ? ` (running as member of team "${teamName}")`
          : "";
        ctx.ui.notify(
          `/team commands are only available in the leader session${context}. ` +
            `This process is a member agent and cannot issue team commands.`,
          "error",
        );
        return;
      }

      const response = await router.dispatch(args ?? "");
      if (response !== undefined) {
        ctx.ui.notify(response, "info");
      }
    },
  });

  // SIGINT / SIGTERM best-effort shutdown hook (TF-27 will flesh this out).
  // Registered here so the extension owns the signal handlers from the start.
  pi.on("session_shutdown", async () => {
    // Nothing to tear down yet — process-manager registration comes in TF-13.
  });
}

// Re-export the router type so later task modules can register subcommands
// by importing this file and calling `registerSubcommand`.
export type { CommandRouter };
