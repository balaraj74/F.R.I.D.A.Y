// HTML fallback for Reference_Images (Requirement 1.5).
// Builds a self-contained, script-free HTML page for a (screen, direction, index) triple.
// Pure: no I/O. The Playwright capture happens in pipeline.ts.

import { DIRECTION_BRIEFS, SCREEN_BRIEFS, type DirectionBrief } from "./directions.js";
import type { RefIndex, Screen, StyleDirection } from "./plan.js";

/** Viewport used for the capture, so the HTML and the screenshot agree. */
export const MOCKUP_VIEWPORT = { width: 1440, height: 900 } as const;

const NAV_ITEMS = ["Home", "Chat", "Jobs", "Memory", "Settings"];

function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function card(title: string, body: string, extra = ""): string {
  return `<section class="card ${extra}"><h3>${esc(title)}</h3>${body}</section>`;
}

function homeBody(): string {
  return [
    `<h1>Good evening, Sir.</h1><p class="muted">All systems nominal. 3 jobs running.</p>`,
    `<div class="row">`,
    card("Voice", `<p class="big">Listening</p><p class="muted">Wake word armed</p>`),
    card("Gateway", `<p class="big">Online</p><p class="muted">Latency 42 ms</p>`),
    card(
      "Today",
      `<ul><li>09:30 Standup notes</li><li>14:00 Dependency review</li><li>18:00 Nightly evals</li></ul>`,
    ),
    `</div>`,
    card(
      "Recent activity",
      `<ul><li>Summarized 12 unread emails</li><li>Merged branch design/refs</li><li>Generated weekly report</li></ul>`,
    ),
    `<div class="actions"><button>New chat</button><button>Start job</button><button class="ghost">Open memory</button></div>`,
  ].join("");
}

function chatBody(): string {
  return [
    `<div class="thread">`,
    `<div class="msg user"><span class="who">You</span>Summarize what changed in the repo today.</div>`,
    `<div class="msg bot"><span class="who">FRIDAY</span>Four files changed under src/design. The planning helpers and the selection file are in place.</div>`,
    card(
      "Tool call: git diff --stat",
      `<pre>src/design/refs/plan.ts | 140 +++\nsrc/design/refs/selection.ts | 180 +++</pre>`,
      "tool",
    ),
    `<div class="msg bot"><span class="who">FRIDAY</span>Next up is the generation pipeline.</div>`,
    `</div>`,
    `<div class="composer"><span class="muted">Message FRIDAY</span><button>Send</button></div>`,
  ].join("");
}

function jobsBody(): string {
  const col = (name: string, jobs: Array<[string, string, string]>): string =>
    `<div class="col"><h3>${esc(name)}</h3>${jobs
      .map(
        ([goal, meta, cost]) =>
          `<div class="card"><p class="big">${esc(goal)}</p><p class="muted">${esc(meta)}</p><p class="muted">${esc(cost)}</p></div>`,
      )
      .join("")}</div>`;
  return [
    `<h1>Jobs</h1>`,
    `<div class="board">`,
    col("Running", [
      ["Refactor HUD tokens", "Task 3 of 7 · 12m", "48k tokens"],
      ["Nightly evals", "Task 1 of 2 · 3m", "9k tokens"],
    ]),
    col("Waiting for approval", [
      ["Publish release notes", "Needs approval · git push", "21k tokens"],
    ]),
    col("Done", [
      ["Weekly report", "Verified · 6m", "15k tokens"],
      ["Inbox triage", "Verified · 4m", "7k tokens"],
    ]),
    `</div>`,
  ].join("");
}

const BODIES: Record<Screen, () => string> = {
  home: homeBody,
  chat: chatBody,
  jobs_board: jobsBody,
};

function styles(b: DirectionBrief, direction: StyleDirection, index: RefIndex): string {
  const p = b.palette;
  const serifHeads = direction === "editorial";
  const glass = direction === "glass";
  const side = index === 0;
  return `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${MOCKUP_VIEWPORT.width}px;height:${MOCKUP_VIEWPORT.height}px;overflow:hidden}
body{background:${p.bg};color:${p.text};font-family:${b.fontStack};font-size:15px;line-height:1.5}
.shell{display:flex;flex-direction:${side ? "row" : "column"};width:100%;height:100%}
nav{display:flex;flex-direction:${side ? "column" : "row"};gap:${side ? "6px" : "24px"};padding:20px;${side ? "width:220px;border-right" : "height:64px;align-items:center;border-bottom"}:1px solid ${p.border};background:${p.surface}}
nav .brand{font-weight:700;letter-spacing:.08em;color:${p.accent};${side ? "margin-bottom:16px" : "margin-right:24px"}}
nav a{padding:6px 10px;color:${p.muted};border-radius:${b.radius}}
nav a.on{color:${p.text};background:${p.surfaceAlt}}
main{flex:1;padding:32px 40px;overflow:hidden;${side ? "" : "max-width:1040px;"}}
${side ? "" : `aside{position:absolute;right:0;top:64px;bottom:0;width:340px;padding:24px;border-left:1px solid ${p.border};background:${p.surface}}`}
h1{font-size:${serifHeads ? "44px" : "28px"};font-weight:${serifHeads ? "400" : "600"};margin-bottom:6px}
h3{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:${p.muted};margin-bottom:10px;font-weight:600}
.muted{color:${p.muted}}
.big{font-size:20px;font-weight:600}
.row{display:flex;gap:16px;margin:20px 0}
.row .card{flex:1}
.card{background:${p.surface};border:1px solid ${p.border};border-radius:${b.radius};padding:16px;margin-bottom:16px;${glass ? "backdrop-filter:blur(12px);" : ""}}
ul{list-style:none}li{padding:4px 0;border-bottom:1px solid ${p.border}}li:last-child{border-bottom:0}
pre{font-family:ui-monospace,monospace;font-size:13px;color:${p.muted}}
.actions{display:flex;gap:12px;margin-top:8px}
button{background:${p.accent};color:${p.bg};border:0;padding:9px 18px;border-radius:${b.radius};font:inherit;font-weight:600}
button.ghost{background:transparent;color:${p.text};border:1px solid ${p.border}}
.thread{display:flex;flex-direction:column;gap:14px;max-width:760px}
.msg{padding:12px 16px;border-radius:${b.radius};background:${p.surface};border:1px solid ${p.border}}
.msg.user{align-self:flex-end;background:${p.surfaceAlt}}
.who{display:block;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${p.accent};margin-bottom:2px}
.composer{position:absolute;bottom:32px;left:${side ? "300px" : "40px"};width:760px;display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:${p.surface};border:1px solid ${p.border};border-radius:${b.radius}}
.board{display:flex;gap:20px;margin-top:20px}
.col{flex:1}
`;
}

/** Context line shown in the aside (alternate layout only), so index 1 differs visibly from index 0. */
function asideHtml(screen: Screen, index: RefIndex): string {
  if (index === 0) {
    return "";
  }
  return `<aside><h3>Details</h3><p class="muted">${esc(SCREEN_BRIEFS[screen].title)} context and shortcuts.</p></aside>`;
}

/**
 * Builds a complete HTML document for the combination.
 * Self-contained: inline CSS only, no scripts, no external fonts or images,
 * so the capture works offline and cannot execute page code.
 */
export function buildHtmlMockup(
  screen: Screen,
  direction: StyleDirection,
  index: RefIndex,
): string {
  const brief = DIRECTION_BRIEFS[direction];
  const nav = NAV_ITEMS.map(
    (item) =>
      `<a${item === (screen === "jobs_board" ? "Jobs" : SCREEN_BRIEFS[screen].title) ? ' class="on"' : ""}>${esc(item)}</a>`,
  ).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(SCREEN_BRIEFS[screen].title)} · ${esc(direction)} · ${index}</title>
<style>${styles(brief, direction, index)}</style></head>
<body><div class="shell"><nav><span class="brand">F.R.I.D.A.Y</span>${nav}</nav>
<main>${BODIES[screen]()}</main>${asideHtml(screen, index)}</div></body></html>
`;
}
