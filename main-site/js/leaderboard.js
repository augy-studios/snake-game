// The leaderboard window: best score or total points, one row per name,
// after MRT Station Guesser's. A best game's row links to its replay.

import { api } from "./api.js";
import { escapeHtml, openModal } from "./ui.js";

const BOARDS = {
  best: {
    head: ["#", "Name", "Score", "Length", ""],
    row: (e) => [e.rank, e.name, e.score, e.length],
    about: "Each name's single best game. The play button shows how it went.",
  },
  total: {
    head: ["#", "Name", "Total", "Games"],
    row: (e) => [e.rank, e.name, e.total, e.games],
    about: "Every game added under a name, scores added up.",
  },
};

let board = "best";
let loading = 0;

function setTab(next) {
  board = BOARDS[next] ? next : "best";
  document.querySelectorAll("#boardTabs [data-board]").forEach((el) => {
    const on = el.dataset.board === board;
    el.classList.toggle("active", on);
    el.setAttribute("aria-selected", String(on));
  });
}

function watchCell(e) {
  if (board !== "best") return "";
  if (!e.replay_id) return "<td></td>";
  const id = escapeHtml(e.replay_id);
  return `<td><a class="board-watch" href="/r/${id}" aria-label="Watch ${escapeHtml(e.name)}'s game">Watch</a></td>`;
}

async function load() {
  const body = document.getElementById("boardBody");
  const note = document.getElementById("boardNote");
  const ticket = ++loading;
  const spec = BOARDS[board];
  body.setAttribute("aria-busy", "true");
  note.textContent = spec.about;

  try {
    const data = await api.leaderboard(board);
    if (ticket !== loading) return;
    const entries = data.entries ?? [];
    body.innerHTML = entries.length
      ? `<table class="board-table">
          <thead><tr>${spec.head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead>
          <tbody>${entries
            .map((e) => `<tr>${spec.row(e).map((v) => `<td>${escapeHtml(v)}</td>`).join("")}${watchCell(e)}</tr>`)
            .join("")}</tbody>
        </table>`
      : `<p class="board-empty">No scores yet. Finish a game and add yours.</p>`;
  } catch (err) {
    if (ticket !== loading) return;
    body.innerHTML = `<p class="board-empty">${
      err.code === "offline" ? "The leaderboard needs a connection." : "The leaderboard did not load. Try again in a moment."
    }</p>`;
  } finally {
    if (ticket === loading) body.removeAttribute("aria-busy");
  }
}

export function openLeaderboard(which = board) {
  setTab(which);
  openModal("boardModal");
  load();
}

// `onWatch(id)` plays a board's replay in place, rather than reloading the
// page on its link.
export function initLeaderboard({ onWatch } = {}) {
  document.getElementById("boardTabs").addEventListener("click", (e) => {
    const tab = e.target.closest("[data-board]");
    if (!tab || tab.dataset.board === board) return;
    setTab(tab.dataset.board);
    load();
  });
  document.getElementById("boardBody").addEventListener("click", (e) => {
    const link = e.target.closest(".board-watch");
    if (!link || !onWatch) return;
    e.preventDefault();
    onWatch(link.getAttribute("href").slice(3));
  });
}
