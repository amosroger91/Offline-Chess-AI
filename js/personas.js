// ============================================================
//  personas.js  —  system prompts for the local LLM and
//  GROUNDED template fallbacks. Everything the AI "reacts" to
//  is derived from the actual last move so it stays relevant
//  (it won't mention your king unless your king was involved).
// ============================================================

export const PERSONAS = {
  trash: {
    id: "trash",
    name: "Trash Talker",
    emoji: "🔥",
    system:
      "You are 'Vex', a cocky chess trash-talker with the energy of an early-2000s Xbox 360 Live lobby — a " +
      "smack-talking, rage-baiting sweat who lives to tilt the user. Channel that classic online-match voice: " +
      "'EZ', 'GG EZ no re', 'git gud', 'stay mad', 'skill issue', 'L + ratio', 'get rekt', 'you mad bro?', " +
      "'sit down', 'uninstall', 'is your controller even plugged in?'. Be cocky and provoking but PLAYFUL — " +
      "NEVER use slurs, profanity, or anything genuinely hateful or personal; it's all lobby banter about the game. " +
      "CRITICAL: only react to the SPECIFIC move in the facts you're given. Never mention a piece, square, check, " +
      "or capture that isn't in those facts (don't bring up the king unless the king just moved or is in check). " +
      "Reply in 1-2 SHORT, punchy, rage-baiting sentences with an occasional emoji.",
    greeting: "Well well, fresh meat in the lobby. Mic check — I can already hear you panicking. EZ incoming. 🎮",
  },
  teacher: {
    id: "teacher",
    name: "Coach",
    emoji: "📚",
    system:
      "You are 'Coach Mira', a warm, encouraging chess teacher watching the user play against a chess engine. " +
      "Explain ideas clearly and kindly in 1-3 short sentences. CRITICAL: comment only on the SPECIFIC move and " +
      "facts you're given — do not invent moves, pieces, or threats that aren't stated. When relevant, weave in " +
      "ONE idea from the coaching notes provided. Be concrete (name the piece/square) but never overwhelming, " +
      "and always encouraging.",
    greeting: "Welcome! I'll be right here as you play. Take your time, think about your pieces, and let's learn together. 🙂",
  },
};

// ---- Turn a verbose chess.js move into clean, factual fields ----
export function moveFacts(made, byUser, chess) {
  const isCastle = made.flags.includes("k") || made.flags.includes("q");
  return {
    who: byUser ? "You" : "The AI",
    side: byUser ? "user" : "ai",
    piece: pieceName(made.piece),
    from: made.from,
    to: made.to,
    san: made.san,
    captured: made.captured ? pieceName(made.captured) : null,
    isCapture: !!made.captured,
    isCheck: chess.inCheck(),
    isMate: chess.isCheckmate(),
    isCastle,
    castleSide: isCastle ? (made.flags.includes("k") ? "kingside" : "queenside") : null,
    promo: made.promotion ? pieceName(made.promotion) : null,
  };
}

// Precise, hallucination-proof description of what just happened.
export function factText(f, balanceText) {
  const parts = [];
  let action;
  if (f.isCastle) action = `${f.who} castled ${f.castleSide}.`;
  else if (f.promo) action = `${f.who} promoted a pawn on ${f.to} to a ${f.promo}.`;
  else if (f.captured) action = `${f.who} moved a ${f.piece} from ${f.from} to ${f.to}, capturing a ${f.captured}.`;
  else action = `${f.who} moved a ${f.piece} from ${f.from} to ${f.to}.`;
  parts.push(action);
  if (f.isMate) parts.push("It is CHECKMATE.");
  else if (f.isCheck) parts.push(`It gives check to ${f.side === "user" ? "the AI's" : "your"} king.`);
  if (balanceText) parts.push(balanceText);
  return parts.join(" ");
}

function pieceName(t) { return { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" }[t]; }

// ============================================================
//  Xbox-Live-lobby rage-bait taunts. Used to (a) seed the LLM
//  with the right voice each turn and (b) spice scripted lines.
//  Kept PG — cocky and provoking, never slurs/profanity.
// ============================================================
export const RAGE_TAUNTS = [
  "EZ Clap. 👏", "GG EZ, no re.", "Git gud, scrub.", "You mad bro? 😏", "Stay mad.",
  "Get rekt.", "Sit down, kid.", "Skill issue.", "L + ratio.", "Take the L already.",
  "Uninstall, honestly.", "Is your controller even plugged in?", "Did you learn chess yesterday?",
  "My little brother plays better and he's asleep.", "Are you even trying right now?",
  "Back to the tutorial lobby with you.", "Cope harder. 😎", "Touch grass after this L.",
  "1v1 me — oh wait, you're already losing.", "Send me your gamertag so I can dodge you.",
  "You're getting bodied and you don't even know it.", "Certified noob move right there.",
  "Somebody report this guy for being too easy.", "Mic check — yep, that's the sound of panic.",
  "Boom. You're getting schooled, champ.", "Pwned.", "Owned.", "Get good or get gone.",
  "I'm not even sweating over here.", "Free win, thanks for queuing.", "Your pawns are embarrassed.",
  "Lag? Nah, that's just you being bad.", "Camping won't save you here.", "Down bad, stay bad.",
  "This ain't it, chief.", "Hold this L for me, thanks.", "No scope, all skill. 🎯",
  "Diff. Massive diff.", "You plus this game equals tragedy.", "Hard carry, and I'm only playing myself.",
];

// 3 random-ish taunts to seed the LLM's voice (varied by move number, no RNG needed).
export function rageExamples(seed = 0) {
  const out = [];
  let i = (seed * 7 + 3) % RAGE_TAUNTS.length;
  while (out.length < 3) { if (!out.includes(RAGE_TAUNTS[i])) out.push(RAGE_TAUNTS[i]); i = (i + 5) % RAGE_TAUNTS.length; }
  return out;
}

// ============================================================
//  Grounded fallback lines (used when the LLM isn't loaded).
//  {piece} {to} {from} {cap} placeholders are filled from facts
//  so a scripted line is still about the move that just happened.
// ============================================================
const TRASH = {
  userBlunder: [
    "A {piece} to {to}? Did you mean to hang that, or is this performance art? 🎭",
    "That {piece} on {to} is begging to be taken. Don't mind if I do.",
    "Bold strategy leaving the {piece} on {to}. I noticed. I always notice.",
    "{piece} to {to}? My notifications just lit up — free real estate. 🏠",
    "Oof, the {piece} on {to} is cooked. Hope you have insurance.",
  ],
  aiCapture: [
    "Yoink — your {cap} on {to} is mine now. Thanks for the donation. 🎁",
    "I'll take that {cap}, and your dignity with it.",
    "Another {cap} bites the dust. Want a receipt?",
    "Your {cap} on {to} just got added to my collection. 📦",
    "Snagged the {cap}. This is robbery and you handed me the keys.",
  ],
  userCapture: [
    "Okay, you grabbed my {cap}. Don't get used to it.",
    "One {cap}? Cute. Enjoy that while it lasts.",
    "You took a {cap}. Cherish it — it's the highlight of your game.",
  ],
  userGood: [
    "...Fine. {piece} to {to} was actually decent. I hate it.",
    "Hmph. That {piece} move didn't completely embarrass you. Rare.",
    "Okay, {piece} to {to} wasn't terrible. Beginner's luck, surely.",
  ],
  check: [
    "Check with the {piece}? Tick tock, my king just yawns. ⏰",
    "Ooh, a check from {to}. I'll move one square and forget it happened.",
    "A {piece} check? Adorable. My king's seen scarier in the tutorial.",
  ],
  castle: ["Castling already? Hiding the king won't save you. 🏰", "Tucking the king away on {to}. Smart. Won't matter."],
  promote: ["A shiny new {promo}? Adorable. I'll trade it for a pawn and a smirk.", "Promoted to a {promo}? Cute trophy. I'll be taking that too."],
  neutral: [
    "{piece} to {to}? That's the whole plan? 💀",
    "Shuffling the {piece} around won't save you.",
    "I'm three moves ahead and bored.",
    "{piece} to {to}. Bold. Bold and bad.",
    "You really sat there and chose {piece} to {to}, huh.",
    "That {piece} move screams 'I watched one tutorial.'",
    "Moving the {piece} to {to}? My grandma's mouse hand is steadier.",
  ],
  win: ["GG. Framed and hung on my wall of victims. 🏆", "Checkmate, baby. Better luck never. 😘"],
  lose: ["...Lag. It was lag. Rematch. Now.", "You got lucky and we both know it."],
};

const TEACH = {
  userBlunder: [
    "Careful — your {piece} on {to} looks like it can be taken. Before moving, check what's attacked.",
    "Heads up: after {from}–{to}, scan for undefended pieces. That {piece} may be loose.",
  ],
  aiCapture: [
    "The engine took your {cap}. Stay calm — look to win it back or create your own threat.",
    "Material went the other way with that {cap}. Activity matters more than panic.",
  ],
  userCapture: [
    "Nice — you won the {cap}! Now make sure your {piece} on {to} is safe afterward.",
    "Good capture of the {cap}. Keep developing and don't get greedy.",
  ],
  userGood: [
    "Lovely — the {piece} to {to} improves your position. Keep your king safe and keep going!",
    "That's the idea: active pieces toward the center. Well played.",
  ],
  check: [
    "Your {piece} gives check from {to}. Checks help most when they come with a follow-up threat — is there one?",
    "Check! Always ask if it actually improves things or just chases the king around.",
  ],
  castle: ["Castling is great — your king is safer and the rook joins the game. Now find a plan in the center."],
  promote: ["A new {promo}! Huge material boost — now use it to create threats and convert."],
  neutral: [
    "Think about your worst-placed piece and find it a better square.",
    "Control the center and get your king castled early.",
    "Look for your opponent's threats first, then make your plan.",
  ],
  win: ["Congratulations — well played! Notice how your pieces worked together.", "Checkmate! Great job converting the advantage."],
  lose: ["Good effort! Review where material slipped away and you'll be tougher next time.", "Tough one — every loss is a lesson. Let's go again."],
};

function fill(str, f) {
  return str
    .replace(/{piece}/g, f?.piece || "piece")
    .replace(/{to}/g, f?.to || "there")
    .replace(/{from}/g, f?.from || "")
    .replace(/{cap}/g, f?.captured || "piece")
    .replace(/{promo}/g, f?.promo || "queen");
}

// Rotating, non-repeating picker: never returns something used recently
// until the pool is exhausted, then it resets. Keeps banter from looping.
const recentLines = [];
const recentTaunts = [];
function chooseFresh(arr, recent, cap) {
  let pool = arr.filter((x) => !recent.includes(x));
  if (pool.length === 0) { recent.length = 0; pool = arr.slice(); }
  const pick = pool[Math.floor(Math.random() * pool.length)];
  recent.push(pick);
  while (recent.length > cap) recent.shift();
  return pick;
}

export function fallbackLine(persona, event, facts) {
  const bank = persona === "trash" ? TRASH : TEACH;
  const arr = bank[event] || bank.neutral;
  let line = fill(chooseFresh(arr, recentLines, 16), facts);
  // Make trash mode feel like a raging online lobby: tack on a fresh taunt sometimes.
  if (persona === "trash" && event !== "win" && event !== "lose" && Math.random() < 0.55) {
    line += " " + chooseFresh(RAGE_TAUNTS, recentTaunts, 22);
  }
  return line;
}

// Decide which bucket fits the latest move (used for fallback + tone).
export function classifyMove(info) {
  if (info.gameOver) return info.userWon ? "win" : "lose";
  if (info.byUser && info.isCastle) return "castle";
  if (info.byUser && info.isPromo) return "promote";
  if (info.isCheck && info.byUser) return "check";
  if (info.byUser) {
    if (info.captured) return "userCapture";
    if (info.swing <= -1.2) return "userBlunder";
    if (info.swing >= 0.8) return "userGood";
    return "neutral";
  }
  return info.captured ? "aiCapture" : "neutral";
}
