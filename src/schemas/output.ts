import { z } from "zod";

export const RiskFlag = z.enum(["rain"]);

export const TravelDay = z.object({
  /** ISO date YYYY-MM-DD. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  plan: z.string(),
  indoor: z.boolean(),
});

export const TravelItinerary = z.object({
  type: z.literal("TRAVEL_ITINERARY"),
  location: z.string(),
  days: z.array(TravelDay).min(1),
  /** Rough USD ballpark for lodging + food + light activities for the trip length. */
  budget_estimate: z.number().int().nonnegative(),
  risk_flags: z.array(RiskFlag),
});

export const ChatMessage = z.object({
  type: z.literal("CHAT"),
  message: z.string(),
});

export const AgentOutput = z.union([TravelItinerary, ChatMessage]);

/** Envelope used as the root schema for OpenAI structured outputs (which requires an object root). */
export const AgentOutputEnvelope = z.object({
  response: AgentOutput,
});

export type TravelItinerary = z.infer<typeof TravelItinerary>;
export type ChatMessage = z.infer<typeof ChatMessage>;
export type AgentOutput = z.infer<typeof AgentOutput>;
export type AgentOutputEnvelope = z.infer<typeof AgentOutputEnvelope>;
