/* Route the panel's generated CSV/JSON backup files through SAF. */
(function installDownloadBridge() {
  'use strict';
  const bridge = window.top && window.top.pvBridge;
  if (!bridge || !HTMLAnchorElement || HTMLAnchorElement.prototype.__pvAndroidSavePatch) return;

  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function saveBlobFromAndroid() {
    const href = String(this.href || '');
    const name = String(this.download || 'proudvocab-export.json');
    if (!this.download || !href.startsWith('blob:')) return originalClick.call(this);

    const anchor = this;
    fetch(href).then((response) => response.blob()).then((blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',').pop() || '');
      reader.onerror = () => reject(reader.error || new Error('Could not read export file'));
      reader.readAsDataURL(blob);
    })).then((base64) => bridge.invoke('pv:save-file', {
      name,
      mime: blobMime(anchor) || 'application/octet-stream',
      base64,
    })).then((result) => {
      if (!result || !result.ok) console.warn('[ProudVocab Android] Export was not saved.');
    }).catch((error) => console.error('[ProudVocab Android] Export failed', error));
  };
  HTMLAnchorElement.prototype.__pvAndroidSavePatch = true;

  function blobMime(anchor) {
    try {
      return anchor.type || (anchor.href && URL.createObjectURL ? '' : '');
    } catch (_) { return ''; }
  }
})();
