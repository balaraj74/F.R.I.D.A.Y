// What is sent to the gateway for one question. Kept identical to quickbar/daemon/daemon.mjs
// (a test compares the two sources).

export const SESSION_KEY = 'agent:main:quickbar';

export const QUICK_NOTE =
  '[Quick bar: Sir summoned you from his desktop. Answer in a short spoken lead first: one or two plain sentences ' +
  'with no markdown, then a blank line, then any detail he may want to read.]';

/** @param {{text:string, image?:{base64:string,mimeType:string}|null}} q */
export function buildAskRequest({text, image = null}) {
  const note = image ? `${QUICK_NOTE} A screenshot of his screen is attached.` : QUICK_NOTE;
  return {sessionKey: SESSION_KEY, message: `${text}\n\n${note}`, image: image ?? null};
}
