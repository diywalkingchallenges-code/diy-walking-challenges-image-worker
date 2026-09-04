export const MAX_USER_PROMPT_CODE_POINTS = 50;
export const MIN_USER_PROMPT_CODE_POINTS = 3;

export const ASSET_KINDS = ["medal", "milestone_banner", "route_map"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const DEFAULT_ASSET_KIND: AssetKind = "medal";

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

export function sanitizeUserPrompt(input: string): string {
  return input
    .normalize("NFKC")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(BIDI_CONTROLS, "")
    .replaceAll("<", "‹")
    .replaceAll(">", "›")
    .replace(/\s+/gu, " ")
    .trim();
}

export function countCodePoints(input: string): number {
  return Array.from(input).length;
}

export function isAssetKind(value: unknown): value is AssetKind {
  return typeof value === "string" && (ASSET_KINDS as readonly string[]).includes(value);
}

export function buildMedalPrompt(userPrompt: string): string {
  return `Create an elaborate premium collectible challenge medal themed around: ${userPrompt}

Design the artwork specifically around the theme. Use a distinctive irregular die-cut shape created by the thematic artwork itself, with elements extending beyond the edges. Avoid a conventional round, oval, shield, or badge-shaped medal.

Use a cohesive theme-appropriate palette of colorful hard enamel, with raised antique-metal outlines, deep sculptural 3D relief, overlapping metal layers, cutouts, and intricate dimensional details. Colors should enhance the subject naturally, not be randomly rainbow-colored.

Cover the entire face of the medal with thematic artwork and decorative metalwork. Use imagery, patterns, enamel, textures, and sculptural details all the way to the lower edge. The design contains artwork only, with no written language anywhere.

One complete medal hanging from a premium woven ribbon. Photorealistic studio product photo, mostly frontal, realistic metal and glossy enamel, sharp detail.

Originality requirement: Create new artwork. Do not reproduce an existing commercial medal, brand logo, trademark, copyrighted character, signature, or watermark.`;
}

export function buildMilestoneBannerPrompt(userPrompt: string): string {
  return `Create an original wide milestone story banner themed around: ${userPrompt}

Compose a cinematic 2:1 landscape scene with one clear focal subject and an immersive, edge-to-edge background. Keep the most important subject matter inside the central safe area so it remains clear on different phone screens.

Make the scene polished, atmospheric, richly detailed, and suitable for celebrating progress in a walking challenge. Do not include a frame, device screen, product mockup, interface controls, route line, map pins, or checkpoint markers.

The artwork contains no written language anywhere: no title, words, letters, numbers, labels, logos, signatures, or watermarks.

Originality requirement: Create new artwork. Do not reproduce an existing commercial image, branded visual style, trademark, copyrighted character, signature, or watermark.`;
}

export function buildRouteMapPrompt(userPrompt: string): string {
  return `Create an original decorative illustrated route-map background themed around: ${userPrompt}

Use a top-down or near-orthographic 4:3 composition with cohesive terrain, open areas, natural paths, and visually distinct landmarks distributed across the image. Make the route overlay easy to see by avoiding clutter and extreme contrast through the center of the map.

This is a decorative, non-navigational illustration, not a geographically accurate map. Do not draw a route line, progress path, pins, checkpoints, start or finish markers, labels, a legend, interface controls, a frame, a folded-paper mockup, or a perspective horizon.

The artwork contains no written language anywhere: no place names, words, letters, numbers, coordinates, logos, signatures, or watermarks.

Originality requirement: Create new artwork. Do not reproduce branded or copyrighted cartography, satellite imagery, a commercial map style, a trademark, copyrighted character, signature, or watermark.`;
}

export function buildAssetPrompt(assetKind: AssetKind, userPrompt: string): string {
  switch (assetKind) {
    case "medal":
      return buildMedalPrompt(userPrompt);
    case "milestone_banner":
      return buildMilestoneBannerPrompt(userPrompt);
    case "route_map":
      return buildRouteMapPrompt(userPrompt);
  }
}

export const NEGATIVE_PROMPT = [
  "existing brand logo",
  "trademark",
  "copyrighted character",
  "commercial product replica",
  "watermark",
  "signature",
  "blurry",
  "cropped medal",
  "multiple medals",
  "round medal",
  "oval medal",
  "shield-shaped medal",
  "badge-shaped medal",
  "written language",
  "words",
  "letters",
  "numbers",
  "typography",
  "random rainbow colors",
  "hands",
  "photographic mockup",
].join(", ");
