/*
 * tests/integration.test.js — full-system integration test.
 *
 * A naive greedy scripted "human" (always takes the first capture, else the
 * first legal move) plays 5 full games as Red against ONE persistent
 * MapeKAgent (in-memory storage) playing Black, in a single process,
 * driving the exact monitor-event sequence the UI contract specifies:
 *
 *   gameStart
 *   [human turn]  monitor playerMove {before, move, legalMoves}  -> applyMove
 *   [ai turn]     chooseMove(before) -> monitor aiMove {before, move}
 *                 -> applyMove -> getInsights() (panel refresh)
 *   gameEnd {winner}   (exactly once per game)
 *
 * Asserts: no exceptions, every move legal, all games terminate,
 * knowledge.gamesPlayed === 5, and the agent wins at least 4 of 5.
 *
 * Plain node script: PASS/FAIL per case, exit(1) on any failure.
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

// Naive greedy scripted human: first capture if any capture exists,
// otherwise the first legal move.
function greedyHumanMove(legal) {
  for (let i = 0; i < legal.length; i++) {
    if (legal[i].captures.length > 0) return legal[i];
  }
  return legal[0];
}

const GAMES = 5;
const MAX_PLIES = 300;

// One persistent agent across all five games (memory storage, single process).
const agent = new AI.MapeKAgent({ storage: 'memory', storageKey: 'integration-kb' });

let aiWins = 0;
let exceptions = [];
let allGamesTerminated = true;
let allMovesLegal = true;
let insightsAlwaysShaped = true;
let insightsDetail = '';

function shapeOk(ins) {
  return !!ins &&
    !!ins.monitor && Array.isArray(ins.monitor.recentEvents) &&
    !!ins.analyze && typeof ins.analyze.style === 'string' &&
    typeof ins.analyze.confidence === 'number' && !!ins.analyze.profile &&
    !!ins.plan && !!ins.plan.strategy && Array.isArray(ins.plan.rationale) &&
    !!ins.execute && typeof ins.execute.lastEval === 'number' &&
    typeof ins.execute.depth === 'number' && typeof ins.execute.nodes === 'number' &&
    !!ins.knowledge && typeof ins.knowledge.gamesPlayed === 'number' &&
    !!ins.knowledge.record && typeof ins.knowledge.adaptationLevel === 'string';
}

for (let g = 1; g <= GAMES; g++) {
  const started = Date.now();
  let state = Engine.initialState();
  let plies = 0;
  let result = null;
  let gameLegal = true;
  let legalDetail = '';

  try {
    // UI contract: New Game fires gameStart before any move.
    agent.monitor({ type: 'gameStart' });
    result = Engine.winner(state);

    while (!result && plies < MAX_PLIES) {
      const legal = Engine.legalMoves(state);

      if (state.turn === Engine.RED) {
        // Scripted human turn (Red): pick greedily, report BEFORE applying.
        const move = greedyHumanMove(legal);
        const ok = !!move && legal.some(function (m) { return key(m) === key(move); });
        if (!ok) {
          gameLegal = false;
          legalDetail = 'human ply ' + plies + ' illegal: ' + (move ? key(move) : String(move));
          break;
        }
        agent.monitor({ type: 'playerMove', before: state, move: move, legalMoves: legal });
        state = Engine.applyMove(state, move);
      } else {
        // AI turn (Black): chooseMove -> monitor aiMove -> applyMove -> insights.
        const move = agent.chooseMove(state);
        const ok = !!move && legal.some(function (m) { return key(m) === key(move); });
        if (!ok) {
          gameLegal = false;
          legalDetail = 'AI ply ' + plies + ' (' + Engine.hash(state) + ') illegal: ' +
            (move ? key(move) : String(move));
          break;
        }
        agent.monitor({ type: 'aiMove', before: state, move: move });
        state = Engine.applyMove(state, move);
        // UI contract: the panel refreshes from getInsights() after every AI move.
        const ins = agent.getInsights();
        if (insightsAlwaysShaped && !shapeOk(ins)) {
          insightsAlwaysShaped = false;
          insightsDetail = 'game ' + g + ' ply ' + plies;
        }
      }

      plies++;
      result = Engine.winner(state);
    }

    // UI contract: gameEnd reported exactly once with the winner.
    const outcome = result || 'draw';
    agent.monitor({ type: 'gameEnd', winner: outcome });

    if (!result) allGamesTerminated = false;
    if (!gameLegal) allMovesLegal = false;
    if (result === Engine.BLACK) aiWins++;

    check('game ' + g + ': every move was legal', gameLegal, legalDetail);
    check('game ' + g + ': terminated within ' + MAX_PLIES + ' plies',
      !!result, 'no result after ' + plies + ' plies');
    console.log('  game ' + g + ': ' + (outcome === 'draw' ? 'draw' : outcome + ' wins') +
      ' in ' + plies + ' plies (' + ((Date.now() - started) / 1000).toFixed(1) + 's)');
  } catch (err) {
    exceptions.push('game ' + g + ': ' + (err && err.stack ? err.stack : String(err)));
    check('game ' + g + ': completed without exception', false, String(err));
  }
}

check('no exceptions across all 5 games', exceptions.length === 0, exceptions.join(' | '));
check('all moves legal across all 5 games', allMovesLegal);
check('all 5 games terminated', allGamesTerminated);
check('getInsights stayed well-formed after every AI move', insightsAlwaysShaped, insightsDetail);

const finalIns = agent.getInsights();
check('knowledge.gamesPlayed === 5', finalIns.knowledge.gamesPlayed === 5,
  'got ' + finalIns.knowledge.gamesPlayed);
check('agent (Black) wins at least 4 of 5 vs the naive player', aiWins >= 4,
  'AI won ' + aiWins + ' of ' + GAMES + ' — record ' + JSON.stringify(finalIns.knowledge.record));
check('knowledge record is consistent with gamesPlayed',
  finalIns.knowledge.record.w + finalIns.knowledge.record.l + finalIns.knowledge.record.d === GAMES,
  JSON.stringify(finalIns.knowledge.record));

console.log('  final record ' + JSON.stringify(finalIns.knowledge.record) +
  ' | ' + finalIns.knowledge.adaptationLevel);
console.log('');
console.log('integration.test.js: ' + passCount + ' passed, ' + failCount + ' failed');
process.exit(failCount > 0 ? 1 : 0);
