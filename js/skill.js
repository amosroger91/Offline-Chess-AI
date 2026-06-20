// ============================================================
//  skill.js  —  account-less skill tracking. A local Elo rating
//  lives in localStorage (the browser "cache"); clearing the
//  cache resets your skill. Used for the rank badge, vs-AI and
//  vs-human rating updates, and deciding Coach-assist.
// ============================================================
const KEY = "occ-skill:v1";

function defaults() { return { rating: 1000, wins: 0, losses: 0, draws: 0, games: 0 }; }

export function getSkill() {
  try { return Object.assign(defaults(), JSON.parse(localStorage.getItem(KEY)) || {}); }
  catch { return defaults(); }
}
function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} }

// score: 1 win / 0.5 draw / 0 loss. Returns { rating, delta }.
export function recordResult(score, opponentRating, K = 32) {
  const s = getSkill();
  const before = s.rating;
  const expected = 1 / (1 + Math.pow(10, (opponentRating - s.rating) / 400));
  s.rating = Math.max(100, Math.round(s.rating + K * (score - expected)));
  s.games++;
  if (score === 1) s.wins++; else if (score === 0) s.losses++; else s.draws++;
  save(s);
  return { rating: s.rating, delta: s.rating - before };
}

// Approximate ratings for the AI difficulty tiers (Stockfish skill levels).
export const AI_RATING = { 1: 600, 2: 1400, 3: 2100 };

const TIERS = [
  [0, "Wood", "#9a7b4f"],
  [800, "Bronze", "#cd7f32"],
  [1000, "Silver", "#c4ccd6"],
  [1200, "Gold", "#f4c04e"],
  [1500, "Platinum", "#7fe3d4"],
  [1800, "Diamond", "#7cc6ff"],
  [2100, "Grandmaster", "#b69bff"],
];
export function rankFor(rating) {
  let t = TIERS[0];
  for (const tier of TIERS) if (rating >= tier[0]) t = tier;
  return { name: t[1], color: t[2] };
}
