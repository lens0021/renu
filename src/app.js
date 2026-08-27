import { PitchDetector } from './pitch.js';
import { HistoryChart } from './chart.js';
import { freqToMidi, noteLabel, splitNote } from './notes.js';
import {
  loadSingers, saveSingers, loadShowGuides, saveShowGuides,
  loadClampId, saveClampId, loadView, saveView, newId, colorFor,
  loadSensitivity, saveSensitivity, DEFAULT_SENSITIVITY,
} from './store.js';

/* ------------------------------------------------------------------ 상수 */

// 화면에 그리는 사람 음역. C2 – C6 은 최저 베이스부터 최고 소프라노까지 덮는다.
const RANGE_LOW = 36;   // C2
const RANGE_HIGH = 84;  // C6
const PAD = 0.5;

// 새로 만드는 음역대의 출발점. 여기서 반음씩 올리고 내려 맞춘다.
const NEW_LOW = 48;     // C3
const NEW_HIGH = 72;    // C5

// 검출기는 더 넓게 본다. 3 kHz 까지 열어두면 고음 잡음의 정수분의 1 을 사람 음역 안의
// 음으로 착각하는 일이 없어진다. 잡은 뒤 음역 밖은 버린다.
const DETECT_MIN = 55;
const DETECT_MAX = 3000;

const BUFFER_SIZE = 8192;   // 48 kHz 기준 약 170 ms
const UPDATE_MS = 50;       // 초당 20 회
const HISTORY_SECONDS = 8;
const IDLE_MS = 350;        // 이만큼 못 잡으면 표시를 비운다
const HOLD_MS = 200;        // 이만큼 유지된 음만 음역대로 인정한다.
                            // 분석 창(약 170 ms)과 스무딩 지연이 앞에 더 붙으므로,
                            // 실제로는 0.5 초쯤 낸 음이 기록된다.
const IN_TUNE_CENTS = 10;

// 소리를 음으로 인정하는 문턱 두 개를 감도 하나로 함께 움직인다. 감도 0 은 둔감해서 큰
// 소리만, 100 은 예민해서 작게 불러도 잡는다. 기본값 50 이 예전에 상수로 박혀 있던
// 0.003 / 0.75 를 그대로 만들어 낸다. 크기는 로그로, 명료도는 선형으로 나눈다.
const RMS_AT_DULL = 0.02;      // 감도 0   · 약 -34 dBFS
const RMS_AT_KEEN = 0.00045;   // 감도 100 · 약 -67 dBFS
const CLARITY_AT_DULL = 0.90;
const CLARITY_AT_KEEN = 0.60;

// 입력 크기 막대가 덮는 범위(dBFS)
const METER_MIN_DB = -72;
const METER_MAX_DB = -12;

// 성악에서 흔히 쓰는 성종별 범위를 합친 값이다.
// 남성 = 베이스 E2 부터 테너 C5 까지, 여성 = 콘트랄토 F3 부터 소프라노 C6 까지.
const GUIDES = [
  { label: '남성 일반', low: 40, high: 72, color: '#6aa6ff' },
  { label: '여성 일반', low: 53, high: 84, color: '#ff7fa8' },
];

/* ------------------------------------------------------------ 스무딩 */

/**
 * 아웃라이어를 걸러내는 이동평균. Tuner 의 OutlierRemovingSmoother 와 같은 발상이다.
 *
 * 튀는 값 하나에 표시가 흔들리면 안 되지만, 정말로 다른 음으로 옮겨갔을 때는 바로
 * 따라가야 한다. 그래서 본 버퍼와 후보 버퍼를 따로 둔다. 벗어난 값은 후보에 쌓이고,
 * 후보끼리 일관되게 몇 개 모이면 그쪽으로 통째로 갈아탄다.
 */
class Smoother {
  constructor({ size = 5, tolerance = 0.6, swapAfter = 3 } = {}) {
    this.size = size;
    this.tolerance = tolerance;
    this.swapAfter = swapAfter;
    this.main = [];
    this.candidate = [];
  }

  reset() {
    this.main.length = 0;
    this.candidate.length = 0;
  }

  push(value) {
    if (this.main.length === 0) {
      this.main.push(value);
      return value;
    }

    const mean = average(this.main);
    if (Math.abs(value - mean) <= this.tolerance) {
      this.main.push(value);
      if (this.main.length > this.size) this.main.shift();
      this.candidate.length = 0;
      return average(this.main);
    }

    const candidateMean = this.candidate.length ? average(this.candidate) : value;
    if (Math.abs(value - candidateMean) <= this.tolerance) this.candidate.push(value);
    else this.candidate = [value];

    if (this.candidate.length >= this.swapAfter) {
      this.main = this.candidate;
      this.candidate = [];
      return average(this.main);
    }
    return average(this.main);
  }
}

function average(list) {
  let sum = 0;
  for (const v of list) sum += v;
  return sum / list.length;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const el = (id) => document.getElementById(id);

const rmsMinFor = (sens) => RMS_AT_DULL * Math.pow(RMS_AT_KEEN / RMS_AT_DULL, sens / 100);
const clarityMinFor = (sens) => CLARITY_AT_DULL + (CLARITY_AT_KEEN - CLARITY_AT_DULL) * (sens / 100);

const dbOf = (rms) => 20 * Math.log10(Math.max(rms, 1e-9));
/** dBFS 를 막대 위의 0..100 % 위치로. */
const meterPct = (rms) =>
  clamp((dbOf(rms) - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB), 0, 1) * 100;

/* --------------------------------------------------------------- 상태 */

const dom = {
  gate: el('gate'), startBtn: el('startBtn'), gateHint: el('gateHint'),
  installBtn: el('installBtn'), installChip: el('installChip'),
  app: el('app'), micBtn: el('micBtn'), micLabel: el('micLabel'),
  lockBadge: el('lockBadge'), editBtn: el('editBtn'), sensBtn: el('sensBtn'),
  noteBig: el('noteBig'), noteName: el('noteName'), noteOct: el('noteOct'),
  centsBar: el('centsBar'), centsText: el('centsText'), freqText: el('freqText'),
  history: el('history'), legend: el('legend'),
  sheet: el('sheet'), sheetTitle: el('sheetTitle'), fName: el('fName'),
  fLow: el('fLow'), fHigh: el('fHigh'), fGuides: el('fGuides'), fClamp: el('fClamp'),
  saveBtn: el('saveBtn'), deleteBtn: el('deleteBtn'),
  newBtn: el('newBtn'), savedList: el('savedList'), sortHint: el('sortHint'),
  sensSection: el('sensSection'), fSens: el('fSens'), sensValue: el('sensValue'),
  sensThresh: el('sensThresh'), levelBar: el('levelBar'), levelMark: el('levelMark'),
  levelText: el('levelText'),
};

let audioCtx = null;
let analyser = null;
let stream = null;
let detector = null;
let sampleBuffer = null;
let chart = null;
let rafId = 0;
let lastUpdate = 0;
let listening = false;

let wakeLock = null;
let installPrompt = null;

const smoother = new Smoother();
let sensitivity = loadSensitivity();
const gate = { rms: rmsMinFor(sensitivity), clarity: clarityMinFor(sensitivity) };
let inputLevel = 0;         // 표시용으로 다듬은 입력 크기(RMS)
let lastGoodAt = 0;
let heldNote = null;
let heldSince = 0;
let displayedNote = null;   // 화면에 찍힌 반올림 MIDI. 불필요한 DOM 갱신을 막는다

let singers = loadSingers();
let showGuides = loadShowGuides();
let clampId = loadClampId();
let currentRange = { low: null, high: null };   // 이번에 켜 둔 동안 실제로 낸 음역

let editing = null;

/* --------------------------------------------------------------- 오디오 */

async function start() {
  dom.startBtn.disabled = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // 튜너에는 방해만 되는 처리들이다. 자동 게인은 음량을, 잡음 억제는 배음을 흔든다.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
  } catch (err) {
    dom.startBtn.disabled = false;
    dom.gateHint.classList.add('error');
    dom.gateHint.textContent =
      err && err.name === 'NotAllowedError'
        ? '마이크 권한이 거부됐습니다. 브라우저 설정에서 허용한 뒤 다시 시도해주세요.'
        : '마이크를 열 수 없습니다: ' + (err && err.message ? err.message : err);
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = BUFFER_SIZE;
  analyser.smoothingTimeConstant = 0;
  audioCtx.createMediaStreamSource(stream).connect(analyser);

  detector = new PitchDetector(audioCtx.sampleRate, {
    fmin: DETECT_MIN,
    fmax: DETECT_MAX,
    bufferSize: BUFFER_SIZE,
    clarityThreshold: gate.clarity,
  });
  sampleBuffer = new Float32Array(BUFFER_SIZE);

  dom.gate.hidden = true;
  dom.app.hidden = false;

  chart = new HistoryChart(dom.history, {
    low: RANGE_LOW,
    high: RANGE_HIGH,
    seconds: HISTORY_SECONDS,
    updateMs: UPDATE_MS,
  });
  const savedView = loadView();
  if (savedView) chart.setView(savedView);

  refreshChartData();
  renderLegend();
  // 첫 레이아웃이 끝난 뒤 한 번 더 재보정한다. 생성 시점에는 크기가 0 일 수 있다.
  requestAnimationFrame(() => { chart.resize(); chart.draw(); });

  setListening(true);
  requestWakeLock();
}

function setListening(on) {
  listening = on;
  dom.micBtn.setAttribute('aria-pressed', String(on));
  dom.micLabel.textContent = on ? '듣는 중' : '멈춤';

  if (on) {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    if (!rafId) rafId = requestAnimationFrame(loop);
    requestWakeLock();
  } else {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (audioCtx && audioCtx.state === 'running') audioCtx.suspend();
    smoother.reset();
    updateLevel(0);
    showIdle();
    releaseWakeLock();
  }
}

function loop(timestamp) {
  rafId = requestAnimationFrame(loop);
  if (timestamp - lastUpdate < UPDATE_MS) return;
  lastUpdate = timestamp;

  analyser.getFloatTimeDomainData(sampleBuffer);
  const result = detector.detect(sampleBuffer);

  let midi = null;
  updateLevel(result ? result.rms : 0);

  if (result && result.freq > 0 && result.clarity >= gate.clarity && result.rms >= gate.rms) {
    const raw = freqToMidi(result.freq);
    // 사람 음역 밖은 들려도 무시한다. 기준 음역대를 정해 뒀으면 그 밖도 소음으로 본다.
    const limit = clampRange();
    const low = limit ? Math.max(RANGE_LOW, limit.low) : RANGE_LOW;
    const high = limit ? Math.min(RANGE_HIGH, limit.high) : RANGE_HIGH;
    if (raw >= low - PAD && raw <= high + PAD) midi = raw;
  }

  const now = performance.now();
  if (midi === null) {
    // 소리가 없어도 시간은 흘러야 하므로 빈 값을 밀어 넣는다.
    chart.push(null);
    if (now - lastGoodAt > IDLE_MS) {
      smoother.reset();
      heldNote = null;
      showIdle();
    }
  } else {
    lastGoodAt = now;
    const smoothed = smoother.push(midi);
    chart.push(smoothed);
    showNote(smoothed, result.freq);
    trackHold(smoothed, now);
  }

  chart.draw();
}

/** 같은 음을 HOLD_MS 넘게 유지하면 실제로 낸 음으로 인정한다. */
function trackHold(smoothed, now) {
  const note = Math.round(smoothed);
  if (note !== heldNote) {
    heldNote = note;
    heldSince = now;
    return;
  }
  if (now - heldSince < HOLD_MS) return;
  heldSince = Infinity; // 한 번 인정한 음은 다른 음으로 옮겨가기 전까지 다시 발화하지 않는다
  onNoteAchieved(note);
}

function onNoteAchieved(note) {
  let changed = false;
  if (currentRange.low === null || note < currentRange.low) { currentRange.low = note; changed = true; }
  if (currentRange.high === null || note > currentRange.high) { currentRange.high = note; changed = true; }
  if (changed) {
    refreshChartData();
    renderLegend();
  }
}

/* --------------------------------------------------------------- 감도 */

/**
 * 감도를 적용한다. 실행 중에 불러도 되고, 다음 프레임부터 바로 새 문턱이 쓰인다.
 * 검출기 안쪽 문턱도 같이 옮긴다. 거기서 먼저 버려지면 앱 쪽 검사는 볼 기회조차 없다.
 */
function applySensitivity(value, { persist = true } = {}) {
  sensitivity = clamp(Math.round(value), 0, 100);
  gate.rms = rmsMinFor(sensitivity);
  gate.clarity = clarityMinFor(sensitivity);
  if (detector) detector.clarityThreshold = gate.clarity;
  if (persist) saveSensitivity(sensitivity);
  renderSensitivity();
}

function renderSensitivity() {
  if (dom.fSens.value !== String(sensitivity)) dom.fSens.value = String(sensitivity);
  dom.sensValue.textContent = String(sensitivity);
  // 기본값에서 벗어나 있을 때만 머리말 칩에 숫자를 붙인다. 손댄 적이 있다는 표시다.
  // 좁은 화면에서는 이 숫자를 CSS 가 감춘다. 값은 정수로 잘라 둔 상태라 그대로 넣어도 된다.
  dom.sensBtn.innerHTML =
    sensitivity === DEFAULT_SENSITIVITY ? '감도' : `감도<span class="num">${sensitivity}</span>`;
  dom.sensThresh.textContent = `문턱 ${Math.round(dbOf(gate.rms))} dB`;
  dom.levelMark.style.left = meterPct(gate.rms) + '%';
  renderLevel();
}

/** 올라갈 때는 그대로, 내려갈 때는 천천히. 순간적인 세기를 눈으로 따라갈 수 있게 한다. */
function updateLevel(rms) {
  inputLevel = rms > inputLevel ? rms : inputLevel * 0.82 + rms * 0.18;
  if (!dom.sheet.hidden) renderLevel();
}

function renderLevel() {
  dom.levelBar.style.width = meterPct(inputLevel) + '%';
  dom.levelBar.classList.toggle('over', inputLevel >= gate.rms);
  dom.levelText.textContent =
    inputLevel > 1e-5 ? `지금 ${Math.round(dbOf(inputLevel))} dB` : '지금 —';
}

/* ------------------------------------------------------------ 화면 표시 */

function showIdle() {
  if (displayedNote === null) return;
  displayedNote = null;
  dom.noteBig.classList.add('idle');
  dom.noteName.textContent = '–';
  dom.noteOct.textContent = '';
  dom.centsText.textContent = '—';
  dom.freqText.textContent = '—';
  dom.centsBar.style.width = '0';
}

function showNote(midi, freq) {
  const note = Math.round(midi);
  const cents = (midi - note) * 100;

  if (note !== displayedNote) {
    displayedNote = note;
    const { name, octave } = splitNote(note);
    dom.noteBig.classList.remove('idle');
    dom.noteName.textContent = name;
    dom.noteOct.textContent = String(octave);
  }

  const rounded = Math.round(cents);
  dom.centsText.textContent = (rounded > 0 ? '+' : '') + rounded + '¢';
  dom.centsBar.style.width = Math.min(50, Math.abs(cents)) + '%';
  dom.centsBar.style.left = (cents >= 0 ? 50 : 50 - Math.min(50, Math.abs(cents))) + '%';
  dom.centsBar.className =
    Math.abs(cents) <= IN_TUNE_CENTS ? '' : cents < 0 ? 'flat' : 'sharp';
  dom.freqText.textContent = freq.toFixed(1) + ' Hz';
}

/** 오른쪽 레일과 범례에 함께 쓰는 목록. 맨 앞이 지금 내고 있는 음역이다. */
function chartEntries() {
  return [
    { id: '__current__', name: '현재', low: currentRange.low, high: currentRange.high, color: '#35d39a' },
    ...singers.map((s, i) => ({ ...s, color: colorFor(i) })),
  ];
}

function clampRange() {
  return clampId ? singers.find((s) => s.id === clampId) || null : null;
}

function refreshChartData() {
  if (!chart) return;
  chart.setEntries(chartEntries());
  chart.setGuides(showGuides ? GUIDES : []);
  chart.setClamp(clampRange());
  chart.draw();
}

function renderLegend() {
  dom.legend.innerHTML = chartEntries().map((entry) => {
    const range = entry.low === null
      ? '아직 없음'
      : `${noteLabel(entry.low)} – ${noteLabel(entry.high)}`;
    const action = entry.id === '__current__'
      ? 'data-reset-current'
      : `data-edit="${entry.id}"`;
    const suffix = entry.id === '__current__'
      ? (entry.low !== null ? ' ↺' : '')
      : (entry.id === clampId ? ' · 기준' : '');
    return `<button ${action}>
      <span class="swatch" style="background:${entry.color}"></span>
      <span>${escapeHtml(entry.name)}</span>
      <span class="rg">${range}${suffix}</span>
    </button>`;
  }).join('');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* --------------------------------------------------------------- 편집 */

function openSheet(entry, { scrollTo = null } = {}) {
  editing = entry
    ? { id: entry.id, name: entry.name, low: entry.low, high: entry.high }
    : { id: null, name: '', low: NEW_LOW, high: NEW_HIGH };
  dom.sheet.hidden = false;
  renderEditor();
  renderSensitivity();
  renderSavedList();
  if (scrollTo === 'sens') {
    // 시트가 열린 뒤에 옮겨야 스크롤 위치가 잡힌다.
    requestAnimationFrame(() => dom.sensSection.scrollIntoView({ block: 'start' }));
  }
}

function closeSheet() {
  dom.sheet.hidden = true;
  editing = null;
}

function renderEditor() {
  if (!editing) return;
  dom.sheetTitle.textContent = editing.id ? '음역대 편집' : '음역대 추가';
  if (dom.fName.value !== editing.name) dom.fName.value = editing.name;
  dom.fLow.textContent = noteLabel(editing.low);
  dom.fHigh.textContent = noteLabel(editing.high);
  dom.deleteBtn.hidden = !editing.id;
  dom.fGuides.checked = showGuides;
  dom.fClamp.checked = !!editing.id && clampId === editing.id;
}

const HANDLE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9h12M6 15h12"/></svg>';

function renderSavedList() {
  // 하나뿐이면 옮길 데가 없으니 손잡이도 내보내지 않는다.
  const sortable = singers.length > 1;
  dom.sortHint.hidden = !sortable;

  if (singers.length === 0) {
    dom.savedList.innerHTML = '<li class="empty">아직 저장된 음역대가 없습니다.</li>';
    return;
  }
  dom.savedList.innerHTML = singers.map((s, i) => `
    <li data-id="${s.id}">
      <button class="row" data-edit="${s.id}">
        <span class="swatch" style="background:${colorFor(i)}"></span>
        <span class="nm">${escapeHtml(s.name)}</span>
        <span class="rg">${noteLabel(s.low)} – ${noteLabel(s.high)}</span>
      </button>
      ${sortable ? `<button class="handle" data-handle="${s.id}"
        aria-label="${escapeHtml(s.name)} 순서 바꾸기">${HANDLE_ICON}</button>` : ''}
    </li>`).join('');
}

/* ---------------------------------------------------- 저장 목록 순서 바꾸기 */

/*
 * 손잡이를 끌어 순서를 바꾼다. HTML5 드래그는 터치에서 아예 동작하지 않으므로
 * 포인터 이벤트로 직접 옮긴다. 끄는 동안 실제 목록은 건드리지 않고 transform 으로만
 * 밀어 두었다가, 손을 뗄 때 한 번 적용한다.
 */
const reorder = { id: null, pointerId: null, from: -1, to: -1, startY: 0, rows: [] };

function beginReorder(handle, event) {
  const li = handle.closest('li');
  const from = singers.findIndex((s) => s.id === li.dataset.id);
  if (from < 0) return;

  const rows = [...dom.savedList.children].map((element) => {
    const rect = element.getBoundingClientRect();
    return { element, center: rect.top + rect.height / 2, height: rect.height };
  });

  try { handle.setPointerCapture(event.pointerId); } catch { /* 무시 */ }
  reorder.id = li.dataset.id;
  reorder.pointerId = event.pointerId;
  reorder.from = from;
  reorder.to = from;
  reorder.startY = event.clientY;
  reorder.rows = rows;
  li.classList.add('dragging');
}

function moveReorder(clientY) {
  const { rows, from } = reorder;
  const offset = clientY - reorder.startY;
  rows[from].element.style.transform = `translateY(${offset}px)`;

  // 끌고 있는 줄의 한가운데보다 위에 있는 줄의 수가 곧 새 자리다.
  const center = rows[from].center + offset;
  let to = 0;
  rows.forEach((row, k) => { if (k !== from && center > row.center) to++; });
  if (to === reorder.to) return;

  reorder.to = to;
  const height = rows[from].height;
  rows.forEach((row, k) => {
    if (k === from) return;
    let shift = 0;
    if (k < from && k >= to) shift = height;
    else if (k > from && k <= to) shift = -height;
    row.element.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}

function endReorder(commit) {
  if (reorder.id === null) return;
  const { from, to } = reorder;
  for (const row of reorder.rows) {
    row.element.style.transform = '';
    row.element.classList.remove('dragging');
  }
  reorder.id = null;
  reorder.pointerId = null;
  reorder.rows = [];
  if (commit && to !== from) moveSinger(from, to);
  else renderSavedList();
}

function moveSinger(from, to) {
  const target = clamp(to, 0, singers.length - 1);
  if (from === target) return;
  const [moved] = singers.splice(from, 1);
  singers.splice(target, 0, moved);
  saveSingers(singers);
  refreshChartData();   // 순서가 곧 차트 막대 자리와 색이다
  renderLegend();
  renderSavedList();
}

function stepNote(which, delta) {
  if (!editing || delta === 0) return;
  const next = clamp(editing[which] + delta, RANGE_LOW, RANGE_HIGH);
  editing[which] = next;
  if (editing.low > editing.high) {
    if (which === 'low') editing.high = next;
    else editing.low = next;
  }
  renderEditor();
}

function saveEditing() {
  if (!editing) return;
  const name = dom.fName.value.trim();
  if (!name) {
    dom.fName.focus();
    dom.fName.placeholder = '이름을 적어주세요';
    return;
  }
  const record = {
    id: editing.id || newId(),
    name,
    low: Math.min(editing.low, editing.high),
    high: Math.max(editing.low, editing.high),
  };
  const index = singers.findIndex((s) => s.id === record.id);
  if (index >= 0) singers[index] = record;
  else singers.push(record);

  if (dom.fClamp.checked) clampId = record.id;
  else if (clampId === record.id) clampId = null;
  saveClampId(clampId);

  saveSingers(singers);
  refreshChartData();
  renderLegend();
  closeSheet();
}

function deleteEditing() {
  if (!editing || !editing.id) return;
  if (clampId === editing.id) {
    clampId = null;
    saveClampId(null);
  }
  singers = singers.filter((s) => s.id !== editing.id);
  saveSingers(singers);
  refreshChartData();
  renderLegend();
  closeSheet();
}

/* ------------------------------------------------------------ 화면 유지 */

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock || !listening) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    dom.lockBadge.hidden = false;
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
      dom.lockBadge.hidden = true;
    });
  } catch {
    // 절전 모드 등에서 거부될 수 있다. 앱 동작 자체에는 지장이 없다.
    dom.lockBadge.hidden = true;
  }
}

function releaseWakeLock() {
  if (!wakeLock) return;
  wakeLock.release().catch(() => {});
  wakeLock = null;
  dom.lockBadge.hidden = true;
}

/* --------------------------------------------------------------- 배선 */

dom.startBtn.addEventListener('click', start);
dom.micBtn.addEventListener('click', () => setListening(!listening));
dom.editBtn.addEventListener('click', () => openSheet(null));
dom.sensBtn.addEventListener('click', () => openSheet(null, { scrollTo: 'sens' }));
dom.newBtn.addEventListener('click', () => openSheet(null));
dom.saveBtn.addEventListener('click', saveEditing);
dom.deleteBtn.addEventListener('click', deleteEditing);

dom.fName.addEventListener('input', () => {
  if (editing) editing.name = dom.fName.value;
});

dom.fClamp.addEventListener('change', () => {
  if (!editing || !editing.id) return; // 새 항목은 저장할 때 함께 적용된다
  clampId = dom.fClamp.checked ? editing.id : null;
  saveClampId(clampId);
  refreshChartData();
  renderLegend();
});

// 끄는 동안 계속 반영하되, 저장은 손을 뗄 때 한 번만 한다.
dom.fSens.addEventListener('input', () => {
  applySensitivity(Number(dom.fSens.value), { persist: false });
});
dom.fSens.addEventListener('change', () => {
  applySensitivity(Number(dom.fSens.value));
});

dom.fGuides.addEventListener('change', () => {
  showGuides = dom.fGuides.checked;
  saveShowGuides(showGuides);
  refreshChartData();
});

dom.sheet.addEventListener('click', (event) => {
  const target = event.target.closest('[data-close], [data-step], [data-edit]');
  if (!target) return;

  if (target.hasAttribute('data-close')) return closeSheet();

  if (target.dataset.step) {
    const [which, delta] = target.dataset.step.split(':');
    return stepNote(which, Number(delta));
  }

  if (target.dataset.edit) {
    const entry = singers.find((s) => s.id === target.dataset.edit);
    if (entry) openSheet(entry);
  }
});

dom.savedList.addEventListener('pointerdown', (event) => {
  const handle = event.target.closest('[data-handle]');
  if (!handle || reorder.id !== null) return;
  event.preventDefault();   // 손잡이에서는 길게 누르기·선택이 끼어들지 않게 한다
  beginReorder(handle, event);
});

dom.savedList.addEventListener('pointermove', (event) => {
  if (reorder.pointerId !== event.pointerId) return;
  event.preventDefault();
  moveReorder(event.clientY);
});

for (const type of ['pointerup', 'pointercancel']) {
  dom.savedList.addEventListener(type, (event) => {
    if (reorder.pointerId !== event.pointerId) return;
    endReorder(type === 'pointerup');
  });
  // 포인터를 붙잡지 못한 브라우저에서 목록 밖에서 손을 떼면 여기로 온다. 되돌린다.
  window.addEventListener(type, (event) => {
    if (reorder.pointerId === event.pointerId) endReorder(false);
  });
}

// 끌기가 어려운 상황(키보드, 보조기기)을 위한 같은 동작.
dom.savedList.addEventListener('keydown', (event) => {
  const handle = event.target.closest('[data-handle]');
  if (!handle) return;
  const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
  if (!delta) return;
  event.preventDefault();
  const id = handle.dataset.handle;
  const from = singers.findIndex((s) => s.id === id);
  if (from < 0) return;
  moveSinger(from, from + delta);
  const next = dom.savedList.querySelector(`[data-handle="${id}"]`);
  if (next) next.focus();
});

dom.legend.addEventListener('click', (event) => {
  const target = event.target.closest('[data-reset-current], [data-edit]');
  if (!target) return;

  if (target.hasAttribute('data-reset-current')) {
    currentRange = { low: null, high: null };
    heldNote = null;
    refreshChartData();
    renderLegend();
    return;
  }

  const entry = singers.find((s) => s.id === target.dataset.edit);
  if (entry) openSheet(entry);
});

window.addEventListener('resize', () => {
  if (!chart) return;
  chart.resize();
  chart.draw();
});

/* ------------------------------------------------------- 차트 핀치 확대 */

// 브라우저가 페이지 전체를 확대하지 못하게 막는다. touch-action 만으로는
// 사파리의 제스처 이벤트가 남아서 따로 취소해야 한다.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (event) => event.preventDefault());
}

// 길게 누를 때 뜨는 컨텍스트 메뉴도 막는다. 입력란에서는 남겨 둔다.
document.addEventListener('contextmenu', (event) => {
  if (event.target.closest('input, textarea')) return;
  event.preventDefault();
});

const pinch = { pointers: new Map(), origin: null, lastTap: 0, lastTapAt: null };

function chartPoint(event) {
  const rect = dom.history.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

dom.history.addEventListener('pointerdown', (event) => {
  if (!chart) return;
  // 캡처는 손가락이 캔버스 밖으로 나가도 제스처를 놓치지 않게 해 준다.
  // 붙잡을 수 없는 포인터면 그냥 넘어간다.
  try { dom.history.setPointerCapture(event.pointerId); } catch { /* 무시 */ }
  pinch.pointers.set(event.pointerId, chartPoint(event));
  if (pinch.pointers.size === 2) beginPinch();
});

dom.history.addEventListener('pointermove', (event) => {
  if (!pinch.pointers.has(event.pointerId)) return;
  pinch.pointers.set(event.pointerId, chartPoint(event));
  if (pinch.pointers.size === 2 && pinch.origin) {
    event.preventDefault();
    updatePinch();
  }
});

for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
  dom.history.addEventListener(type, (event) => {
    if (!pinch.pointers.delete(event.pointerId)) return;
    if (pinch.pointers.size < 2 && pinch.origin) {
      pinch.origin = null;
      saveView(chart.getView());
    }
    if (type === 'pointerup' && pinch.pointers.size === 0) handleTap(event);
  });
}

function beginPinch() {
  const [a, b] = [...pinch.pointers.values()];
  const centerY = (a.y + b.y) / 2;
  const view = chart.getView();
  pinch.origin = {
    dx: Math.abs(a.x - b.x),
    dy: Math.abs(a.y - b.y),
    seconds: view.seconds,
    span: view.high - view.low,
    anchorMidi: chart.midiAtY(centerY),
  };
}

function updatePinch() {
  const origin = pinch.origin;
  const [a, b] = [...pinch.pointers.values()];
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);

  // 한 축으로 나란히 잡은 손가락은 그 축의 배율을 신뢰할 수 없다. 가로로 벌리면
  // 시간축만, 세로로 벌리면 음역만 움직이도록 최소 간격을 둔다.
  if (origin.dx > 24 && dx > 8) chart.setSeconds(origin.seconds * (origin.dx / dx));
  if (origin.dy > 24 && dy > 8) {
    chart.setSpanAround(origin.span * (origin.dy / dy), origin.anchorMidi, (a.y + b.y) / 2);
  }
  chart.draw();
}

/** 두 번 두드리면 원래 보기로 돌아간다. */
function handleTap(event) {
  const now = performance.now();
  const point = chartPoint(event);
  const near = pinch.lastTapAt
    && Math.hypot(point.x - pinch.lastTapAt.x, point.y - pinch.lastTapAt.y) < 30;

  if (near && now - pinch.lastTap < 320) {
    chart.resetView(HISTORY_SECONDS);
    chart.draw();
    saveView(chart.getView());
    pinch.lastTap = 0;
    pinch.lastTapAt = null;
    return;
  }
  pinch.lastTap = now;
  pinch.lastTapAt = point;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (listening) {
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      requestWakeLock();
    }
  } else {
    // 화면을 벗어나면 마이크 처리를 멈춰 배터리를 아낀다.
    if (audioCtx && audioCtx.state === 'running') audioCtx.suspend();
    wakeLock = null;
    dom.lockBadge.hidden = true;
  }
});

/* ----------------------------------------------------------- PWA 설치 */

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  dom.installBtn.hidden = false;
  dom.installChip.hidden = false;
});

async function runInstall() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  dom.installBtn.hidden = true;
  dom.installChip.hidden = true;
}
dom.installBtn.addEventListener('click', runInstall);
dom.installChip.addEventListener('click', runInstall);

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  dom.installBtn.hidden = true;
  dom.installChip.hidden = true;
});

// 저장해 둔 감도를 화면에 반영한다. 문턱 자체는 로드할 때 이미 잡혀 있다.
renderSensitivity();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
