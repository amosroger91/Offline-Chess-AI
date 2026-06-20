// ============================================================
//  chess-knowledge.js  —  a compact, curated knowledge base of
//  things strong players know. To avoid overloading a small
//  local LLM, we DON'T dump all of this into the prompt. Instead
//  `selectKnowledge()` retrieves only 2-3 nuggets relevant to the
//  current position (phase, checks, captures, material, etc.).
// ============================================================

// Each entry: { tags: [...], text: "one-sentence idea" }
const KB = [
  // ---- Opening principles ----
  { tags: ["opening"], text: "In the opening, fight for the center with pawns (e4/d4) and develop knights before bishops." },
  { tags: ["opening"], text: "Castle early to tuck the king away and connect the rooks." },
  { tags: ["opening"], text: "Don't move the same piece twice in the opening without a concrete reason — develop a new piece each move." },
  { tags: ["opening"], text: "Don't bring the queen out too early; it just gets chased around, losing you time (tempo)." },
  { tags: ["opening"], text: "Knights on the rim are dim — develop them toward the center (c3/f3, c6/f6)." },

  // ---- Core tactical motifs ----
  { tags: ["tactic", "fork"], text: "Fork: one piece attacks two targets at once. Knights and pawns are especially good at forking." },
  { tags: ["tactic", "pin"], text: "Pin: a piece can't move because a more valuable piece sits behind it. Pile more attackers onto a pinned piece." },
  { tags: ["tactic", "skewer"], text: "Skewer: attack a valuable piece so when it moves, you win the piece behind it — a pin in reverse." },
  { tags: ["tactic", "discovered"], text: "Discovered attack: move one piece to unveil an attack from the piece behind it; discovered checks are brutal." },
  { tags: ["tactic", "double"], text: "Double attack: create two threats in one move so your opponent can only answer one." },
  { tags: ["tactic", "deflection"], text: "Deflection: force a defending piece away from the square or piece it's guarding, then strike." },
  { tags: ["tactic", "overload"], text: "Overloaded piece: if one defender guards two things, attack one to win the other." },
  { tags: ["tactic", "removingdefender"], text: "Remove the defender: capture or chase away the piece that's holding the position together." },
  { tags: ["tactic", "backrank"], text: "Back-rank mate: a king trapped behind its own pawns can be mated by a rook or queen on the back rank — make luft (a pawn escape)." },
  { tags: ["tactic", "zwischenzug"], text: "Zwischenzug (in-between move): before recapturing, check if an even stronger move (like a check) comes first." },
  { tags: ["tactic", "battery"], text: "Battery: line up queen + rook or queen + bishop on the same line to multiply pressure." },

  // ---- Evaluation / thinking method ----
  { tags: ["method"], text: "Before every move, scan all checks, captures, and threats — for both sides." },
  { tags: ["method"], text: "After your opponent moves, ask 'what is that move threatening?' before making your own plan." },
  { tags: ["method"], text: "When ahead in material, trade pieces (not pawns) to simplify toward a winning endgame." },
  { tags: ["method"], text: "When behind, keep pieces on and create complications and threats." },
  { tags: ["method"], text: "A knight and bishop are worth about 3 pawns, a rook 5, a queen 9 — count material before trading." },

  // ---- Positional ideas ----
  { tags: ["position"], text: "Rooks belong on open files and behind passed pawns." },
  { tags: ["position"], text: "The bishop pair is a long-term edge in open positions." },
  { tags: ["position"], text: "Put knights on strong outposts — squares a pawn can't attack them from." },
  { tags: ["position"], text: "Trade your bad pieces and keep your good ones." },

  // ---- Endgame ----
  { tags: ["endgame"], text: "In the endgame the king is a strong piece — activate it and march it toward the center." },
  { tags: ["endgame"], text: "Passed pawns must be pushed — and rooks belong behind them." },
  { tags: ["endgame"], text: "The opposition (kings facing each other with one square between) wins many king-and-pawn endings." },
  { tags: ["endgame"], text: "Know the rule of the square to tell if a lone king can catch a runner pawn." },

  // ---- Responding to specific events ----
  { tags: ["check"], text: "Three ways to answer a check: move the king, block the check, or capture the checker." },
  { tags: ["capture"], text: "After a capture, recapture toward the center when you have a choice, and check it's truly safe." },
  { tags: ["safety"], text: "If a piece is attacked, you can defend it, move it, counter-attack something bigger, or block the attack." },
];

// Pick a phase label from the position.
function phaseOf(chess) {
  const moves = chess.history().length;
  let majors = 0, total = 0;
  for (const row of chess.board()) for (const p of row) {
    if (!p || p.type === "k") continue;
    total++;
    if (p.type === "q" || p.type === "r") majors++;
  }
  if (moves < 16 && total >= 22) return "opening";
  if (total <= 12 || majors <= 2) return "endgame";
  return "middlegame";
}

// Deterministic-ish pick that rotates with move number (no Math.random
// needed) so tips vary turn to turn but stay relevant.
function pick(pool, n, seed) {
  if (pool.length <= n) return pool.slice();
  const out = [];
  let i = seed % pool.length;
  while (out.length < n) {
    if (!out.includes(pool[i])) out.push(pool[i]);
    i = (i + 1) % pool.length;
  }
  return out;
}

/**
 * Retrieve 2-3 relevant coaching nuggets for the current position.
 * `event` is the classified move bucket (check/capture/etc).
 */
export function selectKnowledge(chess, event) {
  const seed = chess.history().length;
  const phase = phaseOf(chess);
  const picked = [];

  // 1) One situational tip tied to what just happened.
  if (event === "check") picked.push(byTag("check"));
  else if (event === "userCapture" || event === "aiCapture") picked.push(byTag("capture"));
  else if (event === "userBlunder") picked.push(byTag("safety"));

  // 2) One phase-appropriate principle.
  const phasePool = KB.filter((k) => k.tags.includes(phase === "middlegame" ? "position" : phase));
  picked.push(...pick(phasePool, 1, seed));

  // 3) One rotating tactical/method idea to broaden their toolkit.
  const ideaPool = KB.filter((k) => k.tags.includes("tactic") || k.tags.includes("method"));
  picked.push(...pick(ideaPool, 1, seed + 3));

  // de-dupe + trim
  const seen = new Set(), out = [];
  for (const k of picked) {
    if (k && !seen.has(k.text)) { seen.add(k.text); out.push(k.text); }
    if (out.length >= 3) break;
  }
  return out;
}

function byTag(tag) { return KB.find((k) => k.tags.includes(tag)); }
