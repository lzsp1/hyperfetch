'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

function on(channel, cb) {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', {
  /* settings */
  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  resetSettings: () => invoke('settings:reset'),

  /* dialogs & shell */
  chooseFolder: () => invoke('dialog:folder'),
  openPath: (p) => invoke('shell:open-path', p),
  revealPath: (p) => invoke('shell:show-item', p),
  openUrl: (u) => invoke('shell:open-external', u),

  /* window */
  window: {
    minimize: () => invoke('win:minimize'),
    toggleMaximize: () => invoke('win:toggle-maximize'),
    close: () => invoke('win:close'),
    isMaximized: () => invoke('win:is-maximized'),
  },

  /* downloads */
  listDownloads: () => invoke('dl:list'),
  addDownload: (input) => invoke('dl:add', input),
  pause: (id) => invoke('dl:pause', id),
  resume: (id) => invoke('dl:resume', id),
  remove: (id) => invoke('dl:remove', id),
  pauseAll: () => invoke('dl:pause-all'),
  resumeAll: () => invoke('dl:resume-all'),
  clearCompleted: () => invoke('dl:clear-completed'),
  setConnections: (id, n) => invoke('dl:set-connections', id, n),
  setMaxSpeed: (id, n) => invoke('dl:set-max-speed', id, n),
  probe: (url) => invoke('dl:probe', url),
  pasteFromClipboard: () => invoke('clipboard:read'),
  getLogs: () => invoke('log:list'),
  getEnv: () => invoke('app:env'),
  getLocale: () => invoke('i18n:locale'),
  playSound: (kind) => invoke('sound:preview', kind),
  previewNotification: () => invoke('notify:preview'),
  saveFileTo: (sourcePath, suggestedName) => invoke('dl:save-file-to', sourcePath, suggestedName),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  /* updates */
  update: {
    status: () => invoke('update:status'),
    check: () => invoke('update:check'),
    download: () => invoke('update:download'),
    cancel: () => invoke('update:cancel'),
    install: () => invoke('update:install'),
    openReleases: () => invoke('update:open-releases'),
    openInstallerFolder: () => invoke('update:open-installer-folder'),
    onState: (cb) => on('update:state', cb),
    onProgress: (cb) => on('update:progress', cb),
    onReady: (cb) => on('update:ready', cb),
  },

  /* events */
  onDownloadUpdate: (cb) => on('dl:update', cb),
  onDownloadDone: (cb) => on('dl:done', cb),
  onDownloadFailed: (cb) => on('dl:failed', cb),
  onDownloadRemoved: (cb) => on('dl:removed', cb),
  onLog: (cb) => on('log:line', cb),
  onSettingsChanged: (cb) => on('settings:changed', cb),
  onWindowState: (cb) => on('win:state', cb),
});
