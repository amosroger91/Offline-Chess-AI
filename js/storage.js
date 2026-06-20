// ============================================================
//  storage.js  —  session persistence in localStorage so the
//  game (and chat) survive reloads and you can "come back".
// ============================================================
const KEY = "offline-chess-ai:v1";

export function saveSession(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    // Quota or privacy mode — fail silently, game still works in-memory.
  }
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearSession() {
  try { localStorage.removeItem(KEY); } catch {}
}
