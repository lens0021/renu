/*
 * 사람 목소리용 피치 검출기.
 *
 * Tuner(de.moekadu.tuner)의 접근을 참고했다. 자기상관으로 기본 주파수를 잡고,
 * 보간으로 정밀도를 올린 뒤, 아웃라이어를 걸러 스무딩한다. 다만 구현은 새로 썼고
 * 웹/모바일 환경에 맞춰 다음처럼 바꿨다.
 *
 *  1) 목표 대역이 사람 음역(대략 60~1200 Hz)뿐이므로 저역통과 후 1/4로 데시메이션해
 *     NSDF(McLeod)를 돌린다. 연산량이 1/16 로 줄어 배터리에 유리하다.
 *  2) 데시메이션 때문에 거친 추정값의 분해능이 떨어지므로, 원본 샘플레이트에서
 *     주기의 정수배(m*T) 근처를 정규화 상호상관으로 다시 찾아 정밀도를 m 배로 올린다.
 */

/** RBJ 쿡북 저역통과 바이쿼드 계수. */
function lowpassCoeffs(cutoffRatio, q) {
  const w0 = 2 * Math.PI * cutoffRatio;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cosw) / 2) / a0,
    b1: (1 - cosw) / a0,
    b2: ((1 - cosw) / 2) / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * 바이쿼드를 전치형 direct form II 로 적용한다.
 * 상태값을 x[0] 의 정상상태로 초기화하므로 매 프레임 새로 필터링해도 과도응답이 없다.
 */
function biquad(src, dst, n, c) {
  const seed = src[0];
  let s1 = (c.b1 - c.a1 + c.b2 - c.a2) * seed;
  let s2 = (c.b2 - c.a2) * seed;
  for (let i = 0; i < n; i++) {
    const x = src[i];
    const y = c.b0 * x + s1;
    s1 = c.b1 * x - c.a1 * y + s2;
    s2 = c.b2 * x - c.a2 * y;
    dst[i] = y;
  }
}

/** 세 점으로 포물선 꼭짓점을 보간한다. 반환값은 중심에서의 오프셋과 꼭짓점 높이. */
function parabolic(yPrev, yMid, yNext) {
  const denom = yPrev - 2 * yMid + yNext;
  if (denom === 0) return { offset: 0, value: yMid };
  const offset = (0.5 * (yPrev - yNext)) / denom;
  return { offset, value: yMid - 0.25 * (yPrev - yNext) * offset };
}

export class PitchDetector {
  /**
   * @param {number} sampleRate 오디오 컨텍스트 샘플레이트
   * @param {{fmin:number, fmax:number, bufferSize:number, clarityThreshold:number}} opts
   */
  constructor(sampleRate, opts = {}) {
    this.sampleRate = sampleRate;
    this.fmin = opts.fmin ?? 60;
    this.fmax = opts.fmax ?? 1200;
    this.bufferSize = opts.bufferSize ?? 8192;
    this.clarityThreshold = opts.clarityThreshold ?? 0.72;

    // 데시메이션 후 목표 샘플레이트 ~12 kHz. 사람 목소리 기본음의 4~5 배음까지 남는다.
    this.decim = Math.max(1, Math.round(sampleRate / 12000));
    this.decRate = sampleRate / this.decim;
    this.decLen = Math.floor(this.bufferSize / this.decim);

    this.minLag = Math.max(2, Math.floor(this.decRate / this.fmax));
    this.maxLag = Math.min(
      Math.floor(this.decLen / 2),
      Math.ceil(this.decRate / this.fmin)
    );

    // 데시메이션 전 안티에일리어싱: 나이퀴스트의 40% 지점에서 2 단 캐스케이드.
    const cutoff = 0.4 * (this.decRate / 2) / sampleRate;
    this.lpA = lowpassCoeffs(cutoff, Math.SQRT1_2);
    this.lpB = lowpassCoeffs(cutoff, Math.SQRT1_2);

    this.work = new Float32Array(this.bufferSize);
    this.filtered = new Float32Array(this.bufferSize);
    this.dec = new Float32Array(this.decLen);
    this.nsdf = new Float32Array(this.maxLag + 2);
    this.cumSq = new Float64Array(this.bufferSize + 1);
  }

  /**
   * 시간영역 샘플 한 덩어리에서 피치를 뽑는다.
   * @param {Float32Array} samples 길이 bufferSize
   * @returns {{freq:number, clarity:number, rms:number}|null}
   */
  detect(samples) {
    const n = this.bufferSize;

    // DC 제거 + RMS. 고정 오프셋은 자기상관을 크게 흔든다.
    let mean = 0;
    for (let i = 0; i < n; i++) mean += samples[i];
    mean /= n;

    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = samples[i] - mean;
      this.work[i] = v;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / n);
    if (rms < 1e-4) return { freq: 0, clarity: 0, rms };

    const coarse = this._coarsePeriod();
    if (!coarse) return { freq: 0, clarity: 0, rms };

    const period = this._refinePeriod(coarse.period * this.decim);
    const freq = this.sampleRate / period;
    if (freq < this.fmin || freq > this.fmax) return { freq: 0, clarity: coarse.clarity, rms };

    return { freq, clarity: coarse.clarity, rms };
  }

  /** 데시메이션한 신호에서 NSDF 로 거친 주기(데시메이션 샘플 단위)를 찾는다. */
  _coarsePeriod() {
    const n = this.bufferSize;
    biquad(this.work, this.filtered, n, this.lpA);
    biquad(this.filtered, this.filtered, n, this.lpB);

    const d = this.decim;
    const w = this.decLen;
    const x = this.dec;
    for (let i = 0; i < w; i++) x[i] = this.filtered[i * d];

    // NSDF: nsdf[t] = 2*r[t] / (sum x[j]^2 + sum x[j+t]^2). 값은 -1..1 이고 1 이 완전주기.
    const nsdf = this.nsdf;
    const maxLag = this.maxLag;
    for (let t = 1; t <= maxLag; t++) {
      let acf = 0;
      let norm = 0;
      const end = w - t;
      for (let j = 0; j < end; j++) {
        const a = x[j];
        const b = x[j + t];
        acf += a * b;
        norm += a * a + b * b;
      }
      nsdf[t] = norm > 0 ? (2 * acf) / norm : 0;
    }

    // McLeod 피크 선택: 첫 음수 구간을 지난 뒤, 양수 구간마다 최댓값을 모은다.
    //
    // 비교는 반드시 포물선 보간한 값으로 한다. 고음은 한 주기가 데시메이션 샘플로 열 개
    // 남짓이라, 격자에 우연히 잘 맞은 옥타브 아래 피크의 원시값이 진짜 피크보다 커지는
    // 일이 생긴다. 원시값으로 비교하면 그대로 옥타브 오류가 된다.
    let t = 1;
    while (t <= maxLag && nsdf[t] > 0) t++;

    const peaks = [];
    let bestValue = 0;
    while (t <= maxLag) {
      if (nsdf[t] > 0) {
        let localMax = t;
        while (t <= maxLag && nsdf[t] > 0) {
          if (nsdf[t] > nsdf[localMax]) localMax = t;
          t++;
        }
        if (localMax >= 1 && localMax < maxLag) {
          const fit = parabolic(nsdf[localMax - 1], nsdf[localMax], nsdf[localMax + 1]);
          const lag = localMax + fit.offset;
          if (lag >= this.minLag && lag <= maxLag) {
            peaks.push({ lag, value: fit.value });
            if (fit.value > bestValue) bestValue = fit.value;
          }
        }
      } else {
        t++;
      }
    }
    if (peaks.length === 0 || bestValue < this.clarityThreshold) return null;

    // 최고 피크의 90% 를 넘는 첫 피크를 쓴다. 옥타브 아래로 잘못 잡히는 걸 막아준다.
    const threshold = 0.9 * bestValue;
    let chosen = peaks[0];
    for (const p of peaks) {
      if (p.value >= threshold) {
        chosen = p;
        break;
      }
    }

    if (!(chosen.lag > 0)) return null;
    return { period: chosen.lag, clarity: Math.min(1, Math.max(0, chosen.value)) };
  }

  /**
   * 원본 샘플레이트에서 주기를 다듬는다.
   *
   * 주기가 T 라면 지연 m*T 에서도 상관이 최대가 된다. 큰 m 을 쓰면 같은 절대오차가
   * m 배로 희석되므로 상대 정밀도가 m 배 좋아진다. 다만 m 을 너무 키우면 탐색창이
   * 이웃 주기까지 덮어 한 주기씩 밀린 값을 잡으므로, 현재 오차 추정치에 맞춰 m 을 올린다.
   */
  _refinePeriod(periodFull) {
    const n = this.bufferSize;
    const cum = this.cumSq;
    cum[0] = 0;
    for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + this.work[i] * this.work[i];

    let period = periodFull;
    let relError = 0.04; // 데시메이션 추정치의 보수적인 상대오차
    let prevM = 0;

    for (let round = 0; round < 3; round++) {
      // 탐색 반경이 반주기의 40% 를 넘지 않는 선에서 가장 큰 m
      const byError = Math.floor((0.2 * period) / Math.max(1e-9, period * relError));
      const byBuffer = Math.floor(n / 2 / period);
      const m = Math.max(1, Math.min(byError, byBuffer));
      if (m <= prevM) break;
      prevM = m;

      const next = this._correlateAround(period, m, relError, cum);
      if (!next) break;

      period = next.period;
      relError = Math.max(1e-5, 0.4 / (m * period)); // 보간 잔차 ~0.4 샘플
    }
    return period;
  }

  /** m*period 근처에서 정규화 상호상관의 꼭짓점을 찾아 새 주기를 돌려준다. */
  _correlateAround(period, m, relError, cum) {
    const n = this.bufferSize;
    const center = Math.round(m * period);
    const span = Math.min(
      Math.max(2, Math.ceil(m * period * relError) + 2),
      Math.max(2, Math.floor(0.4 * period))
    );
    const lo = center - span;
    const hi = center + span;
    if (lo < 2 || hi >= n - 512) return null;

    const len = n - hi;
    const x = this.work;
    const energyHead = cum[len];
    if (energyHead <= 0) return null;

    const values = new Float64Array(hi - lo + 1);
    for (let lag = lo; lag <= hi; lag++) {
      let dot = 0;
      for (let j = 0; j < len; j++) dot += x[j] * x[j + lag];
      const energyTail = cum[lag + len] - cum[lag];
      values[lag - lo] = energyTail > 0 ? dot / Math.sqrt(energyHead * energyTail) : 0;
    }

    let best = 0;
    for (let i = 1; i < values.length; i++) {
      if (values[i] > values[best]) best = i;
    }
    // 꼭짓점이 탐색창 끝에 걸리면 진짜 최댓값을 놓친 것이므로 이번 회차는 버린다.
    if (best === 0 || best === values.length - 1) return null;

    const fit = parabolic(values[best - 1], values[best], values[best + 1]);
    const lagStar = lo + best + fit.offset;
    const refined = lagStar / m;
    if (!(refined > 0)) return null;
    return { period: refined, value: fit.value };
  }
}
