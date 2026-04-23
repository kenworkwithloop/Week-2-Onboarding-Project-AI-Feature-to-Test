import { runChat, ChatError, type ChatInputMessage } from "../llm/client.js";
import type { ToolCall } from "../tools/types.js";
import type { AgentOutput, ChatOutput } from "../schemas/output.js";

export interface AgentSuccess {
  ok: true;
  messages: ChatInputMessage[];
  output: AgentOutput;
  /** Always returned with output: `{ message }` only. */
  chat: ChatOutput;
  toolCalls: ToolCall[];
}

export interface AgentFailure {
  ok: false;
  messages: ChatInputMessage[];
  error: string;
  toolCalls: ToolCall[];
}

export type AgentResult = AgentSuccess | AgentFailure;

export async function runAgent(messages: ChatInputMessage[]): Promise<AgentResult> {
  try {
    const { output, chat, toolCalls } = await runChat(messages);
    return { ok: true, messages, output, chat, toolCalls };
  } catch (err) {
    return {
      ok: false,
      messages,
      error: err instanceof Error ? err.message : String(err),
      toolCalls: err instanceof ChatError ? err.toolCalls : [],
    };
  }
}
