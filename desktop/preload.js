const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('durov', {
  isDesktop: true,
  platform: process.platform,
});