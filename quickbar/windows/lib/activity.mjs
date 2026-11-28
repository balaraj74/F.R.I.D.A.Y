// What the light is doing, as a pure state machine. Mirrors QuickBar.setActivity/showQuestion/
// setSpeaking/onFinal/onError in extension/bar.js.
// mode: idle | thinking | speaking

export const initialActivity = () => ({mode: 'idle', prevMode: 'idle', changedAt: 0, recording: false});

function setMode(s, mode, now) {
  if (mode === s.mode) return s;
  return {...s, prevMode: s.mode, mode, changedAt: now};
}

/** @param {{type:string, on?:boolean, state?:string}} ev */
export function reduceActivity(state, ev, now = 0) {
  switch (ev.type) {
    case 'question':
      return setMode(state, 'thinking', now);
    case 'final':
      return state.mode === 'thinking' ? setMode(state, 'idle', now) : state;
    case 'error':
      return setMode(state, 'idle', now);
    case 'speaking':
      if (ev.on) return setMode(state, 'speaking', now);
      return state.mode === 'speaking' ? setMode(state, 'idle', now) : state;
    case 'mic':
      return {...state, recording: ev.state === 'recording'};
    case 'toggle-mic':
      return {...state, recording: !state.recording};
    default:
      return state;
  }
}
