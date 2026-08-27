/* localStorage 영속화. 저장 실패(사파리 프라이빗 모드 등)는 조용히 무시한다. */

const SINGERS_KEY = 'renu.singers.v1';
const GUIDES_KEY = 'renu.guides.v1';
const CLAMP_KEY = 'renu.clamp.v1';
const VIEW_KEY = 'renu.view.v1';
const SEEDED_KEY = 'renu.seeded.v1';

export const LANE_COLORS = ['#6aa6ff', '#ffb84d', '#c98cff', '#ff7fa8', '#5fd8d8', '#9ad25f'];

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const value = JSON.parse(raw);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 저장 공간이 없거나 막혀 있으면 이번 세션에만 유지된다 */
  }
}

/** 가수 목록. [{ id, name, low, high }] 이고 low/high 는 MIDI 번호다. */
export function loadSingers() {
  const list = read(SINGERS_KEY, null);
  if (Array.isArray(list)) return list.filter(isValidSinger);

  // 첫 실행에만 예시를 하나 넣어둔다. 지우면 다시 생기지 않는다.
  if (!read(SEEDED_KEY, false)) {
    write(SEEDED_KEY, true);
    const seed = [{ id: newId(), name: '아무개', low: 56, high: 77 }]; // G♯3 – F5
    write(SINGERS_KEY, seed);
    return seed;
  }
  return [];
}

export function saveSingers(list) {
  write(SINGERS_KEY, list);
}

function isValidSinger(s) {
  return s && typeof s.name === 'string'
    && Number.isFinite(s.low) && Number.isFinite(s.high) && s.low <= s.high;
}

export function newId() {
  return 'r' + Math.random().toString(36).slice(2, 10);
}

/** 남성·여성 일반 음역대 기준선을 항상 표시할지. */
export function loadShowGuides() {
  const value = read(GUIDES_KEY, null);
  return value === null ? true : value === true;
}

export function saveShowGuides(value) {
  write(GUIDES_KEY, !!value);
}

/** 기준으로 삼을 음역대의 id. 이 밖의 소리는 소음으로 보고 버린다. */
export function loadClampId() {
  const value = read(CLAMP_KEY, null);
  return typeof value === 'string' ? value : null;
}

export function saveClampId(id) {
  write(CLAMP_KEY, id || null);
}

/** 차트에서 보고 있던 범위. { seconds, low, high } 이고 없으면 null. */
export function loadView() {
  const view = read(VIEW_KEY, null);
  if (!view) return null;
  const ok = Number.isFinite(view.seconds)
    && Number.isFinite(view.low) && Number.isFinite(view.high)
    && view.high > view.low;
  return ok ? view : null;
}

export function saveView(view) {
  write(VIEW_KEY, view);
}

export function colorFor(index) {
  return LANE_COLORS[index % LANE_COLORS.length];
}
