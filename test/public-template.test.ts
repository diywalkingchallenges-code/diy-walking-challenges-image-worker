import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type PublicWranglerConfig = {
  account_id?: string;
  d1_databases?: Array<{ binding?: string; database_id?: string; database_name?: string }>;
  secrets?: { required?: string[] };
  vars?: Record<string, string>;
};

type PublicPackage = {
  scripts?: Record<string, string>;
  cloudflare?: { bindings?: Record<string, { description?: string }> };
};

const config = JSON.parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
) as PublicWranglerConfig;
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PublicPackage;

const publicRepository =
  "https://github.com/diywalkingchallenges-code/diy-walking-challenges-image-worker";
const deployUrl = `https://deploy.workers.cloudflare.com/?url=${publicRepository}`;

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

  it("exposes the live Deploy to Cloudflare flow in both setup guides", () => {
    for (const guide of ["README.md", "DEPLOY.md"]) {
      const content = readFileSync(new URL(`../${guide}`, import.meta.url), "utf8");
      expect(content).toContain(deployUrl);
    }
  });

  it("keeps provisioning, migrations, and deployment machine-checkable", () => {
    expect(packageJson.scripts?.["template:check"]).toBe(
      "wrangler deploy --dry-run --outdir .wrangler/template-check",
    );
    expect(packageJson.scripts?.deploy).toBe(
      "npm run db:migrate && npm run deploy:worker",
    );
    expect(packageJson.scripts?.["db:migrate"]).toBe(
      "wrangler d1 migrations apply QUOTA_DB --remote",
    );
  });

  it("explains every value shown by the guided deployment", () => {
    for (const binding of [
      "RATE_LIMIT_HASH_PEPPER",
      "REPORT_TOKEN_SECRET",
      "DAILY_GLOBAL_NEURON_BUDGET",
      "ALLOWED_ORIGINS",
      "ENABLED_MODELS",
      "SAFETY_MODEL",
    ]) {
      expect(packageJson.cloudflare?.bindings?.[binding]?.description).toBeTruthy();
    }
  });
});
