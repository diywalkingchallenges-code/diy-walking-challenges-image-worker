import type { AssetKind } from "./prompt";

export interface AiBinding {
  run(model: string, inputs: unknown): Promise<unknown>;
}

export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  AI: AiBinding;
  QUOTA_DB: D1Database;
  INSTALL_RATE_LIMITER: RateLimiterBinding;
  IP_RATE_LIMITER: RateLimiterBinding;
  REPORT_RATE_LIMITER: RateLimiterBinding;
  RATE_LIMIT_HASH_PEPPER?: string;
  REPORT_TOKEN_SECRET?: string;
  DAILY_GLOBAL_NEURON_BUDGET?: string;
  ENFORCE_INSTALLATION_DAILY_CAPS?: string;
  ALLOWED_ORIGINS?: string;
  ENABLED_MODELS?: string;
  SAFETY_MODEL?: string;
}

export type ReferenceImage = {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  bytes: Uint8Array;
  width: number;
  height: number;
};

export type ParsedGenerationRequest = {
  assetKind: AssetKind;
  artworkSlotId?: string;
  model: string;
  userPrompt: string;
  seed?: number;
  reference?: ReferenceImage;
};
