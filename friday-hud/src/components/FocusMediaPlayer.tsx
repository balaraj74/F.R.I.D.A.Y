import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, SkipBack, SkipForward, Music2 } from 'lucide-react';
import { focusPlayer } from '../services/audio-player';
import { startFrameLoop } from '../services/frame-loop';
import { MediaStatus } from '../types';

interface FocusMediaPlayerProps {
  compact?: boolean;
}

export const FocusMediaPlayer: React.FC<FocusMediaPlayerProps> = ({ compact = false }) => {
  const [media, setMedia] = useState<MediaStatus>({
    active: false,
    isPlaying: false,
    title: 'Lo-Fi for Deep Work',
    artist: 'Friday Focus Generator',
  });
  const waveContainerRef = useRef<HTMLDivElement>(null);
  const WAVE_BAR_COUNT = 8;

  // Waveform animation — direct DOM manipulation, zero React re-renders
  useEffect(() => {
    if (!media.isPlaying) return;
    // A decorative bounce: 8 updates a second with a CSS ease reads as motion at a fraction of the cost.
    const updateWave = () => {
      if (waveContainerRef.current) {
        const bars = waveContainerRef.current.children;
        for (let i = 0; i < bars.length; i++) {
          const bar = bars[i] as HTMLElement;
          bar.style.transition = 'height 120ms ease-out';
          bar.style.height = `${Math.max(25, (0.2 + Math.random() * 0.8) * 100)}%`;
        }
      }
    };
    return startFrameLoop(updateWave, () => 8);
  }, [media.isPlaying]);

  // Poll real-time system/browser media status via MPRIS
  const pollMedia = async () => {
    if (window.electronAPI?.getMediaStatus) {
      try {
        const res = await window.electronAPI.getMediaStatus();
        if (res && res.active) {
          setMedia(res);
          return;
        }
      } catch (e) {}
    }
  };

  useEffect(() => {
    pollMedia();
    const timer = setInterval(pollMedia, 1000);
    return () => clearInterval(timer);
  }, []);

  const handleToggle = async () => {
    if (window.electronAPI?.mediaPlayPause && media.active) {
      setMedia((prev) => ({ ...prev, isPlaying: !prev.isPlaying }));
      await window.electronAPI.mediaPlayPause();
      setTimeout(pollMedia, 200);
    } else {
      const playing = await focusPlayer.togglePlay();
      setMedia({
        active: false,
        isPlaying: playing,
        title: focusPlayer.getCurrentTrack().title,
        artist: focusPlayer.getCurrentTrack().subtitle,
      });
    }
  };

  const handleNext = async () => {
    if (window.electronAPI?.mediaNext && media.active) {
      await window.electronAPI.mediaNext();
      setTimeout(pollMedia, 250);
    } else {
      const next = focusPlayer.nextTrack();
      setMedia((prev) => ({
        ...prev,
        title: next.title,
        artist: next.subtitle,
      }));
    }
  };

  const handlePrev = async () => {
    if (window.electronAPI?.mediaPrevious && media.active) {
      await window.electronAPI.mediaPrevious();
      setTimeout(pollMedia, 250);
    } else {
      const prev = focusPlayer.prevTrack();
      setMedia((m) => ({
        ...m,
        title: prev.title,
        artist: prev.subtitle,
      }));
    }
  };
  const formatMicroseconds = (us: number) => {
    const s = Math.floor(us / 1000000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  const isBrowserTrack = media.active;
  const playerSource = (media.player || 'browser').toUpperCase();

  // COMPACT MODE LAYOUT (for Mini Desk Widget)
  if (compact) {
    return (
      <div className="w-full px-3 py-2 rounded-xl hud-glass-panel border border-cyan-500/25 flex items-center justify-between gap-2.5 select-none transition-all">
        {/* Disc / Cover Thumbnail */}
        <div className="relative w-8 h-8 rounded-lg overflow-hidden border border-cyan-400/40 bg-slate-900 flex-shrink-0 flex items-center justify-center shadow-[0_0_8px_rgba(0,229,255,0.2)]">
          {media.artUrl ? (
            <img
              src={media.artUrl}
              alt="Cover"
              className={`w-full h-full object-cover transition-transform ${
                media.isPlaying ? 'scale-105' : 'opacity-70'
              }`}
            />
          ) : (
            <div
              className={`w-5 h-5 rounded-full border border-cyan-300/70 flex items-center justify-center ${
                media.isPlaying ? 'animate-spin' : ''
              }`}
              style={{ animationDuration: '6s' }}
            >
              <Music2 className="w-2.5 h-2.5 text-cyan-300" />
            </div>
          )}
        </div>

        {/* Track Title & Artist */}
        <div className="flex-1 min-w-0 pr-1">
          <div className="flex items-center gap-1">
            <span
              className="text-[11px] font-bold font-hud text-slate-100 truncate block"
              title={media.title}
            >
              {media.title || 'No Media Playing'}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[9px] font-mono text-cyan-400/80 truncate">
            <span className="truncate">{media.artist || 'System Audio'}</span>
            {isBrowserTrack && (
              <span className="px-1 py-0.2 rounded bg-cyan-950/80 text-[7.5px] border border-cyan-400/30 text-cyan-300 flex-shrink-0">
                {playerSource}
              </span>
            )}
          </div>
        </div>

        {/* Mini Controls */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={handlePrev}
            title="Previous"
            className="p-1 rounded text-slate-400 hover:text-cyan-300 transition-colors cursor-pointer active:scale-95 focus:outline-none"
          >
            <SkipBack className="w-3 h-3" />
          </button>

          <button
            onClick={handleToggle}
            title={media.isPlaying ? 'Pause' : 'Play'}
            className="p-1.5 rounded-lg bg-cyan-500/20 border border-cyan-400/60 hover:bg-cyan-500/30 text-cyan-300 shadow-[0_0_8px_rgba(0,229,255,0.4)] transition-all cursor-pointer active:scale-95 focus:outline-none"
          >
            {media.isPlaying ? (
              <Pause className="w-3 h-3 fill-cyan-300" />
            ) : (
              <Play className="w-3 h-3 fill-cyan-300 translate-x-0.5" />
            )}
          </button>

          <button
            onClick={handleNext}
            title="Next"
            className="p-1 rounded text-slate-400 hover:text-cyan-300 transition-colors cursor-pointer active:scale-95 focus:outline-none"
          >
            <SkipForward className="w-3 h-3" />
          </button>
        </div>
      </div>
    );
  }

  // EXPANDED / STANDARD LAYOUT (for Medium & Full screens)
  return (
    <div className="sk-plate sk-media select-none !py-3">
      {/* Album Artwork / Disc */}
      <div className="relative w-12 h-12 sk-art flex-shrink-0 flex items-center justify-center overflow-hidden group">
        {media.artUrl ? (
          <img
            src={media.artUrl}
            alt="Album Cover"
            className={`w-full h-full object-cover transition-transform duration-500 ${
              media.isPlaying ? 'scale-105' : 'opacity-80'
            }`}
          />
        ) : (
          <>
            <div className="absolute inset-0 bg-gradient-to-tr from-cyan-950 via-slate-900 to-indigo-950 opacity-90" />
            <div
              className={`relative z-10 w-8 h-8 rounded-full border border-cyan-300/80 flex items-center justify-center ${
                media.isPlaying ? 'animate-spin' : ''
              }`}
              style={{ animationDuration: '6s' }}
            >
              <Music2 className="w-4 h-4 text-cyan-300" />
            </div>
          </>
        )}
        {isBrowserTrack && (
          <div className="absolute bottom-0.5 right-0.5 px-1 rounded bg-black/80 text-[8px] font-mono text-cyan-300 border border-cyan-500/30">
            {playerSource}
          </div>
        )}
      </div>

      {/* Track Info & Visualizer */}
      <div className="flex-1 min-w-0 pr-1">
        <div className="flex items-center justify-between gap-1">
          <span className="sk-strong truncate" title={media.title}>
            {media.title || 'No Media Playing'}
          </span>

          {/* Dynamic Audio Waveform Bars */}
          <div ref={waveContainerRef} className="flex items-center gap-0.5 h-3 flex-shrink-0">
            {Array.from({ length: WAVE_BAR_COUNT }).map((_, idx) => (
              <span
                key={idx}
                className="w-0.5 rounded-full sk-wave-bar"
                style={{
                  height: '25%',
                  opacity: media.isPlaying ? 1 : 0.4,
                  transition: 'opacity 0.2s',
                }}
              />
            ))}
          </div>
        </div>

        <div
          className="sk-muted truncate mt-0.5"
          title={media.artist}
        >
          {media.artist || 'System Audio'}
        </div>

        {/* Progress Bar if length is known */}
        {Boolean(media.length && media.length > 0) && (
          <div className="flex items-center gap-1.5 mt-1.5">
            <span className="text-[8px] font-mono text-slate-400">
              {formatMicroseconds(media.position || 0)}
            </span>
            <div className="flex-1 sk-bar-track">
              <div
                className="sk-bar-fill"
                style={{
                  width: `${Math.min(
                    100,
                    Math.max(0, ((media.position || 0) / (media.length || 1)) * 100)
                  )}%`,
                }}
              />
            </div>
            <span className="text-[8px] font-mono text-slate-400">
              {formatMicroseconds(media.length || 0)}
            </span>
          </div>
        )}
      </div>

      {/* Media Controls */}
      <div className="sk-media-controls">
        <button
          onClick={handlePrev}
          title="Previous Track"
          className="sk-btn"
        >
          <SkipBack className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={handleToggle}
          title={media.isPlaying ? 'Pause' : 'Play'}
          className={`sk-btn sk-btn-lg ${media.isPlaying ? 'sk-btn-active' : ''}`}
        >
          {media.isPlaying ? (
            <Pause className="w-4 h-4" />
          ) : (
            <Play className="w-4 h-4 translate-x-0.5" />
          )}
        </button>

        <button
          onClick={handleNext}
          title="Next Track"
          className="sk-btn"
        >
          <SkipForward className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
