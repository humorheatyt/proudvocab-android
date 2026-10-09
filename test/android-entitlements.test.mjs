import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiClientSource = fs.readFileSync(
  path.join(root, 'app/src/main/assets/www/ext/sidepanel/apiClient.js'),
  'utf8',
);
const syncSource = fs.readFileSync(
  path.join(root, 'app/src/main/assets/www/ext/sidepanel/panel_sync.js'),
  'utf8',
);

test('Android entitlements are local, fully enabled, and do not call a licence endpoint', async () => {
  const stored = {};
  const sandbox = {
    console,
    Date,
    chrome: {
      storage: {
        local: {
          set(values, callback) {
            Object.assign(stored, values);
            if (callback) callback();
          },
        },
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(apiClientSource, sandbox, { filename: 'android-api-client.js' });

  assert.equal(await sandbox.PV_ApiClient.isPremiumVerified(), true);
  assert.equal(await sandbox.PV_ApiClient.verifyLicenseState(), true);
  assert.equal(await sandbox.PV_ApiClient.enforceLicenseIntegrity(), true);
  assert.equal(stored.isPremium, true);
  assert.equal(stored.licenseType, 'LIFETIME');
  assert.equal(stored.googleSyncEnabled, false);
  assert.equal(/https?:\/\//i.test(apiClientSource), false);
});

test('Android cloud-sync stub makes no OAuth or remote requests', async () => {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(syncSource, sandbox, { filename: 'android-sync-stub.js' });
  const result = await sandbox.performGoogleDriveSync(false);
  assert.equal(result.success, false);
  assert.equal(result.reason, 'unavailable_on_android');
  assert.equal(/https?:\/\//i.test(syncSource), false);
});

test('Android project targets API 28+ and requests no broad media/storage permission', () => {
  const gradle = fs.readFileSync(path.join(root, 'app/build.gradle.kts'), 'utf8');
  const manifest = fs.readFileSync(path.join(root, 'app/src/main/AndroidManifest.xml'), 'utf8');
  assert.match(gradle, /minSdk\s*=\s*28/);
  assert.match(gradle, /targetSdk\s*=\s*35/);
  assert.match(manifest, /android\.permission\.INTERNET/);
  assert.doesNotMatch(manifest, /READ_EXTERNAL_STORAGE|READ_MEDIA_VIDEO|WRITE_EXTERNAL_STORAGE/);
  assert.match(manifest, /android\.intent\.action\.VIEW/);
});
