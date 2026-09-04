import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type PublicWranglerConfig = {
  account_id?: string;
  d1_databases?: Array<{ binding?: string; database_id?: string; database_name?: string }>;
  secrets?: { required?: string[] };
  vars?: Record<string, string>;
};

const config = JSON.parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
) as PublicWranglerConfig;

describe("public Cloudflare template", () => {
  it("contains no account-specific Cloudflare identifiers", () => {
    expect(config.account_id).toBeUndefined();
    expect(config.d1_databases).toHaveLength(1);
    expect(config.d1_databases?.[0]).toMatchObject({
      binding: "QUOTA_DB",
      database_name: "diywc-image-quota",
    });
    expect(config.d1_databases?.[0].database_id).toBeUndefined();
  });

  it("declares secret names without committing secret values", () => {
    expect(config.secrets?.required).toEqual([
      "RATE_LIMIT_HASH_PEPPER",
      "REPORT_TOKEN_SECRET",
    ]);
    expect(config.vars).not.toHaveProperty("RATE_LIMIT_HASH_PEPPER");
    expect(config.vars).not.toHaveProperty("REPORT_TOKEN_SECRET");

    const example = readFileSync(new URL("../.dev.vars.example", import.meta.url), "utf8");
    expect(example).toContain("replace-with-a-random-server-only-secret");
    expect(example).toContain("replace-with-another-random-server-only-secret");
  });
});
