// ============================================================
//  engine-worker.js  —  offline chess engine (module worker)
//  Alpha-beta minimax with piece-square tables. Runs off the
//  main thread so the UI never freezes while the AI "thinks".
// ============================================================
import { Chess } from "https://esm.sh/chess.js@1.0.0";

const PIECE_VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

// Piece-square tables (from White's perspective, a8 = index 0).
const PST = {
  p: [
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0],
  n: [
   -50,-40,-30,-30,-30,-30,-40,-50,
   -40,-20,  0,  0,  0,  0,-20,-40,
   -30,  0, 10, 15, 15, 10,  0,-30,
   -30,  5, 15, 20, 20, 15,  5,-30,
   -30,  0, 15, 20, 20, 15,  0,-30,
   -30,  5, 10, 15, 15, 10,  5,-30,
   -40,-20,  0,  5,  5,  0,-20,-40,
   -50,-40,-30,-30,-30,-30,-40,-50],
  b: [
   -20,-10,-10,-10,-10,-10,-10,-20,
   -10,  0,  0,  0,  0,  0,  0,-10,
   -10,  0,  5, 10, 10,  5,  0,-10,
   -10,  5,  5, 10, 10,  5,  5,-10,
   -10,  0, 10, 10, 10, 10,  0,-10,
   -10, 10, 10, 10, 10, 10, 10,-10,
   -10,  5,  0,  0,  0,  0,  5,-10,
   -20,-10,-10,-10,-10,-10,-10,-20],
  r: [
     0,  0,  0,  0,  0,  0,  0,  0,
     5, 10, 10, 10, 10, 10, 10,  5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
     0,  0,  0,  5,  5,  0,  0,  0],
  q: [
   -20,-10,-10, -5, -5,-10,-10,-20,
   -10,  0,  0,  0,  0,  0,  0,-10,
   -10,  0,  5,  5,  5,  5,  0,-10,
    -5,  0,  5,  5,  5,  5,  0, -5,
     0,  0,  5,  5,  5,  5,  0, -5,
   -10,  5,  5,  5,  5,  5,  0,-10,
   -10,  0,  5,  0,  0,  0,  0,-10,
   -20,-10,-10, -5, -5,-10,-10,-20],
  k: [
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -20,-30,-30,-40,-40,-30,-30,-20,
   -10,-20,-20,-20,-20,-20,-20,-10,
    20, 20,  0,  0,  0,  0, 20, 20,
    20, 30, 10,  0,  0, 10, 30, 20],
};

// Evaluate from the side-to-move's perspective (positive = good for mover).
function evaluate(chess) {
  if (chess.isCheckmate()) return -100000; // side to move is mated
  if (chess.isDraw() || chess.isStalemate() || chess.isThreefoldRepetition()) return 0;

  const board = chess.board(); // 8x8, [rank0=8th rank ... rank7=1st], file a..h
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (!p) continue;
      const idx = r * 8 + f;                 // White's PST orientation
      const mirror = (7 - r) * 8 + f;        // Black mirrors the table
      const base = PIECE_VALUE[p.type];
      const pos = p.color === "w" ? PST[p.type][idx] : PST[p.type][mirror];
      score += (p.color === "w" ? 1 : -1) * (base + pos);
    }
  }
  return chess.turn() === "w" ? score : -score;
}

// Order moves: captures first (helps alpha-beta pruning).
function ordered(chess) {
  const moves = chess.moves({ verbose: true });
  moves.sort((a, b) => {
    const av = a.captured ? PIECE_VALUE[a.captured] : 0;
    const bv = b.captured ? PIECE_VALUE[b.captured] : 0;
    return bv - av;
  });
  return moves;
}

function negamax(chess, depth, alpha, beta) {
  if (depth === 0 || chess.isGameOver()) {
    // Small depth-aware bonus so faster mates are preferred.
    return evaluate(chess);
  }
  let best = -Infinity;
  for (const m of ordered(chess)) {
    chess.move(m);
    const val = -negamax(chess, depth - 1, -beta, -alpha);
    chess.undo();
    if (val > best) best = val;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break; // cutoff
  }
  return best;
}

function pickMove(fen, depth) {
  const chess = new Chess(fen);
  const moves = ordered(chess);
  if (moves.length === 0) return null;

  let bestMove = moves[0];
  let bestVal = -Infinity;
  let alpha = -Infinity;
  const beta = Infinity;
  const scored = [];

  for (const m of moves) {
    chess.move(m);
    const val = -negamax(chess, depth - 1, -beta, -alpha);
    chess.undo();
    scored.push({ m, val });
    if (val > bestVal) { bestVal = val; bestMove = m; }
    if (val > alpha) alpha = val;
  }

  // Add light randomness among near-best moves so games vary.
  const topThreshold = bestVal - (depth <= 1 ? 40 : 12);
  const pool = scored.filter((s) => s.val >= topThreshold);
  const chosen = pool[Math.floor(Math.random() * pool.length)] || { m: bestMove, val: bestVal };

  return {
    from: chosen.m.from,
    to: chosen.m.to,
    promotion: chosen.m.promotion || undefined,
    san: chosen.m.san,
    // Eval in pawns, from White's perspective, for the eval bar.
    evalCp: (chess.turn() === "w" ? bestVal : -bestVal),
  };
}

self.onmessage = (e) => {
  const { fen, depth, id } = e.data;
  try {
    const result = pickMove(fen, Math.max(1, depth | 0));
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};
