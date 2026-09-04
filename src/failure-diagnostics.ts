import type { AssetKind } from "./prompt";
import type { ProviderErrorCategory } from "./provider-errors";

export const FAILURE_DIAGNOSTIC_RETENTION_DAYS = 30;
export const FAILURE_DIAGNOSTIC_MAX_ROWS = 5_000;

export type ProviderFailureDiagnostic = {
  requestId: string;
  modelAlias: string;
  assetKind: AssetKind;
  providerCode: string;
  category: ProviderErrorCategory;
};

function safeConsoleError(value: Record<string, unknown>): void {
  try {
    console.error(value);
  } catch {
    // Diagnostics must never replace the original API response.
  }
}

export async function saveProviderFailureDiagnostic(
  db: D1Database,
  diagnostic: ProviderFailureDiagnostic,
  instant = new Date(),
): Promise<void> {
  const createdAt = instant.toISOString();
  const retentionCutoff = new Date(
    instant.getTime() - FAILURE_DIAGNOSTIC_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const statements = [
    db
      .prepare(
        `INSERT INTO provider_ai_failures
           (request_id, model_alias, asset_kind, provider_code, category, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(request_id) DO UPDATE SET
           model_alias = excluded.model_alias,
           asset_kind = excluded.asset_kind,
           provider_code = excluded.provider_code,
           category = excluded.category,
           created_at = excluded.created_at`,
      )
      .bind(
        diagnostic.requestId,
        diagnostic.modelAlias,
        diagnostic.assetKind,
        diagnostic.providerCode,
        diagnostic.category,
        createdAt,
      ),
    db
      .prepare("DELETE FROM provider_ai_failures WHERE created_at < ?1")
      .bind(retentionCutoff),
    db
      .prepare(
        `DELETE FROM provider_ai_failures
         WHERE request_id IN (
           SELECT request_id
           FROM provider_ai_failures
           ORDER BY created_at DESC, request_id DESC
           LIMIT -1 OFFSET ?1
         )`,
      )
      .bind(FAILURE_DIAGNOSTIC_MAX_ROWS),
  ];
  const results = await db.batch(statements);
  if (results.some((result) => !result.success)) {
    throw new Error("Provider failure diagnostic could not be stored");
  }
}

/** Records only allowlisted diagnostic fields and intentionally never throws. */
export async function recordProviderFailureDiagnostic(
  db: D1Database,
  diagnostic: ProviderFailureDiagnostic,
  instant = new Date(),
): Promise<void> {
  const timestamp = instant.toISOString();
  safeConsoleError({
    event: "workers_ai_inference_failure",
    requestId: diagnostic.requestId,
    modelAlias: diagnostic.modelAlias,
    assetKind: diagnostic.assetKind,
    providerCode: diagnostic.providerCode,
    category: diagnostic.category,
    timestamp,
  });

  try {
    await saveProviderFailureDiagnostic(db, diagnostic, instant);
  } catch {
    safeConsoleError({
      event: "workers_ai_diagnostic_persistence_failure",
      requestId: diagnostic.requestId,
      modelAlias: diagnostic.modelAlias,
      assetKind: diagnostic.assetKind,
      providerCode: diagnostic.providerCode,
      category: diagnostic.category,
      timestamp,
    });
  }
}
