/**
 * Unit tests for the subtitle parser (src/renderer/player/srt.js).
 * Run with: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'app', 'src', 'main', 'assets', 'www', 'player', 'srt.js'), 'utf8');

/** evaluate srt.js in a fake browser realm */
function loadParser() {
  const sandbox = { window: {}, console, TextDecoder, TextEncoder, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'srt.js' });
  return sandbox.window.PVSubtitles;
}

const PV = loadParser();

test('parses a plain SRT with CRLF + BOM', () => {
  const srt = '\uFEFF' + '1\r\n00:00:01,000 --> 00:00:02,500\r\nHello world\r\n\r\n2\r\n00:00:03,250 --> 00:00:05,000\r\nSecond <i>line</i>\r\n';
  const res = PV.parse(srt, { fileName: 'a.srt' });
  assert.equal(res.kind, 'srt');
  assert.equal(res.cues.length, 2);
  assert.equal(res.cues[0].start, 1);
  assert.equal(res.cues[0].end, 2.5);
  assert.equal(res.cues[0].text, 'Hello world');
  assert.equal(res.cues[1].text, 'Second line'); // tags stripped
});

test('parses WebVTT with cues and NOTE blocks', () => {
  const vtt = 'WEBVTT\n\nNOTE\n a comment\n\n00:00:00.500 --> 00:00:02.000\nFirst\n\n00:00:02.500 --> 00:00:04.000 align:start\nSecond\n';
  const res = PV.parse(vtt, { fileName: 'a.vtt' });
  assert.equal(res.kind, 'vtt');
  assert.equal(res.cues.length, 2);
  assert.equal(res.cues[1].text, 'Second');
});

test('parses ASS/SSA Dialogue lines', () => {
  const ass = '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello {\\i1}italic{\\i0} world\n';
  const res = PV.parse(ass, { fileName: 'a.ass' });
  assert.equal(res.kind, 'ass');
  assert.equal(res.cues.length, 1);
  assert.equal(res.cues[0].text, 'Hello italic world');
});

test('detects windows-1256 (Persian) bytes', () => {
  // "سلام" in windows-1256
  const bytes = new Uint8Array([0xd3, 0xe1, 0xc7, 0xe3]);
  const res = PV.decode(bytes);
  assert.equal(res.encoding, 'windows-1256');
  assert.match(res.text, /سلام/);
  // and with an explicit language hint it is guaranteed
  const res2 = PV.decode(bytes, { lang: 'fa' });
  assert.equal(res2.encoding, 'windows-1256');
  assert.match(res2.text, /سلام/);
});

test('decodes utf-8 and reports the encoding', () => {
  const bytes = new TextEncoder().encode('héllo سلام');
  const res = PV.decode(bytes);
  assert.equal(res.encoding, 'utf-8');
  assert.equal(res.text, 'héllo سلام');
});

test('cleanText strips formatting artefacts', () => {
  assert.equal(PV.cleanText('{\\an8}Hello\\Nworld&nbsp;!'), 'Hello\nworld !');
  assert.equal(PV.cleanText('<i>bye</i> &amp; see &#8212; you'), 'bye & see — you');
});

test('buildMap / findIndex binary search', () => {
  const cues = [
    { start: 0, end: 1, text: 'a' },
    { start: 5, end: 6, text: 'b' },
    { start: 10, end: 11, text: 'c' },
  ];
  const map = PV.buildMap(cues);
  assert.equal(map.size, 3);
  assert.equal(PV.findIndex(cues, 5.5), 1);
  assert.equal(PV.findIndex(cues, 7), -1);
  assert.equal(PV.findIndex(cues, 0.5), 0);
  assert.equal(PV.nextIndex(cues, 1), 1);
  assert.equal(PV.prevIndex(cues, 6), 1);
});

test('guessLangFromName', () => {
  assert.equal(PV.guessLangFromName('movie.fa.srt'), 'fa');
  assert.equal(PV.guessLangFromName('movie.en.srt'), 'en');
  assert.equal(PV.guessLangFromName('movie.srt'), null);
});

test('formatClock', () => {
  assert.equal(PV.formatClock(0), '00:00');
  assert.equal(PV.formatClock(65), '01:05');
  assert.equal(PV.formatClock(3725), '1:02:05');
});
