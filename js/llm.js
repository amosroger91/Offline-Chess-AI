// ============================================================
//  llm.js  —  Offline LLM via WebLLM (WASM + WebGPU).
//  The model downloads once and is cached by the browser, so
//  afterwards it runs fully offline. If WebGPU is unavailable
//  we expose `supported = false` and the app uses template
//  fallbacks instead — the game still works everywhere.
// ============================================================

let engine = null;       // MLCEngine instance
let webllm = null;       // lazily imported module
let currentModel = null;
let loading = false;

export const llm = {
  ready: false,
  supported: hasWebGPU(),

  get busy() { return loading; },
  get model() { return currentModel; },

  /**
   * Load (download + init) a model. `onProgress` receives {progress, text}.
   */
  async load(modelId, onProgress) {
    if (!this.supported) throw new Error("WebGPU not supported in this browser.");
    if (loading) throw new Error("Already loading a model.");
    loading = true;
    this.ready = false;
    try {
      if (!webllm) {
        webllm = await import("https://esm.run/@mlc-ai/web-llm");
      }
      engine = new webllm.MLCEngine({
        initProgressCallback: (r) => {
          if (onProgress) onProgress({ progress: r.progress ?? 0, text: r.text ?? "" });
        },
      });
      await engine.reload(modelId);
      currentModel = modelId;
      this.ready = true;
      return true;
    } finally {
      loading = false;
    }
  },

  /**
   * Stream a chat completion. `messages` is an OpenAI-style array.
   * `onToken(fullTextSoFar)` is called as tokens arrive.
   * Returns the final text.
   */
  async chat(messages, onToken, opts = {}) {
    if (!this.ready || !engine) throw new Error("Model not ready.");
    const stream = await engine.chat.completions.create({
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.9,
      max_tokens: opts.maxTokens ?? 120,
      // Discourage looping/repeating itself at the sampling level.
      frequency_penalty: opts.frequencyPenalty ?? 0.6,
      presence_penalty: opts.presencePenalty ?? 0.5,
    });
    let full = "";
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content || "";
      if (delta) {
        full += delta;
        if (onToken) onToken(full);
      }
    }
    return full.trim();
  },

  async unload() {
    if (engine) { try { await engine.unload(); } catch {} }
    engine = null; currentModel = null; this.ready = false;
  },
};

function hasWebGPU() {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}
