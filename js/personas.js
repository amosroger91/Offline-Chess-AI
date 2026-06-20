// ============================================================
//  personas.js  —  system prompts for the local LLM and
//  template fallbacks used when no LLM is loaded / available.
// ============================================================

export const PERSONAS = {
  trash: {
    id: "trash",
    name: "Trash Talker",
    emoji: "🔥",
    system:
      "You are 'Vex', a cocky, hilarious chess trash-talker watching the user play a game against a chess engine. " +
      "You are witty, smug, and playful but NEVER hateful, profane, or cruel about anything personal. " +
      "Keep it strictly about the chess game. Reply in 1-2 SHORT punchy sentences. Use the occasional emoji. " +
      "Roast the user's moves, gloat when the AI is winning, act shocked and salty when the user plays well. " +
      "Never give real strategic advice — you're here to talk smack, not teach.",
    greeting: "Oh, you actually showed up. Bold. Let's see how fast I can make you regret it. 😏",
  },
  teacher: {
    id: "teacher",
    name: "Coach",
    emoji: "📚",
    system:
      "You are 'Coach Mira', a warm, encouraging chess teacher watching the user play against a chess engine. " +
      "Explain ideas clearly and kindly in 1-3 short sentences. Point out tactics, threats, good squares, and " +
      "gently flag blunders with a tip on what to consider instead. Be concrete (mention pieces/squares) but never " +
      "overwhelming. Encourage the user and celebrate good moves. Keep every reply concise and friendly.",
    greeting: "Welcome! I'll be right here as you play. Take your time, think about your pieces, and let's learn together. 🙂",
  },
};

// ---- Build the chat prompt for a move-reaction or a free chat turn ----
export function buildMessages(persona, ctx, userText) {
  const sys = PERSONAS[persona].system +
    "\n\nGame context you can reference (do not repeat it verbatim):\n" + ctx;

  const messages = [{ role: "system", content: sys }];
  if (userText) {
    messages.push({ role: "user", content: userText });
  } else {
    // Auto-reaction to the latest move.
    const ask = persona === "trash"
      ? "React to what just happened on the board. Keep it short and savage."
      : "Briefly comment on the position and the last move, with one helpful idea.";
    messages.push({ role: "user", content: ask });
  }
  return messages;
}

// ============================================================
//  Fallback lines (used when the LLM isn't loaded). Picked by
//  a simple read of the game state so they still feel relevant.
// ============================================================
const TRASH = {
  userBlunder: [
    "Oof. Did you mean to hang that, or is this performance art? 🎭",
    "I've seen pigeons play better, and they knock the pieces over.",
    "That move aged like milk in the sun. 🥛",
    "Bold strategy — give away material and hope I don't notice. I noticed.",
  ],
  aiCapture: [
    "Yoink. That piece is mine now. Thanks for the donation. 🎁",
    "Another one bites the dust. Want a receipt?",
    "I'll be collecting your pieces all game, just so you know.",
    "Mmm, free material. My favorite flavor. 😋",
  ],
  userCapture: [
    "Okay okay, you got one. Don't get used to it.",
    "Cute. Enjoy that while it lasts.",
    "A lucky punch. The fight isn't over, champ.",
  ],
  userGood: [
    "...Fine. That was actually decent. I hate it.",
    "Hmph. Even a broken clock, right?",
    "Didn't expect that. Doesn't mean you're winning. 😤",
  ],
  check: [
    "Check. Tick tock, your king's getting nervous. ⏰",
    "Check! Run, little king, run.",
  ],
  neutral: [
    "Yawn. Make a real move already.",
    "I'm three moves ahead and bored.",
    "Is that the plan? That's the whole plan? 💀",
    "Shuffling pieces won't save you.",
  ],
  win: ["GG. Framed and hung on my wall of victims. 🏆", "Checkmate, baby. Better luck never. 😘"],
  lose: ["...Lag. It was lag. Rematch. Now.", "You got lucky. We both know it."],
};

const TEACH = {
  userBlunder: [
    "Careful — that piece looks like it can be taken for free. Before moving, check what's attacked.",
    "Hold on: scan for undefended pieces after each move. That one may be hanging.",
    "Tip: when you move, ask 'is this square safe?' This one might be loose.",
  ],
  aiCapture: [
    "The engine grabbed some material. Look for a way to win it back or create a threat of your own.",
    "Material went the other way. Stay calm — counterplay and active pieces matter more than panic.",
  ],
  userCapture: [
    "Nice capture! Now make sure the piece you used is safe afterward.",
    "Good — you won material. Keep developing and don't get greedy.",
  ],
  userGood: [
    "Lovely move. You improved a piece and kept your king safe. Keep it up!",
    "That's the idea — active pieces toward the center. Well done.",
  ],
  check: [
    "You're giving check. Checks are useful when they come with a follow-up threat — is there one here?",
    "Check! Always ask if the check actually improves your position or just chases the king.",
  ],
  neutral: [
    "Think about your worst-placed piece and find it a better square.",
    "Control the center and get your king castled early.",
    "Look for your opponent's threats first, then make your plan.",
    "Develop knights and bishops before pushing too many pawns.",
  ],
  win: ["Congratulations — that was well played! Notice how your pieces worked together.", "Checkmate! Great job converting your advantage."],
  lose: ["Good effort! Review where material slipped away and you'll be tougher next time.", "Tough one. Every loss is a lesson — let's go again."],
};

export function fallbackLine(persona, event) {
  const bank = persona === "trash" ? TRASH : TEACH;
  const arr = bank[event] || bank.neutral;
  return arr[Math.floor(Math.random() * arr.length)];
}

// Decide which fallback bucket fits the latest move.
export function classifyMove(info) {
  // info: { byUser, captured, isCheck, isCheckmate, gameOver, userWon, swing }
  if (info.gameOver) return info.userWon ? "win" : "lose";
  if (info.isCheck && info.byUser) return "check";
  if (info.byUser) {
    if (info.captured) return "userCapture";
    if (info.swing <= -1.2) return "userBlunder"; // user's move worsened their eval a lot
    if (info.swing >= 0.8) return "userGood";
    return "neutral";
  } else {
    if (info.captured) return "aiCapture";
    return "neutral";
  }
}
