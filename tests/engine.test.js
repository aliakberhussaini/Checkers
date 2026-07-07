/*
 * tests/engine.test.js — plain node test script for engine.js.
 * Prints PASS/FAIL per case; exits 1 on any failure.
 */
'use strict';

const E = require('../engine.js');

let failures = 0;
let passes = 0;

function check(name, cond, detail) {
  if (cond) {
    passes++;
    console.log('PASS ' + name);
  } else {
    failures++;
    console.log('FAIL ' + name + (detail !== undefined ? ' — ' + detail : ''));
  }
}

function deepEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function emptyBoard() {
  const board = [];
  for (let r = 0; r < 8; r++) {
    const row = [];
    for (let c = 0; c < 8; c++) row.push(null);
    board.push(row);
  }
  return board;
}

// pieces: array of [r, c, 'R'|'B', king?]
function makeState(pieces, turn, quiet, ply) {
  const board = emptyBoard();
  for (const [r, c, p, k] of pieces) board[r][c] = { p, k: !!k };
  return { board, turn, quiet: quiet || 0, ply: ply || 0 };
}

function normMove(m) {
  return JSON.stringify({ from: m.from, path: m.path, captures: m.captures });
}

function hasMove(moves, m) {
  const key = normMove(m);
  return moves.some((x) => normMove(x) === key);
}

function movesetEquals(moves, expected) {
  if (moves.length !== expected.length) return false;
  const a = moves.map(normMove).sort();
  const b = expected.map(normMove).sort();
  return deepEq(a, b);
}

// ---------------------------------------------------------------- constants
check('constants RED/BLACK', E.RED === 'R' && E.BLACK === 'B');

// ------------------------------------------------------------ initial setup
{
  const s = E.initialState();
  let red = 0, black = 0, misplaced = 0, kings = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = s.board[r][c];
      if (!cell) continue;
      if ((r + c) % 2 !== 1) misplaced++;
      if (cell.k) kings++;
      if (cell.p === 'R') {
        red++;
        if (r < 5) misplaced++;
      } else if (cell.p === 'B') {
        black++;
        if (r > 2) misplaced++;
      }
    }
  }
  check('initial: 12 red pieces', red === 12, 'got ' + red);
  check('initial: 12 black pieces', black === 12, 'got ' + black);
  check('initial: all pieces on correct dark squares', misplaced === 0);
  check('initial: no kings', kings === 0);
  check('initial: Red to move', s.turn === 'R');
  check('initial: quiet=0 ply=0', s.quiet === 0 && s.ply === 0);
  check('initial: sample squares', deepEq(s.board[0][1], { p: 'B', k: false }) &&
    deepEq(s.board[7][0], { p: 'R', k: false }) && s.board[3][4] === null && s.board[0][0] === null);
  check('initial: winner is null', E.winner(s) === null);
}

// ------------------------------------------------- simple man moves (both colors)
{
  const s = E.initialState();
  const red = E.legalMoves(s);
  check('red opening: 7 simple moves', red.length === 7, 'got ' + red.length);
  check('red opening: no captures', red.every((m) => m.captures.length === 0));
  check('red opening: all forward (row 5 -> row 4)',
    red.every((m) => m.from[0] === 5 && m.path.length === 1 && m.path[0][0] === 4));
  check('red opening: contains (5,2)->(4,3)',
    hasMove(red, { from: [5, 2], path: [[4, 3]], captures: [] }));
  check('red opening: contains (5,0)->(4,1)',
    hasMove(red, { from: [5, 0], path: [[4, 1]], captures: [] }));

  const sb = E.clone(s);
  sb.turn = 'B';
  const black = E.legalMoves(sb);
  check('black opening: 7 simple moves', black.length === 7, 'got ' + black.length);
  check('black opening: all forward (row 2 -> row 3)',
    black.every((m) => m.from[0] === 2 && m.path.length === 1 && m.path[0][0] === 3));
  check('black opening: contains (2,1)->(3,2)',
    hasMove(black, { from: [2, 1], path: [[3, 2]], captures: [] }));
  check('black opening: contains (2,7)->(3,6)',
    hasMove(black, { from: [2, 7], path: [[3, 6]], captures: [] }));
}

// ------------------------------------------------------- forced-capture filtering
{
  // Red man (5,2) can jump black (4,3); red man (6,5) has free simple moves.
  const s = makeState([[5, 2, 'R'], [6, 5, 'R'], [4, 3, 'B'], [0, 1, 'B']], 'R');
  const moves = E.legalMoves(s);
  check('forced capture: only captures returned', moves.length > 0 && moves.every((m) => m.captures.length > 0),
    JSON.stringify(moves));
  check('forced capture: exactly the one jump', movesetEquals(moves,
    [{ from: [5, 2], path: [[3, 4]], captures: [[4, 3]] }]));

  // Black side: black man (2,3) can jump red (3,4); black (0,1) has simple moves.
  const s2 = makeState([[2, 3, 'B'], [0, 1, 'B'], [3, 4, 'R'], [7, 0, 'R']], 'B');
  const m2 = E.legalMoves(s2);
  check('forced capture (black): only captures returned', movesetEquals(m2,
    [{ from: [2, 3], path: [[4, 5]], captures: [[3, 4]] }]));
}

// --------------------------------------------------------- multi-jump: double
{
  // (6,1) jumps (5,2) -> (4,3), then (3,4) -> (2,5). Must be fully expanded.
  const s = makeState([[6, 1, 'R'], [5, 2, 'B'], [3, 4, 'B'], [0, 7, 'B']], 'R');
  const moves = E.legalMoves(s);
  check('double jump: single fully-expanded move', movesetEquals(moves,
    [{ from: [6, 1], path: [[4, 3], [2, 5]], captures: [[5, 2], [3, 4]] }]),
    JSON.stringify(moves));
  check('double jump: no partial jump offered',
    !moves.some((m) => m.path.length === 1));
  const after = E.applyMove(s, moves[0]);
  check('double jump: both captured pieces removed',
    after.board[5][2] === null && after.board[3][4] === null &&
    deepEq(after.board[2][5], { p: 'R', k: false }) && after.board[6][1] === null);
}

// --------------------------------------------------------- multi-jump: triple
{
  // (7,0) over (6,1)->(5,2), over (4,3)->(3,4), over (2,5)->(1,6).
  const s = makeState([[7, 0, 'R'], [6, 1, 'B'], [4, 3, 'B'], [2, 5, 'B']], 'R');
  const moves = E.legalMoves(s);
  check('triple jump: single fully-expanded move', movesetEquals(moves,
    [{ from: [7, 0], path: [[5, 2], [3, 4], [1, 6]], captures: [[6, 1], [4, 3], [2, 5]] }]),
    JSON.stringify(moves));
  const after = E.applyMove(s, moves[0]);
  check('triple jump: all three captured, no promotion (row 1)',
    after.board[6][1] === null && after.board[4][3] === null && after.board[2][5] === null &&
    deepEq(after.board[1][6], { p: 'R', k: false }));
}

// ------------------------------------------------- branching multi-jumps
{
  // (6,3) can jump left over (5,2)->(4,1) then (3,2)->(2,3),
  // or right over (5,4)->(4,5) then (3,4)->(2,3). Both complete sequences.
  const s = makeState([[6, 3, 'R'], [5, 2, 'B'], [5, 4, 'B'], [3, 2, 'B'], [3, 4, 'B']], 'R');
  const moves = E.legalMoves(s);
  check('branching: every complete sequence returned', movesetEquals(moves, [
    { from: [6, 3], path: [[4, 1], [2, 3]], captures: [[5, 2], [3, 2]] },
    { from: [6, 3], path: [[4, 5], [2, 3]], captures: [[5, 4], [3, 4]] }
  ]), JSON.stringify(moves));
}

// --------------------------------------- promotion mid-jump ends the move
{
  // Red man (2,1) jumps (1,2) -> lands (0,3) = promotion row. Black at (1,4)
  // would be jumpable by a king, but the move must end at promotion.
  const s = makeState([[2, 1, 'R'], [1, 2, 'B'], [1, 4, 'B']], 'R');
  const moves = E.legalMoves(s);
  check('promotion mid-jump: sequence stops at crowning square', movesetEquals(moves,
    [{ from: [2, 1], path: [[0, 3]], captures: [[1, 2]] }]),
    JSON.stringify(moves));
  const after = E.applyMove(s, moves[0]);
  check('promotion mid-jump: piece is now a king', deepEq(after.board[0][3], { p: 'R', k: true }));
  check('promotion mid-jump: uninvolved black piece survives', deepEq(after.board[1][4], { p: 'B', k: false }));
  check('promotion mid-jump: quiet reset to 0', after.quiet === 0);

  // Black mirror: black man (5,2) jumps (6,3) -> (7,4) promotion row; red at (6,5) untouched.
  const sb = makeState([[5, 2, 'B'], [6, 3, 'R'], [6, 5, 'R']], 'B');
  const mb = E.legalMoves(sb);
  check('promotion mid-jump (black): stops at row 7', movesetEquals(mb,
    [{ from: [5, 2], path: [[7, 4]], captures: [[6, 3]] }]));
}

// ------------------------------------------- king moves in all 4 directions
{
  const s = makeState([[4, 3, 'R', true], [0, 1, 'B']], 'R');
  const moves = E.legalMoves(s);
  check('king: 4 one-step moves in 4 directions', movesetEquals(moves, [
    { from: [4, 3], path: [[3, 2]], captures: [] },
    { from: [4, 3], path: [[3, 4]], captures: [] },
    { from: [4, 3], path: [[5, 2]], captures: [] },
    { from: [4, 3], path: [[5, 4]], captures: [] }
  ]), JSON.stringify(moves));
  check('king: no flying moves (all destinations adjacent)',
    moves.every((m) => Math.abs(m.path[0][0] - 4) === 1 && Math.abs(m.path[0][1] - 3) === 1));
}

// ------------------------------------------- king jumps in all 4 directions
{
  const s = makeState([
    [4, 3, 'R', true],
    [3, 2, 'B'], [3, 4, 'B'], [5, 2, 'B'], [5, 4, 'B']
  ], 'R');
  const moves = E.legalMoves(s);
  check('king: jumps available in all 4 directions', movesetEquals(moves, [
    { from: [4, 3], path: [[2, 1]], captures: [[3, 2]] },
    { from: [4, 3], path: [[2, 5]], captures: [[3, 4]] },
    { from: [4, 3], path: [[6, 1]], captures: [[5, 2]] },
    { from: [4, 3], path: [[6, 5]], captures: [[5, 4]] }
  ]), JSON.stringify(moves));

  // King multi-jump including a backward leg: (2,1) over (3,2)->(4,3), over (5,4)->(6,5).
  const s2 = makeState([[2, 1, 'R', true], [3, 2, 'B'], [5, 4, 'B']], 'R');
  const m2 = E.legalMoves(s2);
  check('king: backward multi-jump fully expanded', movesetEquals(m2,
    [{ from: [2, 1], path: [[4, 3], [6, 5]], captures: [[3, 2], [5, 4]] }]),
    JSON.stringify(m2));
  const after2 = E.applyMove(s2, m2[0]);
  check('king: stays a king after moving', deepEq(after2.board[6][5], { p: 'R', k: true }));
}

// ------------------------------------------------- applyMove immutability
{
  const s = E.initialState();
  const snapshot = JSON.parse(JSON.stringify(s));
  const move = E.legalMoves(s).find((m) => normMove(m) === normMove({ from: [5, 2], path: [[4, 3]], captures: [] }));
  const next = E.applyMove(s, move);
  check('applyMove: input state unchanged (deep equal)', deepEq(s, snapshot));
  check('applyMove: returns a new object', next !== s && next.board !== s.board);
  check('applyMove: move applied in result',
    next.board[5][2] === null && deepEq(next.board[4][3], { p: 'R', k: false }));
  check('applyMove: turn switched, ply incremented', next.turn === 'B' && next.ply === s.ply + 1);

  const capState = makeState([[5, 2, 'R'], [4, 3, 'B']], 'R', 7, 20);
  const capSnap = JSON.parse(JSON.stringify(capState));
  E.applyMove(capState, E.legalMoves(capState)[0]);
  check('applyMove: capture move also leaves input unchanged', deepEq(capState, capSnap));

  const c = E.clone(s);
  c.board[5][2] = null;
  c.turn = 'B';
  check('clone: mutations do not leak back', deepEq(s.board[5][2], { p: 'R', k: false }) && s.turn === 'R');
}

// ------------------------------------------------- winner by capture-all
{
  // Red to move with zero red pieces -> no legal moves -> Black wins.
  const s = makeState([[2, 3, 'B'], [1, 2, 'B']], 'R');
  check('winner: capture-all (Red wiped) -> B', E.winner(s) === 'B');
  const s2 = makeState([[5, 2, 'R']], 'B');
  check('winner: capture-all (Black wiped) -> R', E.winner(s2) === 'R');
}

// ------------------------------------------------- winner by blocked
{
  // Red man (7,0) blocked: (6,1) occupied by black, jump landing (5,2) occupied.
  const s = makeState([[7, 0, 'R'], [6, 1, 'B'], [5, 2, 'B']], 'R');
  check('winner: blocked red (pieces present, no moves) -> B',
    E.legalMoves(s).length === 0 && E.winner(s) === 'B');

  // Black mirror: black man (0,7) blocked by red at (1,6) and (2,5).
  const s2 = makeState([[0, 7, 'B'], [1, 6, 'R'], [2, 5, 'R']], 'B');
  check('winner: blocked black -> R', E.legalMoves(s2).length === 0 && E.winner(s2) === 'R');
}

// ------------------------------------------------- draw via quiet >= 80
{
  const s = makeState([[5, 2, 'R'], [2, 3, 'B']], 'R', 80, 120);
  check('winner: quiet=80 -> draw', E.winner(s) === 'draw');
  const s81 = makeState([[5, 2, 'R'], [2, 3, 'B']], 'R', 81, 121);
  check('winner: quiet=81 -> draw', E.winner(s81) === 'draw');
  const s79 = makeState([[5, 2, 'R'], [2, 3, 'B']], 'R', 79, 119);
  check('winner: quiet=79 with moves -> null', E.winner(s79) === null);
}

// ---------------------------------- quiet counter: increment / reset rules
{
  // Simple move increments quiet.
  const s = makeState([[5, 2, 'R'], [1, 2, 'B']], 'R', 5, 10);
  const quietMove = E.legalMoves(s).find((m) => m.captures.length === 0);
  const afterQuiet = E.applyMove(s, quietMove);
  check('quiet: +1 on simple non-promoting move', afterQuiet.quiet === 6 && afterQuiet.ply === 11);

  // Capture resets quiet.
  const sc = makeState([[5, 2, 'R'], [4, 3, 'B'], [0, 1, 'B']], 'R', 12, 30);
  const capMove = E.legalMoves(sc)[0];
  const afterCap = E.applyMove(sc, capMove);
  check('quiet: reset to 0 on capture', capMove.captures.length === 1 && afterCap.quiet === 0);

  // Non-capture promotion resets quiet.
  const sp = makeState([[1, 2, 'R'], [7, 6, 'B']], 'R', 9, 40);
  const proMove = E.legalMoves(sp).find((m) => m.path[0][0] === 0);
  const afterPro = E.applyMove(sp, proMove);
  check('quiet: reset to 0 on promotion', proMove.captures.length === 0 && afterPro.quiet === 0 &&
    afterPro.board[proMove.path[0][0]][proMove.path[0][1]].k === true);
}

// ------------------------------------- cyclic multi-jump (origin re-entry)
{
  // Red king (4,1) ringed by four black men. The only complete sequences are
  // the two 4-capture cycles (clockwise / counterclockwise) that land back ON
  // the origin square: legal only because the mover vacates (4,1) at lift-off,
  // and each captured piece is removed as jumped so none is jumped twice.
  const s = makeState([
    [4, 1, 'R', true],
    [3, 2, 'B'], [3, 4, 'B'], [5, 4, 'B'], [5, 2, 'B']
  ], 'R');
  const moves = E.legalMoves(s);
  check('cyclic jump: exactly the two full 4-capture cycles', movesetEquals(moves, [
    { from: [4, 1], path: [[2, 3], [4, 5], [6, 3], [4, 1]], captures: [[3, 2], [3, 4], [5, 4], [5, 2]] },
    { from: [4, 1], path: [[6, 3], [4, 5], [2, 3], [4, 1]], captures: [[5, 2], [5, 4], [3, 4], [3, 2]] }
  ]), JSON.stringify(moves));
  check('cyclic jump: no piece jumped twice in any sequence',
    moves.every((m) => new Set(m.captures.map(String)).size === m.captures.length));
  check('cyclic jump: no partial sequence offered',
    moves.every((m) => m.captures.length === 4));
  const after = E.applyMove(s, moves[0]);
  let blacksLeft = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (after.board[r][c] && after.board[r][c].p === 'B') blacksLeft++;
  }
  check('cyclic jump: all four black men captured, king back on origin',
    blacksLeft === 0 && deepEq(after.board[4][1], { p: 'R', k: true }));
}

// --------------------- forced-capture enumeration across MULTIPLE jumpers
{
  // Two separate red men each have a capture; the red man at (7,0) has only
  // simple moves. Every jumper's sequence must be enumerated (a mutant that
  // stops after the first jumping piece must fail), and the simple mover
  // must be excluded by the forced-capture rule.
  const s = makeState([
    [5, 2, 'R'], [5, 6, 'R'], [7, 0, 'R'],
    [4, 3, 'B'], [4, 5, 'B']
  ], 'R');
  const moves = E.legalMoves(s);
  check('multiple jumpers: sequences from BOTH jumping pieces returned', movesetEquals(moves, [
    { from: [5, 2], path: [[3, 4]], captures: [[4, 3]] },
    { from: [5, 6], path: [[3, 4]], captures: [[4, 5]] }
  ]), JSON.stringify(moves));
  check('multiple jumpers: distinct origins present',
    new Set(moves.map((m) => String(m.from))).size === 2);
  check('multiple jumpers: non-capturing piece contributes no moves',
    moves.every((m) => m.captures.length > 0));
}

// ---------------------- king reaching the far row does NOT reset quiet
{
  // Promotion resets quiet only for men (guard !piece.k): a piece that is
  // ALREADY a king landing on the far row is a plain quiet move.
  const s = makeState([[1, 2, 'R', true], [7, 6, 'B']], 'R', 5, 10);
  const toFarRow = E.legalMoves(s).find((m) => m.path[0][0] === 0 && m.path[0][1] === 1);
  check('king far-row setup: king can step onto row 0', !!toFarRow);
  const after = E.applyMove(s, toFarRow);
  check('king far row: quiet incremented, not reset',
    after.quiet === 6 && after.ply === 11, 'quiet=' + after.quiet);
  check('king far row: piece unchanged (still a king)',
    deepEq(after.board[0][1], { p: 'R', k: true }));
}

// ------------------------------------------------- legalMoves purity
{
  // legalMoves works on a scratch board (lift-off + capture removal/restore);
  // the input state must come back bit-identical, including on positions
  // exercising a mid-jump promotion stop and cyclic multi-jump expansion.
  const positions = [
    ['initial', E.initialState()],
    ['mid-jump promotion stop', makeState([[2, 1, 'R'], [1, 2, 'B'], [1, 4, 'B']], 'R', 3, 12)],
    ['cyclic multi-jump', makeState([
      [4, 1, 'R', true], [3, 2, 'B'], [3, 4, 'B'], [5, 4, 'B'], [5, 2, 'B']
    ], 'R', 7, 40)]
  ];
  for (const [label, s] of positions) {
    const snapshot = JSON.stringify(s);
    E.legalMoves(s);
    check('legalMoves purity: ' + label + ' state bit-identical',
      JSON.stringify(s) === snapshot);
  }
}

// --------------------------------------------------------------- hash
{
  const s = E.initialState();
  const h = E.hash(s);
  check('hash: format 32 dark squares + :turn', /^[.rRbB]{32}:[RB]$/.test(h), h);
  check('hash: initial counts 12 r / 12 b',
    (h.match(/r/g) || []).length === 12 && (h.match(/b/g) || []).length === 12);
  check('hash: initial layout string',
    h === 'bbbbbbbbbbbb........rrrrrrrrrrrr:R');

  const afterMove = E.applyMove(s, E.legalMoves(s)[0]);
  check('hash: differs across positions', E.hash(afterMove) !== h);

  const sameBoardB = E.clone(s);
  sameBoardB.turn = 'B';
  check('hash: differs across turn with identical board',
    E.hash(sameBoardB) !== h && E.hash(sameBoardB).slice(0, 32) === h.slice(0, 32));

  const kingState = makeState([[4, 3, 'R', true], [2, 3, 'B', true]], 'B');
  const kh = E.hash(kingState);
  check('hash: kings encoded as uppercase R/B', kh.slice(0, 32).includes('R') && kh.slice(0, 32).includes('B') &&
    !kh.slice(0, 32).includes('r') && !kh.slice(0, 32).includes('b'), kh);
  check('hash: stable (same state hashes equal)', E.hash(kingState) === kh &&
    E.hash(E.clone(kingState)) === kh);
}

// --------------------------------------------------------------- summary
console.log('---');
console.log(passes + ' passed, ' + failures + ' failed, ' + (passes + failures) + ' total');
if (failures > 0) process.exit(1);
