/* Local Android entitlement provider.
 * Network licence checks and signature verification are intentionally absent:
 * this application is an offline, fully-unlocked Android build.
 */
(function installAndroidEntitlements() {
  'use strict';

  const state = {
    licenseType: 'LIFETIME',
    status: 'ACTIVE',
    isPremium: true,
    licenseStatus: 'ACTIVE',
    licenseExpiration: '',
    dailyUsage: 0,
    lastLicenseCheck: Date.now(),
    licenseToken: null,
    googleSyncEnabled: false,
  };

  function persistEntitlements() {
    try { chrome.storage.local.set(state); } catch (_) { /* the shell may still be booting */ }
  }
  persistEntitlements();

  globalThis.PV_ApiClient = {
    async getOrCreateUserId() { return 'android-local-user'; },
    async registerUser() {
      persistEntitlements();
      return { success: true, data: { ...state, isNewRegistration: false } };
    },
    async checkLicense() {
      persistEntitlements();
      return { success: true, data: { ...state } };
    },
    async syncUsage(count) {
      state.dailyUsage = Math.max(0, Number(count) || 0);
      persistEntitlements();
      return { success: true, data: { ...state } };
    },
    async getEffectiveConfig() { return { apiUrl: '', apiSecret: '' }; },
    async verifyLicenseState() { return true; },
    async enforceLicenseIntegrity() { return true; },
    async isPremiumVerified() { return true; },
  };
})();
