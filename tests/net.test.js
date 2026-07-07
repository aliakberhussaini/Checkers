/* Pure-logic tests for net.js: code/name validation and the defensive
 * wire-move check. Session's PeerJS wiring needs a live browser + network
 * and is covered by manual two-browser verification instead. */
'use strict';

var Net = require('../net.js');
var Engine = require('../engine.js');

var passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('PASS ' + label); }
  else { failed++; console.log('FAIL ' + label); }
}
function eq(actual, expected, label) {
  ok(actual === expected, label + ' (got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected) + ')');
}

// --- isValidCode ---
ok(Net.isValidCode('1234'), 'isValidCode: 4 digits accepted');
ok(Net.isValidCode(1234), 'isValidCode: numeric type accepted');
ok(!Net.isValidCode('123'), 'isValidCode: 3 digits rejected');
ok(!Net.isValidCode('12345'), 'isValidCode: 5 digits rejected');
ok(!Net.isValidCode('12a4'), 'isValidCode: letters rejected');
ok(!Net.isValidCode(''), 'isValidCode: empty rejected');
ok(!Net.isValidCode(null), 'isValidCode: null rejected');
ok(!Net.isValidCode(undefined), 'isValidCode: undefined rejected');
ok(!Net.isValidCode('-123'), 'isValidCode: negative-looking string rejected');

// --- sanitizeName ---
eq(Net.sanitizeName('  Ali  '), 'Ali', 'sanitizeName: trims whitespace');
eq(Net.sanitizeName(''), 'Player', 'sanitizeName: empty falls back to Player');
eq(Net.sanitizeName('   '), 'Player', 'sanitizeName: whitespace-only falls back to Player');
eq(Net.sanitizeName(null), 'Player', 'sanitizeName: null falls back to Player');
eq(Net.sanitizeName(42), 'Player', 'sanitizeName: non-string falls back to Player');
eq(Net.sanitizeName('X'.repeat(30)), 'X'.repeat(18), 'sanitizeName: truncates to 18 chars');

// --- makeCode ---
(function () {
  var allValid = true;
  for (var i = 0; i < 500; i++) {
    var c = Net.makeCode();
    if (!/^[0-9]{4}$/.test(c)) { allValid = false; break; }
  }
  ok(allValid, 'makeCode: always a 4-digit numeric string (500 samples)');
})();

// --- idFor ---
eq(Net.idFor('1234'), 'neonckr-1234', 'idFor: applies the namespace prefix');
eq(Net.idFor(1234), 'neonckr-1234', 'idFor: coerces numeric input to string');

// --- isLegalWireMove (the actual security boundary) ---
(function () {
  var state = Engine.initialState();
  var legal = Engine.legalMoves(state);
  var real = legal[0];
  var wireCopy = { from: real.from.slice(), path: real.path.map(function (p) { return p.slice(); }), captures: real.captures.slice() };
  var result = Net.isLegalWireMove(wireCopy, state, Engine);
  ok(result !== false, 'isLegalWireMove: accepts a real legal move sent as a plain wire object');
  ok(result !== wireCopy, 'isLegalWireMove: does not just echo back the untrusted wire object');
  eq(JSON.stringify(result), JSON.stringify(real), 'isLegalWireMove: returned move matches the engine\'s own legal move');
})();

(function () {
  var state = Engine.initialState();
  var bogus = { from: [5, 2], path: [[0, 0]], captures: [] }; // not adjacent, not legal
  ok(Net.isLegalWireMove(bogus, state, Engine) === false, 'isLegalWireMove: rejects a fabricated illegal move');
})();

(function () {
  var state = Engine.initialState();
  ok(Net.isLegalWireMove(null, state, Engine) === false, 'isLegalWireMove: rejects null');
  ok(Net.isLegalWireMove({}, state, Engine) === false, 'isLegalWireMove: rejects empty object');
  ok(Net.isLegalWireMove({ from: [5, 2] }, state, Engine) === false, 'isLegalWireMove: rejects missing path/captures');
  ok(Net.isLegalWireMove({ from: [5, 2], path: [[4, 3]], captures: 'nope' }, state, Engine) === false,
    'isLegalWireMove: rejects non-array captures');
})();

(function () {
  // A move that WAS legal in a different position must not be accepted here.
  var state = Engine.initialState();
  var afterOneMove = Engine.applyMove(state, Engine.legalMoves(state)[0]);
  var legalElsewhere = Engine.legalMoves(afterOneMove)[0];
  ok(Net.isLegalWireMove(legalElsewhere, state, Engine) === false,
    'isLegalWireMove: rejects a move that is legal in a different position');
})();

// --- friendlyError: every PeerJS error type must become an actionable
// message, never the raw internal string (this is what surfaced the real
// "Negotiation of connection to neonckr-4085 failed." bug in the UI). ---
eq(Net.friendlyError({ type: 'unavailable-id' }), 'that code is already in use — try again', 'friendlyError: unavailable-id');
eq(Net.friendlyError({ type: 'peer-unavailable' }), 'no game found with that code', 'friendlyError: peer-unavailable');
(function () {
  var msg = Net.friendlyError({ type: 'webrtc', message: 'Negotiation of connection to neonckr-4085 failed.' });
  ok(msg.indexOf('Negotiation') === -1, 'friendlyError: webrtc hides the raw PeerJS internal message');
  ok(msg.indexOf('network') !== -1 || msg.indexOf('direct connection') !== -1, 'friendlyError: webrtc gives actionable guidance');
})();
['network', 'socket-error', 'socket-closed', 'server-error', 'disconnected'].forEach(function (t) {
  var msg = Net.friendlyError({ type: t, message: 'some internal detail' });
  ok(msg.indexOf('some internal detail') === -1, 'friendlyError: ' + t + ' hides the raw message');
});
eq(Net.friendlyError({ type: 'totally-unknown-type', message: 'raw fallback text' }), 'raw fallback text',
  'friendlyError: unrecognized type falls back to the raw message (better than nothing)');
eq(Net.friendlyError(null), 'null', 'friendlyError: handles null without throwing');

console.log('\nnet.test.js: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
