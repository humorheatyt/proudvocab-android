/**
 * player.js – the local video + local subtitle engine of ProudVocab Desktop
 * ---------------------------------------------------------------------------
 * What it does
 *   • plays any local video file through the pv-media:// protocol (with HTTP
 *     range support, so seeking inside a 4 GB mkv works)
 *   • parses .srt / .vtt / .ass next to it (any encoding) and writes the active
 *     cue into `#pv-caption-host`
 *   • that single DOM write is what the original extension watches on YouTube,
 *     so the whole vocabulary engine (word chips, CEFR colours, tooltips,
 *     dual subtitles, shadowing, slow-mo, rewind) keeps working untouched
 *   • publishes the cue list to `window.__primevocab_subtitles` through the
 *     same `__primevocab_track_ready` event the network interceptor used
 *   • normal player UX: playlist, recents, resume, cue jumping, sync offset,
 *     speed, keyboard shortcuts, drag & drop
 */
(function () {
  'use strict';

  window.addEventListener('error', (e) => {
    console.error('[player] uncaught error:', (e.error && e.error.stack) || e.message, e.filename + ':' + e.lineno);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    console.error('[player] unhandled rejection:', (r && r.stack) || r);
  });

  const bridge = window.pvBridge || (window.top && window.top.pvBridge);
  const BUS = window.top && window.top.__pvBus;
  const $ = (id) => document.getElementById(id);
  const video = $('pv-video');
  const captionHost = $('pv-caption-host');

  const PREF_KEY = 'pvDesktopPlayer';
  const LANGS = [
    ['en', 'English'], ['fa', 'فارسی'], ['tr', 'Türkçe'], ['de', 'Deutsch'], ['fr', 'Français'],
    ['es', 'Español'], ['it', 'Italiano'], ['ru', 'Русский'], ['pt', 'Português'], ['ar', 'العربية'],
    ['zh', '中文'], ['ja', '日本語'], ['ko', '한국어'], ['nl', 'Nederlands'], ['pl', 'Polski'],
    ['sv', 'Svenska'], ['uk', 'Українська'], ['hi', 'हिन्दी'],
  ];
  const RATES = [0.5, 0.62, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

  /* --------------------------------------------------------------- strings */
  const STRINGS = {
    en: {
      empty_title: 'Open a local video',
      empty_hint: 'Drop a video file here, or pick one from disk. Add an <b>.srt</b> subtitle and every word in it becomes clickable – with translation, CEFR level and spaced-repetition review.',
      btn_open_video: 'Open video', btn_open_subtitle: 'Open SRT', btn_open_folder: 'Folder as playlist',
      empty_drop: '…or drop video + subtitle files anywhere in this window',
      cc_title: 'Subtitles', cc_load: 'Load SRT / VTT…', cc_off: 'Off', cc_lang: 'Subtitle language',
      cc_delay: 'Sync offset', cc_delay_reset: 'reset', cc_auto: 'Auto-load a matching .srt next to the video',
      cc_show_plain: 'Simple caption (no clickable words)',
      files_title: 'Files & playlist', files_playlist: 'Playlist', files_recent: 'Recent',
      tip_playpause: 'Play / Pause (Space)', tip_prev_cue: 'Previous line (Shift+↑)', tip_next_cue: 'Next line (Shift+↓)',
      tip_replay_cue: 'Replay this line (R)', tip_mute: 'Mute (M)', tip_files: 'Files & playlist (L)',
      tip_ontop: 'Always on top', tip_fullscreen: 'Full screen (F / F11)',
      recent_title: 'Continue watching',
      sub_loaded: 'Subtitles loaded: {n} lines ({lang}, {enc})',
      sub_none: 'No subtitle cues found in that file',
      sub_found: '{n} subtitle file(s) found next to the video – open the CC menu to choose',
      no_video: 'Open a video first',
      resume: 'Resumed at {t}',
      resume_restart: 'start over',
      err_load: 'This file could not be played ({code}). Chromium can decode H.264/AAC (mp4, mkv), VP9/Opus (webm) and – with OS support – HEVC. AVI/WMV/FLV usually need converting.',
      err_missing: 'File not found: {name}',
      err_sub: 'Could not read the subtitle file',
      dropped: 'Playing {name}',
      track_activated: 'Subtitle track: {name}',
      playlist_empty: 'Open a folder to build a playlist',
      next_in: 'Next video in {s}s',
      engine_ready: 'Vocabulary engine ready',
    },
    fa: {
      empty_title: 'یک ویدیوی محلی باز کنید',
      empty_hint: 'فایل ویدیو را اینجا رها کنید یا از دیسک انتخاب کنید. یک زیرنویس <b>.srt</b> اضافه کنید تا هر کلمه‌ی آن قابل کلیک شود – با ترجمه، سطح CEFR و مرور با تکرار فاصله‌دار.',
      btn_open_video: 'باز کردن ویدیو', btn_open_subtitle: 'باز کردن SRT', btn_open_folder: 'پوشه به‌عنوان پلی‌لیست',
      empty_drop: '…یا فایل ویدیو و زیرنویس را هر جای این پنجره رها کنید',
      cc_title: 'زیرنویس‌ها', cc_load: 'بارگذاری SRT / VTT…', cc_off: 'خاموش', cc_lang: 'زبان زیرنویس',
      cc_delay: 'جابه‌جایی زمانی زیرنویس', cc_delay_reset: 'صفر', cc_auto: 'بارگذاری خودکار .srt هم‌نام کنار ویدیو',
      cc_show_plain: 'زیرنویس ساده (بدون کلمه‌های کلیک‌شدنی)',
      files_title: 'فایل‌ها و پلی‌لیست', files_playlist: 'پلی‌لیست', files_recent: 'اخیر',
      tip_playpause: 'پخش / توقف (Space)', tip_prev_cue: 'خط قبلی (Shift+↑)', tip_next_cue: 'خط بعدی (Shift+↓)',
      tip_replay_cue: 'پخش دوباره‌ی این خط (R)', tip_mute: 'بی‌صدا (M)', tip_files: 'فایل‌ها و پلی‌لیست (L)',
      tip_ontop: 'همیشه روی پنجره‌ها', tip_fullscreen: 'تمام‌صفحه (F / F11)',
      recent_title: 'ادامه‌ی تماشا',
      sub_loaded: 'زیرنویس بارگذاری شد: {n} خط ({lang}, {enc})',
      sub_none: 'هیچ زیرنویسی در این فایل پیدا نشد',
      sub_found: '{n} فایل زیرنویس کنار ویدیو پیدا شد – از منوی CC انتخاب کنید',
      no_video: 'ابتدا یک ویدیو باز کنید',
      resume: 'از {t} ادامه یافت',
      resume_restart: 'شروع از اول',
      err_load: 'این فایل پخش نشد ({code}). کرومیوم می‌تواند H.264/AAC (mp4, mkv)، VP9/Opus (webm) و — با پشتیبانی سیستم‌عامل — HEVC را باز کند. AVI/WMV/FLV معمولاً نیاز به تبدیل دارند.',
      err_missing: 'فایل پیدا نشد: {name}',
      err_sub: 'خواندن فایل زیرنویس ممکن نشد',
      dropped: 'در حال پخش {name}',
      track_activated: 'زیرنویس فعال: {name}',
      playlist_empty: 'برای ساخت پلی‌لیست یک پوشه باز کنید',
      next_in: 'ویدیوی بعدی تا {s} ثانیه',
      engine_ready: 'موتور واژگان آماده است',
    },
    tr: {
      empty_title: 'Yerel bir video aç',
      empty_hint: 'Buraya bir video dosyası bırakın ya da diskten seçin. Bir <b>.srt</b> altyazı ekleyin; içindeki her kelime tıklanabilir olsun – çeviri, CEFR seviyesi ve aralıklı tekrar ile.',
      btn_open_video: 'Video aç', btn_open_subtitle: 'SRT aç', btn_open_folder: 'Klasörü liste yap',
      empty_drop: '…ya da video + altyazı dosyalarını bu pencerenin herhangi bir yerine bırakın',
      cc_title: 'Altyazılar', cc_load: 'SRT / VTT yükle…', cc_off: 'Kapalı', cc_lang: 'Altyazı dili',
      cc_delay: 'Senkron kaydırma', cc_delay_reset: 'sıfırla', cc_auto: 'Videonun yanındaki eşleşen .srt dosyasını otomatik yükle',
      cc_show_plain: 'Basit altyazı (tıklanabilir kelimeler olmadan)',
      files_title: 'Dosyalar ve liste', files_playlist: 'Oynatma listesi', files_recent: 'Son kullanılanlar',
      tip_playpause: 'Oynat / Duraklat (Space)', tip_prev_cue: 'Önceki satır (Shift+↑)', tip_next_cue: 'Sonraki satır (Shift+↓)',
      tip_replay_cue: 'Bu satırı tekrar oynat (R)', tip_mute: 'Sessiz (M)', tip_files: 'Dosyalar ve liste (L)',
      tip_ontop: 'Her zaman üstte', tip_fullscreen: 'Tam ekran (F / F11)',
      recent_title: 'İzlemeye devam et',
      sub_loaded: 'Altyazı yüklendi: {n} satır ({lang}, {enc})',
      sub_none: 'Bu dosyada altyazı bulunamadı',
      sub_found: 'Videonun yanında {n} altyazı dosyası bulundu – seçmek için CC menüsünü açın',
      no_video: 'Önce bir video açın',
      resume: '{t} konumundan devam ediliyor',
      resume_restart: 'baştan başlat',
      err_load: 'Bu dosya oynatılamadı ({code}). Chromium H.264/AAC (mp4, mkv), VP9/Opus (webm) ve – işletim sistemi destekliyorsa – HEVC çözer. AVI/WMV/FLV genellikle dönüştürme ister.',
      err_missing: 'Dosya bulunamadı: {name}',
      err_sub: 'Altyazı dosyası okunamadı',
      dropped: '{name} oynatılıyor',
      track_activated: 'Altyazı: {name}',
      playlist_empty: 'Liste oluşturmak için bir klasör açın',
      next_in: 'Sonraki video {s} sn içinde',
      engine_ready: 'Kelime motoru hazır',
    },
  };
  let LANG = 'en';
  function t(key, vars) {
    const table = STRINGS[LANG] || STRINGS.en;
    let s = table[key] || STRINGS.en[key] || key;
    if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(vars[k]);
    return s;
  }
  function applyI18n() {
    const nav = String(navigator.language || '').toLowerCase();
    const ui = (BUS && BUS.i18n().uiLanguage) || 'en';
    LANG = nav.startsWith('fa') ? 'fa' : ui === 'tr' ? 'tr' : 'en';
    document.documentElement.lang = LANG;
    document.querySelectorAll('[data-t]').forEach((el) => {
      const val = t(el.getAttribute('data-t'));
      const plain = val.replace(/<[^>]*>/g, '');
      if (el.children.length) {
        /* icon button – never wipe the <svg>: translate a <span> or text node */
        const span = el.querySelector('span');
        if (span) { if (/<[a-z]/i.test(val)) span.innerHTML = val; else span.textContent = val; }
        else {
          let hit = false;
          for (const n of Array.from(el.childNodes)) {
            if (n.nodeType === 3 && n.nodeValue.trim()) { n.nodeValue = ' ' + plain + ' '; hit = true; break; }
          }
          if (!hit) el.title = plain;
        }
      } else if (/<[a-z]/i.test(val)) el.innerHTML = val;
      else el.textContent = val;
      if (el.hasAttribute('title') || el.children.length) el.title = plain;
    });
    renderRecents();
    renderPlaylist();
    renderTracks();
  }

  /* ----------------------------------------------------------------- state */
  const state = {
    videoPath: null, videoName: null, videoUrl: null, contentId: null,
    duration: 0, loaded: false, failed: false,
    tracks: [], activeTrackId: null, trackSeq: 0,
    subDelay: 0, autoSub: true, showPlain: false,
    playlist: [], playlistIndex: -1,
    recents: [], resume: {},
    volume: 1, muted: false, rate: 1, onTop: false, seekSeconds: 5,
    captionText: '', cueIdx: -1,
    scrubbing: false, hideTimer: null, saveTimer: null, endedTimer: null,
    engineReady: false, suppressLangSync: false,
  };

  const activeTrack = () => state.tracks.find((x) => x.id === state.activeTrackId) || null;
  const fmt = (s) => window.PVSubtitles.formatClock(s);

  /* ------------------------------------------------------------ persistence */
  function loadPrefs() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({ [PREF_KEY]: {}, seekSeconds: 5 }, (res) => {
          const p = res && res[PREF_KEY] ? res[PREF_KEY] : {};
          state.seekSeconds = Math.min(10, Math.max(1, parseInt(res.seekSeconds, 10) || 5));
          state.recents = Array.isArray(p.recents) ? p.recents.slice(0, 20) : [];
          state.resume = p.resume && typeof p.resume === 'object' ? p.resume : {};
          state.volume = typeof p.volume === 'number' ? p.volume : 1;
          state.muted = !!p.muted;
          state.rate = typeof p.rate === 'number' ? p.rate : 1;
          state.autoSub = p.autoSub !== false;
          state.showPlain = !!p.showPlain;
          state.subDelay = typeof p.subDelay === 'number' ? p.subDelay : 0;
          state.lastVideo = p.lastVideo || null;
          resolve(p);
        });
      } catch (e) { console.warn('[player] loadPrefs failed', e); resolve({}); }
    });
  }
  function savePrefs() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      const payload = {
        recents: state.recents.slice(0, 20),
        resume: state.resume,
        volume: state.volume, muted: state.muted, rate: state.rate,
        autoSub: state.autoSub, showPlain: state.showPlain,
        lastVideo: state.videoPath ? { path: state.videoPath, name: state.videoName, time: video.currentTime || 0, duration: state.duration } : null,
      };
      try { chrome.storage.local.set({ [PREF_KEY]: payload }); } catch (e) { console.warn('[player] savePrefs failed', e); }
    }, 600);
  }

  /* ------------------------------------------------------------------ toasts */
  let toastTimer = null;
  function toast(msg, kind, ms) {
    const el = $('pv-toast');
    if (!el) return;
    el.className = kind ? 'toast-' + kind : '';
    el.textContent = msg;
    el.classList.remove('pv-hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('pv-hidden'), ms || 3200);
  }
  function notice(html, actionLabel, onAction) {
    const old = document.querySelector('.pv-notice');
    if (old) old.remove();
    const d = document.createElement('div');
    d.className = 'pv-notice';
    d.innerHTML = html;
    if (actionLabel) {
      const b = document.createElement('button');
      b.textContent = actionLabel;
      b.addEventListener('click', () => { d.remove(); if (onAction) onAction(); });
      d.appendChild(b);
    }
    $('pv-player-container').appendChild(d);
    setTimeout(() => { if (d.parentNode) d.remove(); }, 12000);
  }

  /* ============================================================== video I/O */
  function shortHash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  async function loadVideo(path, opts) {
    const o = opts || {};
    const info = await bridge.invoke('pv:file-info', path);
    if (!info || !info.ok) { toast(t('err_missing', { name: String(path).split(/[\\/]/).pop() }), 'err', 5000); return false; }

    // leaving one video behind -> remember where we stopped
    rememberPosition();

    state.videoPath = path;
    state.videoName = info.name;
    state.videoUrl = bridge.localIdFor(path);
    state.contentId = shortHash(path);
    state.loaded = false;
    state.failed = false;
    state.cueIdx = -1;
    state.captionText = '';

    video.src = bridge.mediaUrlFor(path);
    video.load();
    try { video.playbackRate = state.rate; video.volume = state.volume; video.muted = state.muted; } catch (e) { /* ignore */ }

    document.body.classList.remove('pv-no-video');
    $('pv-empty').classList.add('pv-hidden');
    $('pv-controls').classList.remove('pv-hidden');
    $('pv-bigplay').classList.remove('pv-hidden');
    $('t-dur').textContent = '0:00';
    $('t-cur').textContent = '0:00';

    pushRecent(path, info.name);
    updateNowPlaying();
    updateTabInfo();
    savePrefs();

    // clear the panel transcript exactly like the YouTube adapter does
    try {
      if (window.PrimeVocabCommon && window.PrimeVocabCommon.resetSubtitleState) window.PrimeVocabCommon.resetSubtitleState();
      chrome.runtime.sendMessage({ action: 'video_changed', platform: 'Local' });
    } catch (e) { console.warn('[player] reset failed', e); }
    clearCaption();
    state.tracks = [];
    state.activeTrackId = null;
    renderTracks();

    const seekTo = o.seekTo != null ? o.seekTo : (state.resume[state.contentId] && state.resume[state.contentId].time) || 0;

    const onMeta = () => {
      video.removeEventListener('loadedmetadata', onMeta);
      state.duration = isFinite(video.duration) ? video.duration : 0;
      state.loaded = true;
      $('t-dur').textContent = fmt(state.duration);
      if (seekTo > 1 && seekTo < state.duration - 2) {
        video.currentTime = seekTo;
        if (!o.silentResume) {
          notice(t('resume', { t: fmt(seekTo) }), t('resume_restart'), () => { video.currentTime = 0; syncCaption(true); });
        }
      }
      drawTicks();
      if (o.autoplay) play();
      else syncCaption(true);
      if (state.autoSub) autoDetectSubtitles(path);
    };
    video.addEventListener('loadedmetadata', onMeta);
    if (video.readyState >= 1) onMeta();
    return true;
  }

  function rememberPosition() {
    if (!state.contentId || !state.loaded || !isFinite(video.currentTime)) return;
    state.resume[state.contentId] = {
      time: video.currentTime, duration: state.duration, name: state.videoName, path: state.videoPath, at: Date.now(),
    };
    const keys = Object.keys(state.resume);
    if (keys.length > 120) {
      keys.sort((a, b) => (state.resume[a].at || 0) - (state.resume[b].at || 0)).slice(0, keys.length - 120)
        .forEach((k) => delete state.resume[k]);
    }
  }

  function pushRecent(path, name) {
    state.recents = state.recents.filter((r) => r.path !== path);
    state.recents.unshift({ path, name, at: Date.now() });
    state.recents = state.recents.slice(0, 20);
    renderRecents();
  }

  function updateNowPlaying() {
    if (!BUS || !BUS.setNowPlaying) return;
    BUS.setNowPlaying({
      name: state.videoName || '',
      meta: state.duration ? `${fmt(video.currentTime || 0)} / ${fmt(state.duration)}` : '',
      hasVideo: !!state.videoPath,
    });
  }
  function updateTabInfo() {
    if (!BUS) return;
    BUS.setTabInfo({
      url: state.videoUrl || 'pv-local://player',
      title: state.videoName ? state.videoName.replace(/\.[a-z0-9]+$/i, '') : 'ProudVocab Desktop',
    });
  }

  /* ========================================================== subtitle I/O */
  async function loadSubtitleFile(path, opts) {
    const o = opts || {};
    const res = await bridge.invoke('pv:read-bytes', path);
    if (!res || !res.ok) { toast(t('err_sub'), 'err'); return null; }
    const bytes = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
    const name = String(path).split(/[\\/]/).pop();
    /* the file name carries the language hint (movie.fa.srt) which makes the
       legacy-encoding guess (windows-1256 vs -1254 vs …) deterministic */
    const dec = window.PVSubtitles.decode(bytes, { lang: window.PVSubtitles.guessLangFromName(name) || undefined });
    const parsed = window.PVSubtitles.parse(dec.text, { fileName: name });
    if (!parsed.cues.length) { toast(t('sub_none') + (parsed.warnings[0] ? ' – ' + parsed.warnings[0] : ''), 'err', 5000); return null; }

    const guessed = window.PVSubtitles.guessLangFromName(name);
    const track = {
      id: 'trk' + (++state.trackSeq),
      name, path,
      lang: o.lang || guessed || currentSourceLang() || 'en',
      cues: parsed.cues,
      map: window.PVSubtitles.buildMap(parsed.cues),
      encoding: dec.encoding, kind: parsed.kind,
    };
    const existing = state.tracks.findIndex((x) => x.path === path);
    if (existing >= 0) state.tracks[existing] = track; else state.tracks.push(track);
    renderTracks();
    if (o.activate !== false) activateTrack(track.id);
    toast(t('sub_loaded', { n: parsed.cues.length, lang: track.lang.toUpperCase(), enc: track.encoding }), 'ok', 4200);
    return track;
  }

  function currentSourceLang() {
    try {
      const cs = window.PrimeVocabCommon && window.PrimeVocabCommon.currentSettings;
      if (cs && cs.sourceLang) return String(cs.sourceLang).toLowerCase().slice(0, 2);
    } catch (e) { /* ignore */ }
    return null;
  }

  function activateTrack(id) {
    const track = state.tracks.find((x) => x.id === id) || null;
    state.activeTrackId = track ? track.id : null;
    document.body.classList.toggle('pv-cc-on', !!track);
    renderTracks();
    if (!track) { publishTrack(null); clearCaption(); return; }
    publishTrack(track);
    syncSourceLang(track.lang);
    syncCaption(true);
    drawTicks();
    const badge = $('cc-badge');
    badge.textContent = track.lang.toUpperCase();
    badge.classList.remove('pv-hidden');
    toast(t('track_activated', { name: track.name }), 'ok', 2200);
  }

  /** hand the cue list to the extension engine (same event the interceptor used) */
  function publishTrack(track) {
    try {
      const cues = track
        ? track.cues.map((c) => [Number((c.start + state.subDelay).toFixed(3)), { start: c.start + state.subDelay, end: c.end + state.subDelay, text: c.text }])
        : [];
      const lang = track ? track.lang : (currentSourceLang() || 'en');
      window.dispatchEvent(new CustomEvent('__primevocab_track_ready', { detail: { lang, count: cues.length, cues } }));
      if (!track) {
        window.__primevocab_subtitles = {};
        window.__primevocab_sorted_times = {};
      }
    } catch (e) { console.warn('[player] publishTrack failed', e); }
  }

  function syncSourceLang(lang) {
    if (!lang || state.suppressLangSync) return;
    state.suppressLangSync = true;
    setTimeout(() => { state.suppressLangSync = false; }, 1200);
    try {
      chrome.storage.sync.get({ settings: {} }, ({ settings }) => {
        const s = settings && typeof settings === 'object' ? settings : {};
        s.local = s.local && typeof s.local === 'object' ? s.local : {};
        const cur = String(s.local.sourceLang || s.sourceLang || '').toLowerCase().slice(0, 2);
        if (cur === String(lang).toLowerCase().slice(0, 2)) return;
        s.local.sourceLang = lang;
        s.sourceLang = lang;
        s.timestamp = Date.now();
        chrome.storage.sync.set({ settings: s });
      });
    } catch (e) { console.warn('[player] syncSourceLang failed', e); }
  }

  async function autoDetectSubtitles(videoPath) {
    const res = await bridge.invoke('pv:scan-subtitles', videoPath);
    if (!res || !res.ok || !res.files || !res.files.length) return;
    const exact = res.files.find((f) => f.exact);
    if (exact) { await loadSubtitleFile(exact.path, { activate: true }); return; }
    if (res.files.length === 1) { await loadSubtitleFile(res.files[0].path, { activate: true }); return; }
    toast(t('sub_found', { n: res.files.length }), 'ok', 6000);
    state.suggested = res.files;
    renderTracks();
  }

  /* ==================================================== caption → the engine */
  function clearCaption() {
    state.captionText = '';
    state.cueIdx = -1;
    if (captionHost.childNodes.length) captionHost.textContent = '';
  }

  function cueAt(time) {
    const track = activeTrack();
    if (!track || !track.cues.length) return null;
    const idx = window.PVSubtitles.findIndex(track.cues, time - state.subDelay);
    if (idx < 0) return null;
    state.cueIdx = idx;
    return track.cues[idx];
  }

  function syncCaption(force) {
    const cue = cueAt(video.currentTime || 0);
    const text = cue ? cue.text : '';
    if (!force && text === state.captionText) return;
    state.captionText = text;
    renderCaption(text);
  }

  function renderCaption(text) {
    if (!text) { if (captionHost.childNodes.length) captionHost.textContent = ''; return; }
    const lines = String(text).split('\n');
    // rebuild only when the content really changed – the engine's
    // MutationObserver turns this into the interactive word-chip overlay
    if (captionHost.__pvText === text) return;
    captionHost.__pvText = text;
    captionHost.textContent = '';
    for (const l of lines) {
      const d = document.createElement('div');
      d.className = 'pv-caption-line';
      d.textContent = l;
      captionHost.appendChild(d);
    }
  }

  /* ================================================================= control */
  function play() {
    if (!state.videoPath) return toast(t('no_video'), 'err', 1800);
    const p = video.play();
    if (p && p.catch) p.catch((e) => console.warn('[player] play() rejected', e));
  }
  function pause() { try { video.pause(); } catch (e) { /* ignore */ } }
  function togglePlay() { if (video.paused) play(); else pause(); }

  function seekTo(sec) {
    if (!state.loaded || !isFinite(sec)) return;
    const max = isFinite(video.duration) ? video.duration : sec;
    try { video.currentTime = Math.max(0, Math.min(sec, max)); } catch (e) { return; }
    syncCaption(true);
  }
  function seekBy(d) { seekTo((video.currentTime || 0) + d); }

  function cueStep(dir) {
    const track = activeTrack();
    if (!track) return toast(t('no_video'), 'err', 1500);
    const now = video.currentTime || 0;
    let idx;
    if (dir > 0) idx = window.PVSubtitles.nextIndex(track.cues, now);
    else {
      const cur = window.PVSubtitles.findIndex(track.cues, now - state.subDelay);
      if (cur > 0 && now - track.cues[cur].start < 1.6) idx = cur - 1;
      else idx = cur >= 0 ? cur : window.PVSubtitles.prevIndex(track.cues, now);
    }
    if (idx == null || idx < 0) { if (dir < 0) seekTo(0); return; }
    seekTo(track.cues[idx].start + state.subDelay + 0.02);
    if (video.paused) syncCaption(true);
  }
  function replayCue() {
    const track = activeTrack();
    const now = video.currentTime || 0;
    if (!track) return seekBy(-5);
    const idx = window.PVSubtitles.findIndex(track.cues, now - state.subDelay);
    if (idx >= 0) seekTo(track.cues[idx].start + state.subDelay + 0.01);
    else {
      const p = window.PVSubtitles.prevIndex(track.cues, now);
      if (p >= 0) seekTo(track.cues[p].start + state.subDelay + 0.01); else seekBy(-5);
    }
  }

  function setRate(r) {
    state.rate = r;
    try { video.playbackRate = r; } catch (e) { /* ignore */ }
    $('btn-rate').textContent = (r === 1 ? '1' : String(r).replace(/^0\./, '.')) + '×';
    savePrefs();
  }
  function cycleRate(dir) {
    let i = RATES.indexOf(state.rate);
    if (i < 0) i = RATES.indexOf(1);
    i = Math.max(0, Math.min(RATES.length - 1, i + dir));
    setRate(RATES[i]);
    toast(RATES[i] + '×', null, 900);
  }
  function setVolume(v) {
    state.volume = Math.max(0, Math.min(1, v));
    video.volume = state.volume;
    if (state.volume > 0 && state.muted) toggleMute(false);
    $('pv-volume').value = String(state.volume);
    updateVolumeIcon();
    savePrefs();
  }
  function toggleMute(force) {
    state.muted = force == null ? !state.muted : !!force;
    video.muted = state.muted;
    updateVolumeIcon();
    savePrefs();
  }
  function updateVolumeIcon() {
    const off = state.muted || state.volume === 0;
    document.querySelector('#btn-mute .i-vol').classList.toggle('pv-hidden', off);
    document.querySelector('#btn-mute .i-muted').classList.toggle('pv-hidden', !off);
  }

  function toggleFullscreen() { bridge.invoke('pv:window-action', 'fullscreen'); }
  function toggleOnTop() {
    state.onTop = !state.onTop;
    bridge.invoke('pv:window-action', 'always-on-top', state.onTop);
    $('btn-ontop').classList.toggle('on', state.onTop);
  }

  /* ==================================================================== UI */
  function showControls(temp) {
    document.body.classList.remove('pv-hide-controls', 'pv-cursor-none');
    clearTimeout(state.hideTimer);
    if (temp) return;
    state.hideTimer = setTimeout(() => {
      if (!video.paused && !document.querySelector('.pv-popup:not(.pv-hidden)') && !state.scrubbing) {
        document.body.classList.add('pv-hide-controls', 'pv-cursor-none');
      }
    }, 2600);
  }

  function updateProgressUI() {
    const dur = state.duration || (isFinite(video.duration) ? video.duration : 0);
    const cur = video.currentTime || 0;
    const pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;
    $('pv-played').style.width = pct + '%';
    $('pv-knob').style.left = pct + '%';
    setTimeLabel(cur);
    const buf = video.buffered;
    if (buf && buf.length && dur > 0) {
      let end = 0;
      for (let i = 0; i < buf.length; i++) if (buf.end(i) > cur) { end = Math.max(end, buf.end(i)); break; }
      $('pv-buffered').style.width = Math.min(100, (end / dur) * 100) + '%';
    }
  }
  let lastTimeText = '';
  function setTimeLabel(cur) {
    const s = fmt(cur);
    if (s === lastTimeText) return;
    lastTimeText = s;
    const el = $('t-cur');
    if (el.firstChild && el.firstChild.nodeType === 3) el.firstChild.nodeValue = s; // characterData, not childList
    else el.textContent = s;
  }

  function drawTicks() {
    const c = $('pv-cue-ticks');
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(rect.width * dpr));
    const H = Math.max(1, Math.round(rect.height * dpr));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const track = activeTrack();
    if (!track || !state.duration || track.cues.length > 4000) return;
    ctx.fillStyle = 'rgba(255,255,255,.30)';
    const h = Math.round(3 * dpr);
    for (const cue of track.cues) {
      const x = Math.round(((cue.start + state.subDelay) / state.duration) * W);
      ctx.fillRect(x, H - h, Math.max(1, Math.round(dpr)), h);
    }
  }

  function renderTracks() {
    const box = $('cc-track-list');
    if (!box) return;
    box.innerHTML = '';
    if (!state.tracks.length) {
      if (state.suggested && state.suggested.length) {
        for (const f of state.suggested) {
          const d = document.createElement('div');
          d.className = 'tr-item';
          d.innerHTML = `<span class="tr-radio"></span><span class="tr-name"></span><span class="tr-meta">?</span>`;
          d.querySelector('.tr-name').textContent = f.name;
          d.addEventListener('click', async () => { await loadSubtitleFile(f.path, { activate: true }); });
          box.appendChild(d);
        }
      }
      return;
    }
    for (const tr of state.tracks) {
      const d = document.createElement('div');
      d.className = 'tr-item' + (tr.id === state.activeTrackId ? ' active' : '');
      d.innerHTML = `<span class="tr-radio"></span><span class="tr-name"></span><span class="tr-meta">${tr.cues.length} · ${tr.lang.toUpperCase()}</span><button class="tr-x" title="remove">✕</button>`;
      d.querySelector('.tr-name').textContent = tr.name;
      d.addEventListener('click', (e) => {
        if (e.target.closest('.tr-x')) return;
        activateTrack(tr.id === state.activeTrackId ? null : tr.id);
        if (!tr.id) return;
        if (state.activeTrackId === null) badgeOff();
      });
      d.querySelector('.tr-x').addEventListener('click', (e) => {
        e.stopPropagation();
        state.tracks = state.tracks.filter((x) => x.id !== tr.id);
        if (state.activeTrackId === tr.id) { state.activeTrackId = null; publishTrack(null); clearCaption(); badgeOff(); }
        renderTracks();
      });
      box.appendChild(d);
    }
  }
  function badgeOff() { const b = $('cc-badge'); b.classList.add('pv-hidden'); b.textContent = '0'; }

  function renderPlaylist() {
    const box = $('f-playlist');
    if (!box) return;
    box.innerHTML = '';
    if (!state.playlist.length) {
      const d = document.createElement('div');
      d.className = 'tr-meta';
      d.style.padding = '4px 2px';
      d.textContent = t('playlist_empty');
      box.appendChild(d);
      return;
    }
    state.playlist.forEach((f, i) => {
      const d = document.createElement('div');
      d.className = 'tr-item' + (f.path === state.videoPath ? ' active' : '');
      d.innerHTML = `<span class="tr-radio"></span><span class="tr-name"></span><span class="tr-meta">${i + 1}/${state.playlist.length}</span>`;
      d.querySelector('.tr-name').textContent = f.name;
      d.addEventListener('click', () => { state.playlistIndex = i; loadVideo(f.path, { autoplay: true }); });
      box.appendChild(d);
    });
  }

  function renderRecents() {
    const small = $('f-recent');
    const big = $('empty-recent');
    const items = state.recents.slice(0, 8);
    if (small) {
      small.innerHTML = '';
      for (const r of items) {
        const d = document.createElement('div');
        d.className = 'tr-item' + (r.path === state.videoPath ? ' active' : '');
        d.innerHTML = `<span class="tr-radio"></span><span class="tr-name"></span>`;
        d.querySelector('.tr-name').textContent = r.name;
        d.addEventListener('click', () => loadVideo(r.path, {}));
        small.appendChild(d);
      }
    }
    if (big) {
      big.innerHTML = '';
      if (!items.length) return;
      const title = document.createElement('div');
      title.className = 'rc-title';
      title.textContent = t('recent_title');
      big.appendChild(title);
      for (const r of items.slice(0, 5)) {
        const rs = state.resume[shortHash(r.path)];
        const pct = rs && rs.duration ? Math.min(100, (rs.time / rs.duration) * 100) : 0;
        const d = document.createElement('div');
        d.className = 'rc-item';
        d.innerHTML = `<span class="rc-name"></span>
          ${rs ? `<span class="rc-bar"><i style="width:${pct.toFixed(1)}%"></i></span><span class="rc-meta">${fmt(rs.time)}</span>` : ''}`;
        d.querySelector('.rc-name').textContent = r.name;
        d.addEventListener('click', () => loadVideo(r.path, {}));
        big.appendChild(d);
      }
    }
  }

  /* --------------------------------------------------------------- popups */
  function togglePopup(id) {
    const el = $(id);
    const open = el.classList.contains('pv-hidden');
    document.querySelectorAll('.pv-popup').forEach((p) => p.classList.add('pv-hidden'));
    if (open) {
      el.classList.remove('pv-hidden');
      if (id === 'pv-popup-files') { renderPlaylist(); renderRecents(); }
      if (id === 'pv-popup-cc') renderTracks();
      showControls(true);
    }
  }
  function closePopups() { document.querySelectorAll('.pv-popup').forEach((p) => p.classList.add('pv-hidden')); }

  /* ================================================================ wiring */
  function wire() {
    /* ---- transport ---- */
    $('btn-play').addEventListener('click', togglePlay);
    $('pv-bigplay').addEventListener('click', () => { play(); });
    $('btn-prev-cue').addEventListener('click', () => cueStep(-1));
    $('btn-next-cue').addEventListener('click', () => cueStep(1));
    $('btn-replay-cue').addEventListener('click', replayCue);
    $('btn-rate').addEventListener('click', () => cycleRate(1));
    $('btn-mute').addEventListener('click', () => toggleMute());
    $('pv-volume').addEventListener('input', (e) => setVolume(parseFloat(e.target.value)));
    $('btn-fullscreen').addEventListener('click', toggleFullscreen);
    $('btn-ontop').addEventListener('click', toggleOnTop);
    $('btn-cc').addEventListener('click', () => togglePopup('pv-popup-cc'));
    $('btn-files').addEventListener('click', () => togglePopup('pv-popup-files'));
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePopups));

    /* ---- empty state buttons ---- */
    $('empty-open-video').addEventListener('click', pickVideo);
    $('empty-open-sub').addEventListener('click', pickSubtitle);
    $('empty-open-folder').addEventListener('click', pickFolder);

    /* ---- CC popup ---- */
    $('cc-load').addEventListener('click', pickSubtitle);
    $('cc-off').addEventListener('click', () => { activateTrack(null); badgeOff(); });
    $('cc-delay-down').addEventListener('click', () => setSubDelay(state.subDelay - 0.25));
    $('cc-delay-up').addEventListener('click', () => setSubDelay(state.subDelay + 0.25));
    $('cc-delay-reset').addEventListener('click', () => setSubDelay(0));
    $('cc-auto').addEventListener('change', (e) => { state.autoSub = e.target.checked; savePrefs(); });
    $('cc-show-plain').addEventListener('change', (e) => {
      state.showPlain = e.target.checked;
      document.body.classList.toggle('pv-plain-captions', state.showPlain);
      savePrefs();
    });
    const langSel = $('cc-lang');
    for (const [code, label] of LANGS) {
      const op = document.createElement('option');
      op.value = code;
      op.textContent = `${label} (${code})`;
      langSel.appendChild(op);
    }
    langSel.addEventListener('change', () => {
      const tr = activeTrack();
      if (!tr) return;
      tr.lang = langSel.value;
      publishTrack(tr);
      syncSourceLang(tr.lang);
      renderTracks();
      savePrefs();
    });

    /* ---- files popup ---- */
    $('f-open-video').addEventListener('click', pickVideo);
    $('f-open-folder').addEventListener('click', pickFolder);

    /* ---- progress bar ---- */
    const prog = $('pv-progress');
    const timeFromEvent = (e) => {
      const r = prog.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
      return ratio * (state.duration || 0);
    };
    prog.addEventListener('pointerdown', (e) => {
      if (!state.duration) return;
      state.scrubbing = true;
      prog.setPointerCapture(e.pointerId);
      seekTo(timeFromEvent(e));
      showControls(true);
    });
    prog.addEventListener('pointermove', (e) => {
      const r = prog.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
      const tt = ratio * (state.duration || 0);
      const hover = $('pv-hover-time');
      const track = activeTrack();
      const idx = track ? window.PVSubtitles.findIndex(track.cues, tt - state.subDelay) : -1;
      hover.textContent = idx >= 0 ? `${fmt(tt)}  ·  ${track.cues[idx].text.replace(/\n/g, ' ')}` : fmt(tt);
      hover.style.left = (ratio * r.width) + 'px';
      hover.classList.remove('pv-hidden');
      if (state.scrubbing) seekTo(tt);
    });
    prog.addEventListener('pointerleave', () => $('pv-hover-time').classList.add('pv-hidden'));
    prog.addEventListener('pointerup', (e) => {
      if (!state.scrubbing) return;
      state.scrubbing = false;
      try { prog.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      syncCaption(true);
      showControls();
    });
    prog.addEventListener('wheel', (e) => { e.preventDefault(); seekBy(e.deltaY > 0 ? -5 : 5); }, { passive: false });

    /* ---- video element events ---- */
    video.addEventListener('play', () => {
      if (bridge && bridge.setKeepScreenOn) bridge.setKeepScreenOn(true);
      setPlayIcon(true);
      $('pv-bigplay').classList.add('pv-fading');
      showControls();
    });
    video.addEventListener('playing', () => { setPlayIcon(true); $('pv-bigplay').classList.add('pv-fading'); });
    video.addEventListener('pause', () => {
      // the engine pauses the video while a word tooltip is open – keep the UI in sync
      if (!window.PrimeVocabCommon || !window.PrimeVocabCommon.isHoveringOverlay) setPlayIcon(false);
      else setPlayIcon(false);
      $('pv-bigplay').classList.remove('pv-fading', 'pv-hidden');
      if (bridge && bridge.setKeepScreenOn) bridge.setKeepScreenOn(false);
      rememberPosition();
      savePrefs();
      showControls(true);
    });
    let lastMobileProgressSave = 0;
    video.addEventListener('timeupdate', () => {
      updateProgressUI();
      syncCaption(false);
      if (Date.now() - lastMobileProgressSave > 5000) {
        lastMobileProgressSave = Date.now();
        rememberPosition();
        savePrefs();
      }
    });
    video.addEventListener('seeked', () => { syncCaption(true); updateProgressUI(); });
    video.addEventListener('ratechange', () => { if (Math.abs(video.playbackRate - state.rate) > 0.001) { state.rate = video.playbackRate; $('btn-rate').textContent = (state.rate === 1 ? '1' : String(state.rate)) + '×'; } });
    video.addEventListener('volumechange', () => {
      if (Math.abs(video.volume - state.volume) > 0.001) { state.volume = video.volume; $('pv-volume').value = String(state.volume); }
      if (video.muted !== state.muted) { state.muted = video.muted; }
      updateVolumeIcon();
    });
    video.addEventListener('loadedmetadata', () => {
      state.duration = isFinite(video.duration) ? video.duration : 0;
      $('t-dur').textContent = fmt(state.duration);
      updateProgressUI();
      drawTicks();
    });
    video.addEventListener('durationchange', () => {
      if (isFinite(video.duration) && Math.abs(video.duration - state.duration) > 0.5) {
        state.duration = video.duration;
        $('t-dur').textContent = fmt(state.duration);
        drawTicks();
      }
    });
    video.addEventListener('progress', updateProgressUI);
    video.addEventListener('ended', () => {
      rememberPosition(); savePrefs(); setPlayIcon(false);
      if (state.playlist.length > 1) {
        let n = 5;
        toast(t('next_in', { s: n }), 'ok', 5200);
        clearInterval(state.endedTimer);
        state.endedTimer = setInterval(() => {
          n--;
          if (n <= 0) {
            clearInterval(state.endedTimer);
            playNext();
          }
        }, 1000);
      }
    });
    video.addEventListener('error', () => {
      state.failed = true;
      const code = video.error ? video.error.code : 0;
      const names = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
      notice(t('err_load', { code: names[code] || code }), LANG === 'fa' ? 'نمایش در پوشه' : 'Show in folder', () => {
        if (state.videoPath) bridge.invoke('pv:show-in-folder', state.videoPath);
      });
    });
    video.addEventListener('waiting', () => document.body.classList.add('pv-buffering'));
    video.addEventListener('canplay', () => document.body.classList.remove('pv-buffering'));

    /* ---- mouse / auto-hide ---- */
    const stage = $('pv-stage');
    stage.addEventListener('mousemove', () => showControls());
    stage.addEventListener('mouseleave', () => { if (!video.paused) document.body.classList.add('pv-hide-controls', 'pv-cursor-none'); });
    stage.addEventListener('click', (e) => {
      if (e.target.closest('#pv-controls') || e.target.closest('.pv-popup') || e.target.closest('#pv-empty')) return;
      if (e.target.closest('#primevocab-subtitle-overlay')) return; // let the engine handle word clicks
      if (e.detail === 2) toggleFullscreen();
      else togglePlay();
    });
    window.addEventListener('resize', () => { drawTicks(); });

    /* ---- drag & drop ---- */
    const dropZone = $('pv-empty');
    ['dragenter', 'dragover'].forEach((ev) => window.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('drop-active'); }));
    ['dragleave', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && e.relatedTarget) return; dropZone.classList.remove('drop-active'); }));
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (!files.length) return;
      const paths = files.map((f) => bridge.getPathForFile(f)).filter(Boolean);
      await openFiles(paths);
    });

    /* ---- keyboard ---- */
    window.addEventListener('keydown', onKey, false);

    /* ---- follow the panel's own "seek step" setting ---- */
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.seekSeconds) return;
        state.seekSeconds = Math.min(10, Math.max(1, parseInt(changes.seekSeconds.newValue, 10) || 5));
      });
    } catch (e) { /* ignore */ }

    /* ---- shell / menu ---- */
    if (bridge && bridge.on) {
      bridge.on('pv:fullscreen-changed', ({ on }) => {
        document.querySelector('#btn-fullscreen .i-fs').classList.toggle('pv-hidden', !!on);
        document.querySelector('#btn-fullscreen .i-fs-exit').classList.toggle('pv-hidden', !on);
      });
    }
  }

  function setPlayIcon(playing) {
    document.querySelector('#btn-play .i-play').classList.toggle('pv-hidden', playing);
    document.querySelector('#btn-play .i-pause').classList.toggle('pv-hidden', !playing);
  }

  function setSubDelay(sec) {
    state.subDelay = Math.max(-30, Math.min(30, Math.round(sec * 100) / 100));
    $('cc-delay-val').textContent = (state.subDelay >= 0 ? '+' : '') + state.subDelay.toFixed(2) + ' s';
    const tr = activeTrack();
    if (tr) { publishTrack(tr); syncCaption(true); }
    drawTicks();
    savePrefs();
  }

  function onKey(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable)) return;
    if (e.defaultPrevented) return;         // the engine already consumed it (shadowing, chip nav…)
    if (e.altKey || e.ctrlKey || e.metaKey) return; // those belong to the app menu / the engine
    const k = e.key;
    let handled = true;
    switch (true) {
      case k === ' ' || k === 'Spacebar': togglePlay(); break;
      case k === 'ArrowRight': seekBy(e.shiftKey ? state.seekSeconds * 3 : state.seekSeconds); break;
      case k === 'ArrowLeft': seekBy(e.shiftKey ? -state.seekSeconds * 3 : -state.seekSeconds); break;
      case k === 'ArrowUp':
        if (e.shiftKey) cueStep(-1); else setVolume(state.volume + 0.05);
        break;
      case k === 'ArrowDown':
        if (e.shiftKey) cueStep(1); else setVolume(state.volume - 0.05);
        break;
      case k === 'r' || k === 'R': replayCue(); break;
      case k === 'f' || k === 'F': toggleFullscreen(); break;
      case k === 'm' || k === 'M': toggleMute(); break;
      case k === 'l' || k === 'L': togglePopup('pv-popup-files'); break;
      case k === 's' || k === 'S': pickSubtitle(); break;
      case k === 'o' || k === 'O': pickVideo(); break;
      case k === 'c' || k === 'C': togglePopup('pv-popup-cc'); break;
      case k === 'p' || k === 'P': if (BUS) BUS.setPanelVisible(!(BUS.config().panelVisible)); break;
      case k === 't' || k === 'T': toggleOnTop(); break;
      case k === '[': cycleRate(-1); break;
      case k === ']': cycleRate(1); break;
      case k === ',': if (video.paused) seekBy(-1 / 30); break;
      case k === '.': if (video.paused) seekBy(1 / 30); break;
      case k === 'Escape': closePopups(); if (document.body.classList.contains('pv-hide-controls')) showControls(true); break;
      case /^[0-9]$/.test(k): {
        if (!state.duration) { handled = false; break; }
        seekTo(state.duration * (Number(k) / 10));
        break;
      }
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); showControls(); }
  }

  /* ------------------------------------------------------------- file picks */
  async function pickVideo() {
    const res = await bridge.invoke('pv:open-dialog', { kind: 'video', defaultPath: lastDir() });
    if (!res || res.canceled || !Array.isArray(res.filePaths) || !res.filePaths.length) return;
    if (res.filePaths.length > 1) return openFiles(res.filePaths);
    await loadVideo(res.filePaths[0], { autoplay: true });
  }
  async function pickSubtitle() {
    if (!state.videoPath && !state.tracks.length) { /* still allow loading a track before the video */ }
    const res = await bridge.invoke('pv:open-dialog', { kind: 'subtitle', defaultPath: lastDir() });
    if (res.canceled) return;
    await loadSubtitleFile(res.filePaths[0], { activate: true });
  }
  async function pickFolder() {
    const res = await bridge.invoke('pv:open-directory');
    if (res.canceled) return;
    const list = await bridge.invoke('pv:list-videos', res.filePaths[0]);
    state.playlist = (list && list.files) || [];
    renderPlaylist();
    if (!state.playlist.length) return toast(t('playlist_empty'), 'err');
    state.playlistIndex = 0;
    await loadVideo(state.playlist[0].path, { autoplay: true });
  }
  function lastDir() {
    if (state.videoPath) return state.videoPath.replace(/[\\/][^\\/]*$/, '');
    return (state.recents[0] && state.recents[0].path || '').replace(/[\\/][^\\/]*$/, '') || undefined;
  }
  function playNext() {
    if (!state.playlist.length) return;
    state.playlistIndex = (state.playlistIndex + 1) % state.playlist.length;
    loadVideo(state.playlist[state.playlistIndex].path, { autoplay: true });
  }

  async function openFiles(paths) {
    const videos = [];
    const subs = [];
    for (const p of paths) {
      if (bridge.isVideoFile(p)) videos.push(p);
      else if (bridge.isSubtitleFile(p)) subs.push(p);
    }
    if (videos.length > 1) {
      state.playlist = videos.map((p) => ({ path: p, name: String(p).split(/[\\/]/).pop() }));
      state.playlistIndex = 0;
      renderPlaylist();
    }
    if (videos.length) {
      const ok = await loadVideo(videos[0], { autoplay: subs.length === 0 });
      if (ok) toast(t('dropped', { name: state.videoName }), 'ok', 2000);
    }
    for (const s of subs) await loadSubtitleFile(s, { activate: true });
  }

  function openLocalId(url) {
    try {
      const u = String(url);
      const b64 = u.replace(/^pv-local:\/\//, '').split('#')[0].split('?')[0];
      const p = new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
      const m = /[#&?]t=(\d+)/.exec(u);
      if (p && bridge.isVideoFile(p)) loadVideo(p, { seekTo: m ? Number(m[1]) : 0, autoplay: true, silentResume: !!m });
      else if (p) bridge.invoke('pv:show-in-folder', p);
    } catch (e) { console.warn('[player] openLocalId failed', e); }
  }

  /* ------------------------------------------------------------ engine glue */
  /**
   * The browser extension loads a per-site script (inject_youtube.js,
   * inject_netflix.js, inject_amazon.js) whose very last line is
   * `PrimeVocabCommon.init()`. That call is what pulls the user's settings out
   * of chrome.storage, builds `currentSettings` for the active adapter, loads
   * the saved-word map, wires the numpad/Alt+arrow shortcuts and – crucially –
   * registers the storage.onChanged listener plus PlayerAdapter.onInit.
   * There is no such site script for local files, so we do it ourselves.
   */
  let engineInitStarted = false;
  async function initEngine() {
    if (engineInitStarted) return;
    engineInitStarted = true;
    const C = window.PrimeVocabCommon;
    if (!C || typeof C.init !== 'function') { console.warn('[player] PrimeVocabCommon.init() not available'); return; }
    try {
      const r = C.init();
      if (r && typeof r.then === 'function') await Promise.race([r, new Promise((res) => setTimeout(res, 10000))]);
      console.log('[player] engine init() finished');
    } catch (e) { console.error('[player] engine init() failed', e); }
  }

  function onEngineInit(settings) {
    state.engineReady = true;
    state.engineSettings = settings || null;
    document.body.classList.add('pv-engine-ready');
    try {
      const lang = settings && settings.sourceLang ? String(settings.sourceLang).toLowerCase().slice(0, 2) : 'en';
      const sel = $('cc-lang');
      if (sel) sel.value = lang;
      const tr = activeTrack();
      if (tr && tr.lang !== lang) { tr.lang = lang; publishTrack(tr); renderTracks(); }
      else if (!tr) { sel.value = lang; }
    } catch (e) { /* ignore */ }
    if (state.captionText) syncCaption(true);
    console.log('[player] engine initialised');
  }
  function onEngineSettings(settings) {
    if (!settings) return;
    state.engineSettings = settings;
    const sel = $('cc-lang');
    const tr = activeTrack();
    const lang = String(settings.sourceLang || '').toLowerCase().slice(0, 2);
    if (sel && lang) sel.value = lang;
    if (tr && lang && tr.lang !== lang) {
      const match = state.tracks.find((x) => x.lang === lang);
      if (match && match.id !== tr.id) activateTrack(match.id);
      else { tr.lang = lang; publishTrack(tr); renderTracks(); }
    }
  }
  function onSourceLangRequested(lang) {
    const l = String(lang || '').toLowerCase().slice(0, 2);
    if (!l) return;
    const tr = activeTrack();
    if (tr && tr.lang === l) return;
    const match = state.tracks.find((x) => x.lang === l);
    if (match) activateTrack(match.id);
  }

  /* --------------------------------------------------------------- lifecycle */
  let rafId = 0;
  let lastUiUpdate = 0;
  function tick(now) {
    rafId = requestAnimationFrame(tick);
    if (!state.loaded) return;
    if (now - lastUiUpdate > 100) { lastUiUpdate = now; updateProgressUI(); if (BUS) updateNowPlaying(); }
  }

  function getMetadata() {
    const base = (state.videoName || document.title || '').replace(/\.[a-z0-9]+$/i, '');
    return { title: base || null, showTitle: null, season: null, episode: null };
  }
  function getPageSource() {
    return {
      title: (state.videoName || '').replace(/\.[a-z0-9]+$/i, '') || null,
      showTitle: null, season: null, episode: null,
      time: isFinite(video.currentTime) ? Math.floor(video.currentTime) : null,
      contentId: state.contentId,
      url: state.videoUrl || 'pv-local://player',
    };
  }

  const api = {
    /* for LocalAdapter */
    onEngineInit, onEngineSettings, onSourceLangRequested, getMetadata, getPageSource,
    syncAfterSeek: () => syncCaption(true),
    /* for the shell */
    openFiles, openLocalId, pickVideo, pickSubtitle, pickFolder,
    menuAction(action, arg) {
      switch (action) {
        case 'play-pause': togglePlay(); break;
        case 'seek': seekBy(Number(arg) || 0); break;
        case 'cue': cueStep(Number(arg) || 1); break;
        case 'replay-cue': replayCue(); break;
        case 'rate': setRate(Number(arg) || 1); break;
        case 'fullscreen': toggleFullscreen(); break;
        case 'always-on-top': state.onTop = !!arg; $('btn-ontop').classList.toggle('on', state.onTop); break;
        case 'devtools': break;
        default: break;
      }
    },
    get state() { return state; },
    get video() { return video; },
    /* test hooks (used by scripts/smoke) */
    __test: {
      ready: () => state.loaded,
      cues: () => (activeTrack() ? activeTrack().cues.length : 0),
      caption: () => state.captionText,
      overlayText: () => {
        const o = document.getElementById('primevocab-subtitle-overlay');
        return o ? (o.textContent || '').trim() : '';
      },
      chips: () => document.querySelectorAll('.primevocab-word-chip').length,
      tooltip: () => {
        const tip = document.querySelector('#primevocab-translation-tooltip, .primevocab-translation-tooltip');
        if (!tip) return null;
        return {
          visible: tip.offsetParent !== null,
          word: (tip.querySelector('.primevocab-tooltip-word') || {}).textContent || '',
          text: (tip.textContent || '').replace(/\s+/g, ' ').trim(),
          saved: !!tip.querySelector('.primevocab-tooltip-save.saved'),
        };
      },
      get video() { return video; },
      getState: () => ({
        videoPath: state.videoPath, loaded: state.loaded, failed: state.failed, duration: state.duration,
        tracks: state.tracks.map((x) => ({ id: x.id, lang: x.lang, cues: x.cues.length })),
        engine: state.engineSettings ? {
          sourceLang: state.engineSettings.sourceLang, targetLang: state.engineSettings.targetLang,
          dualSubtitles: state.engineSettings.dualSubtitles, enabled: state.engineSettings.enabled,
          fontSize: state.engineSettings.fontSize, wordHighlight: state.engineSettings.wordHighlight,
        } : null,
      }),
      initEngine,
      loadVideo, loadSubtitleFile, seekTo, play, pause, togglePlay,
    },
  };

  window.__pvPlayer = api;
  window.__pvDesktop = api;

  async function start() {
    applyI18n();
    document.body.classList.add('pv-no-video');
    document.body.classList.toggle('pv-plain-captions', state.showPlain);
    $('cc-auto').checked = state.autoSub;
    $('cc-show-plain').checked = state.showPlain;

    wire();
    await loadPrefs();
    await initEngine();
    $('cc-auto').checked = state.autoSub;
    $('cc-show-plain').checked = state.showPlain;
    document.body.classList.toggle('pv-plain-captions', state.showPlain);
    setVolume(state.volume);
    if (state.muted) toggleMute(true);
    setRate(state.rate);
    setSubDelay(state.subDelay);
    renderRecents();
    renderTracks();
    showControls(true);
    rafId = requestAnimationFrame(tick);

    /* restore the previous session */
    if (state.lastVideo && state.lastVideo.path) {
      const info = await bridge.invoke('pv:file-info', state.lastVideo.path);
      if (info && info.ok) await loadVideo(state.lastVideo.path, { silentResume: false });
    }
    window.dispatchEvent(new CustomEvent('pv-player-ready'));
  }

  window.addEventListener('beforeunload', () => {
    rememberPosition();
    savePrefs();
    cancelAnimationFrame(rafId);
    if (bridge && bridge.setKeepScreenOn) bridge.setKeepScreenOn(false);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') { rememberPosition(); savePrefs(); }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
