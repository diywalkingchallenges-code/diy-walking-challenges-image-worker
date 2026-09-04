const REPORT_REASONS = new Set([
  "unsafe_or_inappropriate",
  "copyright_or_trademark",
  "personal_information",
  "other",
]);

export type ParsedReport = {
  requestId: string;
  reportToken: string;
  reason: string;
  details?: string;
};

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function hmac(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return encodeBase64Url(new Uint8Array(signature));
}

function constantTimeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maxLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function parseReport(input: unknown): ParsedReport {
  if (typeof input !== "object" || input === null) throw new Error("Report body must be an object");
  const value = input as Record<string, unknown>;
  if (typeof value.requestId !== "string" || !/^[0-9a-f-]{36}$/iu.test(value.requestId)) {
    throw new Error("Invalid generation request ID");
  }
  if (typeof value.reportToken !== "string" || value.reportToken.length < 32 || value.reportToken.length > 128) {
    throw new Error("Invalid report token");
  }
  if (typeof value.reason !== "string" || !REPORT_REASONS.has(value.reason)) {
    throw new Error("Invalid report reason");
  }
  if (value.details !== undefined && typeof value.details !== "string") {
    throw new Error("Report details must be text");
  }
  const details = value.details?.trim();
  if (typeof details === "string" && Array.from(details).length > 500) {
    throw new Error("Report details must be 500 characters or fewer");
  }
  return {
    requestId: value.requestId,
    reportToken: value.reportToken,
    reason: value.reason,
    ...(details ? { details } : {}),
  };
}

export async function createReportToken(
  requestId: string,
  installationHash: string,
  secret: string,
): Promise<string> {
  return hmac(`${requestId}\n${installationHash}`, secret);
}

export async function verifyReportToken(
  report: ParsedReport,
  installationHash: string,
  secret: string,
): Promise<boolean> {
  const expected = await createReportToken(report.requestId, installationHash, secret);
  return constantTimeEqual(report.reportToken, expected);
}

export async function saveReport(
  db: D1Database,
  report: ParsedReport,
  installationHash: string,
  instant = new Date(),
): Promise<string> {
  const reportId = crypto.randomUUID();
  const now = instant.toISOString();
  const row = await db
    .prepare(
      `INSERT INTO generation_reports
         (report_id, generation_request_id, installation_hash, reason, details, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT(generation_request_id, installation_hash) DO UPDATE SET
         reason = excluded.reason,
         details = excluded.details,
         updated_at = excluded.updated_at
       RETURNING report_id`,
    )
    .bind(reportId, report.requestId, installationHash, report.reason, report.details ?? null, now)
    .first<{ report_id: string }>();
  if (!row) throw new Error("Report could not be stored");
  return row.report_id;
}
