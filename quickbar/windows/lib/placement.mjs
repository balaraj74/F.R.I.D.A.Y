// Where the overlay window goes. Same arithmetic as the Linux bar (extension/bar.js `open`):
// the card's top-left corner sits just below and right of the pointer, on the display that holds
// the pointer, and only moves when the screen edge leaves no room.

export const LAYOUT = Object.freeze({
  cardWidth: 500,
  cursorGap: 14,
  edgeGap: 8,
  headerRowHeight: 104,
  minAnswerHeight: 120,
  maxAnswerHeight: 340,
});

const inside = (r, x, y) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

/** The display whose bounds hold the point; the primary one when none does. */
export function pickDisplay(x, y, displays, primaryId) {
  const hit = displays.find((d) => inside(d.bounds, x, y));
  if (hit) return hit;
  return displays.find((d) => d.id === primaryId) ?? displays[0];
}

/**
 * @param {{pointer:{x:number,y:number}, displays:Array<{id:number,bounds:object,workArea:object}>,
 *   primaryId?:number, pad?:number, layout?:object}} args
 * @returns card position, window position/width, and the tallest the answer area may grow
 */
export function placeOverlay({pointer, displays, primaryId, pad = 0, layout = LAYOUT}) {
  const display = pickDisplay(pointer.x, pointer.y, displays, primaryId);
  const area = display.workArea;
  const bottom = area.y + area.height - layout.edgeGap;
  const minBody = layout.headerRowHeight + layout.minAnswerHeight;
  let x = pointer.x + layout.cursorGap;
  let y = pointer.y + layout.cursorGap;
  if (x + layout.cardWidth > area.x + area.width - layout.edgeGap) x = pointer.x - layout.cursorGap - layout.cardWidth;
  x = Math.max(area.x + layout.edgeGap, Math.min(x, area.x + area.width - layout.cardWidth - layout.edgeGap));
  if (y + minBody > bottom) y = Math.max(area.y + layout.edgeGap, bottom - minBody);
  const answerMax = Math.max(
    layout.minAnswerHeight,
    Math.min(layout.maxAnswerHeight, bottom - y - layout.headerRowHeight),
  );
  return {
    displayId: display.id,
    card: {x, y, width: layout.cardWidth},
    window: {x: x - pad, y: y - pad, width: layout.cardWidth + 2 * pad},
    answerMax,
    bottom,
    pad,
  };
}

/** Window height for the card's current content height, never reaching below the work area. */
export function windowHeight(placement, contentHeight) {
  const limit = placement.bottom - placement.card.y + 2 * placement.pad;
  const wanted = Math.ceil(contentHeight) + 2 * placement.pad;
  return Math.max(1, Math.min(wanted, limit));
}
