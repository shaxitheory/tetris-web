// Visual themes for TETRA. Each theme retints three layers at once:
//   1. `vars`   — CSS custom properties that drive the whole UI chrome.
//   2. `pieces` — tetromino colors (mutated into the engine's COLORS so both
//                 the active piece and already-locked cells use them).
//   3. `board`  — canvas background + grid color used by the renderer.
//
// applyTheme() updates all three in place and remembers the choice. The engine's
// COLORS object and the BOARD object are the same references the renderer holds,
// so a theme switch in the menu takes effect instantly without rewiring anything.
import { COLORS } from './engine.js';

// Live board-canvas colors. game.js imports this object and reads it every frame.
export const BOARD = { bg: '#0a0e1a', grid: 'rgba(255,255,255,0.04)' };

export const THEMES = {
  neon: {
    name: 'Neon',
    pieces: { I: '#22d3ee', O: '#facc15', T: '#a855f7', S: '#4ade80', Z: '#f87171', J: '#3b82f6', L: '#fb923c', G: '#6b7280' },
    board: { bg: '#0a0e1a', grid: 'rgba(255,255,255,0.04)' },
    vars: {
      '--bg': '#070a14', '--bg-glow': '#16203a',
      '--panel': '#121826', '--panel-2': '#1b2236',
      '--accent': '#22d3ee', '--accent-2': '#a855f7',
      '--text': '#e5e9f0', '--muted': '#8b95a8',
      '--border': '#2a3346', '--border-soft': '#222b3e',
      '--on-accent': '#07101a', '--glow': 'rgba(34,211,238,0.30)',
    },
  },

  cyber: {
    name: 'Cyberpunk',
    pieces: { I: '#00f0ff', O: '#faff00', T: '#ff2bd6', S: '#00ff9d', Z: '#ff3b6b', J: '#5b6bff', L: '#ff9e1f', G: '#5a4a66' },
    board: { bg: '#0c0616', grid: 'rgba(255,43,214,0.07)' },
    vars: {
      '--bg': '#0a0612', '--bg-glow': '#3a0a4d',
      '--panel': '#160a22', '--panel-2': '#221033',
      '--accent': '#ff2bd6', '--accent-2': '#faff00',
      '--text': '#f5e8ff', '--muted': '#9a7fb0',
      '--border': '#3a1f4d', '--border-soft': '#2a1538',
      '--on-accent': '#15001a', '--glow': 'rgba(255,43,214,0.35)',
    },
  },

  aurora: {
    name: 'Aurora',
    pieces: { I: '#22d3ee', O: '#a3e635', T: '#818cf8', S: '#34d399', Z: '#fb7185', J: '#38bdf8', L: '#fbbf24', G: '#527a82' },
    board: { bg: '#06161c', grid: 'rgba(45,212,191,0.06)' },
    vars: {
      '--bg': '#04141a', '--bg-glow': '#0a3a44',
      '--panel': '#0a1f28', '--panel-2': '#102e38',
      '--accent': '#2dd4bf', '--accent-2': '#38bdf8',
      '--text': '#e0f7fa', '--muted': '#7da3ac',
      '--border': '#1c3d47', '--border-soft': '#15303a',
      '--on-accent': '#022027', '--glow': 'rgba(45,212,191,0.28)',
    },
  },

  sunset: {
    name: 'Synthwave',
    pieces: { I: '#f472b6', O: '#fbbf24', T: '#c084fc', S: '#34d399', Z: '#fb7185', J: '#60a5fa', L: '#fb923c', G: '#6b5563' },
    board: { bg: '#1c0a20', grid: 'rgba(255,110,199,0.06)' },
    vars: {
      '--bg': '#1a0a1f', '--bg-glow': '#54164a',
      '--panel': '#2a0f2e', '--panel-2': '#3a1640',
      '--accent': '#ff6ec7', '--accent-2': '#ffb347',
      '--text': '#ffe8f5', '--muted': '#b98aa8',
      '--border': '#4a2050', '--border-soft': '#38163d',
      '--on-accent': '#25001a', '--glow': 'rgba(255,110,199,0.32)',
    },
  },

  mono: {
    name: 'Mono',
    // Low-saturation tints keep the minimalist look while staying distinguishable.
    pieces: { I: '#9ad8e0', O: '#ede9b8', T: '#c9b6e0', S: '#b6e0c2', Z: '#e6b8b8', J: '#b6c2e6', L: '#e6cdb6', G: '#4b4b52' },
    board: { bg: '#0b0b0d', grid: 'rgba(255,255,255,0.05)' },
    vars: {
      '--bg': '#0d0d0f', '--bg-glow': '#1f1f24',
      '--panel': '#161618', '--panel-2': '#1f1f23',
      '--accent': '#e5e5e5', '--accent-2': '#9ca3af',
      '--text': '#f4f4f5', '--muted': '#8a8a90',
      '--border': '#2c2c30', '--border-soft': '#232327',
      '--on-accent': '#0d0d0f', '--glow': 'rgba(255,255,255,0.18)',
    },
  },

  sakura: {
    name: 'Sakura',
    // The one light theme — board background is light and the grid lines go dark.
    pieces: { I: '#38bdf8', O: '#fbbf24', T: '#c084fc', S: '#34d399', Z: '#fb7185', J: '#6366f1', L: '#fb923c', G: '#cbb5be' },
    board: { bg: '#fdeef2', grid: 'rgba(0,0,0,0.06)' },
    vars: {
      '--bg': '#fff5f7', '--bg-glow': '#ffe4ec',
      '--panel': '#ffffff', '--panel-2': '#fdeef2',
      '--accent': '#f472b6', '--accent-2': '#fb7185',
      '--text': '#4a2c38', '--muted': '#9c7a87',
      '--border': '#f3d6df', '--border-soft': '#f8e4ea',
      '--on-accent': '#4a0d28', '--glow': 'rgba(244,114,182,0.30)',
    },
  },
};

export const DEFAULT_THEME = 'neon';
const STORE_KEY = 'tetra.theme';

export function savedThemeId() {
  const id = localStorage.getItem(STORE_KEY);
  return THEMES[id] ? id : DEFAULT_THEME;
}

let current = DEFAULT_THEME;
export function currentThemeId() { return current; }

export function applyTheme(id, persist = true) {
  const theme = THEMES[id] || THEMES[DEFAULT_THEME];
  current = THEMES[id] ? id : DEFAULT_THEME;

  // 1. CSS chrome
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
  root.setAttribute('data-theme', current);

  // 2. piece palette (same object the engine + renderer already hold)
  Object.assign(COLORS, theme.pieces);

  // 3. board canvas colors
  BOARD.bg = theme.board.bg;
  BOARD.grid = theme.board.grid;

  if (persist) localStorage.setItem(STORE_KEY, current);
}

// Apply the saved theme immediately on import so there's no unstyled flash.
applyTheme(savedThemeId(), false);
