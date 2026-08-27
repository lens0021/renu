/* 음이름 / 주파수 변환 유틸. 절대음감 표기는 과학적 음이름(A4 = 440 Hz, MIDI 69). */

export const A4_FREQ = 440;
export const A4_MIDI = 69;

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const PC_OF_LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 주파수(Hz) -> 실수 MIDI 번호. */
export function freqToMidi(freq) {
  return A4_MIDI + 12 * Math.log2(freq / A4_FREQ);
}

/** MIDI 번호 -> 주파수(Hz). 소수점 MIDI 도 허용한다. */
export function midiToFreq(midi) {
  return A4_FREQ * Math.pow(2, (midi - A4_MIDI) / 12);
}

/** MIDI 번호를 음이름 부분과 옥타브로 나눈다. C4 = 60. */
export function splitNote(midi) {
  const m = Math.round(midi);
  const pc = ((m % 12) + 12) % 12;
  const octave = Math.floor(m / 12) - 1;
  return { name: NAMES[pc].replace('#', '♯'), octave, sharp: NAMES[pc].includes('#') };
}

/** "C#4" 형태의 표시용 문자열. */
export function noteLabel(midi) {
  const { name, octave } = splitNote(midi);
  return `${name}${octave}`;
}

/** "G#3", "G♯3", "Ab3", "Gb3" 등을 MIDI 번호로. 실패하면 null. */
export function parseNote(text) {
  const m = /^\s*([A-Ga-g])\s*([#♯♯b♭]?)\s*(-?\d+)\s*$/.exec(text || '');
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const accidental = m[2];
  const octave = parseInt(m[3], 10);
  let pc = PC_OF_LETTER[letter];
  if (accidental === '#' || accidental === '♯') pc += 1;
  else if (accidental === 'b' || accidental === '♭') pc -= 1;
  return (octave + 1) * 12 + pc;
}

/** 두 주파수 사이의 센트 차이. */
export function centsBetween(freq, reference) {
  return 1200 * Math.log2(freq / reference);
}
