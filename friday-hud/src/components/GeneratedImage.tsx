import React, { useEffect, useState } from 'react';
import { Download, FileText, Film, FolderOpen, ImageOff, Loader2, Music, X } from 'lucide-react';

// Media FRIDAY generated, shown in chat (images, video, audio, PDFs).
// In Electron, files are read via IPC (scoped to generated/). In browser webchat,
// files are streamed via /api/media?path=... with the exact same generated/ guard.

type MediaKind = 'image' | 'video' | 'audio' | 'pdf';

function inferMediaKind(filePath: string): MediaKind {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (['mp4', 'webm', 'mov', 'mkv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  return 'image';
}

export const GeneratedImage: React.FC<{ path: string; caption?: string }> = ({ path, caption }) => {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [big, setBig] = useState(false);
  const api = window.electronAPI;
  const kind = inferMediaKind(path);

  useEffect(() => {
    let live = true;
    setSrc(null);
    setError('');

    if (api?.readMedia) {
      api.readMedia(path).then((r) => {
        if (!live) return;
        if (r.ok && r.dataUrl) setSrc(r.dataUrl);
        else setError(r.error || 'Could not open this media file.');
      });
    } else {
      // Browser webchat fallback: stream from Vite /api/media endpoint (supports Range for video/audio)
      const mediaUrl = `/api/media?path=${encodeURIComponent(path)}`;
      if (kind === 'video' || kind === 'audio' || kind === 'pdf') {
        setSrc(mediaUrl);
      } else {
        fetch(mediaUrl, { method: 'HEAD' })
          .then((res) => {
            if (!live) return;
            if (res.ok) setSrc(mediaUrl);
            else setError('Could not open this picture (outside generated/ or missing).');
          })
          .catch(() => {
            if (live) setError('Could not reach media server.');
          });
      }
    }

    return () => {
      live = false;
    };
  }, [path, api, kind]);

  const name = path.split('/').pop() ?? 'media';
  const btn =
    'flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-cyan-400/30 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-200 text-[11px] font-mono cursor-pointer';

  return (
    <figure className="my-1 inline-flex flex-col gap-2 max-w-full p-2 rounded-xl border border-cyan-500/25 bg-slate-900/60">
      {error ? (
        <div className="flex items-center gap-2 px-3 py-6 text-[12px] text-slate-400">
          <ImageOff className="w-4 h-4" /> {error}
        </div>
      ) : src ? (
        kind === 'video' ? (
          <video
            src={src}
            controls
            playsInline
            preload="metadata"
            onError={() => setError('Could not play this video.')}
            className="max-h-96 max-w-full rounded-lg bg-black"
          />
        ) : kind === 'audio' ? (
          <div className="flex items-center gap-2.5 px-2 py-1.5 min-w-[260px]">
            <Music className="w-4 h-4 text-cyan-300 shrink-0" />
            <audio
              src={src}
              controls
              preload="metadata"
              onError={() => setError('Could not play this audio.')}
              className="w-full h-8"
            />
          </div>
        ) : kind === 'pdf' ? (
          <div className="flex flex-col gap-1.5 w-full min-w-[320px]">
            <div className="flex items-center gap-1.5 text-[11px] font-mono text-cyan-300">
              <FileText className="w-3.5 h-3.5" /> PDF Preview
            </div>
            <iframe
              src={src}
              title={caption || name}
              className="w-full h-80 rounded-lg border border-cyan-500/20 bg-white"
            />
          </div>
        ) : (
          <button type="button" onClick={() => setBig(true)} title="Click to enlarge" className="cursor-zoom-in">
            <img src={src} alt={caption || name} className="max-h-96 max-w-full rounded-lg object-contain" />
          </button>
        )
      ) : (
        <div className="flex items-center gap-2 px-6 py-10 text-[12px] text-slate-400 font-mono">
          <Loader2 className="w-4 h-4 animate-spin" />
          {kind === 'video' ? 'Loading video…' : kind === 'audio' ? 'Loading audio…' : 'Opening media…'}
        </div>
      )}
      <figcaption className="flex items-center gap-2 flex-wrap">
        <span className="flex items-center gap-1 text-[11px] font-mono text-slate-500 truncate max-w-[16rem]">
          {kind === 'video' && <Film className="w-3 h-3 text-cyan-400/70 shrink-0" />}
          {name}
        </span>
        {!error && (
          <>
            {api?.saveMediaAs ? (
              <button type="button" className={`${btn} ml-auto`} onClick={() => void api.saveMediaAs?.(path)}>
                <Download className="w-3 h-3" /> Save as
              </button>
            ) : src ? (
              <a href={src} download={name} className={`${btn} ml-auto no-underline`}>
                <Download className="w-3 h-3" /> Download
              </a>
            ) : null}
            {api?.revealMedia && (
              <button type="button" className={btn} onClick={() => void api.revealMedia?.(path)}>
                <FolderOpen className="w-3 h-3" /> Show in folder
              </button>
            )}
          </>
        )}
      </figcaption>
      {big && src && kind === 'image' && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6" onClick={() => setBig(false)}>
          <button type="button" className="absolute top-4 right-4 p-2 rounded-full bg-slate-900/80 text-slate-200 cursor-pointer" title="Close">
            <X className="w-5 h-5" />
          </button>
          <img src={src} alt={caption || name} className="max-h-full max-w-full object-contain rounded-lg" />
        </div>
      )}
    </figure>
  );
};

export const GeneratedMedia = GeneratedImage;
