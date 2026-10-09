/* Android-specific panel behaviour; shared feature code remains upstream. */
(function installAndroidPanel() {
  'use strict';

  const isPersian = String(navigator.language || '').toLowerCase().startsWith('fa');
  const run = () => {
    if (!document.body) return;
    document.body.classList.add('pv-android');

    // This build is entirely local/offline for accounts and entitlements.
    // Cloud Drive OAuth belongs to the browser extension and is not available
    // inside this Android WebView, so explain the local export/restore path.
    const login = document.getElementById('profile-login-btn');
    const syncNow = document.getElementById('profile-sync-now-btn');
    const logout = document.getElementById('profile-logout-btn');
    const buy = document.getElementById('profile-buy-premium-btn');
    const manage = document.getElementById('profile-manage-subscription-btn');
    [login, syncNow, logout, buy, manage].forEach((element) => {
      if (element) element.style.display = 'none';
    });

    const badge = document.getElementById('profile-membership-badge');
    if (badge) {
      badge.textContent = isPersian ? 'همهٔ امکانات فعال' : 'All features enabled';
      badge.style.display = 'inline-flex';
    }

    const syncStatus = document.getElementById('profile-sync-status');
    if (syncStatus) syncStatus.textContent = isPersian ? 'ذخیره‌سازی محلی فعال' : 'Saved on this device';

    const syncAnchor = document.getElementById('profile-sync-status')
      || document.getElementById('sync-google-btn')
      || document.getElementById('google-sync-btn');
    if (syncAnchor) {
      const host = syncAnchor.closest('.settings-block, .settings-card') || syncAnchor.parentElement;
      if (host && !host.querySelector('.pv-android-sync-note')) {
        const note = document.createElement('div');
        note.className = 'pv-android-sync-note';
        note.textContent = isPersian
          ? 'واژه‌ها و پیشرفت شما فقط روی همین دستگاه ذخیره می‌شوند. برای انتقال، از بخش آرشیو خروجی بگیرید یا فایل پشتیبان را بازیابی کنید.'
          : 'Words and progress are stored on this device. Use Archive export or restore to move a backup.';
        host.appendChild(note);
      }
    }

    unlockVisibleControls();
    if (document.body.__pvAndroidUnlockObserver) return;
    const observer = new MutationObserver(unlockVisibleControls);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    document.body.__pvAndroidUnlockObserver = observer;
  };

  function unlockVisibleControls() {
    document.querySelectorAll('.premium-locked').forEach((element) => {
      element.classList.remove('premium-locked');
    });
    document.querySelectorAll('.premium-lock-overlay').forEach((element) => element.remove());
    document.querySelectorAll('.premium-pro-tag, .premium-crown-badge').forEach((element) => {
      if (!element.closest('#premium-welcome-modal, #premium-modal')) element.remove();
    });
    const membership = document.getElementById('profile-membership-badge');
    if (membership && membership.textContent === 'FREE') membership.textContent = 'All features enabled';
  }

  // These dialogs/actions only advertise paid plans; every local learning
  // feature is already enabled by the Android entitlement provider.
  window.showPremiumModal = function noPremiumModal() {};
  window.handleBuyPremium = function noPurchaseFlow() {};
  window.executeIfPremium = function runUnlockedFeature(callback) {
    if (typeof callback === 'function') callback();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
})();
