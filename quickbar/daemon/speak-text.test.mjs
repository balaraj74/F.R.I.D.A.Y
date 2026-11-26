import {describe, expect, it} from 'vitest';
import {cleanForSpeech, leadParagraphIfComplete, pickSpoken, stripReplyTags} from './speak-text.mjs';

describe('pickSpoken', () => {
  it('speaks the first paragraph and leaves the detail on screen', () => {
    const answer = 'Your build failed because of a missing import in app.ts.\n\nDetails:\n- line 12\n- line 40';
    expect(pickSpoken(answer)).toBe('Your build failed because of a missing import in app.ts.');
  });

  it('keeps it to three sentences', () => {
    const answer = 'One is here. Two is here. Three is here. Four is here. Five is here.';
    expect(pickSpoken(answer)).toBe('One is here. Two is here. Three is here.');
  });

  it('caps very long sentences', () => {
    const out = pickSpoken(`${'word '.repeat(200)}end.`);
    expect(out.length).toBeLessThanOrEqual(330);
  });

  it('skips headings, lists, tables and code to find prose', () => {
    const answer = '# Title\n\n- a\n- b\n\n| x | y |\n\n```js\nconst a = 1;\n```\n\nThe real answer is forty two.';
    expect(pickSpoken(answer)).toBe('The real answer is forty two.');
  });

  it('removes links, markdown and reply tags', () => {
    const out = pickSpoken('[[reply_to_current]] See **the docs** at [this page](https://x.dev/a) for more.');
    expect(out).toBe('See the docs at this page for more.');
  });

  it('turns curly quotes and dashes into speakable text', () => {
    expect(cleanForSpeech('It\u2019s \u201Cdone\u201D \u2014 finally')).toBe('It\'s "done" , finally');
  });

  it('returns an empty string when nothing is speakable', () => {
    expect(pickSpoken('```js\nconst a = 1;\n```')).toBe('');
    expect(pickSpoken('NO_REPLY')).toBe('');
  });
});

describe('leadParagraphIfComplete', () => {
  it('waits until the first paragraph is finished', () => {
    expect(leadParagraphIfComplete('Your build failed because of a missing import')).toBe('');
    expect(leadParagraphIfComplete('Your build failed because of a missing import in app.ts.\n\nDeta')).toBe(
      'Your build failed because of a missing import in app.ts.',
    );
  });
});

describe('stripReplyTags', () => {
  it('drops reply tags, silent markers and media lines', () => {
    expect(stripReplyTags('[[reply_to_current]]Hi\nMEDIA:/tmp/a.png\nNO_REPLY')).toBe('Hi');
  });
});
