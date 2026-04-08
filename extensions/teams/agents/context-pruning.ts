import type { AgentMessage } from "@mariozechner/pi-agent-core";

export const DEFAULT_CODE_AGENT_CONTEXT_MESSAGE_LIMIT = 20;

export type CodeAgentContextPruningOptions = {
  maxMessages?: number;
};

export type CodeAgentTransformContext = (
  messages: AgentMessage[],
  signal?: AbortSignal,
) => Promise<AgentMessage[]>;

export function createCodeAgentContextPruner(
  options: CodeAgentContextPruningOptions = {},
): CodeAgentTransformContext {
  const maxMessages = normalizeMaxMessages(options.maxMessages);

  return async (messages, _signal) => {
    if (messages.length <= maxMessages) {
      return messages;
    }

    return messages.slice(-maxMessages);
  };
}

export function installCodeAgentContextPruning(
  session: { agent: object },
  options: CodeAgentContextPruningOptions = {},
): void {
  Reflect.set(
    session.agent,
    "transformContext",
    createCodeAgentContextPruner(options),
  );
}

function normalizeMaxMessages(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_CODE_AGENT_CONTEXT_MESSAGE_LIMIT;
  }

  if (!Number.isInteger(value) || value < 1) {
    return DEFAULT_CODE_AGENT_CONTEXT_MESSAGE_LIMIT;
  }

  return value;
}
