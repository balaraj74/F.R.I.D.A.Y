import React, { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Camera, Paperclip, Send, X, FileText } from 'lucide-react';
import { voiceLoop, type VoiceLoopView } from '../services/voice-loop';
import { captureWebcam, fileToAttachment, type Attachment } from '../services/attachments';

interface CommandBarProps {
  onSendMessage: (text: string, attachments?: Attachment[]) => void;
  disabled?: boolean;
}

export const CommandBar: React.FC<CommandBarProps> = React.memo(({
  onSendMessage,
  disabled = false,
}) => {
  const [input, setInput] = useState('');
  // Voice turns can start from the mic button, the wake word or Ctrl+Alt+Space; all go
  // through the voice loop, which sends finished utterances itself.
  const [voice, setVoice] = useState<VoiceLoopView>({ listening: false, transcript: '', status: '', draft: '' });
  useEffect(() => voiceLoop.subscribe(setVoice), []);
  const inputRef = useRef<HTMLInputElement>(null);
  // An offline transcript lands in the box for confirmation (Enter sends, or edit it first).
  useEffect(() => {
    if (!voice.draft) return;
    setInput(voice.draft);
    voiceLoop.consumeDraft();
    inputRef.current?.focus();
  }, [voice.draft]);
  const isListening = voice.listening;
  const voiceStatus = voice.status;

  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((n) => (n === msg ? '' : n)), 4000);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if ((!input.trim() && attachments.length === 0) || disabled) return;
    onSendMessage(input.trim(), attachments);
    setInput('');
    setAttachments([]);
  };

  const handleFiles = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      const res = await fileToAttachment(file);
      if ('error' in res) flash(res.error);
      else setAttachments((prev) => [...prev, res]);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleWebcam = async () => {
    try {
      flash('Taking a webcam photo…');
      const shot = await captureWebcam();
      setAttachments((prev) => [...prev, shot]);
      flash('Photo attached');
    } catch (e: any) {
      flash(e?.name === 'NotAllowedError' ? 'Camera permission denied' : 'No camera available');
    }
  };

  const handleMicClick = () => voiceLoop.toggle();

  return (
    <div className="relative w-full max-w-2xl mx-auto z-30">
      {/* Pending attachments */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2 px-2">
          {attachments.map((a, i) => (
            <div key={i} className="sk-chip flex items-center gap-1.5 pl-1 pr-2 py-1">
              {a.kind === 'image' ? (
                <img src={a.previewUrl} alt="" className="w-7 h-7 rounded object-cover" />
              ) : (
                <FileText className="w-4 h-4 mx-1" />
              )}
              <span className="max-w-[160px] truncate">{a.fileName}</span>
              <button
                type="button"
                aria-label={`Remove ${a.fileName}`}
                onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                className="p-0.5 rounded hover:text-rose-300"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />
      <form
        onSubmit={handleSubmit}
        className="sk-plate sk-command flex items-center gap-2.5"
      >
        {/* Glowing Voice Mic Button */}
        <button
          type="button"
          onClick={handleMicClick}
          title={isListening ? 'Listening… pause or click to finish' : 'Talk to FRIDAY (or say "Friday", or press Ctrl+Alt+Space)'}
          aria-label={isListening ? 'Stop listening' : 'Talk to FRIDAY'}
          className={`sk-btn sk-btn-lg relative ${isListening ? 'sk-btn-rec' : ''}`}
        >
          {isListening && (
            <span className="absolute -inset-1 rounded-full border border-rose-400/70 animate-ping opacity-50 pointer-events-none" />
          )}
          {isListening ? (
            <MicOff className="w-4 h-4" />
          ) : (
            <Mic className="w-4 h-4" />
          )}
        </button>

        {/* Command Input Field */}
        <input
          type="text"
          ref={inputRef}
          value={isListening ? voice.transcript : input}
          readOnly={isListening}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            isListening
              ? voiceStatus || 'Listening... (Speak now, click mic or pause to finish)'
              : notice || voiceStatus || 'Ask FRIDAY anything...'
          }
          className="sk-input flex-1"
        />

        {/* Attachment & Vision Icons */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            title="Take a webcam photo and attach it"
            onClick={() => void handleWebcam()}
            className="sk-btn"
          >
            <Camera className="w-4 h-4" />
          </button>
          <button
            type="button"
            title="Attach an image (≤5 MB) or a text/code file (≤100 KB)"
            onClick={() => fileInputRef.current?.click()}
            className="sk-btn"
          >
            <Paperclip className="w-4 h-4" />
          </button>
        </div>

        {/* Send Action Button */}
        <button
          type="submit"
          disabled={(!input.trim() && attachments.length === 0) || disabled}
          title="Send"
          aria-label="Send"
          className="sk-send"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
});

