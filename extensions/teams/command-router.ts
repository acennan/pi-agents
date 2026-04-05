/**
 * Teams command router.
 *
 * Parses raw argument strings passed to the `/team` extension command and
 * dispatches to the appropriate subcommand handler. This module has no
 * dependency on the Pi runtime so it can be unit-tested independently.
 */

import type { AutocompleteItem } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Subcommand registry
// ---------------------------------------------------------------------------

/** A subcommand descriptor registered in the router. */
export type SubcommandDescriptor<TContext = void> = {
  /** Short description shown in `/team help` output. */
  readonly description: string;
  /**
   * Handler called when the subcommand is invoked.
   * Returns a human-readable string that will be displayed to the user,
   * or undefined when the handler manages display itself.
   */
  readonly handler: (
    args: string,
    context: TContext,
  ) => Promise<string | undefined>;
};

/** A read-only view of a registered subcommand (name + descriptor). */
export type RegisteredSubcommand<TContext = void> = {
  readonly name: string;
} & SubcommandDescriptor<TContext>;

// ---------------------------------------------------------------------------
// CommandRouter
// ---------------------------------------------------------------------------

/**
 * Routes `/team <subcommand> [args...]` invocations to registered handlers.
 *
 * All concrete subcommand implementations (create, start, stop, …) will be
 * registered by later tasks (TF-02 onwards). This router provides the
 * dispatch skeleton and is intentionally decoupled from the Pi ExtensionAPI
 * so it can be exercised in unit tests without a running runtime.
 */
export class CommandRouter<TContext = void> {
  readonly #subcommands = new Map<string, SubcommandDescriptor<TContext>>();

  /** Register a subcommand. Throws if the name is already taken. */
  register(name: string, descriptor: SubcommandDescriptor<TContext>): void {
    if (this.#subcommands.has(name)) {
      throw new Error(`Subcommand "${name}" is already registered`);
    }
    this.#subcommands.set(name, descriptor);
  }

  /**
   * Parse the raw argument string from the `/team` command and dispatch.
   *
   * Returns a response string suitable for display to the user, or undefined
   * when the handler manages output itself.
   */
  async dispatch(
    rawArgs: string,
    context?: TContext,
  ): Promise<string | undefined> {
    const trimmed = rawArgs.trim();
    const spaceIndex = trimmed.indexOf(" ");
    const subcommand =
      spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
    const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1);

    if (!subcommand) {
      return this.#helpText();
    }

    const descriptor = this.#subcommands.get(subcommand);
    if (!descriptor) {
      return `Unknown subcommand: "${subcommand}". Run /team help for usage.`;
    }

    return descriptor.handler(rest, context as TContext);
  }

  /**
   * Return autocomplete items for the argument portion of `/team `.
   * Only top-level subcommand names are completed here; further argument
   * completion is delegated to individual subcommand handlers as needed.
   */
  getCompletions(prefix: string): AutocompleteItem[] | null {
    const items: AutocompleteItem[] = [];
    for (const [name, { description }] of this.#subcommands) {
      if (name.startsWith(prefix)) {
        items.push({ value: name, label: `${name} — ${description}` });
      }
    }
    return items.length > 0 ? items : null;
  }

  /** Return all registered subcommands in registration order. */
  list(): ReadonlyArray<RegisteredSubcommand<TContext>> {
    return [...this.#subcommands.entries()].map(([name, descriptor]) => ({
      name,
      ...descriptor,
    }));
  }

  // -------------------------------------------------------------------------
  // Built-in subcommands
  // -------------------------------------------------------------------------

  /** Produce a help string listing all registered subcommands. */
  #helpText(): string {
    const lines: string[] = ["Available /team subcommands:", ""];
    for (const { name, description } of this.list()) {
      lines.push(`  ${name.padEnd(12)} ${description}`);
    }
    if (lines.length === 2) {
      lines.push("  (no subcommands registered yet)");
    }
    return lines.join("\n");
  }
}
