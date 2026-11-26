import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getFileExtension } from "./mime.js";

const execFileAsync = promisify(execFile);

const VOICE_AUDIO_EXTENSIONS = new Set([".oga", ".ogg", ".opus"]);

export function isVoiceCompatibleAudio(opts: {
  contentType?: string | null;
  fileName?: string | null;
}): boolean {
  const mime = opts.contentType?.toLowerCase();
  if (mime && (mime.includes("ogg") || mime.includes("opus"))) {
    return true;
  }
  const fileName = opts.fileName?.trim();
  if (!fileName) return false;
  const ext = getFileExtension(fileName);
  if (!ext) return false;
  return VOICE_AUDIO_EXTENSIONS.has(ext);
}

export async function convertToOggOpus(inputBuffer: Buffer): Promise<Buffer | null> {
  const tmpDir = os.tmpdir();
  const inputPath = path.join(
    tmpDir,
    `input-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  const outputPath = path.join(
    tmpDir,
    `output-${Date.now()}-${Math.random().toString(36).slice(2)}.opus`,
  );
  try {
    await fs.writeFile(inputPath, inputBuffer);
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      inputPath,
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      "-f",
      "ogg",
      outputPath,
    ]);
    const outBuffer = await fs.readFile(outputPath);
    return outBuffer;
  } catch {
    return null;
  } finally {
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
  }
}
