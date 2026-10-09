/* Android WebView bridge for the ProudVocab local player. */
(function installAndroidBridge() {
  'use strict';

  const root = window.top || window;
  if (root.pvBridge) {
    window.pvBridge = root.pvBridge;
    return;
  }

  if (!window.AndroidBridge) {
    console.error('[ProudVocab Android] Native bridge is not available.');
    return;
  }

  const pending = new Map();
  const events = new Map();
  const queuedEvents = new Map();
  let requestSequence = 0;

  root.__pvAndroidResolve = function resolveAndroidRequest(id, resultJson) {
    const entry = pending.get(String(id));
    if (!entry) return;
    pending.delete(String(id));
    try {
      const result = JSON.parse(resultJson);
      if (result && result.__pvBridgeError) entry.reject(new Error(result.__pvBridgeError));
      else entry.resolve(result);
    } catch (error) {
      entry.reject(error);
    }
  };

  root.__pvAndroidEvent = function dispatchAndroidEvent(name, payloadJson) {
    let payload = {};
    try { payload = JSON.parse(payloadJson || '{}'); } catch (_) { /* ignore malformed event */ }
    const key = String(name);
    const listeners = (events.get(key) || []).slice();
    if (!listeners.length) {
      const queue = queuedEvents.get(key) || [];
      queue.push(payload);
      queuedEvents.set(key, queue.slice(-20));
      return;
    }
    for (const listener of listeners) {
      try { listener(payload); } catch (error) { console.error('[ProudVocab Android] Event listener failed', error); }
    }
  };

  function invoke(channel, ...args) {
    return new Promise((resolve, reject) => {
      const id = `pv-${Date.now().toString(36)}-${(++requestSequence).toString(36)}`;
      pending.set(id, { resolve, reject });
      try {
        window.AndroidBridge.dispatch(id, String(channel), JSON.stringify(args));
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  const videoExtensions = new Set([
    'mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'avi', 'wmv', 'flv',
    'mpg', 'mpeg', 'ts', 'm2ts', '3gp', 'vob',
  ]);
  const subtitleExtensions = new Set(['srt', 'vtt', 'ass', 'ssa', 'sub']);
  const audioExtensions = new Set(['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac']);
  function extensionOf(value) {
    const path = String(value || '').split(/[?#]/, 1)[0];
    const last = path.slice(path.lastIndexOf('/') + 1);
    const dot = last.lastIndexOf('.');
    return dot < 0 ? '' : last.slice(dot + 1).toLowerCase();
  }
  function base64UrlUtf8(value) {
    const bytes = new TextEncoder().encode(String(value));
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  const bridge = {
    invoke,
    send(channel, ...args) {
      if (channel === 'pv:net-abort') {
        try { window.AndroidBridge.abort(String(args[0] || '')); return true; } catch (_) { return false; }
      }
      return false;
    },
    on(channel, callback) {
      if (typeof callback !== 'function') return () => {};
      const key = String(channel);
      const list = events.get(key) || [];
      list.push(callback);
      events.set(key, list);
      const queued = queuedEvents.get(key) || [];
      queuedEvents.delete(key);
      queued.forEach((payload) => {
        try { callback(payload); } catch (error) { console.error('[ProudVocab Android] Event listener failed', error); }
      });
      return () => {
        const current = events.get(key) || [];
        const index = current.indexOf(callback);
        if (index >= 0) current.splice(index, 1);
      };
    },
    getPathForFile() { return null; },
    mediaUrlFor(path) {
      return `https://appassets.androidplatform.net/media?path=${encodeURIComponent(String(path || ''))}`;
    },
    localIdFor(path) { return `pv-local://${base64UrlUtf8(path)}`; },
    isVideoFile(path) { return videoExtensions.has(extensionOf(path)); },
    isSubtitleFile(path) { return subtitleExtensions.has(extensionOf(path)); },
    isAudioFile(path) { return audioExtensions.has(extensionOf(path)); },
    setKeepScreenOn(on) {
      try { window.AndroidBridge.setKeepScreenOn(Boolean(on)); } catch (_) { /* no-op outside Android */ }
    },
    platform: 'android',
    versions: { android: true, webview: navigator.userAgent || '' },
  };

  root.pvBridge = bridge;
  window.pvBridge = bridge;

  // The standard archive export code downloads Blob URLs. Route those files
  // through Android's Storage Access Framework instead of a browser download.
  const anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function androidAwareDownloadClick() {
    const href = String(this.href || '');
    const filename = String(this.download || 'proudvocab-export.json');
    if (!this.download || !href.startsWith('blob:')) return anchorClick.call(this);

    const anchor = this;
    fetch(href).then((response) => response.blob()).then((blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',').pop() || '');
      reader.onerror = () => reject(reader.error || new Error('Could not read export file'));
      reader.readAsDataURL(blob);
    })).then((base64) => invoke('pv:save-file', {
      name: filename,
      mime: anchor.type || 'application/octet-stream',
      base64,
    })).catch((error) => console.error('[ProudVocab Android] Export failed', error));
  };

  try {
    root.__PV_ANDROID_INITIAL_FILES = JSON.parse(window.AndroidBridge.consumeInitialFiles() || '[]');
  } catch (_) {
    root.__PV_ANDROID_INITIAL_FILES = [];
  }
})();
