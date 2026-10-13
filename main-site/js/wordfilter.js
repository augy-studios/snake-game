// The word filter, shared by the leaderboard API (api/_lib/names.js), which
// checks every name a person picks, and Slither, which names its computer
// snakes from wordlist.json. Pure: no DOM, nothing server only.

// Matched anywhere in the squashed name. Long or unambiguous only, so an
// ordinary word does not trip it.
const ANYWHERE = [
  "fuck", "fck", "shit", "cunt", "bitch", "nigger", "nigga", "faggot", "asshole", "bastard",
  "wanker", "whore", "pussy", "penis", "vagina", "porn", "retard", "twat", "dildo", "blowjob",
  "motherf", "hitler", "cocksuck", "jerkoff", "wetback", "towelhead", "raghead",
  // Singlish, Hokkien and Malay.
  "lanjiao", "lanjio", "chibai", "cheebye", "cheebai", "pukimak", "kanina", "kannina", "nabeh",
  "knnbccb",
  // Chinese.
  "操你", "肏", "屄", "屌", "妈的", "他妈", "傻逼", "傻屄", "煞笔", "贱人", "婊子", "鸡巴", "狗日",
  "草泥马", "王八蛋", "日你", "干你", "你妈", "去死", "滚蛋", "强奸",
];

// Matched only as a whole word, since each is also part of harmless words:
// "assist", "cocktail", "grape", "Dickson", "therapist", "torpedo",
// "raccoon", "cocoon".
const WHOLE_WORD = new Set([
  "ass", "cock", "dick", "dicks", "rape", "raped", "rapes", "rapist", "fag", "fags", "slut", "sluts",
  "tits", "cum", "sex", "nazi", "nazis", "pedo", "chink", "chinks", "gook", "gooks", "coon", "coons",
  "dyke", "dykes", "kike", "kikes", "spic", "spics", "tranny", "retards", "negro", "negroes",
  "knn", "ccb", "cb", "puki", "kkb", "wtf", "stfu",
]);

const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", 9: "g" };
const unleet = (s) => s.replace(/[0-9]/g, (d) => LEET[d] ?? d);

export function profane(name) {
  const lower = name.toLowerCase();
  const squashed = unleet(lower.replace(/[\s_-]+/g, ""));
  if (ANYWHERE.some((w) => squashed.includes(w))) return true;
  const words = lower.split(/[\s_-]+/).map(unleet);
  return words.some((w) => WHOLE_WORD.has(w));
}

// Stricter for the names the game gives its own snakes, which everybody
// sees and nobody chose: nothing rude, nothing adult, nothing violent, and
// no groups of people.
const NOT_FOR_SNAKES = new Set([
  "anal", "anus", "boner", "semen", "sperm", "crap", "piss", "turd", "pimp", "pimps", "hooker",
  "hookers", "scrotum", "testicle", "testicles", "orgasm", "orgasms", "orgy", "orgies", "erotic",
  "sexy", "kinky", "fetish", "incest", "molest", "molests", "suicide", "murder", "murders",
  "murderer", "killer", "killers", "nazism", "heroin", "cocaine", "bigot", "bigots", "gypsy",
  "gypsies", "midget", "midgets", "queer", "queers", "homo", "homos", "lesbo", "jizz", "titty",
  "breast", "breasts", "nipple", "nipples", "condom", "condoms", "viagra", "drunk", "junkie",
  "rapists", "slave", "slaves", "slavery", "abortion", "abortions", "abortionist", "abortionists",
  "bomb", "bombs", "bomber", "terror", "terrorist", "terrorists", "corpse", "corpses", "torture",
  "genocide", "lynch", "lynching", "racist", "racists", "nude", "nudes", "nudity", "naked",
  "harlot", "strumpet", "bimbo", "pervert", "perverts", "satan", "satanic", "damn", "damned",
]);

// Whether a word from the word list may name a computer snake.
export function fitForSnake(word) {
  if (!/^[A-Za-z]{4,9}$/.test(word)) return false;
  return !profane(word) && !NOT_FOR_SNAKES.has(word.toLowerCase());
}
