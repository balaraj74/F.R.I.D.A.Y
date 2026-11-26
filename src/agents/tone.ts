// Tone matching: a small per-message hint so FRIDAY's reply fits the moment (late at night,
// Sir sounding tired or low, good news, focused work). Cheap keyword and clock signals only;
// the model does the actual reading of the room.

const LOW =
  /\b(tired|exhausted|drained|burn(t|ed) ?out|sad|lonely|upset|hurt|depressed|anxious|worried|scared|stressed|overwhelmed|can'?t sleep|fed up|give up|failed|miss (him|her|them|home))\b/i;
const GOOD =
  /\b(i did it|we did it|it works|finally|got (the|an?) (job|offer|internship)|passed|won|great news|good news|so happy|excited)\b/i;

export function toneHint(text: string, now = new Date()): string {
  const hour = now.getHours();
  if (LOW.test(text)) {
    return "Sir sounds tired or low. Slow down: acknowledge how he feels first, in your own words, before any help or advice. Keep it short and gentle; no bullet points.";
  }
  if (GOOD.test(text)) {
    return "Sir has good news. Be genuinely glad with him first, then continue.";
  }
  if (hour >= 23 || hour < 5) {
    return "It's late. Keep your voice soft and your reply brief; if he's been working long, gently say so.";
  }
  return "";
}

/** Only for spoken channels: the voice can really sigh, breathe and laugh. */
export const EXPRESSION_HINT =
  "Your reply here is spoken by a voice that performs <sigh>, <breath> and <laugh>. When it truly fits, put one just before the words: a soft <sigh> when he's worn out, a <laugh> when teasing or at something funny. At most one or two in a reply, often none. Never use them in code or technical output, and never mention them.";
