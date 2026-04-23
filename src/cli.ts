#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { runAgent } from "./agent/runAgent.js";

const program = new Command();

program
  .name("omniplanner")
  .description("Weather-aware travel chatbot with Zod-validated structured outputs.")
  .version("0.1.0");

program
  .command("run")
  .description("Send a single user message to the agent.")
  .requiredOption("-p, --prompt <text>", "User message, e.g. 'Plan a weekend in Seattle' or 'hi'")
  .action(async (opts: { prompt: string }) => {
    const result = await runAgent([{ role: "user", content: opts.prompt }]);
    if (!result.ok) {
      console.error(JSON.stringify({ ok: false, error: result.error }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(
      JSON.stringify({ ok: true, output: result.output, toolCalls: result.toolCalls }, null, 2),
    );
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
