# ♟️ Offline Chess AI

Play chess against an offline engine and get **trash-talked** (or coached) by a
large language model that runs **entirely in your browser** — no servers, no API
keys, no data leaving your machine. Built to deploy straight to **GitHub Pages**.

![chess](https://img.shields.io/badge/runs-100%25%20in%20browser-7c5cff) ![offline](https://img.shields.io/badge/AI-offline%20WASM%2FWebGPU-29d3a6)

## What it does

- **Play chess** against an offline opponent — a custom alpha-beta engine (with
  piece-square tables) that runs in a Web Worker, with three strength levels.
- **Live AI chat** with two personas while you play:
  - 🔥 **Trash Talker** — roasts your moves and gloats.
  - 📚 **Coach** — explains tactics and gently flags blunders.
- **Offline LLM** via [WebLLM](https://github.com/mlc-ai/web-llm): the model
  (Qwen / Llama, your pick) downloads once, is cached by the browser, and then
  runs fully offline using WASM + WebGPU.
- **Session caching** — your game, move history, and chat are saved to
  `localStorage`, so you can close the tab and **come back where you left off**.
  Hit **New Game** any time to start fresh.
- **Graceful fallback** — no WebGPU? The chat falls back to built-in scripted
  trash-talk / coaching lines so the whole thing still works everywhere.
- Polished, responsive dark UI with eval bar, captured pieces, and move list.

## Run locally

It's a static site — any static server works (ES modules need `http://`, not
`file://`):

```bash
# from the repo root
python -m http.server 8000
# then open http://localhost:8000
```

Or with Node: `npx serve` .

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. **Settings → Pages → Build and deployment → Source: “Deploy from a branch”.**
3. Branch: `main`, folder: `/ (root)`. Save.
4. Open the published URL. Click **“Load local AI brain”** to download a model
   (one-time), or just start playing — the scripted personas work immediately.

The included `.nojekyll` file makes Pages serve the `js/` and `css/` folders
verbatim.

## Browser support

| Feature | Requirement |
|---|---|
| Chess game + scripted chat | Any modern browser |
| Local LLM trash talk / coaching | **WebGPU** (Chrome / Edge 113+, on a GPU-capable machine) |

The first model load downloads a few hundred MB (Qwen 0.5B) up to ~2 GB (Llama
3.2 3B). After that it's cached and works offline.

## Project layout

```
index.html            # markup + layout
css/styles.css        # all styling
js/main.js            # app controller: board, interaction, glue
js/engine-worker.js   # offline chess engine (alpha-beta) in a Web Worker
js/llm.js             # WebLLM loader + streaming chat
js/personas.js        # persona prompts + scripted fallback lines
js/storage.js         # localStorage session persistence
```

External libs are loaded as ES modules from a CDN (`chess.js`, `@mlc-ai/web-llm`).

## Credits

- [chess.js](https://github.com/jhlywa/chess.js) — move generation & rules.
- [WebLLM](https://github.com/mlc-ai/web-llm) — in-browser LLM inference.
