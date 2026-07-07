/*
 * tests/selfplay.js — two independent MapeKAgent instances (in-memory storage)
 * play 3 full games against each other. Asserts: every move is legal, each
 * game terminates (win or draw) within 300 plies, and gamesPlayed increments
 * for both agents. Plain node script: PASS/FAIL per case, exit(1) on failure.
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

const agentRed = new AI.MapeKAgent({ storage: 'memory', storageKey: 'selfplay-red' });
const agentBlack = new AI.MapeKAgent({ storage: 'memory', storageKey: 'selfplay-black' });

const GAMES = 3;
const MAX_PLIES = 300;

for (let g = 1; g <= GAMES; g++) {
  const started = Date.now();
  agentRed.monitor({ type: 'gameStart' });
  agentBlack.monitor({ type: 'gameStart' });

  let state = Engine.initialState();
  let plies = 0;
  let allLegal = true;
  let legalDetail = '';
  let result = Engine.winner(state);

  while (!result && plies < MAX_PLIES) {
    const mover = state.turn === Engine.RED ? agentRed : agentBlack;
    const other = state.turn === Engine.RED ? agentBlack : agentRed;
    const legal = Engine.legalMoves(state);
    const move = mover.chooseMove(state);
    const ok = !!move && legal.some(function (m) { return key(m) === key(move); });
    if (!ok) {
      allLegal = false;
      legalDetail = 'ply ' + plies + ' (' + Engine.hash(state) + ') got ' +
        (move ? key(move) : String(move));
      break;
    }
    mover.monitor({ type: 'aiMove', before: state, move: move });
    other.monitor({ type: 'playerMove', before: state, move: move, legalMoves: legal });
    state = Engine.applyMove(state, move);
    plies++;
    result = Engine.winner(state);
  }

  check('game ' + g + ': every move was legal', allLegal, legalDetail);
  check('game ' + g + ': terminated within ' + MAX_PLIES + ' plies (win or draw)',
    !!result, 'no result after ' + plies + ' plies');

  const outcome = result || 'draw'; // if it failed to terminate, still close the game
  agentRed.monitor({ type: 'gameEnd', winner: outcome });
  agentBlack.monitor({ type: 'gameEnd', winner: outcome });

  const gpR = agentRed.getInsights().knowledge.gamesPlayed;
  const gpB = agentBlack.getInsights().knowledge.gamesPlayed;
  check('game ' + g + ': red agent gamesPlayed incremented to ' + g, gpR === g, 'got ' + gpR);
  check('game ' + g + ': black agent gamesPlayed incremented to ' + g, gpB === g, 'got ' + gpB);

  console.log('  game ' + g + ': ' + (outcome === 'draw' ? 'draw' : outcome + ' wins') +
    ' in ' + plies + ' plies (' + ((Date.now() - started) / 1000).toFixed(1) + 's)');
}

const finalR = agentRed.getInsights();
const finalB = agentBlack.getInsights();
console.log('  red   record ' + JSON.stringify(finalR.knowledge.record) +
  ' | ' + finalR.knowledge.adaptationLevel);
console.log('  black record ' + JSON.stringify(finalB.knowledge.record) +
  ' | ' + finalB.knowledge.adaptationLevel);

console.log('');
console.log('selfplay.js: ' + passCount + ' passed, ' + failCount + ' failed');
process.exit(failCount > 0 ? 1 : 0);
