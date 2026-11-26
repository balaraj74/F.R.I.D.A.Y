// Which media files the HUD may read: only files FRIDAY generated, in her workspace's
// generated/ folder (or the state dir's). A chat message can name any path, so this is the guard.
const fs = require('fs');
const os = require('os');
const path = require('path');

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

const VIDEO_MIME = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};

const AUDIO_MIME = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
};

const DOC_MIME = {
  '.pdf': 'application/pdf',
};

const ALL_MIME = { ...IMAGE_MIME, ...VIDEO_MIME, ...AUDIO_MIME, ...DOC_MIME };
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 150 * 1024 * 1024;
const MAX_IPC_BYTES = 50 * 1024 * 1024;

function generatedRoots(home = os.homedir(), tmp = os.tmpdir()) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return [
    // Where image_generate saves now (scratch output lives in the OS temp dir).
    path.join(tmp, uid != null ? `friday-${uid}` : 'friday', 'generated'),
    path.join(home, 'friday', 'generated'),
    // Older pictures that were tidied away; chat history still points at them.
    path.join(home, 'friday', 'archive', 'generated'),
    path.join(home, '.friday', 'generated'),
  ];
}

function getMediaKind(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  if (IMAGE_MIME[ext]) return 'image';
  if (VIDEO_MIME[ext]) return 'video';
  if (AUDIO_MIME[ext]) return 'audio';
  if (DOC_MIME[ext]) return 'pdf';
  return null;
}

function getMediaMime(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  return ALL_MIME[ext] || null;
}

/** The real path of an allowed generated media file, or throws. */
function resolveGeneratedMedia(file, roots = generatedRoots()) {
  if (typeof file !== 'string' || !file) throw new Error('No file given.');
  const ext = path.extname(file).toLowerCase();
  const mime = ALL_MIME[ext];
  if (!mime) throw new Error('Unsupported media file type.');
  const real = fs.realpathSync(file); // follows symlinks, so a link can't escape the folder
  const inside = roots.some((r) => {
    let root;
    try { root = fs.realpathSync(r); } catch { return false; }
    return real === root || real.startsWith(root + path.sep);
  });
  if (!inside) throw new Error('That file is outside the generated media folder.');
  const size = fs.statSync(real).size;
  const limit = VIDEO_MIME[ext] ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (size > limit) throw new Error('That media file is too large to show.');
  return real;
}

/** Backwards-compatible image-only resolver. */
function resolveGeneratedImage(file, roots = generatedRoots()) {
  if (typeof file !== 'string' || !file) throw new Error('No file given.');
  const ext = path.extname(file).toLowerCase();
  if (!IMAGE_MIME[ext]) throw new Error('Not an image file.');
  return resolveGeneratedMedia(file, roots);
}

function readGeneratedMedia(file, roots) {
  const real = resolveGeneratedMedia(file, roots);
  const size = fs.statSync(real).size;
  if (size > MAX_IPC_BYTES) {
    throw new Error('Media file is too large for inline IPC; stream via /api/media.');
  }
  const mime = getMediaMime(real);
  return {
    dataUrl: `data:${mime};base64,${fs.readFileSync(real).toString('base64')}`,
    path: real,
    mimeType: mime,
    kind: getMediaKind(real),
  };
}

function readGeneratedImage(file, roots) {
  const real = resolveGeneratedImage(file, roots);
  return {
    dataUrl: `data:${IMAGE_MIME[path.extname(real).toLowerCase()]};base64,${fs.readFileSync(real).toString('base64')}`,
    path: real,
  };
}

module.exports = {
  resolveGeneratedImage,
  readGeneratedImage,
  resolveGeneratedMedia,
  readGeneratedMedia,
  getMediaKind,
  getMediaMime,
  generatedRoots,
};
