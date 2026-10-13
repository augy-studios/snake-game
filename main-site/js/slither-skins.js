// Slither skins: a sequence of colours from a palette laid down the body,
// a pattern for how they are laid, and an outfit on the head. Players build
// their own; computer snakes get random ones.
//
// A skin travels between devices as a short code, "pattern.outfit.c-c-c",
// for example "b.crown.3-17-17-29". cleanSkin turns anything received into
// a code that is safe to draw.

// The palette, after slither.io's builder: forty colours, a few of them
// starred. Fixed colours like the theme's fixed-meaning accents: a skin
// looks the same whatever theme the viewer has chosen.
export const PALETTE = [
  { hex: "#e0383e" }, { hex: "#b9bcc4" }, { hex: "#1f2fa8" }, { hex: "#a8161c" }, { hex: "#a8a22c" },
  { hex: "#8a5a2b" }, { hex: "#a83aa0" }, { hex: "#2e8a3a" }, { hex: "#4a64d8" }, { hex: "#5a2a9a" },
  { hex: "#2333c8" }, { hex: "#8a44d8" }, { hex: "#d8b420" }, { hex: "#2a3ec8", star: true }, { hex: "#3448d8", star: true },
  { hex: "#5a28b4" }, { hex: "#e0640c" }, { hex: "#4ab4d0" }, { hex: "#9aa0a8" }, { hex: "#2a9a3c" },
  { hex: "#1ed060" }, { hex: "#d03238" }, { hex: "#c022c0" }, { hex: "#e4e4e8" }, { hex: "#6a74c8", star: true },
  { hex: "#3c3c44" }, { hex: "#e09a2c" }, { hex: "#1f6e4c" }, { hex: "#4a5cd0" }, { hex: "#6670c8" },
  { hex: "#2838c0" }, { hex: "#a274d8" }, { hex: "#7c88d8" }, { hex: "#5ab4b8" }, { hex: "#7aff7a" },
  { hex: "#d4c450" }, { hex: "#e0844a" }, { hex: "#e08a8a" }, { hex: "#e0283a" }, { hex: "#ffffff" },
];

export const PATTERNS = [
  { id: "b", label: "Bands" },
  { id: "s", label: "Stripes" },
  { id: "d", label: "Spots" },
];

export const OUTFITS = [
  { id: "none", label: "None" },
  { id: "crown", label: "Crown" },
  { id: "party", label: "Party hat" },
  { id: "tophat", label: "Top hat" },
  { id: "bow", label: "Bow" },
  { id: "shades", label: "Shades" },
  { id: "halo", label: "Halo" },
];

export const MAX_COLORS = 12;

// Ready-made skins, for a quick pick.
export const PRESETS = [
  "b.none.20",
  "b.none.0",
  "b.none.10",
  "b.none.12",
  "s.none.0-39",
  "s.none.10-39-0",
  "b.none.13-14",
  "b.crown.12-16-12",
  "b.none.6-22-31",
  "s.none.25-23",
  "d.none.34-19",
  "b.halo.39-23-1",
  "b.party.16-26-35",
  "s.shades.9-11-15",
];

export const DEFAULT_SKIN = "b.none.20";

export function parseSkin(code) {
  const [pattern, outfit, list] = String(code ?? "").split(".");
  const colors = String(list ?? "")
    .split("-")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n < PALETTE.length)
    .slice(0, MAX_COLORS);
  return {
    pattern: PATTERNS.some((p) => p.id === pattern) ? pattern : "b",
    outfit: OUTFITS.some((o) => o.id === outfit) ? outfit : "none",
    colors: colors.length ? colors : [20],
  };
}

export function skinCode({ pattern, outfit, colors }) {
  return `${pattern}.${outfit}.${colors.join("-")}`;
}

export const cleanSkin = (code) => skinCode(parseSkin(code));

// Which palette entry segment i wears.
export function colorAt(skin, i) {
  const run = skin.pattern === "s" ? 1 : 3;
  return skin.colors[Math.floor(i / run) % skin.colors.length];
}

/* ---- Storage ---- */

const SKIN_KEY = "uwusnek.skin";
const NAME_KEY = "uwusnek.slitherName";

export function storedSkin(store) {
  return cleanSkin(store.get(SKIN_KEY) ?? DEFAULT_SKIN);
}

export function saveSkin(store, code) {
  store.set(SKIN_KEY, cleanSkin(code));
}

export function storedName(store) {
  return String(store.get(NAME_KEY) ?? "").slice(0, 20);
}

export function saveName(store, name) {
  store.set(NAME_KEY, String(name ?? "").trim().slice(0, 20));
}
