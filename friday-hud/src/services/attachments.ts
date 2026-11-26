// Attachments for chat messages. Images go to the gateway as real attachments (base64,
// the gateway caps them at 5 MB); text/code files are inlined into the message.

export interface ImageAttachment {
  kind: 'image';
  fileName: string;
  mimeType: string;
  base64: string;
  previewUrl: string;
}

export interface TextAttachment {
  kind: 'text';
  fileName: string;
  content: string;
}

export type Attachment = ImageAttachment | TextAttachment;

export const MAX_IMAGE_BYTES = 5_000_000;
export const MAX_TEXT_BYTES = 100_000;

const TEXT_EXT = /\.(txt|md|py|ts|tsx|js|jsx|json|csv|yaml|yml|toml|ini|sh|c|cpp|h|hpp|java|kt|go|rs|sql|html|css|xml|log)$/i;

function readAs(file: Blob, mode: 'dataUrl' | 'text'): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    if (mode === 'dataUrl') r.readAsDataURL(file);
    else r.readAsText(file);
  });
}

/** Turn a picked file into an attachment, or explain why it can't be attached. */
export async function fileToAttachment(file: File): Promise<Attachment | { error: string }> {
  if (file.type.startsWith('image/')) {
    if (file.size > MAX_IMAGE_BYTES) return { error: `${file.name} is over 5 MB` };
    const dataUrl = await readAs(file, 'dataUrl');
    return { kind: 'image', fileName: file.name, mimeType: file.type, base64: dataUrl.split(',')[1] ?? '', previewUrl: dataUrl };
  }
  if (file.type.startsWith('text/') || TEXT_EXT.test(file.name)) {
    if (file.size > MAX_TEXT_BYTES) return { error: `${file.name} is over 100 KB` };
    return { kind: 'text', fileName: file.name, content: await readAs(file, 'text') };
  }
  return { error: `${file.name}: only images and text/code files can be attached` };
}

/** One webcam frame as a JPEG attachment. The camera is released immediately afterwards. */
export async function captureWebcam(): Promise<ImageAttachment> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // Give auto-exposure a moment so the frame isn't dark.
    await new Promise((r) => setTimeout(r, 400));
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    return {
      kind: 'image',
      fileName: `webcam-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`,
      mimeType: 'image/jpeg',
      base64: dataUrl.split(',')[1] ?? '',
      previewUrl: dataUrl,
    };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

/** Message text with any text files inlined as fenced blocks. */
export function composeMessage(text: string, attachments: Attachment[]): string {
  const files = attachments.filter((a): a is TextAttachment => a.kind === 'text');
  if (files.length === 0) return text;
  const blocks = files.map((f) => `\n\nFile: ${f.fileName}\n\`\`\`\n${f.content}\n\`\`\``).join('');
  return `${text}${blocks}`;
}

/** Gateway `chat.send` attachment payloads (images only). */
export function toGatewayAttachments(attachments: Attachment[]) {
  return attachments
    .filter((a): a is ImageAttachment => a.kind === 'image')
    .map((a) => ({ type: 'image', mimeType: a.mimeType, fileName: a.fileName, content: a.base64 }));
}
