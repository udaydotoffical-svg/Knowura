// The only things the page can ask the desktop app to do. No Node access reaches the website.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('KnowuraDesk', {
    hide: () => ipcRenderer.send('kw:hide'),
    openApp: (path) => ipcRenderer.send('kw:openApp', typeof path === 'string' ? path : '/'),
    platform: 'windows'
});
