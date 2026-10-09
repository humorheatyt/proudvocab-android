import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'app/src/main/assets/www/android-bridge.js'), 'utf8');

function installBridge() {
  const requests = [];
  class HTMLAnchorElement {
    click() {}
  }
  const window = {
    AndroidBridge: {
      dispatch(id, channel, rawArgs) { requests.push({ id, channel, args: JSON.parse(rawArgs) }); },
      abort() {},
      consumeInitialFiles() { return '[]'; },
      setKeepScreenOn() {},
    },
  };
  window.top = window;
  const sandbox = {
    window,
    HTMLAnchorElement,
    TextEncoder,
    TextDecoder,
    Map,
    Promise,
    Date,
    console,
    navigator: { userAgent: 'test WebView' },
    btoa(value) { return Buffer.from(value, 'binary').toString('base64'); },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'android-bridge.js' });
  return { window, requests };
}

test('Android bridge serializes asynchronous requests and resolves responses', async () => {
  const { window, requests } = installBridge();
  const resultPromise = window.pvBridge.invoke('pv:file-info', 'pv-file://abc/movie.mp4');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].channel, 'pv:file-info');
  assert.deepEqual(requests[0].args, ['pv-file://abc/movie.mp4']);
  window.__pvAndroidResolve(requests[0].id, JSON.stringify({ ok: true, name: 'movie.mp4' }));
  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.equal(result.name, 'movie.mp4');
});

test('Android bridge queues native events delivered before a listener is ready', () => {
  const { window } = installBridge();
  window.__pvAndroidEvent('pv:open-files', JSON.stringify({ filePaths: ['pv-file://abc/movie.mp4'] }));
  let openedPath = null;
  window.pvBridge.on('pv:open-files', (payload) => { openedPath = payload.filePaths[0]; });
  assert.equal(openedPath, 'pv-file://abc/movie.mp4');
});

test('Android bridge creates safe media/local IDs and recognizes supported local files', () => {
  const { window } = installBridge();
  const file = 'pv-file://abc/movie.fa.srt';
  assert.equal(window.pvBridge.isVideoFile('pv-file://abc/episode.mp4'), true);
  assert.equal(window.pvBridge.isSubtitleFile(file), true);
  assert.equal(window.pvBridge.isVideoFile('pv-file://abc/notes.txt'), false);
  assert.match(window.pvBridge.mediaUrlFor(file), /^https:\/\/appassets\.androidplatform\.net\/media\?path=/);
  assert.match(window.pvBridge.localIdFor(file), /^pv-local:\/\/[A-Za-z0-9_-]+$/);
});
