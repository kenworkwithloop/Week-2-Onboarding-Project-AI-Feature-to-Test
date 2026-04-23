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
  .argument(
    "<words...>",
    "Full user message (all words after `run`; no quotes needed). Example: run Should I invest in TSLA?",
  )
  .action(async (words: string[]) => {
    const prompt = words.join(" ").trim();
    if (!prompt) {
      console.error(
        'Missing prompt: put your message after `run`, e.g. npm run dev -- run Should I invest in TSLA?',
      );
      process.exitCode = 1;
      return;
    }
    const result = await runAgent([{ role: "user", content: prompt }]);
    if (!result.ok) {
      console.error(JSON.stringify({ ok: false, error: result.error }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(
      JSON.stringify(
        { ok: true, output: result.output, chat: result.chat, toolCalls: result.toolCalls },
        null,
        2,
      ),
    );
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
