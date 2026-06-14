// Web Audio synth: chiptune music + game SFX. No audio files — everything is
// generated with oscillators, so there's nothing to download and no licensing
// issues. The melody is "Korobeiniki", a 19th-century Russian folk tune (the
// classic Tetris theme) that is in the public domain.

const STORE_KEY = 'tetra_muted';

// note name ("E5", "F#3") -> frequency in Hz
const SEMI = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
function noteFreq(name) {
  const m = /^([A-G]#?)(\d)$/.exec(name);
  if (!m) return 0;
  const midi = (parseInt(m[2], 10) + 1) * 12 + SEMI[m[1]];
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// Korobeiniki, Theme A — two 16-beat phrases. [note, beats]; 'R' = rest.
const MELODY = [
  ['E5', 1], ['B4', 0.5], ['C5', 0.5], ['D5', 1], ['C5', 0.5], ['B4', 0.5],
  ['A4', 1], ['A4', 0.5], ['C5', 0.5], ['E5', 1], ['D5', 0.5], ['C5', 0.5],
  ['B4', 1.5], ['C5', 0.5], ['D5', 1], ['E5', 1],
  ['C5', 1], ['A4', 1], ['A4', 2],

  ['R', 0.5], ['D5', 1], ['F5', 0.5], ['A5', 1], ['G5', 0.5], ['F5', 0.5],
  ['E5', 1.5], ['C5', 0.5], ['E5', 1], ['D5', 0.5], ['C5', 0.5],
  ['B4', 1], ['B4', 0.5], ['C5', 0.5], ['D5', 1], ['E5', 1],
  ['C5', 1], ['A4', 1], ['A4', 2],
];

// Bass line — also 32 beats so it realigns with the melody on every loop.
const BASS = [
  ['E2', 1], ['B2', 1], ['E2', 1], ['B2', 1],
  ['E2', 1], ['B2', 1], ['E2', 1], ['B2', 1],
  ['A2', 1], ['E3', 1], ['A2', 1], ['E3', 1],
  ['E2', 1], ['B2', 1], ['E2', 1], ['B2', 1],
  ['A2', 1], ['E3', 1], ['A2', 1], ['E3', 1],
  ['B2', 1], ['F#3', 1], ['B2', 1], ['F#3', 1],
  ['E2', 1], ['B2', 1], ['E2', 1], ['B2', 1],
  ['B2', 1], ['B2', 1], ['E2', 1], ['E2', 1],
];

const BPM = 150;
const SPB = 60 / BPM;          // seconds per beat

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = (() => { try { return localStorage.getItem(STORE_KEY) === '1'; } catch { return false; } })();
    this._playing = false;
    this._timer = null;
  }

  // Build the context lazily — browsers only allow it after a user gesture.
  _ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(this.ctx.destination);
  }

  // Call on the first user interaction to enable sound and start the music.
  unlock() {
    this._ensure();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (!this.muted) this.startMusic();
  }

  toggleMute() {
    this.muted = !this.muted;
    try { localStorage.setItem(STORE_KEY, this.muted ? '1' : '0'); } catch {}
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.9;
    if (this.muted) this.stopMusic();
    else { this.unlock(); }
    return this.muted;
  }

  // ---- low-level voices ---------------------------------------------------
  _tone(freq, start, dur, { type = 'square', vol = 0.25, glideTo = null } = {}) {
    if (!this.ctx || freq <= 0) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, start);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, glideTo), start + dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(vol, start + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(this.master);
    o.start(start);
    o.stop(start + dur + 0.03);
  }

  _noise(start, dur, vol = 0.2) {
    if (!this.ctx) return;
    const n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(g).connect(this.master);
    src.start(start);
  }

  // ---- sound effects ------------------------------------------------------
  // Each ensures the context exists; if still muted, master gain is 0 anyway.
  _now() { this._ensure(); return this.ctx ? this.ctx.currentTime : 0; }

  move()    { const t = this._now(); this._tone(330, t, 0.04, { vol: 0.12 }); }
  rotate()  { const t = this._now(); this._tone(520, t, 0.06, { vol: 0.16, glideTo: 640 }); }
  hold()    { const t = this._now(); this._tone(440, t, 0.05, { vol: 0.16 }); this._tone(660, t + 0.05, 0.07, { vol: 0.16 }); }
  lock()    { const t = this._now(); this._tone(180, t, 0.06, { type: 'triangle', vol: 0.2 }); this._noise(t, 0.04, 0.08); }
  hardDrop(){ const t = this._now(); this._tone(150, t, 0.12, { type: 'square', vol: 0.22, glideTo: 60 }); this._noise(t, 0.09, 0.16); }
  gameOver(){
    const t = this._now();
    ['A4', 'F4', 'D4', 'A3'].forEach((n, i) =>
      this._tone(noteFreq(n), t + i * 0.18, 0.22, { type: 'triangle', vol: 0.22 }));
  }

  // n = lines cleared; bigger clears get a richer flourish.
  lineClear(n, tspin = false, perfectClear = false) {
    const t = this._now();
    if (perfectClear) {
      ['C5', 'E5', 'G5', 'C6', 'E6'].forEach((nt, i) =>
        this._tone(noteFreq(nt), t + i * 0.07, 0.3, { vol: 0.2 }));
      return;
    }
    if (tspin) {
      ['E5', 'A5', 'C6'].forEach((nt, i) =>
        this._tone(noteFreq(nt), t + i * 0.06, 0.22, { type: 'sawtooth', vol: 0.18 }));
      return;
    }
    if (n >= 4) { // Tetris!
      ['C5', 'G5', 'C6', 'E6'].forEach((nt, i) =>
        this._tone(noteFreq(nt), t + i * 0.06, 0.26, { vol: 0.2 }));
      return;
    }
    // 1–3 lines: short ascending arpeggio that grows with the clear
    const notes = ['C5', 'E5', 'G5'].slice(0, n);
    notes.forEach((nt, i) => this._tone(noteFreq(nt), t + i * 0.05, 0.16, { vol: 0.18 }));
  }

  // ---- music loop (lookahead scheduler) -----------------------------------
  startMusic() {
    this._ensure();
    if (!this.ctx || this._playing || this.muted) return;
    this._playing = true;
    const t0 = this.ctx.currentTime + 0.1;
    this._mIdx = 0; this._mTime = t0;
    this._bIdx = 0; this._bTime = t0;
    this._schedule();
  }

  stopMusic() {
    this._playing = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  _schedule() {
    if (!this._playing || !this.ctx) return;
    const ahead = this.ctx.currentTime + 0.25;
    while (this._mTime < ahead) {
      const [note, beats] = MELODY[this._mIdx];
      const dur = beats * SPB;
      if (note !== 'R') this._tone(noteFreq(note), this._mTime, dur * 0.9, { type: 'square', vol: 0.14 });
      this._mTime += dur;
      this._mIdx = (this._mIdx + 1) % MELODY.length;
    }
    while (this._bTime < ahead) {
      const [note, beats] = BASS[this._bIdx];
      const dur = beats * SPB;
      if (note !== 'R') this._tone(noteFreq(note), this._bTime, dur * 0.95, { type: 'triangle', vol: 0.18 });
      this._bTime += dur;
      this._bIdx = (this._bIdx + 1) % BASS.length;
    }
    this._timer = setTimeout(() => this._schedule(), 40);
  }
}

export const audio = new AudioEngine();
