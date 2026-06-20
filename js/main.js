// ============================================================
//  main.js  —  app controller: board, interaction, engine,
//  LLM chat personas, sound, animation, and session persistence.
// ============================================================
import { Chess } from "https://esm.sh/chess.js@1.0.0";
import { llm } from "./llm.js";
import { PERSONAS, fallbackLine, classifyMove, moveFacts, factText } from "./personas.js";
import { selectKnowledge } from "./chess-knowledge.js";
import { pieceSVG } from "./pieces.js";
import { saveSession, loadSession } from "./storage.js";

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
  overlayIcon.textContent = draw ? "½" : (userWon ? "🏆" : "♚");
  overlayTitle.textContent = draw ? "Draw" : (userWon ? "You win!" : "Checkmate");
  overlaySub.textContent = gameOverText();
  overlay.classList.remove("hidden");
  if (userWon) sfx.win(); else if (!draw) sfx.lose();
  reactEvent(userWon ? "win" : (chess.isCheckmate() ? "lose" : "neutral"), `The game just ended: ${gameOverText()}`);
  persist();
}

// ============================================================
//  Analysis + AI chat reactions
// ============================================================
async function analyzeAndReact(made, byUser) {
  let swing = 0;
  try {
    const ev = await askEngine(chess.fen(), 2);
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
  const ctx = factText(facts, balanceText()) + swingNote(swing, byUser);
  await reactEvent(event, ctx, facts);
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
  if (persona === "teacher") {
    const tips = selectKnowledge(chess, event || "neutral");
    if (tips.length) sys += "\n\nCoaching notes you may draw ONE relevant idea from:\n- " + tips.join("\n- ");
  }
  const msgs = [{ role: "system", content: sys }];
  for (const t of llmTurns.slice(-8)) msgs.push(t);
  if (userText) msgs.push({ role: "user", content: userText });
  else msgs.push({ role: "user", content: persona === "trash"
    ? "React to ONLY the move in the facts above, in 1-2 short, savage sentences."
    : "Comment on ONLY the move in the facts above and give one helpful idea, in 1-3 short sentences." });
  return msgs;
}

// Auto-reaction to a move.
async function reactEvent(event, ctx, facts) {
  if (reacting) return;
  reacting = true;
  try {
    if (llm.ready) {
      const node = addTyping();
      try {
        let text = "";
        await llm.chat(llmMessages(ctx, null, event), (full) => { text = full; node.textEl.textContent = full; }, { maxTokens: 90, temperature: 0.8 });
        text = text.trim() || fallbackLine(persona, event, facts);
        finalizeMsg(node, text);
        llmTurns.push({ role: "assistant", content: text });
      } catch (e) {
        finalizeMsg(node, fallbackLine(persona, event, facts));
      }
    } else {
      addMessage("ai", fallbackLine(persona, event, facts), persona);
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
  const t = document.createElement("div"); t.textContent = text; div.appendChild(t);
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  if (who !== "system") { chatMessages.push({ who, text, cls }); persist(); }
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
}

async function sendUserChat(text) {
  ensureAudio();
  addMessage("user", text);
  llmTurns.push({ role: "user", content: text });

  if (llm.ready) {
    const node = addTyping();
    try {
      const ctx = positionSummary();
      let out = "";
      await llm.chat(llmMessages(ctx, text, "neutral"), (full) => { out = full; node.textEl.textContent = full; }, { maxTokens: 160, temperature: 0.85 });
      out = out.trim();
      if (!out) out = "(…the model went quiet. Try again?)";
      finalizeMsg(node, out);
      llmTurns.push({ role: "assistant", content: out });
    } catch (e) {
      node.typing.remove();
      node.textEl.textContent = "⚠️ The local model errored: " + (e.message || e) + ". Try reloading it.";
      console.error("LLM chat error:", e);
    }
  } else if (llm.supported) {
    addMessage("ai", fallbackLine(persona, "neutral"), persona);
    addMessage("system", "💡 Click “Load local AI brain” above for real, generated replies instead of scripted ones.");
  } else {
    addMessage("ai", fallbackLine(persona, "neutral"), persona);
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

async function loadModel() {
  const btn = $("loadModelBtn"), bar = $("loaderBar"), fill = $("loaderFill"), note = $("loaderNote");
  if (!llm.supported) {
    note.textContent = "⚠️ WebGPU isn't available here, so chat uses built-in scripted lines. Try Chrome or Edge for the full local LLM.";
    setModelStatus("fallback", "LLM: scripted mode"); btn.disabled = true; return;
  }
  const modelId = $("modelSelect").value;
  if (llm.ready) { try { await llm.unload(); } catch {} }
  btn.disabled = true; bar.classList.remove("hidden");
  setModelStatus("loading", "LLM: loading…");
  try {
    await llm.load(modelId, ({ progress, text }) => {
      fill.style.width = Math.round((progress || 0) * 100) + "%";
      note.textContent = text || "Downloading & compiling… (cached after first time)";
    });
    setModelStatus("ready", "LLM: " + PERSONAS[persona].name + " online");
    note.textContent = "✓ Running fully offline now. Pick another model above to switch.";
    bar.classList.add("hidden");
    llmTurns = [];
    addMessage("system", "Local AI brain loaded (" + modelId.split("-").slice(0, 2).join(" ") + ") — running fully offline. 🧠");
    addMessage("ai", PERSONAS[persona].greeting, persona);
  } catch (e) {
    console.error(e);
    note.textContent = "Couldn't load the model (" + e.message + "). Using scripted lines instead.";
    setModelStatus("fallback", "LLM: scripted mode");
    bar.classList.add("hidden");
  } finally {
    refreshLoadButton();
  }
}

// ============================================================
//  Game lifecycle
// ============================================================
function newGame() {
  chess.reset();
  selected = null; legalTargets = []; aiThinking = false;
  lastEvalCp = 0; lastEvalBeforeMove = 0; setEval(0);
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
  saveSession({
    sans: chess.history(), userSide, depth, orientation, persona,
    chat: chatMessages, soundOn, over: chess.isGameOver(),
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
    aiMove();
  }
}

function syncControls() {
  document.querySelectorAll("#difficultySeg .seg-btn").forEach((b) => b.classList.toggle("active", +b.dataset.depth === depth));
  document.querySelectorAll("#sideSeg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.side === userSide));
  document.querySelectorAll("#personaToggle .persona-btn").forEach((b) => b.classList.toggle("active", b.dataset.persona === persona));
  $("soundBtn").textContent = soundOn ? "🔊" : "🔇";
}

// ============================================================
//  Wire up controls
// ============================================================
$("newGameBtn").addEventListener("click", () => { ensureAudio(); newGame(); });
$("overlayNewGame").addEventListener("click", () => { ensureAudio(); newGame(); });
$("flipBtn").addEventListener("click", () => { orientation = orientation === "w" ? "b" : "w"; popIn = true; render(); persist(); });
$("undoBtn").addEventListener("click", () => {
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

$("loadModelBtn").addEventListener("click", loadModel);
$("modelSelect").addEventListener("change", refreshLoadButton);
$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chatInput"); const text = input.value.trim();
  if (!text) return; input.value = ""; sendUserChat(text);
});

// ============================================================
//  Boot
// ============================================================
(function boot() {
  setModelStatus(llm.supported ? "" : "fallback", llm.supported ? "LLM: off" : "LLM: scripted mode");
  if (!llm.supported) $("loaderNote").textContent = "⚠️ WebGPU not detected — chat uses built-in scripted lines. Open in Chrome/Edge for a full local LLM.";
  refreshLoadButton();
  const sess = loadSession();
  if (sess && sess.sans) {
    restore(sess);
  } else {
    setEval(0); syncControls(); render();
    addMessage("system", "Welcome! Make a move, or load the local AI brain for live trash talk.");
    addMessage("ai", PERSONAS[persona].greeting, persona);
  }
})();
