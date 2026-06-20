// ============================================================
//  stockfish-engine.js  —  Stockfish (single-file asm.js) in a
//  Web Worker via importScripts. No .wasm, no threads, so it
//  needs no COOP/COEP headers and runs fine on GitHub Pages.
//  Falls back gracefully (engine.ready stays false) if it can't
//  load, and the app uses the bundled minimax instead.
// ============================================================
const SF_URL = "https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js";

let sf = null;
let pending = null;          // { resolve, scoreCp }
let queue = Promise.resolve(); // serialize searches (one engine)
let readyResolve, readyReject;

export const stockfish = {
  ready: false,
  ready_promise: null,

  init() {
    if (this.ready_promise) return this.ready_promise;
    this.ready_promise = new Promise((resolve, reject) => {
      readyResolve = resolve; readyReject = reject;
      try {
        const blob = URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(SF_URL)})`], { type: "application/javascript" }));
        sf = new Worker(blob);
      } catch (e) { return reject(e); }

      const initTimer = setTimeout(() => reject(new Error("Stockfish load timeout")), 20000);

      sf.onerror = (e) => { clearTimeout(initTimer); reject(new Error("Stockfish worker error: " + (e.message || e))); };
      sf.onmessage = (e) => {
        const line = typeof e.data === "string" ? e.data : (e.data && e.data.data) || "";
        if (line.includes("uciok")) { post("isready"); return; }
        if (line.includes("readyok")) {
          clearTimeout(initTimer);
          if (!stockfish.ready) { stockfish.ready = true; readyResolve(true); }
          return;
        }
        if (!pending) return;
        if (line.startsWith("info") && line.includes(" score ")) {
          const cp = parseScore(line);
          if (cp !== null) pending.scoreCp = cp;
        } else if (line.startsWith("bestmove")) {
          const uci = line.split(/\s+/)[1];
          const r = pending; pending = null;
          r.resolve({ uci, scoreCp: r.scoreCp });
        }
      };
      post("uci");
    }).catch((e) => { console.warn("Stockfish unavailable:", e.message); throw e; });
    return this.ready_promise;
  },

  // Opponent move at a given skill (0-20) and time budget.
  async bestMove(fen, { skill = 20, movetime = 500 } = {}) {
    return search(fen, { skill, movetime });
  },

  // Full-strength quick eval (for the eval bar / swing / coach hints).
  async evaluate(fen, movetime = 300) {
    return search(fen, { skill: 20, movetime });
  },
};

function search(fen, { skill, movetime }) {
  const task = () => new Promise((resolve) => {
    pending = { resolve, scoreCp: 0 };
    post(`setoption name Skill Level value ${skill}`);
    post("position fen " + fen);
    post("go movetime " + movetime);
  }).then(({ uci, scoreCp }) => {
    const stm = (fen.split(/\s+/)[1] || "w");
    const evalCp = stm === "w" ? scoreCp : -scoreCp; // → White's perspective
    return parseUci(uci, evalCp);
  });
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

function post(cmd) { if (sf) sf.postMessage(cmd); }

function parseScore(line) {
  const m = line.match(/score (cp|mate) (-?\d+)/);
  if (!m) return null;
  if (m[1] === "mate") return (Number(m[2]) >= 0 ? 1 : -1) * 100000;
  return Number(m[2]);
}

function parseUci(uci, evalCp) {
  if (!uci || uci === "(none)") return null;
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : undefined,
    evalCp,
  };
}
