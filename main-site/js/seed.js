// Seeds: a short code that decides where every fruit lands, so the same code
// and the same moves always play the same game. Pure, so the leaderboard API
// can replay a game with it too.

// No 0, O, 1, I or L, so a seed read off a screen is typed back right.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 6;
export const SEED_MAX = 24;

export function makeSeed() {
  const bytes = new Uint32Array(LENGTH);
  crypto.getRandomValues(bytes);
  return [...bytes].map((n) => ALPHABET[n % ALPHABET.length]).join("");
}

// What was pasted, as a seed: case and spaces do not matter, and any other
// text is a seed too, so "long snek" plays the same game every time. Empty
// when nothing is left.
export function cleanSeed(text) {
  return String(text ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, SEED_MAX);
}

// cyrb53's 32-bit half: a string to a well-mixed number.
function hash(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

// Whole numbers from 0 up to but not including n, from mulberry32, the same
// for the same key in every browser and in Node. Integer arithmetic only.
export function seededInts(key) {
  let a = hash(key);
  return (n) => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}
