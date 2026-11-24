// Rate-history minimum-data rule for `estimated` prices (RFC 0004 §3).
//
// An anchor gets an `estimated` price for a pair only when its rate history
// is deep enough: at least 7 days of data and at least 100 samples in the
// window. Below either threshold the pair is unpriceable at that anchor —
// too little data must never be presented as a price (docs/threat-model.md).

import { isValidAmount } from "@corridor/types";

/** Default minimum sample count for an `estimated` price (RFC 0004 §3). */
export const DEFAULT_ESTIMATE_MIN_SAMPLES = 100;

/** Default minimum span of rate history, in days, for an `estimated` price (RFC 0004 §3). */
export const DEFAULT_ESTIMATE_MIN_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * One rate observation for a pair at an anchor, as held in rate history
 * (RFC 0004 §3): the anchor's indicative price, a DEX trade price, or the
 * effective rate of one of the business's own completed payments.
 */
export interface RateHistorySample {
  /** Observed rate as a decimal string: destination units per 1 source unit. */
  readonly rate: string;
  /** When the rate was observed, in epoch milliseconds. */
  readonly observedAt: number;
}

/**
 * The minimum-data thresholds, configurable per business (RFC 0004 §3).
 * Both default to the RFC values when omitted.
 */
export interface EstimateThresholds {
  /** Minimum number of samples in the window (default `100`). */
  readonly minSamples?: number;
  /** Minimum span of data in days, from the first to the last sample (default `7`). */
  readonly minDays?: number;
}

/**
 * Whether a pair at an anchor can carry an `estimated` price: either the
 * lower-quartile rate (P25, RFC 0004 D3) and the number of samples behind
 * it, or the reason the history is not deep enough.
 */
export type EstimateAssessment =
  | { readonly ok: true; readonly p25: string; readonly samples: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Exact decimal comparison of two rate strings, via scaled BigInts, so
 * ordering never depends on float64 precision.
 */
function compareRates(a: string, b: string): number {
  const scale = Math.max(fracLength(a), fracLength(b));
  const x = toScaledRate(a, scale);
  const y = toScaledRate(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

function fracLength(rate: string): number {
  const dot = rate.indexOf(".");
  return dot === -1 ? 0 : rate.length - dot - 1;
}

function toScaledRate(rate: string, scale: number): bigint {
  const neg = rate.startsWith("-");
  const [intPart, fracPart = ""] = rate.replace("-", "").split(".");
  const mag = BigInt((intPart ?? "0") + fracPart.padEnd(scale, "0"));
  return neg ? -mag : mag;
}

function formatDays(days: number): string {
  return Number.isInteger(days) ? String(days) : Number(days.toFixed(2)).toString();
}

/**
 * Applies the minimum-data rule to the rate history held for one pair at one
 * anchor. Pass the observations in the estimate window (RFC 0004 D3); the
 * rule judges their depth — how many there are, and how long a span they
 * cover — and, when both thresholds are met, returns their lower quartile.
 *
 * The P25 is the nearest-rank quartile: an observed rate, returned verbatim,
 * never an interpolated or rounded value. Checks fail closed, in order: a
 * malformed or non-positive rate is refused first, then the sample count,
 * then the span.
 */
export function assessRateHistory(
  samples: readonly RateHistorySample[],
  thresholds?: EstimateThresholds,
): EstimateAssessment {
  const minSamples = thresholds?.minSamples ?? DEFAULT_ESTIMATE_MIN_SAMPLES;
  const minDays = thresholds?.minDays ?? DEFAULT_ESTIMATE_MIN_DAYS;

  for (const sample of samples) {
    if (!isValidAmount(sample.rate) || compareRates(sample.rate, "0") <= 0) {
      return { ok: false, reason: `invalid rate in history: "${sample.rate}"` };
    }
  }

  if (samples.length < minSamples) {
    return {
      ok: false,
      reason: `insufficient history: ${samples.length} of ${minSamples} samples required`,
    };
  }

  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    first = Math.min(first, sample.observedAt);
    last = Math.max(last, sample.observedAt);
  }
  const spanDays = (last - first) / MS_PER_DAY;
  if (spanDays < minDays) {
    return {
      ok: false,
      reason: `insufficient history: ${formatDays(spanDays)} d of data, ${minDays} d required`,
    };
  }

  const sorted = [...samples].sort((a, b) => compareRates(a.rate, b.rate));
  const rank = Math.max(1, Math.ceil(sorted.length / 4));
  const p25 = sorted[rank - 1];
  return { ok: true, p25: p25.rate, samples: samples.length };
}
