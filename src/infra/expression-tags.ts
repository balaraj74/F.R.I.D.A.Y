// <sigh>, <breath> and <laugh> are voice directions for FRIDAY's spoken replies. They must never
// reach anything that displays text (WhatsApp, other channels).
const TAG = /[ \t]*<(sigh|breath|laugh)>[ \t]*/gi;

export function stripExpressionTags(text: string): string {
  return text.replace(TAG, " ").replace(/^ +/gm, "").replace(/ {2,}/g, " ");
}
