/*
 * engine.js — American checkers (English draughts) rules engine.
 * Attaches one global `CheckersEngine`; CommonJS guard for node tests.
 * See SPEC.md: "Game rules", "State shape", "Move shape", "Engine API".
 */
(function (global) {
  'use strict';

  const RED = 'R';
  const BLACK = 'B';
  const SIZE = 8;

  function inBounds(r, c) {
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  }

  function isDark(r, c) {
    return (r + c) % 2 === 1;
  }

  function promotionRow(p) {
    return p === RED ? 0 : SIZE - 1;
  }

  function directionsFor(piece) {
    if (piece.k) return [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    // Red moves toward decreasing row; Black toward increasing row.
    return piece.p === RED ? [[-1, -1], [-1, 1]] : [[1, -1], [1, 1]];
  }

  function cloneBoard(board) {
    const out = new Array(SIZE);
    for (let r = 0; r < SIZE; r++) {
      const row = new Array(SIZE);
      for (let c = 0; c < SIZE; c++) {
        const cell = board[r][c];
        row[c] = cell ? { p: cell.p, k: cell.k } : null;
      }
      out[r] = row;
    }
    return out;
  }

  function clone(state) {
    return {
      board: cloneBoard(state.board),
      turn: state.turn,
      quiet: state.quiet,
      ply: state.ply
    };
  }

  function initialState() {
    const board = new Array(SIZE);
    for (let r = 0; r < SIZE; r++) {
      const row = new Array(SIZE);
      for (let c = 0; c < SIZE; c++) {
        if (isDark(r, c) && r <= 2) row[c] = { p: BLACK, k: false };
        else if (isDark(r, c) && r >= 5) row[c] = { p: RED, k: false };
        else row[c] = null;
      }
      board[r] = row;
    }
    return { board, turn: RED, quiet: 0, ply: 0 };
  }

  /*
   * Depth-first expansion of every complete jump sequence for `piece`,
   * which has (conceptually) been lifted off the board; `board` is a
   * scratch copy that is mutated and restored during the search.
   * Rules honored:
   *  - after a jump the piece must keep jumping if it can (only complete
   *    sequences are emitted);
   *  - a man that lands on the promotion row stops immediately (no
   *    continuing as a king);
   *  - captured pieces are removed as they are jumped, so no piece can
   *    be jumped twice.
   */
  function jumpSequences(board, startR, startC, piece) {
    const results = [];
    const dirs = directionsFor(piece);

    function dfs(cr, cc, path, captures) {
      let extended = false;
      for (let i = 0; i < dirs.length; i++) {
        const dr = dirs[i][0];
        const dc = dirs[i][1];
        const mr = cr + dr;
        const mc = cc + dc;
        const lr = cr + 2 * dr;
        const lc = cc + 2 * dc;
        if (!inBounds(lr, lc)) continue;
        const mid = board[mr][mc];
        if (!mid || mid.p === piece.p) continue;
        if (board[lr][lc] !== null) continue;

        extended = true;
        board[mr][mc] = null; // captured piece removed for the rest of this line
        const newPath = path.concat([[lr, lc]]);
        const newCaps = captures.concat([[mr, mc]]);
        if (!piece.k && lr === promotionRow(piece.p)) {
          // Promotion mid-jump ends the move immediately.
          results.push({ path: newPath, captures: newCaps });
        } else {
          dfs(lr, lc, newPath, newCaps);
        }
        board[mr][mc] = mid; // restore
      }
      if (!extended && path.length > 0) {
        results.push({ path: path, captures: captures });
      }
    }

    dfs(startR, startC, [], []);
    return results;
  }

  function legalMoves(state) {
    const side = state.turn;
    const scratch = cloneBoard(state.board); // never mutate the input state
    const jumps = [];

    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const piece = scratch[r][c];
        if (!piece || piece.p !== side) continue;
        scratch[r][c] = null; // lift the moving piece (it may re-cross its origin)
        const seqs = jumpSequences(scratch, r, c, piece);
        scratch[r][c] = piece;
        for (let i = 0; i < seqs.length; i++) {
          jumps.push({ from: [r, c], path: seqs[i].path, captures: seqs[i].captures });
        }
      }
    }

    // Forced captures: if any capture exists, only captures are legal.
    if (jumps.length > 0) return jumps;

    const simples = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const piece = scratch[r][c];
        if (!piece || piece.p !== side) continue;
        const dirs = directionsFor(piece);
        for (let i = 0; i < dirs.length; i++) {
          const nr = r + dirs[i][0];
          const nc = c + dirs[i][1];
          if (inBounds(nr, nc) && scratch[nr][nc] === null) {
            simples.push({ from: [r, c], path: [[nr, nc]], captures: [] });
          }
        }
      }
    }
    return simples;
  }

  function applyMove(state, move) {
    const next = clone(state); // pure: never mutates its input
    const fr = move.from[0];
    const fc = move.from[1];
    const piece = next.board[fr][fc];
    next.board[fr][fc] = null;

    for (let i = 0; i < move.captures.length; i++) {
      next.board[move.captures[i][0]][move.captures[i][1]] = null;
    }

    const last = move.path[move.path.length - 1];
    const tr = last[0];
    const tc = last[1];
    let promoted = false;
    if (!piece.k && tr === promotionRow(piece.p)) {
      piece.k = true;
      promoted = true;
    }
    next.board[tr][tc] = piece;

    next.turn = state.turn === RED ? BLACK : RED;
    next.ply = state.ply + 1;
    next.quiet = (move.captures.length > 0 || promoted) ? 0 : state.quiet + 1;
    return next;
  }

  function winner(state) {
    if (state.quiet >= 80) return 'draw';
    if (legalMoves(state).length === 0) {
      return state.turn === RED ? BLACK : RED; // side to move loses
    }
    return null;
  }

  // Stable compact key: 32 dark squares row-major as . r R b B, then ':' + turn.
  function hash(state) {
    let s = '';
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (!isDark(r, c)) continue;
        const cell = state.board[r][c];
        if (!cell) s += '.';
        else if (cell.p === RED) s += cell.k ? 'R' : 'r';
        else s += cell.k ? 'B' : 'b';
      }
    }
    return s + ':' + state.turn;
  }

  const CheckersEngine = {
    RED,
    BLACK,
    initialState,
    legalMoves,
    applyMove,
    winner,
    hash,
    clone
  };

  global.CheckersEngine = CheckersEngine;
  if (typeof module !== 'undefined' && module.exports) module.exports = CheckersEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
