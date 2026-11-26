// Plain HTML stand-in for a reference image, used when image generation is unavailable.
import type { OptionDirection } from "./directions.js";

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

export const OPTION_VIEWPORT = { width: 1312, height: 816 } as const;

export function buildOptionMockup(brief: string, d: OptionDirection): string {
  const p = d.palette;
  const words = brief.trim().replace(/^(a|an|the)\s+/i, "").split(/\s+/).slice(0, 3).join(" ");
  const name = esc((words.charAt(0).toUpperCase() + words.slice(1)) || "Your project");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;width:${OPTION_VIEWPORT.width}px;height:${OPTION_VIEWPORT.height}px;background:${p.bg};color:${p.text};font-family:${d.fontStack};display:flex}
nav{width:220px;padding:28px 20px;border-right:1px solid ${p.border};background:${p.surface}}
nav b{display:block;font-size:20px;margin-bottom:28px}nav span{display:block;padding:10px 12px;margin-bottom:6px;color:${p.muted};border-radius:${d.radius}}
nav span.on{background:${p.surfaceAlt};color:${p.text}}
main{flex:1;padding:40px 48px}h1{font-size:44px;margin:0 0 8px}p{color:${p.muted};margin:0 0 28px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.card{background:${p.surface};border:1px solid ${p.border};border-radius:${d.radius};padding:22px;height:150px}
.card i{display:block;height:10px;width:60%;background:${p.surfaceAlt};border-radius:6px;margin-top:12px}
.card b{color:${p.muted};font-weight:500}
.btn{display:inline-block;margin-top:32px;padding:14px 26px;background:${p.accent};color:${p.bg};border-radius:${d.radius};font-weight:600}
</style></head><body><nav><b>${name}</b><span class="on">Overview</span><span>Activity</span><span>Library</span><span>Settings</span></nav>
<main><h1>Overview</h1><p>${esc(d.label)} direction, placeholder layout</p>
<div class="grid"><div class="card"><b>Today</b><i></i><i></i></div><div class="card"><b>Recent</b><i></i><i></i></div><div class="card"><b>Status</b><i></i><i></i></div>
<div class="card"><b>Tasks</b><i></i><i></i></div><div class="card"><b>Notes</b><i></i><i></i></div><div class="card"><b>Shortcuts</b><i></i><i></i></div></div>
<span class="btn">Primary action</span></main></body></html>`;
}
