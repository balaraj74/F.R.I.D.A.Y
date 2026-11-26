// Plain text out of Sir's files for the local file index: text and code as-is, PDFs page by
// page (pdftotext), Office/OpenDocument files from their XML, notebooks from their cells.
// Each file becomes a list of sections ("p. 3", "slide 2") so search results can say where.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Optional better readers (helpers/docs/setup.sh): MarkItDown for Office files, Docling OCR for
// scanned PDFs. Without them the built-in readers below are used.
const DOCS = path.join(process.env.HOME ?? "", ".friday", "tools", "docs");
const DOCS_PY = path.join(DOCS, "venv", "bin", "python");
const DOCS_SCRIPT = path.join(DOCS, "convert.py");
const MAX_OCR_PAGES = 30;

async function viaHelper(
  mode: "office" | "ocr",
  file: string,
  timeout: number,
): Promise<Section[] | null> {
  try {
    await fs.access(DOCS_PY);
    await fs.access(DOCS_SCRIPT);
  } catch {
    return null;
  }
  try {
    const { stdout } = await run(DOCS_PY, ["-I", DOCS_SCRIPT, mode, file], {
      timeout,
      maxBuffer: 64 * 1024 * 1024,
    });
    const sections = JSON.parse(stdout) as Section[];
    return Array.isArray(sections) ? sections : null;
  } catch {
    return null;
  }
}

export type Section = { loc: string; text: string };

const TEXT_EXT = new Set(
  (
    "md markdown txt rst org tex csv tsv log json yaml yml toml ini cfg conf env.example " +
    "ts tsx js jsx mjs cjs py ipynb java kt kts swift c h cc cpp hpp cs go rs rb php scala lua dart " +
    "sh bash zsh sql html htm css scss vue svelte xml gradle dockerfile makefile"
  ).split(" "),
);
const OFFICE_EXT = new Set(["docx", "pptx", "xlsx", "odt", "odp", "ods"]);

export const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_CHARS = 1_500_000;

export function fileKind(file: string): "text" | "pdf" | "office" | "notebook" | null {
  const base = path.basename(file).toLowerCase();
  const ext = base.includes(".") ? base.split(".").pop()! : base;
  if (ext === "pdf") return "pdf";
  if (ext === "ipynb") return "notebook";
  if (OFFICE_EXT.has(ext)) return "office";
  if (TEXT_EXT.has(ext) || base === "readme" || base === "dockerfile" || base === "makefile")
    return "text";
  return null;
}

const xmlText = (xml: string) =>
  xml
    .replace(/<\/(w:p|a:p|text:p|text:h|row)>/g, "\n")
    .replace(/<(w:tab|text:tab)\/?>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

async function unzipList(file: string): Promise<string[]> {
  const { stdout } = await run("unzip", ["-Z1", file], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.split("\n").filter(Boolean);
}

async function unzipEntry(file: string, entry: string): Promise<string> {
  const { stdout } = await run("unzip", ["-p", file, entry], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function extractOffice(file: string): Promise<Section[]> {
  const entries = await unzipList(file);
  const num = (e: string) => Number(e.match(/(\d+)\.xml$/)?.[1] ?? 0);
  const slides = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e))
    .sort((a, b) => num(a) - num(b));
  if (slides.length) {
    const out: Section[] = [];
    for (const s of slides)
      out.push({ loc: `slide ${num(s)}`, text: xmlText(await unzipEntry(file, s)) });
    return out;
  }
  const main = ["word/document.xml", "content.xml", "xl/sharedStrings.xml"].find((e) =>
    entries.includes(e),
  );
  return main ? [{ loc: "", text: xmlText(await unzipEntry(file, main)) }] : [];
}

async function extractPdf(file: string): Promise<Section[]> {
  // pdftotext fails outright on some image-only PDFs: treat that as "no text" and try OCR.
  const stdout = await run("pdftotext", ["-enc", "UTF-8", "-q", file, "-"], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  }).then(
    (r) => r.stdout,
    () => "",
  );
  // pdftotext separates pages with form feeds.
  const pages = stdout.split("\f").map((text, i) => ({ loc: `p. ${i + 1}`, text }));
  const readable = stdout.replace(/\s+/g, "").length;
  // Almost no text means a scanned PDF: read the page images instead (slow, so capped).
  if (readable < 40 * Math.max(1, pages.length) && pages.length <= MAX_OCR_PAGES) {
    const ocr = await viaHelper("ocr", file, 10 * 60_000);
    if (ocr?.length) return ocr;
  }
  return pages;
}

function extractNotebook(raw: string): Section[] {
  const nb = JSON.parse(raw) as {
    cells?: Array<{ cell_type?: string; source?: string | string[] }>;
  };
  return (nb.cells ?? []).map((c, i) => ({
    loc: `cell ${i + 1}`,
    text: Array.isArray(c.source) ? c.source.join("") : String(c.source ?? ""),
  }));
}

/** Sections of text, or [] when the file has nothing readable (binary, empty, unsupported). */
export async function extractText(file: string): Promise<Section[]> {
  const kind = fileKind(file);
  if (!kind) return [];
  let sections: Section[];
  if (kind === "pdf") sections = await extractPdf(file);
  else if (kind === "office")
    sections = (await viaHelper("office", file, 120_000)) ?? (await extractOffice(file));
  else {
    const buf = await fs.readFile(file);
    if (buf.subarray(0, 8000).includes(0)) return []; // binary pretending to be text
    const raw = buf.toString("utf-8");
    sections = kind === "notebook" ? extractNotebook(raw) : [{ loc: "", text: raw }];
  }
  let budget = MAX_CHARS;
  const out: Section[] = [];
  for (const s of sections) {
    const text = s.text
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!text || budget <= 0) continue;
    out.push({ loc: s.loc, text: text.slice(0, budget) });
    budget -= text.length;
  }
  return out;
}

/** Split a section into ~1500-character chunks on paragraph (then line) boundaries. */
export function chunkSection(text: string, size = 1500): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const para of text.split(/\n{2,}/)) {
    const pieces =
      para.length > size ? (para.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? []) : [para];
    for (const piece of pieces) {
      if (current && current.length + piece.length + 2 > size) {
        chunks.push(current);
        current = "";
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}
