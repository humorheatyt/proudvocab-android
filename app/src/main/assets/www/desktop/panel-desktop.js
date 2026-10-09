/**
 * panel-desktop.js – last script of the (otherwise untouched) side panel.
 * Small, surgical adaptations for life inside a desktop window:
 *   • mark the body so desktop-panel.css can hide browser-only controls
 *   • the three "enable YouTube / Netflix / Prime" switches are meaningless
 *     when the app only plays local files
 *   • document the desktop player's own keyboard shortcuts
 *   • explain that Google-Drive sync needs the browser build
 */
(function () {
  'use strict';

  const BUS = window.top && window.top.__pvBus;
  const isFa = String(navigator.language || '').toLowerCase().startsWith('fa');

  function onReady(fn, tries) {
    tries = tries || 0;
    if (document.body) { fn(); return; }
    if (tries > 60) return;
    setTimeout(() => onReady(fn, tries + 1), 50);
  }

  onReady(function init() {
    document.body.classList.add('pv-desktop');
    hideBrowserOnlyToggles();
    addShortcutCard();
    addSyncNote();
    tagTitle();

    /* the panel re-reads the active platform whenever the "tab" changes; the
       shell already fires tabs.onUpdated through the shim when a new video is
       opened, but nudge it once more after the first paint. */
    setTimeout(() => {
      try { if (typeof detectAndSetPlatform === 'function') detectAndSetPlatform(); } catch (e) { /* ignore */ }
    }, 700);
  });

  function hideBrowserOnlyToggles() {
    const ids = [
      'enable-youtube-toggle', 'enable-netflix-toggle', 'enable-prime-toggle',
      'platform-toggle-youtube', 'platform-toggle-netflix', 'platform-toggle-prime',
    ];
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const row = el.closest('.settings-block') || el.closest('.settings-group') || el.parentElement;
      if (row) row.classList.add('pv-desktop-hide');
    });
    /* the "Prime Video redirection domain" picker is streaming-only */
    document.querySelectorAll('[data-supported-platforms]').forEach((el) => {
      const p = (el.getAttribute('data-supported-platforms') || '').split(',');
      if (p.indexOf('local') < 0 && p.indexOf('all') < 0) el.classList.add('pv-desktop-hide');
    });
  }

  function addShortcutCard() {
    const overlay = document.getElementById('shortcuts-overlay');
    if (!overlay) return;
    const modal = overlay.querySelector('.shortcuts-modal') || overlay;
    if (modal.querySelector('.pv-desktop-shortcuts')) return;

    const rows = [
      ['Ctrl+O', isFa ? 'باز کردن ویدیو' : 'Open video'],
      ['Ctrl+Shift+O', isFa ? 'باز کردن زیرنویس SRT' : 'Open SRT subtitle'],
      ['Ctrl+Shift+F', isFa ? 'پوشه به‌عنوان پلی‌لیست' : 'Open folder as playlist'],
      ['Ctrl+B', isFa ? 'نمایش/پنهان کردن پنل' : 'Show / hide this panel'],
      ['Space', isFa ? 'پخش / توقف' : 'Play / pause'],
      ['← / →', isFa ? '۵ ثانیه عقب / جلو' : 'Back / forward 5 s'],
      ['Shift+← / →', isFa ? '۱۵ ثانیه عقب / جلو' : 'Back / forward 15 s'],
      ['Shift+↑ / ↓', isFa ? 'خط قبلی / بعدی زیرنویس' : 'Previous / next subtitle line'],
      ['R', isFa ? 'پخش دوباره‌ی خط جاری' : 'Replay current line'],
      ['↑ / ↓', isFa ? 'صدا' : 'Volume'],
      ['M', isFa ? 'بی‌صدا' : 'Mute'],
      ['[ / ]', isFa ? 'سرعت پخش' : 'Playback speed'],
      [', / .', isFa ? 'یک فریم عقب / جلو (هنگام توقف)' : 'Frame step (while paused)'],
      ['0–9', isFa ? 'پرش به درصدی از ویدیو' : 'Jump to 0–90 % of the video'],
      ['C / S / L', isFa ? 'منوی زیرنویس / بارگذاری SRT / فایل‌ها' : 'Subtitle menu / load SRT / files'],
      ['F یا F11', isFa ? 'تمام‌صفحه' : 'Full screen'],
      ['T', isFa ? 'همیشه روی پنجره‌ها' : 'Always on top'],
    ];

    const box = document.createElement('div');
    box.className = 'pv-desktop-shortcuts';
    const h = document.createElement('h4');
    h.textContent = isFa ? 'میان‌برهای نسخه‌ی دسکتاپ' : 'Desktop player shortcuts';
    box.appendChild(h);
    for (const [k, label] of rows) {
      const row = document.createElement('div');
      row.className = 'pvk';
      const span = document.createElement('span');
      span.textContent = label;
      const b = document.createElement('b');
      b.textContent = k;
      row.appendChild(span);
      row.appendChild(b);
      box.appendChild(row);
    }
    modal.appendChild(box);
  }

  function addSyncNote() {
    /* put the note next to the Google-sync controls if we can find them */
    const anchor = document.getElementById('sync-google-btn')
      || document.getElementById('google-sync-btn')
      || document.getElementById('profile-sync-status')
      || document.querySelector('[data-i18n="profile_sync_title"]');
    if (!anchor) return;
    const host = anchor.closest('.settings-block') || anchor.closest('.settings-card') || anchor.parentElement;
    if (!host || host.querySelector('.pv-desktop-note')) return;
    const n = document.createElement('div');
    n.className = 'pv-desktop-note';
    n.textContent = isFa
      ? 'همگام‌سازی گوگل‌درایو فقط در نسخه‌ی افزونه‌ی مرورگر کار می‌کند. در نسخه‌ی دسکتاپ، کلمه‌ها به‌صورت خودکار در پوشه‌ی داده‌ی برنامه روی همین کامپیوتر ذخیره می‌شوند (از بخش آرشیو می‌توانید خروجی JSON/Anki بگیرید).'
      : 'Google-Drive sync only works in the browser extension. In the desktop build your words are saved automatically to this computer\'s app-data folder – use the Archive tab to export JSON/Anki.';
    host.appendChild(n);
  }

  function tagTitle() {
    const t = document.querySelector('.app-title, .panel-title, #panel-title');
    if (t && !t.querySelector('.pv-desktop-tag')) {
      const s = document.createElement('span');
      s.className = 'pv-desktop-tag';
      s.textContent = 'desktop';
      s.style.cssText = 'margin-left:6px;font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#0a0f1c;background:linear-gradient(135deg,#8fd3a4,#6ea8fe);padding:1px 5px;border-radius:5px;vertical-align:2px';
      t.appendChild(s);
    }
    if (BUS && BUS.config) {
      const cfg = BUS.config();
      document.title = 'ProudVocab' + (cfg && cfg.panelVisible === false ? '' : '');
    }
  }

  /* expose a tiny handle for automated tests */
  window.__pvPanelDesktop = { hideBrowserOnlyToggles, addShortcutCard };
})();
