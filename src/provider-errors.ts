export type ProviderErrorCategory =
  | "access"
  | "capacity"
  | "configuration"
  | "content_filter"
  | "free_quota"
  | "invalid_model"
  | "invalid_output"
  | "timeout"
  | "unknown";

export type ProviderApiErrorCode =
  | "content_rejected"
  | "model_busy"
  | "model_configuration_error"
  | "model_invalid_output"
  | "model_timeout"
  | "model_unavailable"
  | "workers_ai_quota_exhausted";

export type ProviderErrorClassification = {
  providerCode: string;
  category: ProviderErrorCategory;
  api: {
    status: number;
    code: ProviderApiErrorCode;
    message: string;
    retryable: boolean;
    retryAfterSeconds?: number;
  };
};

const CODE_KEYS = ["internalCode", "internal_code", "errorCode", "error_code", "code"] as const;
const NESTED_KEYS = ["cause", "error", "errors", "response", "body", "data", "details", "message"] as const;
const MAX_ERROR_TREE_DEPTH = 8;
const MAX_ERROR_TREE_NODES = 64;
const MAX_JSON_ERROR_TEXT_LENGTH = 32 * 1024;

function numericCode(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    const normalized = String(value);
    return /^[35]\d{3}$/u.test(normalized) ? normalized : undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[35]\d{3}$/u.test(normalized) ? normalized : undefined;
}

function ownDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function codeInText(text: string): string | undefined {
  const trimmed = text.trim();
  const direct = numericCode(trimmed);
  if (direct) return direct;

  return (
    /\b(?:internal(?:[_\s-]?code)?|error(?:[_\s-]?code)?|code)\b["']?\s*[:=#-]?\s*["']?([35]\d{3})\b/iu.exec(
      trimmed,
    )?.[1] ??
    /\b(?:ai_error|aierror|workers ai(?: error)?|cloudflare(?: ai)? error)\b[^\d]{0,24}([35]\d{3})\b/iu.exec(
      trimmed,
    )?.[1] ??
    /^\s*(?:[a-z]*error\s*:\s*)?([35]\d{3})\s*:/iu.exec(trimmed)?.[1] ??
    /\(\s*code\s+([35]\d{3})\s*\)\s*$/iu.exec(trimmed)?.[1]
  );
}

/**
 * Extracts only a normalized Cloudflare Workers AI internal code. Traversal is intentionally
 * bounded and ignores accessors so an unusual thrown value cannot execute application code.
 */
export function extractCloudflareAiErrorCode(error: unknown): string | undefined {
  const seen = new WeakSet<object>();
  let remainingNodes = MAX_ERROR_TREE_NODES;

  const visit = (value: unknown, depth: number): string | undefined => {
    if (depth > MAX_ERROR_TREE_DEPTH || remainingNodes <= 0) return undefined;
    remainingNodes -= 1;

    if (typeof value === "number") return numericCode(value);
    if (typeof value === "string") {
      if (value.length <= MAX_JSON_ERROR_TEXT_LENGTH) {
        const trimmed = value.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          try {
            const nested = visit(JSON.parse(trimmed) as unknown, depth + 1);
            if (nested) return nested;
          } catch {
            // A plain provider message is expected to be non-JSON.
          }
        }
      }
      return codeInText(value);
    }
    if (typeof value !== "object" || value === null || seen.has(value)) return undefined;
    seen.add(value);

    for (const key of CODE_KEYS) {
      const candidate = ownDataProperty(value, key);
      const normalized = numericCode(candidate);
      if (normalized) return normalized;
      if (typeof candidate === "string") {
        const embedded = codeInText(candidate);
        if (embedded) return embedded;
      }
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = visit(item, depth + 1);
        if (nested) return nested;
      }
      return undefined;
    }

    for (const key of NESTED_KEYS) {
      const nested = visit(ownDataProperty(value, key), depth + 1);
      if (nested) return nested;
    }
    return undefined;
  };

  return visit(error, 0);
}

function safeMessage(error: unknown): string {
  if (typeof error === "string") return error.slice(0, MAX_JSON_ERROR_TEXT_LENGTH);
  if (typeof error !== "object" || error === null) return "";
  const message = ownDataProperty(error, "message");
  return typeof message === "string" ? message.slice(0, MAX_JSON_ERROR_TEXT_LENGTH) : "";
}

function categoryForCode(code: string): ProviderErrorCategory | undefined {
  if (code === "3030") return "content_filter";
  if (code === "3040") return "capacity";
  if (code === "3036") return "free_quota";
  if (code === "3007" || code === "3008") return "timeout";
  if (code === "5007" || code === "3042") return "invalid_model";
  if (["3023", "3041", "5016", "5018", "5035"].includes(code)) return "access";
  if (["3003", "3006", "3039", "5004", "5005", "5019"].includes(code)) {
    return "configuration";
  }
  return undefined;
}

function categoryFromMessage(message: string): ProviderErrorCategory {
  if (/safety|moderation|inappropriate|nsfw|content.?policy/iu.test(message)) {
    return "content_filter";
  }
  if (/out of capacity|no more data centers|\bcapacity\b/iu.test(message)) return "capacity";
  if (/daily free allocation|account limited|neuron[^.]{0,40}(?:quota|limit)/iu.test(message)) {
    return "free_quota";
  }
  if (/timed?\s*out|request was aborted|\baborted\b/iu.test(message)) return "timeout";
  if (/no such model|invalid model/iu.test(message)) return "invalid_model";
  if (/private model|paid plan|not allowed to access|account blocked|model agreement/iu.test(message)) {
    return "access";
  }
  return "unknown";
}

export function classifyCloudflareAiError(
  error: unknown,
  dailyQuotaRetryAfterSeconds: number,
): ProviderErrorClassification {
  const extractedCode = extractCloudflareAiErrorCode(error);
  const providerCode = extractedCode ?? "unknown";
  const category = categoryForCode(providerCode) ?? categoryFromMessage(safeMessage(error));

  switch (category) {
    case "content_filter":
      return {
        providerCode,
        category,
        api: {
          status: 422,
          code: "content_rejected",
          message: "That image could not be generated. Try a different, family-friendly description.",
          retryable: false,
        },
      };
    case "capacity":
      return {
        providerCode,
        category,
        api: {
          status: 503,
          code: "model_busy",
          message: "The image model is busy right now. Try again shortly or upload your own artwork.",
          retryable: true,
          retryAfterSeconds: 60,
        },
      };
    case "free_quota":
      return {
        providerCode,
        category,
        api: {
          status: 503,
          code: "workers_ai_quota_exhausted",
          message: "Today's hosted image-generation allowance has been used. Try again after the 00:00 UTC daily reset or upload your own artwork.",
          retryable: true,
          retryAfterSeconds: dailyQuotaRetryAfterSeconds,
        },
      };
    case "timeout":
      return {
        providerCode,
        category,
        api: {
          status: 504,
          code: "model_timeout",
          message: "The image model took too long to respond. Try again or upload your own artwork.",
          retryable: true,
          retryAfterSeconds: 120,
        },
      };
    case "invalid_model":
    case "access":
    case "configuration":
      return {
        providerCode,
        category,
        api: {
          status: 503,
          code: "model_configuration_error",
          message: "This image model is not configured correctly. You can still upload your own artwork.",
          retryable: false,
        },
      };
    case "invalid_output":
      return {
        providerCode,
        category,
        api: {
          status: 503,
          code: "model_invalid_output",
          message: "The image model returned an unusable image. Try again or upload your own artwork.",
          retryable: true,
          retryAfterSeconds: 120,
        },
      };
    case "unknown":
      return {
        providerCode,
        category,
        api: {
          status: 503,
          code: "model_unavailable",
          message: "Image generation is temporarily unavailable. You can still upload your own artwork.",
          retryable: true,
          retryAfterSeconds: 120,
        },
      };
  }
}
