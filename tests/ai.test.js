/*
 * tests/ai.test.js — proves the MAPE-K agent learns and adapts (SPEC "AI API"
 * and "Learning requirements"). Plain node script: PASS/FAIL per case,
 * exit(1) on any failure.
 */
'use strict';

const Engine = require('../engine.js');
const AI = require('../ai.js');

let passCount = 0;
let failCount = 0;

function check(name, cond, detail) {
  if (cond) {
    passCount++;
    console.log('PASS ' + name);
  } else {
    failCount++;
    console.log('FAIL ' + name + (detail ? ' :: ' + detail : ''));
  }
}

const key = AI.moveKey;

function emptyBoard() { return Array.from({ length: 8 }, () => Array(8).fill(null)); }
function put(b, r, c, p, k) { b[r][c] = { p: p, k: !!k }; }
function S(board, turn, ply, quiet) {
  return { board: board, turn: turn, quiet: quiet || 0, ply: ply === undefined ? 20 : ply };
}
function legalKeys(state) { return Engine.legalMoves(state).map(key); }
function isLegal(state, move) { return !!move && legalKeys(state).indexOf(key(move)) !== -1; }
function mem() { return new AI.MemoryStorage(); }
function agent(storage, storageKey) {
  return new AI.MapeKAgent({ storage: storage || 'memory', storageKey: storageKey || 'kb-test' });
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Synthetic exposure-prone player: R's move 5,2>4,3 lands next to B(3,4),
// which can then jump 3,4 -> 5,2. The alternative 5,2>4,1 is safe.
function exposureState() {
  const b = emptyBoard();
  put(b, 5, 2, 'R');
  put(b, 3, 4, 'B');
  return S(b, 'R', 20);
}
function trainExposure(a, n) {
  const st = exposureState();
  const lm = Engine.legalMoves(st);
  const mv = lm.filter(function (m) { return key(m) === '5,2>4,3'; })[0];
  for (let i = 0; i < n; i++) {
    a.monitor({ type: 'playerMove', before: st, move: mv, legalMoves: lm });
  }
  return mv;
}

// ---------------------------------------------------------------
console.log('--- structure: five explicit MAPE-K classes + public surface ---');
// ---------------------------------------------------------------
['MapeKAgent', 'Monitor', 'Analyzer', 'Planner', 'Executor', 'KnowledgeBase', 'MemoryStorage']
  .forEach(function (cls) {
    check('CheckersAI.' + cls + ' is a class', typeof AI[cls] === 'function');
  });
{
  const a = agent();
  check('public surface: monitor/chooseMove/getInsights/resetKnowledge',
    typeof a.monitor === 'function' && typeof a.chooseMove === 'function' &&
    typeof a.getInsights === 'function' && typeof a.resetKnowledge === 'function');
}

// ---------------------------------------------------------------
console.log('--- (1) knowledge persistence roundtrip + corrupt-data recovery ---');
// ---------------------------------------------------------------
{
  const shim = mem();
  const a1 = agent(shim, 'kb-t1');
  const s0 = Engine.initialState();
  const lm0 = Engine.legalMoves(s0);
  a1.monitor({ type: 'gameStart' });
  a1.monitor({ type: 'playerMove', before: s0, move: lm0[0], legalMoves: lm0 });
  const s1 = Engine.applyMove(s0, lm0[0]);
  const bm = Engine.legalMoves(s1)[0];
  a1.monitor({ type: 'aiMove', before: s1, move: bm });
  a1.monitor({ type: 'gameEnd', winner: 'B' });

  let persisted = null;
  try { persisted = JSON.parse(shim.getItem('kb-t1')); } catch (e) { persisted = null; }
  check('persisted knowledge is schema-versioned JSON',
    !!persisted && typeof persisted.schema === 'number',
    shim.getItem('kb-t1') === null ? 'nothing persisted' : 'unparseable');

  const a2 = agent(shim, 'kb-t1');
  const ins2 = a2.getInsights();
  check('roundtrip: gamesPlayed survives reload', ins2.knowledge.gamesPlayed === 1,
    'got ' + ins2.knowledge.gamesPlayed);
  check('roundtrip: record survives reload (AI Black won)',
    ins2.knowledge.record.w === 1 && ins2.knowledge.record.l === 0 && ins2.knowledge.record.d === 0,
    JSON.stringify(ins2.knowledge.record));
  check('roundtrip: profile sample count survives reload',
    ins2.analyze.profile.moves === 1, 'got ' + ins2.analyze.profile.moves);
  // useOpeningBook now reports that a book bias was actually applied to the
  // plan, so sense a booked position (s1) before reading the flag.
  a2.chooseMove(s1);
  check('roundtrip: opening book survives reload',
    a2.getInsights().plan.strategy.useOpeningBook === true);

  // corrupt JSON
  shim.setItem('kb-t1', '{"schema": 1, "gamesPlayed": '); // truncated JSON
  let a3 = null, threw = false;
  try { a3 = agent(shim, 'kb-t1'); } catch (e) { threw = true; }
  check('corrupt JSON: constructor does not throw', !threw);
  check('corrupt JSON: falls back to fresh defaults',
    !!a3 && a3.getInsights().knowledge.gamesPlayed === 0);
  check('corrupt JSON: agent still plays a legal move',
    !!a3 && isLegal(s0, a3.chooseMove(s0)));

  // wrong schema version
  shim.setItem('kb-t1', JSON.stringify({ schema: 999, gamesPlayed: 42 }));
  check('wrong schema version: ignored, defaults used',
    agent(shim, 'kb-t1').getInsights().knowledge.gamesPlayed === 0);

  // right schema, garbage fields
  shim.setItem('kb-t1', JSON.stringify({
    schema: 1, gamesPlayed: -5, record: { w: 'many' }, profile: null, book: [1, 2, 3]
  }));
  const a5 = agent(shim, 'kb-t1');
  const ins5 = a5.getInsights();
  check('garbage fields under valid schema: sanitized to defaults',
    ins5.knowledge.gamesPlayed === 0 && ins5.knowledge.record.w === 0 &&
    ins5.analyze.profile.moves === 0);

  // resetKnowledge wipes persisted state
  const a6 = agent(mem(), 'kb-t1r');
  a6.monitor({ type: 'gameStart' });
  a6.monitor({ type: 'gameEnd', winner: 'B' });
  a6.resetKnowledge();
  check('resetKnowledge: gamesPlayed back to 0',
    a6.getInsights().knowledge.gamesPlayed === 0);
}

// ---------------------------------------------------------------
console.log('--- (2) exposure-prone player flips trap-seeking + changes chooseMove ---');
// ---------------------------------------------------------------
{
  const naive = agent(mem(), 'kb-t2a');
  const trained = agent(mem(), 'kb-t2b');
  trainExposure(trained, 12);

  const insN = naive.getInsights();
  const insT = trained.getInsights();
  check('exposureRate observed high', insT.analyze.profile.exposureRate > 0.9,
    'got ' + insT.analyze.profile.exposureRate);
  check('trap-seeking flag flips (false -> true)',
    insN.plan.strategy.trapSeeking === false && insT.plan.strategy.trapSeeking === true);
  check('trap weight raised above baseline',
    insT.plan.strategy.weights.trap > insN.plan.strategy.weights.trap,
    insN.plan.strategy.weights.trap + ' -> ' + insT.plan.strategy.weights.trap);
  check('strategy object measurably changes',
    JSON.stringify(insN.plan.strategy) !== JSON.stringify(insT.plan.strategy));
  check('rationale explains the trap adaptation',
    insT.plan.rationale.some(function (r) { return /trap/i.test(r); }));

  // Crafted position (found by offline search, deterministic at full depth):
  // Black to move; a trap line exists and the trap-seeking strategy picks it.
  const b = emptyBoard();
  put(b, 1, 2, 'B'); put(b, 2, 1, 'B'); put(b, 2, 5, 'B'); put(b, 2, 7, 'B');
  put(b, 3, 0, 'R'); put(b, 6, 1, 'R'); put(b, 6, 3, 'B');
  const T = S(b, 'B', 20);
  const mN = naive.chooseMove(T);
  const mT = trained.chooseMove(T);
  check('crafted trap position: naive move is legal', isLegal(T, mN));
  check('crafted trap position: trained move is legal', isLegal(T, mT));
  check('crafted trap position: chooseMove differs under trap-seeking',
    !!mN && !!mT && key(mN) !== key(mT),
    'naive=' + (mN && key(mN)) + ' trained=' + (mT && key(mT)));
}

// ---------------------------------------------------------------
console.log('--- (3) edge-hugging player raises the center-control weight ---');
// ---------------------------------------------------------------
{
  const c = agent(mem(), 'kb-t3');
  const s0 = Engine.initialState();
  const lm0 = Engine.legalMoves(s0);
  const edgeMove = lm0.filter(function (m) { return key(m) === '5,6>4,7'; })[0];
  check('edge test setup: 5,6>4,7 is legal from the start', !!edgeMove);
  for (let i = 0; i < 20; i++) {
    c.monitor({ type: 'playerMove', before: s0, move: edgeMove, legalMoves: lm0 });
  }
  const insC = c.getInsights();
  const baseCenter = agent(mem(), 'kb-t3f').getInsights().plan.strategy.weights.center;
  check('edgePreference observed high', insC.analyze.profile.edgePreference > 0.9,
    'got ' + insC.analyze.profile.edgePreference);
  check('center-control weight raised above baseline',
    insC.plan.strategy.weights.center > baseCenter,
    baseCenter + ' -> ' + insC.plan.strategy.weights.center);
  check('style calls out edge-hugging', /edge/i.test(insC.analyze.style), insC.analyze.style);
  check('rationale explains the center adaptation',
    insC.plan.rationale.some(function (r) { return /center/i.test(r); }));
}

// ---------------------------------------------------------------
console.log('--- (4) low blunderRate raises planned search depth ---');
// ---------------------------------------------------------------
{
  // Forced moves are now zero-information (evaluated:false), so skill must be
  // shown where a real choice exists: from the initial position (7 legal
  // moves, none of which loses a man at blunder-check depth) the player
  // repeatedly makes a sound developing move.
  const F = Engine.initialState();
  const lmF = Engine.legalMoves(F);
  const sound = lmF.filter(function (m) { return key(m) === '5,2>4,3'; })[0];
  check('depth test setup: player has a real choice', lmF.length > 1 && !!sound,
    'moves=' + lmF.map(key).join(' '));
  const d = agent(mem(), 'kb-t4');
  for (let i = 0; i < 12; i++) {
    d.monitor({ type: 'playerMove', before: F, move: sound, legalMoves: lmF });
  }
  const insD = d.getInsights();
  const baseDepth = agent(mem(), 'kb-t4f').getInsights().plan.strategy.maxDepth;
  check('blunderRate observed at 0', insD.analyze.profile.blunderRate === 0,
    'got ' + insD.analyze.profile.blunderRate);
  check('sound moves with a real choice count as evaluated',
    insD.analyze.profile.evaluated >= AI.TUNING.minEvaluated,
    'got ' + insD.analyze.profile.evaluated);
  check('planned depth raised above baseline',
    insD.plan.strategy.maxDepth > baseDepth,
    baseDepth + ' -> ' + insD.plan.strategy.maxDepth);
  check('rationale explains the depth adaptation',
    insD.plan.rationale.some(function (r) { return /depth/i.test(r); }));

  // Forced moves (fewer than 2 choices) must contribute zero information:
  // previously they counted as evaluated non-blunders, deflating blunderRate
  // and unlocking the deeper-search adaptation for free.
  const fb = emptyBoard();
  put(fb, 5, 4, 'R'); put(fb, 4, 3, 'B'); put(fb, 0, 7, 'B');
  const FF = S(fb, 'R', 20);
  const lmFF = Engine.legalMoves(FF);
  check('forced setup: exactly one forced capture',
    lmFF.length === 1 && lmFF[0].captures.length === 1, 'moves=' + lmFF.map(key).join(' '));
  const f = agent(mem(), 'kb-t4g');
  for (let i = 0; i < 12; i++) {
    f.monitor({ type: 'playerMove', before: FF, move: lmFF[0], legalMoves: lmFF });
  }
  const insF = f.getInsights();
  check('forced moves do not count as evaluated',
    insF.analyze.profile.evaluated === 0, 'got ' + insF.analyze.profile.evaluated);
  check('forced moves alone never unlock deeper search',
    insF.plan.strategy.maxDepth === baseDepth,
    baseDepth + ' vs ' + insF.plan.strategy.maxDepth);
}

// ---------------------------------------------------------------
console.log('--- (5) opening book: losses on a line make chooseMove avoid it ---');
// ---------------------------------------------------------------
{
  const s0 = Engine.initialState();
  const lm0 = Engine.legalMoves(s0);
  const redOpen = lm0.filter(function (m) { return key(m) === '5,2>4,3'; })[0];
  const s1 = Engine.applyMove(s0, redOpen); // ply 1, Black (AI) to move

  const probe = agent(mem(), 'kb-t5p');
  const natural = probe.chooseMove(s1); // the line the AI naturally plays
  check('opening test setup: natural reply is legal', isLegal(s1, natural));

  const t = agent(mem(), 'kb-t5');
  for (let g = 0; g < 5; g++) { // AI (Black) plays `natural` on this line and loses
    t.monitor({ type: 'gameStart' });
    t.monitor({ type: 'playerMove', before: s0, move: redOpen, legalMoves: lm0 });
    t.monitor({ type: 'aiMove', before: s1, move: natural });
    t.monitor({ type: 'gameEnd', winner: 'R' });
  }
  const insB = t.getInsights();
  check('book records the games', insB.knowledge.gamesPlayed === 5 && insB.knowledge.record.l === 5,
    JSON.stringify(insB.knowledge.record));
  const avoided = t.chooseMove(s1);
  check('chooseMove avoids the losing continuation',
    !!avoided && key(avoided) !== key(natural),
    'natural=' + key(natural) + ' chose=' + (avoided && key(avoided)));
  check('the avoiding move is still legal', isLegal(s1, avoided));
  const insAfter = t.getInsights();
  check('rationale cites the opening book',
    insAfter.plan.rationale.some(function (r) { return /opening book/i.test(r); }));
  // useOpeningBook is now derived from a bias actually being applied to the
  // sensed position's plan, so it is only meaningful after chooseMove(s1).
  check('useOpeningBook reports the applied book bias',
    insAfter.plan.strategy.useOpeningBook === true);
  // gameStart must clear the previously sensed position: insights right
  // after New Game must not plan (book biases) for the OLD game's position.
  t.monitor({ type: 'gameStart' });
  const insNew = t.getInsights();
  check('gameStart clears the stale sensed position from the plan',
    insNew.plan.strategy.useOpeningBook === false &&
    Object.keys(insNew.plan.strategy.rootBias).length === 0,
    JSON.stringify(insNew.plan.strategy.rootBias));
}

// ---------------------------------------------------------------
console.log('--- (6) chooseMove legality across 50 randomized positions ---');
// ---------------------------------------------------------------
{
  const rng = mulberry32(20260706);
  const a = agent(mem(), 'kb-t6');
  let allLegal = true;
  let detail = '';
  let tested = 0;
  while (tested < 50) {
    let st = Engine.initialState();
    const steps = 4 + Math.floor(rng() * 36);
    let dead = false;
    for (let i = 0; i < steps; i++) {
      if (Engine.winner(st)) { dead = true; break; }
      const ms = Engine.legalMoves(st);
      st = Engine.applyMove(st, ms[Math.floor(rng() * ms.length)]);
    }
    if (dead || Engine.winner(st)) continue;
    tested++;
    const mv = a.chooseMove(st);
    if (!isLegal(st, mv)) {
      allLegal = false;
      detail = 'position ' + tested + ' (' + Engine.hash(st) + ') got ' + (mv ? key(mv) : String(mv));
      break;
    }
  }
  check('chooseMove returns a legal move on all 50 random positions', allLegal, detail);
}

// ---------------------------------------------------------------
console.log('--- (7) getInsights returns the full SPEC shape (pre-game and mid-game) ---');
// ---------------------------------------------------------------
function checkShape(ins, label) {
  check(label + ': monitor.recentEvents is string[]',
    !!ins.monitor && Array.isArray(ins.monitor.recentEvents) &&
    ins.monitor.recentEvents.every(function (e) { return typeof e === 'string'; }));
  const p = ins.analyze && ins.analyze.profile;
  check(label + ': analyze.profile has the five learned rates',
    !!p && ['exposureRate', 'edgePreference', 'advanceRate', 'kingUsage', 'blunderRate']
      .every(function (k2) { return typeof p[k2] === 'number' && isFinite(p[k2]); }));
  check(label + ': analyze.style/confidence',
    typeof ins.analyze.style === 'string' && typeof ins.analyze.confidence === 'number' &&
    ins.analyze.confidence >= 0 && ins.analyze.confidence <= 1);
  check(label + ': plan.strategy object + rationale string[]',
    !!ins.plan && typeof ins.plan.strategy === 'object' && ins.plan.strategy !== null &&
    Array.isArray(ins.plan.rationale) &&
    ins.plan.rationale.every(function (r) { return typeof r === 'string'; }) &&
    ins.plan.rationale.length > 0);
  check(label + ': execute.lastEval/depth/nodes numbers',
    !!ins.execute && typeof ins.execute.lastEval === 'number' &&
    typeof ins.execute.depth === 'number' && typeof ins.execute.nodes === 'number');
  check(label + ': knowledge.gamesPlayed/record/adaptationLevel',
    !!ins.knowledge && typeof ins.knowledge.gamesPlayed === 'number' &&
    !!ins.knowledge.record &&
    ['w', 'l', 'd'].every(function (k2) { return typeof ins.knowledge.record[k2] === 'number'; }) &&
    typeof ins.knowledge.adaptationLevel === 'string');
}
{
  const a = agent(mem(), 'kb-t7');
  checkShape(a.getInsights(), 'pre-game');

  a.monitor({ type: 'gameStart' });
  const s0 = Engine.initialState();
  const lm0 = Engine.legalMoves(s0);
  a.monitor({ type: 'playerMove', before: s0, move: lm0[0], legalMoves: lm0 });
  const s1 = Engine.applyMove(s0, lm0[0]);
  const mv = a.chooseMove(s1);
  a.monitor({ type: 'aiMove', before: s1, move: mv });
  const mid = a.getInsights();
  checkShape(mid, 'mid-game');
  check('mid-game: recentEvents populated, newest first',
    mid.monitor.recentEvents.length >= 3 && /^AI:/.test(mid.monitor.recentEvents[0]),
    JSON.stringify(mid.monitor.recentEvents[0]));
  check('mid-game: executor actually searched (depth>0, nodes>0)',
    mid.execute.depth > 0 && mid.execute.nodes > 0,
    JSON.stringify(mid.execute));
}

// --- formatMove/formatMoveKey: human-readable square notation for the
// Monitor live-panel text (a-h files, 1-8 ranks), independent of moveKey's
// raw coordinate format which stays as an internal book/map key. ---
{
  const simple = { from: [5, 2], path: [[4, 3]], captures: [] };
  check('formatMove: simple move uses square notation', AI.formatMove(simple) === 'c3→d4',
    AI.formatMove(simple));
  check('formatMoveKey: same move via its moveKey string matches formatMove',
    AI.formatMoveKey(AI.moveKey(simple)) === AI.formatMove(simple),
    AI.formatMoveKey(AI.moveKey(simple)) + ' vs ' + AI.formatMove(simple));

  const doubleJump = { from: [3, 4], path: [[5, 6], [7, 4]], captures: [[4, 5], [6, 5]] };
  check('formatMove: multi-jump chains squares with arrows', AI.formatMove(doubleJump) === 'e5→g3→e1',
    AI.formatMove(doubleJump));
  check('formatMove: never contains a raw comma-coordinate (unreadable to a player)',
    AI.formatMove(doubleJump).indexOf(',') === -1, AI.formatMove(doubleJump));
}

// ---------------------------------------------------------------
console.log('');
console.log('ai.test.js: ' + passCount + ' passed, ' + failCount + ' failed');
process.exit(failCount > 0 ? 1 : 0);
