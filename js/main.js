// ============================================================
//  main.js  —  app controller: board, interaction, engine,
//  LLM chat personas, and session persistence.
// ============================================================
import { Chess } from "https://esm.sh/chess.js@1.0.0";
import { llm } from "./llm.js";
import { PERSONAS, buildMessages, fallbackLine, classifyMove } from "./personas.js";
import { saveSession, loadSession, clearSession } from "./storage.js";

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const boardEl = $("board");
const statusText = $("statusText");
const turnDot = $("turnDot");
const evalFill = $("evalFill");
const evalText = $("evalText");
const moveListEl = $("moveList");
const capWhiteEl = $("capturedByWhite");
const capBlackEl = $("capturedByBlack");
const overlay = $("boardOverlay");
const overlayTitle = $("overlayTitle");
const overlaySub = $("overlaySub");
const chatLog = $("chatLog");

// ---------- Glyphs ----------
const GLYPH = {
  w: { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" },
  b: { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" },
};
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

// ---------- State ----------
const chess = new Chess();
let userSide = "w";        // 'w' | 'b'
let depth = 2;             // engine search depth
let orientation = "w";     // board orientation
let persona = "trash";
let selected = null;       // selected square e.g. 'e2'
let legalTargets = [];     // verbose moves from `selected`
let aiThinking = false;
let lastEvalCp = 0;        // white-perspective centipawns
let chatMessages = [];     // {who, text, cls}
let reacting = false;      // prevent overlapping auto-reactions

// ---------- Engine worker ----------
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

// ============================================================
//  Rendering
// ============================================================
function render() {
  boardEl.innerHTML = "";
  const board = chess.board(); // board[0] = rank 8
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

      // last-move highlight
      if (last && (last.from === square || last.to === square)) sq.classList.add("last");
      // selection + legal target hints
      if (selected === square) sq.classList.add("sel");
      const tgt = legalTargets.find((m) => m.to === square);
      if (tgt) {
        sq.classList.add("target");
        if (tgt.captured || tgt.flags.includes("e")) sq.classList.add("capture");
      }

      const piece = board[r][f];
      if (piece) {
        // king-in-check highlight
        if (inCheck && piece.type === "k" && piece.color === turn) sq.classList.add("check");
        const span = document.createElement("span");
        span.className = "piece " + (piece.color === "w" ? "white" : "black");
        span.textContent = GLYPH[piece.color][piece.type];
        sq.appendChild(span);
      }

      // coordinate labels on the edges
      if (f === (orientation === "w" ? 0 : 7)) {
        const c = document.createElement("span");
        c.className = "coord rank";
        c.textContent = 8 - r;
        sq.appendChild(c);
      }
      if (r === (orientation === "w" ? 7 : 0)) {
        const c = document.createElement("span");
        c.className = "coord file";
        c.textContent = FILES[f];
        sq.appendChild(c);
      }

      sq.addEventListener("click", () => onSquareClick(square));
      boardEl.appendChild(sq);
    }
  }
  renderStatus();
  renderMoves();
  renderCaptures();
}

function renderStatus() {
  turnDot.className = "dot";
  if (chess.isGameOver()) {
    turnDot.classList.add("over");
    statusText.textContent = gameOverText();
    return;
  }
  if (aiThinking) {
    turnDot.classList.add("thinking");
    statusText.textContent = "AI is thinking…";
    return;
  }
  const turn = chess.turn();
  const yourTurn = turn === userSide;
  const sideName = userSide === "w" ? "White" : "Black";
  statusText.textContent = yourTurn
    ? `Your move — you are ${sideName}.` + (chess.inCheck() ? " You're in check!" : "")
    : "Waiting for the AI…";
}

function gameOverText() {
  if (chess.isCheckmate()) {
    const loser = chess.turn();
    const userWon = loser !== userSide;
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
  for (const m of verbose) {
    if (!m.captured) continue;
    if (m.color === "w") byWhite.push(GLYPH.b[m.captured]);
    else byBlack.push(GLYPH.w[m.captured]);
  }
  capWhiteEl.textContent = byWhite.join("") || "—";
  capBlackEl.textContent = byBlack.join("") || "—";
}

function setEval(cp) {
  lastEvalCp = cp;
  const pawns = cp / 100;
  const pct = 100 / (1 + Math.exp(-pawns / 4));
  evalFill.style.width = pct.toFixed(1) + "%";
  let label;
  if (Math.abs(pawns) >= 100) label = (pawns > 0 ? "+M" : "-M");
  else label = (pawns > 0 ? "+" : "") + pawns.toFixed(1);
  evalText.textContent = label;
}

// ============================================================
//  Interaction
// ============================================================
function onSquareClick(square) {
  if (chess.isGameOver() || aiThinking) return;
  if (chess.turn() !== userSide) return;

  const piece = chess.get(square);

  // If a piece is already selected and this is a legal target, move.
  if (selected) {
    const move = legalTargets.find((m) => m.to === square);
    if (move) { doUserMove(move); return; }
  }

  // Select your own piece.
  if (piece && piece.color === userSide) {
    selected = square;
    legalTargets = chess.moves({ square, verbose: true });
  } else {
    selected = null; legalTargets = [];
  }
  render();
}

async function doUserMove(move) {
  let promotion = move.promotion;
  if (move.flags.includes("p") || (move.promotion && !promotion)) {
    // pawn promotion — ask which piece
    promotion = await pickPromotion(userSide);
    if (!promotion) { selected = null; legalTargets = []; render(); return; }
  }
  const made = chess.move({ from: move.from, to: move.to, promotion });
  selected = null; legalTargets = [];
  render();
  persist();

  // React to the user's move, then let the AI reply.
  await analyzeAndReact(made, true);
  if (!chess.isGameOver()) aiMove();
  else handleGameOver();
}

async function aiMove() {
  if (chess.isGameOver()) return;
  aiThinking = true; renderStatus(); turnDot.className = "dot thinking";
  try {
    const res = await askEngine(chess.fen(), depth);
    if (!res) { aiThinking = false; return; }
    const made = chess.move({ from: res.from, to: res.to, promotion: res.promotion });
    setEval(res.evalCp);
    aiThinking = false;
    selected = null; legalTargets = [];
    render();
    persist();
    // AI reacts only on impactful moves to avoid spam.
    if (made.captured || chess.inCheck() || chess.isGameOver()) {
      await analyzeAndReact(made, false);
    }
    if (chess.isGameOver()) handleGameOver();
  } catch (err) {
    aiThinking = false;
    renderStatus();
    console.error("Engine error:", err);
  }
}

// Promotion picker overlay -> resolves to 'q'|'r'|'b'|'n' or null.
function pickPromotion(color) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "board-overlay";
    wrap.innerHTML = `<div class="overlay-card"><h2 style="font-size:20px">Promote to…</h2>
      <div style="display:flex;gap:10px;justify-content:center;font-size:46px;margin-top:6px">
      ${["q", "r", "b", "n"].map((t) => `<button class="btn btn-ghost promo" data-t="${t}" style="font-size:42px;padding:6px 12px">${GLYPH[color][t]}</button>`).join("")}
      </div></div>`;
    boardEl.parentElement.appendChild(wrap);
    wrap.querySelectorAll(".promo").forEach((b) =>
      b.addEventListener("click", () => { wrap.remove(); resolve(b.dataset.t); })
    );
  });
}

function handleGameOver() {
  render();
  const userWon = chess.isCheckmate() && chess.turn() !== userSide;
  overlayTitle.textContent = chess.isCheckmate() ? (userWon ? "You win! 🏆" : "Checkmate") : "Game over";
  overlaySub.textContent = gameOverText();
  overlay.classList.remove("hidden");
  // Final word from the persona.
  reactEvent(userWon ? "win" : (chess.isCheckmate() ? "lose" : "neutral"),
    `The game just ended: ${gameOverText()}`);
  persist();
}

// ============================================================
//  AI reactions / chat
// ============================================================
async function analyzeAndReact(made, byUser) {
  // Get a fresh eval of the resulting position for swing detection + bar.
  let swing = 0;
  try {
    const ev = await askEngine(chess.fen(), 2);
    if (ev) {
      setEval(ev.evalCp);
      const before = userPersp(lastEvalBeforeMove);
      const after = userPersp(ev.evalCp);
      swing = (after - before) / 100; // pawns, from user's perspective
    }
  } catch {}
  lastEvalBeforeMove = lastEvalCp;

  const info = {
    byUser,
    captured: !!made.captured,
    isCheck: chess.inCheck(),
    isCheckmate: chess.isCheckmate(),
    gameOver: chess.isGameOver(),
    userWon: chess.isCheckmate() && chess.turn() !== userSide,
    swing,
  };
  const event = classifyMove(info);
  const ctx = gameContext(made, info);
  await reactEvent(event, ctx);
}

let lastEvalBeforeMove = 0;
function userPersp(cp) { return userSide === "w" ? cp : -cp; }

function gameContext(made, info) {
  const moverName = info.byUser ? "the user" : "the AI engine";
  const balance = materialBalance();
  return [
    `Last move: ${made.san} by ${moverName}.`,
    made.captured ? `It captured a ${pieceName(made.captured)}.` : "",
    info.isCheck ? "It gives check." : "",
    `Material balance (user minus AI): ${balance >= 0 ? "+" : ""}${balance}.`,
    `It is now ${chess.turn() === userSide ? "the user's" : "the AI's"} turn.`,
  ].filter(Boolean).join(" ");
}

function materialBalance() {
  const v = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  let bal = 0;
  for (const row of chess.board()) for (const p of row) {
    if (!p) continue;
    const s = v[p.type] * (p.color === userSide ? 1 : -1);
    bal += s;
  }
  return bal;
}
function pieceName(t) { return { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" }[t]; }

// Produce a chat line for an event — via LLM if ready, else template.
async function reactEvent(event, ctx) {
  if (reacting) return;
  reacting = true;
  try {
    if (llm.ready) {
      const node = addTyping();
      try {
        const msgs = buildMessages(persona, ctx, null);
        let text = "";
        await llm.chat(msgs, (full) => { text = full; node.textEl.textContent = full; }, { maxTokens: 90 });
        finalizeMsg(node, text || fallbackLine(persona, event));
      } catch (e) {
        finalizeMsg(node, fallbackLine(persona, event));
      }
    } else {
      addMessage("ai", fallbackLine(persona, event), persona);
    }
  } finally {
    reacting = false;
  }
}

// ============================================================
//  Chat UI
// ============================================================
function addMessage(who, text, cls = "") {
  const div = document.createElement("div");
  div.className = `msg ${who}${cls ? " " + cls : ""}`;
  if (who === "ai") {
    const tag = document.createElement("div");
    tag.className = "who";
    tag.textContent = PERSONAS[persona].emoji + " " + PERSONAS[persona].name;
    div.appendChild(tag);
  }
  const t = document.createElement("div");
  t.textContent = text;
  div.appendChild(t);
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  if (who !== "system") { chatMessages.push({ who, text, cls }); persist(); }
  return div;
}

function addTyping() {
  const div = document.createElement("div");
  div.className = `msg ai ${persona}`;
  const tag = document.createElement("div");
  tag.className = "who";
  tag.textContent = PERSONAS[persona].emoji + " " + PERSONAS[persona].name;
  const typing = document.createElement("div");
  typing.className = "typing";
  typing.innerHTML = "<span></span><span></span><span></span>";
  const textEl = document.createElement("div");
  div.append(tag, typing, textEl);
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
}

async function sendUserChat(text) {
  addMessage("user", text);
  if (llm.ready) {
    const node = addTyping();
    try {
      const ctx = gameContext({ san: chess.history().slice(-1)[0] || "(no moves yet)", captured: null },
        { byUser: false, isCheck: chess.inCheck() });
      const msgs = buildMessages(persona, ctx, text);
      let out = "";
      await llm.chat(msgs, (full) => { out = full; node.textEl.textContent = full; }, { maxTokens: 120 });
      finalizeMsg(node, out || fallbackLine(persona, "neutral"));
    } catch (e) {
      finalizeMsg(node, fallbackLine(persona, "neutral"));
    }
  } else {
    addMessage("ai", fallbackLine(persona, "neutral"), persona);
  }
}

// ============================================================
//  LLM loading UI
// ============================================================
function setModelStatus(state, text) {
  const dot = $("modelDot");
  dot.className = "model-dot" + (state ? " " + state : "");
  $("modelStatusText").textContent = text;
}

async function loadModel() {
  const btn = $("loadModelBtn");
  const bar = $("loaderBar");
  const fill = $("loaderFill");
  const note = $("loaderNote");
  if (!llm.supported) {
    note.textContent = "⚠️ WebGPU isn't available in this browser, so the chat AI uses built-in scripted lines. Try Chrome or Edge for the full local LLM.";
    setModelStatus("fallback", "LLM: scripted mode");
    btn.disabled = true;
    return;
  }
  const modelId = $("modelSelect").value;
  btn.disabled = true;
  bar.classList.remove("hidden");
  setModelStatus("loading", "LLM: loading…");
  try {
    await llm.load(modelId, ({ progress, text }) => {
      fill.style.width = Math.round((progress || 0) * 100) + "%";
      note.textContent = text || "Downloading & compiling… (cached after first time)";
    });
    setModelStatus("ready", "LLM: " + PERSONAS[persona].name + " online");
    $("modelLoader").classList.add("hidden");
    addMessage("system", "Local AI brain loaded — running fully offline now. 🧠");
    addMessage("ai", PERSONAS[persona].greeting, persona);
  } catch (e) {
    console.error(e);
    note.textContent = "Couldn't load the model (" + e.message + "). Using scripted lines instead.";
    setModelStatus("fallback", "LLM: scripted mode");
    btn.disabled = false;
    bar.classList.add("hidden");
  }
}

// ============================================================
//  Game lifecycle
// ============================================================
function newGame() {
  chess.reset();
  selected = null; legalTargets = [];
  aiThinking = false;
  lastEvalCp = 0; lastEvalBeforeMove = 0;
  setEval(0);
  overlay.classList.add("hidden");
  orientation = userSide;
  chatMessages = [];
  chatLog.innerHTML = "";
  addMessage("system", "New game started. You play " + (userSide === "w" ? "White" : "Black") + ".");
  addMessage("ai", PERSONAS[persona].greeting, persona);
  render();
  persist();
  if (chess.turn() !== userSide) aiMove(); // AI moves first if user is Black
}

function persist() {
  saveSession({
    sans: chess.history(),
    userSide, depth, orientation, persona,
    chat: chatMessages,
    over: chess.isGameOver(),
  });
}

function restore(sess) {
  userSide = sess.userSide || "w";
  depth = sess.depth || 2;
  orientation = sess.orientation || userSide;
  persona = sess.persona || "trash";
  // replay moves
  chess.reset();
  try { for (const san of sess.sans || []) chess.move(san); } catch {}
  // restore chat
  chatMessages = sess.chat || [];
  chatLog.innerHTML = "";
  for (const m of chatMessages) {
    const div = document.createElement("div");
    div.className = `msg ${m.who}${m.cls ? " " + m.cls : ""}`;
    if (m.who === "ai") {
      const tag = document.createElement("div"); tag.className = "who";
      tag.textContent = (PERSONAS[m.cls]?.emoji || "🤖") + " " + (PERSONAS[m.cls]?.name || "AI");
      div.appendChild(tag);
    }
    const t = document.createElement("div"); t.textContent = m.text; div.appendChild(t);
    chatLog.appendChild(div);
  }
  chatLog.scrollTop = chatLog.scrollHeight;
  // sync UI controls
  syncControls();
  render();
  if (chess.isGameOver()) {
    overlay.classList.remove("hidden");
    overlayTitle.textContent = chess.isCheckmate() ? "Game over" : "Draw";
    overlaySub.textContent = gameOverText();
  } else if (chess.turn() !== userSide) {
    aiMove(); // resume: it was the AI's turn when you left
  }
}

function syncControls() {
  document.querySelectorAll("#difficultySeg .seg-btn").forEach((b) =>
    b.classList.toggle("active", +b.dataset.depth === depth));
  document.querySelectorAll("#sideSeg .seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.side === userSide));
  document.querySelectorAll("#personaToggle .persona-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.persona === persona));
}

// ============================================================
//  Wire up controls
// ============================================================
$("newGameBtn").addEventListener("click", newGame);
$("overlayNewGame").addEventListener("click", newGame);
$("flipBtn").addEventListener("click", () => { orientation = orientation === "w" ? "b" : "w"; render(); persist(); });
$("undoBtn").addEventListener("click", () => {
  if (aiThinking) return;
  // Undo AI move + user move so it's the user's turn again.
  if (chess.history().length === 0) return;
  if (chess.turn() === userSide) chess.undo(); // undo AI reply
  chess.undo();                                 // undo user move
  selected = null; legalTargets = [];
  overlay.classList.add("hidden");
  render(); persist();
});

document.querySelectorAll("#difficultySeg .seg-btn").forEach((b) =>
  b.addEventListener("click", () => {
    depth = +b.dataset.depth;
    syncControls(); persist();
  }));

document.querySelectorAll("#sideSeg .seg-btn").forEach((b) =>
  b.addEventListener("click", () => {
    const side = b.dataset.side;
    if (side === userSide) return;
    userSide = side;
    syncControls();
    newGame(); // changing side starts fresh
  }));

document.querySelectorAll("#personaToggle .persona-btn").forEach((b) =>
  b.addEventListener("click", () => {
    persona = b.dataset.persona;
    syncControls();
    if (llm.ready) setModelStatus("ready", "LLM: " + PERSONAS[persona].name + " online");
    addMessage("ai", PERSONAS[persona].greeting, persona);
    persist();
  }));

$("loadModelBtn").addEventListener("click", loadModel);

$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  sendUserChat(text);
});

// ============================================================
//  Boot
// ============================================================
(function boot() {
  setModelStatus(llm.supported ? "" : "fallback", llm.supported ? "LLM: off" : "LLM: scripted mode");
  if (!llm.supported) {
    $("loaderNote").textContent = "⚠️ WebGPU not detected — chat uses built-in scripted lines. Open in Chrome/Edge for a full local LLM.";
  }
  const sess = loadSession();
  if (sess && sess.sans) {
    restore(sess);
  } else {
    setEval(0);
    syncControls();
    render();
    addMessage("system", "Welcome! Make a move, or load the local AI brain for live trash talk.");
    addMessage("ai", PERSONAS[persona].greeting, persona);
  }
})();
