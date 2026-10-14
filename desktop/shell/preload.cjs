// Exposes a narrow, fixed API to the page; no Node access and no arbitrary channels.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('orbit', {
  state: () => ipcRenderer.invoke('orbit:state'),
  onState: cb => { const f = (_e, s) => cb(s); ipcRenderer.on('orbit:state', f); return () => ipcRenderer.removeListener('orbit:state', f); },
  pair: () => ipcRenderer.invoke('orbit:pair'),
  cancelPair: () => ipcRenderer.invoke('orbit:cancel-pair'),
  revoke: id => ipcRenderer.invoke('orbit:revoke', id),
  retry: () => ipcRenderer.invoke('orbit:retry'),
  loginItem: enable => ipcRenderer.invoke('orbit:login-item', enable),
});
