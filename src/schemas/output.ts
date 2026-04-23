import { z } from "zod";

export const RiskFlag = z.enum(["rain"]);

export const TravelDay = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  plan: z.string(),
  indoor: z.boolean(),
});

export const TravelItinerary = z.object({
  type: z.literal("TRAVEL_ITINERARY"),
  location: z.string(),
  days: z.array(TravelDay).min(1),
  budget_estimate: z.number().int().nonnegative(),
  risk_flags: z.array(RiskFlag),
});

export const ChatOutput = z.object({
  message: z.string(),
});

export const DecisionOption = z.object({
  name: z.string().min(1),
  score: z.number().int().min(0).max(100),
});

export const DecisionReport = z
  .object({
    type: z.literal("DECISION_REPORT"),
    options: z.array(DecisionOption).min(2),
    recommendation: z.string().min(1),
  })
  .superRefine((data, ctx) => {
    const names = data.options.map((o) => o.name);
    if (!names.includes(data.recommendation)) {
      ctx.addIssue({
        code: "custom",
        path: ["recommendation"],
        message: "recommendation must exactly match one of options[].name",
      });
    }
  });

export const AgentStructured = z.union([TravelItinerary, DecisionReport]);

export const AgentOutputEnvelope = z.object({
  response: AgentStructured.nullable(),
  chat: ChatOutput,
});

export type TravelItinerary = z.infer<typeof TravelItinerary>;
export type ChatOutput = z.infer<typeof ChatOutput>;
export type DecisionOption = z.infer<typeof DecisionOption>;
export type DecisionReport = z.infer<typeof DecisionReport>;
export type AgentStructured = z.infer<typeof AgentStructured>;
export type AgentOutput = AgentStructured | null;
export type AgentOutputEnvelope = z.infer<typeof AgentOutputEnvelope>;
