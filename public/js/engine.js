// Headless Tetris engine: board state, SRS rotation, 7-bag, scoring, garbage.
// Rendering and input live elsewhere; this only computes game state.

export const COLS = 10;
export const ROWS = 20;

// Most garbage that can rise on a single piece lock; the rest waits for the
// next no-clear lock so you're never buried instantly by one huge attack.
const MAX_GARBAGE_PER_DROP = 8;

// Difficulty ramp: gravity speeds up one level for every this-many lines cleared.
const LINES_PER_LEVEL = 10;

// Piece colors (index 1..7 maps to pieces; 8 = garbage).
export const COLORS = {
  I: '#22d3ee', O: '#facc15', T: '#a855f7', S: '#4ade80',
  Z: '#f87171', J: '#3b82f6', L: '#fb923c', G: '#6b7280',
};
export const TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

// SRS pieces as filled-cell lists [row, col] within an N×N box, 4 states each.
const PIECES = {
  I: { n: 4, states: [
    [[1,0],[1,1],[1,2],[1,3]],
    [[0,2],[1,2],[2,2],[3,2]],
    [[2,0],[2,1],[2,2],[2,3]],
    [[0,1],[1,1],[2,1],[3,1]],
  ]},
  O: { n: 2, states: [
    [[0,0],[0,1],[1,0],[1,1]],
    [[0,0],[0,1],[1,0],[1,1]],
    [[0,0],[0,1],[1,0],[1,1]],
    [[0,0],[0,1],[1,0],[1,1]],
  ]},
  T: { n: 3, states: [
    [[0,1],[1,0],[1,1],[1,2]],
    [[0,1],[1,1],[1,2],[2,1]],
    [[1,0],[1,1],[1,2],[2,1]],
    [[0,1],[1,0],[1,1],[2,1]],
  ]},
  S: { n: 3, states: [
    [[0,1],[0,2],[1,0],[1,1]],
    [[0,1],[1,1],[1,2],[2,2]],
    [[1,1],[1,2],[2,0],[2,1]],
    [[0,0],[1,0],[1,1],[2,1]],
  ]},
  Z: { n: 3, states: [
    [[0,0],[0,1],[1,1],[1,2]],
    [[0,2],[1,1],[1,2],[2,1]],
    [[1,0],[1,1],[2,1],[2,2]],
    [[0,1],[1,0],[1,1],[2,0]],
  ]},
  J: { n: 3, states: [
    [[0,0],[1,0],[1,1],[1,2]],
    [[0,1],[0,2],[1,1],[2,1]],
    [[1,0],[1,1],[1,2],[2,2]],
    [[0,1],[1,1],[2,0],[2,1]],
  ]},
  L: { n: 3, states: [
    [[0,2],[1,0],[1,1],[1,2]],
    [[0,1],[1,1],[2,1],[2,2]],
    [[1,0],[1,1],[1,2],[2,0]],
    [[0,0],[0,1],[1,1],[2,1]],
  ]},
};

// SRS wall-kick offsets given as [colOffset, rowOffset] (row positive = down).
// Standard guideline tables, converted so +y(up) becomes -row.
const KICKS_JLSTZ = {
  '01': [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
  '10': [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
  '12': [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
  '21': [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
  '23': [[0,0],[1,0],[1,-1],[0,2],[1,2]],
  '32': [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
  '30': [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
  '03': [[0,0],[1,0],[1,-1],[0,2],[1,2]],
};
const KICKS_I = {
  '01': [[0,0],[-2,0],[1,0],[-2,1],[1,-2]],
  '10': [[0,0],[2,0],[-1,0],[2,-1],[-1,2]],
  '12': [[0,0],[-1,0],[2,0],[-1,-2],[2,1]],
  '21': [[0,0],[1,0],[-2,0],[1,2],[-2,-1]],
  '23': [[0,0],[2,0],[-1,0],[2,-1],[-1,2]],
  '32': [[0,0],[-2,0],[1,0],[-2,1],[1,-2]],
  '30': [[0,0],[1,0],[-2,0],[1,2],[-2,-1]],
  '03': [[0,0],[-1,0],[2,0],[-1,-2],[2,1]],
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Tetris {
  constructor(seed = 1, callbacks = {}) {
    this.rng = mulberry32(seed >>> 0);
    this.cb = callbacks;
    this.board = Array.from({ length: ROWS }, () => new Array(COLS).fill(null));
    this.bag = [];
    this.queue = [];
    for (let i = 0; i < 5; i++) this.queue.push(this.drawPiece());
    this.hold = null;
    this.canHold = true;
    this.gameOver = false;

    // scoring / attack state
    this.score = 0;
    this.lines = 0;
    this.level = 1;             // ramps up every LINES_PER_LEVEL lines cleared
    this.combo = -1;
    this.b2b = false;
    this.pendingGarbage = [];   // queued garbage columns to insert

    // timing
    this.gravityMs = 1000;
    this.gravityAcc = 0;
    this.lockDelay = 500;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.maxLockResets = 15;
    this.onGround = false;
    this.lastWasRotate = false;

    this.spawn();
  }

  drawPiece() {
    if (this.bag.length === 0) {
      this.bag = TYPES.slice();
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
    }
    return this.bag.pop();
  }

  spawn(type) {
    const t = type || this.queue.shift();
    if (!type) this.queue.push(this.drawPiece());
    const def = PIECES[t];
    const x = t === 'O' ? 4 : 3;
    this.piece = { type: t, rot: 0, x, y: 0 };
    this.onGround = false;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.lastWasRotate = false;
    if (this.collides(this.piece)) {
      this.gameOver = true;
      this.cb.onGameOver && this.cb.onGameOver();
    }
  }

  cells(piece) {
    const def = PIECES[piece.type];
    return def.states[piece.rot].map(([r, c]) => [piece.y + r, piece.x + c]);
  }

  collides(piece) {
    for (const [r, c] of this.cells(piece)) {
      if (c < 0 || c >= COLS || r >= ROWS) return true;
      if (r >= 0 && this.board[r][c]) return true;
    }
    return false;
  }

  move(dx, dy) {
    if (this.gameOver) return false;
    const p = { ...this.piece, x: this.piece.x + dx, y: this.piece.y + dy };
    if (this.collides(p)) return false;
    this.piece = p;
    if (dx !== 0) this.lastWasRotate = false;
    this.resetLockIfGrounded();
    return true;
  }

  rotate(dir) {
    if (this.gameOver || this.piece.type === 'O') return false;
    const from = this.piece.rot;
    const to = (from + (dir > 0 ? 1 : 3)) % 4;
    const table = this.piece.type === 'I' ? KICKS_I : KICKS_JLSTZ;
    const kicks = table[`${from}${to}`] || [[0, 0]];
    for (const [dc, dr] of kicks) {
      const p = { ...this.piece, rot: to, x: this.piece.x + dc, y: this.piece.y + dr };
      if (!this.collides(p)) {
        this.piece = p;
        this.lastWasRotate = true;
        this.resetLockIfGrounded();
        return true;
      }
    }
    return false;
  }

  resetLockIfGrounded() {
    const below = { ...this.piece, y: this.piece.y + 1 };
    this.onGround = this.collides(below);
    if (this.onGround && this.lockResets < this.maxLockResets) {
      this.lockTimer = 0;
      this.lockResets++;
    }
  }

  softDrop() {
    if (this.move(0, 1)) { this.score += 1; return true; }
    return false;
  }

  hardDrop() {
    if (this.gameOver) return;
    let dist = 0;
    while (this.move(0, 1)) dist++;
    this.score += dist * 2;
    this.lockPiece();
  }

  holdPiece() {
    if (this.gameOver || !this.canHold) return;
    const cur = this.piece.type;
    if (this.hold) {
      const h = this.hold;
      this.hold = cur;
      this.spawn(h);
    } else {
      this.hold = cur;
      this.spawn();
    }
    this.canHold = false;
  }

  ghostY() {
    const p = { ...this.piece };
    while (!this.collides({ ...p, y: p.y + 1 })) p.y++;
    return p.y;
  }

  // Detect T-spin: T piece, last action rotate, >=3 of 4 diagonal corners filled.
  detectTSpin() {
    if (this.piece.type !== 'T' || !this.lastWasRotate) return false;
    const { x, y } = this.piece;
    const corners = [[y, x], [y, x + 2], [y + 2, x], [y + 2, x + 2]];
    let filled = 0;
    for (const [r, c] of corners) {
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS || this.board[r][c]) filled++;
    }
    return filled >= 3;
  }

  lockPiece() {
    const tspin = this.detectTSpin();
    for (const [r, c] of this.cells(this.piece)) {
      if (r < 0) { // locked above the field => top out
        this.gameOver = true;
        this.cb.onGameOver && this.cb.onGameOver();
        return;
      }
      this.board[r][c] = COLORS[this.piece.type];
    }

    // clear full lines
    let cleared = 0;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (this.board[r].every((c) => c)) {
        this.board.splice(r, 1);
        this.board.unshift(new Array(COLS).fill(null));
        cleared++;
        r++;
      }
    }

    const perfectClear = cleared > 0 && this.board.every((row) => row.every((c) => !c));
    this.applyScore(cleared, tspin, perfectClear);

    if (cleared > 0) {
      this.combo++;
      this.lines += cleared;
      this.updateLevel();
    } else {
      this.combo = -1;
      this.dumpGarbage(); // garbage only lands when you don't clear
    }

    this.cb.onLock && this.cb.onLock({ cleared, tspin, perfectClear });
    this.canHold = true;
    this.gravityAcc = 0;
    this.spawn();
  }

  applyScore(cleared, tspin, perfectClear) {
    let attack = 0;
    const base = [0, 0, 1, 2, 4];
    const isB2B = (cleared === 4) || (tspin && cleared > 0);

    if (tspin && cleared > 0) {
      attack = [0, 2, 4, 6][cleared];
      this.score += [0, 800, 1200, 1600][cleared];
    } else {
      attack = base[cleared];
      this.score += [0, 100, 300, 500, 800][cleared];
    }

    // back-to-back bonus
    if (cleared > 0) {
      if (isB2B && this.b2b) attack += 1;
      this.b2b = isB2B;
    }

    // combo bonus
    if (cleared > 0 && this.combo >= 1) {
      const comboTable = [0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5];
      attack += comboTable[Math.min(this.combo, comboTable.length - 1)];
    }

    if (perfectClear) { attack += 4; this.score += 3000; }

    if (attack > 0 && cleared > 0) {
      // outgoing attack cancels pending incoming garbage first
      let remaining = attack;
      while (remaining > 0 && this.pendingGarbage.length > 0) {
        this.pendingGarbage.shift();
        remaining--;
      }
      if (remaining > 0 && this.cb.onAttack) this.cb.onAttack(remaining);
    }
  }

  receiveGarbage(amount) {
    for (let i = 0; i < amount; i++) {
      this.pendingGarbage.push(Math.floor(this.rng() * COLS));
    }
  }

  dumpGarbage() {
    if (this.pendingGarbage.length === 0) return;
    // Only up to MAX_GARBAGE_PER_DROP rises now; the rest stays queued.
    const n = Math.min(this.pendingGarbage.length, MAX_GARBAGE_PER_DROP);
    const lines = this.pendingGarbage.splice(0, n);
    // Garbage rises from the bottom, shoving the stack up by n rows. It's a top
    // out only if a filled cell in the top n rows would be pushed off the board.
    let overflow = false;
    for (let r = 0; r < n && r < ROWS; r++) {
      if (this.board[r].some((c) => c)) { overflow = true; break; }
    }
    for (const hole of lines) {
      this.board.shift();
      const row = new Array(COLS).fill(COLORS.G);
      row[hole] = null;
      this.board.push(row);
    }
    if (overflow) {
      this.gameOver = true;
      this.cb.onGameOver && this.cb.onGameOver();
    }
  }

  // Bump the level when enough lines have been cleared, speeding up gravity.
  updateLevel() {
    const target = Math.floor(this.lines / LINES_PER_LEVEL) + 1;
    if (target > this.level) {
      this.setLevel(target);
      this.cb.onLevelUp && this.cb.onLevelUp(this.level);
    }
  }

  setLevel(level) {
    this.level = level;
    // classic-ish gravity curve
    this.gravityMs = Math.max(50, 1000 * Math.pow(0.8, level - 1));
  }

  tick(dt) {
    if (this.gameOver) return;
    this.gravityAcc += dt;
    if (this.gravityAcc >= this.gravityMs) {
      this.gravityAcc = 0;
      if (!this.move(0, 1)) this.onGround = true;
    }
    // lock delay handling
    const below = { ...this.piece, y: this.piece.y + 1 };
    if (this.collides(below)) {
      this.onGround = true;
      this.lockTimer += dt;
      if (this.lockTimer >= this.lockDelay) this.lockPiece();
    } else {
      this.onGround = false;
      this.lockTimer = 0;
    }
  }
}
