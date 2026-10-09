/**
 * srt.js – subtitle parsing for the desktop player
 * ---------------------------------------------------------------------------
 * Understands .srt, .vtt, .ass/.ssa and MicroDVD .sub, plus the encoding
 * roulette that comes with files downloaded from the internet
 * (UTF-8 / UTF-16 / windows-1252 / -1254 / -1256 / -1251 / -1255 / GBK / …).
 *
 * Output shape (what the ProudVocab engine expects):
 *   cues : [{ i, start, end, text }]      seconds, text may contain \n
 *   map  : Map(start -> {start,end,text}) for window.__primevocab_subtitles
 */
(function (global) {
  'use strict';

  const TS = '\\d{1,2}:\\d{2}:\\d{2}[:.,]\\d{1,3}|\\d{1,2}:\\d{2}[:.,]\\d{1,3}';
  const ARROW_RE = new RegExp('^\\s*(-?)(' + TS + ')\\s*-->\\s*(-?)(' + TS + ')');
  const ASS_TIME_RE = /^(\d{1,2}):(\d{2}):(\d{2})[.](\d{2,3})$/;
  const MAX_CUE_SECONDS = 60;

  /* ------------------------------------------------------------ decoding */
  /* NOTE: order only matters for *ties* (every single-byte codec decodes any
     byte without errors). windows-1256 sits before windows-1254 because the
     audience of this app mostly deals with Persian/Arabic subtitle files, and
     decode() additionally accepts a language hint that wins outright. */
  const CANDIDATES = [
    'utf-8', 'windows-1256', 'windows-1254', 'windows-1252', 'windows-1251',
    'windows-1255', 'iso-8859-9', 'iso-8859-1', 'cp866', 'gbk', 'big5',
    'shift_jis', 'euc-kr', 'windows-874', 'windows-1250', 'windows-1253',
  ];

  const LANG_ENCODINGS = {
    fa: ['windows-1256'], ar: ['windows-1256'], ur: ['windows-1256'], ps: ['windows-1256'],
    tr: ['windows-1254', 'iso-8859-9'], az: ['windows-1254'],
    ru: ['windows-1251', 'cp866'], uk: ['windows-1251', 'cp866'], bg: ['windows-1251'],
    he: ['windows-1255'], el: ['windows-1253'],
    zh: ['gbk', 'big5'], ja: ['shift_jis'], ko: ['euc-kr'], th: ['windows-874'],
    pl: ['windows-1250'], cs: ['windows-1250'], hu: ['windows-1250'],
  };

  function scoreText(s) {
    let good = 0;
    let bad = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 0xfffd) { bad += 8; continue; }
      if (c < 9 || (c > 13 && c < 32) || c === 127) { bad += 4; continue; }
      if (c < 128) { good += 1; continue; }
      // Latin-1 supplement, Latin Extended, Greek, Cyrillic, Hebrew, Arabic,
      // CJK, Hiragana/Katakana, Hangul – all plausible subtitle content.
      if ((c >= 0x00a0 && c <= 0x024f) || (c >= 0x0370 && c <= 0x05ff) ||
          (c >= 0x0600 && c <= 0x06ff) || (c >= 0xfb50 && c <= 0xfdff) ||
          (c >= 0x2000 && c <= 0x206f) || (c >= 0x3040 && c <= 0x30ff) ||
          (c >= 0x3400 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) ||
          (c >= 0xf900 && c <= 0xfaff)) { good += 2; continue; }
      bad += 1;
    }
    return good - bad * 3;
  }

  /** bytes (Uint8Array) -> {text, encoding}; opts.lang = ISO-639-1 hint */
  function decode(bytes, opts) {
    if (!bytes || !bytes.length) return { text: '', encoding: 'utf-8' };
    // BOMs
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8-bom' };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
    }
    // strict UTF-8 first – by far the most common case
    try {
      const strict = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (strict.indexOf('\uFFFD') < 0) return { text: strict, encoding: 'utf-8' };
    } catch (e) { /* not utf-8 */ }

    let list = CANDIDATES;
    const hint = opts && opts.lang ? LANG_ENCODINGS[String(opts.lang).toLowerCase().slice(0, 2)] : null;
    if (hint) list = hint.concat(CANDIDATES.filter((c) => hint.indexOf(c) < 0));

    let best = null;
    for (const enc of list) {
      let out = '';
      try { out = new TextDecoder(enc).decode(bytes); } catch (e) { continue; }
      const s = scoreText(out);
      if (!best || s > best.score) best = { text: out, encoding: enc, score: s };
    }
    if (!best) return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' };
    return { text: best.text, encoding: best.encoding };
  }

  /* --------------------------------------------------------------- cleanup */
  function cleanText(raw) {
    let t = String(raw == null ? '' : raw);
    t = t.replace(/\uFEFF/g, '');
    t = t.replace(/\{\\[^}]*\}/g, '');                      // {\an8}{\i1}{\pos(x,y)}
    t = t.replace(/<\s*\/?\s*[a-zA-Z][^>]{0,120}>/g, '');   // <i>, </font>, <br/> …
    t = t.replace(/\\N|\\n/gi, '\n');                       // ASS hard line break
    t = t.replace(/\\h/gi, ' ');
    t = t.replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
      .replace(/&#0*(\d{1,5});/g, (m, d) => safeChar(+d))
      .replace(/&#x([0-9a-f]{1,5});/gi, (m, d) => safeChar(parseInt(d, 16)))
      .replace(/&amp;/gi, '&');
    t = t.replace(/[\u200e\u200f\u202a-\u202e]/g, '');      // bidi overrides
    t = t.replace(/\u266a{2,}/g, '\u266a');
    const lines = t.split('\n')
      .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').replace(/^\s*[-\u2013\u2014]\s+/, '').trim())
      .filter((l) => l.length > 0);
    return lines.join('\n').trim();
  }
  function safeChar(code) {
    if (!code || code > 0x10ffff) return '';
    try { return String.fromCodePoint(code); } catch { return ''; }
  }

  function parseTimestamp(s) {
    s = String(s).trim().replace(',', '.');
    const p = s.split(':').map((x) => parseFloat(x));
    if (p.some((n) => isNaN(n))) return NaN;
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    return p[0];
  }

  /* ------------------------------------------------------------- detection */
  function detectKind(text) {
    const head = text.slice(0, 600).replace(/\uFEFF/g, '');
    if (/^\s*WEBVTT/i.test(head)) return 'vtt';
    if (/\[Script Info\]|\[Events\]|\[V4\+? Styles\]/i.test(head)) return 'ass';
    if (/^\s*\{\d+\}\{\d*\}/.test(head)) return 'sub';
    if (/-->/.test(text)) return 'srt';
    return 'unknown';
  }

  /* -------------------------------------------------------------- parsers */
  function parseTimedLines(text, kind) {
    const lines = text.split(/\r\n|\r|\n|\u2028|\u2029/);
    const cues = [];
    let i = 0;
    let guard = 0;
    while (i < lines.length && guard++ < 500000) {
      const line = lines[i];
      if (kind === 'vtt' && /^\s*(NOTE|STYLE|REGION)\b/i.test(line)) {
        i++;
        while (i < lines.length && lines[i].trim() !== '') i++;
        continue;
      }
      const m = ARROW_RE.exec(line);
      if (!m) { i++; continue; }
      const signA = m[1] === '-' ? -1 : 1;
      const signB = m[3] === '-' ? -1 : 1;
      const start = signA * parseTimestamp(m[2]);
      const end = signB * parseTimestamp(m[4]);
      const body = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '' && !ARROW_RE.test(lines[i])) {
        body.push(lines[i]);
        i++;
        if (body.length > 40) break;
      }
      if (i < lines.length && lines[i].trim() === '') i++;
      const clean = cleanText(body.join('\n'));
      if (!clean) continue;
      if (isNaN(start) || isNaN(end)) continue;
      cues.push({ start: Math.max(0, start), end: Math.max(0, end), text: clean });
    }
    return cues;
  }

  function parseAss(text) {
    const lines = text.split(/\r\n|\r|\n/);
    const cues = [];
    let inEvents = false;
    let format = null;
    for (const line of lines) {
      const t = line.trim();
      if (/^\[Events\]/i.test(t)) { inEvents = true; continue; }
      if (/^\[/.test(t)) { inEvents = false; continue; }
      if (!inEvents) continue;
      if (/^Format:/i.test(t)) {
        format = t.slice(t.indexOf(':') + 1).split(',').map((s) => s.trim().toLowerCase());
        continue;
      }
      if (!/^Dialogue:/i.test(t)) continue;
      const rest = t.slice(t.indexOf(':') + 1);
      const fields = rest.split(',');
      const f = format || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
      const si = Math.max(0, f.indexOf('start'));
      const ei = Math.max(1, f.indexOf('end'));
      const ti = f.indexOf('text');
      const start = parseAssTime(fields[si]);
      const end = parseAssTime(fields[ei]);
      const body = ti >= 0 ? fields.slice(ti).join(',') : fields.slice(9).join(',');
      const clean = cleanText(body);
      if (!clean || isNaN(start) || isNaN(end)) continue;
      cues.push({ start: Math.max(0, start), end: Math.max(0, end), text: clean });
    }
    return cues;
  }
  function parseAssTime(s) {
    const m = ASS_TIME_RE.exec(String(s || '').trim());
    if (!m) return NaN;
    const ms = String(m[4]).length === 2 ? Number(m[4]) * 10 : Number(m[4]);
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000;
  }

  function parseMicroDvd(text, fps) {
    const rate = fps && fps > 1 ? fps : 23.976;
    const cues = [];
    for (const line of text.split(/\r\n|\r|\n/)) {
      const m = /^\{(\d+)\}\{(\d*)\}(.*)$/.exec(line);
      if (!m) continue;
      const start = Number(m[1]) / rate;
      let end = m[2] ? Number(m[2]) / rate : start + 2;
      const clean = cleanText(m[3].replace(/\|/g, '\n'));
      if (!clean) continue;
      cues.push({ start, end, text: clean });
    }
    return cues;
  }

  /* ---------------------------------------------------------------- normalise */
  function normalise(cues) {
    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    const out = [];
    for (let k = 0; k < cues.length; k++) {
      const c = cues[k];
      let end = c.end;
      if (!(end > c.start)) {
        const next = cues[k + 1];
        end = next ? Math.min(next.start, c.start + 3) : c.start + 2;
        if (!(end > c.start)) end = c.start + 1.5;
      }
      if (end - c.start > MAX_CUE_SECONDS) end = c.start + MAX_CUE_SECONDS;
      const prev = out[out.length - 1];
      if (prev && prev.text === c.text && c.start - prev.end < 0.35 && c.start >= prev.start) {
        // rolling/duplicated caption – extend instead of re-rendering
        prev.end = Math.max(prev.end, end);
        continue;
      }
      out.push({ i: out.length, start: c.start, end, text: c.text });
    }
    out.forEach((c, n) => { c.i = n; });
    return out;
  }

  /**
   * @param {string} text  decoded subtitle file content
   * @param {{fps?:number, fileName?:string}} [opts]
   */
  function parse(text, opts) {
    const o = opts || {};
    const warnings = [];
    const stripped = String(text || '').replace(/^\uFEFF/, '');
    let kind = detectKind(stripped);
    if (o.fileName) {
      const ext = /\.([a-z0-9]+)$/i.exec(o.fileName);
      if (ext) {
        const e = ext[1].toLowerCase();
        if (e === 'vtt' && kind !== 'vtt') kind = 'vtt';
        if ((e === 'ass' || e === 'ssa') && kind !== 'ass') kind = 'ass';
        if (e === 'sub' && kind === 'unknown') kind = 'sub';
      }
    }
    let cues = [];
    if (kind === 'ass') cues = parseAss(stripped);
    else if (kind === 'sub') cues = parseMicroDvd(stripped, o.fps);
    else if (kind === 'srt' || kind === 'vtt' || kind === 'unknown') {
      cues = parseTimedLines(stripped, kind === 'vtt' ? 'vtt' : 'srt');
      if (kind === 'unknown') warnings.push('Format not recognised – parsed as SRT.');
    }
    cues = normalise(cues);
    if (!cues.length) warnings.push('No cues could be parsed from this file.');
    return { kind, cues, warnings };
  }

  /** Map(startSeconds -> {start,end,text}) – the shape __primevocab_subtitles uses. */
  function buildMap(cues) {
    const m = new Map();
    for (const c of cues) m.set(Number(c.start.toFixed(3)), { start: c.start, end: c.end, text: c.text });
    return m;
  }

  /** binary search – index of the cue active at t, or -1 */
  function findIndex(cues, t) {
    if (!cues || !cues.length) return -1;
    let lo = 0;
    let hi = cues.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (found < 0) return -1;
    return t <= cues[found].end ? found : -1;
  }

  /** index of the cue that starts next after t (for the "next line" button) */
  function nextIndex(cues, t) {
    if (!cues || !cues.length) return -1;
    for (let i = 0; i < cues.length; i++) if (cues[i].start > t + 0.05) return i;
    return -1;
  }
  function prevIndex(cues, t) {
    if (!cues || !cues.length) return -1;
    let best = -1;
    for (let i = 0; i < cues.length; i++) {
      if (cues[i].start < t - 0.35) best = i; else break;
    }
    return best;
  }

  function formatClock(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  /** Guess the language of a subtitle file from its name (…​.en.srt / [fa] …) */
  function guessLangFromName(name) {
    const n = String(name || '').toLowerCase();
    const known = ['en', 'fa', 'tr', 'de', 'fr', 'es', 'it', 'ru', 'pt', 'ar', 'zh', 'ja', 'ko', 'nl', 'pl', 'sv', 'uk', 'hi'];
    let m = /[. _-]([a-z]{2})(?:[. _-]|$)/.exec(n.replace(/\.(srt|vtt|ass|ssa|sub)$/i, ''));
    if (m && known.indexOf(m[1]) >= 0) return m[1];
    m = /\[([a-z]{2})\]/.exec(n);
    if (m && known.indexOf(m[1]) >= 0) return m[1];
    if (/(persian|farsi|فارسی|فارسي)/.test(n)) return 'fa';
    if (/(english|انگلیسی)/.test(n)) return 'en';
    return null;
  }

  global.PVSubtitles = {
    decode, parse, buildMap, findIndex, nextIndex, prevIndex,
    formatClock, detectKind, cleanText, guessLangFromName, parseTimestamp,
  };
})(typeof window !== 'undefined' ? window : globalThis);
