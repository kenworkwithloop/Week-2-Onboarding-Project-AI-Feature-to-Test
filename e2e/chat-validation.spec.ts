import { expect, test, type APIResponse } from "@playwright/test";

interface ValidationFailure {
  body: unknown;
  reason: string;
}

//these tests mirror the validateMessages rules in src/server.ts and never reach the agent, so they stay deterministic and cheap without API keys
const INVALID_BODIES: ValidationFailure[] = [
  { body: {}, reason: "messages is missing" },
  { body: { messages: [] }, reason: "messages is empty" },
  { body: { messages: "nope" }, reason: "messages is not an array" },
  {
    body: { messages: [{ role: "system", content: "hi" }] },
    reason: "role is not 'user' or 'assistant'",
  },
  {
    body: { messages: [{ role: "user", content: "" }] },
    reason: "content is empty",
  },
  {
    body: { messages: [{ role: "user", content: 42 }] },
    reason: "content is not a string",
  },
  {
    body: {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    },
    reason: "last message is not role 'user'",
  },
];

async function parseJson(response: APIResponse): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test.describe("POST /chat validation", () => {
  for (const { body, reason } of INVALID_BODIES) {
    test(`returns 400 when ${reason}`, async ({ request }) => {
      const response = await request.post("/chat", { data: body });

      expect(response.status()).toBe(400);

      const payload = await parseJson(response);
      expect(payload.ok).toBe(false);
      expect(typeof payload.error).toBe("string");
      expect((payload.error as string).length).toBeGreaterThan(0);
    });
  }
});
