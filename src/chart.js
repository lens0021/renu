/*
 * 시간축 피치 히스토리. Tuner 의 PitchHistory 화면을 웹으로 옮긴 것이다.
 * 가로는 시간이고 새 값이 오른쪽 끝에 붙으면서 왼쪽으로 흘러간다.
 *
 * DOM 대신 캔버스 한 장에 전부 그린다. 눈금·격자·기준선·궤적·오른쪽 음역대 레일이
 * 같은 y 좌표계를 쓰기 때문에, 요소를 나눠 두고 위치를 맞추는 것보다 이쪽이 단순하다.
 *
 * 보이는 범위는 두 축 모두 바뀔 수 있다. 표본은 항상 MAX_SECONDS 만큼 들고 있고
 * 그중 뒤쪽 일부만 그린다. 그래서 시간축을 넓혀도 과거가 비어 있지 않다.
 */

import { noteLabel } from './notes.js';

const COLORS = {
  gridOctave: '#242428',
  gridMinor: '#171719',
  label: '#4c4c55',
  labelDim: '#33333a',
  trail: '#1f7d5e',
  line: '#35d39a',
  clamp: '#8c8c98',
};

const GUTTER = 34;   // 왼쪽 음이름 눈금
const RAIL_BAR = 7;  // 오른쪽 레일 막대 너비
const RAIL_GAP = 4;
const HEAD_PAD = 10; // 최신 값과 오른쪽 끝 사이 여백

export const MAX_SECONDS = 30;
export const MIN_SECONDS = 2;
export const MIN_SPAN = 8;   // 확대 한계: 반음 8 개

export class HistoryChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{low:number, high:number, seconds:number, updateMs:number}} opts
   *   low/high 는 전체 한계이고, 처음에는 그 전체가 보이는 상태로 시작한다.
   */
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.minMidi = opts.low - 0.5;
    this.maxMidi = opts.high + 0.5;
    this.low = this.minMidi;
    this.high = this.maxMidi;

    this.updateMs = opts.updateMs;
    this.viewSeconds = opts.seconds;
    this.capacity = Math.ceil((MAX_SECONDS * 1000) / opts.updateMs);
    this.samples = new Array(this.capacity).fill(null);

    this.entries = [];
    this.guides = [];
    this.clamp = null;
    this.width = 0;
    this.height = 0;
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (!width || !height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setEntries(entries) {
    this.entries = entries;
  }

  setGuides(guides) {
    this.guides = guides;
  }

  /** 기준 음역대. 지정하면 그 경계를 그려서 무엇이 무시되는지 보이게 한다. */
  setClamp(range) {
    this.clamp = range;
  }

  /** 새 값을 오른쪽 끝에 붙인다. 소리가 없으면 null 을 넣어 시간만 흐르게 한다. */
  push(midi) {
    this.samples.push(midi);
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  /* ------------------------------------------------------------ 보이는 범위 */

  getView() {
    return { seconds: this.viewSeconds, low: this.low, high: this.high };
  }

  setSeconds(seconds) {
    this.viewSeconds = clamp(seconds, MIN_SECONDS, MAX_SECONDS);
  }

  /**
   * 세로 범위를 바꾸되 anchorY 화면 높이에 있던 음이 제자리에 있도록 맞춘다.
   * 핀치할 때 손가락 사이에 있던 음이 따라 움직이지 않게 하려는 것이다.
   */
  setSpanAround(span, anchorMidi, anchorY) {
    const full = this.maxMidi - this.minMidi;
    const next = clamp(span, MIN_SPAN, full);
    const ratio = this.height ? clamp(anchorY / this.height, 0, 1) : 0.5;

    let high = anchorMidi + ratio * next;
    if (high > this.maxMidi) high = this.maxMidi;
    if (high - next < this.minMidi) high = this.minMidi + next;

    this.high = high;
    this.low = high - next;
  }

  setView({ seconds, low, high }) {
    if (Number.isFinite(seconds)) this.setSeconds(seconds);
    if (Number.isFinite(low) && Number.isFinite(high) && high > low) {
      const full = this.maxMidi - this.minMidi;
      const span = clamp(high - low, MIN_SPAN, full);
      let top = clamp(high, this.minMidi + span, this.maxMidi);
      this.high = top;
      this.low = top - span;
    }
  }

  resetView(seconds) {
    this.viewSeconds = seconds;
    this.low = this.minMidi;
    this.high = this.maxMidi;
  }

  get isDefaultView() {
    return this.low === this.minMidi && this.high === this.maxMidi;
  }

  /* -------------------------------------------------------------- 좌표 변환 */

  /** 화면 밖으로 나가도 잘라내지 않는 y. 궤적처럼 클리핑해서 그릴 때 쓴다. */
  yRaw(midi) {
    return ((this.high - midi) / (this.high - this.low)) * this.height;
  }

  y(midi) {
    return this.yRaw(clamp(midi, this.low, this.high));
  }

  midiAtY(y) {
    if (!this.height) return (this.low + this.high) / 2;
    return this.high - (y / this.height) * (this.high - this.low);
  }

  get railWidth() {
    return this.entries.length ? this.entries.length * (RAIL_BAR + RAIL_GAP) : 0;
  }

  get plotLeft() {
    return GUTTER;
  }

  get plotRight() {
    return this.width - this.railWidth;
  }

  get visibleCount() {
    return Math.max(2, Math.round((this.viewSeconds * 1000) / this.updateMs));
  }

  /* ------------------------------------------------------------------ 그리기 */

  draw() {
    const ctx = this.ctx;
    if (!this.width || !this.height) return;
    ctx.clearRect(0, 0, this.width, this.height);

    this.drawGuides();
    this.drawGrid();
    this.drawClamp();
    this.drawTrail();
    this.drawRail();
  }

  drawGuides() {
    const ctx = this.ctx;
    const left = this.plotLeft;
    const right = this.plotRight;
    for (const guide of this.guides) {
      const top = this.y(guide.high + 0.5);
      const bottom = this.y(guide.low - 0.5);
      if (bottom - top < 1) continue;

      ctx.fillStyle = guide.color;
      ctx.globalAlpha = 0.055;
      ctx.fillRect(left, top, right - left, bottom - top);
      ctx.globalAlpha = 0.28;
      ctx.strokeStyle = guide.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      for (const edge of [top, bottom]) {
        ctx.beginPath();
        ctx.moveTo(left, Math.round(edge) + 0.5);
        ctx.lineTo(right, Math.round(edge) + 0.5);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = guide.color;
      ctx.font = '9px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(guide.label, right - 4, top + 3);
      ctx.globalAlpha = 1;
    }
  }

  /**
   * 눈금 간격은 보이는 범위에 맞춘다. 전체를 볼 때는 C 만, 확대할수록 촘촘해진다.
   * 12 의 약수만 쓰기 때문에 어떤 간격에서도 C 는 항상 눈금 위에 온다.
   */
  drawGrid() {
    const ctx = this.ctx;
    const left = this.plotLeft;
    const right = this.plotRight;
    const span = this.high - this.low;
    const step = span > 30 ? 12 : span > 16 ? 6 : span > 10 ? 3 : 1;

    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;

    for (let midi = Math.ceil(this.low); midi <= this.high; midi++) {
      if (midi % step !== 0) continue;
      const isOctave = midi % 12 === 0;
      const y = Math.round(this.yRaw(midi)) + 0.5;

      ctx.strokeStyle = isOctave ? COLORS.gridOctave : COLORS.gridMinor;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();

      ctx.fillStyle = isOctave ? COLORS.label : COLORS.labelDim;
      ctx.fillText(noteLabel(midi), GUTTER - 7, y);
    }
  }

  drawClamp() {
    const range = this.clamp;
    if (!range) return;
    const ctx = this.ctx;
    const left = this.plotLeft;
    const right = this.plotRight;
    const top = this.y(range.high + 0.5);

    ctx.strokeStyle = COLORS.clamp;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.75;
    for (const edge of [top, this.y(range.low - 0.5)]) {
      const y = Math.round(edge) + 0.5;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = COLORS.clamp;
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('기준', left + 4, top - 3);
    ctx.globalAlpha = 1;
  }

  drawTrail() {
    const ctx = this.ctx;
    const left = this.plotLeft;
    const right = this.plotRight - HEAD_PAD;
    if (right - left <= 0) return;

    const total = this.samples.length;
    const count = Math.min(this.visibleCount, total);
    const first = total - count;
    const step = (right - left) / (count - 1);
    const xOf = (index) => left + (index - first) * step;

    // 확대하면 궤적이 화면 밖으로 나간다. 값을 가장자리에 눌러 붙이면 없는 음을
    // 그리게 되므로, 자르는 쪽이 정직하다.
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, 0, this.plotRight - left, this.height);
    ctx.clip();

    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // 끊긴 구간을 잇지 않도록 연속된 조각마다 따로 그린다.
    let run = [];
    const flush = () => {
      if (run.length === 0) return;
      if (run.length === 1) {
        ctx.fillStyle = COLORS.trail;
        ctx.beginPath();
        ctx.arc(run[0][0], run[0][1], 1.4, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.strokeStyle = COLORS.trail;
        ctx.beginPath();
        ctx.moveTo(run[0][0], run[0][1]);
        for (let i = 1; i < run.length; i++) ctx.lineTo(run[i][0], run[i][1]);
        ctx.stroke();
      }
      run = [];
    };

    for (let i = first; i < total; i++) {
      const value = this.samples[i];
      if (value === null) flush();
      else run.push([xOf(i), this.yRaw(value)]);
    }
    flush();

    // 가장 최근 값은 점과 안내선으로 강조한다.
    const head = this.samples[total - 1];
    if (head !== null) {
      const y = this.yRaw(head);
      ctx.strokeStyle = COLORS.line;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, Math.round(y) + 0.5);
      ctx.lineTo(this.plotRight, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.fillStyle = COLORS.line;
      ctx.beginPath();
      ctx.arc(xOf(total - 1), y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  drawRail() {
    if (!this.entries.length) return;
    const ctx = this.ctx;
    let x = this.plotRight + RAIL_GAP / 2;

    for (const entry of this.entries) {
      if (entry.low !== null && entry.high !== null) {
        const top = this.y(entry.high + 0.5);
        const bottom = this.y(entry.low - 0.5);
        ctx.fillStyle = entry.color;
        ctx.globalAlpha = 0.85;
        roundRect(ctx, x, top, RAIL_BAR, Math.max(3, bottom - top), RAIL_BAR / 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = COLORS.gridMinor;
        ctx.lineWidth = 1;
        roundRect(ctx, x + 0.5, 0.5, RAIL_BAR - 1, this.height - 1, RAIL_BAR / 2);
        ctx.stroke();
      }
      x += RAIL_BAR + RAIL_GAP;
    }
  }
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
