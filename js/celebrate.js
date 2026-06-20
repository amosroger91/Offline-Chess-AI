// ============================================================
//  celebrate.js  —  full-screen win/lose party: a canvas
//  confetti engine + background music pulled from the iTunes
//  top-songs RSS (CORS-friendly, preview URL embedded in feed).
// ============================================================

// ---------------- Confetti ----------------
let raf = null, particles = [], ctx = null, cv = null, colors = ["#8b5cff"];

function resize() {
  if (!cv) return;
  cv.width = window.innerWidth;
  cv.height = window.innerHeight;
}
function makeParticle(spread) {
  const w = cv ? cv.width : 800, h = cv ? cv.height : 600;
  return {
    x: Math.random() * w,
    y: spread ? Math.random() * -h : -20,
    vx: (Math.random() - 0.5) * 1.8,
    vy: 2 + Math.random() * 3.2,
    size: 6 + Math.random() * 8,
    rot: Math.random() * Math.PI * 2,
    vr: (Math.random() - 0.5) * 0.32,
    color: colors[(Math.random() * colors.length) | 0],
    shape: Math.random() < 0.5 ? "rect" : "circ",
  };
}
function frame() {
  raf = requestAnimationFrame(frame);
  if (!ctx || !cv) return;
  ctx.clearRect(0, 0, cv.width, cv.height);
  for (const p of particles) {
    p.x += p.vx; p.y += p.vy; p.vy += 0.045; p.rot += p.vr; p.vx *= 0.999;
    if (p.y > cv.height + 24) Object.assign(p, makeParticle(false));
    ctx.save();
    ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    ctx.fillStyle = p.color; ctx.globalAlpha = 0.92;
    if (p.shape === "rect") ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
    else { ctx.beginPath(); ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }
}
export function startConfetti(canvasEl, palette) {
  cv = canvasEl; ctx = cv.getContext("2d");
  colors = palette && palette.length ? palette : colors;
  resize();
  window.addEventListener("resize", resize);
  const N = window.innerWidth < 640 ? 110 : 190;
  particles = Array.from({ length: N }, () => makeParticle(true));
  if (!raf) frame();
}
export function stopConfetti() {
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  window.removeEventListener("resize", resize);
  if (ctx && cv) ctx.clearRect(0, 0, cv.width, cv.height);
  particles = [];
}

// ---------------- Music (iTunes top songs) ----------------
let audio = null;

export async function fetchTopSongPreview() {
  const res = await fetch("https://itunes.apple.com/us/rss/topsongs/limit=10/json", { cache: "no-store" });
  if (!res.ok) throw new Error("rss " + res.status);
  const data = await res.json();
  const entries = (data.feed && data.feed.entry) || [];
  if (!entries.length) throw new Error("no entries");
  const pick = entries[(Math.random() * entries.length) | 0];
  const name = pick["im:name"] ? pick["im:name"].label : "Unknown";
  const artist = pick["im:artist"] ? pick["im:artist"].label : "";
  const link = (pick.link || []).find((l) => l.attributes && l.attributes["im:assetType"] === "preview");
  const preview = link && link.attributes ? link.attributes.href : null;
  const imgs = pick["im:image"] || [];
  const art = imgs.length ? imgs[imgs.length - 1].label : null;
  return { name, artist, preview, art };
}

// Returns true if playback actually started (autoplay can be blocked).
export async function playPreview(url) {
  stopMusic();
  audio = new Audio(url);
  audio.loop = true;
  audio.volume = 0.0;
  try {
    await audio.play();
    // gentle fade-in
    let v = 0; const target = 0.38;
    const id = setInterval(() => { v = Math.min(target, v + 0.04); if (audio) audio.volume = v; if (v >= target) clearInterval(id); }, 60);
    return true;
  } catch (e) {
    return false;
  }
}
export async function resumeMusic() {
  if (!audio) return false;
  try { await audio.play(); audio.volume = 0.38; return true; } catch { return false; }
}
export function setMuted(m) { if (audio) audio.muted = m; }
export function stopMusic() {
  if (audio) { try { audio.pause(); } catch {} audio.src = ""; audio = null; }
}
