<p align="center">
  <a href="https://amosroger91.github.io/Offline-Chess-AI/">
    <img src="https://img.shields.io/badge/▶%20%20PLAY%20NOW-Offline%20Chess%20AI-92C83E?style=for-the-badge&labelColor=107C10&color=92C83E" alt="Play Now" height="64" />
  </a>
</p>

<h3 align="center">
  🎮 <a href="https://amosroger91.github.io/Offline-Chess-AI/">amosroger91.github.io/Offline-Chess-AI</a>
</h3>

# ♟️ Offline Chess AI

A chess game with an **Xbox-360-dashboard** look that runs **100% in the browser** —
no backend, no API keys, no build step. Play a real chess engine (**Stockfish**),
get **trash-talked or coached** by a local LLM, or play a **friend peer-to-peer**
with **text + voice chat**. Win and a confetti screen drops with a song pulled live
from the iTunes charts. Deploys to **GitHub Pages** as static files.

![browser](https://img.shields.io/badge/runs-100%25%20in%20browser-92C83E)
![engine](https://img.shields.io/badge/engine-Stockfish%20(WASM)-107C10)
![p2p](https://img.shields.io/badge/multiplayer-WebRTC%20P2P-7c5cff)
![serverless](https://img.shields.io/badge/backend-none-29d3a6)

---

## Table of contents

- [Architecture at a glance](#architecture-at-a-glance)
- [The rules engine](#1-the-rules-engine-chessjs)
- [The chess engine (opponent)](#2-the-chess-engine-stockfish--minimax-fallback)
- [The persona / LLM engine](#3-the-persona--llm-engine)
- [The multiplayer engine](#4-the-multiplayer-engine-peerjs-p2p)
- [Voice + text chat](#5-voice--text-chat-webrtc-media)
- [The song / celebration engine](#6-the-song--celebration-engine)
- [The skill engine](#7-the-skill-engine-account-less-elo)
- [UX systems](#8-ux-systems)
- [Progressive enhancement & browser support](#progressive-enhancement--browser-support)
- [Run locally / deploy](#run-locally)
- [Project layout](#project-layout)
- [Credits](#credits)

---

## Architecture at a glance

Everything is a **static site**: `index.html` + `css/styles.css` + a handful of
ES-module `js/` files. There is **no bundler and no server** — modules are loaded
natively by the browser, and third-party libraries are pulled from CDNs as ESM.
State lives in `localStorage`; the only network calls are CDN fetches, the LLM
model download (cached), the iTunes chart fetch, and WebRTC signaling for P2P.

```
                         ┌─────────────── main.js (controller) ───────────────┐
   chess.js (rules) ◄────┤  board render · interaction · turn/mode state · UI │
                         └───┬─────────┬──────────┬──────────┬──────────┬─────┘
                             │         │          │          │          │
              stockfish-engine.js   llm.js     online.js   celebrate.js skill.js
               (Stockfish WASM     (WebLLM    (PeerJS P2P  (confetti +  (local Elo
                in a Web Worker)    persona    + voice)     iTunes song) + ranks)
                                    chat)
              engine-worker.js          personas.js / chess-knowledge.js
               (minimax fallback)        (voice + tactics for the LLM)
              pieces.js (SVG set)        storage.js (session persistence)
```

Each subsystem is intentionally a separate module with a small surface so it can
fail independently and degrade gracefully (see
[Progressive enhancement](#progressive-enhancement--browser-support)).

---

## 1. The rules engine ([chess.js](https://github.com/jhlywa/chess.js))

All legality, move generation, SAN/FEN, check / checkmate / stalemate / draw
detection, and game history come from **chess.js** (`esm.sh/chess.js@1.0.0`). The
app never trusts the UI or the network for legality — every move (local, engine,
or a move received from a P2P opponent) is validated by `chess.move()`, and an
illegal/desynced remote move is rejected rather than applied.

- Board state of truth: a single `Chess` instance in `main.js`.
- Rendering reads `chess.board()`; highlights read `chess.history({verbose:true})`.
- The engine and the eval bar are fed FEN strings (`chess.fen()`).

## 2. The chess engine (Stockfish + minimax fallback)

The opponent's moves and the evaluation bar come from **Stockfish**, not a toy
engine.

- **`js/stockfish-engine.js`** loads `stockfish.js@10.0.2` — a **single-file
  asm.js build** — inside a **Web Worker** created from a `Blob` that does
  `importScripts(<cdn url>)`. The single-threaded asm.js flavor is deliberate: the
  strong threaded/NNUE builds need `SharedArrayBuffer`, which requires
  `COOP`/`COEP` cross-origin-isolation headers that **GitHub Pages cannot set**.
  The asm.js build needs **no special headers**, so it just works on Pages.
- Communication is the **UCI protocol** over `postMessage`: `uci` → `uciok`,
  `isready` → `readyok`, then `position fen …` + `go movetime …`, parsing
  `bestmove` and `info … score cp|mate …`.
- **Difficulty** maps to UCI `Skill Level` + a time budget: Casual = skill 2 /
  200 ms, Club = skill 9 / 450 ms, Sharp = skill 20 / 800 ms.
- **Eval bar / blunder detection** run a separate full-strength quick search
  (skill 20, ~300 ms) and convert the side-to-move score to White's perspective.
- Searches are **serialized through a promise queue** (one engine, one `go` at a
  time).
- **Fallback:** `js/engine-worker.js` is a hand-written **alpha-beta minimax with
  piece-square tables** (also in a Web Worker). If Stockfish fails to load, the app
  transparently falls back to it, so there is always a working opponent.

> We avoid the `coi-serviceworker` COOP/COEP shim on purpose: enabling
> `COEP: require-corp` would break the app's other cross-origin resources
> (WebLLM model shards, PeerJS, iTunes audio, Google Fonts), so single-threaded
> Stockfish is the right trade-off here.

## 3. The persona / LLM engine

The chat personality is a **local LLM** running in your browser via
[**WebLLM**](https://github.com/mlc-ai/web-llm) (`@mlc-ai/web-llm`, WASM + WebGPU).
The opponent's *moves* are Stockfish; the LLM only drives *conversation*, so the
game is fully playable without it.

- **`js/llm.js`** — loads/streams a model (default **Qwen2.5 0.5B**, with Llama
  3.2 1B/3B options). The model downloads once and is cached by the browser, then
  runs offline. Choosing "Play the AI" auto-loads it (progress bar) before the
  game starts; typing a chat message also lazily spins it up.
- **`js/personas.js`** — two personas:
  - 🔥 **Trash Talker ("Vex")** — early-2000s Xbox-Live-lobby rage-bait energy.
  - 📚 **Coach ("Mira")** — warm, concrete tactical guidance.
- **Grounded reactions:** every move is turned into a precise fact string
  (piece, from→to, capture, check, castle, promotion) and the model is told to
  reference *only* those facts — so it won't, e.g., mention your king unless your
  king actually moved or is in check.
- **Tilt escalation:** Vex's tone tracks the live eval — `crushing → winning →
  even → losing → tilted` — gloating when ahead, coping/in-denial when behind.
- **Streak callouts:** consecutive blunders or strong moves are detected from the
  eval swing and called out ("that's 3 blunders in a row…").
- **Anti-repetition:** the model is shown its own recent lines and told not to
  reuse them, plus frequency/presence penalties; the scripted fallback uses a
  rotating non-repeating picker.
- **Brevity:** tight length rules + low `max_tokens` + a `sanitizeReply()` pass
  that strips markdown, trims to ~one sentence, and caps emoji — so it reads like
  a chat message, not an essay.
- **Coach knowledge base (`js/chess-knowledge.js`):** a curated set of tactics
  (forks, pins, skewers, deflection, back-rank, opposition, passed pawns, opening
  principles…). To avoid overloading a small model, a **position-aware retriever**
  injects only 2–3 relevant tips per turn (by game phase + what just happened).
- **Scripted fallback:** with no WebGPU (or before the model loads), a hand-written
  bank of mood/streak-aware lines carries the personality so the experience works
  everywhere.

## 4. The multiplayer engine (PeerJS P2P)

`js/online.js` provides **serverless, account-less peer-to-peer** play over WebRTC.

- **Why PeerJS, not Trystero:** the project originally used Trystero, but its free
  public signaling became unreliable — the default **nostr** relays now require
  auth (`auth-required` / `blocked: only certain pubkeys`), and the torrent/MQTT
  trackers stopped matching peers. We verified two-browser tests where none of the
  three strategies connected, while a raw single-page WebRTC loopback connected
  fine — i.e. **the failure was signaling, not WebRTC**. We switched to
  [**PeerJS**](https://peerjs.com) (`peerjs@1.5.4`), whose maintained public broker
  cloud reliably connects two real browsers; verified end-to-end (connect → color
  assignment → move sync → voice).
- **Room model:** the **host registers under the room code as its peer id**
  (`occ-<CODE>`); the joiner connects to it. One **reliable `DataConnection`**
  carries typed messages — `{t:'move'|'chat'|'meta'|'ctrl', d}` — for moves, chat,
  name/rating exchange, and control (resign / rematch).
- **Colors:** host plays White, joiner Black (deterministic for both sides); the
  board auto-flips to each player's perspective.
- **Robustness:** a 25 s "still connecting…" timeout with a retry button;
  `peer-unavailable` → "no game with that code"; `unavailable-id` (rare code
  collision) → auto-regenerate the code.
- The local Stockfish still runs **client-side** during online games to drive the
  eval bar and Coach-assist hints — it just isn't the opponent.

## 5. Voice + text chat (WebRTC media)

In online mode the chat panel becomes **peer chat**, and voice rides the same
PeerJS connection.

- **Text:** sent over the data channel (`sendChat`), rendered as opponent bubbles.
- **Voice:** `getUserMedia({audio})` → `peer.call(opponentId, stream)`; the other
  side auto-answers (with its own mic if enabled) and the remote stream is attached
  to a hidden autoplay `<audio>` sink. A 🎤 button toggles mic / mute, with a 🔊
  "in voice" indicator.
- Verified end-to-end with two browsers: both peers receive each other's **live**
  audio track.

## 6. The song / celebration engine

`js/celebrate.js` powers the win/lose screen — styled as an Xbox
**"Achievement Unlocked"**.

- **Confetti:** a dependency-free `<canvas>` particle system (gravity, rotation,
  recycling), themed green on a win, red/orange on a loss.
- **Music:** on game end it `fetch`es the **iTunes top-songs RSS**
  (`https://itunes.apple.com/us/rss/topsongs/limit=10/json`). That endpoint sends
  `Access-Control-Allow-Origin: *` **and** embeds the 30-second `audio/x-m4a`
  preview URL directly in the feed — so it plays straight from the browser with no
  proxy or backend. A random track is picked, faded in, and looped behind the
  celebration with an animated equalizer, **song — artist** label, and a mute
  toggle. If autoplay is blocked, the pill becomes a "▶ Tap to play" button.

## 7. The skill engine (account-less Elo)

`js/skill.js` tracks skill **per browser**, with no accounts — it lives in
`localStorage` (the browser "cache"), so clearing your cache resets your skill.

- **Rating:** a standard **Elo** update (K=32) after every game. vs-AI uses the
  difficulty tier's rating (Casual ≈ 600, Club ≈ 1400, Sharp ≈ 2100); online games
  exchange ratings over the data channel and both sides apply the update
  (honor-system, since there are no accounts).
- **Rank badge:** a Gamerscore-style header badge — **Wood → Bronze → Silver →
  Gold → Platinum → Diamond → Grandmaster** — colored by tier, with the rating
  delta shown on the end screen.
- **Coach-assist for uneven skill:** in online games, peers exchange ratings; if
  you're the **underdog** (gap > 150), Coach assist turns on and privately suggests
  the Stockfish best move after each opponent move (toggle with 📚). This ties the
  [chess engine](#2-the-chess-engine-stockfish--minimax-fallback) and the
  [skill engine](#7-the-skill-engine-account-less-elo) together to level the field.

## 8. UX systems

- **Xbox 360 theme:** an animated green **energy-sphere** background with rotating
  light rays, glossy lime "blade" buttons, a ring-of-light brand mark + status dot,
  Red-Ring-of-Death red for the Trash Talker, and the `Rajdhani` display font.
- **Pieces:** the classic **Cburnett SVG set** is embedded inline (`js/pieces.js`)
  so the board is crisp, scalable, and offline. (A `viewBox` is injected at runtime
  because the source SVGs ship without one — that's what keeps pieces centered at
  any size.)
- **Board interactions:** tap-to-select with legal-move dots, last-move / check /
  capture highlights, a **FLIP-style slide animation** for each move, a promotion
  picker, a flippable board, and undo (vs AI).
- **Eval bar:** a vertical chess.com-style bar driven by the Stockfish score.
- **Sound:** synthesized **WebAudio** effects (move / capture / check / win / lose)
  — no audio files — with a mute toggle.
- **Session persistence (`js/storage.js`):** the vs-AI game, move history, chat,
  persona, and sound preference are saved to `localStorage`; reload and you resume
  where you left off (online games are not persisted).
- **Mobile UX:** below 1120 px the three-column desktop grid collapses to a
  **bottom tab bar** (Play / Chat / Info) that swaps views, with an unread badge on
  the Chat tab, safe-area insets, and `100dvh` sizing.

## Progressive enhancement & browser support

The chess game and core UX work in **any modern browser**. Heavier features layer
on where supported and degrade cleanly where not:

| Feature | Needs | Fallback if unavailable |
|---|---|---|
| Chess vs AI (Stockfish) + eval | WASM / Web Workers | Bundled minimax engine |
| LLM trash-talk / coaching | **WebGPU** (desktop Chrome/Edge) | Scripted mood/streak banter |
| Online multiplayer + voice | WebRTC + mic permission | (single-player still works) |
| Celebration music | `fetch` + audio autoplay | "Tap to play" button |

The first LLM model download is a few hundred MB (Qwen 0.5B) up to ~2 GB
(Llama 3.2 3B); after that it's cached and offline. Stockfish, PeerJS, chess.js,
and fonts are small CDN loads.

## Run locally

It's a static site — any static server works (ES modules need `http://`, not
`file://`):

```bash
# from the repo root
python -m http.server 8000
# then open http://localhost:8000
```

Or `npx serve`. For local **multiplayer** testing, open two browser windows/devices,
**Create** a game in one, and **Join** with the code in the other.

## Deploy to GitHub Pages

1. Push to GitHub.
2. **Settings → Pages → Build and deployment → Source: "Deploy from a branch".**
3. Branch `main`, folder `/ (root)`. Save.
4. Open the published HTTPS URL (HTTPS is required for mic/voice).

The included `.nojekyll` file makes Pages serve the `js/` and `css/` folders
verbatim.

## Project layout

```
index.html                # markup + layout (gate/mode-picker, board, chat, end screen)
css/styles.css            # Xbox-360 theme + all styling (responsive, mobile tabs)
js/main.js                # controller: board, interaction, mode/turn state, glue
js/stockfish-engine.js    # Stockfish (asm.js) in a Web Worker — opponent + eval
js/engine-worker.js       # alpha-beta minimax fallback engine (Web Worker)
js/llm.js                 # WebLLM loader + streaming chat
js/personas.js            # personas, grounded reactions, mood/streak, scripted fallback
js/chess-knowledge.js     # tactics KB + position-aware retrieval for the Coach
js/online.js              # PeerJS P2P: room codes, move/chat/meta/ctrl, voice
js/skill.js               # local Elo rating + rank tiers
js/celebrate.js           # canvas confetti + iTunes top-songs music
js/pieces.js              # embedded Cburnett SVG piece set
js/storage.js             # localStorage session persistence
```

**External libraries** (all loaded as ESM/scripts from CDNs — nothing vendored
except the piece SVGs):

| Library | Used for | Source |
|---|---|---|
| chess.js | rules / move gen | `esm.sh/chess.js@1.0.0` |
| Stockfish | opponent engine | `cdn.jsdelivr.net/npm/stockfish.js@10.0.2` |
| WebLLM | local LLM chat | `esm.run/@mlc-ai/web-llm` |
| PeerJS | WebRTC P2P signaling | `esm.sh/peerjs@1.5.4` |
| iTunes RSS | celebration music | `itunes.apple.com/us/rss/topsongs` |
| Rajdhani / Inter | fonts | Google Fonts |

## Credits

- [chess.js](https://github.com/jhlywa/chess.js) — move generation & rules
- [Stockfish](https://stockfishchess.org/) / [stockfish.js](https://github.com/nmrugg/stockfish.js) — chess engine
- [WebLLM](https://github.com/mlc-ai/web-llm) — in-browser LLM inference
- [PeerJS](https://peerjs.com) — WebRTC peer-to-peer
- Cburnett chess piece SVGs (CC BY-SA 3.0, via Wikimedia Commons)
- Apple iTunes RSS feeds — celebration soundtrack
