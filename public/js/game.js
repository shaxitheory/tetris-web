// Rendering, input handling, game loop. Wires the engine to the network.
import { Tetris, COLS, ROWS, COLORS } from './engine.js';
import { audio } from './audio.js';
import { BOARD } from './themes.js';

const DAS = 120;   // delayed auto shift (ms)
const ARR = 18;    // auto repeat rate (ms)
const SOFT = 25;   // soft drop repeat (ms)

// preview shapes for hold/next rendering (state 0 cells)
const PREVIEW = {
  I: [[1,0],[1,1],[1,2],[1,3]],
  O: [[0,1],[0,2],[1,1],[1,2]],
  T: [[0,1],[1,0],[1,1],[1,2]],
  S: [[0,1],[0,2],[1,0],[1,1]],
  Z: [[0,0],[0,1],[1,1],[1,2]],
  J: [[0,0],[1,0],[1,1],[1,2]],
  L: [[0,2],[1,0],[1,1],[1,2]],
};

export class Game {
  constructor({ canvas, holdCanvas, nextCanvas, oppCanvas, net, onStats, onEnd, onPause }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.holdCtx = holdCanvas.getContext('2d');
    this.nextCtx = nextCanvas.getContext('2d');
    this.oppCtx = oppCanvas ? oppCanvas.getContext('2d') : null;
    this.net = net;
    this.onStats = onStats || (() => {});
    this.onEnd = onEnd || (() => {});
    this.onPause = onPause || (() => {});
    this.cell = Math.floor(canvas.width / COLS);
    this.oppBoard = null;
    this.running = false;
    this.paused = false;
    this.keys = {};
    this._bindInput();
  }

  start(seed) {
    this.engine = new Tetris(seed, {
      onAttack: (amt) => { if (this.net) this.net.send({ type: 'garbage', amount: amt }); this.flash(amt); },
      onGameOver: () => { audio.gameOver(); this.end(); },
      onLock: (info) => this._onLock(info),
    });
    this.running = true;
    this.paused = false;
    this.lastTime = performance.now();
    this.stateTimer = 0;
    this.attackFlash = 0;
    audio.startMusic();
    this.onPause(false);
    this._loop();
  }

  end() {
    if (!this.running) return;
    this.running = false;
    this.paused = false;
    this.onPause(false);
    if (this.net) {
      this.net.send({ type: 'gameover', score: this.engine.score, lines: this.engine.lines });
    }
    this.onEnd();
  }

  stop() { this.running = false; this.paused = false; this.onPause(false); }

  // Pause is only meaningful when there's no opponent waiting on us (solo).
  canPause() { return !this.net; }

  togglePause() {
    if (!this.running || !this.canPause()) return;
    this.paused = !this.paused;
    if (this.paused) {
      audio.stopMusic();
      this.keys = {};               // drop any held movement so it can't auto-repeat on resume
    } else {
      audio.startMusic();
      this.lastTime = performance.now();   // avoid a huge dt jump after the pause
    }
    this.onPause(this.paused);
  }

  flash(amt) { this.attackFlash = Math.min(1, this.attackFlash + amt * 0.2); }

  receiveGarbage(amount) { if (this.engine) this.engine.receiveGarbage(amount); }

  setOppBoard(board) { this.oppBoard = board; }

  // ---- input -------------------------------------------------------------
  _bindInput() {
    this.handleKeyDown = (e) => {
      if (!this.running) return;
      const k = e.key.toLowerCase();
      // P or Esc toggles pause (solo only); works even while already paused.
      if ((k === 'p' || k === 'escape') && this.canPause()) {
        e.preventDefault();
        this.togglePause();
        return;
      }
      if (this.paused) return;
      if (['arrowleft','arrowright','arrowdown','arrowup',' '].includes(e.key.toLowerCase()) ||
          [' '].includes(e.key)) e.preventDefault();
      if (e.repeat) return;
      const eng = this.engine;
      switch (e.key) {
        case 'ArrowLeft':  this._press('left'); if (eng.move(-1, 0)) audio.move(); break;
        case 'ArrowRight': this._press('right'); if (eng.move(1, 0)) audio.move(); break;
        case 'ArrowDown':  this._press('soft'); eng.softDrop(); break;
        case 'ArrowUp':
        case 'x': case 'X': if (eng.rotate(1)) audio.rotate(); break;
        case 'z': case 'Z':
        case 'Control': if (eng.rotate(-1)) audio.rotate(); break;
        case 'a': case 'A': eng.rotate(1); if (eng.rotate(1)) audio.rotate(); break;
        case ' ': eng.hardDrop(); audio.hardDrop(); this._sendState(); break;
        case 'Shift':
        case 'c': case 'C': { const could = eng.canHold && !eng.gameOver; eng.holdPiece(); if (could) audio.hold(); break; }
      }
    };
    this.handleKeyUp = (e) => {
      switch (e.key) {
        case 'ArrowLeft':  this._release('left'); break;
        case 'ArrowRight': this._release('right'); break;
        case 'ArrowDown':  this._release('soft'); break;
      }
    };
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
  }

  _press(dir) {
    this.keys[dir] = { held: true, dasTimer: 0, arrTimer: 0, fired: false };
  }
  _release(dir) { delete this.keys[dir]; }

  // Called by the on-screen touch buttons. phase is 'start' or 'end'.
  // Movement buttons reuse the keyboard DAS/ARR state so holding repeats.
  touchAction(act, phase) {
    if (!this.engine || !this.running || this.paused) return;
    const eng = this.engine;
    if (phase === 'start') {
      switch (act) {
        case 'left':     if (eng.move(-1, 0)) audio.move(); this._press('left'); break;
        case 'right':    if (eng.move(1, 0)) audio.move();  this._press('right'); break;
        case 'softdrop': eng.softDrop();  this._press('soft'); break;
        case 'cw':       if (eng.rotate(1)) audio.rotate(); break;
        case 'ccw':      if (eng.rotate(-1)) audio.rotate(); break;
        case 'harddrop': eng.hardDrop(); audio.hardDrop(); this._sendState(); break;
        case 'hold':     { const could = eng.canHold && !eng.gameOver; eng.holdPiece(); if (could) audio.hold(); break; }
      }
    } else {
      if (act === 'left') this._release('left');
      else if (act === 'right') this._release('right');
      else if (act === 'softdrop') this._release('soft');
    }
  }

  _handleAutoRepeat(dt) {
    const eng = this.engine;
    for (const dir of ['left', 'right']) {
      const k = this.keys[dir];
      if (!k) continue;
      k.dasTimer += dt;
      if (k.dasTimer >= DAS) {
        k.arrTimer += dt;
        while (k.arrTimer >= ARR) {
          k.arrTimer -= ARR;
          eng.move(dir === 'left' ? -1 : 1, 0);
        }
      }
    }
    const s = this.keys.soft;
    if (s) {
      s.arrTimer += dt;
      while (s.arrTimer >= SOFT) { s.arrTimer -= SOFT; eng.softDrop(); }
    }
  }

  // ---- loop --------------------------------------------------------------
  _loop() {
    if (!this.running) return;
    const now = performance.now();
    const dt = Math.min(now - this.lastTime, 100);
    this.lastTime = now;

    // While paused the board stays frozen but visible; just keep the frame alive.
    if (this.paused) { requestAnimationFrame(() => this._loop()); return; }

    this._handleAutoRepeat(dt);
    this.engine.tick(dt);

    // periodically push our board to the opponent
    this.stateTimer += dt;
    if (this.stateTimer >= 120) { this.stateTimer = 0; this._sendState(); }

    if (this.attackFlash > 0) this.attackFlash = Math.max(0, this.attackFlash - dt / 400);

    this._render();
    this.onStats({
      score: this.engine.score,
      lines: this.engine.lines,
      pending: this.engine.pendingGarbage.length,
    });

    requestAnimationFrame(() => this._loop());
  }

  // Called by the engine after a piece locks; plays clear/lock SFX then syncs.
  _onLock(info = {}) {
    if (info.cleared > 0) audio.lineClear(info.cleared, info.tspin, info.perfectClear);
    else audio.lock();
    this._sendState();
  }

  _sendState() {
    if (!this.net || !this.engine) return;
    // compact board: array of color strings or null
    this.net.send({
      type: 'state', board: this.engine.board,
      score: this.engine.score, lines: this.engine.lines,
    });
  }

  // ---- rendering ---------------------------------------------------------
  _drawCell(ctx, x, y, size, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(x, y, size, size * 0.18);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(x, y + size * 0.82, size, size * 0.18);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
  }

  _render() {
    const ctx = this.ctx, cell = this.cell;
    ctx.fillStyle = BOARD.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // grid
    ctx.strokeStyle = BOARD.grid;
    ctx.lineWidth = 1;
    for (let c = 0; c <= COLS; c++) {
      ctx.beginPath(); ctx.moveTo(c * cell, 0); ctx.lineTo(c * cell, ROWS * cell); ctx.stroke();
    }
    for (let r = 0; r <= ROWS; r++) {
      ctx.beginPath(); ctx.moveTo(0, r * cell); ctx.lineTo(COLS * cell, r * cell); ctx.stroke();
    }

    const eng = this.engine;
    // settled board
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (eng.board[r][c]) this._drawCell(ctx, c * cell, r * cell, cell, eng.board[r][c]);
      }
    }

    // ghost
    if (!eng.gameOver) {
      const gy = eng.ghostY();
      const ghost = { ...eng.piece, y: gy };
      ctx.globalAlpha = 0.25;
      for (const [r, c] of eng.cells(ghost)) {
        if (r >= 0) this._drawCell(ctx, c * cell, r * cell, cell, COLORS[eng.piece.type]);
      }
      ctx.globalAlpha = 1;
      // active piece
      for (const [r, c] of eng.cells(eng.piece)) {
        if (r >= 0) this._drawCell(ctx, c * cell, r * cell, cell, COLORS[eng.piece.type]);
      }
    }

    // attack flash border
    if (this.attackFlash > 0) {
      ctx.strokeStyle = `rgba(248,113,113,${this.attackFlash})`;
      ctx.lineWidth = 6;
      ctx.strokeRect(3, 3, this.canvas.width - 6, this.canvas.height - 6);
    }

    // pending garbage bar (left edge)
    if (eng.pendingGarbage.length > 0) {
      const h = Math.min(ROWS, eng.pendingGarbage.length) * cell;
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(0, this.canvas.height - h, 5, h);
    }

    this._renderHold();
    this._renderNext();
    this._renderOpp();
  }

  _renderPreview(ctx, type, big = false) {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (!type) return;
    const cells = PREVIEW[type];
    const size = big ? 18 : 16;
    const w = type === 'I' ? 4 : type === 'O' ? 4 : 3;
    const offX = (ctx.canvas.width - w * size) / 2;
    const offY = (ctx.canvas.height - 2 * size) / 2;
    for (const [r, c] of cells) {
      this._drawCell(ctx, offX + c * size, offY + r * size, size, COLORS[type]);
    }
  }

  _renderHold() {
    this._renderPreview(this.holdCtx, this.engine.hold);
  }

  _renderNext() {
    const ctx = this.nextCtx;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    const size = 16;
    for (let i = 0; i < Math.min(5, this.engine.queue.length); i++) {
      const type = this.engine.queue[i];
      const cells = PREVIEW[type];
      const w = type === 'I' || type === 'O' ? 4 : 3;
      const offX = (ctx.canvas.width - w * size) / 2;
      const offY = 10 + i * (size * 2.6);
      for (const [r, c] of cells) {
        this._drawCell(ctx, offX + c * size, offY + r * size, size, COLORS[type]);
      }
    }
  }

  _renderOpp() {
    if (!this.oppCtx) return;
    const ctx = this.oppCtx;
    const cell = ctx.canvas.width / COLS;
    ctx.fillStyle = BOARD.bg;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (!this.oppBoard) return;
    for (let r = 0; r < ROWS; r++) {
      const row = this.oppBoard[r];
      if (!row) continue;
      for (let c = 0; c < COLS; c++) {
        if (row[c]) this._drawCell(ctx, c * cell, r * cell, cell, row[c]);
      }
    }
  }

  destroy() {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
  }
}
