import type { AiBinding } from "./types";

export const DEFAULT_SAFETY_MODEL = "@cf/meta/llama-guard-3-8b";
export const SAFETY_TEMPLATE_TOKEN_HEADROOM = 2_048;
export const SAFETY_MAX_OUTPUT_TOKENS = 32;
const SAFETY_INPUT_NEURONS_PER_TOKEN = 44_003 / 1_000_000;
const SAFETY_OUTPUT_NEURONS_PER_TOKEN = 2_730 / 1_000_000;

const ALLOWED_SAFETY_MODELS = new Set([DEFAULT_SAFETY_MODEL]);

const DETERMINISTIC_BLOCKS = [
  /\b(?:csam|child sexual abuse material|sexual(?:ly)? explicit (?:child|minor)|underage sex)\b/iu,
  /\b(?:exact|identical) (?:copy|clone|replica) of (?:an? )?(?:(?:existing|commercial|branded) )+(?:medal|logo|product)\b/iu,
  /\bcopy (?:this|the) (?:commercial )?(?:medal|logo) exactly\b/iu,
] as const;

export class UnsafePromptError extends Error {}
export class SafetyServiceError extends Error {}

export function deterministicPromptBlock(prompt: string): boolean {
  return DETERMINISTIC_BLOCKS.some((pattern) => pattern.test(prompt));
}

export function estimateSafetyNeurons(prompt: string): number {
  // A tokenizer-specific exact count is not available before inference. UTF-8 bytes
  // conservatively upper-bound ordinary prompt tokens, and the fixed headroom covers
  // the Llama Guard chat template and hazard taxonomy.
  const estimatedInputTokens =
    SAFETY_TEMPLATE_TOKEN_HEADROOM + new TextEncoder().encode(prompt).byteLength;
  return Math.ceil(
    estimatedInputTokens * SAFETY_INPUT_NEURONS_PER_TOKEN +
      SAFETY_MAX_OUTPUT_TOKENS * SAFETY_OUTPUT_NEURONS_PER_TOKEN,
  );
}

function parseClassification(value: unknown): "safe" | "unsafe" | undefined {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (/^safe(?:\s|$)/u.test(normalized)) return "safe";
    if (/^unsafe(?:\s|$)/u.test(normalized)) return "unsafe";
    return undefined;
  }
  if (typeof value === "object" && value !== null && "safe" in value) {
    const safe = (value as { safe?: unknown }).safe;
    if (typeof safe === "boolean") return safe ? "safe" : "unsafe";
  }
  return undefined;
}

function responseClassification(result: unknown): "safe" | "unsafe" | undefined {
  if (typeof result === "object" && result !== null && "response" in result) {
    return parseClassification((result as { response?: unknown }).response);
  }
  return parseClassification(result);
}

export async function assertPromptSafe(
  ai: AiBinding,
  prompt: string,
  configuredModel: string | undefined,
): Promise<void> {
  if (deterministicPromptBlock(prompt)) {
    throw new UnsafePromptError("Prompt matched a deterministic safety rule");
  }

  const model = (configuredModel || DEFAULT_SAFETY_MODEL).trim();
  if (!ALLOWED_SAFETY_MODELS.has(model)) {
    throw new SafetyServiceError("Configured safety model is not allowlisted");
  }

  let result: unknown;
  try {
    // One user message satisfies Llama Guard's alternating-role requirement and asks it
    // to classify the submitted prompt rather than a server-authored rewrite.
    result = await ai.run(model, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: SAFETY_MAX_OUTPUT_TOKENS,
      temperature: 0,
    });
  } catch {
    throw new SafetyServiceError("Safety classifier request failed");
  }

  const classification = responseClassification(result);
  if (classification === "safe") return;
  if (classification === "unsafe") {
    throw new UnsafePromptError("Safety classifier rejected the prompt");
  }
  throw new SafetyServiceError("Safety classifier returned an unrecognized response");
}
