import { expect, test } from "@playwright/test";

test.describe("GET /health", () => {
  test("returns 200 with { status: 'ok' }", async ({ request }) => {
    const response = await request.get("/health");

    expect(response.status()).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
