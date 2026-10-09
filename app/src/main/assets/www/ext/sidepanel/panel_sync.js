/* Android local-only build: the browser-extension Google Drive OAuth service is
 * deliberately not packaged. This keeps the app offline-capable and avoids
 * shipping a server-side licence/sync client in the Android WebView. */
(function installAndroidSyncStubs() {
  'use strict';

  const unavailable = () => ({ success: false, reason: 'unavailable_on_android' });

  globalThis.performGoogleDriveSync = async function performGoogleDriveSync() {
    return unavailable();
  };
  globalThis.connectGoogleAccount = async function connectGoogleAccount() {
    throw new Error('Google Drive sync is not available in the Android build.');
  };
  globalThis.triggerGoogleLogin = globalThis.connectGoogleAccount;
  globalThis.getGoogleAuthToken = async function getGoogleAuthToken() {
    throw new Error('Google Drive sync is not available in the Android build.');
  };
  globalThis.getGoogleUserInfo = async function getGoogleUserInfo() { return null; };
  globalThis.clearGoogleAuthToken = async function clearGoogleAuthToken() { return true; };
})();
