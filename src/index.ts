import { beginGeneration, cancelGeneration, finishGeneration, readArtworkAllowance, readGeneration,
  setGenerationReservation, startGenerationStage, FREE_FAILED_GENERATION_NEURONS, type ArtworkAllowance } from "./generation-accounting";
import { ImageValidationError, sha256Hex, validateGeneratedImage, validateReferenceImage } from "./images";
import { recordProviderFailureDiagnostic } from "./failure-diagnostics";
import {
  enabledModelSpecs,
  findEnabledModel,
  findModelAssetSpec,
  MODEL_REFERENCE_MAX_EDGE,
  runImageModel,
} from "./models";
import {
  buildAssetPrompt,
  countCodePoints,
  DEFAULT_ASSET_KIND,
  isAssetKind,
  MAX_USER_PROMPT_CODE_POINTS,
  MIN_USER_PROMPT_CODE_POINTS,
  sanitizeUserPrompt,
} from "./prompt";
import { classifyCloudflareAiError } from "./provider-errors";
import {
  ARTWORK_SLOT_DAILY_ATTEMPT_LIMIT,
  INSTALLATION_DAILY_ATTEMPT_LIMIT,
  parseBooleanFlag,
  parsePositiveLimit,
  readGlobalNeuronBudget,
  readInstallationAttemptCount,
  pruneExpiredDailyQuota,
  reserveGenerationBudget,
  secondsUntilNextUtcDay,
} from "./quota";
import { createReportToken, parseReport, saveReport, verifyReportToken } from "./reports";
import {
  assertPromptSafe,
  DEFAULT_SAFETY_MODEL,
  estimateSafetyNeurons,
  SafetyServiceError,
  UnsafePromptError,
} from "./safety";
import type { Env, ParsedGenerationRequest, ReferenceImage } from "./types";

const API_VERSION = 1;
const GENERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_GENERATE_BODY_BYTES = 3 * 1024 * 1024;
const MAX_REPORT_BODY_BYTES = 8 * 1024;
const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;
const MAX_REFERENCE_BASE64_CHARACTERS = Math.ceil(MAX_REFERENCE_BYTES / 3) * 4 + 4;
const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9._-]{20,80}$/u;
const ARTWORK_SLOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/u;

type ErrorCode =
  | "generation_canceled"
  | "generation_already_submitted"
  | "content_rejected"
  | "daily_quota_exhausted"
  | "invalid_prompt"
  | "invalid_report_token"
  | "invalid_request"
  | "method_not_allowed"
  | "model_busy"
  | "model_configuration_error"
  | "artwork_slot_daily_limit_reached"
  | "installation_daily_limit_reached"
  | "model_invalid_output"
  | "model_timeout"
  | "model_unavailable"
  | "not_found"
  | "origin_not_allowed"
  | "rate_limited"
  | "service_unavailable"
  | "workers_ai_quota_exhausted";

type NeuronQuotaDetails = {
  requested: number;
  used: number;
  remaining: number;
};

class ApiError extends Error {
  artworkAllowance?: ArtworkAllowance;
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
    readonly neuronQuota?: NeuronQuotaDetails,
  ) {
    super(message);
  }
}

function securityHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-DIYWC-API-Version": String(API_VERSION),
  });
}

function parseAllowedOrigins(config: string | undefined): Set<string> {
  return new Set(
    (config ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value && value !== "*"),
  );
}

function acceptedCorsOrigin(request: Request, env: Env): string | undefined {
  const origin = request.headers.get("Origin");
  if (!origin) return undefined;
  if (!parseAllowedOrigins(env.ALLOWED_ORIGINS).has(origin)) {
    throw new ApiError(403, "origin_not_allowed", "This browser origin is not allowed");
  }
  return origin;
}

function addCorsHeaders(headers: Headers, origin: string | undefined): void {
  if (!origin) return;
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type,X-DIYWC-Installation-ID",
  );
  headers.set(
    "Access-Control-Expose-Headers",
    [
      "Content-Length",
      "Retry-After",
      "X-DIYWC-Estimated-Neurons",
      "X-DIYWC-Asset-Kind",
      "X-DIYWC-Artwork-Slot-Attempts-Remaining",
      "X-DIYWC-Artwork-Slot-Attempts-Used",
      "X-DIYWC-Global-Estimated-Neurons-Remaining",
      "X-DIYWC-Global-Estimated-Neurons-Used",
      "X-DIYWC-Height",
      "X-DIYWC-Installation-Attempts-Remaining",
      "X-DIYWC-Installation-Attempts-Used",
      "X-DIYWC-Model",
      "X-DIYWC-Model-Attempts-Remaining",
      "X-DIYWC-Model-Attempts-Used",
      "X-DIYWC-Report-Token",
      "X-DIYWC-Request-ID",
      "X-DIYWC-SHA256",
      "X-DIYWC-Width",
    ].join(","),
  );
  headers.append("Vary", "Origin");
}

function jsonResponse(
  value: unknown,
  status: number,
  origin: string | undefined,
  extraHeaders?: HeadersInit,
): Response {
  const headers = securityHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  addCorsHeaders(headers, origin);
  return new Response(JSON.stringify(value), { status, headers });
}

const LANDING_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>DIY Walking Challenges · Artwork Generator</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #f8f4e7;
      background: radial-gradient(circle at top, #244b37 0, #101914 44%, #090d0b 100%); }
    main { width: min(620px, 100%); padding: clamp(28px, 7vw, 54px); text-align: center; border: 1px solid #6d765f;
      border-radius: 28px; background: rgba(17, 27, 22, .94); box-shadow: 0 28px 80px #0009, inset 0 0 0 1px #dcb45c22; }
    .mark { width: 76px; height: 76px; margin: 0 auto 24px; display: grid; place-items: center; border-radius: 24px;
      color: #1b241d; background: linear-gradient(145deg, #f2ca72, #b98535); font-size: 38px; box-shadow: 0 12px 36px #0008; }
    .eyebrow { margin: 0 0 10px; color: #edc46c; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; font-size: .78rem; }
    h1 { margin: 0; font-size: clamp(2rem, 7vw, 3.6rem); line-height: 1.02; }
    .status { display: inline-flex; align-items: center; gap: 9px; margin: 26px 0 18px; padding: 9px 15px; border-radius: 999px;
      color: #d9f6df; background: #1d3d2b; font-weight: 750; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #70db8d; box-shadow: 0 0 14px #70db8d; }
    p { color: #cbd2cb; line-height: 1.65; }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">✦</div>
    <p class="eyebrow">DIY Walking Challenges</p>
    <h1>Artwork generator is online</h1>
    <div class="status"><span class="dot" aria-hidden="true"></span>Service online · API v${API_VERSION}</div>
    <p>This service powers optional AI artwork for completion medals, milestone banners, and route maps in the DIY Walking Challenges Android app. You do not need to configure anything on this page.</p>
  </main>
</body>
</html>`;

function landingPageResponse(method: string, origin: string | undefined): Response {
  const headers = securityHeaders();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  addCorsHeaders(headers, origin);
  return new Response(method === "HEAD" ? null : LANDING_PAGE_HTML, { status: 200, headers });
}

function redirectToCanonicalModels(url: URL, origin: string | undefined): Response {
  const headers = securityHeaders();
  headers.set("Location", new URL("/v1/models", url).toString());
  addCorsHeaders(headers, origin);
  return new Response(null, { status: 308, headers });
}

function errorResponse(error: ApiError, requestId: string, origin: string | undefined): Response {
  const extra = new Headers();
  if (error.retryAfterSeconds !== undefined) {
    extra.set("Retry-After", String(error.retryAfterSeconds));
  }
  if (error.neuronQuota) {
    extra.set("X-DIYWC-Estimated-Neurons", String(error.neuronQuota.requested));
    extra.set("X-DIYWC-Global-Estimated-Neurons-Used", String(error.neuronQuota.used));
    extra.set("X-DIYWC-Global-Estimated-Neurons-Remaining", String(error.neuronQuota.remaining));
  }
  return jsonResponse(
    {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        requestId,
        ...(error.artworkAllowance ? { artworkAllowance: error.artworkAllowance } : {}),
        ...(error.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: error.retryAfterSeconds }),
        ...(error.neuronQuota === undefined
          ? {}
          : {
              requestedNeurons: error.neuronQuota.requested,
              usedNeurons: error.neuronQuota.used,
              remainingNeurons: error.neuronQuota.remaining,
            }),
      },
    },
    error.status,
    origin,
    extra,
  );
}

function requireSecret(value: string | undefined): string {
  if (!value || value.length < 32) {
    throw new ApiError(
      503,
      "service_unavailable",
      "Image generation is not configured. You can still upload your own artwork.",
      true,
    );
  }
  return value;
}

function requireInstallationId(request: Request): string {
  const value = request.headers.get("X-DIYWC-Installation-ID") ?? "";
  if (!INSTALLATION_ID_PATTERN.test(value)) {
    throw new ApiError(400, "invalid_request", "A valid app installation ID is required");
  }
  return value;
}

async function hashRateLimitKey(kind: string, value: string, pepper: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${pepper}\n${kind}\n${value}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJsonBody(request: Request, maximumBytes: number): Promise<unknown> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "invalid_request", "Content-Type must be application/json");
  }
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ApiError(413, "invalid_request", "Request body is too large");
  }
  const body = await request.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > maximumBytes) {
    throw new ApiError(413, "invalid_request", "Request body is empty or too large");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, "invalid_request", "Request body is not valid JSON");
  }
}

function decodeReference(value: unknown): ReferenceImage {
  if (typeof value !== "object" || value === null) {
    throw new ApiError(400, "invalid_request", "Reference image must be an object");
  }
  const reference = value as Record<string, unknown>;
  if (reference.rightsConfirmed !== true) {
    throw new ApiError(
      400,
      "invalid_request",
      "Confirm that you own or have permission to use the reference image",
    );
  }
  const mimeType = reference.mimeType;
  if (mimeType !== "image/jpeg" && mimeType !== "image/png" && mimeType !== "image/webp") {
    throw new ApiError(400, "invalid_request", "Reference image must be JPEG, PNG, or WebP");
  }
  if (
    typeof reference.dataBase64 !== "string" ||
    reference.dataBase64.length === 0 ||
    reference.dataBase64.length > MAX_REFERENCE_BASE64_CHARACTERS ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(reference.dataBase64)
  ) {
    throw new ApiError(400, "invalid_request", "Reference image data is invalid or too large");
  }
  let binary: string;
  try {
    binary = atob(reference.dataBase64);
  } catch {
    throw new ApiError(400, "invalid_request", "Reference image is not valid Base64 data");
  }
  if (binary.length === 0 || binary.length > MAX_REFERENCE_BYTES) {
    throw new ApiError(400, "invalid_request", "Reference image must be no larger than 2 MiB");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  let image;
  try {
    image = validateReferenceImage(bytes, mimeType);
  } catch (error) {
    if (error instanceof ImageValidationError) {
      throw new ApiError(400, "invalid_request", error.message);
    }
    throw error;
  }
  return { mimeType, bytes, width: image.width, height: image.height };
}

function parseGenerationRequest(body: unknown, enabledConfig: string | undefined): ParsedGenerationRequest {
  if (typeof body !== "object" || body === null) {
    throw new ApiError(400, "invalid_request", "Request body must be an object");
  }
  const value = body as Record<string, unknown>;
  if (value.generationId !== undefined && (typeof value.generationId !== "string" || !GENERATION_ID_PATTERN.test(value.generationId))) {
    throw new ApiError(400, "invalid_request", "A valid generation ID is required");
  }
  const assetKindValue = value.assetKind ?? DEFAULT_ASSET_KIND;
  if (!isAssetKind(assetKindValue)) {
    throw new ApiError(400, "invalid_request", "That artwork type is not available");
  }
  const model = typeof value.model === "string"
    ? findEnabledModel(value.model, enabledConfig)
    : undefined;
  if (!model) {
    throw new ApiError(400, "model_unavailable", "That image model is not available");
  }
  if (!findModelAssetSpec(model, assetKindValue)) {
    throw new ApiError(
      400,
      "model_unavailable",
      "That image model is not available for the selected artwork type",
    );
  }
  let artworkSlotId: string | undefined;
  if (value.artworkSlotId !== undefined) {
    if (typeof value.artworkSlotId !== "string" || !ARTWORK_SLOT_ID_PATTERN.test(value.artworkSlotId)) {
      throw new ApiError(
        400,
        "invalid_request",
        "Artwork slot ID must be 8–160 letters, numbers, periods, underscores, colons, or hyphens",
      );
    }
    artworkSlotId = value.artworkSlotId;
  }
  if (typeof value.prompt !== "string") {
    throw new ApiError(400, "invalid_prompt", "Describe the artwork you want to create");
  }
  const userPrompt = sanitizeUserPrompt(value.prompt);
  const length = countCodePoints(userPrompt);
  if (length < MIN_USER_PROMPT_CODE_POINTS || length > MAX_USER_PROMPT_CODE_POINTS) {
    throw new ApiError(
      400,
      "invalid_prompt",
      `Artwork theme must be between ${MIN_USER_PROMPT_CODE_POINTS} and ${MAX_USER_PROMPT_CODE_POINTS} characters`,
    );
  }
  let seed: number | undefined;
  if (value.seed !== undefined) {
    if (!Number.isSafeInteger(value.seed) || Number(value.seed) < 0 || Number(value.seed) > 2_147_483_647) {
      throw new ApiError(400, "invalid_request", "Seed must be a positive 32-bit integer");
    }
    seed = Number(value.seed);
  }
  const reference = value.reference === undefined ? undefined : decodeReference(value.reference);
  if (reference && !model.supportsReference) {
    throw new ApiError(400, "invalid_request", "The selected model does not support reference images");
  }
  if (
    reference &&
    (reference.width > MODEL_REFERENCE_MAX_EDGE || reference.height > MODEL_REFERENCE_MAX_EDGE)
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      `Reference image dimensions must be no larger than ${MODEL_REFERENCE_MAX_EDGE} by ${MODEL_REFERENCE_MAX_EDGE} pixels`,
    );
  }
  return {
    assetKind: assetKindValue,
    generationId: value.generationId as string | undefined,
    ...(artworkSlotId ? { artworkSlotId } : {}),
    model: value.model as string,
    userPrompt,
    ...(seed === undefined ? {} : { seed }),
    ...(reference ? { reference } : {}),
  };
}

async function applyGenerationBurstLimits(
  request: Request,
  env: Env,
  installationId: string,
  pepper: string,
): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) throw new ApiError(400, "invalid_request", "Client network information is unavailable");
  const [installationHash, ipHash] = await Promise.all([
    hashRateLimitKey("installation", installationId, pepper),
    hashRateLimitKey("ip", ip, pepper),
  ]);
  let limits: [{ success: boolean }, { success: boolean }];
  try {
    limits = await Promise.all([
      env.INSTALL_RATE_LIMITER.limit({ key: installationHash }),
      env.IP_RATE_LIMITER.limit({ key: ipHash }),
    ]);
  } catch {
    throw new ApiError(
      503,
      "service_unavailable",
      "Image generation is temporarily unavailable. You can still upload your own artwork.",
      true,
      60,
    );
  }
  if (!limits[0].success || !limits[1].success) {
    throw new ApiError(429, "rate_limited", "Please wait a minute before generating another image", true, 60);
  }
  return installationHash;
}

async function handleQuota(request: Request, env: Env, origin: string | undefined): Promise<Response> {
  const pepper = requireSecret(env.RATE_LIMIT_HASH_PEPPER);
  const installationId = requireInstallationId(request);
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) throw new ApiError(400, "invalid_request", "Client network information is unavailable");
  // Separate keys keep read-only checks from consuming generation/report burst allowances.
  const quotaKey = await hashRateLimitKey("quota-status-ip", ip, pepper);
  if (!(await env.REPORT_RATE_LIMITER.limit({ key: quotaKey })).success) {
    throw new ApiError(429, "rate_limited", "Please wait a minute before checking the allowance again", true, 60);
  }
  const installationHash = await hashRateLimitKey("installation", installationId, pepper);
  const instant = new Date();
  const day = instant.toISOString().slice(0, 10);
  const total = parsePositiveLimit(env.DAILY_GLOBAL_NEURON_BUDGET, 10_000);
  const enforced = parseBooleanFlag(env.ENFORCE_INSTALLATION_DAILY_CAPS, true);
  const [neurons, attempts] = await Promise.all([
    readGlobalNeuronBudget(env.QUOTA_DB, day, total),
    enforced ? readInstallationAttemptCount(env.QUOTA_DB, day, installationHash) : Promise.resolve(null),
  ]);
  const query = new URL(request.url).searchParams;
  let artworkAllowance: ArtworkAllowance | undefined;
  if (enforced && query.has("artworkSlotId")) {
    const slotId = query.get("artworkSlotId") ?? "";
    const kind = query.get("assetKind");
    if (!ARTWORK_SLOT_ID_PATTERN.test(slotId) || !isAssetKind(kind)) {
      throw new ApiError(400, "invalid_request", "A valid artwork destination is required");
    }
    const slotHash = await hashRateLimitKey("artwork-slot", `${installationHash}\n${kind}\n${slotId}`, pepper);
    artworkAllowance = await readArtworkAllowance(env.QUOTA_DB, day, installationHash, slotHash);
  }
  return jsonResponse({
    apiVersion: API_VERSION,
    resetsAtEpochMillis: Date.parse(`${day}T00:00:00Z`) + 86_400_000,
    sharedNeurons: { total, used: neurons.used, remaining: neurons.remaining, estimated: true },
    ...(artworkAllowance ? { artworkAllowance } : {}),
    ...(attempts !== null ? { installation: {
      total: INSTALLATION_DAILY_ATTEMPT_LIMIT,
      remaining: Math.max(0, INSTALLATION_DAILY_ATTEMPT_LIMIT - attempts),
    } } : {}),
  }, 200, origin);
}

async function handleGenerate(
  request: Request,
  env: Env,
  requestId: string,
  origin: string | undefined,
): Promise<Response> {
  const pepper = requireSecret(env.RATE_LIMIT_HASH_PEPPER);
  const reportSecret = requireSecret(env.REPORT_TOKEN_SECRET);
  const installationId = requireInstallationId(request);
  const installationHash = await applyGenerationBurstLimits(request, env, installationId, pepper);
  const body = await readJsonBody(request, MAX_GENERATE_BODY_BYTES);
  const parsed = parseGenerationRequest(body, env.ENABLED_MODELS);
  const model = findEnabledModel(parsed.model, env.ENABLED_MODELS);
  if (!model) throw new ApiError(400, "model_unavailable", "That image model is not available");
  const asset = findModelAssetSpec(model, parsed.assetKind);
  if (!asset) {
    throw new ApiError(
      400,
      "model_unavailable",
      "That image model is not available for the selected artwork type",
    );
  }

  const safetyNeurons = estimateSafetyNeurons(parsed.userPrompt);
  const estimatedNeurons = safetyNeurons + model.estimateImageNeurons(asset, parsed.reference);
  const globalNeuronBudget = parsePositiveLimit(env.DAILY_GLOBAL_NEURON_BUDGET, 10_000);
  const enforceInstallationDailyCaps = parseBooleanFlag(
    env.ENFORCE_INSTALLATION_DAILY_CAPS,
    true,
  );
  // Older app builds omit artworkSlotId. They share one conservative legacy
  // slot per artwork kind instead of receiving an accidental quota bypass.
  const artworkSlotHash = await hashRateLimitKey(
    "artwork-slot",
    `${installationHash}\n${parsed.assetKind}\n${parsed.artworkSlotId ?? `legacy:${parsed.assetKind}`}`,
    pepper,
  );
  const instant = new Date();
  const key = { installationHash, generationId: parsed.generationId ?? requestId };
  if (!(await beginGeneration(env.QUOTA_DB, key, requestId, artworkSlotHash, instant))) {
    const old = await readGeneration(env.QUOTA_DB, key);
    throw new ApiError(409, old?.cancel_requested ? "generation_canceled" : "generation_already_submitted",
      old?.cancel_requested ? "Generation canceled." : "This generation request has already been submitted.");
  }
  let reservedNeurons = 0;
  const retryAfter = secondsUntilNextUtcDay(instant);
  try {
    let reservation: Awaited<ReturnType<typeof reserveGenerationBudget>>;
    try {
      reservation = await reserveGenerationBudget(
        env.QUOTA_DB,
        {
          installationHash,
          artworkSlotHash,
          reservationId: requestId,
          assetKind: parsed.assetKind,
          estimatedNeurons,
          globalNeuronBudget,
          enforceInstallationDailyCaps,
          instant,
        },
      );
    } catch {
      throw new ApiError(
        503,
        "service_unavailable",
        "Image generation is temporarily unavailable. You can still upload your own artwork.",
        true,
        60,
      );
    }
    if (reservation.result === "installation_exhausted") {
      throw new ApiError(
        429,
        "installation_daily_limit_reached",
        `This app installation has used today's ${INSTALLATION_DAILY_ATTEMPT_LIMIT} shared-server image attempts. Try again after the 00:00 UTC daily reset, use a private image server, or upload your own artwork.`,
        true,
        retryAfter,
      );
    }
    if (reservation.result === "artwork_slot_exhausted") {
      throw new ApiError(
        429,
        "artwork_slot_daily_limit_reached",
        "This artwork already used its shared-server generation attempt today. Try again after the 00:00 UTC daily reset, use a private image server, or upload your own artwork.",
        true,
        retryAfter,
      );
    }
    if (reservation.result === "global_exhausted") {
      const quota = {
        requested: reservation.estimatedNeurons,
        used: reservation.globalNeurons.used,
        remaining: reservation.globalNeurons.remaining,
      };
      throw new ApiError(
        503,
        "daily_quota_exhausted",
        `Today's shared server allowance has ${quota.remaining} estimated Neurons left, but this image needs ${quota.requested}. Try again after the 00:00 UTC daily reset or upload your own artwork.`,
        true,
        retryAfter,
        quota,
      );
    }

    reservedNeurons = reservation.estimatedNeurons;
    await setGenerationReservation(env.QUOTA_DB, key, reservedNeurons);
    const trackedAi = {
      async run(modelId: string, inputs: unknown): Promise<unknown> {
        const neurons = modelId === model.cloudflareId ? model.estimateImageNeurons(asset, parsed.reference) : safetyNeurons;
        if (!(await startGenerationStage(env.QUOTA_DB, key, neurons))) {
          throw new ApiError(409, "generation_canceled", "Generation canceled.");
        }
        return env.AI.run(modelId, inputs);
      },
    };
    try {
      if (!(await startGenerationStage(env.QUOTA_DB, key, 0))) throw new ApiError(409, "generation_canceled", "Generation canceled.");
      await assertPromptSafe(trackedAi, parsed.userPrompt, env.SAFETY_MODEL);
    } catch (error) {
      if (error instanceof UnsafePromptError) {
        throw new ApiError(
          422,
          "content_rejected",
          "That description cannot be used for image generation. Try a different, family-friendly idea.",
        );
      }
      if (error instanceof SafetyServiceError) {
        throw new ApiError(
          503,
          "service_unavailable",
          "Safety screening is temporarily unavailable. You can still upload your own artwork.",
          true,
          120,
        );
      }
      throw error;
    }

    let bytes: Uint8Array;
    try {
      bytes = await runImageModel(
        trackedAi,
        model,
        asset,
        buildAssetPrompt(parsed.assetKind, parsed.userPrompt),
        parsed.seed,
        parsed.reference,
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === "generation_canceled") throw error;
      const failure = classifyCloudflareAiError(error, retryAfter);
      await recordProviderFailureDiagnostic(env.QUOTA_DB, {
        requestId,
        modelAlias: model.alias,
        assetKind: parsed.assetKind,
        providerCode: failure.providerCode,
        category: failure.category,
      });
      throw new ApiError(
        failure.api.status,
        failure.api.code,
        failure.api.message,
        failure.api.retryable,
        failure.api.retryAfterSeconds,
      );
    }
    let image;
    try {
      image = validateGeneratedImage(
        bytes,
        asset.output.providerControlled ? undefined : asset.output,
      );
    } catch {
      await recordProviderFailureDiagnostic(env.QUOTA_DB, {
        requestId,
        modelAlias: model.alias,
        assetKind: parsed.assetKind,
        providerCode: "unknown",
        category: "invalid_output",
      });
      throw new ApiError(
        503,
        "model_invalid_output",
        "The image model returned an unusable image. Try again or upload your own artwork.",
        true,
        120,
      );
    }
    const [sha, reportToken] = await Promise.all([
      sha256Hex(bytes),
      createReportToken(requestId, installationHash, reportSecret),
    ]);
    const settled = await finishGeneration(env.QUOTA_DB, key, "succeeded");
    if (settled?.status !== "succeeded") throw new ApiError(409, "generation_canceled", "Generation canceled.");
    const headers = securityHeaders();
    headers.set("Content-Type", image.mimeType);
    headers.set("Content-Length", String(bytes.byteLength));
    const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.split("/")[1];
    const filenameKind = parsed.assetKind.replaceAll("_", "-");
    headers.set("Content-Disposition", `inline; filename="diywc-${filenameKind}-${requestId}.${extension}"`);
    headers.set("X-DIYWC-Request-ID", requestId);
    headers.set("X-DIYWC-Asset-Kind", parsed.assetKind);
    headers.set("X-DIYWC-Report-Token", reportToken);
    headers.set("X-DIYWC-Model", model.alias);
    headers.set("X-DIYWC-SHA256", sha);
    headers.set("X-DIYWC-Width", String(image.width));
    headers.set("X-DIYWC-Height", String(image.height));
    if (reservation.installationAttempts && reservation.artworkSlotAttempts) {
      // The legacy names retain parser compatibility but now report the
      // across-model installation cap; the additive names are unambiguous.
      headers.set("X-DIYWC-Model-Attempts-Used", String(reservation.installationAttempts.used));
      headers.set("X-DIYWC-Model-Attempts-Remaining", String(reservation.installationAttempts.remaining));
      headers.set("X-DIYWC-Installation-Attempts-Used", String(reservation.installationAttempts.used));
      headers.set("X-DIYWC-Installation-Attempts-Remaining", String(reservation.installationAttempts.remaining));
      headers.set("X-DIYWC-Artwork-Slot-Attempts-Used", String(reservation.artworkSlotAttempts.used));
      headers.set("X-DIYWC-Artwork-Slot-Attempts-Remaining", String(reservation.artworkSlotAttempts.remaining));
    } else {
      // Old clients require these integer headers. In uncapped mode they are a
      // compatibility sentinel only; the catalog's enforcement flag is authoritative.
      headers.set("X-DIYWC-Model-Attempts-Used", "0");
      headers.set("X-DIYWC-Model-Attempts-Remaining", String(INSTALLATION_DAILY_ATTEMPT_LIMIT));
    }
    headers.set("X-DIYWC-Estimated-Neurons", String(reservation.estimatedNeurons));
    headers.set(
      "X-DIYWC-Global-Estimated-Neurons-Used",
      String(reservation.globalNeurons.used),
    );
    headers.set(
      "X-DIYWC-Global-Estimated-Neurons-Remaining",
      String(reservation.globalNeurons.remaining),
    );
    addCorsHeaders(headers, origin);
    const responseBody = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Response(responseBody, { status: 200, headers });
  } catch (error) {
    // A cancellation during reservation waits for its owner to publish the reservation before settling.
    await setGenerationReservation(env.QUOTA_DB, key, reservedNeurons);
    const finalAttempt = await finishGeneration(env.QUOTA_DB, key, "failed");
    const failure = finalAttempt?.status === "canceled" ? new ApiError(409, "generation_canceled", "Generation canceled.")
      : error instanceof ApiError ? error : new ApiError(503, "service_unavailable",
      "Image generation is temporarily unavailable. Try again shortly.", true, 60);
    if (enforceInstallationDailyCaps) {
      failure.artworkAllowance = await readArtworkAllowance(env.QUOTA_DB, instant.toISOString().slice(0, 10), installationHash, artworkSlotHash);
    }
    throw failure;
  }
}

async function handleCancel(request: Request, env: Env, origin: string | undefined): Promise<Response> {
  const pepper = requireSecret(env.RATE_LIMIT_HASH_PEPPER);
  const installationId = requireInstallationId(request);
  const installationHash = await hashRateLimitKey("installation", installationId, pepper);
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) throw new ApiError(400, "invalid_request", "Client network information is unavailable");
  const [cancelKey, cancelIpKey] = await Promise.all([
    hashRateLimitKey("cancel", installationId, pepper), hashRateLimitKey("cancel-ip", ip, pepper),
  ]);
  const allowed = await Promise.all([env.REPORT_RATE_LIMITER.limit({ key: cancelKey }), env.REPORT_RATE_LIMITER.limit({ key: cancelIpKey })]);
  if (allowed.some(result => !result.success)) {
    throw new ApiError(429, "rate_limited", "Please wait before checking cancellation again.", true, 60);
  }
  const body = await readJsonBody(request, MAX_REPORT_BODY_BYTES) as Record<string, unknown> | null;
  if (!body || typeof body.generationId !== "string" || !GENERATION_ID_PATTERN.test(body.generationId)) {
    throw new ApiError(400, "invalid_request", "A valid generation ID is required");
  }
  const attempt = await cancelGeneration(env.QUOTA_DB, { installationHash, generationId: body.generationId });
  const artworkAllowance = attempt?.artwork_slot_hash && parseBooleanFlag(env.ENFORCE_INSTALLATION_DAILY_CAPS, true)
    ? await readArtworkAllowance(env.QUOTA_DB, attempt.day_utc, installationHash, attempt.artwork_slot_hash) : undefined;
  return jsonResponse({ status: attempt?.status, ...(artworkAllowance ? { artworkAllowance } : {}) }, 200, origin);
}

async function handleReport(
  request: Request,
  env: Env,
  origin: string | undefined,
): Promise<Response> {
  const pepper = requireSecret(env.RATE_LIMIT_HASH_PEPPER);
  const reportSecret = requireSecret(env.REPORT_TOKEN_SECRET);
  const installationId = requireInstallationId(request);
  const installationHash = await hashRateLimitKey("installation", installationId, pepper);
  let allowed: { success: boolean };
  try {
    allowed = await env.REPORT_RATE_LIMITER.limit({ key: installationHash });
  } catch {
    throw new ApiError(503, "service_unavailable", "Reports are temporarily unavailable", true, 60);
  }
  if (!allowed.success) {
    throw new ApiError(429, "rate_limited", "Please wait before sending another report", true, 60);
  }
  let report;
  try {
    report = parseReport(await readJsonBody(request, MAX_REPORT_BODY_BYTES));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_request", error instanceof Error ? error.message : "Invalid report");
  }
  if (!(await verifyReportToken(report, installationHash, reportSecret))) {
    throw new ApiError(403, "invalid_report_token", "This image report cannot be verified");
  }
  let reportId: string;
  try {
    reportId = await saveReport(env.QUOTA_DB, report, installationHash);
  } catch {
    throw new ApiError(503, "service_unavailable", "Reports are temporarily unavailable", true, 60);
  }
  return jsonResponse({ accepted: true, reportId }, 202, origin);
}

async function dispatch(
  request: Request,
  env: Env,
  requestId: string,
  origin: string | undefined,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    if (!origin) throw new ApiError(403, "origin_not_allowed", "CORS is not enabled");
    const headers = securityHeaders();
    headers.set("Access-Control-Max-Age", "600");
    addCorsHeaders(headers, origin);
    return new Response(null, { status: 204, headers });
  }
  if (url.pathname === "/") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new ApiError(405, "method_not_allowed", "Method not allowed");
    }
    return landingPageResponse(request.method, origin);
  }
  if (url.pathname === "/model" || url.pathname === "/models") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new ApiError(405, "method_not_allowed", "Method not allowed");
    }
    return redirectToCanonicalModels(url, origin);
  }
  if (url.pathname === "/health") {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    return jsonResponse({ ok: true, apiVersion: API_VERSION }, 200, origin);
  }
  if (url.pathname === "/v1/models") {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    const installationDailyCapsEnforced = parseBooleanFlag(
      env.ENFORCE_INSTALLATION_DAILY_CAPS,
      true,
    );
    return jsonResponse(
      {
        apiVersion: API_VERSION,
        defaultAssetKind: DEFAULT_ASSET_KIND,
        promptLimits: {
          minCodePoints: MIN_USER_PROMPT_CODE_POINTS,
          maxCodePoints: MAX_USER_PROMPT_CODE_POINTS,
        },
        quota: {
          dailyAttemptLimit: INSTALLATION_DAILY_ATTEMPT_LIMIT,
          dailyAttemptScope: "installation",
          installationDailyCapsEnforced,
          artworkSlotDailyAttemptLimit: ARTWORK_SLOT_DAILY_ATTEMPT_LIMIT,
          artworkSlotIdSupported: true,
          generationCancellationSupported: true,
          outcomeAccountingSupported: true,
          freeFailureNeuronLimit: FREE_FAILED_GENERATION_NEURONS,
          legacyMissingArtworkSlotScope: "installation_asset_kind",
          resets: "utc_day",
        },
        models: enabledModelSpecs(env.ENABLED_MODELS).map((model) => {
          const medal = findModelAssetSpec(model, DEFAULT_ASSET_KIND);
          if (!medal) throw new Error(`Enabled model ${model.alias} has no medal capability`);
          return {
            id: model.alias,
            name: model.name,
            description: model.description,
            supportsReference: model.supportsReference,
            dailyAttemptLimit: INSTALLATION_DAILY_ATTEMPT_LIMIT,
            baseEstimatedImageNeurons: medal.baseEstimatedImageNeurons,
            output: medal.output,
            ...(model.supportsReference
              ? {
                  referenceMaxBytes: MAX_REFERENCE_BYTES,
                  referenceMaxWidth: MODEL_REFERENCE_MAX_EDGE,
                  referenceMaxHeight: MODEL_REFERENCE_MAX_EDGE,
                }
              : {}),
            assetKinds: model.assetKinds.map((asset) => ({
              id: asset.id,
              baseEstimatedImageNeurons: asset.baseEstimatedImageNeurons,
              output: asset.output,
              supportsReference: model.supportsReference,
              ...(model.supportsReference
                ? {
                    referenceMaxBytes: MAX_REFERENCE_BYTES,
                    referenceMaxWidth: MODEL_REFERENCE_MAX_EDGE,
                    referenceMaxHeight: MODEL_REFERENCE_MAX_EDGE,
                  }
                : {}),
            })),
          };
        }),
        safety: {
          model: env.SAFETY_MODEL || DEFAULT_SAFETY_MODEL,
          estimatedNeuronsVaryByPrompt: true,
        },
      },
      200,
      origin,
    );
  }
  if (url.pathname === "/v1/quota") {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    return handleQuota(request, env, origin);
  }
  if (url.pathname === "/v1/generate") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    return handleGenerate(request, env, requestId, origin);
  }
  if (url.pathname === "/v1/cancel") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    return handleCancel(request, env, origin);
  }
  if (url.pathname === "/v1/report") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    return handleReport(request, env, origin);
  }
  throw new ApiError(404, "not_found", "Endpoint not found");
}

export default {
  async fetch(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    let origin: string | undefined;
    try {
      origin = acceptedCorsOrigin(request, env);
      const response = dispatch(request, env, requestId, origin);
      context?.waitUntil(response.then(() => undefined, () => undefined));
      return await response;
    } catch (error) {
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError(
              503,
              "service_unavailable",
              "Image generation is temporarily unavailable. You can still upload your own artwork.",
              true,
              60,
            );
      return errorResponse(apiError, requestId, origin);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await pruneExpiredDailyQuota(env.QUOTA_DB);
  },
};
