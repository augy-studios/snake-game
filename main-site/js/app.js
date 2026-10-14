import { COLOR_THEMES, applyColorTheme, applyMode, getStoredColorTheme, getStoredMode, getModePreference, initTheme } from "./theme.js";
import { hydrateIcons, openModal, closeModal, closeTopModal, store } from "./ui.js";
import { initUpdateBar } from "./update-bar.js";
import { initGame } from "./game.js";
import { initLeaderboard, openLeaderboard } from "./leaderboard.js";
import { initSettings, openSettings } from "./settings.js";
import { initParty, openParty, partyHooks } from "./party.js";
import { initSlither } from "./slither-game.js";
import { initLadders } from "./ladders-game.js";
import { cleanSlitherReplay } from "./slither-replay.js";
import { api } from "./api.js";
import { cleanReplay, unpackReplay } from "./replay-format.js";
import { normaliseCode } from "./p2p.js";

/* Theme modal, per uwuapps-theme.md section 6. */

function buildThemeModal() {
  const grid = document.getElementById("swatchGrid");
  grid.innerHTML = COLOR_THEMES.map(
    (t) => `
      <button class="swatch" data-theme-id="${t.id}" style="--swatch-color:${t.hex}" type="button" aria-label="${t.label}">
        <span class="swatch-dot"></span>
        <span class="swatch-label">${t.label}</span>
      </button>`
  ).join("");

  syncThemeModalState();

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-theme-id]");
    if (!btn) return;
    applyColorTheme(btn.dataset.themeId);
    syncThemeModalState();
  });

  document.getElementById("modeToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mode]");
    if (!btn) return;
    applyMode(btn.dataset.mode);
    syncThemeModalState();
  });

  // A tab left open across 09:00 or 18:00 re-resolves itself; redraw the
  // modal so the note and pressed state stay in step with the change.
  document.addEventListener("uwu:modechange", syncThemeModalState);
}

function syncThemeModalState() {
  const activeTheme = getStoredColorTheme();
  const activePreference = getModePreference();
  const resolvedMode = getStoredMode();

  document.querySelectorAll("#swatchGrid .swatch").forEach((el) => {
    el.classList.toggle("active", el.dataset.themeId === activeTheme);
  });
  document.querySelectorAll("#modeToggle .mode-btn").forEach((el) => {
    const isActive = el.dataset.mode === activePreference;
    el.classList.toggle("active", isActive);
    el.setAttribute("aria-pressed", String(isActive));
  });

  const note = document.getElementById("modeNote");
  if (note) {
    note.hidden = activePreference !== "time";
    if (activePreference === "time") {
      note.textContent = `Following the clock. Currently ${resolvedMode}.`;
    }
  }

  updateThemeButtonIcon();
}

function updateThemeButtonIcon() {
  const span = document.querySelector("#themeBtn [data-icon]");
  span.setAttribute("data-icon", getStoredMode() === "dark" ? "moon" : "sun");
  hydrateIcons(document.getElementById("themeBtn"));
}

/* The edge tray, per edge-tray-spec.md: leaderboard, party, settings, theme
   and full screen, sliding off the right edge to leave an arrow tab. Open
   until somebody closes it; remembered in this browser. */

const TRAY_KEY = "uwusnek.trayOpen";

function setTray(open, { save = true } = {}) {
  const tray = document.getElementById("tray");
  const tab = document.getElementById("trayTab");
  tray.classList.toggle("collapsed", !open);
  tab.setAttribute("aria-expanded", String(open));
  tab.setAttribute("aria-label", open ? "Hide menu" : "Show menu");
  tab.title = open ? "Hide menu" : "Show menu";
  // Off screen buttons must not take focus or clicks.
  document.getElementById("trayButtons").inert = !open;
  document.body.classList.toggle("tray-open", open);
  if (save) store.set(TRAY_KEY, open ? "1" : "0");
}

function initTray() {
  setTray(store.get(TRAY_KEY) !== "0", { save: false });
  // The pre-paint script started a collapsed tray shut with no transition;
  // from the next frame on, toggles animate.
  requestAnimationFrame(() => document.documentElement.classList.remove("tray-start-collapsed"));
  document.getElementById("trayTab").addEventListener("click", () => {
    setTray(document.getElementById("tray").classList.contains("collapsed"));
  });
}

/* Full screen, where the browser allows it. Safari on iPhone does not, and
   there the button goes: added to the home screen, the app is full screen
   already. */

function initFullscreen() {
  const btn = document.getElementById("fullBtn");
  const root = document.documentElement;
  const enabled = Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  btn.hidden = !enabled;
  if (!enabled) return;
  const current = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  const sync = () => {
    const full = Boolean(current());
    const label = full ? "Leave full screen" : "Full screen";
    btn.setAttribute("aria-label", label);
    btn.title = label;
    btn.querySelector("[data-icon]").setAttribute("data-icon", full ? "shrink" : "expand");
    hydrateIcons(btn);
  };
  btn.addEventListener("click", async () => {
    try {
      if (current()) await (document.exitFullscreen?.call(document) ?? document.webkitExitFullscreen?.call(document));
      else await (root.requestFullscreen?.call(root, { navigationUI: "hide" }) ?? root.webkitRequestFullscreen?.call(root));
    } catch {
      // Refused: the page stays as it is.
    }
  });
  document.addEventListener("fullscreenchange", sync);
  document.addEventListener("webkitfullscreenchange", sync);
  sync();
}

function wireModals(game, slither, ladders) {
  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
  });
  document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal(backdrop.id);
    });
  });
  document.addEventListener("keydown", (e) => {
    // Handled, so the game does not take the same Esc for itself.
    if (e.key === "Escape" && closeTopModal()) e.preventDefault();
  });

  // Every window stops a game on this device first. Closing it leaves the
  // game paused, so nothing moves while the player finds their place again.
  const pausing = (open) => () => {
    game.pause();
    slither.pause();
    ladders.pause();
    open();
  };
  document.getElementById("themeBtn").addEventListener("click", pausing(() => openModal("themeModal")));
  document.getElementById("boardBtn").addEventListener("click", pausing(() => openLeaderboard()));
  document.getElementById("settingsBtn").addEventListener("click", pausing(openSettings));
  // In a Slither world, the people button shows that world's join code.
  document.getElementById("partyBtn").addEventListener("click", () => (slither.inWorld ? slither.openWorld() : openParty()));
  document.getElementById("startPartyBtn").addEventListener("click", () => openParty());
}

/* Links that open something: /join?id=CODE from a party's QR code,
   /r/<id> for a stored replay, and /?replay=... for one in the link. */

async function openLink(game, slither) {
  const path = location.pathname;
  const params = new URLSearchParams(location.search);

  if (path === "/join") {
    const code = normaliseCode(params.get("id"));
    history.replaceState(null, "", "/");
    game.showStart();
    openParty({ code });
    return;
  }

  const short = path.match(/^\/r\/([A-Za-z0-9]{8})$/);
  if (short) {
    await watchStored(game, slither, short[1], { fromLink: true });
    return;
  }

  if (params.has("replay")) {
    const replay = await unpackReplay(params.get("replay"));
    if (replay && game.openReplay(replay, { shared: true })) return;
    history.replaceState(null, "", "/");
    game.showStart({ message: "That replay link is damaged or from a newer version." });
    return;
  }

  game.showStart();
}

// A stored replay, from its link or from the leaderboard. From the board,
// whatever was on screen stays underneath, to go back to after.
async function watchStored(game, slither, id, { fromLink = false } = {}) {
  if (fromLink) game.showStart({ message: "Loading the replay." });
  try {
    const data = await api.replay(id);
    if (data.kind === "slither") {
      await slither.prepare();
      const sreplay = cleanSlitherReplay(data.replay);
      if (sreplay && slither.openReplay(sreplay, { shared: true, verified: data.verified })) return;
      throw new Error("unplayable");
    }
    const replay = cleanReplay(data.replay);
    if (replay && game.openReplay(replay, { shared: true, verified: data.verified })) return;
    throw new Error("unplayable");
  } catch (err) {
    const message =
      err.code === "offline"
        ? "Watching a shared replay needs a connection."
        : err.code === "replay_not_found"
          ? "There is no replay at that link."
          : "That replay did not load. Try again in a moment.";
    if (fromLink) {
      history.replaceState(null, "", "/");
      game.showStart({ message });
    } else {
      openLeaderboard();
      document.getElementById("boardNote").textContent = message;
    }
  }
}

function boot() {
  initTheme();
  hydrateIcons();
  updateThemeButtonIcon();
  buildThemeModal();
  initTray();
  initFullscreen();
  initSettings();
  const hooks = { ...partyHooks };
  const game = initGame(hooks);
  const slither = initSlither({ showStart: (opts) => game.showStart(opts) });
  const ladders = initLadders({ showStart: (opts) => game.showStart(opts) });
  hooks.startSlither = (opts) => slither.start(opts);
  hooks.startLadders = (opts) => ladders.start(opts);
  initLeaderboard({
    onWatch: (id) => {
      closeModal("boardModal");
      watchStored(game, slither, id);
    },
  });
  initParty(game, { onSlither: (guest, code, hello) => slither.joinWith(guest, code, hello) });
  wireModals(game, slither, ladders);
  openLink(game, slither);
  initUpdateBar();
}

boot();
