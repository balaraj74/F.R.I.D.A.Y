// Bridge between the overlay/indicator pages and the host. Only named calls are exposed.
const {contextBridge, ipcRenderer} = require('electron');

const listen = (channel) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('fqb', {
  init: () => ipcRenderer.invoke('qb:init'),
  ready: () => ipcRenderer.send('qb:ready'),
  ask: (text) => ipcRenderer.send('qb:ask', String(text)),
  mic: (action) => ipcRenderer.send('qb:mic', action === 'start' ? 'start' : 'stop'),
  audio: (bytes) => ipcRenderer.send('qb:audio', bytes),
  silence: () => ipcRenderer.send('qb:silence'),
  close: () => ipcRenderer.send('qb:close'),
  resize: (height) => ipcRenderer.send('qb:resize', Number(height) || 0),
  playbackDone: (ok) => ipcRenderer.send('qb:playback-done', ok === true),
  onEvent: listen('qb:event'),
  onPlay: listen('qb:play'),
  onStopPlayback: listen('qb:stop-playback'),
  stopControl: () => ipcRenderer.send('ind:stop'),
});
