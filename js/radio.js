// ============================================================
//  radio.js  —  social "listen together" internet radio via the
//  Radio Browser API (free, open, CORS-enabled). We fetch a
//  curated set of stations across genres, keep only HTTPS streams
//  (HTTP streams are blocked as mixed content on GitHub Pages),
//  and play the chosen one in a plain <audio>. Sync between
//  players is handled by the caller over the P2P data channel.
// ============================================================
// Radio Browser's CORS header is intermittent (de1 is load-balanced; some
// backends omit Access-Control-Allow-Origin), which randomly blocked the whole
// list. So: retry direct requests, fall back to a CORS proxy, and cache the
// result in localStorage so it only has to succeed once.
const API = "https://de1.api.radio-browser.info";
const PROXIES = ["https://api.allorigins.win/raw?url=", "https://corsproxy.io/?url="];
const CACHE_KEY = "occ-radio:v2";
const TAGS = ["lofi", "jazz", "classical", "rock", "country", "electronic", "pop", "reggae", "ambient"];

let audio = null;
let lastVolume = 0.5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function directGet(path, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(API + path, { cache: "no-store" }); if (r.ok) return r.json(); } catch {}
    if (i < tries - 1) await sleep(250);
  }
  throw new Error("direct failed");
}
async function proxiedGet(path) {
  const url = API + path;
  for (const prox of PROXIES) {
    try { const r = await fetch(prox + encodeURIComponent(url), { cache: "no-store" }); if (r.ok) return r.json(); } catch {}
  }
  throw new Error("proxy failed");
}
async function robustGet(path) { try { return await directGet(path, 2); } catch { return proxiedGet(path); } }

function readCache() {
  try { const o = JSON.parse(localStorage.getItem(CACHE_KEY)); if (o && Array.isArray(o.list) && o.list.length && Date.now() - o.t < 216e5) return o.list; } catch {}
  return null;
}
function writeCache(list) { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), list })); } catch {} }

const isHttps = (s) => s && s.url_resolved && s.url_resolved.startsWith("https://") && s.name;
function mapStation(s, tag) {
  return { name: (s.name || "Unknown").trim().slice(0, 42), url: s.url_resolved, tag, bitrate: s.bitrate || 0, codec: s.codec || "", uuid: s.stationuuid };
}
function genreOf(s) {
  const t = (s.tags || "").toLowerCase().replace(/-/g, "");
  return TAGS.find((g) => t.includes(g)) || "radio";
}

// A genre-diverse list of working HTTPS stations.
export async function fetchStations() {
  const cached = readCache();
  if (cached) return cached;

  const lists = await Promise.all(TAGS.map((tag) =>
    // Wider window — sparse genres (rock, country) have their HTTPS streams
    // below the (HTTP-heavy) top of the votes list.
    directGet(`/json/stations/search?tag=${encodeURIComponent(tag)}&order=votes&reverse=true&hidebroken=true&limit=24`, 2)
      .then((arr) => arr.filter(isHttps).slice(0, 4).map((s) => mapStation(s, tag)))
      .catch(() => [])
  ));
  const seen = new Set(), out = [];
  for (const list of lists) {
    let n = 0;
    for (const s of list) { if (n >= 2 || seen.has(s.url)) continue; seen.add(s.url); out.push(s); n++; }
  }
  if (out.length < 6) {
    // Direct calls were CORS-blocked or sparse → one broad request via
    // direct-then-proxy, bucketed by genre, so the list is never empty.
    try {
      const arr = await robustGet(`/json/stations/search?order=votes&reverse=true&hidebroken=true&limit=200`);
      for (const s of arr.filter(isHttps)) {
        if (out.length >= 14 || seen.has(s.url_resolved)) continue;
        seen.add(s.url_resolved); out.push(mapStation(s, genreOf(s)));
      }
    } catch {}
  }
  if (out.length) writeCache(out);
  return out;
}

// Returns true if playback started (autoplay can be blocked on the receiver).
export async function playStation(url) {
  stopRadio();
  audio = new Audio(url);
  audio.volume = lastVolume;
  try { await audio.play(); return true; }
  catch { return false; }
}
export function resumeRadio() {
  if (!audio) return Promise.resolve(false);
  return audio.play().then(() => true).catch(() => false);
}
export function stopRadio() {
  if (audio) { try { audio.pause(); } catch {} audio.src = ""; audio = null; }
}
export function setRadioVolume(v) { lastVolume = Math.max(0, Math.min(1, v)); if (audio) audio.volume = lastVolume; }
export function radioVolume() { return lastVolume; }
export function isRadioOn() { return !!audio; }
export function onRadioError(cb) { if (audio) audio.onerror = cb; }
