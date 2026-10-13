// Plays a replay back: the game is worked out again from its inputs by
// js/rules.js, one tick at a time, with a copy of the game kept every
// KEYFRAME ticks so stepping back or dragging the timeline does not have to
// start from the beginning. No DOM here; js/game.js draws what this holds.

import { applyEvent, newGame, step, summary } from "./rules.js";

const KEYFRAME = 64;

const clone = (state) => structuredClone(state);

export class ReplayPlayer {
  constructor(replay) {
    this.replay = replay;
    this.keyframes = [];
    // Game time at every tick, for the clock and for pacing playback.
    this.timeAt = new Int32Array(replay.ticks + 1);
    // What happened on each tick that had something happen, for captions.
    this.happened = new Map();
    // Ticks a fruit was eaten on, for the timeline's marks.
    this.eatTicks = [];

    const state = this.fresh();
    let i = 0;
    this.keyframes.push({ state: clone(state), event: 0 });
    while (!state.over && state.tick < replay.ticks) {
      i = this.applyAt(state, i);
      step(state);
      this.timeAt[state.tick] = state.timeMs;
      if (state.happened.length) this.happened.set(state.tick, state.happened);
      if (state.happened.some((h) => h.type === "eat")) this.eatTicks.push(state.tick);
      if (state.tick % KEYFRAME === 0) this.keyframes.push({ state: clone(state), event: i });
    }
    this.ticks = state.tick;
    this.final = summary(state);
    this.seek(0);
  }

  fresh() {
    const r = this.replay;
    return newGame({ seed: r.seed, mode: r.mode, players: r.players.length, settings: r.settings, grid: r.grid });
  }

  // Applies the events due at the state's tick, from index i; returns the next.
  applyAt(state, i) {
    const events = this.replay.events;
    while (i < events.length && events[i][0] === state.tick) applyEvent(state, events[i++]);
    return i;
  }

  // The game as it stood after `tick` moves.
  seek(tick) {
    const t = Math.max(0, Math.min(this.ticks, tick));
    const key = this.keyframes[Math.min(this.keyframes.length - 1, Math.floor(t / KEYFRAME))];
    const state = clone(key.state);
    let i = key.event;
    while (state.tick < t) {
      i = this.applyAt(state, i);
      step(state);
    }
    this.state = state;
    this.event = i;
  }

  // One move on, from wherever it is.
  forward() {
    if (this.state.tick >= this.ticks) return false;
    this.event = this.applyAt(this.state, this.event);
    step(this.state);
    return true;
  }

  get tick() {
    return this.state.tick;
  }

  // How long the move from this tick to the next took in the game.
  durationAt(tick) {
    return tick < this.ticks ? this.timeAt[tick + 1] - this.timeAt[tick] : Infinity;
  }
}
