const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  pathFor: file => webUtils.getPathForFile(file),
  save: (dir, name, bytes) => ipcRenderer.invoke('save', dir, name, bytes),
  read: path => ipcRenderer.invoke('read', path),
  rename: (path, newName) => ipcRenderer.invoke('rename', path, newName),
  openEditor: (path, tool) => ipcRenderer.send('editor', path, tool),
  hide: () => ipcRenderer.send('hide'),
  close: () => ipcRenderer.send('close'),
  notify: (title, path) => ipcRenderer.send('notify', title, path),
  onShow: cb => ipcRenderer.on('wheel:show', () => cb()),
  onHide: cb => ipcRenderer.on('wheel:hide', () => cb()),
  onCycle: cb => ipcRenderer.on('wheel:cycle', () => cb()),
});
