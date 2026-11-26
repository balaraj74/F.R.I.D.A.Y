import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DesignReviewGallery } from './DesignReviewGallery';
import { groupForGallery } from './group';
import type { Manifest, ManifestEntry } from './types';

const created = (screen: ManifestEntry['screen'], direction: ManifestEntry['direction'], index: 0 | 1): ManifestEntry => ({
  screen,
  direction,
  index,
  status: 'created',
  source: 'image_generate',
  path: `/refs/${screen}-${direction}-${index}.png`,
});

describe('groupForGallery', () => {
  it('groups by screen then direction, orders by index and drops pending entries', () => {
    const manifest: Manifest = {
      version: 1,
      entries: [
        created('chat', 'glass', 1),
        created('chat', 'glass', 0),
        { screen: 'home', direction: 'instrument', index: 0, status: 'pending' },
        { screen: 'jobs_board', direction: 'editorial', index: 0, status: 'failed', failureReason: 'x' },
      ],
    };
    const g = groupForGallery(manifest);
    expect(g.chat.glass.map((e) => e.index)).toEqual([0, 1]);
    expect(g.home.instrument).toEqual([]);
    expect(g.jobs_board.editorial).toHaveLength(1);
    expect(Object.keys(g)).toEqual(['home', 'chat', 'jobs_board']);
  });
});

describe('DesignReviewGallery', () => {
  const manifest: Manifest = {
    version: 1,
    entries: [
      created('home', 'instrument', 0),
      created('home', 'instrument', 1),
      {
        screen: 'jobs_board',
        direction: 'glass',
        index: 0,
        status: 'failed',
        source: 'html_fallback',
        failureReason: 'Playwright capture failed',
      },
    ],
  };

  it('shows created images under their screen and direction with a verdict control', () => {
    const html = renderToStaticMarkup(
      <DesignReviewGallery manifest={manifest} persistSelection={async () => {}} />,
    );
    expect(html).toContain('data-testid="group-home-instrument"');
    expect(html).toContain('src="/refs/home-instrument-0.png"');
    expect(html).toContain('src="/refs/home-instrument-1.png"');
    // One radio group with keep / reject / mix per created image.
    expect(html.match(/type="radio"/g)).toHaveLength(6);
    for (const v of ['keep', 'reject', 'mix']) expect(html).toContain(`value="${v}"`);
    expect(html).toContain('<textarea');
  });

  it('shows an error placeholder naming the screen and direction for a failed entry', () => {
    const html = renderToStaticMarkup(
      <DesignReviewGallery manifest={manifest} persistSelection={async () => {}} />,
    );
    const card = html.slice(html.indexOf('data-testid="ref-jobs_board-glass-0"'));
    expect(card).toContain('Screen: jobs_board');
    expect(card).toContain('Style direction: glass');
    expect(card).toContain('Playwright capture failed');
    // A failed entry gets no verdict control.
    expect(card.slice(0, card.indexOf('</li>'))).not.toContain('type="radio"');
  });

  it('restores a saved verdict and note from the initial selection', () => {
    const html = renderToStaticMarkup(
      <DesignReviewGallery
        manifest={manifest}
        initialSelection={{
          version: 1,
          entries: [{ screen: 'home', direction: 'instrument', index: 0, verdict: 'mix', note: 'keep the dial' }],
        }}
        persistSelection={async () => {}}
      />,
    );
    expect(html).toMatch(/value="mix"[^>]*checked|checked[^>]*value="mix"/);
    expect(html).toContain('keep the dial');
    expect(html).toContain('13/500');
  });
});
