import type { DecisionReport } from "../schemas/output.js";
import type { StockReport } from "../tools/types.js";
import type { ToolCall } from "../tools/types.js";

/** Volatility threshold: "70" on a 0–100 scale → our metric is on [0, 1]. */
const VOLATILITY_HIGH = 0.7;
/** Points to subtract when the down + high-vol rule fires. */
const INVESTMENT_SCORE_PENALTY = 20;

function isStockResult(r: unknown): r is StockReport {
  if (r === null || typeof r !== "object") return false;
  if ("error" in r) return false;
  const o = r as Record<string, unknown>;
  return (
    o.trend === "up" || o.trend === "down" || o.trend === "sideways"
  ) && typeof o.volatility_score === "number";
}

function optionMentionsSymbol(optionName: string, symbol: string): boolean {
  return optionName.toUpperCase().includes(symbol.toUpperCase());
}

/**
 * Deterministic rule: IF trend == "down" AND volatility > 70 (0.7 on [0,1]), reduce that option's score.
 * Re-picks `recommendation` as the option with the highest score after adjustments.
 */
export function applyInvestmentRulesToDecision(
  report: DecisionReport,
  toolCalls: ToolCall[],
): DecisionReport {
  const deltas = new Map<number, number>();

  for (const tc of toolCalls) {
    if (tc.name !== "get_stock_data") continue;
    const sym = String(tc.args["symbol"] ?? "")
      .trim()
      .toUpperCase();
    if (!sym) continue;
    if (!isStockResult(tc.result)) continue;
    const { trend, volatility_score } = tc.result;
    if (trend !== "down" || volatility_score <= VOLATILITY_HIGH) continue;

    report.options.forEach((opt, idx) => {
      if (optionMentionsSymbol(opt.name, sym)) {
        deltas.set(idx, (deltas.get(idx) ?? 0) - INVESTMENT_SCORE_PENALTY);
      }
    });
  }

  if (deltas.size === 0) return report;

  const options = report.options.map((opt, idx) => {
    const d = deltas.get(idx) ?? 0;
    if (d === 0) return opt;
    return {
      ...opt,
      score: Math.max(0, Math.min(100, opt.score + d)),
    };
  });

  let best = options[0]!;
  for (const o of options) {
    if (o.score > best.score) best = o;
  }

  return {
    ...report,
    options,
    recommendation: best.name,
  };
}
