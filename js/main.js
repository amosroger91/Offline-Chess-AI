// ============================================================
//  main.js  —  app controller: board, interaction, engine,
//  LLM chat personas, sound, animation, and session persistence.
// ============================================================
import { Chess } from "https://esm.sh/chess.js@1.0.0";
import { llm } from "./llm.js";
import { PERSONAS, fallbackLine, classifyMove, moveFacts, factText, rageExamples } from "./personas.js";
import { selectKnowledge } from "./chess-knowledge.js";
import { pieceSVG } from "./pieces.js";
import { saveSession, loadSession } from "./storage.js";
import { startConfetti, stopConfetti, fetchTopSongPreview, playPreview, resumeMusic, setMuted, stopMusic } from "./celebrate.js";
import { stockfish } from "./stockfish-engine.js";
import { joinOnline, makeRoomCode } from "./online.js";
import { getSkill, recordResult, AI_RATING, rankFor } from "./skill.js";

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const boardEl = $("board");
const statusText = $("statusText");
const turnDot = $("turnDot");
const evalVertFill = $("evalVertFill");
const evalText = $("evalText");
const moveListEl = $("moveList");
const capWhiteEl = $("capturedByWhite");
const capBlackEl = $("capturedByBlack");
const advWhiteEl = $("advWhite");
const advBlackEl = $("advBlack");
const overlay = $("boardOverlay");
const overlayTitle = $("overlayTitle");
const overlaySub = $("overlaySub");
const overlayIcon = $("overlayIcon");
const chatLog = $("chatLog");

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const PVAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

// ---------- State ----------
const chess = new Chess();
let userSide = "w";
let depth = 2;
let orientation = "w";
let persona = "trash";
let selected = null;
let legalTargets = [];
let aiThinking = false;
let lastEvalCp = 0;
let lastEvalBeforeMove = 0;
let chatMessages = [];        // for UI restore: {who, text, cls}
let llmTurns = [];            // for LLM memory: {role, content}
let reacting = false;
let popIn = true;             // pop-in animation only on full (re)draws
let animFromTo = null;        // {from,to} to animate this render
let soundOn = true;
let unlocked = false;         // board stays locked until the AI brain is loaded
let pendingStartAiMove = false; // AI move queued until the game is unlocked
let vexMood = "even";         // crushing | winning | even | losing | tilted
let blunderStreak = 0;        // consecutive user blunders
let goodStreak = 0;           // consecutive strong user moves

// ---- Online (P2P) state ----
let mode = "ai";              // 'ai' | 'online'
let online = null;            // Trystero room controls
let opponentId = null;
let opponentName = "Opponent";
let myName = "Player";
let roomCode = "";
let localStream = null;       // our mic stream
let voiceOn = false, micMuted = false;
let opponentRating = 1000;
let coachAssist = false;      // auto-help the weaker online player
let gameRecorded = false;     // avoid double-counting a result
const ASSIST_GAP = 150;       // rating gap that triggers Coach assist
let onlineJoinTimer = null;   // "still connecting…" timeout
let roomIsCreator = false;

const MOOD_DIRECTIVE = {
  crushing: "You are utterly CRUSHING this game — be insufferably cocky, take a victory lap, act like it's already won.",
  winning: "You're clearly AHEAD — be smug and confident and rub it in.",
  even: "The game is roughly EVEN — standard cocky lobby trash talk.",
  losing: "You are BEHIND and salty about it — get defensive, make excuses (lag, mouse slipped, going easy), stay in denial but still cocky.",
  tilted: "You are getting DESTROYED and fully TILTING — cope hard, blame everything, rage-deny that you're losing (still playful, no profanity).",
};
function moodPhrase(m) {
  return {
    crushing: "completely winning and gloating", winning: "ahead and smug",
    even: "in a roughly even game", losing: "behind and salty about it",
    tilted: "getting destroyed and tilting hard",
  }[m];
}

// ============================================================
//  Sound (WebAudio, synthesized — no files, fully offline)
// ============================================================
let actx = null;
function ensureAudio() {
  if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
  if (actx && actx.state === "suspended") actx.resume();
}
function tone(freq, t0, dur, type = "sine", gain = 0.12) {
  if (!soundOn || !actx) return;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.value = freq;
  o.connect(g); g.connect(actx.destination);
  const now = actx.currentTime + t0;
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(gain, now + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0008, now + dur);
  o.start(now); o.stop(now + dur + 0.02);
}
const sfx = {
  move: () => { tone(330, 0, 0.07, "triangle", 0.10); tone(247, 0.04, 0.09, "sine", 0.08); },
  capture: () => { tone(150, 0, 0.12, "square", 0.10); tone(90, 0.03, 0.16, "sawtooth", 0.07); },
  check: () => { tone(880, 0, 0.09, "sine", 0.12); tone(1175, 0.09, 0.12, "sine", 0.10); },
  win: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.1, 0.22, "triangle", 0.12)); },
  lose: () => { [392, 330, 262].forEach((f, i) => tone(f, i * 0.13, 0.28, "sine", 0.12)); },
};

// ============================================================
//  Engine worker
// ============================================================
const worker = new Worker(new URL("./engine-worker.js", import.meta.url), { type: "module" });
let reqId = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const { id, ok, result, error } = e.data;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  ok ? p.resolve(result) : p.reject(new Error(error));
};
function askEngine(fen, d) {
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, fen, depth: d });
  });
}

// Difficulty → Stockfish skill (0-20) + time budget (ms).
const SF_SKILL = { 1: 2, 2: 9, 3: 20 };
const SF_MOVETIME = { 1: 200, 2: 450, 3: 800 };

// Opponent move: Stockfish when available, else the bundled minimax.
async function getBestMove(fen, level) {
  if (stockfish.ready) {
    try { const r = await stockfish.bestMove(fen, { skill: SF_SKILL[level] ?? 9, movetime: SF_MOVETIME[level] ?? 450 }); if (r) return r; }
    catch (e) { console.warn("Stockfish bestMove fell back to minimax:", e); }
  }
  return askEngine(fen, level);
}
// Full-strength eval (bar / swing / coach): Stockfish when available.
async function getEval(fen) {
  if (stockfish.ready) {
    try { const r = await stockfish.evaluate(fen, 300); if (r) return r; }
    catch (e) { console.warn("Stockfish eval fell back to minimax:", e); }
  }
  return askEngine(fen, 2);
}

// ============================================================
//  Rendering
// ============================================================
function render() {
  boardEl.innerHTML = "";
  const board = chess.board();
  const ranks = orientation === "w" ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const files = orientation === "w" ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];

  const last = chess.history({ verbose: true }).slice(-1)[0];
  const inCheck = chess.inCheck();
  const turn = chess.turn();

  for (const r of ranks) {
    for (const f of files) {
      const sq = document.createElement("div");
      const isLight = (r + f) % 2 === 0;
      const square = FILES[f] + (8 - r);
      sq.className = "sq " + (isLight ? "light" : "dark");
      sq.dataset.square = square;

      if (last && (last.from === square || last.to === square)) sq.classList.add("last");
      if (selected === square) sq.classList.add("sel");
      const tgt = legalTargets.find((m) => m.to === square);
      if (tgt) {
        sq.classList.add("target");
        if (tgt.captured || tgt.flags.includes("e")) sq.classList.add("capture");
      }

      const piece = board[r][f];
      if (piece) {
        if (inCheck && piece.type === "k" && piece.color === turn) sq.classList.add("check");
        const el = document.createElement("div");
        el.className = "piece " + (piece.color === "w" ? "white" : "black") + (popIn ? " pop" : "");
        el.innerHTML = pieceSVG(piece.color, piece.type);
        sq.appendChild(el);
      }

      if (f === (orientation === "w" ? 0 : 7)) {
        const c = document.createElement("span"); c.className = "coord rank"; c.textContent = 8 - r; sq.appendChild(c);
      }
      if (r === (orientation === "w" ? 7 : 0)) {
        const c = document.createElement("span"); c.className = "coord file"; c.textContent = FILES[f]; sq.appendChild(c);
      }

      sq.addEventListener("click", () => onSquareClick(square));
      boardEl.appendChild(sq);
    }
  }
  popIn = false;
  if (animFromTo) { runMoveAnimation(animFromTo); animFromTo = null; }

  renderStatus(); renderMoves(); renderCaptures();
}

function runMoveAnimation({ from, to }) {
  const fromSq = boardEl.querySelector(`[data-square="${from}"]`);
  const toSq = boardEl.querySelector(`[data-square="${to}"]`);
  const piece = toSq && toSq.querySelector(".piece");
  if (!piece || !fromSq || !toSq) return;
  const fr = fromSq.getBoundingClientRect(), tr = toSq.getBoundingClientRect();
  const dx = fr.left - tr.left, dy = fr.top - tr.top;
  piece.classList.add("moving");
  piece.style.transition = "none";
  piece.style.transform = `translate(${dx}px, ${dy}px)`;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    piece.style.transition = "";
    piece.style.transform = "";
  }));
}

function renderStatus() {
  turnDot.className = "dot";
  if (chess.isGameOver()) { turnDot.classList.add("over"); statusText.textContent = gameOverText(); return; }
  if (aiThinking) { turnDot.classList.add("thinking"); statusText.textContent = "AI is thinking…"; return; }
  const yourTurn = chess.turn() === userSide;
  const sideName = userSide === "w" ? "White" : "Black";
  statusText.textContent = yourTurn
    ? `Your move — you are ${sideName}.` + (chess.inCheck() ? " You're in check!" : "")
    : "Waiting for the AI…";
}

function gameOverText() {
  if (chess.isCheckmate()) {
    const userWon = chess.turn() !== userSide;
    return userWon ? "Checkmate — you win! 🏆" : "Checkmate — the AI wins.";
  }
  if (chess.isStalemate()) return "Stalemate — it's a draw.";
  if (chess.isThreefoldRepetition()) return "Draw by repetition.";
  if (chess.isInsufficientMaterial()) return "Draw — insufficient material.";
  if (chess.isDraw()) return "Draw (50-move rule).";
  return "Game over.";
}

function renderMoves() {
  const h = chess.history();
  moveListEl.innerHTML = "";
  for (let i = 0; i < h.length; i += 2) {
    const li = document.createElement("li");
    const no = document.createElement("span"); no.className = "mv-no"; no.textContent = i / 2 + 1 + ".";
    const w = document.createElement("span"); w.className = "mv"; w.textContent = h[i] || "";
    const b = document.createElement("span"); b.className = "mv"; b.textContent = h[i + 1] || "";
    if (i === h.length - 1) w.classList.add("last");
    if (i + 1 === h.length - 1) b.classList.add("last");
    li.append(no, w, b);
    moveListEl.appendChild(li);
  }
  moveListEl.scrollTop = moveListEl.scrollHeight;
}

function renderCaptures() {
  const verbose = chess.history({ verbose: true });
  const byWhite = [], byBlack = [];
  let wPts = 0, bPts = 0;
  for (const m of verbose) {
    if (!m.captured) continue;
    if (m.color === "w") { byWhite.push(["b", m.captured]); wPts += PVAL[m.captured]; }
    else { byBlack.push(["w", m.captured]); bPts += PVAL[m.captured]; }
  }
  const sortKey = ([, t]) => -PVAL[t];
  byWhite.sort((a, b) => sortKey(a) - sortKey(b));
  byBlack.sort((a, b) => sortKey(a) - sortKey(b));
  capWhiteEl.innerHTML = byWhite.map(([c, t]) => `<span class="cap">${pieceSVG(c, t)}</span>`).join("") || "<span class='capnone'></span>";
  capBlackEl.innerHTML = byBlack.map(([c, t]) => `<span class="cap">${pieceSVG(c, t)}</span>`).join("") || "<span class='capnone'></span>";
  const diff = wPts - bPts;
  advWhiteEl.textContent = diff > 0 ? "+" + diff : "";
  advBlackEl.textContent = diff < 0 ? "+" + -diff : "";
}

function setEval(cp) {
  lastEvalCp = cp;
  const pawns = cp / 100;
  const pct = 100 / (1 + Math.exp(-pawns / 4));
  evalVertFill.style.height = pct.toFixed(1) + "%";
  let label;
  if (Math.abs(pawns) >= 100) label = pawns > 0 ? "M" : "-M";
  else label = (pawns > 0 ? "+" : "") + pawns.toFixed(1);
  evalText.textContent = label;
}

// ============================================================
//  Interaction
// ============================================================
function onSquareClick(square) {
  ensureAudio();
  if (!unlocked) return;
  if (chess.isGameOver() || aiThinking) return;
  if (chess.turn() !== userSide) return;

  const piece = chess.get(square);
  if (selected) {
    const move = legalTargets.find((m) => m.to === square);
    if (move) { doUserMove(move); return; }
  }
  if (piece && piece.color === userSide) {
    selected = square;
    legalTargets = chess.moves({ square, verbose: true });
  } else { selected = null; legalTargets = []; }
  render();
}

async function doUserMove(move) {
  let promotion = move.promotion;
  if (move.flags.includes("p")) {
    promotion = await pickPromotion(userSide);
    if (!promotion) { selected = null; legalTargets = []; render(); return; }
  }
  const made = chess.move({ from: move.from, to: move.to, promotion });
  selected = null; legalTargets = [];
  playMoveSound(made);
  animFromTo = { from: made.from, to: made.to };
  render();
  persist();

  if (mode === "online") {
    if (online) online.sendMove({ from: made.from, to: made.to, promotion: made.promotion });
    updateEvalOnly();
    if (chess.isGameOver()) handleGameOver();
    return;
  }

  await analyzeAndReact(made, true);
  if (!chess.isGameOver()) aiMove();
  else handleGameOver();
}

async function aiMove() {
  if (chess.isGameOver()) return;
  aiThinking = true; renderStatus(); turnDot.className = "dot thinking";
  try {
    const res = await getBestMove(chess.fen(), depth);
    if (!res) { aiThinking = false; return; }
    const made = chess.move({ from: res.from, to: res.to, promotion: res.promotion });
    setEval(res.evalCp);
    aiThinking = false;
    selected = null; legalTargets = [];
    playMoveSound(made);
    animFromTo = { from: made.from, to: made.to };
    render();
    persist();
    if (made.captured || chess.inCheck() || chess.isGameOver()) await analyzeAndReact(made, false);
    if (chess.isGameOver()) handleGameOver();
  } catch (err) {
    aiThinking = false; renderStatus(); console.error("Engine error:", err);
  }
}

function playMoveSound(made) {
  if (chess.isCheckmate()) return; // handled by win/lose
  if (chess.inCheck()) sfx.check();
  else if (made.captured) sfx.capture();
  else sfx.move();
}

function pickPromotion(color) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "board-overlay";
    wrap.innerHTML = `<div class="overlay-card"><h2 style="font-size:21px;margin-bottom:14px">Promote to…</h2>
      <div style="display:flex;gap:12px;justify-content:center">
      ${["q", "r", "b", "n"].map((t) => `<button class="btn btn-ghost promo" data-t="${t}" style="width:62px;height:62px;padding:8px">${pieceSVG(color, t)}</button>`).join("")}
      </div></div>`;
    boardEl.parentElement.appendChild(wrap);
    wrap.querySelectorAll(".promo").forEach((b) =>
      b.addEventListener("click", () => { wrap.remove(); resolve(b.dataset.t); }));
  });
}

function handleGameOver() {
  render();
  const userWon = chess.isCheckmate() && chess.turn() !== userSide;
  const draw = !chess.isCheckmate();
  const outcome = draw ? "draw" : (userWon ? "win" : "lose");
  if (userWon) sfx.win(); else if (!draw) sfx.lose();
  if (mode !== "online") {
    reactEvent(userWon ? "win" : (chess.isCheckmate() ? "lose" : "neutral"), `The game just ended: ${gameOverText()}`);
  }
  persist();
  showEndScreen(outcome);
  const rec = recordGameResult(outcome);
  if (rec) $("endSub").textContent += ` · ${rec.delta >= 0 ? "+" : ""}${rec.delta} rating → ${rankFor(rec.rating).name} ${rec.rating}`;
}

// ---- Full-screen win/lose party (sprites + confetti + iTunes music) ----
let endMuted = false;
async function showEndScreen(outcome) {
  const es = $("endScreen");
  es.classList.remove("end-win", "end-lose", "end-draw");
  es.classList.add("end-" + outcome);
  const you = $("spriteYou"), ai = $("spriteAi");
  you.className = "sprite sprite-you"; ai.className = "sprite sprite-ai";
  const foe = mode === "online" ? opponentName : "Vex";
  const aiTag = ai.querySelector(".sprite-tag");
  if (aiTag) aiTag.textContent = foe;
  let title, sub, palette;
  if (outcome === "win") {
    you.classList.add("dancing"); ai.classList.add("slumped");
    title = "ACHIEVEMENT UNLOCKED";
    sub = mode === "online" ? `Checkmate — you beat ${foe}! 🏆 +100G` : "Checkmate — you bodied the AI. 🏆 +100G";
    palette = ["#92c83e", "#b6e85a", "#107c10", "#eafbd6", "#f4b740"];
  } else if (outcome === "lose") {
    ai.classList.add("dancing"); you.classList.add("slumped");
    title = "DEFEAT"; sub = mode === "online" ? `${foe} got you this time. Run it back?` : "Vex got you this time. Run it back?";
    palette = ["#e23b2e", "#ff7a2e", "#f4b740", "#92c83e"];
  } else {
    you.classList.add("tie"); ai.classList.add("tie");
    title = "DRAW"; sub = "Dead even — nobody blinked. Rematch?";
    palette = ["#92c83e", "#b6e85a", "#d3ddc8", "#eafbd6"];
  }
  $("endTitle").textContent = title;
  $("endSub").textContent = sub;
  $("endScreen").classList.remove("hidden");
  startConfetti($("confetti"), palette);

  const np = $("nowPlaying");
  np.classList.remove("hidden", "tap");
  $("npText").textContent = "Loading the anthem…";
  $("npMute").textContent = "🔊"; endMuted = false;
  try {
    const song = await fetchTopSongPreview();
    if (song && song.preview) {
      const ok = await playPreview(song.preview);
      if (ok) $("npText").textContent = "🎵 " + song.name + " — " + song.artist;
      else { $("npText").textContent = "▶ Tap to play: " + song.name + " — " + song.artist; np.classList.add("tap"); }
    } else {
      $("npText").textContent = "🎵 (no preview available)";
    }
  } catch (e) {
    console.warn("music:", e);
    $("npText").textContent = "🎵 (couldn't reach iTunes)";
  }
}

function closeEndScreen() {
  stopConfetti(); stopMusic();
  $("endScreen").classList.add("hidden");
  $("nowPlaying").classList.remove("tap");
}

// ============================================================
//  Analysis + AI chat reactions
// ============================================================
async function analyzeAndReact(made, byUser) {
  let swing = 0;
  try {
    const ev = await getEval(chess.fen());
    if (ev) {
      setEval(ev.evalCp);
      const before = userPersp(lastEvalBeforeMove);
      const after = userPersp(ev.evalCp);
      swing = (after - before) / 100;
    }
  } catch {}
  lastEvalBeforeMove = lastEvalCp;

  const facts = moveFacts(made, byUser, chess);
  const info = {
    byUser, captured: !!made.captured, isCheck: chess.inCheck(),
    isCheckmate: chess.isCheckmate(), gameOver: chess.isGameOver(),
    isCastle: facts.isCastle, isPromo: !!facts.promo,
    userWon: chess.isCheckmate() && chess.turn() !== userSide, swing,
  };
  const event = classifyMove(info);

  // Streak tracking — consecutive user blunders / strong moves.
  if (byUser && !info.gameOver) {
    if (info.swing <= -1.2) { blunderStreak++; goodStreak = 0; }
    else if (info.swing >= 0.8) { goodStreak++; blunderStreak = 0; }
    else { blunderStreak = 0; goodStreak = 0; }
  }
  // Vex's tilt/gloat mood from the current eval (AI's perspective).
  const aiAdv = -userPersp(lastEvalCp) / 100;
  vexMood = aiAdv >= 5 ? "crushing" : aiAdv >= 1.5 ? "winning"
    : aiAdv <= -5 ? "tilted" : aiAdv <= -1.5 ? "losing" : "even";

  let ctx = factText(facts, balanceText()) + swingNote(swing, byUser);
  ctx += ` Vex (the AI) is ${moodPhrase(vexMood)}.`;
  if (blunderStreak >= 2) ctx += ` The user has blundered ${blunderStreak} moves in a row.`;
  if (goodStreak >= 2) ctx += ` The user has played ${goodStreak} strong moves in a row.`;

  await reactEvent(event, ctx, facts, { mood: vexMood, blunderStreak, goodStreak });
}

function userPersp(cp) { return userSide === "w" ? cp : -cp; }

function balanceText() {
  const bal = materialBalance();
  if (bal === 0) return "Material is currently equal.";
  return `${bal > 0 ? "You are" : "The AI is"} ahead by ${Math.abs(bal)} point${Math.abs(bal) === 1 ? "" : "s"} of material.`;
}
function swingNote(swing, byUser) {
  if (!byUser || Math.abs(swing) < 0.8) return "";
  return swing <= -1.2 ? " That move looks like a costly mistake for the user."
    : swing >= 0.8 ? " That was a good, improving move by the user." : "";
}

function materialBalance() {
  let bal = 0;
  for (const row of chess.board()) for (const p of row) {
    if (p) bal += PVAL[p.type] * (p.color === userSide ? 1 : -1);
  }
  return bal;
}
function pieceName(t) { return { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" }[t]; }

// One-line summary of the live position for free-chat questions.
function positionSummary() {
  const last = chess.history().slice(-1)[0];
  return [
    last ? `Last move played: ${last}.` : "The game just started; no moves yet.",
    balanceText(),
    `It is ${chess.turn() === userSide ? "the user's" : "the AI's"} turn to move.`,
    chess.inCheck() ? `${chess.turn() === userSide ? "The user" : "The AI"} is in check.` : "",
  ].filter(Boolean).join(" ");
}

// Build the message array sent to the LLM (system + memory + this turn).
// For the Coach, inject 2-3 position-relevant tips from the knowledge base.
function llmMessages(ctx, userText, event) {
  let sys = PERSONAS[persona].system + "\n\nFACTS about the current position (only reference these; do not invent anything else):\n" + ctx;

  // Anti-repetition: show the model its own recent lines and forbid reuse.
  const recent = llmTurns.filter((t) => t.role === "assistant").slice(-4).map((t) => t.content);
  if (recent.length) {
    sys += "\n\nYOUR RECENT LINES (do NOT repeat these words, jokes, openers, or sentence structure — be totally fresh):\n- " + recent.join("\n- ");
  }
  sys += "\n\nIMPORTANT: make this reply SPECIFIC to the exact move in the facts (name the actual piece and square) rather than a generic line, and vary your phrasing every single time.";
  sys += "\n\nLENGTH RULES (critical): reply with ONE short sentence, 18 words MAX. No markdown, no asterisks, no bold, no lists, no headers. At most ONE emoji and usually none. Write it like a quick chat message someone fires off mid-match — not a paragraph.";

  if (persona === "teacher") {
    const tips = selectKnowledge(chess, event || "neutral");
    if (tips.length) sys += "\n\nCoaching notes you may draw ONE relevant idea from:\n- " + tips.join("\n- ");
  } else if (persona === "trash") {
    sys += "\n\nVEX'S CURRENT MOOD: " + MOOD_DIRECTIVE[vexMood];
    if (blunderStreak >= 2) sys += ` The user just blundered ${blunderStreak} moves in a row — mock the streak.`;
    if (goodStreak >= 2) sys += ` The user has played ${goodStreak} good moves in a row — be begrudgingly impressed or suspicious.`;
    sys += "\n\nLobby taunts for VIBE ONLY (rephrase, never copy verbatim, never reuse one): " +
      rageExamples(chess.history().length).join(" · ");
  }
  const msgs = [{ role: "system", content: sys }];
  for (const t of llmTurns.slice(-8)) msgs.push(t);
  if (userText) msgs.push({ role: "user", content: userText });
  else msgs.push({ role: "user", content: persona === "trash"
    ? "React to ONLY the move in the facts above, in 1-2 short, savage sentences."
    : "Comment on ONLY the move in the facts above and give one helpful idea, in 1-3 short sentences." });
  return msgs;
}

// Keep replies chat-length: strip markdown, cap to one sentence + a bit,
// collapse whitespace, and limit emoji. Stops the model from rambling.
function sanitizeReply(s) {
  if (!s) return "";
  let t = s.replace(/\*+|__|`+|^#+\s*|^[-*]\s+/gm, "").replace(/\s*\n+\s*/g, " ").trim();
  // Drop leading clutter (stray emoji/arrows/symbols) so it starts on a word.
  t = t.replace(/^[^\p{L}\p{N}"'(]+/u, "").trim();
  const parts = t.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [t];
  // One sentence, unless the first is short enough to allow a snappy second.
  const take = (parts[0] && parts[0].trim().length < 55 && parts[1]) ? 2 : 1;
  t = parts.slice(0, take).join(" ").trim();
  if (t.length > 140) t = t.slice(0, 137).replace(/\s+\S*$/, "") + "…";
  let n = 0;
  t = t.replace(/\p{Extended_Pictographic}/gu, (m) => (++n <= 2 ? m : "")); // ≤2 emoji
  return t.replace(/\s{2,}/g, " ").trim();
}

// Auto-reaction to a move.
async function reactEvent(event, ctx, facts, extra) {
  if (reacting) return;
  reacting = true;
  try {
    if (llm.ready) {
      const node = addTyping();
      try {
        let text = "";
        await llm.chat(llmMessages(ctx, null, event), (full) => { text = full; node.textEl.textContent = full; }, { maxTokens: 46, temperature: 0.9 });
        text = sanitizeReply(text) || fallbackLine(persona, event, facts, extra);
        finalizeMsg(node, text);
        llmTurns.push({ role: "assistant", content: text });
      } catch (e) {
        finalizeMsg(node, fallbackLine(persona, event, facts, extra));
      }
    } else {
      addMessage("ai", fallbackLine(persona, event, facts, extra), persona);
    }
  } finally { reacting = false; }
}

// ============================================================
//  Chat UI
// ============================================================
function addMessage(who, text, cls = "") {
  const div = document.createElement("div");
  div.className = `msg ${who}${cls ? " " + cls : ""}`;
  if (who === "ai") div.appendChild(avatarEl());
  else if (who === "peer") { const a = document.createElement("div"); a.className = "avatar"; a.textContent = "🎮"; div.appendChild(a); }
  const t = document.createElement("div"); t.textContent = text; div.appendChild(t);
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  if (who !== "system") { chatMessages.push({ who, text, cls }); persist(); }
  if (who === "ai" || who === "peer") flagUnread();
  return div;
}
function avatarEl() {
  const a = document.createElement("div"); a.className = "avatar"; a.textContent = PERSONAS[persona].emoji; return a;
}
function addTyping() {
  const div = document.createElement("div");
  div.className = `msg ai ${persona}`;
  div.appendChild(avatarEl());
  const typing = document.createElement("div"); typing.className = "typing"; typing.innerHTML = "<span></span><span></span><span></span>";
  const textEl = document.createElement("div");
  div.append(typing, textEl);
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return { div, typing, textEl };
}
function finalizeMsg(node, text) {
  node.typing.remove();
  node.textEl.textContent = text;
  chatLog.scrollTop = chatLog.scrollHeight;
  chatMessages.push({ who: "ai", text, cls: persona });
  persist();
  flagUnread();
}

async function sendUserChat(text) {
  ensureAudio();
  addMessage("user", text);
  llmTurns.push({ role: "user", content: text });

  // Already loaded → generate for real.
  if (llm.ready) { await generateChatReply(text); return; }

  // Supported but not loaded → auto-spin-up the local LLM so the convo is
  // genuinely generated (the scripted lines only guide the persona's voice).
  if (llm.supported && !llm.busy) {
    addMessage("system", "🧠 Waking up my local brain so I can roast you for real — one-time download, give me a sec…");
    try {
      const modelId = $("modelSelect").value;
      $("loaderBar").classList.remove("hidden"); $("loadModelBtn").disabled = true;
      setModelStatus("loading", "LLM: loading…");
      await llm.load(modelId, ({ progress, text }) => showLoadProgress(progress, text));
      setModelStatus("ready", "LLM: " + PERSONAS[persona].name + " online");
      $("loaderBar").classList.add("hidden"); $("modelSelect").value = modelId; refreshLoadButton();
      addMessage("system", "🧠 Brain online — now we're really talking.");
      await generateChatReply(text);
    } catch (e) {
      console.error(e);
      setModelStatus("fallback", "LLM: error"); $("loaderBar").classList.add("hidden"); refreshLoadButton();
      addMessage("system", "Couldn't load the model (" + (e.message || e) + "). Using scripted lines for now.");
      addMessage("ai", fallbackLine(persona, "neutral", null, { mood: vexMood, blunderStreak, goodStreak }), persona);
    }
    return;
  }

  // WebGPU unavailable (or mid-load) → scripted, with a note.
  addMessage("ai", fallbackLine(persona, "neutral", null, { mood: vexMood, blunderStreak, goodStreak }), persona);
  if (!llm.supported) addMessage("system", "ℹ️ Live LLM banter needs Chrome/Edge with WebGPU — using built-in lines here.");
}

// Stream a real LLM reply to a chat message.
async function generateChatReply(text) {
  const node = addTyping();
  try {
    const ctx = positionSummary();
    let out = "";
    await llm.chat(llmMessages(ctx, text, "neutral"), (full) => { out = full; node.textEl.textContent = full; }, { maxTokens: 64, temperature: 0.85 });
    out = sanitizeReply(out) || "(…went quiet — try me again.)";
    finalizeMsg(node, out);
    llmTurns.push({ role: "assistant", content: out });
  } catch (e) {
    node.typing.remove();
    node.textEl.textContent = "⚠️ The local model errored: " + (e.message || e) + ".";
    console.error("LLM chat error:", e);
  }
}

// ============================================================
//  LLM loading UI
// ============================================================
function setModelStatus(state, text) {
  $("modelDot").className = "model-dot" + (state ? " " + state : "");
  $("modelStatusText").textContent = text;
}
function refreshLoadButton() {
  const btn = $("loadModelBtn");
  if (!llm.supported) { btn.disabled = true; return; }
  if (llm.busy) { btn.disabled = true; return; }
  if (llm.ready) {
    const sel = $("modelSelect").value;
    if (sel === llm.model) { btn.disabled = true; btn.textContent = "✓ Loaded — running offline"; }
    else { btn.disabled = false; btn.textContent = "🔄 Switch to this model"; }
  } else {
    btn.disabled = false; btn.textContent = "🧠 Load local AI brain";
  }
}

function showLoadProgress(progress, text) {
  const pc = Math.round((progress || 0) * 100) + "%";
  const gf = $("gateFill"), lf = $("loaderFill");
  if (gf) gf.style.width = pc;
  if (lf) lf.style.width = pc;
  const t = text || "Downloading & compiling… (cached after first time)";
  if ($("gateNote")) $("gateNote").textContent = t;
  if ($("loaderNote")) $("loaderNote").textContent = t;
}

// In-chat model switcher (the gate auto-loads the default via startAiFlow).
async function loadModel() {
  if (!llm.supported) {
    $("loaderNote").textContent = "⚠️ WebGPU isn't available here, so chat uses built-in scripted lines. Try Chrome or Edge for the full local LLM.";
    setModelStatus("fallback", "LLM: scripted mode"); $("loadModelBtn").disabled = true; return;
  }
  const modelId = $("modelSelect").value;
  if (llm.ready) { try { await llm.unload(); } catch {} }
  $("loadModelBtn").disabled = true;
  $("loaderBar").classList.remove("hidden");
  setModelStatus("loading", "LLM: loading…");
  try {
    await llm.load(modelId, ({ progress, text }) => showLoadProgress(progress, text));
    setModelStatus("ready", "LLM: " + PERSONAS[persona].name + " online");
    $("loaderNote").textContent = "✓ Running fully offline. Pick another model to switch.";
    $("loaderBar").classList.add("hidden");
    llmTurns = [];
    addMessage("system", "Model switched to " + modelId.split("-").slice(0, 2).join(" ") + ". 🧠");
  } catch (e) {
    console.error(e);
    $("loaderNote").textContent = "Couldn't load the model (" + (e.message || e) + ").";
    setModelStatus("fallback", "LLM: error");
    $("loaderBar").classList.add("hidden");
  } finally {
    refreshLoadButton();
  }
}

// Reveal the board for play (and run any AI move that was waiting).
function unlockGame() {
  unlocked = true;
  $("gate").classList.add("hidden");
  if (pendingStartAiMove) { pendingStartAiMove = false; aiMove(); }
}

// Escape hatch: play in scripted mode without the LLM.
function skipGate() {
  setModelStatus(llm.supported ? "" : "fallback", "LLM: scripted mode");
  if (chatMessages.filter((m) => m.who === "ai").length === 0) {
    addMessage("system", "Playing in scripted mode — you can load a model anytime from the chat panel.");
    addMessage("ai", PERSONAS[persona].greeting, persona);
  }
  unlockGame();
}

// ============================================================
//  Game lifecycle
// ============================================================
function newGame() {
  closeEndScreen();
  chess.reset();
  selected = null; legalTargets = []; aiThinking = false;
  lastEvalCp = 0; lastEvalBeforeMove = 0; setEval(0);
  vexMood = "even"; blunderStreak = 0; goodStreak = 0; gameRecorded = false;
  overlay.classList.add("hidden");
  orientation = userSide;
  chatMessages = []; llmTurns = []; chatLog.innerHTML = "";
  popIn = true; animFromTo = null;
  addMessage("system", "New game — you play " + (userSide === "w" ? "White" : "Black") + ".");
  addMessage("ai", PERSONAS[persona].greeting, persona);
  render(); persist();
  if (chess.turn() !== userSide) aiMove();
}

function persist() {
  if (mode === "online") return; // online games aren't restorable
  saveSession({
    sans: chess.history(), userSide, depth, orientation, persona,
    chat: chatMessages, soundOn, mode: "ai", over: chess.isGameOver(),
  });
}

function restore(sess) {
  userSide = sess.userSide || "w";
  depth = sess.depth || 2;
  orientation = sess.orientation || userSide;
  persona = sess.persona || "trash";
  soundOn = sess.soundOn !== false;
  chess.reset();
  try { for (const san of sess.sans || []) chess.move(san); } catch {}
  chatMessages = sess.chat || [];
  chatLog.innerHTML = "";
  for (const m of chatMessages) {
    const div = document.createElement("div");
    div.className = `msg ${m.who}${m.cls ? " " + m.cls : ""}`;
    if (m.who === "ai") {
      const a = document.createElement("div"); a.className = "avatar";
      a.textContent = PERSONAS[m.cls]?.emoji || "🤖"; div.appendChild(a);
    }
    const t = document.createElement("div"); t.textContent = m.text; div.appendChild(t);
    chatLog.appendChild(div);
  }
  chatLog.scrollTop = chatLog.scrollHeight;
  popIn = true;
  syncControls(); render();
  if (chess.isGameOver()) {
    const userWon = chess.isCheckmate() && chess.turn() !== userSide;
    overlayIcon.textContent = !chess.isCheckmate() ? "½" : (userWon ? "🏆" : "♚");
    overlayTitle.textContent = !chess.isCheckmate() ? "Draw" : (userWon ? "You win!" : "Checkmate");
    overlaySub.textContent = gameOverText();
    overlay.classList.remove("hidden");
  } else if (chess.turn() !== userSide) {
    if (unlocked) aiMove(); else pendingStartAiMove = true;
  }
}

function syncControls() {
  document.querySelectorAll("#difficultySeg .seg-btn").forEach((b) => b.classList.toggle("active", +b.dataset.depth === depth));
  document.querySelectorAll("#sideSeg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.side === userSide));
  document.querySelectorAll("#personaToggle .persona-btn").forEach((b) => b.classList.toggle("active", b.dataset.persona === persona));
  $("soundBtn").textContent = soundOn ? "🔊" : "🔇";
}

// ============================================================
//  Start gate navigation + mode start
// ============================================================
let gateStep = "mode";
function showGateStep(name) {
  gateStep = name;
  document.querySelectorAll(".gate-step").forEach((s) => s.classList.toggle("hidden", s.dataset.step !== name));
  $("gate").classList.remove("hidden");
}

function startAiMode() {
  mode = "ai";
  document.body.dataset.chatmode = "ai";
  $("gate").classList.add("hidden");
  unlocked = true;
  newGame();
}

// Choosing "Play the AI" loads the local LLM (brief wait), then starts.
const DEFAULT_MODEL = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
async function startAiFlow() {
  showGateStep("ai");
  if (!llm.supported) { startAiMode(); return; }  // no WebGPU → built-in banter
  $("gateBar").classList.remove("hidden");
  $("gateNote").textContent = "Running 100% in your browser.";
  setModelStatus("loading", "LLM: loading…");
  try {
    await llm.load(DEFAULT_MODEL, ({ progress, text }) => showLoadProgress(progress, text));
    if (gateStep !== "ai") return;                 // user backed out mid-load
    setModelStatus("ready", "LLM: " + PERSONAS[persona].name + " online");
    $("modelSelect").value = DEFAULT_MODEL; refreshLoadButton();
    startAiMode();
  } catch (e) {
    console.error(e);
    setModelStatus("fallback", "LLM: error");
    if (gateStep !== "ai") return;
    $("gateNote").textContent = "Couldn't load the brain — starting with built-in banter.";
    startAiMode();
  }
}

// ============================================================
//  Online (P2P) multiplayer
// ============================================================
function startOnline(code, isCreator) {
  roomCode = code; roomIsCreator = isCreator;
  myName = ($("nameInput").value || "").trim().slice(0, 16) || "Player";
  const rs = $("roomStatus");
  rs.classList.remove("hidden");
  rs.innerHTML = isCreator
    ? `<div>Share this code with your friend:</div><div class="room-code">${code}</div>
       <div class="room-copy" id="roomCopy">📋 Copy code</div>
       <div class="room-wait"><span class="spin"></span> Waiting for opponent…</div>`
    : `<div class="room-wait"><span class="spin"></span> Connecting to <b>${code}</b>…</div>`;
  const copy = $("roomCopy");
  if (copy) copy.addEventListener("click", () => { navigator.clipboard?.writeText(code); copy.textContent = "✓ Copied!"; });

  if (online) online.leave();
  opponentId = null;
  clearTimeout(onlineJoinTimer);
  onlineJoinTimer = setTimeout(() => { if (!opponentId) showRoomTrouble(); }, 25000);
  online = joinOnline(code, {
    onPeerJoin: onOnlinePeerJoin,
    onPeerLeave: onOnlinePeerLeave,
    onMove: (d) => applyRemoteMove(d),
    onChat: (d) => { if (d && d.text) addMessage("peer", String(d.text).slice(0, 400)); },
    onMeta: (d) => {
      if (!d) return;
      if (d.name) opponentName = String(d.name).slice(0, 16);
      if (typeof d.rating === "number") opponentRating = d.rating;
      refreshOnlinePeerUI();
      if (opponentId) setupCoachAssist();
    },
    onCtrl: onOnlineCtrl,
    onStream: attachRemoteAudio,
  });
}

function onOnlinePeerJoin(id) {
  if (opponentId) return;          // already paired (ignore extra peers)
  clearTimeout(onlineJoinTimer);
  opponentId = id;
  online.sendMeta({ name: myName, rating: getSkill().rating });
  startOnlineGame();
}

function showRoomTrouble() {
  const rs = $("roomStatus");
  if (!rs || opponentId) return;
  rs.innerHTML += `<div style="margin-top:10px;color:var(--amber);font-size:12.5px;line-height:1.5">
      Still connecting… double-check your friend typed the exact code${roomIsCreator ? ` (<b>${roomCode}</b>)` : ""}.
      Strict networks/firewalls can block peer-to-peer.</div>
    <button class="btn" id="roomRetry" style="margin-top:10px">↻ Retry</button>`;
  const r = $("roomRetry");
  if (r) r.addEventListener("click", () => startOnline(roomCode, roomIsCreator));
}

function startOnlineGame() {
  mode = "online";
  document.body.dataset.chatmode = "online";
  userSide = online.selfId < opponentId ? "w" : "b";   // deterministic on both sides
  orientation = userSide;
  $("gate").classList.add("hidden");
  unlocked = true;
  chess.reset();
  selected = null; legalTargets = []; aiThinking = false;
  lastEvalCp = 0; lastEvalBeforeMove = 0; setEval(0);
  popIn = true; animFromTo = null;
  gameRecorded = false; assistConfigured = false; coachAssist = false;
  chatMessages = []; chatLog.innerHTML = "";
  closeEndScreen();
  refreshOnlinePeerUI();
  render();
  addMessage("system", `Connected to ${opponentName}! You are ${userSide === "w" ? "White ♔" : "Black ♚"}.`);
  addMessage("system", userSide === "w" ? "Your move." : `Waiting for ${opponentName} to move…`);
}

function refreshOnlinePeerUI() {
  $("obName").textContent = opponentName;
  $("obDot").className = "ob-dot" + (opponentId ? " connected" : "");
  updateVoiceBtn();
}

function applyRemoteMove(d) {
  if (mode !== "online" || !d) return;
  let made = null;
  try { made = chess.move({ from: d.from, to: d.to, promotion: d.promotion }); } catch { made = null; }
  if (!made) { console.warn("Ignored illegal/desynced remote move", d); return; }
  selected = null; legalTargets = [];
  playMoveSound(made);
  animFromTo = { from: made.from, to: made.to };
  render();
  updateEvalOnly();
  if (chess.isGameOver()) handleGameOver();
  else if (coachAssist && chess.turn() === userSide) maybeCoachHint();
}

function onOnlineCtrl(d) {
  if (!d) return;
  if (d.type === "newgame") resetOnlineBoard(false);
  else if (d.type === "resign") {
    addMessage("system", `${opponentName} resigned. You win! 🏆`);
    showEndScreen("win");
  }
}

function onOnlinePeerLeave(id) {
  if (id !== opponentId) return;
  $("obDot").className = "ob-dot gone";
  addMessage("system", `${opponentName} disconnected. Hit New Game to return to the menu.`);
  opponentId = null;
}

function resetOnlineBoard(initiator) {
  closeEndScreen();
  chess.reset();
  selected = null; legalTargets = []; setEval(0);
  popIn = true; animFromTo = null;
  render();
  addMessage("system", "New game! " + (userSide === "w" ? "Your move." : `Waiting for ${opponentName}…`));
  if (initiator && online) online.sendCtrl({ type: "newgame" });
}

function backToMenu() {
  clearTimeout(onlineJoinTimer);
  if (online) { online.leave(); online = null; }
  stopVoiceLocal();
  opponentId = null; opponentName = "Opponent"; roomCode = "";
  mode = "ai"; document.body.dataset.chatmode = "ai";
  unlocked = false;
  closeEndScreen();
  chess.reset(); selected = null; legalTargets = []; chatLog.innerHTML = ""; chatMessages = [];
  popIn = true; render();
  const rs = $("roomStatus"); if (rs) { rs.classList.add("hidden"); rs.innerHTML = ""; }
  showGateStep("mode");
}

function updateEvalOnly() {
  getEval(chess.fen()).then((ev) => { if (ev) setEval(ev.evalCp); }).catch(() => {});
}

// ---- Voice chat (WebRTC media via Trystero) ----
async function toggleVoice() {
  if (mode !== "online" || !online) return;
  if (!localStream) {
    try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { addMessage("system", "⚠️ Microphone access denied."); return; }
    online.addStream(localStream);
    voiceOn = true; micMuted = false;
    addMessage("system", "🎤 Voice on — your friend can hear you. Tap again to mute.");
  } else {
    micMuted = !micMuted;
    localStream.getAudioTracks().forEach((t) => (t.enabled = !micMuted));
    addMessage("system", micMuted ? "🔇 Mic muted." : "🎤 Mic live.");
  }
  updateVoiceBtn();
}
function stopVoiceLocal() {
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  voiceOn = false; micMuted = false;
  $("voiceAudio").innerHTML = "";
  $("obVoice").classList.add("hidden");
  updateVoiceBtn();
}
function updateVoiceBtn() {
  const b = $("voiceBtn");
  b.classList.toggle("voice-on", voiceOn && !micMuted);
  b.classList.toggle("voice-muted", voiceOn && micMuted);
  b.textContent = voiceOn && micMuted ? "🔇" : "🎤";
  b.title = !voiceOn ? "Start voice chat" : micMuted ? "Mic muted — tap to unmute" : "Mic live — tap to mute";
}
function attachRemoteAudio(stream) {
  const box = $("voiceAudio");
  box.innerHTML = "";
  const a = document.createElement("audio");
  a.autoplay = true; a.playsInline = true; a.srcObject = stream;
  box.appendChild(a);
  a.play().catch(() => {});
  $("obVoice").classList.remove("hidden");
  addMessage("system", "🔊 " + opponentName + " joined voice.");
}

// ============================================================
//  Skill rating + rank badge
// ============================================================
function renderRank() {
  const s = getSkill();
  const r = rankFor(s.rating);
  $("rankName").textContent = r.name;
  $("rankNum").textContent = s.rating;
  $("rankBadge").style.setProperty("--rank-color", r.color);
}
function recordGameResult(outcome) {
  if (gameRecorded) return null;
  gameRecorded = true;
  const score = outcome === "win" ? 1 : outcome === "draw" ? 0.5 : 0;
  const oppR = mode === "online" ? opponentRating : (AI_RATING[depth] || 1200);
  const res = recordResult(score, oppR);
  renderRank();
  const num = $("rankNum");
  num.classList.toggle("up", res.delta > 0);
  num.classList.toggle("down", res.delta < 0);
  return res;
}

// ============================================================
//  Coach assist (help the weaker online player)
// ============================================================
let assistConfigured = false;
function setupCoachAssist() {
  if (assistConfigured) return;
  assistConfigured = true;
  coachAssist = getSkill().rating + ASSIST_GAP < opponentRating; // I'm the underdog
  const btn = $("assistBtn");
  btn.classList.remove("hidden");
  btn.classList.toggle("on", coachAssist);
  if (coachAssist) {
    addMessage("system", `📚 You're rated under ${opponentName} — Coach assist is ON, I'll suggest moves. (Tap 📚 to toggle.)`);
    if (chess.turn() === userSide && !chess.isGameOver()) maybeCoachHint();
  }
}
function toggleAssist() {
  coachAssist = !coachAssist;
  $("assistBtn").classList.toggle("on", coachAssist);
  addMessage("system", coachAssist ? "📚 Coach assist ON." : "📚 Coach assist OFF.");
  if (coachAssist) maybeCoachHint();
}
async function maybeCoachHint() {
  if (!coachAssist || mode !== "online" || chess.isGameOver() || chess.turn() !== userSide) return;
  try {
    const best = await getBestMove(chess.fen(), 3);
    if (!best) return;
    const tmp = new Chess(chess.fen());
    const m = tmp.move({ from: best.from, to: best.to, promotion: best.promotion });
    if (!m) return;
    let tip = `📚 Coach: ${m.san} looks strong`;
    if (m.captured) tip += ` — it grabs a ${pieceName(m.captured)}`;
    else if (tmp.inCheck()) tip += " — it checks the king";
    addMessage("ai", tip + ".", "teacher");
  } catch {}
}

// ============================================================
//  Mobile tab views (Play / Chat / Info)
// ============================================================
const mqMobile = window.matchMedia("(max-width: 1120px)");
function isMobile() { return mqMobile.matches; }
function setMobileView(v) {
  document.body.dataset.mview = v;
  document.querySelectorAll(".mobile-tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.mview === v));
  if (v === "chat") {
    $("chatBadge").classList.remove("show");
    requestAnimationFrame(() => { chatLog.scrollTop = chatLog.scrollHeight; });
  }
}
function flagUnread() {
  if (isMobile() && document.body.dataset.mview !== "chat") $("chatBadge").classList.add("show");
}
document.querySelectorAll(".mobile-tabs .tab").forEach((t) =>
  t.addEventListener("click", () => setMobileView(t.dataset.mview)));

// ============================================================
//  Wire up controls
// ============================================================
$("newGameBtn").addEventListener("click", () => { ensureAudio(); if (mode === "online") backToMenu(); else newGame(); });
$("overlayNewGame").addEventListener("click", () => { ensureAudio(); newGame(); });
$("flipBtn").addEventListener("click", () => { orientation = orientation === "w" ? "b" : "w"; popIn = true; render(); persist(); });
$("undoBtn").addEventListener("click", () => {
  if (mode === "online") return; // can't take back moves in a P2P game
  if (aiThinking || chess.history().length === 0) return;
  if (chess.turn() === userSide) chess.undo();
  chess.undo();
  selected = null; legalTargets = []; overlay.classList.add("hidden"); popIn = true;
  render(); persist();
});
$("soundBtn").addEventListener("click", () => { soundOn = !soundOn; ensureAudio(); $("soundBtn").textContent = soundOn ? "🔊" : "🔇"; if (soundOn) sfx.move(); persist(); });

document.querySelectorAll("#difficultySeg .seg-btn").forEach((b) =>
  b.addEventListener("click", () => { depth = +b.dataset.depth; syncControls(); persist(); }));
document.querySelectorAll("#sideSeg .seg-btn").forEach((b) =>
  b.addEventListener("click", () => { if (b.dataset.side === userSide) return; userSide = b.dataset.side; syncControls(); newGame(); }));
document.querySelectorAll("#personaToggle .persona-btn").forEach((b) =>
  b.addEventListener("click", () => {
    persona = b.dataset.persona; syncControls();
    if (llm.ready) setModelStatus("ready", "LLM: " + PERSONAS[persona].name + " online");
    llmTurns = [];
    addMessage("ai", PERSONAS[persona].greeting, persona); persist();
  }));

$("endPlayAgain").addEventListener("click", () => { ensureAudio(); if (mode === "online") resetOnlineBoard(true); else newGame(); });
$("npMute").addEventListener("click", (e) => {
  e.stopPropagation();
  endMuted = !endMuted; setMuted(endMuted);
  $("npMute").textContent = endMuted ? "🔇" : "🔊";
});
$("nowPlaying").addEventListener("click", async () => {
  if (!$("nowPlaying").classList.contains("tap")) return;
  const ok = await resumeMusic();
  if (ok) { $("nowPlaying").classList.remove("tap"); $("npText").textContent = $("npText").textContent.replace("▶ Tap to play:", "🎵"); }
});
// Test/easter-egg hook: window.dispatchEvent(new CustomEvent('forceEnd',{detail:'win'}))
window.addEventListener("forceEnd", (e) => showEndScreen(e.detail || "win"));

$("loadModelBtn").addEventListener("click", () => loadModel());
$("modelSelect").addEventListener("change", refreshLoadButton);
$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chatInput"); const text = input.value.trim();
  if (!text) return; input.value = "";
  if (mode === "online") { addMessage("user", text); if (online) online.sendChat({ text }); }
  else sendUserChat(text);
});

// ---- Mode picker + online wiring ----
$("modeAiBtn").addEventListener("click", () => { ensureAudio(); startAiFlow(); });
$("modeOnlineBtn").addEventListener("click", () => { ensureAudio(); showGateStep("online"); });
document.querySelectorAll(".gate-back").forEach((b) => b.addEventListener("click", () => showGateStep(b.dataset.back)));
$("createBtn").addEventListener("click", () => { ensureAudio(); startOnline(makeRoomCode(), true); });
$("joinBtn").addEventListener("click", () => {
  ensureAudio();
  const code = ($("codeInput").value || "").trim().toUpperCase();
  if (code.length < 4) {
    const rs = $("roomStatus"); rs.classList.remove("hidden");
    rs.innerHTML = "<div style='color:var(--rrod)'>Enter the 5-letter code your friend shared.</div>";
    return;
  }
  startOnline(code, false);
});
$("codeInput").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase(); });
$("voiceBtn").addEventListener("click", toggleVoice);
$("assistBtn").addEventListener("click", toggleAssist);

// ============================================================
//  Boot
// ============================================================
// Warm up Stockfish in the background; the minimax covers us until it's ready.
stockfish.init().then(() => console.log("Stockfish ready (single-threaded)")).catch(() => console.log("Stockfish unavailable — using bundled minimax"));

(function boot() {
  document.body.dataset.chatmode = "ai";
  renderRank();
  setModelStatus(llm.supported ? "" : "fallback", llm.supported ? "LLM: off" : "LLM: scripted mode");
  if (!llm.supported) $("loaderNote").textContent = "Optional · WebGPU not detected, so the AI uses scripted banter (Stockfish still plays).";
  refreshLoadButton();
  syncControls();

  const sess = loadSession();
  if (sess && sess.sans && sess.sans.length && sess.mode !== "online") {
    // Resume the last vs-AI game, skipping the menu.
    mode = "ai"; unlocked = true;
    $("gate").classList.add("hidden");
    restore(sess);
  } else {
    setEval(0); render();
    showGateStep("mode");   // start at the mode picker
  }
})();
