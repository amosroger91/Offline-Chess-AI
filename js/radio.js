// ============================================================
//  radio.js  —  social "listen together" internet radio via the
//  Radio Browser API (free, open, CORS-enabled). We fetch a
//  curated set of stations across genres, keep only HTTPS streams
//  (HTTP streams are blocked as mixed content on GitHub Pages),
//  and play the chosen one in a plain <audio>. Sync between
//  players is handled by the caller over the P2P data channel.
// ============================================================
// Only mirrors that are actually reachable with CORS from a browser today.
// (The old nl1/at1/fr1 hosts are dead; the server list now advertises just de1.)
const MIRRORS = [
  "https://de1.api.radio-browser.info",
  "https://all.api.radio-browser.info",   // round-robin fallback
  "https://de2.api.radio-browser.info",
];
const TAGS = ["lofi", "jazz", "classical", "rock", "country", "electronic", "pop", "reggae", "ambient"];

let baseCache = null;
let audio = null;
let lastVolume = 0.5;

// Resolve (and cache) one working mirror up front, so the per-genre fan-out
// doesn't waste time falling through dead hosts on every request.
async function resolveBase() {
  if (baseCache) return baseCache;
  for (const m of MIRRORS) {
    try { const r = await fetch(m + "/json/stations/search?limit=1&hidebroken=true", { cache: "no-store" }); if (r.ok) { baseCache = m; return m; } }
    catch {}
  }
  throw new Error("Radio Browser unreachable");
}
async function get(path) {
  let base;
  try { base = await resolveBase(); } catch (e) { throw e; }
  const r = await fetch(base + path, { cache: "no-store" });
  if (!r.ok) throw new Error("status " + r.status);
  return r.json();
}

const isHttps = (s) => s && s.url_resolved && s.url_resolved.startsWith("https://") && s.name;
function mapStation(s, tag) {
  return { name: (s.name || "Unknown").trim().slice(0, 42), url: s.url_resolved, tag, bitrate: s.bitrate || 0, codec: s.codec || "", uuid: s.stationuuid };
}
function genreOf(s) {
  const t = (s.tags || "").toLowerCase().replace(/-/g, "");
  return TAGS.find((g) => t.includes(g)) || "radio";
}

// A genre-diverse list of working HTTPS stations. Tolerant of partial failures,
// with a single-request fallback so one bad mirror can't blank the whole list.
export async function fetchStations() {
  await resolveBase(); // confirm a working mirror before fanning out
  const lists = await Promise.all(TAGS.map((tag) =>
    // Fetch a wider window — sparse genres (rock, country) have their HTTPS
    // streams below the (HTTP-heavy) top of the votes list.
    get(`/json/stations/search?tag=${encodeURIComponent(tag)}&order=votes&reverse=true&hidebroken=true&limit=24`)
      .then((arr) => arr.filter(isHttps).slice(0, 4).map((s) => mapStation(s, tag)))
      .catch(() => [])
  ));
  const seen = new Set(), out = [];
  for (const list of lists) {
    let n = 0;
    for (const s of list) { if (n >= 2 || seen.has(s.url)) continue; seen.add(s.url); out.push(s); n++; }
  }
  if (out.length >= 6) return out;
  // Fallback: one broad top-voted request, bucketed by genre.
  try {
    const arr = await get(`/json/stations/search?order=votes&reverse=true&hidebroken=true&limit=150`);
    for (const s of arr.filter(isHttps)) {
      if (out.length >= 14 || seen.has(s.url_resolved)) continue;
      seen.add(s.url_resolved); out.push(mapStation(s, genreOf(s)));
    }
  } catch {}
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
