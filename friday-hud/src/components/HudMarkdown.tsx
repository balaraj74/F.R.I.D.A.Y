import { stripExpressionTags } from '../services/speech-text';
import React, { useState } from 'react';
import { Copy, Check, ExternalLink, Workflow } from 'lucide-react';
import {
  BrowserSessionCard,
  GitDiffCard,
  ApprovalGateCard,
  DurableTaskCard,
} from './cards';
import { GeneratedImage } from './GeneratedImage';

interface HudMarkdownProps {
  content: string;
  isUser?: boolean;
  /** Called with a chat message when Sir clicks one of FRIDAY's design options. */
  onChoose?: (message: string) => void;
}

type InlineToken =
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'bold-italic'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; label: string; url: string }
  | { type: 'text'; value: string };

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'hr' }
  | { type: 'image'; path: string; alt: string }
  | { type: 'design-choice'; options: Array<{ id: number; label: string }> }
  | { type: 'code'; lang: string; code: string }
  | { type: 'blockquote'; text: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: Array<{ num: string; text: string }> }
  | { type: 'paragraph'; text: string };

function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let remaining = text;
  const regex = /(\*\*\*[\s\S]+?\*\*\*|\*\*[\s\S]+?\*\*|\*[\s\S]+?\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/;

  while (remaining) {
    const match = remaining.match(regex);
    if (!match || match.index === undefined) {
      tokens.push({ type: 'text', value: remaining });
      break;
    }

    if (match.index > 0) {
      tokens.push({ type: 'text', value: remaining.slice(0, match.index) });
    }

    const raw = match[0];
    if (raw.startsWith('***') && raw.endsWith('***')) {
      tokens.push({ type: 'bold-italic', value: raw.slice(3, -3) });
    } else if (raw.startsWith('**') && raw.endsWith('**')) {
      tokens.push({ type: 'bold', value: raw.slice(2, -2) });
    } else if (raw.startsWith('*') && raw.endsWith('*')) {
      tokens.push({ type: 'italic', value: raw.slice(1, -1) });
    } else if (raw.startsWith('`') && raw.endsWith('`')) {
      tokens.push({ type: 'code', value: raw.slice(1, -1) });
    } else if (raw.startsWith('[')) {
      const linkMatch = raw.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        tokens.push({ type: 'link', label: linkMatch[1], url: linkMatch[2] });
      } else {
        tokens.push({ type: 'text', value: raw });
      }
    }

    remaining = remaining.slice(match.index + raw.length);
  }
  return tokens;
}

/** A picture FRIDAY made: her "MEDIA:/path" line, or a markdown image with an absolute path. */
export function parseImageLine(line: string): { path: string; alt: string } | null {
  const t = line.trim();
  const media = t.match(/^MEDIA:\s*(\/\S.*?)\s*$/);
  if (media) return { path: media[1], alt: '' };
  const md = t.match(/^!\[([^\]]*)\]\((\/[^)]+)\)$/);
  return md ? { path: md[2], alt: md[1] } : null;
}

/** FRIDAY's "DESIGN_CHOICE: 1=Instrument; 2=Editorial" line, shown as buttons. */
export function parseDesignChoice(line: string): Array<{ id: number; label: string }> | null {
  const m = line.trim().match(/^DESIGN_CHOICE:\s*(.+)$/);
  if (!m) return null;
  const options = m[1]
    .split(';')
    .map((part) => part.trim().match(/^(\d+)\s*=\s*(.+)$/))
    .filter((x): x is RegExpMatchArray => x !== null)
    .map((x) => ({ id: Number(x[1]), label: x[2].trim() }));
  return options.length > 0 ? options : null;
}
function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const image = parseImageLine(line);
    if (image) {
      blocks.push({ type: 'image', ...image });
      i++;
      continue;
    }
    const designChoice = parseDesignChoice(line);
    if (designChoice) {
      blocks.push({ type: 'design-choice', options: designChoice });
      i++;
      continue;
    }

    // 1. Fenced Code Block
    if (line.trim().startsWith('```')) {
      const match = line.trim().match(/^```([a-zA-Z0-9_-]*)/);
      const lang = match ? match[1] : '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].trim().startsWith('```')) {
        i++;
      }
      blocks.push({ type: 'code', lang, code: codeLines.join('\n') });
      continue;
    }

    // 2. Horizontal Rule (---, ***, ___)
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(line.trim())) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // 3. Headings (#)
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      i++;
      continue;
    }

    // 4. Blockquotes (>)
    if (line.trim().startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', text: quoteLines.join('\n') });
      continue;
    }

    // 5. Tables (| a | b |)
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      if (tableLines.length >= 2) {
        const headers = tableLines[0]
          .slice(1, -1)
          .split('|')
          .map((s) => s.trim());
        const rows = tableLines
          .slice(2)
          .map((r) => r.slice(1, -1).split('|').map((s) => s.trim()));
        blocks.push({ type: 'table', headers, rows });
        continue;
      }
    }

    // 6. Unordered List (- or * or +)
    if (/^[-*+]\s+/.test(line.trim())) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // 7. Ordered List (1. 2.)
    if (/^\d+\.\s+/.test(line.trim())) {
      const items: Array<{ num: string; text: string }> = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        const itemMatch = lines[i].trim().match(/^(\d+)\.\s+(.*)$/);
        if (itemMatch) {
          items.push({ num: itemMatch[1], text: itemMatch[2] });
        }
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    // 8. Paragraph
    const paraLines = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !parseImageLine(lines[i]) &&
      !lines[i].trim().startsWith('```') &&
      !/^(\*{3,}|-{3,}|_{3,})$/.test(lines[i].trim()) &&
      !lines[i].match(/^#{1,6}\s+/) &&
      !lines[i].trim().startsWith('>') &&
      !(lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) &&
      !/^[-*+]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', text: paraLines.join(' ') });
  }

  return blocks;
}

const InlineRenderer: React.FC<{ text: string }> = ({ text }) => {
  const tokens = parseInline(text);

  return (
    <>
      {tokens.map((token, idx) => {
        if (token.type === 'bold') {
          // Check if it looks like a field label like "What it is:" or "Why it's neglected:"
          if (token.value.trim().endsWith(':')) {
            return (
              <span
                key={idx}
                className="inline-flex items-center font-bold text-cyan-300 font-mono tracking-wide px-1.5 py-0.5 rounded bg-cyan-950/60 border border-cyan-500/30 text-[11px] shadow-[0_0_8px_rgba(0,229,255,0.15)] mr-1.5 align-baseline"
              >
                {token.value}
              </span>
            );
          }
          return (
            <strong
              key={idx}
              className="font-bold text-cyan-200 drop-shadow-[0_0_4px_rgba(0,229,255,0.25)]"
            >
              {token.value}
            </strong>
          );
        }
        if (token.type === 'bold-italic') {
          return (
            <strong
              key={idx}
              className="font-bold italic text-cyan-200 drop-shadow-[0_0_4px_rgba(0,229,255,0.25)]"
            >
              {token.value}
            </strong>
          );
        }
        if (token.type === 'italic') {
          return (
            <em key={idx} className="italic text-slate-300">
              {token.value}
            </em>
          );
        }
        if (token.type === 'code') {
          return (
            <code
              key={idx}
              className="px-1.5 py-0.5 mx-0.5 rounded bg-cyan-950/70 border border-cyan-500/30 text-cyan-200 font-mono text-[11px] shadow-[0_0_6px_rgba(0,229,255,0.1)]"
            >
              {token.value}
            </code>
          );
        }
        if (token.type === 'link') {
          return (
            <a
              key={idx}
              href={token.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan-400 hover:text-cyan-200 underline underline-offset-2 transition-colors inline-flex items-center gap-0.5 cursor-pointer"
            >
              {token.label}
              <ExternalLink className="w-2.5 h-2.5 inline ml-0.5 opacity-70" />
            </a>
          );
        }
        return <span key={idx}>{token.value}</span>;
      })}
    </>
  );
};

export const HudMarkdown: React.FC<HudMarkdownProps> = ({ content: raw, isUser = false, onChoose }) => {
  const content = stripExpressionTags(raw);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);

  if (isUser) {
    return (
      <div className="text-xs leading-relaxed text-slate-100 whitespace-pre-wrap select-text font-sans">
        {content}
      </div>
    );
  }

  const blocks = parseBlocks(content);

  const handleCopyCode = (code: string, idx: number) => {
    navigator.clipboard.writeText(code);
    setCopiedIndex(idx);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  return (
    <div className="space-y-2.5 text-xs text-slate-200 select-text leading-relaxed font-sans">
      {blocks.map((block, idx) => {
        if (block.type === 'image') return <GeneratedImage key={idx} path={block.path} caption={block.alt} />;
        if (block.type === 'design-choice') {
          return (
            <div key={idx} className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-[10px] uppercase tracking-wider text-slate-400">Pick a look</span>
              {block.options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  disabled={!onChoose || chosen !== null}
                  onClick={() => {
                    setChosen(o.id);
                    onChoose?.(`I pick option ${o.id} (${o.label}).`);
                  }}
                  className={`px-3 py-1.5 rounded-md border text-xs font-semibold transition-colors ${
                    chosen === o.id
                      ? 'border-cyan-300 bg-cyan-500/25 text-cyan-50'
                      : 'border-slate-500/50 bg-slate-800/60 text-slate-100 hover:border-cyan-300/70 disabled:opacity-50 disabled:hover:border-slate-500/50'
                  }`}
                >
                  {o.id}. {o.label}
                </button>
              ))}
            </div>
          );
        }

        // 1. Heading
        if (block.type === 'heading') {
          if (block.level === 1) {
            return (
              <div
                key={idx}
                className="flex items-center gap-2.5 my-3.5 pb-1.5 border-b border-cyan-500/30"
              >
                <span className="w-2 h-5 rounded-sm bg-cyan-400 shadow-[0_0_10px_#00e5ff]" />
                <h1 className="text-sm font-bold text-cyan-100 tracking-wider font-hud uppercase drop-shadow-[0_0_8px_rgba(0,229,255,0.4)]">
                  <InlineRenderer text={block.text} />
                </h1>
              </div>
            );
          }
          if (block.level === 2) {
            return (
              <div
                key={idx}
                className="flex items-center gap-2.5 my-3 px-3 py-1.5 rounded-lg bg-gradient-to-r from-cyan-950/60 via-cyan-900/30 to-transparent border-l-4 border-cyan-400 shadow-[inset_0_1px_1px_rgba(0,229,255,0.15)]"
              >
                <h2 className="text-xs font-bold text-cyan-200 tracking-wider font-hud uppercase drop-shadow-[0_0_6px_rgba(0,229,255,0.3)]">
                  <InlineRenderer text={block.text} />
                </h2>
              </div>
            );
          }
          if (block.level === 3) {
            return (
              <div
                key={idx}
                className="flex items-center gap-2 mt-3 mb-1 text-cyan-300 font-hud text-xs font-semibold tracking-wide"
              >
                <span className="text-cyan-400 text-[10px] animate-pulse">◆</span>
                <h3 className="drop-shadow-[0_0_4px_rgba(0,229,255,0.2)]">
                  <InlineRenderer text={block.text} />
                </h3>
              </div>
            );
          }
          return (
            <h4 key={idx} className="text-xs font-bold text-slate-200 tracking-wide mt-2 mb-1">
              <InlineRenderer text={block.text} />
            </h4>
          );
        }

        // 2. Horizontal Rule (Divider)
        if (block.type === 'hr') {
          return (
            <div key={idx} className="my-3.5 relative flex items-center justify-center">
              <div className="w-full h-px bg-gradient-to-r from-transparent via-cyan-500/40 to-transparent" />
              <div className="absolute w-2 h-2 rotate-45 border border-cyan-400/80 bg-slate-950 shadow-[0_0_8px_rgba(0,229,255,0.8)]" />
            </div>
          );
        }

        // 3. Fenced Code Block / Generative UI Cards
        if (block.type === 'code') {
          const lang = (block.lang || '').toLowerCase().trim();

          // A. Git Diff Card
          if (lang === 'diff') {
            return <GitDiffCard key={idx} diff={block.code} />;
          }

          // B. Browser Session Card
          if (lang === 'browser' || lang === 'card:browser') {
            try {
              const data = JSON.parse(block.code);
              return <BrowserSessionCard key={idx} {...data} />;
            } catch {
              return <BrowserSessionCard key={idx} url={block.code.trim()} />;
            }
          }

          // C. Security Approval Gate Card
          if (lang === 'approval' || lang === 'card:approval') {
            try {
              const data = JSON.parse(block.code);
              return <ApprovalGateCard key={idx} {...data} />;
            } catch {
              return <ApprovalGateCard key={idx} command={block.code.trim()} />;
            }
          }

          // D. Durable Task Card
          if (lang === 'task' || lang === 'card:task') {
            try {
              const data = JSON.parse(block.code);
              return <DurableTaskCard key={idx} {...data} />;
            } catch {
              return (
                <DurableTaskCard
                  key={idx}
                  id={`task-${idx}`}
                  category="background"
                  status="running"
                  resultSnippet={block.code.slice(0, 100)}
                />
              );
            }
          }

          // E. Mermaid Diagram Block
          if (lang === 'mermaid') {
            return (
              <div
                key={idx}
                className="my-3 rounded-2xl border border-cyan-500/40 bg-gradient-to-br from-slate-950 via-slate-900 to-cyan-950/30 p-3.5 shadow-[0_8px_32px_rgba(0,0,0,0.6)]"
              >
                <div className="flex items-center justify-between pb-2 border-b border-cyan-500/20 mb-2">
                  <div className="flex items-center gap-1.5 text-cyan-300 font-mono text-xs font-bold">
                    <Workflow className="w-3.5 h-3.5 text-cyan-400" />
                    <span>SYSTEM ARCHITECTURE DIAGRAM</span>
                  </div>
                  <button
                    onClick={() => handleCopyCode(block.code, idx)}
                    className="text-slate-400 hover:text-cyan-300 text-[10px] font-mono flex items-center gap-1 cursor-pointer"
                  >
                    {copiedIndex === idx ? (
                      <Check className="w-3 h-3 text-emerald-400" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                    {copiedIndex === idx ? 'COPIED' : 'COPY'}
                  </button>
                </div>
                <pre className="p-3 bg-black/60 rounded-xl border border-cyan-500/15 font-mono text-[11px] text-cyan-200 overflow-x-auto leading-relaxed">
                  <code>{block.code}</code>
                </pre>
              </div>
            );
          }

          // F. Standard Enhanced Code Block
          const lineCount = block.code.split('\n').length;
          return (
            <div
              key={idx}
              className="my-3 rounded-2xl border border-cyan-500/35 bg-gradient-to-br from-slate-950/95 via-slate-900/90 to-cyan-950/20 overflow-hidden shadow-[0_6px_24px_rgba(0,0,0,0.55)]"
            >
              <div className="flex items-center justify-between px-3 py-1.5 bg-slate-950/80 border-b border-cyan-500/20 text-[10px] font-mono">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-red-400/80" />
                  <span className="w-2 h-2 rounded-full bg-yellow-400/80" />
                  <span className="w-2 h-2 rounded-full bg-cyan-400/80 shadow-[0_0_6px_#00e5ff]" />
                  <span className="text-cyan-300 font-bold uppercase tracking-wider ml-1">
                    {block.lang || 'TERMINAL'}
                  </span>
                  <span className="text-slate-500 ml-1">({lineCount} lines)</span>
                </div>
                <button
                  onClick={() => handleCopyCode(block.code, idx)}
                  className="text-slate-400 hover:text-cyan-300 transition-colors flex items-center gap-1 cursor-pointer"
                >
                  {copiedIndex === idx ? (
                    <Check className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  <span className="text-[10px]">{copiedIndex === idx ? 'COPIED' : 'COPY'}</span>
                </button>
              </div>
              <pre className="p-3 text-[11px] font-mono text-cyan-100 overflow-x-auto selection:bg-cyan-500/30 leading-relaxed bg-black/50">
                <code>{block.code}</code>
              </pre>
            </div>
          );
        }

        // 4. Blockquote
        if (block.type === 'blockquote') {
          return (
            <div
              key={idx}
              className="my-2.5 p-3 rounded-r-xl border-l-2 border-cyan-400 bg-cyan-950/25 text-cyan-100/90 text-xs italic shadow-[inset_0_1px_1px_rgba(0,229,255,0.1)]"
            >
              <InlineRenderer text={block.text} />
            </div>
          );
        }

        // 5. Table
        if (block.type === 'table') {
          return (
            <div
              key={idx}
              className="my-3 overflow-x-auto rounded-xl border border-cyan-500/30 bg-slate-950/60 shadow-[0_4px_20px_rgba(0,0,0,0.3)]"
            >
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-cyan-500/30 bg-cyan-950/40">
                    {block.headers.map((h, i) => (
                      <th
                        key={i}
                        className="px-3 py-2 text-cyan-200 font-hud tracking-wider text-[11px] uppercase font-semibold"
                      >
                        <InlineRenderer text={h} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rIdx) => (
                    <tr
                      key={rIdx}
                      className="border-b border-cyan-500/10 hover:bg-cyan-500/5 transition-colors"
                    >
                      {row.map((cell, cIdx) => (
                        <td key={cIdx} className="px-3 py-2 text-slate-200 text-xs">
                          <InlineRenderer text={cell} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        // 6. Unordered List
        if (block.type === 'ul') {
          return (
            <ul key={idx} className="my-2 space-y-1.5 pl-1">
              {block.items.map((item, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2.5 text-[12.5px] leading-relaxed text-slate-200"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-[0_0_6px_#00e5ff] mt-1.5 shrink-0" />
                  <div className="flex-1">
                    <InlineRenderer text={item} />
                  </div>
                </li>
              ))}
            </ul>
          );
        }

        // 7. Ordered List
        if (block.type === 'ol') {
          return (
            <ol key={idx} className="my-2 space-y-1.5 pl-1">
              {block.items.map((item, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2.5 text-[12.5px] leading-relaxed text-slate-200"
                >
                  <span className="px-1.5 py-0.5 text-[9px] font-mono font-bold rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 shrink-0 mt-0.5 shadow-[0_0_4px_rgba(0,229,255,0.2)]">
                    {item.num}
                  </span>
                  <div className="flex-1">
                    <InlineRenderer text={item.text} />
                  </div>
                </li>
              ))}
            </ol>
          );
        }

        // 8. Paragraph
        return (
          <div
            key={idx}
            className="my-1.5 text-[12.5px] leading-relaxed text-slate-200/95 tracking-wide"
          >
            <InlineRenderer text={block.text} />
          </div>
        );
      })}
    </div>
  );
};

