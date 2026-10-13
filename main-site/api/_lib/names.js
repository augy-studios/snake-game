// Leaderboard display names. All validation is here, server side.

import { HttpError } from "./http.js";
import { profane } from "../../js/wordfilter.js";

const MAX_LENGTH = 20;

// Letters in any script (CJK included), with at most two combining marks
// each so Tamil and other Indic names work but stacked marks do not; digits,
// spaces, hyphens and underscores.
const ALLOWED = /^(?:[\p{L}\p{N}]\p{M}{0,2}|[ _-])+$/u;

// The word filter is shared with the page (Slither names its computer
// snakes through it), so it lives in js/wordfilter.js.
export { profane };

// Trimmed, whitespace collapsed, cut to 20 characters, then checked.
export function cleanName(value) {
  let name = typeof value === "string" ? value.normalize("NFKC") : "";
  name = name.replace(/\s+/gu, " ").trim();
  name = Array.from(name).slice(0, MAX_LENGTH).join("").trim();

  if (!name) throw new HttpError(400, "empty_name", "Enter a name.");
  if (!ALLOWED.test(name) || !/[\p{L}\p{N}]/u.test(name)) {
    throw new HttpError(400, "bad_name", "Use letters, numbers, spaces, hyphens and underscores only.");
  }
  if (profane(name)) throw new HttpError(400, "rude_name", "Pick a different name.");
  return name;
}
