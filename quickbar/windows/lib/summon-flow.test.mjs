import {describe, expect, it, vi} from 'vitest';
import {createSummonFlow} from './summon-flow.mjs';

function rig(over = {}) {
  const order = [];
  const session = {summon: vi.fn((a) => order.push(['session', a.shot])), dismiss: vi.fn()};
  const flow = createSummonFlow({
    getPointer: () => ({x: 10, y: 20}),
    prepareOverlay: async (p) => {
      order.push(['prepare', p]);
      return {win: 'w'};
    },
    capture: async () => {
      order.push(['capture']);
      return {image: {base64: 'x'}, partial: false};
    },
    showOverlay: (prepared, p) => order.push(['show', prepared, p]),
    session,
    ...over,
  });
  return {flow, order, session};
}

describe('summon flow', () => {
  it('captures the screen before the overlay is shown, then starts the session with the picture', async () => {
    const {flow, order} = rig();
    expect(await flow.summon('shake')).toBe(true);
    const names = order.map((o) => o[0]);
    expect(names.indexOf('capture')).toBeLessThan(names.indexOf('show'));
    expect(names.indexOf('show')).toBeLessThan(names.indexOf('session'));
    expect(order.find((o) => o[0] === 'session')[1]).toEqual({base64: 'x'});
    expect(flow.state).toBe('open');
  });
  it('reads the pointer first and passes the same position on', async () => {
    const {flow, order} = rig();
    await flow.summon('shortcut');
    expect(order[0]).toEqual(['prepare', {x: 10, y: 20}]);
    expect(order.find((o) => o[0] === 'show')[2]).toEqual({x: 10, y: 20});
  });
  it('ignores a second summon while capturing or open', async () => {
    const {flow, order} = rig();
    const a = flow.summon('shake');
    expect(await flow.summon('shortcut')).toBe(false);
    await a;
    expect(await flow.summon('shake')).toBe(false);
    expect(order.filter((o) => o[0] === 'show')).toHaveLength(1);
  });
  it('can be summoned again after close, and close dismisses the session', async () => {
    const {flow, session} = rig();
    await flow.summon('shake');
    flow.closed();
    expect(session.dismiss).toHaveBeenCalledTimes(1);
    expect(flow.state).toBe('idle');
    expect(await flow.summon('shake')).toBe(true);
  });
  it('still opens, and tells the user, when the capture fails or is partial', async () => {
    const notify = vi.fn();
    const {flow, session} = rig({capture: async () => ({image: null, partial: true}), notify});
    expect(await flow.summon('shake')).toBe(true);
    expect(notify).toHaveBeenCalledWith('Part of the screen could not be read.');
    expect(session.summon).toHaveBeenCalledWith({shot: null});
    const rejected = rig({capture: async () => { throw new Error('boom'); }, notify});
    expect(await rejected.flow.summon('shake')).toBe(true);
  });
  it('returns to idle and discards the window when opening fails', async () => {
    const discardOverlay = vi.fn();
    const {flow} = rig({prepareOverlay: async () => { throw new Error('no window'); }, discardOverlay});
    expect(await flow.summon('shake')).toBe(false);
    expect(flow.state).toBe('idle');
    expect(discardOverlay).toHaveBeenCalled();
  });
});
