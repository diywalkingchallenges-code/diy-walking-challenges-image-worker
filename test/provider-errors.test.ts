import { describe, expect, it, vi } from "vitest";

import {
  FAILURE_DIAGNOSTIC_MAX_ROWS,
  recordProviderFailureDiagnostic,
  saveProviderFailureDiagnostic,
} from "../src/failure-diagnostics";
import {
  classifyCloudflareAiError,
  extractCloudflareAiErrorCode,
} from "../src/provider-errors";

describe("Cloudflare Workers AI error normalization", () => {
  it.each([
    [{ cause: { error: { internalCode: 3030 } } }, "3030"],
    [{ response: { body: '{"errors":[{"internal_code":"3040"}]}' } }, "3040"],
    [new Error("AI_ERROR: 3036: daily allocation reached"), "3036"],
    ["InferenceUpstreamError: 3007: Request timeout", "3007"],
    ["The upstream request failed (code 5007)", "5007"],
    [{ errorCode: "3042" }, "3042"],
  ])("extracts a bounded four-digit code from supported nested and string shapes", (error, code) => {
    expect(extractCloudflareAiErrorCode(error)).toBe(code);
  });

  it("ignores unrelated numbers, malformed codes, cycles, and property getters", () => {
    const cyclic: Record<string, unknown> = { message: "The prompt asked for 3040 trees" };
    cyclic.cause = cyclic;
    Object.defineProperty(cyclic, "code", {
      get: () => {
        throw new Error("must not execute");
      },
    });
    expect(extractCloudflareAiErrorCode(cyclic)).toBeUndefined();
    expect(extractCloudflareAiErrorCode({ code: "raw-secret-code" })).toBeUndefined();
    expect(extractCloudflareAiErrorCode({ code: 429 })).toBeUndefined();
  });

  it.each([
    [3030, "content_filter", "content_rejected", 422, false],
    [3040, "capacity", "model_busy", 503, true],
    [3036, "free_quota", "workers_ai_quota_exhausted", 503, true],
    [3007, "timeout", "model_timeout", 504, true],
    [3008, "timeout", "model_timeout", 504, true],
    [5007, "invalid_model", "model_configuration_error", 503, false],
    [3042, "invalid_model", "model_configuration_error", 503, false],
    [3023, "access", "model_configuration_error", 503, false],
    [3041, "access", "model_configuration_error", 503, false],
    [5016, "access", "model_configuration_error", 503, false],
    [5018, "access", "model_configuration_error", 503, false],
    [5035, "access", "model_configuration_error", 503, false],
  ])(
    "maps provider code %i to a stable sanitized API error",
    (providerCode, category, apiCode, status, retryable) => {
      const rawMessage = `provider-only secret ${providerCode}`;
      const result = classifyCloudflareAiError({ code: providerCode, message: rawMessage }, 4_321);
      expect(result).toMatchObject({
        providerCode: String(providerCode),
        category,
        api: { code: apiCode, status, retryable },
      });
      expect(result.api.message).not.toContain(rawMessage);
      expect(result.api.message).not.toContain(String(providerCode));
      if (providerCode === 3036) expect(result.api.retryAfterSeconds).toBe(4_321);
    },
  );

  it("preserves the sanitized content-keyword and unknown fallbacks", () => {
    expect(classifyCloudflareAiError(new Error("NSFW filter declined input"), 60)).toMatchObject({
      providerCode: "unknown",
      category: "content_filter",
      api: { code: "content_rejected" },
    });
    const unknown = classifyCloudflareAiError(
      new Error("raw upstream detail that must remain private"),
      60,
    );
    expect(unknown).toMatchObject({
      providerCode: "unknown",
      category: "unknown",
      api: { code: "model_unavailable", retryAfterSeconds: 120 },
    });
    expect(unknown.api.message).not.toContain("raw upstream detail");
  });
});

describe("provider failure diagnostics", () => {
  it("writes only minimal fields and batches age and row-count retention pruning", async () => {
    const bound: Array<{ sql: string; values: unknown[] }> = [];
    const batch = vi.fn(async (statements: D1PreparedStatement[]) =>
      statements.map(() => ({ success: true })),
    );
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...values: unknown[]) => {
          bound.push({ sql, values });
          return {} as D1PreparedStatement;
        }),
      })),
      batch,
    } as unknown as D1Database;
    const instant = new Date("2026-09-04T12:34:56.000Z");

    await saveProviderFailureDiagnostic(
      db,
      {
        requestId: "73582ff2-4c07-4f17-99a7-38bcf0941e09",
        modelAlias: "flux-schnell",
        assetKind: "medal",
        providerCode: "3030",
        category: "content_filter",
      },
      instant,
    );

    expect(batch).toHaveBeenCalledOnce();
    expect(bound).toHaveLength(3);
    expect(bound[0].values).toEqual([
      "73582ff2-4c07-4f17-99a7-38bcf0941e09",
      "flux-schnell",
      "medal",
      "3030",
      "content_filter",
      instant.toISOString(),
    ]);
    expect(bound[0].sql).not.toMatch(/prompt|installation|ip|message/iu);
    expect(bound[1]).toMatchObject({ values: ["2026-08-05T12:34:56.000Z"] });
    expect(bound[2]).toMatchObject({ values: [FAILURE_DIAGNOSTIC_MAX_ROWS] });
  });

  it("never lets diagnostic persistence failure replace the original failure", async () => {
    const rawSentinel = "raw-provider-message-and-secret";
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({} as D1PreparedStatement)) })),
      batch: vi.fn(async () => {
        throw new Error(rawSentinel);
      }),
    } as unknown as D1Database;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      recordProviderFailureDiagnostic(db, {
        requestId: "73582ff2-4c07-4f17-99a7-38bcf0941e09",
        modelAlias: "flux-schnell",
        assetKind: "medal",
        providerCode: "3040",
        category: "capacity",
      }),
    ).resolves.toBeUndefined();

    const serializedLogs = JSON.stringify(consoleError.mock.calls);
    expect(serializedLogs).toContain("workers_ai_inference_failure");
    expect(serializedLogs).toContain("workers_ai_diagnostic_persistence_failure");
    expect(serializedLogs).not.toContain(rawSentinel);
    expect(Object.keys(consoleError.mock.calls[0][0] as object).sort()).toEqual([
      "assetKind",
      "category",
      "event",
      "modelAlias",
      "providerCode",
      "requestId",
      "timestamp",
    ]);
    consoleError.mockRestore();
  });
});
