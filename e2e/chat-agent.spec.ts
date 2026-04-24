import { expect, test } from "@playwright/test";

//set .env E2E_LIVE=1 and OPENAI_API_KEY to run live agent tests
const LIVE = process.env.E2E_LIVE === "1";

test.describe("POST /chat agent round trip", () => {
  test.skip(!LIVE, "set E2E_LIVE=1 and OPENAI_API_KEY to run live agent tests");
  test.describe.configure({ timeout: 120_000 });

  test("returns an ok envelope for a simple chat-only prompt", async ({ request }) => {
    const response = await request.post("/chat", {
      data: { messages: [{ role: "user", content: "hi" }] },
    });

    expect(response.status()).toBe(200);

    const payload = (await response.json()) as {
      ok: boolean;
      chat?: { message?: unknown };
      toolCalls?: unknown;
      output?: unknown;
    };

    expect(payload.ok).toBe(true);
    expect(typeof payload.chat?.message).toBe("string");
    expect((payload.chat?.message as string).length).toBeGreaterThan(0);
    expect(Array.isArray(payload.toolCalls)).toBe(true);
  });
});
