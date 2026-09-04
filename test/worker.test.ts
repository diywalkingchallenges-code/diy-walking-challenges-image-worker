import { describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";

import worker from "../src/index";
import { ImageValidationError, inspectImage, validateGeneratedImage } from "../src/images";
import {
  findModelAssetSpec,
  MILESTONE_BANNER_HEIGHT,
  MILESTONE_BANNER_WIDTH,
  MODEL_SPECS,
  ROUTE_MAP_HEIGHT,
  ROUTE_MAP_WIDTH,
} from "../src/models";
import {
  buildAssetPrompt,
  buildMedalPrompt,
  buildMilestoneBannerPrompt,
  buildRouteMapPrompt,
  countCodePoints,
  sanitizeUserPrompt,
} from "../src/prompt";
import { reserveGenerationBudget } from "../src/quota";
import { createReportToken, verifyReportToken } from "../src/reports";
import { deterministicPromptBlock, estimateSafetyNeurons } from "../src/safety";
import type { Env } from "../src/types";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

const INSTALLATION_ID = "8ba9f618-438f-4caa-a499-dfe73bd0b3ac";
const PEPPER = "p".repeat(40);
const REPORT_SECRET = "r".repeat(40);

function fakePng(width = 512, height = 512, size = 1_024): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

type MockDatabaseOptions = {
  diagnosticPersistenceFailure?: boolean;
  globalBudgetExhausted?: boolean;
  modelAttemptsExhausted?: boolean;
};

function mockDatabase(options: MockDatabaseOptions = {}): D1Database {
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...values: unknown[]) => ({
        first: vi.fn(async () => {
          if (sql.includes("daily_installation_model_attempts")) {
            return options.modelAttemptsExhausted ? null : { attempts: 1 };
          }
          if (sql.includes("daily_global_neuron_budget")) {
            return options.globalBudgetExhausted
              ? null
              : { estimated_neurons_used: Number(values[1]) };
          }
          if (sql.includes("generation_reports")) return { report_id: String(values[0]) };
          return null;
        }),
      })),
    })),
    batch: vi.fn(async (statements: D1PreparedStatement[]) => {
      if (options.diagnosticPersistenceFailure) throw new Error("private D1 failure detail");
      return statements.map(() => ({ success: true }));
    }),
  } as unknown as D1Database;
}

function mockEnv(
  overrides: Partial<Env> = {},
  databaseOptions: MockDatabaseOptions = {},
): Env {
  return {
    AI: {
      run: vi.fn(async (model: string) =>
        model === "@cf/meta/llama-guard-3-8b"
          ? { response: "safe" }
          : { image: base64(fakePng()) },
      ),
    },
    QUOTA_DB: mockDatabase(databaseOptions),
    INSTALL_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    IP_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    REPORT_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    RATE_LIMIT_HASH_PEPPER: PEPPER,
    REPORT_TOKEN_SECRET: REPORT_SECRET,
    DAILY_GLOBAL_NEURON_BUDGET: "8000",
    ENABLED_MODELS: "flux2-klein-4b,flux-schnell",
    SAFETY_MODEL: "@cf/meta/llama-guard-3-8b",
    ALLOWED_ORIGINS: "",
    ...overrides,
  };
}

function postGenerate(body: unknown, headers: HeadersInit = {}): Request {
  return new Request("https://medals.example/v1/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.9",
      "X-DIYWC-Installation-ID": INSTALLATION_ID,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("service landing page", () => {
  it("shows a friendly branded status page at the root URL", async () => {
    const response = await worker.fetch(new Request("https://medals.example/"), mockEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-diywc-api-version")).toBe("1");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(response.headers.get("permissions-policy")).toBe(
      "camera=(), geolocation=(), microphone=()",
    );
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    const html = await response.text();
    expect(html).toContain("DIY Walking Challenges");
    expect(html).toContain("Artwork generator is online");
    expect(html).toContain("completion medals, milestone banners, and route maps");
    expect(html).toContain("Service online · API v1");
    expect(html).toContain("noindex,nofollow,noarchive");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("RATE_LIMIT_HASH_PEPPER");
    expect(html).not.toContain("example-sensitive-account-id");
    expect(html).not.toContain("flux-schnell");
    expect(html).not.toContain("not_found");
  });

  it("supports a bodyless HEAD check with the same hardened content headers", async () => {
    const head = await worker.fetch(
      new Request("https://medals.example/", { method: "HEAD" }),
      mockEnv(),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(head.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(head.headers.get("permissions-policy")).toBe("camera=(), geolocation=(), microphone=()");
    expect(await head.text()).toBe("");
  });

  it("keeps unsupported root methods and unknown paths as structured JSON errors", async () => {
    const unsupported = await worker.fetch(
      new Request("https://medals.example/", { method: "POST" }),
      mockEnv(),
    );
    expect(unsupported.status).toBe(405);
    await expect(unsupported.json()).resolves.toMatchObject({
      error: { code: "method_not_allowed" },
    });

    const missing = await worker.fetch(
      new Request("https://medals.example/favicon.ico"),
      mockEnv(),
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "not_found" } });
  });

  it("still rejects an untrusted browser origin before rendering the root page", async () => {
    const response = await worker.fetch(
      new Request("https://medals.example/", { headers: { Origin: "https://untrusted.example" } }),
      mockEnv(),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "origin_not_allowed" },
    });
  });
});

describe("model catalog", () => {
  it.each(["/model", "/models"])("redirects the common %s alias to the versioned catalog", async (path) => {
    const response = await worker.fetch(
      new Request(`https://medals.example${path}`, { redirect: "manual" }),
      mockEnv(),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://medals.example/v1/models");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("allows a bodyless HEAD request through the model alias", async () => {
    const response = await worker.fetch(
      new Request("https://medals.example/model", { method: "HEAD", redirect: "manual" }),
      mockEnv(),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://medals.example/v1/models");
    expect(await response.text()).toBe("");
  });

  it("rejects mutation methods on a model alias", async () => {
    const response = await worker.fetch(
      new Request("https://medals.example/model", { method: "POST" }),
      mockEnv(),
    );
    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "method_not_allowed" },
    });
  });

  it("keeps seven unique reviewed adapters while production gates them separately", () => {
    expect(MODEL_SPECS).toHaveLength(7);
    expect(new Set(MODEL_SPECS.map((model) => model.cloudflareId)).size).toBe(7);
    expect(MODEL_SPECS.every((model) => model.cloudflareId.startsWith("@cf/"))).toBe(true);
  });

  it("only publishes the two conservative defaults", async () => {
    const response = await worker.fetch(new Request("https://medals.example/v1/models"), mockEnv());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      defaultAssetKind: string;
      promptLimits: { minCodePoints: number; maxCodePoints: number };
      quota: { dailyAttemptLimit: number; dailyAttemptScope: string; resets: string };
      models: Array<{
        id: string;
        name: string;
        description: string;
        supportsReference: boolean;
        assetKinds: Array<{
          id: string;
          baseEstimatedImageNeurons: number;
          output: { providerControlled: boolean; width?: number; height?: number };
          supportsReference: boolean;
          referenceMaxWidth?: number;
          referenceMaxHeight?: number;
        }>;
      }>;
    };
    expect(body.defaultAssetKind).toBe("medal");
    expect(body.promptLimits).toEqual({ minCodePoints: 3, maxCodePoints: 50 });
    expect(body.quota).toEqual({
      dailyAttemptLimit: 3,
      dailyAttemptScope: "installation_model",
      resets: "utc_day",
    });
    expect(body.models).toEqual([
      expect.objectContaining({
        id: "flux-schnell",
        name: "Flux Schnell",
        description: "Fast completion-medal artwork; not available for maps or banners",
        supportsReference: false,
        dailyAttemptLimit: 3,
        baseEstimatedImageNeurons: 58,
        output: { providerControlled: true },
      }),
      expect.objectContaining({
        id: "flux2-klein-4b",
        supportsReference: true,
        dailyAttemptLimit: 3,
        baseEstimatedImageNeurons: 27,
        output: { width: 512, height: 512, providerControlled: false },
      }),
    ]);
    expect(body.models[0].assetKinds).toEqual([
      {
        id: "medal",
        baseEstimatedImageNeurons: 58,
        output: { providerControlled: true },
        supportsReference: false,
      },
    ]);
    expect(body.models[1].assetKinds).toEqual([
      expect.objectContaining({
        id: "medal",
        baseEstimatedImageNeurons: 27,
        output: { width: 512, height: 512, providerControlled: false },
        supportsReference: true,
        referenceMaxWidth: 512,
        referenceMaxHeight: 512,
      }),
      expect.objectContaining({
        id: "milestone_banner",
        baseEstimatedImageNeurons: 53,
        output: {
          width: MILESTONE_BANNER_WIDTH,
          height: MILESTONE_BANNER_HEIGHT,
          providerControlled: false,
        },
      }),
      expect.objectContaining({
        id: "route_map",
        baseEstimatedImageNeurons: 105,
        output: {
          width: ROUTE_MAP_WIDTH,
          height: ROUTE_MAP_HEIGHT,
          providerControlled: false,
        },
      }),
    ]);
  });

  it("cannot enable the five non-production adapters through configuration alone", async () => {
    const response = await worker.fetch(
      new Request("https://medals.example/v1/models"),
      mockEnv({
        ENABLED_MODELS:
          "flux-schnell,flux2-klein-4b,sdxl-lightning,sdxl-base,phoenix,lucid-origin,flux2-dev",
      }),
    );
    const body = (await response.json()) as { models: Array<{ id: string }> };
    expect(body.models.map((model) => model.id)).toEqual(["flux-schnell", "flux2-klein-4b"]);
  });

  it("requests each reviewed Klein output and budgets output and reference tiles", async () => {
    const klein = MODEL_SPECS.find((model) => model.alias === "flux2-klein-4b")!;
    const reference = {
      mimeType: "image/png" as const,
      bytes: fakePng(),
      width: 512,
      height: 512,
    };
    const cases = [
      ["medal", 512, 512, 27, 32],
      ["milestone_banner", MILESTONE_BANNER_WIDTH, MILESTONE_BANNER_HEIGHT, 53, 58],
      ["route_map", ROUTE_MAP_WIDTH, ROUTE_MAP_HEIGHT, 105, 110],
    ] as const;

    for (const [assetKind, width, height, baseNeurons, referenceNeurons] of cases) {
      const asset = findModelAssetSpec(klein, assetKind)!;
      const inputs = (await klein.buildInputs(
        `an original ${assetKind}`,
        undefined,
        undefined,
        asset,
      )) as { multipart: { body: ReadableStream<Uint8Array>; contentType: string } };
      const form = await new Response(inputs.multipart.body, {
        headers: { "Content-Type": inputs.multipart.contentType },
      }).formData();
      expect(form.get("width")).toBe(String(width));
      expect(form.get("height")).toBe(String(height));
      expect(klein.estimateImageNeurons(asset, undefined)).toBe(baseNeurons);
      expect(klein.estimateImageNeurons(asset, reference)).toBe(referenceNeurons);
    }
  });

  it("keeps Schnell at four steps and conservatively budgets its provider-sized output", async () => {
    const schnell = MODEL_SPECS.find((model) => model.alias === "flux-schnell")!;
    const medal = findModelAssetSpec(schnell, "medal")!;
    const inputs = (await schnell.buildInputs("an original medal", undefined, undefined, medal)) as Record<
      string,
      unknown
    >;
    expect(inputs).toMatchObject({ steps: 4 });
    expect(inputs).not.toHaveProperty("width");
    expect(inputs).not.toHaveProperty("height");
    expect(schnell.estimateImageNeurons(medal, undefined)).toBe(58);
  });
});

describe("prompt boundary", () => {
  it("normalizes controls and keeps emoji as one code point", () => {
    const result = sanitizeUserPrompt("  brass\u0000  fox 🦊  <ignore> ");
    expect(result).toBe("brass fox 🦊 ‹ignore›");
    expect(countCodePoints("🦊")).toBe(1);
  });

  it("inserts the user theme into the fixed premium medal parent prompt", () => {
    const result = buildMedalPrompt("a moonlit mountain");
    expect(result).toBe(`Create an elaborate premium collectible challenge medal themed around: a moonlit mountain

Design the artwork specifically around the theme. Use a distinctive irregular die-cut shape created by the thematic artwork itself, with elements extending beyond the edges. Avoid a conventional round, oval, shield, or badge-shaped medal.

Use a cohesive theme-appropriate palette of colorful hard enamel, with raised antique-metal outlines, deep sculptural 3D relief, overlapping metal layers, cutouts, and intricate dimensional details. Colors should enhance the subject naturally, not be randomly rainbow-colored.

Cover the entire face of the medal with thematic artwork and decorative metalwork. Use imagery, patterns, enamel, textures, and sculptural details all the way to the lower edge. The design contains artwork only, with no written language anywhere.

One complete medal hanging from a premium woven ribbon. Photorealistic studio product photo, mostly frontal, realistic metal and glossy enamel, sharp detail.

Originality requirement: Create new artwork. Do not reproduce an existing commercial medal, brand logo, trademark, copyrighted character, signature, or watermark.`);
    expect(result).not.toContain("{{USER_PROMPT}}");
    expect(result.match(/a moonlit mountain/gu)).toHaveLength(1);
  });

  it("uses fixed wide-banner instructions without letting the theme replace them", () => {
    const result = buildMilestoneBannerPrompt("a moonlit waterfall");
    expect(result).toBe(`Create an original wide milestone story banner themed around: a moonlit waterfall

Compose a cinematic 2:1 landscape scene with one clear focal subject and an immersive, edge-to-edge background. Keep the most important subject matter inside the central safe area so it remains clear on different phone screens.

Make the scene polished, atmospheric, richly detailed, and suitable for celebrating progress in a walking challenge. Do not include a frame, device screen, product mockup, interface controls, route line, map pins, or checkpoint markers.

The artwork contains no written language anywhere: no title, words, letters, numbers, labels, logos, signatures, or watermarks.

Originality requirement: Create new artwork. Do not reproduce an existing commercial image, branded visual style, trademark, copyrighted character, signature, or watermark.`);
    expect(buildAssetPrompt("milestone_banner", "a moonlit waterfall")).toBe(result);
    expect(result.match(/a moonlit waterfall/gu)).toHaveLength(1);
  });

  it("uses a fixed decorative non-navigational route-map brief", () => {
    const result = buildRouteMapPrompt("coastal cliffs and pine forest");
    expect(result).toBe(`Create an original decorative illustrated route-map background themed around: coastal cliffs and pine forest

Use a top-down or near-orthographic 4:3 composition with cohesive terrain, open areas, natural paths, and visually distinct landmarks distributed across the image. Make the route overlay easy to see by avoiding clutter and extreme contrast through the center of the map.

This is a decorative, non-navigational illustration, not a geographically accurate map. Do not draw a route line, progress path, pins, checkpoints, start or finish markers, labels, a legend, interface controls, a frame, a folded-paper mockup, or a perspective horizon.

The artwork contains no written language anywhere: no place names, words, letters, numbers, coordinates, logos, signatures, or watermarks.

Originality requirement: Create new artwork. Do not reproduce branded or copyrighted cartography, satellite imagery, a commercial map style, a trademark, copyrighted character, signature, or watermark.`);
    expect(buildAssetPrompt("route_map", "coastal cliffs and pine forest")).toBe(result);
    expect(result.match(/coastal cliffs and pine forest/gu)).toHaveLength(1);
  });

  it("accepts exactly 50 Unicode code points and rejects 51 before inference", async () => {
    const env = mockEnv();
    const accepted = await worker.fetch(
      postGenerate({ model: "flux-schnell", prompt: "🦊".repeat(50) }),
      env,
    );
    expect(accepted.status).toBe(200);
    expect(env.AI.run).toHaveBeenCalledTimes(2);

    const rejected = await worker.fetch(
      postGenerate({ model: "flux-schnell", prompt: "🦊".repeat(51) }),
      env,
    );
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      error: {
        code: "invalid_prompt",
        message: "Artwork theme must be between 3 and 50 characters",
      },
    });
    expect(env.AI.run).toHaveBeenCalledTimes(2);
  });

  it("uses only narrow deterministic blocks as defense in depth", () => {
    expect(deterministicPromptBlock("an exact copy of an existing commercial medal")).toBe(true);
    expect(deterministicPromptBlock("a gothic skull medal with red enamel")).toBe(false);
  });

  it("adds conservative variable Llama Guard headroom as prompts grow", () => {
    expect(estimateSafetyNeurons("a short medal")).toBeGreaterThan(90);
    expect(estimateSafetyNeurons("x".repeat(50))).toBeGreaterThan(
      estimateSafetyNeurons("a short medal"),
    );
  });
});

describe("daily budget policy", () => {
  it("keys the exact three-attempt reservation by installation and model", async () => {
    const binds: unknown[][] = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...values: unknown[]) => {
          binds.push(values);
          return {
            first: vi.fn(async () =>
              sql.includes("daily_installation_model_attempts")
                ? { attempts: 1 }
                : { estimated_neurons_used: 153 },
            ),
          };
        }),
      })),
    } as unknown as D1Database;
    const result = await reserveGenerationBudget(
      db,
      "hashed-installation",
      "flux-schnell",
      153,
      8_000,
      new Date("2026-09-03T12:00:00Z"),
    );
    expect(result).toMatchObject({
      result: "reserved",
      modelAttempts: { used: 1, remaining: 2 },
      globalNeurons: { used: 153, remaining: 7_847 },
    });
    expect(binds[0]).toEqual([
      "2026-09-03",
      "hashed-installation",
      "flux-schnell",
      "2026-09-03T12:00:00.000Z",
      3,
    ]);
  });

  it("shares a model's three daily attempts across all of its artwork types", async () => {
    let attempts = 0;
    let globalNeurons = 0;
    const reservedAliases: string[] = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...values: unknown[]) => ({
          first: vi.fn(async () => {
            if (sql.includes("daily_installation_model_attempts")) {
              reservedAliases.push(String(values[2]));
              if (attempts >= 3) return null;
              attempts += 1;
              return { attempts };
            }
            if (sql.includes("daily_global_neuron_budget")) {
              globalNeurons += Number(values[1]);
              return { estimated_neurons_used: globalNeurons };
            }
            return null;
          }),
        })),
      })),
    } as unknown as D1Database;
    const ai = {
      run: vi.fn(async (model: string, inputs: unknown) => {
        if (model === "@cf/meta/llama-guard-3-8b") return { response: "safe" };
        const multipart = inputs as {
          multipart: { body: ReadableStream<Uint8Array>; contentType: string };
        };
        const form = await new Response(multipart.multipart.body, {
          headers: { "Content-Type": multipart.multipart.contentType },
        }).formData();
        return {
          image: base64(fakePng(Number(form.get("width")), Number(form.get("height")))),
        };
      }),
    };
    const env = mockEnv({ AI: ai, QUOTA_DB: db });
    const requests = [
      { model: "flux2-klein-4b", prompt: "forest medal" },
      { model: "flux2-klein-4b", assetKind: "milestone_banner", prompt: "forest banner" },
      { model: "flux2-klein-4b", assetKind: "route_map", prompt: "forest map" },
      { model: "flux2-klein-4b", assetKind: "route_map", prompt: "another map" },
    ];
    const responses = [];
    for (const request of requests) responses.push(await worker.fetch(postGenerate(request), env));

    expect(responses.slice(0, 3).map((response) => response.status)).toEqual([200, 200, 200]);
    expect(responses[3].status).toBe(429);
    await expect(responses[3].json()).resolves.toMatchObject({
      error: { code: "model_daily_limit_reached" },
    });
    expect(reservedAliases).toEqual(Array(4).fill("flux2-klein-4b"));
    expect(ai.run).toHaveBeenCalledTimes(6);
  });
});

describe("image validation", () => {
  it("reads PNG dimensions and accepts a bounded generated image", () => {
    expect(inspectImage(fakePng(1_024, 512))).toEqual({
      mimeType: "image/png",
      width: 1_024,
      height: 512,
    });
    expect(validateGeneratedImage(fakePng()).width).toBe(512);
  });

  it("rejects malformed and oversized-dimension output", () => {
    expect(() => inspectImage(new Uint8Array(100))).toThrow(ImageValidationError);
    expect(() => validateGeneratedImage(fakePng(4_096, 4_096))).toThrow(ImageValidationError);
  });

  it("requires exact dimensions when the selected model controls its output", () => {
    expect(validateGeneratedImage(fakePng(1_024, 512), { width: 1_024, height: 512 }))
      .toMatchObject({ width: 1_024, height: 512 });
    expect(() =>
      validateGeneratedImage(fakePng(512, 512), { width: 1_024, height: 512 }),
    ).toThrow("dimensions do not match");
    expect(validateGeneratedImage(fakePng(1_024, 512))).toMatchObject({
      width: 1_024,
      height: 512,
    });
  });
});

describe("POST /v1/generate", () => {
  it("returns validated raw image bytes and metadata without exposing the parent prompt", async () => {
    const ai = {
      run: vi.fn(async (model: string, _inputs: unknown) =>
        model === "@cf/meta/llama-guard-3-8b"
          ? { response: "safe" }
          : { image: base64(fakePng()) },
      ),
    };
    const response = await worker.fetch(
      postGenerate({ model: "flux-schnell", prompt: "an original copper forest compass" }),
      mockEnv({ AI: ai }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Length")).toBe("1024");
    expect(response.headers.get("Content-Disposition")).toMatch(/^inline; filename="diywc-medal-/u);
    expect(response.headers.get("X-DIYWC-Asset-Kind")).toBe("medal");
    expect(response.headers.get("X-DIYWC-Model")).toBe("flux-schnell");
    expect(response.headers.get("X-DIYWC-Model-Attempts-Used")).toBe("1");
    expect(response.headers.get("X-DIYWC-Model-Attempts-Remaining")).toBe("2");
    expect(response.headers.get("X-DIYWC-Estimated-Neurons")).toBe(
      String(58 + estimateSafetyNeurons("an original copper forest compass")),
    );
    expect(response.headers.get("X-DIYWC-SHA256")).toMatch(/^[0-9a-f]{64}$/u);
    expect(response.headers.get("X-DIYWC-Report-Token")).toBeTruthy();
    expect((await response.arrayBuffer()).byteLength).toBe(1_024);
    expect(ai.run).toHaveBeenCalledTimes(2);
    const [safetyModel, safetyInputs] = ai.run.mock.calls[0];
    expect(safetyModel).toBe("@cf/meta/llama-guard-3-8b");
    expect(safetyInputs).toMatchObject({
      messages: [{ role: "user", content: "an original copper forest compass" }],
      max_tokens: 32,
      temperature: 0,
    });
    const [modelId, inputs] = ai.run.mock.calls[1];
    expect(modelId).toBe("@cf/black-forest-labs/flux-1-schnell");
    expect((inputs as { prompt: string }).prompt).toContain(
      "Create an elaborate premium collectible challenge medal themed around: an original copper forest compass",
    );
  });

  it.each([
    [
      "milestone_banner",
      MILESTONE_BANNER_WIDTH,
      MILESTONE_BANNER_HEIGHT,
      53,
      "Create an original wide milestone story banner themed around:",
      "milestone-banner",
    ],
    [
      "route_map",
      ROUTE_MAP_WIDTH,
      ROUTE_MAP_HEIGHT,
      105,
      "Create an original decorative illustrated route-map background themed around:",
      "route-map",
    ],
  ] as const)(
    "generates an exact %s with its fixed prompt, dimensions, cost, and metadata",
    async (assetKind, width, height, baseNeurons, promptPrefix, filenameKind) => {
      const ai = {
        run: vi.fn(async (model: string, _inputs: unknown) =>
          model === "@cf/meta/llama-guard-3-8b"
            ? { response: "safe" }
            : { image: base64(fakePng(width, height)) },
        ),
      };
      const theme = "moonlit waterfall and pine forest";
      const response = await worker.fetch(
        postGenerate({ model: "flux2-klein-4b", assetKind, prompt: theme }),
        mockEnv({ AI: ai }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("X-DIYWC-Asset-Kind")).toBe(assetKind);
      expect(response.headers.get("X-DIYWC-Width")).toBe(String(width));
      expect(response.headers.get("X-DIYWC-Height")).toBe(String(height));
      expect(response.headers.get("X-DIYWC-Estimated-Neurons")).toBe(
        String(baseNeurons + estimateSafetyNeurons(theme)),
      );
      expect(response.headers.get("Content-Disposition")).toMatch(
        new RegExp(`^inline; filename="diywc-${filenameKind}-`, "u"),
      );
      const [, inputs] = ai.run.mock.calls[1];
      const multipart = inputs as {
        multipart: { body: ReadableStream<Uint8Array>; contentType: string };
      };
      const form = await new Response(multipart.multipart.body, {
        headers: { "Content-Type": multipart.multipart.contentType },
      }).formData();
      expect(form.get("width")).toBe(String(width));
      expect(form.get("height")).toBe(String(height));
      expect(String(form.get("prompt")).replaceAll("\r\n", "\n")).toBe(
        buildAssetPrompt(assetKind, theme),
      );
      expect(String(form.get("prompt"))).toContain(promptPrefix);
    },
  );

  it("rejects unsupported or unknown artwork types before safety and image inference", async () => {
    const env = mockEnv();
    const unsupported = await worker.fetch(
      postGenerate({
        model: "flux-schnell",
        assetKind: "milestone_banner",
        prompt: "forest overlook",
      }),
      env,
    );
    expect(unsupported.status).toBe(400);
    await expect(unsupported.json()).resolves.toMatchObject({
      error: { code: "model_unavailable" },
    });

    const unknown = await worker.fetch(
      postGenerate({ model: "flux2-klein-4b", assetKind: "poster", prompt: "forest" }),
      env,
    );
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });

    const wrongType = await worker.fetch(
      postGenerate({ model: "flux2-klein-4b", assetKind: 7, prompt: "forest" }),
      env,
    );
    expect(wrongType.status).toBe(400);
    await expect(wrongType.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("fails closed when controlled artwork output has the wrong dimensions", async () => {
    const ai = {
      run: vi.fn(async (model: string) =>
        model === "@cf/meta/llama-guard-3-8b"
          ? { response: "safe" }
          : { image: base64(fakePng(512, 512)) },
      ),
    };
    const response = await worker.fetch(
      postGenerate({
        model: "flux2-klein-4b",
        assetKind: "milestone_banner",
        prompt: "forest overlook",
      }),
      mockEnv({ AI: ai }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "model_invalid_output", retryable: true },
    });
    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it("retains bounded provider-controlled output for legacy Schnell medals", async () => {
    const ai = {
      run: vi.fn(async (model: string) =>
        model === "@cf/meta/llama-guard-3-8b"
          ? { response: "safe" }
          : { image: base64(fakePng(1_024, 512)) },
      ),
    };
    const response = await worker.fetch(
      postGenerate({ model: "flux-schnell", prompt: "forest compass" }),
      mockEnv({ AI: ai }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-DIYWC-Width")).toBe("1024");
    expect(response.headers.get("X-DIYWC-Height")).toBe("512");
  });

  it("returns a safe mapped provider error even when diagnostic persistence fails", async () => {
    const rawMessage = "No more data centers; internal tenant secret";
    const prompt = "private sentinel forest medal";
    const ai = {
      run: vi.fn(async (model: string) => {
        if (model === "@cf/meta/llama-guard-3-8b") return { response: "safe" };
        throw { cause: { error: { internalCode: 3040, message: rawMessage } } };
      }),
    };
    const db = mockDatabase({ diagnosticPersistenceFailure: true });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await worker.fetch(
      postGenerate({ model: "flux-schnell", prompt }),
      mockEnv({ AI: ai, QUOTA_DB: db }),
    );
    const responseText = await response.text();
    const body = JSON.parse(responseText) as {
      error: { code: string; message: string; retryable: boolean; requestId: string };
    };

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(body.error).toMatchObject({
      code: "model_busy",
      message: "The image model is busy right now. Try again shortly or upload your own artwork.",
      retryable: true,
    });
    expect(responseText).not.toContain(rawMessage);
    expect(body.error).not.toHaveProperty("providerCode");
    const serializedLogs = JSON.stringify(consoleError.mock.calls);
    expect(serializedLogs).toContain(body.error.requestId);
    expect(serializedLogs).toContain('"providerCode":"3040"');
    expect(serializedLogs).not.toContain(rawMessage);
    expect(serializedLogs).not.toContain(prompt);
    expect(serializedLogs).not.toContain(INSTALLATION_ID);
    expect(serializedLogs).not.toContain("@cf/black-forest-labs/flux-1-schnell");
    expect(db.batch).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it("fails closed when Llama Guard marks a prompt unsafe", async () => {
    const ai = {
      run: vi.fn(async (model: string) =>
        model === "@cf/meta/llama-guard-3-8b"
          ? { response: "unsafe\nS12" }
          : { image: base64(fakePng()) },
      ),
    };
    const response = await worker.fetch(
      postGenerate({ model: "flux-schnell", prompt: "a disallowed request" }),
      mockEnv({ AI: ai }),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "content_rejected", retryable: false },
    });
    expect(ai.run).toHaveBeenCalledOnce();
  });

  it("accepts Cloudflare's structured safe classifier response", async () => {
    const ai = {
      run: vi.fn(async (model: string) =>
        model === "@cf/meta/llama-guard-3-8b"
          ? { response: { safe: true, categories: [] } }
          : { image: base64(fakePng()) },
      ),
    };
    const response = await worker.fetch(
      postGenerate({ model: "flux-schnell", prompt: "an original flower medal" }),
      mockEnv({ AI: ai }),
    );
    expect(response.status).toBe(200);
    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it("rejects Cloudflare's structured unsafe classifier response", async () => {
    const ai = {
      run: vi.fn(async (model: string) =>
        model === "@cf/meta/llama-guard-3-8b"
          ? { response: { safe: false, categories: ["S12"] } }
          : { image: base64(fakePng()) },
      ),
    };
    const response = await worker.fetch(
      postGenerate({ model: "flux-schnell", prompt: "a blocked request" }),
      mockEnv({ AI: ai }),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "content_rejected", retryable: false },
    });
    expect(ai.run).toHaveBeenCalledOnce();
  });

  it("fails closed without image inference when the safety classifier is unavailable", async () => {
    const ai = { run: vi.fn(async () => ({ unexpected: true })) };
    const response = await worker.fetch(
      postGenerate({ model: "flux-schnell", prompt: "an ordinary flower medal" }),
      mockEnv({ AI: ai }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "service_unavailable", retryable: true },
    });
    expect(ai.run).toHaveBeenCalledOnce();
  });

  it("rejects disabled model IDs instead of accepting arbitrary Workers AI IDs", async () => {
    const response = await worker.fetch(
      postGenerate({ model: "@cf/anything/dangerous", prompt: "a medal" }),
      mockEnv(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "model_unavailable", retryable: false },
    });
  });

  it("requires rights confirmation and a reference-capable model", async () => {
    const reference = {
      mimeType: "image/png",
      dataBase64: base64(fakePng(512, 512, 100)),
      rightsConfirmed: false,
    };
    const response = await worker.fetch(
      postGenerate({ model: "flux2-klein-4b", prompt: "a medal", reference }),
      mockEnv(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
  });

  it("enforces the reviewed Klein reference dimensions before inference", async () => {
    const oversizedReference = {
      mimeType: "image/png",
      dataBase64: base64(fakePng(513, 512, 100)),
      rightsConfirmed: true,
    };
    const oversizedEnv = mockEnv();
    const rejected = await worker.fetch(
      postGenerate({
        model: "flux2-klein-4b",
        assetKind: "route_map",
        prompt: "forest trail",
        reference: oversizedReference,
      }),
      oversizedEnv,
    );
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      error: {
        code: "invalid_request",
        message: "Reference image dimensions must be no larger than 512 by 512 pixels",
      },
    });
    expect(oversizedEnv.AI.run).not.toHaveBeenCalled();

    const acceptedReference = {
      ...oversizedReference,
      dataBase64: base64(fakePng(512, 512, 100)),
    };
    const accepted = await worker.fetch(
      postGenerate({
        model: "flux2-klein-4b",
        prompt: "forest trail",
        reference: acceptedReference,
      }),
      mockEnv(),
    );
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("X-DIYWC-Estimated-Neurons")).toBe(
      String(32 + estimateSafetyNeurons("forest trail")),
    );
  });

  it("returns 429 when the fast installation limiter refuses the request", async () => {
    const response = await worker.fetch(
      postGenerate({ model: "flux-schnell", prompt: "a medal" }),
      mockEnv({ INSTALL_RATE_LIMITER: { limit: vi.fn(async () => ({ success: false })) } }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "rate_limited" } });
  });

  it("fails closed with a clear 503 when the global daily cap is exhausted", async () => {
    const response = await worker.fetch(
      postGenerate({ model: "flux-schnell", prompt: "a medal" }),
      mockEnv({}, { globalBudgetExhausted: true }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "daily_quota_exhausted", retryable: true },
    });
  });

  it("returns a distinct daily-limit error after three attempts for this model", async () => {
    const response = await worker.fetch(
      postGenerate({ model: "flux2-klein-4b", prompt: "a medal" }),
      mockEnv({}, { modelAttemptsExhausted: true }),
    );
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "model_daily_limit_reached", retryable: true },
    });
  });

  it("denies browser origins unless explicitly allowlisted", async () => {
    const response = await worker.fetch(
      postGenerate(
        { model: "flux-schnell", prompt: "a medal" },
        { Origin: "https://untrusted.example" },
      ),
      mockEnv(),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "origin_not_allowed" } });
  });

  it("exposes artwork metadata to an explicitly allowed browser origin", async () => {
    const origin = "https://app.example";
    const response = await worker.fetch(
      postGenerate(
        { model: "flux-schnell", prompt: "forest medal" },
        { Origin: origin },
      ),
      mockEnv({ ALLOWED_ORIGINS: origin }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain(
      "X-DIYWC-Asset-Kind",
    );
    expect(response.headers.get("X-DIYWC-Asset-Kind")).toBe("medal");
  });
});

describe("generated image reports", () => {
  it("binds the report token to both request and installation", async () => {
    const token = await createReportToken("73582ff2-4c07-4f17-99a7-38bcf0941e09", "install-a", REPORT_SECRET);
    expect(
      await verifyReportToken(
        {
          requestId: "73582ff2-4c07-4f17-99a7-38bcf0941e09",
          reportToken: token,
          reason: "other",
        },
        "install-a",
        REPORT_SECRET,
      ),
    ).toBe(true);
    expect(
      await verifyReportToken(
        {
          requestId: "73582ff2-4c07-4f17-99a7-38bcf0941e09",
          reportToken: token,
          reason: "other",
        },
        "install-b",
        REPORT_SECRET,
      ),
    ).toBe(false);
  });

  it("accepts an authenticated report without storing the image or prompt", async () => {
    const env = mockEnv();
    const generated = await worker.fetch(
      postGenerate({ model: "flux-schnell", prompt: "a medal" }),
      env,
    );
    const requestId = generated.headers.get("X-DIYWC-Request-ID")!;
    const reportToken = generated.headers.get("X-DIYWC-Report-Token")!;
    const report = new Request("https://medals.example/v1/report", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-DIYWC-Installation-ID": INSTALLATION_ID,
      },
      body: JSON.stringify({
        requestId,
        reportToken,
        reason: "copyright_or_trademark",
        details: "Looks too close to an existing product",
      }),
    });
    const response = await worker.fetch(report, env);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ accepted: true });
  });
});
