// Player settings, kept in this browser, after MRT Station Guesser's: the
// leaderboard name, adding games automatically, and the difficulty and time
// limits that scale the points. The game reads them through getSettings()
// and hears about changes on the "uwusnek:settings" event. Changes count
// from the next game.

import { api } from "./api.js";
import { DIFFICULTIES, FRUIT_LIMITS, GAME_LIMITS, cleanSettings } from "./rules.js";
import { openModal } from "./ui.js";

const STORAGE = "uwusnek.settings";

const DEFAULTS = {
  name: null,
  auto_submit: false,
  difficulty: "normal",
  start_level: 0,
  game_seconds: 0,
  fruit_seconds: 0,
};

let current = null;

function load() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE) ?? "{}") ?? {};
  } catch {
    // Unreadable or blocked storage: the defaults.
  }
  const out = { ...DEFAULTS, ...cleanSettings(saved) };
  if (typeof saved.name === "string" && saved.name.trim()) out.name = saved.name.trim();
  out.auto_submit = saved.auto_submit === true;
  // Adding games automatically needs a name to add them under.
  if (!out.name) out.auto_submit = false;
  return out;
}

export function getSettings() {
  current ??= load();
  return { ...current };
}

// The four that change the game, in the form js/rules.js takes.
export function gameSettings() {
  return cleanSettings(getSettings());
}

export function saveSettings(changes) {
  current = { ...getSettings(), ...changes };
  current = { ...current, ...cleanSettings(current) };
  if (!current.name) current.auto_submit = false;
  try {
    localStorage.setItem(STORAGE, JSON.stringify(current));
  } catch {
    // Kept for this page view only.
  }
  render();
  document.dispatchEvent(new CustomEvent("uwusnek:settings", { detail: getSettings() }));
  return getSettings();
}

const minutes = (s) => (s % 60 ? `${s} s` : `${s / 60} min`);

// One line for the pre-game screen: what the next game will be.
export function describeSettings(s = getSettings()) {
  const parts = [DIFFICULTIES[s.difficulty].label];
  parts.push(s.game_seconds ? `${minutes(s.game_seconds)} game` : "no game limit");
  parts.push(s.fruit_seconds ? `${s.fruit_seconds} s per fruit` : "no fruit timer");
  return parts.join(", ");
}

const $ = (id) => document.getElementById(id);

function render() {
  const s = getSettings();
  $("clearNameBtn").classList.toggle("hidden", !s.name);
  $("savedName").textContent = `Now: ${s.name ?? "Not set"}`;

  document.querySelectorAll("#settingsModal [data-setting]").forEach((el) => {
    const on = s[el.dataset.setting];
    el.setAttribute("aria-checked", String(on));
    el.querySelector(".switch-state").textContent = on ? "On" : "Off";
  });
  const auto = document.querySelector('[data-setting="auto_submit"]');
  auto.disabled = !s.name;
  $("autoNote").classList.toggle("hidden", Boolean(s.name));

  const press = (selector, isOn) =>
    document.querySelectorAll(selector).forEach((el) => {
      const on = isOn(el);
      el.classList.toggle("active", on);
      el.setAttribute("aria-pressed", String(on));
    });
  press("#difficultyToggle [data-difficulty]", (el) => el.dataset.difficulty === s.difficulty);
  press("#gameLimitToggle [data-game]", (el) => Number(el.dataset.game) === s.game_seconds);
  press("#fruitLimitToggle [data-fruit]", (el) => Number(el.dataset.fruit) === s.fruit_seconds);
  $("scoringNote").textContent = scoringNote(s);
}

// The multipliers the current choice adds up to, so the trade is visible.
function scoringNote(s) {
  const total = DIFFICULTIES[s.difficulty].mult * GAME_LIMITS[s.game_seconds] * FRUIT_LIMITS[s.fruit_seconds];
  return `Points times ${Math.round(total * 100) / 100} at these settings, before the level and how quickly you reach each fruit.`;
}

async function onSaveName(event) {
  event.preventDefault();
  const input = $("settingsName");
  const msg = $("nameMsg");
  const name = input.value.trim();
  if (!name) {
    msg.textContent = "Enter a name.";
    input.focus();
    return;
  }
  $("saveNameBtn").disabled = true;
  msg.textContent = "";
  try {
    // The API cleans and checks it, the same check a submission gets.
    const result = await api.checkName(name);
    saveSettings({ name: result.name });
    input.value = "";
    msg.textContent = "Saved.";
  } catch (err) {
    msg.textContent =
      err.code === "offline"
        ? "Checking a name needs a connection."
        : err.message || "That did not go through. Try again in a moment.";
  } finally {
    $("saveNameBtn").disabled = false;
  }
}

export function openSettings() {
  $("nameMsg").textContent = "";
  $("settingsName").value = "";
  render();
  openModal("settingsModal");
}

export function initSettings() {
  $("nameForm").addEventListener("submit", onSaveName);
  $("clearNameBtn").addEventListener("click", () => {
    saveSettings({ name: null });
    $("nameMsg").textContent = "Name cleared.";
  });
  document.querySelectorAll("#settingsModal [data-setting]").forEach((el) => {
    el.addEventListener("click", () => saveSettings({ [el.dataset.setting]: !getSettings()[el.dataset.setting] }));
  });
  $("difficultyToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-difficulty]");
    if (btn) saveSettings({ difficulty: btn.dataset.difficulty });
  });
  $("gameLimitToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-game]");
    if (btn) saveSettings({ game_seconds: Number(btn.dataset.game) });
  });
  $("fruitLimitToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-fruit]");
    if (btn) saveSettings({ fruit_seconds: Number(btn.dataset.fruit) });
  });
  render();
}
