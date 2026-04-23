import "dotenv/config";
import Fastify from "fastify";
import { runAgent } from "./agent/runAgent.js";
import type { ChatInputMessage } from "./llm/client.js";

interface ChatRequestBody {
  messages?: unknown;
}

function validateMessages(raw: unknown): ChatInputMessage[] | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return "Body must include a non-empty messages[] array.";
  }
  const out: ChatInputMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") {
      return "Each message must be an object with { role, content }.";
    }
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") {
      return `Invalid role: ${JSON.stringify(role)}. Must be "user" or "assistant".`;
    }
    if (typeof content !== "string" || content.length === 0) {
      return "Each message.content must be a non-empty string.";
    }
    out.push({ role, content });
  }
  if (out[out.length - 1]!.role !== "user") {
    return "The last message must have role 'user'.";
  }
  return out;
}

export async function buildServer() {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ status: "ok" }));

  app.post<{ Body: ChatRequestBody }>("/chat", async (req, reply) => {
    const messages = validateMessages(req.body?.messages);
    if (typeof messages === "string") {
      reply.code(400);
      return { ok: false, error: messages };
    }
    const result = await runAgent(messages);
    if (!result.ok) {
      reply.code(422);
      return { ok: false, error: result.error, toolCalls: result.toolCalls };
    }
    return { ok: true, output: result.output, chat: result.chat, toolCalls: result.toolCalls };
  });

  return app;
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("/server.ts") || entry.endsWith("/server.js")) {
  const port = Number(process.env.PORT ?? 3000);
  buildServer()
    .then((app) => app.listen({ port, host: "0.0.0.0" }))
    .then(() => console.log(`OmniPlanner listening on http://localhost:${port}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
