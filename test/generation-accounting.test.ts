import { describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { sqliteDatabase } from "./d1";
import { beginGeneration, cancelGeneration, finishGeneration, readArtworkAllowance,
  setGenerationReservation, startGenerationStage } from "../src/generation-accounting";
import { readGlobalNeuronBudget, reserveGenerationBudget } from "../src/quota";
import worker from "../src/index";
import type { Env } from "../src/types";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
const instant = new Date("2026-09-07T18:00:00Z");
const day = "2026-09-07";
async function reserve(db: D1Database, neurons: number, slot = "map", installationHash = "owner", at = instant) {
  const key = { installationHash, generationId: crypto.randomUUID() };
  const requestId = crypto.randomUUID();
  expect(await beginGeneration(db, key, requestId, slot, at)).toBe(true);
  const result = await reserveGenerationBudget(db, { installationHash, artworkSlotHash: slot,
    reservationId: requestId, assetKind: "route_map", estimatedNeurons: neurons,
    globalNeuronBudget: 10000, enforceInstallationDailyCaps: true, instant: at });
  expect(result.result).toBe("reserved");
  await setGenerationReservation(db, key, neurons);
  return key;
}

describe("generation outcome accounting using migrated SQLite", () => {
  it("refunds failures through exactly 500 Neurons, counts the crossing attempt, and never erases spent work", async () => {
    const db = sqliteDatabase();
    for (const neurons of [300, 200]) {
      const key = await reserve(db, neurons);
      expect(await startGenerationStage(db, key, neurons)).toBe(true);
      await finishGeneration(db, key, "failed");
      expect(await readArtworkAllowance(db, day, "owner", "map")).toMatchObject({
        installationRemaining: 6, artworkSlotRemaining: 1, pending: false });
    }
    const crossing = await reserve(db, 1);
    await startGenerationStage(db, crossing, 1);
    await finishGeneration(db, crossing, "failed");
    expect(await readArtworkAllowance(db, day, "owner", "map")).toMatchObject({
      installationRemaining: 5, artworkSlotRemaining: 0, estimatedNeuronsUsed: 501 });
    expect((await readGlobalNeuronBudget(db, day, 10000)).used).toBe(501);
    await Promise.all([finishGeneration(db, crossing, "failed"), cancelGeneration(db, crossing, instant)]);
    expect((await readGlobalNeuronBudget(db, day, 10000)).used).toBe(501);
    expect((await readArtworkAllowance(db, day, "owner", "map")).estimatedNeuronsUsed).toBe(501);
  });

  it("counts successful images normally and isolates each artwork, installation, and UTC day", async () => {
    const db = sqliteDatabase();
    const key = await reserve(db, 200);
    await startGenerationStage(db, key, 200);
    await finishGeneration(db, key, "succeeded");
    expect(await readArtworkAllowance(db, day, "owner", "map")).toMatchObject({
      installationRemaining: 5, artworkSlotRemaining: 0 });
    expect(await readArtworkAllowance(db, day, "owner", "milestone-1")).toMatchObject({
      artworkSlotRemaining: 1, estimatedNeuronsUsed: 0 });
    expect(await readArtworkAllowance(db, day, "friend", "map")).toMatchObject({
      installationRemaining: 6, artworkSlotRemaining: 1, estimatedNeuronsUsed: 0 });
    expect(await readArtworkAllowance(db, "2026-09-08", "owner", "map")).toMatchObject({
      installationRemaining: 6, artworkSlotRemaining: 1, estimatedNeuronsUsed: 0 });
  });

  it("cancellation retains only started stages and prevents the image stage from starting", async () => {
    const db = sqliteDatabase();
    const key = await reserve(db, 200);
    await startGenerationStage(db, key, 95);
    expect((await cancelGeneration(db, key, instant))?.status).toBe("canceled");
    expect(await startGenerationStage(db, key, 105)).toBe(false);
    await finishGeneration(db, key, "succeeded");
    expect((await readGlobalNeuronBudget(db, day, 10000)).used).toBe(95);
    expect(await readArtworkAllowance(db, day, "owner", "map")).toMatchObject({
      installationRemaining: 6, artworkSlotRemaining: 1, estimatedNeuronsUsed: 95 });
  });

  it("an early cancellation blocks a delayed request, and cancellation during reservation is settled by its owner", async () => {
    const db = sqliteDatabase();
    const early = { installationHash: "owner", generationId: crypto.randomUUID() };
    await cancelGeneration(db, early, instant);
    expect(await beginGeneration(db, early, crypto.randomUUID(), "map", instant)).toBe(false);
    const preparing = { installationHash: "owner", generationId: crypto.randomUUID() };
    const requestId = crypto.randomUUID();
    await beginGeneration(db, preparing, requestId, "map", instant);
    expect((await cancelGeneration(db, preparing, instant))?.status).toBe("preparing");
    await reserveGenerationBudget(db, { ...preparing, artworkSlotHash: "map", reservationId: requestId,
      assetKind: "route_map", estimatedNeurons: 200, globalNeuronBudget: 10000, enforceInstallationDailyCaps: true, instant });
    await setGenerationReservation(db, preparing, 200);
    expect(await startGenerationStage(db, preparing, 95)).toBe(false);
    await finishGeneration(db, preparing, "failed");
    expect((await readGlobalNeuronBudget(db, day, 10000)).used).toBe(0);
    expect((await readArtworkAllowance(db, day, "owner", "map")).installationRemaining).toBe(6);
  });

  it("a second request cannot share a reserved slot and replayed settlement cannot refund a newer request", async () => {
    const db = sqliteDatabase();
    const first = await reserve(db, 200);
    expect((await reserveGenerationBudget(db, { installationHash: "owner", artworkSlotHash: "map",
      reservationId: crypto.randomUUID(), assetKind: "route_map", estimatedNeurons: 200,
      globalNeuronBudget: 10000, enforceInstallationDailyCaps: true, instant })).result).toBe("artwork_slot_exhausted");
    await cancelGeneration(db, first, instant);
    const second = await reserve(db, 200);
    await finishGeneration(db, first, "failed");
    expect((await readArtworkAllowance(db, day, "owner", "map")).artworkSlotRemaining).toBe(0);
    await startGenerationStage(db, second, 200);
    await finishGeneration(db, second, "succeeded");
    expect((await readGlobalNeuronBudget(db, day, 10000)).used).toBe(200);
  });

  it("handles cancellation racing a completed download once, but keeps a long-finished image counted", async () => {
    const db = sqliteDatabase();
    const key = await reserve(db, 200);
    await startGenerationStage(db, key, 200);
    await finishGeneration(db, key, "succeeded");
    await cancelGeneration(db, key, new Date(instant.getTime() + 1_000));
    await cancelGeneration(db, key, new Date(instant.getTime() + 2_000));
    expect(await readArtworkAllowance(db, day, "owner", "map")).toMatchObject({
      artworkSlotRemaining: 1, installationRemaining: 6, estimatedNeuronsUsed: 200 });
    const next = await reserve(db, 200);
    await startGenerationStage(db, next, 200);
    await finishGeneration(db, next, "succeeded");
    await cancelGeneration(db, next, new Date(instant.getTime() + 6 * 60_000));
    expect(await readArtworkAllowance(db, day, "owner", "map")).toMatchObject({
      artworkSlotRemaining: 0, installationRemaining: 5, estimatedNeuronsUsed: 400 });
    expect((await readGlobalNeuronBudget(db, day, 10000)).used).toBe(400);
  });

  it("rolls back the whole settlement on a database failure and safely retries it", async () => {
    const db = sqliteDatabase();
    const key = await reserve(db, 200);
    await startGenerationStage(db, key, 95);
    const batch = db.batch.bind(db);
    db.batch = (async statements => batch([...statements, db.prepare("INSERT INTO table_that_does_not_exist VALUES (1)")])) as typeof db.batch;
    await expect(finishGeneration(db, key, "failed")).rejects.toThrow();
    expect((await readGlobalNeuronBudget(db, day, 10000)).used).toBe(200);
    expect((await readArtworkAllowance(db, day, "owner", "map")).artworkSlotRemaining).toBe(0);
    db.batch = batch;
    await finishGeneration(db, key, "failed");
    expect((await readGlobalNeuronBudget(db, day, 10000)).used).toBe(95);
    expect((await readArtworkAllowance(db, day, "owner", "map")).artworkSlotRemaining).toBe(1);
  });
});

describe("generation and cancellation HTTP integration", () => {
  const installation = "8ba9f618-438f-4caa-a499-dfe73bd0b3ac";
  function env(ai: Env["AI"]): Env {
    return { AI: ai, QUOTA_DB: sqliteDatabase(), RATE_LIMIT_HASH_PEPPER: "p".repeat(40), REPORT_TOKEN_SECRET: "r".repeat(40),
      INSTALL_RATE_LIMITER: { limit: async () => ({ success: true }) }, IP_RATE_LIMITER: { limit: async () => ({ success: true }) },
      REPORT_RATE_LIMITER: { limit: async () => ({ success: true }) } };
  }
  function post(path: string, body: unknown, owner = installation) {
    return new Request(`https://worker.example/v1/${path}`, { method: "POST", headers: {
      "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9", "X-DIYWC-Installation-ID": owner,
    }, body: JSON.stringify(body) });
  }

  it("IP/copyright rule failures make no AI call and leave the artwork and daily use available", async () => {
    const ai = { run: vi.fn() };
    const service = env(ai);
    const response = await worker.fetch(post("generate", { model: "flux-schnell", artworkSlotId: "medal-slot",
      prompt: "exact copy of a commercial logo", generationId: crypto.randomUUID() }), service);
    expect(response.status).toBe(422);
    const body = await response.json() as any;
    expect(body.error.artworkAllowance).toMatchObject({ installationRemaining: 6, artworkSlotRemaining: 1, estimatedNeuronsUsed: 0 });
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("repeated safety rejections spend screening Neurons and eventually consume only this artwork's use", async () => {
    const service = env({ run: vi.fn(async () => ({ response: "unsafe" })) });
    let allowance: any;
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await worker.fetch(post("generate", { model: "flux-schnell", artworkSlotId: "medal-slot",
        prompt: "some rejected artwork", generationId: crypto.randomUUID() }), service);
      allowance = (await response.json() as any).error.artworkAllowance;
      expect(allowance.artworkSlotRemaining).toBe(attempt < 5 ? 1 : 0);
    }
    expect(allowance.estimatedNeuronsUsed).toBeGreaterThan(500);
    expect(allowance.installationRemaining).toBe(5);
  });

  it("a cancel request during screening prevents image generation, and another installation cannot cancel it", async () => {
    let completeSafety!: (value: unknown) => void;
    let screeningStarted!: () => void;
    const started = new Promise<void>(resolve => { screeningStarted = resolve; });
    const ai = { run: vi.fn(() => new Promise(resolve => { completeSafety = resolve; screeningStarted(); })) };
    const service = env(ai);
    const generationId = crypto.randomUUID();
    const response = worker.fetch(post("generate", { generationId, model: "flux-schnell", artworkSlotId: "medal-slot",
      prompt: "forest compass design" }), service);
    await started;
    await worker.fetch(post("cancel", { generationId }, "different-installation-id-1234"), service);
    const cancel = await worker.fetch(post("cancel", { generationId }), service);
    expect((await cancel.json() as any).artworkAllowance).toMatchObject({ installationRemaining: 6, artworkSlotRemaining: 1 });
    completeSafety({ response: "safe" });
    expect((await response).status).toBe(409);
    expect(ai.run).toHaveBeenCalledOnce();
    expect((await worker.fetch(post("generate", { generationId, model: "flux-schnell", artworkSlotId: "medal-slot",
      prompt: "forest compass design" }), service)).status).toBe(409);
  });

  it("canceling an in-flight image retains its cost and eventually uses the artwork's daily allowance", async () => {
    let completeImage!: (value: unknown) => void;
    let imageStarted!: () => void;
    const ai = { run: vi.fn(async (model: string) => model.includes("llama-guard") ? { response: "safe" }
      : new Promise(resolve => { completeImage = resolve; imageStarted(); })) };
    const service = env(ai);
    for (let index = 0; index < 4; index++) {
      const started = new Promise<void>(resolve => { imageStarted = resolve; });
      const generationId = crypto.randomUUID();
      const response = worker.fetch(post("generate", { generationId, model: "flux-schnell", artworkSlotId: "medal-slot",
        prompt: "forest compass design" }), service);
      await started;
      const cancel = await worker.fetch(post("cancel", { generationId }), service);
      const allowance = (await cancel.json() as any).artworkAllowance;
      expect(allowance.artworkSlotRemaining).toBe(index < 3 ? 1 : 0);
      expect(allowance.installationRemaining).toBe(index < 3 ? 6 : 5);
      // No useful output is required to settle cancellation. It still counts the started AI stage.
      completeImage({ image: "invalid" });
      expect((await response).status).toBe(409);
    }
  });

  it("returns per-artwork status on reopening and leaves uncapped private servers uncapped", async () => {
    const service = env({ run: vi.fn(async () => ({ response: "unsafe" })) });
    await worker.fetch(post("generate", { model: "flux-schnell", artworkSlotId: "medal-slot", prompt: "rejected artwork" }), service);
    const status = () => new Request("https://worker.example/v1/quota?artworkSlotId=medal-slot&assetKind=medal", {
      headers: { "X-DIYWC-Installation-ID": installation, "CF-Connecting-IP": "203.0.113.9" } });
    const current = await worker.fetch(status(), service);
    expect((await current.json() as any).artworkAllowance).toMatchObject({ artworkSlotRemaining: 1, installationRemaining: 6 });
    service.ENFORCE_INSTALLATION_DAILY_CAPS = "false";
    const privateStatus = await worker.fetch(status(), service);
    const body = await privateStatus.json() as any;
    expect(body.artworkAllowance).toBeUndefined();
    expect(body.installation).toBeUndefined();
  });
});
