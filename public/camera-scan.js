/* OncoScan camera scanning (iPhone/iPad/Android/PC webcam). Prototype.
   Reads GS1 Data Matrix from the camera, shows a CONFIRM step, then hands the text to the existing Scan form.
   Nothing is saved until the user taps Confirm. Requires: app.js (unchanged), camera-scan.css. */
(() => {
'use strict';
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

const ENGINE_VERSION = '3.1.2';
const ENGINE_URLS = [
  'https://cdn.jsdelivr.net/npm/zxing-wasm@' + ENGINE_VERSION + '/+esm',
  'https://cdn.jsdelivr.net/npm/zxing-wasm@' + ENGINE_VERSION + '/reader/+esm'
];
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

const link = el('link'); link.rel = 'stylesheet'; link.href = '/camera-scan.css'; document.head.append(link);

// ---------- Feedback: haptic (iOS switch trick up to iOS 26.4; Android vibrate), beep, visual flash ----------
const haptic = (() => {
  let label = null;
  function ensure() {
    if (label) return;
    const input = document.createElement('input');
    input.type = 'checkbox'; input.setAttribute('switch', ''); input.id = 'cs-haptic'; input.className = 'cs-haptic';
    input.tabIndex = -1; input.setAttribute('aria-hidden', 'true');
    label = document.createElement('label'); label.htmlFor = 'cs-haptic'; label.className = 'cs-haptic'; label.setAttribute('aria-hidden', 'true');
    document.body.append(input, label);
  }
  const pulse = () => { if (typeof navigator.vibrate === 'function') return false; ensure(); label.click(); return true; };
  return kind => {
    const pattern = kind === 'success' ? [0, 90] : kind === 'error' ? [0, 90, 180] : [0];
    if (typeof navigator.vibrate === 'function') { navigator.vibrate(kind === 'error' ? [60, 60, 60, 60, 60] : kind === 'success' ? [40, 40, 40] : 15); return; }
    pattern.forEach(ms => setTimeout(pulse, ms));
  };
})();
let audio = null;
function beep(freq, ms) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = freq; g.gain.value = 0.08; o.connect(g); g.connect(audio.destination);
    o.start(); o.stop(audio.currentTime + ms / 1000);
  } catch { /* sound is optional */ }
}

// ---------- Decoder engine (loaded only when first used) ----------
let engine = null;
async function loadEngine() {
  if (engine) return engine;
  let lastError;
  for (const url of ENGINE_URLS) {
    try {
      const m = await import(url);
      if (typeof m.readBarcodes === 'function') {
        // The package's default .wasm host (fastly.jsdelivr.net) is outside our CSP; use cdn.jsdelivr.net instead.
        if (typeof m.prepareZXingModule === 'function') {
          const ver = m.ZXING_WASM_VERSION || ENGINE_VERSION;
          m.prepareZXingModule({ overrides: { locateFile: (path, prefix) => {
            const k = path.match(/_(.+?)\.wasm$/);
            return k ? 'https://cdn.jsdelivr.net/npm/zxing-wasm@' + ver + '/dist/' + k[1] + '/' + path : prefix + path;
          } } });
        }
        engine = m; return m;
      }
    } catch (e) { lastError = e; }
  }
  throw new Error('Scanner engine did not load (' + (lastError && lastError.message || 'unknown') + ').');
}

// ---------- Overlay ----------
let overlay, video, canvas, ctx, reticle, hint, sheet, sheetTitle, sheetBody, sheetWarn, btnConfirm, btnRescan, btnClose, flash;
let stream = null, running = false, paused = false, timer = 0, current = null, ignore = { text: '', until: 0 }, savedInputMode = '';

function build() {
  if (overlay) return;
  overlay = el('div', 'cs-overlay'); overlay.hidden = true; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-label', 'Camera scan');
  video = el('video', 'cs-video'); video.setAttribute('playsinline', ''); video.muted = true; video.autoplay = true;
  canvas = document.createElement('canvas'); ctx = canvas.getContext('2d', { willReadFrequently: true });
  reticle = el('div', 'cs-reticle'); hint = el('p', 'cs-hint', 'Hold the Data Matrix inside the square');
  flash = el('div', 'cs-flash');
  btnClose = el('button', 'cs-close', 'Close'); btnClose.type = 'button';
  sheet = el('div', 'cs-sheet'); sheet.hidden = true;
  sheetTitle = el('h2', 'cs-title'); sheetBody = el('dl', 'cs-body'); sheetWarn = el('p', 'cs-warn');
  const row = el('div', 'cs-row');
  btnConfirm = el('button', 'cs-btn cs-primary', 'Confirm & save'); btnConfirm.type = 'button';
  btnRescan = el('button', 'cs-btn', 'Rescan'); btnRescan.type = 'button';
  row.append(btnConfirm, btnRescan); sheet.append(sheetTitle, sheetBody, sheetWarn, row);
  overlay.append(video, reticle, hint, flash, btnClose, sheet); document.body.append(overlay);
  btnClose.onclick = close; btnRescan.onclick = resume; btnConfirm.onclick = () => onConfirm();
}

function actionLabel() {
  const v = document.querySelector('input[name=action]:checked');
  return v ? v.value : 'RECEIVE';
}
function addRow(label, value, mono) { const dt = el('dt', '', label), dd = el('dd', mono ? 'cs-mono' : '', value); sheetBody.append(dt, dd); }

async function open() {
  build(); beep(1, 1);
  overlay.hidden = false; document.body.classList.add('cs-open');
  const raw = $('raw'); if (raw) { savedInputMode = raw.inputMode; raw.inputMode = 'none'; }
  hint.textContent = 'Starting camera...'; sheet.hidden = true; paused = false;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    video.srcObject = stream; await video.play();
  } catch (e) {
    hint.textContent = e && e.name === 'NotAllowedError' ? 'Camera permission denied. Allow camera access for this site in Settings > Apps > Safari > Camera.' : 'Camera unavailable: ' + (e && e.message || e);
    return;
  }
  hint.textContent = 'Loading scanner...';
  try { await loadEngine(); } catch (e) { hint.textContent = e.message; return; }
  hint.textContent = 'Hold the Data Matrix inside the square';
  running = true; loop();
}

function stopCamera() {
  running = false; clearTimeout(timer);
  if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
  if (video) video.srcObject = null;
}
function close() {
  stopCamera(); if (overlay) overlay.hidden = true;
  document.body.classList.remove('cs-open');
  const raw = $('raw'); if (raw) raw.inputMode = savedInputMode || '';
  current = null;
}
function resume() {
  sheet.hidden = true; current = null; paused = false;
  ignore.until = Date.now() + 1500; hint.textContent = 'Hold the Data Matrix inside the square';
  clearTimeout(timer); loop();
}

// ---------- Decode loop ----------
async function loop() {
  if (!running || paused) return;
  try {
    if (video.readyState >= 2 && video.videoWidth) {
      const vw = video.videoWidth, vh = video.videoHeight, cw = video.clientWidth, ch = video.clientHeight;
      const scale = Math.max(cw / vw, ch / vh), box = Math.round(Math.min(cw, ch) * 0.72);
      reticle.style.width = reticle.style.height = box + 'px';
      const side = Math.min(Math.round(box / scale), vw, vh), sx = Math.round((vw - side) / 2), sy = Math.round((vh - side) / 2);
      canvas.width = canvas.height = side;
      ctx.drawImage(video, sx, sy, side, side, 0, 0, side, side);
      const found = await engine.readBarcodes(ctx.getImageData(0, 0, side, side), { formats: ['DataMatrix'], tryHarder: true, tryRotate: true, tryInvert: true, maxNumberOfSymbols: 1 });
      const hit = found.find(r => r.text && r.isValid !== false);
      if (hit && !(hit.text === ignore.text && Date.now() < ignore.until)) { await onDetect(hit.text); return; }
    }
  } catch (e) { hint.textContent = 'Scan error: ' + (e && e.message || e); }
  if (running && !paused) timer = setTimeout(loop, 60);
}

// ---------- Confirm step ----------
async function onDetect(text) {
  paused = true; current = { text, info: null, ok: false };
  ignore = { text, until: 0 }; haptic('tick'); beep(880, 70);
  flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
  sheet.hidden = false; sheetBody.replaceChildren(); sheetWarn.textContent = '';
  sheetTitle.textContent = 'Checking scan...'; btnConfirm.disabled = true; btnConfirm.textContent = 'Confirm & save';
  addRow('Raw', text.replace(/\x1d/g, '<GS>'), true);
  try {
    const r = await fetch('/api/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: text }) });
    const info = JSON.parse(await r.text());
    if (!r.ok) throw new Error(info.error || 'Scan could not be read.');
    current.info = info; sheetBody.replaceChildren();
    const act = actionLabel(), m = info.match;
    sheetTitle.textContent = act + ' this vial?';
    addRow('Medication', m ? m.description : 'Not in drug library');
    if (m) addRow('Library NDC11', m.ndc11, true);
    addRow('GTIN', String(info.gtin), true); addRow('Lot', String(info.lot), true);
    addRow('Expiration', String(info.expiration)); addRow('Serial', info.serial == null ? 'Not encoded (lot tracked)' : String(info.serial), true);
    addRow('Tracking', String(info.tracking_mode));
    const warns = [];
    if (info.expiration && info.expiration < new Date().toISOString().slice(0, 10)) warns.push('Manufacturer expiration is in the past.');
    if (m && m.archived) warns.push('Library entry is archived; new receipts are blocked.');
    sheetWarn.textContent = warns.join(' ');
    if (m) { current.ok = true; btnConfirm.disabled = false; btnConfirm.textContent = 'Confirm ' + act.toLowerCase() + ' (1 vial)'; }
    else { btnConfirm.disabled = false; btnConfirm.textContent = 'Resolve product on Scan screen'; }
  } catch (e) {
    sheetTitle.textContent = 'Could not use this scan'; sheetWarn.textContent = e.message; haptic('error');
    sheetBody.replaceChildren(); addRow('Raw', text.replace(/\x1d/g, '<GS>'), true);
    btnConfirm.disabled = true;
  }
}

async function onConfirm() {
  if (!current || !current.info) return;
  const raw = $('raw');
  if (!current.ok) { raw.value = current.text; close(); $('diagnose').click(); return; }
  btnConfirm.disabled = true; btnRescan.disabled = true; sheetTitle.textContent = 'Saving...';
  raw.value = current.text;
  $('scanForm').requestSubmit();
  const start = Date.now();
  await new Promise(res => { const t = setInterval(() => { if (!$('save').disabled || Date.now() - start > 35000) { clearInterval(t); res(); } }, 150); });
  const st = $('status'), saved = /\bsaved\b/i.test(st.textContent) && !/not confirmed/i.test(st.textContent), ok = st.classList.contains('ok');
  sheetBody.replaceChildren(); sheetWarn.textContent = '';
  sheetTitle.textContent = saved ? 'Saved' : 'Not saved';
  addRow('Result', st.textContent || '(no message)');
  if (saved) { haptic('success'); beep(1175, 90); } else { haptic('error'); beep(220, 220); }
  btnRescan.disabled = false; btnRescan.textContent = 'Scan next vial';
  btnConfirm.textContent = 'Done'; btnConfirm.disabled = false;
  btnConfirm.onclick = () => { btnConfirm.onclick = () => onConfirm(); btnRescan.onclick = resume; btnRescan.textContent = 'Rescan'; close(); };
  btnRescan.onclick = () => { btnConfirm.onclick = () => onConfirm(); btnRescan.onclick = resume; btnRescan.textContent = 'Rescan'; resume(); };
}

// ---------- Entry button on the Scan screen ----------
function install() {
  const form = $('scanForm'); if (!form || $('camBtn')) return;
  const b = el('button', 'btn primary cs-open-btn', '\u{1F4F7} Scan with camera'); b.type = 'button'; b.id = 'camBtn';
  b.addEventListener('click', open); form.before(b);
}
install();
document.addEventListener('visibilitychange', () => { if (document.hidden && overlay && !overlay.hidden) close(); });
window.addEventListener('hashchange', () => { if (overlay && !overlay.hidden) close(); });
window.addEventListener('pagehide', stopCamera);
})();
