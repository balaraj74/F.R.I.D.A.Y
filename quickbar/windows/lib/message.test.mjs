import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {QUICK_NOTE, SESSION_KEY, buildAskRequest} from './message.mjs';

const daemon = fs.readFileSync(fileURLToPath(new URL('../../daemon/daemon.mjs', import.meta.url)), 'utf8');

describe('gateway message', () => {
  it('uses the session agent:main:quickbar', () => {
    expect(SESSION_KEY).toBe('agent:main:quickbar');
    expect(daemon).toContain(`const SESSION_KEY = '${SESSION_KEY}'`);
  });
  it('has the same quick note as the Linux daemon', () => {
    // The daemon builds the note from two string literals; compare the pieces.
    const first = QUICK_NOTE.slice(0, QUICK_NOTE.indexOf('with no markdown'));
    expect(daemon).toContain(first.trimEnd());
    expect(daemon).toContain("'with no markdown, then a blank line, then any detail he may want to read.]'");
    expect(daemon).toContain('A screenshot of his screen is attached.');
  });
  it('appends the note, and the screenshot sentence only with an image', () => {
    const plain = buildAskRequest({text: 'what is this?'});
    expect(plain.message).toBe(`what is this?\n\n${QUICK_NOTE}`);
    expect(plain.image).toBeNull();
    const image = {base64: 'AAA', mimeType: 'image/jpeg'};
    const withImg = buildAskRequest({text: 'q', image});
    expect(withImg.message).toBe(`q\n\n${QUICK_NOTE} A screenshot of his screen is attached.`);
    expect(withImg.image).toBe(image);
    expect(withImg.sessionKey).toBe(SESSION_KEY);
  });
});
