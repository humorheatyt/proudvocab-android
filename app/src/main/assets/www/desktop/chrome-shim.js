/* eslint-disable no-undef */
/**
 * chrome-shim.js  –  runs the *unmodified* extension code inside Electron
 * ---------------------------------------------------------------------------
 * The original project is a Manifest-V3 browser extension. Its three worlds
 * (content script, side panel, service worker) talk to each other through the
 * `chrome.*` APIs. This file re-implements exactly the subset that ProudVocab
 * uses, on top of the in-page message bus that `shell.js` publishes as
 * `window.top.__pvBus`.
 *
 * Implemented: runtime (sendMessage / onMessage / connect / onConnect /
 * getURL / lastError / onInstalled / onStartup), storage (local / sync /
 * onChanged), tabs, i18n, commands, identity, sidePanel, action.
 *
 * Everything is deliberately synchronous-where-Chrome-is-synchronous and
 * asynchronous-where-Chrome-is-asynchronous, and data is JSON round-tripped
 * between frames – the same serialisation boundary Chrome itself applies.
 *
 * Loaded as the FIRST script of: bg.html, player/player.html, ext/sidepanel/panel.html
 * `window.__PV_ROLE__` must be set before this file: "background" | "player" | "panel".
 */
(function installChromeShim() {
  'use strict';

  const ROLE = window.__PV_ROLE__ || 'unknown';
  const BUS = window.top && window.top.__pvBus;
  if (!BUS) {
    console.error('[pv-shim] window.top.__pvBus is missing – this page must be loaded inside the ProudVocab shell.');
    return;
  }

  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const inRealm = (x) => clone(x);

  /* background.js pulls in its dependencies with importScripts(); inside a
   * document they are ordinary <script> tags, so this becomes a no-op. */
  if (typeof window.importScripts !== 'function') window.importScripts = function pvImportScripts() {};

  /* Never let Chromium navigate the app away when a file is dropped somewhere
   * that has no drop handler of its own. */
  window.addEventListener('dragover', (e) => { if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; e.preventDefault(); }, false);
  window.addEventListener('drop', (e) => { e.preventDefault(); }, false);

  /* ---------------------------------------------------------------- events */
  function makeEvent() {
    const listeners = [];
    return {
      addListener(fn) { if (typeof fn === 'function' && listeners.indexOf(fn) < 0) listeners.push(fn); },
      removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      hasListener(fn) { return listeners.indexOf(fn) >= 0; },
      hasListeners() { return listeners.length > 0; },
      _fire(...args) {
        for (const fn of listeners.slice()) {
          try { fn(...args); } catch (e) { console.error('[pv-shim] listener error', e); }
        }
      },
      _listeners: listeners,
    };
  }

  /* ------------------------------------------------------------ registration */
  BUS.registerFrame(ROLE, {
    win: window,
    clone: inRealm,
    runtimeListeners: [],
    connectListeners: [],
    storageListeners: [],
    ports: new Map(),
    portFactory: null,
  });

  const frame = BUS.frame(ROLE);

  /* ------------------------------------------------------------------ misc */
  const onInstalled = makeEvent();
  const onStartup = makeEvent();
  const onConnect = makeEvent();
  const onMessage = makeEvent();
  const onStorageChanged = makeEvent();
  const onTabActivated = makeEvent();
  const onTabUpdated = makeEvent();
  const onTabRemoved = makeEvent();
  const onActionClicked = makeEvent();

  frame.runtimeListeners.push(onMessage);
  frame.connectListeners.push(onConnect);
  frame.storageListeners.push(onStorageChanged);

  /* ------------------------------------------------------------------ chrome */
  const chromeShim = {
    __pvShim: true,
    __pvRole: ROLE,

    runtime: {
      id: 'proudvocab-desktop',
      lastError: undefined,
      getManifest: () => clone(BUS.manifest),
      getURL: (p) => BUS.getURL(p),
      reload: () => window.location.reload(),

      onMessage,
      onConnect,
      onInstalled,
      onStartup,
      onSuspend: makeEvent(),
      onMessageExternal: makeEvent(),

      /**
       * chrome.runtime.sendMessage(message[, responseCallback]) -> Promise|undefined
       * Delivered to the background frame and to the panel frame (never to
       * content-script frames) – exactly like Chrome.
       */
      sendMessage(msg, cb) {
        const hasCb = typeof cb === 'function';
        const p = BUS.runtimeSend(ROLE, msg);
        if (!hasCb) {
          return p.then(unwrap, (err) => { chromeShim.runtime.lastError = err instanceof Error ? err : new Error(String(err)); throw err; });
        }
        p.then(
          (res) => cb(unwrap(res)),
          (err) => { chromeShim.runtime.lastError = err instanceof Error ? err : new Error(String(err)); cb(undefined); }
        );
        return undefined;
      },

      /** chrome.runtime.connect({name}) -> Port (panel <-> background) */
      connect(info) {
        const name = (info && info.name) || '';
        const portId = BUS.portCreate(ROLE, name);
        return makePort(portId, name, ROLE);
      },

      getPlatformInfo: (cb) => { const r = { os: BUS.platform, arch: BUS.arch, nacl_arch: 'x86-64' }; if (cb) cb(inRealm(r)); return Promise.resolve(r); },
    },

    storage: {
      local: makeStorageArea('local'),
      sync: makeStorageArea('sync'),
      session: makeStorageArea('session'),
      managed: makeStorageArea('managed'),
      onChanged: onStorageChanged,
    },

    tabs: {
      query(info, cb) {
        const tabs = BUS.getTabs(info);
        /* Chrome answers asynchronously – answering synchronously here breaks
           code that does connect() + query() + postMessage() back to back. */
        if (cb) { chromeShim.runtime.lastError = undefined; setTimeout(() => cb(inRealm(tabs)), 0); return undefined; }
        return Promise.resolve(inRealm(tabs));
      },
      get(tabId, cb) {
        const t = BUS.getTab(tabId);
        if (cb) { if (!t) chromeShim.runtime.lastError = new Error('No tab with id: ' + tabId); cb(inRealm(t)); return undefined; }
        return t ? Promise.resolve(inRealm(t)) : Promise.reject(new Error('No tab with id: ' + tabId));
      },
      sendMessage(tabId, msg, cb) {
        const hasCb = typeof cb === 'function';
        const p = BUS.tabsSend(tabId, msg, ROLE);
        if (!hasCb) return p.then(unwrap, () => undefined);
        p.then(
          (res) => cb(unwrap(res)),
          () => { chromeShim.runtime.lastError = new Error('Could not establish connection.'); cb(undefined); }
        );
        return undefined;
      },
      create(opts, cb) {
        const url = (opts && opts.url) || '';
        BUS.openExternal(url);
        const t = { id: Math.floor(Math.random() * 1e6), url, active: true };
        if (cb) cb(inRealm(t));
        return Promise.resolve(t);
      },
      update() { return Promise.resolve(BUS.getTab()); },
      remove(_id, cb) { if (cb) cb(); return Promise.resolve(); },
      reload(_id, _o, cb) { if (cb) cb(); return Promise.resolve(); },
      onActivated: onTabActivated,
      onUpdated: onTabUpdated,
      onRemoved: onTabRemoved,
      onCreated: makeEvent(),
      onMoved: makeEvent(),
      onDetached: makeEvent(),
      onAttached: makeEvent(),
      onHighlighted: makeEvent(),
      onZoomChange: makeEvent(),
      TAB_ID_NONE: -1,
    },

    windows: {
      getCurrent(cb) { const w = { id: 1, focused: true, type: 'normal' }; if (cb) cb(inRealm(w)); return Promise.resolve(w); },
      getAll(cb) { const w = [{ id: 1, focused: true, type: 'normal' }]; if (cb) cb(inRealm(w)); return Promise.resolve(w); },
      create(opts, cb) { if (opts && opts.url) BUS.openExternal(opts.url); const w = { id: 2 }; if (cb) cb(inRealm(w)); return Promise.resolve(w); },
      onFocused: makeEvent(),
    },

    i18n: {
      getMessage(key, substitutions) {
        const i18n = BUS.i18n();
        const entry = i18n.messages && i18n.messages[key];
        if (!entry) return '';
        let out = entry.message || '';
        if (substitutions != null) {
          const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
          out = out.replace(/\$(\d+)/g, (m, n) => (subs[Number(n) - 1] != null ? String(subs[Number(n) - 1]) : m));
          out = out.replace(/\$([a-zA-Z0-9_]+)\$/g, (m, name) => {
            const idx = (entry.placeholders && entry.placeholders[name] && Number(String(entry.placeholders[name].content).replace(/\D/g, ''))) || 0;
            return idx && subs[idx - 1] != null ? String(subs[idx - 1]) : m;
          });
        }
        return out;
      },
      getUILanguage: () => BUS.i18n().uiLanguage,
      getAcceptLanguages(cb) { const l = [BUS.i18n().uiLanguage, 'en']; if (cb) cb(l); return Promise.resolve(l); },
      detectLanguage(_t, cb) { const r = { languages: [{ language: 'en', percentage: 100 }] }; if (cb) cb(inRealm(r)); return Promise.resolve(r); },
    },

    commands: {
      getAll(cb) {
        const list = clone(BUS.commands());
        if (cb) cb(list);
        return Promise.resolve(list);
      },
      onCommand: makeEvent(),
      reset: (cb) => { if (cb) cb(); return Promise.resolve(); },
      update: () => Promise.resolve(),
    },

    /**
     * Google Drive sync of the original extension needs chrome.identity + the
     * Web-Store OAuth client id, neither of which exist in a desktop build.
     * The stubs fail with the exact message the extension already swallows, so
     * the rest of the app keeps working and the panel simply shows "sync off".
     */
    identity: {
      getAuthToken(opts, cb) {
        const err = new Error('Interactive login is not available in the desktop build.');
        if (typeof opts === 'function') { opts(err); return undefined; }
        if (cb) { chromeShim.runtime.lastError = err; cb(undefined, err.message); return undefined; }
        return Promise.reject(err);
      },
      removeCachedAuthToken(_o, cb) { if (cb) cb(); return Promise.resolve(); },
      clearAllCachedAuthTokens(cb) { if (cb) cb(); return Promise.resolve(); },
      getRedirectURL(p) { return (p || '') + 'oauth_callback.html'; },
      launchWebAuthFlow(_o, cb) { const err = new Error('Interactive login is not available in the desktop build.'); if (cb) cb(err); return Promise.reject(err); },
      onSignInChanged: makeEvent(),
    },

    sidePanel: {
      open() { BUS.setPanelVisible(true); return Promise.resolve(); },
      setOptions() { return Promise.resolve(); },
      setPanelBehavior() { return Promise.resolve(); },
      getOptions(cb) { const o = { enabled: true }; if (cb) cb(inRealm(o)); return Promise.resolve(o); },
    },

    action: {
      onClicked: onActionClicked,
      setBadgeText() { return Promise.resolve(); },
      setBadgeBackgroundColor() { return Promise.resolve(); },
      setTitle() { return Promise.resolve(); },
      setIcon() { return Promise.resolve(); },
    },

    /* a few extras that make the ported code behave like a normal web app */
    notifications: { create: () => {}, clear: () => {}, onClicked: makeEvent(), onClosed: makeEvent() },
    downloads: { download: (o, cb) => { BUS.openExternal(o && o.url); if (cb) cb(1); } },
  };

  /* ------------------------------------------------------------- storage API */
  function makeStorageArea(area) {
    const ev = makeEvent();
    frame.storageListeners.push({ area, event: ev });

    function normalizeKeys(keys) {
      if (keys == null) return { kind: 'all' };
      if (typeof keys === 'string') return { kind: 'list', list: [keys] };
      if (Array.isArray(keys)) return { kind: 'list', list: keys.slice() };
      if (typeof keys === 'object') return { kind: 'defaults', defaults: keys };
      return { kind: 'all' };
    }

    const api = {
      QUOTA_BYTES: area === 'sync' ? 102400 : 104857600,
      MAX_ITEMS: 100000,

      get(keys, cb) {
        const spec = normalizeKeys(keys);
        let result = {};
        try {
          const all = BUS.storageGet(area);
          if (spec.kind === 'all') result = all;
          else if (spec.kind === 'list') { for (const k of spec.list) if (Object.prototype.hasOwnProperty.call(all, k)) result[k] = all[k]; }
          else {
            for (const k of Object.keys(spec.defaults)) {
              result[k] = Object.prototype.hasOwnProperty.call(all, k) ? all[k] : clone(spec.defaults[k]);
            }
          }
        } catch (e) { console.error('[pv-shim] storage.get failed', e); }
        result = inRealm(result);
        if (typeof cb === 'function') { chromeShim.runtime.lastError = undefined; setTimeout(() => cb(result), 0); return undefined; }
        return Promise.resolve(result);
      },

      set(items, cb) {
        try { BUS.storageSet(area, clone(items)); } catch (e) { console.error('[pv-shim] storage.set failed', e); }
        if (typeof cb === 'function') { setTimeout(cb, 0); return undefined; }
        return Promise.resolve();
      },

      remove(keys, cb) {
        const list = Array.isArray(keys) ? keys.slice() : [keys];
        try { BUS.storageRemove(area, list); } catch (e) { console.error('[pv-shim] storage.remove failed', e); }
        if (typeof cb === 'function') { setTimeout(cb, 0); return undefined; }
        return Promise.resolve();
      },

      clear(cb) {
        try { BUS.storageClear(area); } catch (e) { console.error('[pv-shim] storage.clear failed', e); }
        if (typeof cb === 'function') { setTimeout(cb, 0); return undefined; }
        return Promise.resolve();
      },

      getBytesInUse(keys, cb) {
        let n = 0;
        try { n = JSON.stringify(BUS.storageGet(area)).length; } catch { n = 0; }
        if (typeof cb === 'function') { cb(n); return undefined; }
        return Promise.resolve(n);
      },

      onChanged: ev,
    };
    return api;
  }

  /* ------------------------------------------------------------------- ports */
  function makePort(portId, name, side) {
    const onMsg = makeEvent();
    const onDisc = makeEvent();
    const port = {
      name,
      sender: side === 'background' ? { id: chromeShim.runtime.id, origin: BUS.origin, tab: clone(BUS.getTab()) } : { id: chromeShim.runtime.id, origin: BUS.origin },
      onMessage: onMsg,
      onDisconnect: onDisc,
      postMessage(msg) { BUS.portPost(portId, side, clone(msg)); },
      disconnect() { BUS.portDisconnect(portId, side); },
    };
    frame.ports.set(portId, port);
    return port;
  }

  /**
   * Turn a bus reply into what Chrome would hand the callback:
   *   { __pvError }      -> runtime.lastError + undefined
   *   { __pvNoResponse } -> undefined (the listener never answered)
   *   anything else      -> the value, deep-copied into this realm
   */
  function unwrap(res) {
    if (res && typeof res === 'object') {
      if (res.__pvError !== undefined) { chromeShim.runtime.lastError = new Error(res.__pvError); return undefined; }
      if (res.__pvNoResponse) { chromeShim.runtime.lastError = undefined; return undefined; }
    }
    chromeShim.runtime.lastError = undefined;
    return inRealm(res);
  }

  /* The bus needs to be able to materialise a Port inside *this* realm when
   * the other side connects. */
  frame.portFactory = (portId, name, side) => makePort(portId, name, side);

  /* ------------------------------------------------------- bus -> shim hooks */
  BUS.attachFrameHooks(ROLE, {
    deliverRuntimeMessage(msg, sender, respond) {
      const m = inRealm(msg);
      const s = inRealm(sender);
      let responded = false;
      let asyncPending = false;
      let timer = null;
      const sendResponse = (r) => {
        if (responded) return;
        responded = true;
        if (timer) { clearTimeout(timer); timer = null; }
        respond(clone(r));
      };
      for (const ev of frame.runtimeListeners) {
        for (const fn of ev._listeners.slice()) {
          let ret;
          try { ret = fn(m, s, sendResponse); } catch (e) { console.error('[pv-shim] onMessage listener threw', e); }
          /* Chrome style: `return true` keeps the channel open.
             Firefox style (and what background.js actually does for
             `translate`): the listener returns a Promise – treat a thenable as
             "still working" too, and adopt its value if it resolves to one. */
          if (ret === true) asyncPending = true;
          else if (ret && typeof ret.then === 'function') {
            asyncPending = true;
            ret.then((v) => { if (v !== undefined && !responded) sendResponse(v); }, () => {});
          }
        }
        if (responded) break;
      }
      if (!responded && !asyncPending) { respond(undefined); return false; }
      if (!responded) {
        /* safety net – never leave the sender hanging forever */
        timer = setTimeout(() => { if (!responded) { responded = true; respond(undefined); } }, 25000);
      }
      return true;
    },
    deliverPortMessage(portId, msg) {
      const p = frame.ports.get(portId);
      if (p) p.onMessage._fire(inRealm(msg));
    },
    deliverPortDisconnect(portId) {
      const p = frame.ports.get(portId);
      if (p) { p.onDisconnect._fire(); frame.ports.delete(portId); }
    },
    deliverConnect(portId, name, side) {
      const port = frame.portFactory(portId, name, side);
      for (const ev of frame.connectListeners) ev._fire(port);
      return port;
    },
    deliverStorageChange(changes, areaName) {
      const c = inRealm(changes);
      onStorageChanged._fire(c, areaName);
      for (const l of frame.storageListeners) {
        if (l && l.area === areaName && l.event) l.event._fire(c);
      }
    },
    deliverTabEvent(kind, a, b, c) {
      if (kind === 'activated') onTabActivated._fire(inRealm(a));
      else if (kind === 'updated') onTabUpdated._fire(a, inRealm(b), inRealm(c));
      else if (kind === 'removed') onTabRemoved._fire(a);
    },
    fireLifecycle(which, details) {
      if (which === 'installed') onInstalled._fire(inRealm(details || { reason: 'install' }));
      else onStartup._fire();
    },
  });

  /* ------------------------------------------------- window.open / fetch/etc */
  const nativeOpen = window.open ? window.open.bind(window) : null;
  window.open = function pvOpen(url, target, features) {
    const u = String(url || '');
    if (!u || u === 'about:blank') return nativeOpen ? nativeOpen(u, target, features) : null;
    if (u.startsWith('pv-local://')) { BUS.openLocalId(u); return null; }
    if (/^(https?:|mailto:)/i.test(u)) { BUS.openExternal(u); return null; }
    if (u.startsWith('chrome://') || u.startsWith('chrome-extension://')) { BUS.openExternal(u); return null; }
    return nativeOpen ? nativeOpen(u, target, features) : null;
  };

  if (ROLE === 'panel') {
    const nativeClose = window.close ? window.close.bind(window) : null;
    window.close = function pvClose() { BUS.setPanelVisible(false); if (nativeClose) { try { nativeClose(); } catch { /* iframes can't close */ } } };
  }

  /* fetch(): local URLs stay native, http(s) is proxied through the main
   * process so Google Translate / dictionaryapi / datamuse work without CORS. */
  const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  const BLOCKED_LICENSE_RE = /(prime-vocab-mobile\.vercel\.app|script\.google\.com)/i;

  window.fetch = function pvFetch(input, init) {
    let url = '';
    let opts = init || {};
    if (typeof input === 'string') url = input;
    else if (input && typeof input === 'object') { url = input.url || ''; if (!init) opts = { method: input.method || 'GET', headers: input.headers ? Object.fromEntries(new Headers(input.headers).entries()) : undefined, body: input.body }; }

    if (!/^https?:/i.test(url)) return nativeFetch(input, init);

    const cfg = BUS.config();
    if (!cfg.licenseServer && BLOCKED_LICENSE_RE.test(url)) {
      const body = JSON.stringify({ ok: false, success: false, error: 'license server disabled in this desktop build' });
      return Promise.resolve(new Response(body, { status: 403, statusText: 'Forbidden', headers: { 'Content-Type': 'application/json' } }));
    }

    const headers = {};
    try {
      const h = opts.headers;
      if (h instanceof Headers) h.forEach((v, k) => { headers[k] = v; });
      else if (Array.isArray(h)) h.forEach(([k, v]) => { headers[k] = v; });
      else if (h && typeof h === 'object') Object.keys(h).forEach((k) => { headers[k] = String(h[k]); });
    } catch { /* ignore */ }

    let body = opts.body;
    if (body != null && typeof body !== 'string') {
      try { body = body instanceof URLSearchParams ? body.toString() : (typeof FormData !== 'undefined' && body instanceof FormData) ? null : String(body); } catch { body = null; }
    }

    const id = 'f' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const signal = opts.signal;

    return new Promise((resolve, reject) => {
      let done = false;
      const onAbort = () => {
        if (done) return;
        done = true;
        try { BUS.netAbort(id); } catch { /* ignore */ }
        const e = new Error('The user aborted a request.');
        e.name = 'AbortError';
        reject(e);
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      BUS.netFetch({ id, url, method: (opts.method || 'GET').toUpperCase(), headers, body: body == null ? null : String(body), timeoutMs: opts.timeoutMs })
        .then((res) => {
          if (done) return;
          done = true;
          if (signal) signal.removeEventListener('abort', onAbort);
          if (!res || !res.ok) {
            if (res && res.error === 'aborted') return onAbort();
            const e = new Error((res && res.error) || 'Network request failed');
            e.name = 'TypeError';
            return reject(e);
          }
          const bytes = res.base64 ? Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0)) : new Uint8Array(0);
          resolve(new Response(bytes, { status: res.status || 200, statusText: res.statusText || '', headers: res.headers || {} }));
          return undefined;
        })
        .catch((err) => {
          if (done) return;
          done = true;
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  };

  /* ---------------------------------------------------------- export chrome */
  try {
    Object.defineProperty(window, 'chrome', { value: chromeShim, writable: true, configurable: true });
  } catch {
    window.chrome = chromeShim;
  }
  window.__pvChromeReady = true;
  BUS.frameReady(ROLE);
  console.log(`[pv-shim] chrome.* shim ready (role=${ROLE})`);
})();
