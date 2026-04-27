"""Shared eval case definitions for the OmniPlanner pipeline.

The same `EvalCase` rows feed both the curated baseline and the
generated artifact written by the pipeline's "generate" phase, so the
prompts/rubrics live in exactly one place.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class EvalCase:
    name: str
    prompt: str
    expected_output: str


CASES: list[EvalCase] = [
    EvalCase(
        name="chat_only_greeting",
        prompt="Hi there, what can you help me with?",
        expected_output=(
            "A friendly 1-3 sentence greeting that briefly lists what the assistant "
            "can help with (travel planning, stock snapshots, movies in theaters, "
            "US city cost signals). The structured output must be null because this "
            "is a chat-only turn."
        ),
    ),
    EvalCase(
        name="travel_itinerary_seattle",
        prompt="Plan a 3-day weekend trip to Seattle starting this Friday.",
        expected_output=(
            "A TRAVEL_ITINERARY with location referencing Seattle, exactly 3 "
            "entries in days[] with ISO YYYY-MM-DD dates in sequence, a positive "
            "integer budget_estimate, and risk_flags that only contain 'rain' if "
            "a weather tool call actually reported rain_probability >= 0.6. The "
            "chat.message should be a short intro or wrap-up, not a day list."
        ),
    ),
    EvalCase(
        name="decision_report_tsla_vs_travel",
        prompt="Should I invest $1000 in TSLA or take a weekend trip to New York City?",
        expected_output=(
            "A DECISION_REPORT with at least two options (one whose name contains "
            "'TSLA', one referencing NYC travel), integer scores in [0, 100], and "
            "a recommendation that exactly matches one of the option names. "
            "chat.message should cite concrete tool facts like price, trend, "
            "volatility_score, temperature, or rain_probability and briefly "
            "explain the tradeoff."
        ),
    ),
    EvalCase(
        name="movies_now_playing_chicago",
        prompt="What movies are playing in theaters in Chicago right now?",
        expected_output=(
            "Structured `output` may be null — listing movies only in "
            "`chat.message` is valid. Every film title the assistant names must "
            "appear exactly (same spelling) in the get_local_movies rows inside "
            "`retrieval_context`; release dates and vote_average, if stated, must "
            "match those rows. Plot one-liners may paraphrase tool overviews but "
            "must not add titles absent from retrieval_context."
        ),
    ),
    EvalCase(
        name="city_metrics_austin",
        prompt="How affordable is Austin, Texas? I care about rent and income.",
        expected_output=(
            "A chat reply grounded in get_city_metrics for Austin. If the tool "
            "returns median_household_income_usd and/or median_gross_rent_usd, "
            "those numbers in prose must match exactly. If those fields are null, "
            "say so explicitly and still report cost_index, limited, and note from "
            "the tool; do not invent ACS figures. output may be null (chat-only)."
        ),
    ),
    EvalCase(
        name="weather_forecast_boston",
        prompt="What will the weather be like in Boston tomorrow?",
        expected_output=(
            "A helpful reply grounded in get_weather for Boston for a single future "
            "calendar day (tomorrow). Any temperature, rain_probability, or "
            "conditions stated in chat.message must match the tool result in "
            "retrieval_context. output may be null (chat-only)."
        ),
    ),
    EvalCase(
        name="stock_quote_msft",
        prompt="What is Microsoft's stock price and trend right now?",
        expected_output=(
            "A reply grounded in get_stock_data for MSFT (symbol MSFT). "
            "chat.message should cite price, trend, and/or volatility_score from "
            "the tool; those values must match retrieval_context. output may be "
            "null (chat-only)."
        ),
    ),
    EvalCase(
        name="decision_aapl_vs_msft",
        prompt="Should I invest in AAPL or MSFT for the next quarter?",
        expected_output=(
            "A DECISION_REPORT with at least two options whose names include "
            "both 'AAPL' and 'MSFT' (or clear Apple vs Microsoft labels tied to "
            "those tickers), integer scores in [0, 100], and recommendation "
            "exactly matching one option name. chat.message should cite concrete "
            "get_stock_data facts for each ticker (price, trend, volatility_score). "
            "Both tickers should have been retrieved before scoring."
        ),
    ),
    EvalCase(
        name="movies_now_playing_london",
        prompt="What movies are playing in theaters in London right now?",
        expected_output=(
            "Structured output may be null. Listings in chat.message must be "
            "grounded in get_local_movies for London: every title must appear in "
            "retrieval_context rows; release_date and vote_average must match if "
            "quoted. Region should reflect the UK theatrical market from the tool."
        ),
    ),
    EvalCase(
        name="city_compare_denver_phoenix",
        prompt="Compare cost of living between Denver and Phoenix for a potential move.",
        expected_output=(
            "A reply that compares the two cities using get_city_metrics results "
            "for Denver and Phoenix (two tool calls or one per city). Any "
            "cost_index, income, rent, population, limited, or note values "
            "mentioned must match the corresponding retrieval_context payloads; "
            "do not invent Census figures. output may be null (chat-only)."
        ),
    ),
]
