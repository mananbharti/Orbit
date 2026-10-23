// Exposes a narrow, fixed API to the page; no Node access and no arbitrary channels.
const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('orbit', {
  state: () => ipcRenderer.invoke('orbit:state'),
  onState: cb => { const f = (_e, s) => cb(s); ipcRenderer.on('orbit:state', f); return () => ipcRenderer.removeListener('orbit:state', f); },
  pair: () => ipcRenderer.invoke('orbit:pair'),
  cancelPair: () => ipcRenderer.invoke('orbit:cancel-pair'),
  revoke: id => ipcRenderer.invoke('orbit:revoke', id),
  retry: () => ipcRenderer.invoke('orbit:retry'),
  agentSave: (key, baseUrl) => ipcRenderer.invoke('orbit:agent-save', key, baseUrl),
  agentClear: () => ipcRenderer.invoke('orbit:agent-clear'),
  loginItem: enable => ipcRenderer.invoke('orbit:login-item', enable),
  clipboardRead: () => ipcRenderer.invoke('orbit:clipboard-read'),
  clipboardWrite: text => ipcRenderer.invoke('orbit:clipboard-write', text),
  openFile: path => ipcRenderer.invoke('orbit:file-open', path),
  revealFile: path => ipcRenderer.invoke('orbit:file-reveal', path),
  copyPath: path => ipcRenderer.invoke('orbit:file-copy-path', path),
  sendFiles: () => ipcRenderer.invoke('orbit:send-files'),
  openInbox: () => ipcRenderer.invoke('orbit:open-inbox'),
  sendPaths: paths => ipcRenderer.invoke('orbit:send-files', paths),
  pathForFile: file => webUtils.getPathForFile(file),
});
