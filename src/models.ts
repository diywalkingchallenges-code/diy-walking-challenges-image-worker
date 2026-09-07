import { DEFAULT_ASSET_KIND, NEGATIVE_PROMPT, type AssetKind } from "./prompt";
import type { AiBinding, ReferenceImage } from "./types";

export const OUTPUT_EDGE = 512;
export const MILESTONE_BANNER_WIDTH = 1_024;
export const MILESTONE_BANNER_HEIGHT = 512;
export const ROUTE_MAP_WIDTH = 1_024;
export const ROUTE_MAP_HEIGHT = 768;
export const MODEL_REFERENCE_MAX_EDGE = 512;
export const SCHNELL_STEPS = 4;
const SCHNELL_BUDGET_OUTPUT_TILES = 4;
const SCHNELL_NEURONS_PER_OUTPUT_TILE = 4.8;
const SCHNELL_NEURONS_PER_STEP = 9.6;
const KLEIN_NEURONS_PER_INPUT_TILE = 5.37;
const KLEIN_NEURONS_PER_OUTPUT_TILE = 26.05;
const MAX_ENCODED_OUTPUT_CHARACTERS = 14 * 1024 * 1024;
const MAX_STREAM_OUTPUT_BYTES = 10 * 1024 * 1024;

export type ModelOutputSpec =
  | { providerControlled: true }
  | { providerControlled: false; width: number; height: number };

export type ModelAssetSpec = {
  id: AssetKind;
  output: ModelOutputSpec;
  baseEstimatedImageNeurons: number;
};

export type ModelSpec = {
  alias: string;
  name: string;
  description: string;
  cloudflareId: string;
  supportsReference: boolean;
  productionEnabled: boolean;
  assetKinds: readonly ModelAssetSpec[];
  estimateImageNeurons: (
    asset: ModelAssetSpec,
    reference: ReferenceImage | undefined,
  ) => number;
  buildInputs: (
    prompt: string,
    seed: number | undefined,
    reference: ReferenceImage | undefined,
    asset: ModelAssetSpec,
  ) => Promise<unknown>;
};

function outputTileCount(width: number, height: number): number {
  return Math.ceil(width / 512) * Math.ceil(height / 512);
}

function controlledAsset(
  id: AssetKind,
  width: number,
  height: number,
  neuronsPerOutputTile: number,
): ModelAssetSpec {
  return {
    id,
    output: { providerControlled: false, width, height },
    baseEstimatedImageNeurons: Math.ceil(
      outputTileCount(width, height) * neuronsPerOutputTile,
    ),
  };
}

function controlledOutput(asset: ModelAssetSpec): Extract<ModelOutputSpec, { providerControlled: false }> {
  if (asset.output.providerControlled) {
    throw new Error("The selected artwork type requires controlled output dimensions");
  }
  return asset.output;
}

export function findModelAssetSpec(
  model: ModelSpec,
  assetKind: AssetKind,
): ModelAssetSpec | undefined {
  return model.assetKinds.find((asset) => asset.id === assetKind);
}

const SCHNELL_BASE_ESTIMATED_IMAGE_NEURONS = Math.ceil(
  SCHNELL_BUDGET_OUTPUT_TILES * SCHNELL_NEURONS_PER_OUTPUT_TILE +
    SCHNELL_STEPS * SCHNELL_NEURONS_PER_STEP,
);

const SCHNELL_ASSETS: readonly ModelAssetSpec[] = [
  {
    id: DEFAULT_ASSET_KIND,
    output: { providerControlled: true },
    baseEstimatedImageNeurons: SCHNELL_BASE_ESTIMATED_IMAGE_NEURONS,
  },
];

const KLEIN_ASSETS: readonly ModelAssetSpec[] = [
  controlledAsset("racer_icon", OUTPUT_EDGE, OUTPUT_EDGE, KLEIN_NEURONS_PER_OUTPUT_TILE),
  controlledAsset("medal", OUTPUT_EDGE, OUTPUT_EDGE, KLEIN_NEURONS_PER_OUTPUT_TILE),
  controlledAsset(
    "milestone_banner",
    MILESTONE_BANNER_WIDTH,
    MILESTONE_BANNER_HEIGHT,
    KLEIN_NEURONS_PER_OUTPUT_TILE,
  ),
  controlledAsset(
    "route_map",
    ROUTE_MAP_WIDTH,
    ROUTE_MAP_HEIGHT,
    KLEIN_NEURONS_PER_OUTPUT_TILE,
  ),
];

const DISABLED_MEDAL_ASSETS: readonly ModelAssetSpec[] = [
  {
    id: DEFAULT_ASSET_KIND,
    output: { providerControlled: false, width: OUTPUT_EDGE, height: OUTPUT_EDGE },
    baseEstimatedImageNeurons: 10_000,
  },
];

function withSeed<T extends Record<string, unknown>>(inputs: T, seed?: number): T {
  if (seed !== undefined) (inputs as Record<string, unknown>).seed = seed;
  return inputs;
}

async function stableDiffusionInputs(
  prompt: string,
  seed: number | undefined,
  reference: ReferenceImage | undefined,
  asset: ModelAssetSpec,
  steps: number,
): Promise<unknown> {
  const output = controlledOutput(asset);
  return withSeed(
    {
      prompt,
      negative_prompt: NEGATIVE_PROMPT,
      width: output.width,
      height: output.height,
      num_steps: steps,
      guidance: 7.5,
      ...(reference ? { image_b64: bytesToBase64(reference.bytes), strength: 0.62 } : {}),
    },
    seed,
  );
}

async function multipartFluxInputs(
  prompt: string,
  seed: number | undefined,
  reference: ReferenceImage | undefined,
  asset: ModelAssetSpec,
): Promise<unknown> {
  const output = controlledOutput(asset);
  const form = new FormData();
  form.set("prompt", prompt);
  form.set("width", String(output.width));
  form.set("height", String(output.height));
  if (seed !== undefined) form.set("seed", String(seed));
  if (reference) {
    const extension = reference.mimeType === "image/jpeg" ? "jpg" : reference.mimeType.split("/")[1];
    const source = reference.bytes.buffer.slice(
      reference.bytes.byteOffset,
      reference.bytes.byteOffset + reference.bytes.byteLength,
    ) as ArrayBuffer;
    form.set("input_image_0", new Blob([source], { type: reference.mimeType }), `reference.${extension}`);
  }

  const encoded = new Request("https://multipart.invalid/", { method: "POST", body: form });
  const contentType = encoded.headers.get("content-type");
  if (!encoded.body || !contentType) throw new Error("Unable to encode multipart model request");
  return { multipart: { body: encoded.body, contentType } };
}

export const MODEL_SPECS: readonly ModelSpec[] = [
  {
    alias: "flux-schnell",
    name: "Flux Schnell",
    description: "Fast completion-medal artwork; not available for maps or banners",
    cloudflareId: "@cf/black-forest-labs/flux-1-schnell",
    supportsReference: false,
    productionEnabled: true,
    assetKinds: SCHNELL_ASSETS,
    estimateImageNeurons: () => SCHNELL_BASE_ESTIMATED_IMAGE_NEURONS,
    buildInputs: async (prompt, seed) => withSeed({ prompt, steps: SCHNELL_STEPS }, seed),
  },
  {
    alias: "sdxl-lightning",
    name: "SDXL Lightning",
    description: "Fast graphic and illustrative styles",
    cloudflareId: "@cf/bytedance/stable-diffusion-xl-lightning",
    supportsReference: true,
    productionEnabled: false,
    assetKinds: DISABLED_MEDAL_ASSETS,
    estimateImageNeurons: () => 10_000,
    buildInputs: (prompt, seed, reference, asset) =>
      stableDiffusionInputs(prompt, seed, reference, asset, 4),
  },
  {
    alias: "sdxl-base",
    name: "SDXL",
    description: "Versatile classic image generation",
    cloudflareId: "@cf/stabilityai/stable-diffusion-xl-base-1.0",
    supportsReference: true,
    productionEnabled: false,
    assetKinds: DISABLED_MEDAL_ASSETS,
    estimateImageNeurons: () => 10_000,
    buildInputs: (prompt, seed, reference, asset) =>
      stableDiffusionInputs(prompt, seed, reference, asset, 20),
  },
  {
    alias: "flux2-klein-4b",
    name: "Flux 2 Klein",
    description: "Modern generation and reference-image editing",
    cloudflareId: "@cf/black-forest-labs/flux-2-klein-4b",
    supportsReference: true,
    productionEnabled: true,
    assetKinds: KLEIN_ASSETS,
    estimateImageNeurons: (asset, reference) => {
      const output = controlledOutput(asset);
      const inputTiles = reference
        ? Math.ceil(reference.width / 512) * Math.ceil(reference.height / 512)
        : 0;
      return Math.ceil(
        outputTileCount(output.width, output.height) * KLEIN_NEURONS_PER_OUTPUT_TILE +
          inputTiles * KLEIN_NEURONS_PER_INPUT_TILE,
      );
    },
    buildInputs: multipartFluxInputs,
  },
  {
    alias: "phoenix",
    name: "Phoenix",
    description: "Strong prompt adherence and decorative detail",
    cloudflareId: "@cf/leonardo/phoenix-1.0",
    supportsReference: false,
    productionEnabled: false,
    assetKinds: DISABLED_MEDAL_ASSETS,
    estimateImageNeurons: () => 10_000,
    buildInputs: async (prompt, seed) =>
      withSeed(
        {
          prompt,
          negative_prompt: NEGATIVE_PROMPT,
          width: OUTPUT_EDGE,
          height: OUTPUT_EDGE,
          num_steps: 20,
          guidance: 4,
        },
        seed,
      ),
  },
  {
    alias: "lucid-origin",
    name: "Lucid Origin",
    description: "Polished designs with crisp material rendering",
    cloudflareId: "@cf/leonardo/lucid-origin",
    supportsReference: false,
    productionEnabled: false,
    assetKinds: DISABLED_MEDAL_ASSETS,
    estimateImageNeurons: () => 10_000,
    buildInputs: async (prompt, seed) =>
      withSeed(
        {
          prompt,
          width: OUTPUT_EDGE,
          height: OUTPUT_EDGE,
          num_steps: 20,
          guidance: 4.5,
        },
        seed,
      ),
  },
  {
    alias: "flux2-dev",
    name: "Flux 2 Dev",
    description: "Highest-detail option with reference-image support",
    cloudflareId: "@cf/black-forest-labs/flux-2-dev",
    supportsReference: true,
    productionEnabled: false,
    assetKinds: DISABLED_MEDAL_ASSETS,
    estimateImageNeurons: () => 10_000,
    buildInputs: multipartFluxInputs,
  },
] as const;

const MODEL_BY_ALIAS = new Map(MODEL_SPECS.map((model) => [model.alias, model]));

export function enabledModelSpecs(config: string | undefined): ModelSpec[] {
  const enabled = new Set(
    (config ?? "flux2-klein-4b,flux-schnell")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return MODEL_SPECS.filter((model) => model.productionEnabled && enabled.has(model.alias));
}

export function findEnabledModel(alias: string, config: string | undefined): ModelSpec | undefined {
  const model = MODEL_BY_ALIAS.get(alias);
  return model && enabledModelSpecs(config).some((candidate) => candidate.alias === alias)
    ? model
    : undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
  let result = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(result);
}

function base64ToBytes(encoded: string): Uint8Array {
  if (encoded.length > MAX_ENCODED_OUTPUT_CHARACTERS) {
    throw new Error("Model returned an image that is too large");
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function readBoundedStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_STREAM_OUTPUT_BYTES) throw new Error("Model returned an image that is too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof value === "object" && value !== null && "getReader" in value;
}

export async function runImageModel(
  ai: AiBinding,
  model: ModelSpec,
  asset: ModelAssetSpec,
  prompt: string,
  seed: number | undefined,
  reference: ReferenceImage | undefined,
): Promise<Uint8Array> {
  const inputs = await model.buildInputs(prompt, seed, reference, asset);
  const result = await ai.run(model.cloudflareId, inputs);
  if (isReadableStream(result)) return readBoundedStream(result);
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (result instanceof Uint8Array) return result;
  if (typeof result === "object" && result !== null && "image" in result) {
    const encoded = (result as { image?: unknown }).image;
    if (typeof encoded === "string") return base64ToBytes(encoded);
  }
  throw new Error("Model returned an unsupported response format");
}
