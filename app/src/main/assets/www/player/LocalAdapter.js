/**
 * LocalAdapter.js – the PlayerAdapter implementation for local files.
 * ---------------------------------------------------------------------------
 * The engine (content/inject_common.js) only ever talks to `window.PlayerAdapter`,
 * so replacing the YouTube adapter with this one is enough to run the whole
 * ProudVocab feature set on a local video: clickable word chips, CEFR colours,
 * translation tooltips, dual subtitles, shadowing, auto-slow-mo, auto-rewind…
 *
 * Subtitles do not come from a network request any more: player.js parses a
 * local .srt/.vtt/.ass and writes the active cue into `.pv-caption-host`,
 * which is exactly what the engine's MutationObserver watches on YouTube
 * (`.ytp-caption-window-container`).
 */
(function () {
  'use strict';

  const player = () => window.__pvPlayer || null;

  window.PlayerAdapter = {
    name: 'Local',

    /* the element the engine observes for new subtitle text */
    SUBTITLE_SELECTORS: ['.pv-caption-host', '#pv-caption-host'],

    captionHideStyles: '\n    .pv-caption-host {\n      opacity: 0 !important;\n      pointer-events: none !important;\n    }\n  ',

    getActiveVideo() {
      return document.getElementById('pv-video') || document.querySelector('video');
    },

    getPlayerContainer() {
      return document.getElementById('pv-player-container') || (this.getActiveVideo() || {}).parentElement || null;
    },

    play(video) {
      const v = video || this.getActiveVideo();
      if (v) { try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ } }
    },

    pause(video) {
      const v = video || this.getActiveVideo();
      if (v) { try { v.pause(); } catch (e) { /* ignore */ } }
    },

    seek(video, time) {
      const v = video || this.getActiveVideo();
      if (!v || time == null || isNaN(time)) return;
      try {
        v.currentTime = Math.max(0, Math.min(time, isFinite(v.duration) ? v.duration : time));
      } catch (e) { /* not seekable yet */ }
      if (player()) player().syncAfterSeek();
    },

    seekRelative(video, delta) {
      const v = video || this.getActiveVideo();
      if (!v || delta == null) return;
      this.seek(v, Math.max(0, v.currentTime + delta));
    },

    /** the engine asks "should I run on this page?" – always yes here */
    shouldRun() { return true; },

    /** YouTube uses this to ignore "click the settings icon" placeholder cues */
    isMetaSubtitle(text) {
      if (!text) return true;
      const t = String(text).trim();
      if (!t) return true;
      return t === '\u266a' || /^[\u266a\s]*$/.test(t);
    },

    /* -------------------------------------------------------- lifecycle hooks */
    onInit(settings) {
      if (player()) player().onEngineInit(settings);
    },

    onSettingsChanged(settings) {
      if (player()) player().onEngineSettings(settings);
    },

    /**
     * Called when the user changes "learning language" in the panel. If several
     * subtitle tracks are loaded we switch to the one that matches.
     */
    setSubtitleLanguage(lang) {
      if (player()) player().onSourceLangRequested(lang);
    },

    getMetadata(cb) {
      const md = player() ? player().getMetadata() : { title: document.title, showTitle: null, season: null, episode: null };
      if (typeof cb === 'function') cb(md);
      return md;
    },

    getPageSource() {
      if (player()) return player().getPageSource();
      return { title: document.title, showTitle: null, season: null, episode: null, time: null, contentId: null, url: location.href };
    },
  };

  console.log('[PV-local] LocalAdapter registered');
})();
