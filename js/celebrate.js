// ============================================================
//  celebrate.js  —  full-screen win/lose party: a canvas
//  confetti engine + background music pulled from the iTunes
//  top-songs RSS (CORS-friendly, preview URL embedded in feed).
// ============================================================

// ---------------- Confetti (cannons + fireworks + rain) ----------------
let raf = null, particles = [], ctx = null, cv = null, colors = ["#8b5cff"];
let fireworksLeft = 0, fireworkTimer = 0;

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const SHAPES = ["rect", "circ", "streamer", "star"];

function resize() { if (!cv) return; cv.width = window.innerWidth; cv.height = window.innerHeight; }

function mkRain() {
  const w = cv ? cv.width : 800, h = cv ? cv.height : 600;
  return {
    kind: "rain", x: rand(0, w), y: rand(-h, 0),
    vx: rand(-0.9, 0.9), vy: rand(2, 5.5), g: 0.05, drag: 1,
    size: rand(6, 14), rot: rand(0, 6.283), vr: rand(-0.32, 0.32),
    color: pick(colors), shape: pick(SHAPES), life: Infinity, maxLife: Infinity,
  };
}
function mkSpark(x, y, ang, spd) {
  return {
    kind: "spark", x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, g: 0.13, drag: 0.985,
    size: rand(6, 13), rot: rand(0, 6.283), vr: rand(-0.45, 0.45),
    color: pick(colors), shape: pick(SHAPES), life: rand(55, 110), maxLife: 110,
  };
}
function cannon(x, y, baseAng, spread, n, spd) {
  for (let i = 0; i < n; i++) particles.push(mkSpark(x, y, baseAng + rand(-spread, spread), spd * rand(0.55, 1.15)));
}
function firework() {
  const x = rand(cv.width * 0.18, cv.width * 0.82), y = rand(cv.height * 0.12, cv.height * 0.45), n = 46;
  const c = pick(colors);
  for (let i = 0; i < n; i++) { const p = mkSpark(x, y, (i / n) * 6.283, rand(2.6, 6)); p.color = c; particles.push(p); }
}
function star(c, r) {
  c.beginPath();
  for (let i = 0; i < 5; i++) {
    const o = i * 4 * Math.PI / 5 - Math.PI / 2;
    c.lineTo(Math.cos(o) * r, Math.sin(o) * r);
  }
  c.closePath(); c.fill();
}
function frame() {
  raf = requestAnimationFrame(frame);
  if (!ctx || !cv) return;
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (fireworksLeft > 0 && --fireworkTimer <= 0) { firework(); fireworksLeft--; fireworkTimer = rand(22, 52); }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.vy += p.g; p.vx *= p.drag; p.vy *= p.drag; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
    if (p.kind === "rain") { if (p.y > cv.height + 22) { Object.assign(p, mkRain()); p.y = -20; } }
    else { p.life--; if (p.life <= 0 || p.y > cv.height + 50) { particles.splice(i, 1); continue; } }
    ctx.save();
    ctx.globalAlpha = p.kind === "spark" ? Math.min(1, p.life / 28) : 0.92;
    ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.color;
    if (p.shape === "rect") ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.55);
    else if (p.shape === "streamer") ctx.fillRect(-p.size * 0.16, -p.size * 1.5, p.size * 0.32, p.size * 3);
    else if (p.shape === "star") star(ctx, p.size * 0.72);
    else { ctx.beginPath(); ctx.arc(0, 0, p.size / 2, 0, 6.283); ctx.fill(); }
    ctx.restore();
  }
}
export function startConfetti(canvasEl, palette, opts = {}) {
  cv = canvasEl; ctx = cv.getContext("2d");
  colors = palette && palette.length ? palette : colors;
  resize();
  window.addEventListener("resize", resize);
  const N = window.innerWidth < 640 ? 80 : 130;
  particles = Array.from({ length: N }, () => mkRain());
  if (opts.cannons !== false) {
    cannon(cv.width * 0.05, cv.height * 1.02, -Math.PI / 3, 0.34, 95, 18);        // bottom-left → up-right
    cannon(cv.width * 0.95, cv.height * 1.02, -2 * Math.PI / 3, 0.34, 95, 18);    // bottom-right → up-left
    cannon(cv.width * 0.5, cv.height * 1.06, -Math.PI / 2, 0.5, 70, 16);          // center fountain
  }
  fireworksLeft = opts.fireworks ?? 6; fireworkTimer = 12;
  if (!raf) frame();
}
// Fire an extra confetti volley on demand (e.g. a second pop).
export function confettiBurst() {
  if (!cv) return;
  cannon(cv.width * 0.5, cv.height * 1.05, -Math.PI / 2, 0.55, 80, 17);
}
export function stopConfetti() {
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  window.removeEventListener("resize", resize);
  if (ctx && cv) ctx.clearRect(0, 0, cv.width, cv.height);
  particles = []; fireworksLeft = 0;
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
