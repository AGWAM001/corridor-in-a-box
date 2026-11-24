import { describe, expect, it } from "vitest";
import {
  assessRateHistory,
  DEFAULT_ESTIMATE_MIN_DAYS,
  DEFAULT_ESTIMATE_MIN_SAMPLES,
  type RateHistorySample,
} from "@corridor/router";

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

/** `count` samples evenly spread over `spanMs`, starting at T0, all at one rate. */
function history(count: number, spanMs: number, rate = "1500"): RateHistorySample[] {
  if (count === 0) return [];
  if (count === 1) return [{ rate, observedAt: T0 }];
  return Array.from({ length: count }, (_, i) => ({
    rate,
    observedAt: T0 + Math.round((spanMs * i) / (count - 1)),
  }));
}

describe("assessRateHistory minimum-data rule (RFC 0004 §3)", () => {
  it("exposes the RFC defaults: 100 samples and 7 days", () => {
    expect(DEFAULT_ESTIMATE_MIN_SAMPLES).toBe(100);
    expect(DEFAULT_ESTIMATE_MIN_DAYS).toBe(7);
  });

  describe("sample-count threshold (span held at 8 days)", () => {
    it("refuses just below 100 samples", () => {
      expect(assessRateHistory(history(99, 8 * DAY_MS))).toEqual({
        ok: false,
        reason: "insufficient history: 99 of 100 samples required",
      });
    });

    it("accepts exactly 100 samples", () => {
      expect(assessRateHistory(history(100, 8 * DAY_MS))).toEqual({
        ok: true,
        p25: "1500",
        samples: 100,
      });
    });

    it("accepts just above 100 samples", () => {
      expect(assessRateHistory(history(101, 8 * DAY_MS))).toEqual({
        ok: true,
        p25: "1500",
        samples: 101,
      });
    });

    it("refuses an empty history", () => {
      expect(assessRateHistory([])).toEqual({
        ok: false,
        reason: "insufficient history: 0 of 100 samples required",
      });
    });
  });

  describe("days-of-data threshold (count held at 120 samples)", () => {
    it("refuses just below 7 days of data", () => {
      expect(assessRateHistory(history(120, 7 * DAY_MS - 60 * 60 * 1000))).toEqual({
        ok: false,
        reason: "insufficient history: 6.96 d of data, 7 d required",
      });
    });

    it("accepts exactly 7 days of data", () => {
      const result = assessRateHistory(history(120, 7 * DAY_MS));
      expect(result).toEqual({ ok: true, p25: "1500", samples: 120 });
    });

    it("accepts just above 7 days of data", () => {
      const result = assessRateHistory(history(120, 7 * DAY_MS + 1));
      expect(result).toEqual({ ok: true, p25: "1500", samples: 120 });
    });

    it("reports a fractional span when the history is much shorter", () => {
      expect(assessRateHistory(history(120, DAY_MS / 2))).toEqual({
        ok: false,
        reason: "insufficient history: 0.5 d of data, 7 d required",
      });
    });
  });

  it("reports the sample count first when both thresholds fail", () => {
    expect(assessRateHistory(history(50, DAY_MS))).toEqual({
      ok: false,
      reason: "insufficient history: 50 of 100 samples required",
    });
  });

  describe("configurable thresholds", () => {
    const thresholds = { minSamples: 3, minDays: 2 };

    it("accepts at both custom thresholds", () => {
      expect(assessRateHistory(history(3, 2 * DAY_MS), thresholds)).toEqual({
        ok: true,
        p25: "1500",
        samples: 3,
      });
    });

    it("refuses below the custom sample threshold", () => {
      expect(assessRateHistory(history(2, 3 * DAY_MS), thresholds)).toEqual({
        ok: false,
        reason: "insufficient history: 2 of 3 samples required",
      });
    });

    it("refuses below the custom days threshold", () => {
      expect(assessRateHistory(history(3, DAY_MS), thresholds)).toEqual({
        ok: false,
        reason: "insufficient history: 1 d of data, 2 d required",
      });
    });
  });

  describe("the P25 it returns", () => {
    const small = { minSamples: 4, minDays: 0 };

    it("is the nearest-rank lower quartile of the observed rates", () => {
      const samples: RateHistorySample[] = [
        { rate: "40", observedAt: T0 },
        { rate: "10", observedAt: T0 + DAY_MS },
        { rate: "30", observedAt: T0 + 2 * DAY_MS },
        { rate: "20", observedAt: T0 + 3 * DAY_MS },
      ];
      expect(assessRateHistory(samples, small)).toEqual({ ok: true, p25: "10", samples: 4 });
    });

    it("picks the 25th of 100 rates, counting from the lowest", () => {
      const samples = Array.from({ length: 100 }, (_, i) => ({
        rate: String(100 - i),
        observedAt: T0 + i * DAY_MS,
      }));
      expect(assessRateHistory(samples)).toEqual({ ok: true, p25: "25", samples: 100 });
    });

    it("returns the observed rate string verbatim, trailing zeros and all", () => {
      const samples = history(100, 8 * DAY_MS, "1512.3400");
      expect(assessRateHistory(samples)).toEqual({ ok: true, p25: "1512.3400", samples: 100 });
    });

    it("orders rates by exact decimal value, not float64", () => {
      const samples: RateHistorySample[] = [
        { rate: "1.0000000000000002", observedAt: T0 },
        { rate: "1.0000000000000001", observedAt: T0 + DAY_MS },
        { rate: "3", observedAt: T0 + 2 * DAY_MS },
        { rate: "4", observedAt: T0 + 3 * DAY_MS },
      ];
      // float64 cannot tell the first two apart; the lower one is the P25.
      expect(assessRateHistory(samples, small)).toEqual({
        ok: true,
        p25: "1.0000000000000001",
        samples: 4,
      });
    });

    it("does not mutate or reorder the caller's samples", () => {
      const samples: RateHistorySample[] = [
        { rate: "9", observedAt: T0 + DAY_MS },
        { rate: "1", observedAt: T0 },
        { rate: "5", observedAt: T0 + 3 * DAY_MS },
        { rate: "3", observedAt: T0 + 2 * DAY_MS },
      ];
      assessRateHistory(samples, small);
      expect(samples.map((s) => s.rate)).toEqual(["9", "1", "5", "3"]);
    });
  });

  describe("malformed history fails closed", () => {
    it("refuses a non-decimal rate", () => {
      const samples = history(100, 8 * DAY_MS);
      samples[42] = { rate: "not-a-rate", observedAt: T0 };
      expect(assessRateHistory(samples)).toEqual({
        ok: false,
        reason: 'invalid rate in history: "not-a-rate"',
      });
    });

    it("refuses a zero or negative rate: neither is a price", () => {
      for (const rate of ["0", "-1500"]) {
        const samples = history(100, 8 * DAY_MS);
        samples[0] = { rate, observedAt: T0 };
        expect(assessRateHistory(samples)).toEqual({
          ok: false,
          reason: `invalid rate in history: "${rate}"`,
        });
      }
    });
  });
});
