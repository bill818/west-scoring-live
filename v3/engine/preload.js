// WEST Engine preload — exposes a tight API surface to the renderer
// via contextBridge. Renderer never gets `require` or `process` —
// everything goes through window.westEngine.*

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('westEngine', {
  // State subscription — main pushes on every change, renderer re-renders.
  onState: (handler) => {
    ipcRenderer.on('state', (_evt, state) => handler(state));
  },
  // Renderer asks for an immediate state push (e.g. on window reuse).
  requestState: () => ipcRenderer.send('state-request'),
  // Main asks the renderer to open the show picker (used on first-run).
  onOpenPicker: (handler) => {
    ipcRenderer.on('open-picker', () => handler());
  },
  // Main fires when the window comes back from tray. Renderer resets to
  // the Status tab so operators always see the dashboard on re-open.
  onWindowShown: (handler) => {
    ipcRenderer.on('window-shown', () => handler());
  },
  // Main reports a frame number observed in incoming UDP that isn't in our
  // protocol map. Renderer adds a placeholder card flagged auto-discovered.
  // Wired up when the UDP listener lands; safe stub until then.
  onDiscoveredFrame: (handler) => {
    ipcRenderer.on('discovered-frame', (_evt, info) => handler(info));
  },
  // Main reports a tag observed inside a known frame that isn't in our
  // tag list for that frame. Renderer appends with auto-discovered badge.
  onDiscoveredTag: (handler) => {
    ipcRenderer.on('discovered-tag', (_evt, info) => handler(info));
  },

  // Renderer → main calls (return promises via invoke/handle).
  fetchShows:     ()              => ipcRenderer.invoke('fetch-shows'),
  fetchRings:     (slug)          => ipcRenderer.invoke('fetch-rings', slug),
  switchShow:     (slug, ring, name) => ipcRenderer.invoke('switch-show', { slug, ring, name }),
  clearShow:      ()              => ipcRenderer.invoke('clear-show'),
  saveCredentials: (workerUrl, authKey) => ipcRenderer.invoke('save-credentials', { workerUrl, authKey }),
  checkForUpdate: ()                    => ipcRenderer.invoke('check-for-update'),
  installUpdate:  ()                    => ipcRenderer.invoke('install-update'),
  repostCls:      ()              => ipcRenderer.invoke('repost-cls'),
  repostTsked:    ()              => ipcRenderer.invoke('repost-tsked'),
  toggleForwarding: ()            => ipcRenderer.invoke('toggle-forwarding'),
  toggleLiveScoring: ()           => ipcRenderer.invoke('toggle-live-scoring'),
  saveSettings:   (patch)         => ipcRenderer.invoke('save-settings', patch),
  saveFeature:    (key, value)    => ipcRenderer.invoke('save-feature', { key, value }),
  // Forget that we ever discovered this frame/tag, so a future packet
  // with it triggers auto-discovery again. Keys for forgetDiscovered:
  //   { ch, fr }       — forget a whole frame (and any tags inside it)
  //   { ch, fr, tag }  — forget a single tag
  forgetDiscovered: (key)         => ipcRenderer.invoke('forget-discovered', key),
  // S46 — manual class lifecycle action from right-click menu.
  // action ∈ { 'clear' | 'finalize' | 'focus' }
  setClassLiveState: (class_id, action) =>
    ipcRenderer.invoke('set-class-live-state', { class_id, action }),
  // S46 — flush is_live across all classes on this ring (one button).
  flushLiveAll: () => ipcRenderer.invoke('set-class-live-state', { class_id: null, action: 'flush_all' }),
  // 3.2.0 — folder/website reconciliation actions.
  reconcileRefresh:        ()          => ipcRenderer.invoke('reconcile-refresh'),
  reconcileRestore:        (class_ids) => ipcRenderer.invoke('reconcile-restore', { class_ids }),
  reconcileUploadOverride: (class_ids) => ipcRenderer.invoke('reconcile-upload-override', { class_ids }),
  openLog:        ()              => ipcRenderer.send('open-log'),
  openAdmin:      ()              => ipcRenderer.send('open-admin'),
  openTestUrl:    ()              => ipcRenderer.send('open-test-url'),
  minimizeToTray: ()              => ipcRenderer.send('minimize-to-tray'),
});
