/* Neon Checkers UI — implements CheckersGame.dc.html (variant "grid") on top of
 * the production rules engine (engine.js) and the MAPE-K agent (ai.js).
 *
 * The design prototype's internal game logic is intentionally NOT copied; the
 * engine is the single source of truth for rules and the MapeKAgent for play.
 * Monitor-event order follows SPEC.md: playerMove (with the pre-move state)
 * fires BEFORE applyMove; aiMove fires before its applyMove; gameEnd fires
 * exactly once per game.
 */
(function () {
  'use strict';

  var E = (typeof window !== 'undefined') ? window.CheckersEngine : null;
  var AIRoot = (typeof window !== 'undefined') ? window.CheckersAI : null;
  var Net = (typeof window !== 'undefined') ? window.NetCheckers : null;

  var TURN_TIME = 30;
  var AI_STEP_MS = 300;
  var PHASE_STEP_MS = 180;
  var PREFS_KEY = 'neon-checkers-ui-prefs';

  var agent = null;      // persistent learning agent (localStorage-backed)
  var hintAgent = null;  // throwaway full-strength agent for hints (memory only)

  var state = null;      // authoritative engine state
  var screen = 'title';  // 'title' | 'play'
  var mode = 'solo';     // 'solo' (vs agent) | 'mp' (vs a networked human)
  var mySide = null;     // E.RED or E.BLACK — which side THIS browser plays
  var mpName = 'Player'; // this player's display name, persisted
  var oppName = 'Opponent';
  var netSession = null; // NetCheckers.Session while a multiplayer link is live/pending
  var over = false, winnerSide = null, gameEndReported = false;
  var paused = false;
  var thinking = false;
  var committing = false; // a human move is being handed to the agent/engine
  var selected = null;   // [r,c] currently selected / chain head
  var candidates = [];   // full engine moves compatible with the chosen prefix
  var stepIndex = 0;     // steps of the prefix already shown on the board
  var mustContinue = false;
  var trays = { human: [], ai: [] };
  // Captures the board already shows but the panel data does not yet (or vice
  // versa): pending.human = visually removed, engine state/trays not committed;
  // pending.ai = applied to engine state, not yet visually removed.
  var pending = { human: [], ai: [] };
  var lastMove = null;
  var history = [];
  var moveCount = 0;
  var startTime = 0, endAt = 0;
  var timeLeft = TURN_TIME;
  var hintCells = null;
  var muted = false, colorblind = false, difficulty = 'adaptive';
  var lastMoveFromAgent = false; // did pickAiMove's result come from agent.chooseMove?
  var handicappedGame = false;   // any part of this game was played on 'easy'
  var generation = 0;    // bumped to cancel in-flight async work
  var timeouts = [];
  var nodes = [];        // nodes[r][c] -> piece DOM node mirroring the visual board

  var els = {};
  var cellEls = [];

  var actx = null;

  /* ------------------------------------------------------------ helpers */

  function $(id) { return document.getElementById(id); }

  function schedule(fn, ms) {
    var gen = generation;
    var id = setTimeout(function () { if (gen === generation) fn(); }, ms);
    timeouts.push(id);
    return id;
  }
  function clearTimers() {
    for (var i = 0; i < timeouts.length; i++) clearTimeout(timeouts[i]);
    timeouts = [];
  }

  function samePos(a, b) { return a && b && a[0] === b[0] && a[1] === b[1]; }
  function posKey(p) { return p[0] + ',' + p[1]; }

  function safeMonitor(event) {
    if (!agent) return;
    try { agent.monitor(event); } catch (err) { /* agent errors never break play */ }
  }
  function safeInsights() {
    if (!agent) return null;
    try { return agent.getInsights(); } catch (err) { return null; }
  }
  function track(event, props) {
    try { if (typeof Analytics !== 'undefined') Analytics.capture(event, props); } catch (err) { /* analytics never breaks play */ }
  }

  function loadPrefs() {
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        muted = !!p.muted;
        colorblind = !!p.colorblind;
        if (p.difficulty === 'easy' || p.difficulty === 'hard' || p.difficulty === 'adaptive') difficulty = p.difficulty;
        if (typeof p.mpName === 'string' && p.mpName) mpName = p.mpName;
      }
    } catch (err) { /* defaults stand */ }
  }
  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        muted: muted, colorblind: colorblind, difficulty: difficulty, mpName: mpName
      }));
    } catch (err) {}
  }

  /* ------------------------------------------------------------ audio */

  function ensureAudio() {
    if (!actx) {
      try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (err) { actx = null; }
    }
    if (actx && actx.state === 'suspended') actx.resume();
  }
  var SFX = {
    select: [[440, 0, 0.06, 'triangle', 0.14]],
    move: [[300, 0, 0.08, 'sine', 0.18], [420, 0.05, 0.07, 'sine', 0.1]],
    capture: [[200, 0, 0.12, 'sawtooth', 0.2], [110, 0.07, 0.16, 'square', 0.16]],
    king: [[523, 0, 0.1, 'triangle', 0.18], [784, 0.09, 0.16, 'triangle', 0.18]],
    tick: [[900, 0, 0.03, 'square', 0.06]],
    win: [[523, 0, 0.12, 'triangle', 0.2], [659, 0.12, 0.12, 'triangle', 0.2], [784, 0.24, 0.22, 'triangle', 0.22], [1047, 0.42, 0.3, 'triangle', 0.2]],
    lose: [[392, 0, 0.18, 'sawtooth', 0.16], [294, 0.16, 0.22, 'sawtooth', 0.16], [196, 0.36, 0.4, 'sine', 0.16]],
    phase: [[660, 0, 0.04, 'triangle', 0.07]]
  };
  function sfx(name) {
    if (muted || !actx) return;
    var notes = SFX[name];
    if (!notes) return;
    var now = actx.currentTime;
    for (var i = 0; i < notes.length; i++) {
      var f = notes[i][0], t = notes[i][1], d = notes[i][2], ty = notes[i][3], g = notes[i][4];
      var o = actx.createOscillator(), ga = actx.createGain();
      o.type = ty; o.frequency.value = f;
      o.connect(ga); ga.connect(actx.destination);
      var st = now + t;
      ga.gain.setValueAtTime(0.0001, st);
      ga.gain.exponentialRampToValueAtTime(g, st + 0.012);
      ga.gain.exponentialRampToValueAtTime(0.0001, st + d);
      o.start(st); o.stop(st + d + 0.03);
    }
  }

  /* ------------------------------------------------------------ boot */

  function init() {
    var ids = ['board', 'piece-layer', 'timer-bar', 'timer-num', 'turn-dot', 'status-main', 'status-sub',
      'human-count', 'ai-count', 'skill-pct', 'ring-arc', 'level-num', 'brain-games', 'brain-moves',
      'agent-wins', 'player-wins', 'phase-row', 'human-tray', 'ai-tray', 'stat-you', 'stat-agent',
      'title-overlay', 'title-brain', 'over-overlay', 'result-headline', 'result-sub', 'stat-moves',
      'stat-duration', 'stat-you-final', 'stat-agent-final', 'stat-adapt', 'settings-overlay',
      'diff-row', 'diff-note', 'btn-sound-toggle', 'btn-cb-toggle', 'icon-sound-on', 'icon-sound-off', 'app',
      'brain-draws', 'live-monitor', 'live-analyze', 'live-plan', 'live-execute', 'live-knowledge',
      'opp-name-label', 'opp-tray-label', 'opp-took-label', 'adapt-stat-block', 'agent-panel',
      'mp-panel', 'mp-conn-dot', 'mp-my-name', 'mp-opp-name', 'btn-mp-leave', 'btn-undo',
      'mp-overlay', 'mp-name-step', 'mp-generate-step', 'mp-join-step', 'mp-name-input',
      'mp-code-display', 'mp-generate-status', 'mp-code-input', 'mp-join-status',
      'btn-pause', 'pause-overlay', 'pause-sub', 'btn-resume', 'btn-quit',
      'topbar', 'layout', 'btn-share', 'btn-share-result', 'toast',
      'nps-strip', 'nps-scale', 'btn-nps-dismiss', 'nps-thanks'];
    for (var i = 0; i < ids.length; i++) els[ids[i]] = $(ids[i]);

    if (!E) {
      els['status-main'].textContent = 'Load error';
      els['status-sub'].textContent = 'engine.js is missing';
      return;
    }
    if (AIRoot) {
      try {
        var Ctor = AIRoot.MapeKAgent || AIRoot;
        agent = new Ctor();
      } catch (err) { agent = null; }
    }

    loadPrefs();
    buildBoard();

    $('btn-start').addEventListener('click', function () { ensureAudio(); startGame(); });
    $('btn-new').addEventListener('click', function () {
      ensureAudio();
      if (mode === 'mp' && screen === 'play') leaveMultiplayer(); else newGame();
    });
    $('btn-rematch').addEventListener('click', function () {
      ensureAudio();
      if (mode === 'mp') startMultiplayerRematch(true); else newGame();
    });
    $('btn-home').addEventListener('click', function () {
      if (mode === 'mp') leaveMultiplayer(); else goTitle();
    });
    $('btn-hint').addEventListener('click', showHint);
    els['btn-undo'].addEventListener('click', undo);
    $('btn-sound').addEventListener('click', toggleMute);
    $('btn-sound-toggle').addEventListener('click', toggleMute);
    $('btn-cb-toggle').addEventListener('click', toggleColorblind);
    $('btn-settings').addEventListener('click', function () { els['settings-overlay'].classList.remove('hidden'); });
    $('btn-close-settings').addEventListener('click', function () { els['settings-overlay'].classList.add('hidden'); });
    $('btn-reset-brain').addEventListener('click', resetBrain);
    els['diff-row'].addEventListener('click', function (ev) {
      var chip = ev.target.closest('.diff-chip');
      if (chip) setDifficulty(chip.getAttribute('data-diff'));
    });

    $('btn-multiplayer').addEventListener('click', openMultiplayerModal);
    $('btn-close-mp').addEventListener('click', closeMultiplayerModal);
    $('btn-mp-choose-generate').addEventListener('click', mpGenerateCode);
    $('btn-mp-choose-join').addEventListener('click', function () {
      els['mp-join-status'].textContent = '';
      els['mp-code-input'].value = '';
      showMpStep('join');
    });
    $('btn-mp-back-1').addEventListener('click', function () { cancelNetSession(); showMpStep('name'); });
    $('btn-mp-back-2').addEventListener('click', function () { showMpStep('name'); });
    $('btn-mp-connect').addEventListener('click', mpConnectWithCode);
    els['btn-mp-leave'].addEventListener('click', leaveMultiplayer);
    els['mp-code-input'].addEventListener('input', function () {
      this.value = this.value.replace(/[^0-9]/g, '').slice(0, 4);
    });

    els['btn-pause'].addEventListener('click', openPause);
    els['btn-resume'].addEventListener('click', resumeGame);
    els['btn-quit'].addEventListener('click', quitGame);

    els['btn-share'].addEventListener('click', shareGame);
    els['btn-share-result'].addEventListener('click', shareGame);
    els['nps-scale'].addEventListener('click', function (ev) {
      var b = ev.target.closest('.nps-btn');
      if (b) submitNps(Number(b.getAttribute('data-score')));
    });
    els['btn-nps-dismiss'].addEventListener('click', dismissNps);

    setInterval(onTimerTick, 1000);

    state = E.initialState();
    resetVisualState();
    applyPrefsToUI();
    refreshInsights();
    updateTitleBrain();
    render();
  }

  function buildBoard() {
    cellEls = [];
    els.board.textContent = '';
    for (var r = 0; r < 8; r++) {
      var row = [];
      for (var c = 0; c < 8; c++) {
        var cell = document.createElement('div');
        cell.className = 'cell' + (((r + c) % 2 === 1) ? ' playable' : '');
        cell.dataset.r = String(r);
        cell.dataset.c = String(c);
        els.board.appendChild(cell);
        row.push(cell);
      }
      cellEls.push(row);
    }
    els.board.addEventListener('click', function (ev) {
      var cell = ev.target.closest('.cell');
      if (cell) onCell(Number(cell.dataset.r), Number(cell.dataset.c));
    });
  }

  /* ------------------------------------------------------------ piece layer */

  function makePieceNode(cellData) {
    var slot = document.createElement('div');
    slot.className = 'piece-slot' + (cellData.k ? ' king' : '');
    var ring = document.createElement('div');
    ring.className = 'movable-ring hidden';
    var disc = document.createElement('div');
    // p1 (cyan) = mine, p2 (violet) = the other side — relative to mySide so
    // a multiplayer joiner (playing Black) still sees their own pieces as
    // "mine". Board orientation itself is not flipped; both peers share one
    // fixed (row, col) coordinate system.
    disc.className = 'disc ' + (cellData.p === mySide ? 'p1' : 'p2');
    var kingRing = document.createElement('div');
    kingRing.className = 'king-ring';
    var mark = document.createElement('div');
    mark.className = 'mark';
    disc.appendChild(kingRing);
    disc.appendChild(mark);
    slot.appendChild(ring);
    slot.appendChild(disc);
    return slot;
  }
  function placeNode(node, r, c) {
    node.style.left = (c * 12.5) + '%';
    node.style.top = (r * 12.5) + '%';
  }
  function rebuildPieceLayer() {
    els['piece-layer'].textContent = '';
    nodes = [];
    for (var r = 0; r < 8; r++) {
      var row = [];
      for (var c = 0; c < 8; c++) {
        var cellData = state.board[r][c];
        if (cellData) {
          var node = makePieceNode(cellData);
          placeNode(node, r, c);
          els['piece-layer'].appendChild(node);
          row.push(node);
        } else {
          row.push(null);
        }
      }
      nodes.push(row);
    }
  }
  function fxAt(r, c, isHumanPiece) {
    var slot = document.createElement('div');
    slot.className = 'fx-slot';
    placeNode(slot, r, c);
    var disc = document.createElement('div');
    disc.className = 'fx-disc ' + (isHumanPiece ? 'p1' : 'p2');
    slot.appendChild(disc);
    els['piece-layer'].appendChild(slot);
    schedule(function () { if (slot.parentNode) slot.parentNode.removeChild(slot); }, 480);
  }

  /* One visual hop: move the piece node, remove any captured node with a pop. */
  function stepVisual(from, to, capSq) {
    var node = nodes[from[0]][from[1]];
    if (!node) return;
    nodes[from[0]][from[1]] = null;
    nodes[to[0]][to[1]] = node;
    node.classList.add('front');
    placeNode(node, to[0], to[1]);
    if (capSq) {
      var capNode = nodes[capSq[0]][capSq[1]];
      var capIsHuman = capNode && capNode.querySelector('.disc.p1') !== null;
      if (capNode) {
        nodes[capSq[0]][capSq[1]] = null;
        if (capNode.parentNode) capNode.parentNode.removeChild(capNode);
      }
      fxAt(capSq[0], capSq[1], capIsHuman);
      sfx('capture');
    } else {
      sfx('move');
    }
  }
  function crownIfPromoted(dest) {
    var cellData = state.board[dest[0]][dest[1]];
    var node = nodes[dest[0]][dest[1]];
    if (cellData && cellData.k && node && !node.classList.contains('king')) {
      node.classList.add('king');
      sfx('king');
    }
  }

  /* ------------------------------------------------------------ game flow */

  function resetVisualState() {
    over = false; winnerSide = null; gameEndReported = false;
    paused = false;
    thinking = false; committing = false;
    selected = null; candidates = []; stepIndex = 0; mustContinue = false;
    trays = { human: [], ai: [] };
    pending = { human: [], ai: [] };
    lastMove = null; history = []; moveCount = 0;
    startTime = Date.now(); endAt = 0;
    timeLeft = TURN_TIME;
    hintCells = null;
    // An interrupted AI turn (New Game / Home mid-thinking) cancels the chip
    // sequence's scheduled callbacks; drop any chip left glowing.
    var chips = els['phase-row'].querySelectorAll('.phase-chip');
    for (var i = 0; i < chips.length; i++) chips[i].classList.remove('active');
    rebuildPieceLayer();
    els['over-overlay'].classList.add('hidden');
    els['pause-overlay'].classList.add('hidden');
  }

  /* If a decided game is being abandoned before its end was reported (e.g. New
   * Game clicked during the final move's animation), report gameEnd first so
   * the agent's knowledge never silently loses a finished game. */
  function flushPendingGameEnd() {
    if (mode !== 'solo' || screen !== 'play' || gameEndReported || !state) return;
    var w = E.winner(state);
    if (w) {
      gameEndReported = true;
      if (!handicappedGame) safeMonitor({ type: 'gameEnd', winner: w });
    }
  }

  /* A solo game must never start while a multiplayer link is open. */
  function teardownAnyNetSession() {
    if (netSession) { netSession.close(); netSession = null; }
  }

  function startGame() {
    teardownAnyNetSession();
    generation++; clearTimers();
    mode = 'solo'; mySide = E.RED;
    state = E.initialState();
    resetVisualState();
    screen = 'play';
    els['title-overlay'].classList.add('hidden');
    handicappedGame = (difficulty === 'easy');
    updateOpponentLabels();
    safeMonitor({ type: 'gameStart' });
    track('game_started', { mode: 'agent', difficulty: difficulty });
    sfx('select');
    refreshInsights();
    render();
  }
  function newGame() {
    flushPendingGameEnd();
    teardownAnyNetSession();
    generation++; clearTimers();
    mode = 'solo'; mySide = E.RED;
    state = E.initialState();
    resetVisualState();
    screen = 'play';
    els['title-overlay'].classList.add('hidden');
    handicappedGame = (difficulty === 'easy');
    updateOpponentLabels();
    safeMonitor({ type: 'gameStart' });
    track('game_started', { mode: 'agent', difficulty: difficulty });
    sfx('select');
    refreshInsights();
    render();
  }
  function goTitle() {
    flushPendingGameEnd();
    teardownAnyNetSession();
    generation++; clearTimers();
    mode = 'solo'; mySide = E.RED;
    state = E.initialState();
    resetVisualState();
    screen = 'title';
    els['title-overlay'].classList.remove('hidden');
    updateOpponentLabels();
    updateTitleBrain();
    render();
  }

  function pushHistory() {
    history.push({
      state: E.clone(state),
      trays: { human: trays.human.slice(), ai: trays.ai.slice() },
      lastMove: lastMove,
      moveCount: moveCount
    });
  }
  function undo() {
    if (mode !== 'solo') return; // undo would desync the two peers' replicated state
    if (screen !== 'play' || over || paused || thinking || committing || mustContinue || !history.length) return;
    if (!state || state.turn !== mySide) return;
    track('undo_used', { moveCount: moveCount });
    generation++; clearTimers();
    var snap = history.pop();
    state = snap.state;
    trays = snap.trays;
    lastMove = snap.lastMove;
    moveCount = snap.moveCount;
    selected = null; candidates = []; stepIndex = 0; mustContinue = false;
    hintCells = null; thinking = false;
    timeLeft = TURN_TIME;
    rebuildPieceLayer();
    sfx('select');
    render();
  }

  function onCell(r, c) {
    if (screen !== 'play' || over || paused || thinking || committing || !state || state.turn !== mySide) return;
    ensureAudio();

    if (selected) {
      var t = [r, c];
      var filtered = [];
      for (var i = 0; i < candidates.length; i++) {
        var m = candidates[i];
        if (m.path.length > stepIndex && samePos(m.path[stepIndex], t)) filtered.push(m);
      }
      if (filtered.length) { advanceStep(t, filtered); return; }
      if (mustContinue) return; // chain in progress: only continuation squares accepted
    }

    var cellData = state.board[r][c];
    if (cellData && cellData.p === mySide) {
      var all = E.legalMoves(state);
      var mine = [];
      for (var j = 0; j < all.length; j++) {
        if (samePos(all[j].from, [r, c])) mine.push(all[j]);
      }
      if (mine.length) {
        selected = [r, c];
        candidates = mine;
        stepIndex = 0;
        hintCells = null;
        sfx('select');
      }
      render();
      return;
    }
    selected = null; candidates = []; stepIndex = 0;
    render();
  }

  function advanceStep(target, filtered) {
    var capSq = (filtered[0].captures.length > stepIndex) ? filtered[0].captures[stepIndex] : null;
    if (capSq) {
      // Engine state is still pre-move here; stage the visually-captured
      // piece so counts/trays track the board through the chain.
      var capCell = state.board[capSq[0]][capSq[1]];
      pending.human.push({ king: !!(capCell && capCell.k) });
    }
    stepVisual(selected, target, capSq);
    stepIndex++;
    selected = target;
    var continuing = [];
    for (var i = 0; i < filtered.length; i++) {
      if (filtered[i].path.length > stepIndex) continuing.push(filtered[i]);
    }
    if (continuing.length) {
      candidates = continuing;
      mustContinue = true;
      timeLeft = TURN_TIME;
      render();
    } else {
      commitHumanMove(filtered[0]);
    }
  }

  function commitHumanMove(mv) {
    // Let the final hop paint first: the agent's blunder search (inside the
    // playerMove monitor event) can take ~250ms and would stall the animation.
    selected = null; candidates = []; stepIndex = 0; mustContinue = false;
    hintCells = null;
    committing = true;
    render();
    schedule(function () {
      pushHistory();
      var before = state;
      // Multiplayer moves never touch the agent's knowledge — there is no
      // agent in this match, and a live match must not feed the solo agent's
      // persistent learning (that would be silently mixing two players' data).
      if (mode === 'solo') {
        var legal = E.legalMoves(before);
        safeMonitor({ type: 'playerMove', before: before, move: mv, legalMoves: legal });
      }
      state = E.applyMove(before, mv);
      for (var i = 0; i < mv.captures.length; i++) {
        var capCell = before.board[mv.captures[i][0]][mv.captures[i][1]];
        trays.human.push({ king: !!(capCell && capCell.k) });
      }
      pending.human = []; // committed for real above
      var dest = mv.path[mv.path.length - 1];
      crownIfPromoted(dest);
      lastMove = { from: mv.from, to: dest };
      moveCount++;
      committing = false;
      timeLeft = TURN_TIME;
      var w = E.winner(state);
      if (mode === 'mp') sendMove(mv);
      if (w) { finishGame(w); return; }
      render();
      if (mode === 'solo') startAiTurn();
    }, 30);
  }

  /* Human ran out of time: play a random legal move (or continuation). */
  function autoMoveHuman() {
    if (screen !== 'play' || over || paused || thinking || committing || state.turn !== mySide) return;
    var pool, offset;
    if (mustContinue && candidates.length) {
      pool = candidates; offset = stepIndex;
    } else {
      pool = selected ? candidates : E.legalMoves(state);
      if (!selected || !pool.length) pool = E.legalMoves(state);
      offset = (selected && candidates.length && !mustContinue) ? stepIndex : 0;
      if (!selected) offset = 0;
    }
    if (!pool.length) return;
    committing = true; // lock out clicks and further timer auto-moves mid-playout
    var mv = pool[Math.floor(Math.random() * pool.length)];
    if (!selected || !samePos(mv.from, selected)) {
      selected = mv.from.slice();
      candidates = [mv];
      stepIndex = 0;
      offset = 0;
    }
    var gen = generation;
    var step = offset;
    var run = function () {
      if (gen !== generation) return;
      if (step < mv.path.length) {
        var from = (step === 0) ? mv.from : mv.path[step - 1];
        var capSq = (mv.captures.length > step) ? mv.captures[step] : null;
        if (capSq) {
          var capCell = state.board[capSq[0]][capSq[1]];
          pending.human.push({ king: !!(capCell && capCell.k) });
        }
        stepVisual(from, mv.path[step], capSq);
        step++;
        schedule(run, 140);
      } else {
        selected = mv.from.slice();
        commitHumanMove(mv);
      }
    };
    // Restart visuals from where the chain already is.
    selected = (offset === 0) ? mv.from.slice() : mv.path[offset - 1].slice();
    run();
  }

  /* ------------------------------------------------------------ AI turn */

  function startAiTurn() {
    thinking = true;
    render();
    // MAPE phase chips light in sequence while the agent works.
    var gen = generation;
    var idx = 0;
    var chips = els['phase-row'].querySelectorAll('.phase-chip');
    var phaseNames = ['Monitor', 'Analyze', 'Plan', 'Execute'];
    var stepChips = function () {
      if (gen !== generation) return;
      for (var i = 0; i < chips.length; i++) chips[i].classList.toggle('active', i === idx);
      els['status-sub'].textContent = 'MAPE-K · ' + (phaseNames[idx] || 'loop');
      sfx('phase');
      idx++;
      if (idx < chips.length) schedule(stepChips, PHASE_STEP_MS);
      else schedule(function () { clearChips(); aiCompute(); }, PHASE_STEP_MS + 20);
    };
    var clearChips = function () {
      for (var i = 0; i < chips.length; i++) chips[i].classList.remove('active');
      els['status-sub'].textContent = 'MAPE-K · loop';
    };
    schedule(stepChips, 150);
  }

  function matchToLegal(mv, legal) {
    if (!mv) return null;
    var key = JSON.stringify([mv.from, mv.path, mv.captures]);
    for (var i = 0; i < legal.length; i++) {
      if (JSON.stringify([legal[i].from, legal[i].path, legal[i].captures]) === key) return legal[i];
    }
    for (var j = 0; j < legal.length; j++) {
      if (JSON.stringify([legal[j].from, legal[j].path]) === JSON.stringify([mv.from, mv.path])) return legal[j];
    }
    return null;
  }

  function pickAiMove(before, legal) {
    // Easy mode plays loose: mostly random when not forced to capture.
    lastMoveFromAgent = false;
    var hasCapture = legal.length && legal[0].captures.length > 0;
    if (difficulty === 'easy' && !hasCapture && Math.random() < 0.7) {
      return legal[Math.floor(Math.random() * legal.length)];
    }
    var mv = null;
    if (agent) {
      try { mv = agent.chooseMove(E.clone(before)); } catch (err) { mv = null; }
    }
    mv = matchToLegal(mv, legal);
    if (mv) { lastMoveFromAgent = true; return mv; }
    return legal[Math.floor(Math.random() * legal.length)];
  }

  function aiCompute() {
    if (screen !== 'play' || over) return;
    var before = state;
    var legal = E.legalMoves(before);
    if (!legal.length) { finishGame(E.winner(before) || mySide); return; }
    var mv = pickAiMove(before, legal);
    // Only moves the agent actually chose feed its opening book; recording
    // easy-mode random moves as 'aiMove' would corrupt persistent learning.
    if (lastMoveFromAgent) safeMonitor({ type: 'aiMove', before: before, move: mv });
    state = E.applyMove(before, mv);
    // Captures are staged in pending.ai and moved to the tray hop by hop so
    // the panel tracks the visual board during multi-jump animations.
    for (var i = 0; i < mv.captures.length; i++) {
      var capCell = before.board[mv.captures[i][0]][mv.captures[i][1]];
      pending.ai.push({ king: !!(capCell && capCell.k) });
    }
    animateAiMove(mv);
  }

  function animateAiMove(mv) {
    var gen = generation;
    var step = 0;
    var run = function () {
      if (gen !== generation) return;
      if (step < mv.path.length) {
        var from = (step === 0) ? mv.from : mv.path[step - 1];
        var capSq = (mv.captures.length > step) ? mv.captures[step] : null;
        stepVisual(from, mv.path[step], capSq);
        if (capSq) {
          if (pending.ai.length) trays.ai.push(pending.ai.shift());
          render(); // counts and tray follow each hop, like the prototype
        }
        step++;
        schedule(run, AI_STEP_MS);
      } else {
        trays.ai = trays.ai.concat(pending.ai);
        pending.ai = [];
        var dest = mv.path[mv.path.length - 1];
        crownIfPromoted(dest);
        lastMove = { from: mv.from, to: dest };
        moveCount++;
        thinking = false;
        timeLeft = TURN_TIME;
        if (mode === 'solo') refreshInsights();
        var w = E.winner(state);
        if (w) { finishGame(w); return; }
        render();
      }
    };
    run();
  }

  /* ------------------------------------------------------------ multiplayer */

  function sendMove(mv) {
    if (netSession) netSession.send({ type: 'move', move: mv });
  }

  /* Applies an already-validated opponent move and reuses animateAiMove
   * (side-agnostic: it only moves pieces along a path and updates the
   * "other side" tray/pending state) for the visuals and winner check. */
  function receiveOpponentMove(mv) {
    var before = state;
    state = E.applyMove(before, mv);
    for (var i = 0; i < mv.captures.length; i++) {
      var capCell = before.board[mv.captures[i][0]][mv.captures[i][1]];
      pending.ai.push({ king: !!(capCell && capCell.k) });
    }
    animateAiMove(mv);
  }

  function handlePeerMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'move') {
      if (mode !== 'mp' || over || !state || state.turn === mySide) return; // stray/late message
      var validated = Net.isLegalWireMove(msg.move, state, E);
      if (!validated) return; // defensive: never trust the wire
      receiveOpponentMove(validated);
    } else if (msg.type === 'rematch') {
      if (mode === 'mp') startMultiplayerRematch(false);
    } else if (msg.type === 'leave') {
      handlePeerClose();
    }
  }

  function handlePeerClose() {
    if (mode !== 'mp') return;
    if (netSession) { netSession.close(); netSession = null; }
    if (!over) {
      els['status-main'].textContent = 'Opponent disconnected';
      els['status-sub'].textContent = 'They left the match.';
    }
    var dot = els['mp-conn-dot'];
    if (dot) dot.classList.add('off');
  }

  function updateOpponentLabels() {
    var label = (mode === 'mp') ? oppName : 'Agent';
    els['opp-name-label'].textContent = label;
    els['opp-tray-label'].textContent = label + ' captured';
    els['opp-took-label'].textContent = label + ' took';
  }

  function showMpStep(step) {
    els['mp-name-step'].classList.toggle('hidden', step !== 'name');
    els['mp-generate-step'].classList.toggle('hidden', step !== 'generate');
    els['mp-join-step'].classList.toggle('hidden', step !== 'join');
  }

  function cancelNetSession() {
    if (netSession) { netSession.close(); netSession = null; }
  }

  function openMultiplayerModal() {
    ensureAudio();
    track('multiplayer_modal_opened');
    els['mp-name-input'].value = mpName;
    showMpStep('name');
    els['mp-overlay'].classList.remove('hidden');
  }
  function closeMultiplayerModal() {
    cancelNetSession();
    els['mp-overlay'].classList.add('hidden');
  }

  function mpGenerateCode() {
    if (!Net || !window.Peer) {
      els['mp-generate-status'] && (els['mp-generate-status'].textContent = 'Networking is unavailable.');
      return;
    }
    mpName = Net.sanitizeName(els['mp-name-input'].value);
    savePrefs();
    var code = Net.makeCode();
    els['mp-code-display'].textContent = code;
    els['mp-generate-status'].textContent = 'Waiting for your opponent to join…';
    showMpStep('generate');
    track('multiplayer_host_started');
    cancelNetSession();
    netSession = new Net.Session({
      onOpen: function (theirName) {
        oppName = theirName;
        beginMultiplayerMatch(E.RED);
      },
      onPeerMessage: handlePeerMessage,
      onPeerClose: handlePeerClose,
      onError: function (msg) {
        els['mp-generate-status'].textContent = 'Error: ' + msg;
      }
    });
    netSession.host(code, mpName);
  }

  function mpConnectWithCode() {
    if (!Net || !window.Peer) {
      els['mp-join-status'].textContent = 'Networking is unavailable.';
      return;
    }
    var code = els['mp-code-input'].value.trim();
    if (!Net.isValidCode(code)) { els['mp-join-status'].textContent = 'Enter a 4-digit code.'; return; }
    mpName = Net.sanitizeName(els['mp-name-input'].value);
    savePrefs();
    els['mp-join-status'].textContent = 'Connecting…';
    track('multiplayer_join_attempted');
    cancelNetSession();
    netSession = new Net.Session({
      onOpen: function (theirName) {
        oppName = theirName;
        beginMultiplayerMatch(E.BLACK);
      },
      onPeerMessage: handlePeerMessage,
      onPeerClose: handlePeerClose,
      onError: function (msg) {
        els['mp-join-status'].textContent = 'Could not connect: ' + msg;
      }
    });
    netSession.join(code, mpName);
  }

  function beginMultiplayerMatch(side) {
    generation++; clearTimers();
    mode = 'mp'; mySide = side;
    state = E.initialState();
    resetVisualState();
    screen = 'play';
    els['mp-overlay'].classList.add('hidden');
    els['title-overlay'].classList.add('hidden');
    els['agent-panel'].classList.add('hidden');
    els['mp-panel'].classList.remove('hidden');
    els['btn-undo'].disabled = true;
    els['mp-my-name'].textContent = mpName;
    els['mp-opp-name'].textContent = oppName;
    var dot = els['mp-conn-dot'];
    if (dot) dot.classList.remove('off');
    updateOpponentLabels();
    track('game_started', { mode: 'friend', side: side === E.RED ? 'host' : 'guest' });
    sfx('select');
    render();
  }

  function leaveMultiplayer() {
    if (netSession) {
      track('multiplayer_left');
      try { netSession.send({ type: 'leave' }); } catch (err) {}
      netSession.close();
      netSession = null;
    }
    els['mp-panel'].classList.add('hidden');
    els['agent-panel'].classList.remove('hidden');
    els['btn-undo'].disabled = false;
    goTitle(); // resets mode/mySide back to solo defaults
  }

  function startMultiplayerRematch(announce) {
    generation++; clearTimers();
    state = E.initialState();
    resetVisualState();
    screen = 'play';
    els['over-overlay'].classList.add('hidden');
    if (announce && netSession) netSession.send({ type: 'rematch' });
    sfx('select');
    render();
  }

  /* ------------------------------------------------------------ game end */

  function finishGame(w, quit) {
    over = true;
    winnerSide = w; // 'R' | 'B' | 'draw'
    endAt = Date.now();
    thinking = false;
    paused = false;
    els['pause-overlay'].classList.add('hidden');
    if (!gameEndReported) {
      gameEndReported = true;
      // Easy-mode games are handicapped (random AI moves); folding their
      // outcome would pollute the persistent opening book and W/L record.
      // Multiplayer games never touch the agent's knowledge at all.
      if (mode === 'solo' && !handicappedGame) safeMonitor({ type: 'gameEnd', winner: w });
    }
    if (mode === 'solo') { refreshInsights(); updateTitleBrain(); }
    els['adapt-stat-block'].classList.toggle('hidden', mode === 'mp');

    var headline = els['result-headline'];
    headline.classList.remove('win', 'lose', 'draw');
    if (w === mySide) {
      headline.textContent = 'Victory';
      headline.classList.add('win');
      els['result-sub'].textContent = (mode === 'mp') ? 'You won the match.' : 'You outplayed the agent.';
      sfx('win');
    } else if (w === 'draw') {
      headline.textContent = 'Draw';
      headline.classList.add('draw');
      els['result-sub'].textContent = 'Neither side could break through.';
      sfx('select');
    } else {
      headline.textContent = 'Defeated';
      headline.classList.add('lose');
      els['result-sub'].textContent = quit
        ? 'You quit the match — it counts as a loss.'
        : ((mode === 'mp') ? (oppName + ' won this one.') : 'The agent adapted to you.');
      sfx('lose');
    }
    els['stat-moves'].textContent = String(moveCount);
    var dur = Math.max(0, Math.floor((endAt - startTime) / 1000));
    els['stat-duration'].textContent = Math.floor(dur / 60) + ':' + String(dur % 60).padStart(2, '0');
    els['stat-you-final'].textContent = String(trays.human.length);
    els['stat-agent-final'].textContent = String(trays.ai.length);
    els['stat-adapt'].textContent = currentLevel() + '%';
    els['over-overlay'].classList.remove('hidden');
    track('game_ended', {
      mode: mode,
      result: (w === mySide) ? 'win' : (w === 'draw' ? 'draw' : 'loss'),
      quit: !!quit,
      moves: moveCount,
      durationSec: Math.max(0, Math.floor((endAt - startTime) / 1000)),
      difficulty: (mode === 'solo') ? difficulty : undefined,
      handicapped: (mode === 'solo') ? handicappedGame : undefined
    });
    els['nps-strip'].classList.add('hidden');
    els['nps-thanks'].classList.add('hidden');
    maybeShowNps();
    render();
  }

  /* ------------------------------------------------------------ NPS survey */

  var NPS_KEY = 'checkers-nps-state';
  var NPS_TRIGGER_GAMES = [1, 4, 9]; // ask after the 1st, 4th, and 9th completed game
  var NPS_MAX_DISMISSALS = 2;
  var npsState = null;

  function loadNpsState() {
    try {
      var raw = localStorage.getItem(NPS_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        return {
          submitted: !!p.submitted,
          dismissedCount: Number.isFinite(p.dismissedCount) ? p.dismissedCount : 0,
          gamesSeen: Number.isFinite(p.gamesSeen) ? p.gamesSeen : 0
        };
      }
    } catch (err) { /* corrupt/unavailable storage falls back to defaults */ }
    return { submitted: false, dismissedCount: 0, gamesSeen: 0 };
  }
  function saveNpsState() {
    try { localStorage.setItem(NPS_KEY, JSON.stringify(npsState)); } catch (err) {}
  }

  // Called once per completed game (win, loss, draw, or quit) to decide
  // whether this is one of the few moments we ask for gameplay feedback.
  function maybeShowNps() {
    if (!npsState) npsState = loadNpsState();
    npsState.gamesSeen++;
    saveNpsState();
    if (npsState.submitted || npsState.dismissedCount >= NPS_MAX_DISMISSALS) return;
    if (NPS_TRIGGER_GAMES.indexOf(npsState.gamesSeen) === -1) return;
    els['nps-strip'].classList.remove('hidden');
    track('nps_shown', { gamesSeen: npsState.gamesSeen });
  }
  function submitNps(score) {
    if (!npsState) npsState = loadNpsState();
    npsState.submitted = true;
    saveNpsState();
    var category = score >= 9 ? 'promoter' : (score >= 7 ? 'passive' : 'detractor');
    track('nps_submitted', { score: score, category: category, gamesSeen: npsState.gamesSeen });
    els['nps-strip'].classList.add('hidden');
    els['nps-thanks'].classList.remove('hidden');
  }
  function dismissNps() {
    if (!npsState) npsState = loadNpsState();
    npsState.dismissedCount++;
    saveNpsState();
    track('nps_dismissed', { gamesSeen: npsState.gamesSeen, dismissedCount: npsState.dismissedCount });
    els['nps-strip'].classList.add('hidden');
  }

  /* ------------------------------------------------------------ share */

  var toastTimer = null;
  function showToast(msg) {
    var t = els.toast;
    t.textContent = msg;
    t.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  function shareText() {
    if (over) {
      if (winnerSide === mySide) return 'I just beat a MAPE-K learning AI at Neon Checkers. Think you can do better?';
      if (winnerSide === 'draw') return 'Just drew with a MAPE-K learning AI at Neon Checkers — it studies how you play. Try it:';
      return 'This MAPE-K agent in Neon Checkers is studying how I play, and it is winning. Can you beat it?';
    }
    return 'Play Neon Checkers — a checkers game with a MAPE-K agent that learns your style and adapts to beat you.';
  }

  function copyLink() {
    var url = location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(url);
    }
    // Older-browser fallback: a temporary offscreen textarea + execCommand.
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('execCommand copy returned false'));
      } catch (err) { reject(err); }
    });
  }

  function shareGame() {
    ensureAudio();
    var context = over ? 'result' : 'topbar';
    track('share_clicked', { context: context, mode: mode });
    var payload = { title: 'Neon Checkers', text: shareText(), url: location.href };
    if (navigator.share) {
      navigator.share(payload).then(function () {
        track('share_completed', { context: context, method: 'native' });
      }).catch(function (err) {
        if (err && err.name === 'AbortError') { track('share_dismissed', { context: context, method: 'native' }); return; }
        track('share_failed', { context: context, method: 'native', error: String(err && err.message || err) });
      });
      return;
    }
    copyLink().then(function () {
      showToast('Link copied — paste it anywhere!');
      track('share_completed', { context: context, method: 'copy' });
    }).catch(function (err) {
      showToast('Could not copy the link.');
      track('share_failed', { context: context, method: 'copy', error: String(err && err.message || err) });
    });
  }

  /* ------------------------------------------------------------ hint / timer */

  function showHint() {
    if (screen !== 'play' || over || paused || thinking || committing || mustContinue || state.turn !== mySide) return;
    ensureAudio();
    var legal = E.legalMoves(state);
    if (!legal.length) return;
    track('hint_used', { moveCount: moveCount });
    if (!hintAgent && AIRoot) {
      try { hintAgent = new (AIRoot.MapeKAgent || AIRoot)({ storage: 'memory' }); } catch (err) { hintAgent = null; }
    }
    schedule(function () {
      var mv = null;
      if (hintAgent) {
        try { mv = hintAgent.chooseMove(E.clone(state)); } catch (err) { mv = null; }
      }
      mv = matchToLegal(mv, legal) || legal[0];
      hintCells = { from: mv.from, to: mv.path[mv.path.length - 1] };
      sfx('select');
      render();
      schedule(function () { hintCells = null; render(); }, 1800);
    }, 30);
  }

  function onTimerTick() {
    if (screen !== 'play' || over || paused) return;
    var t = timeLeft - 1;
    if (t <= 5 && t >= 0) sfx('tick');
    if (t < 0) {
      if (state.turn === mySide && !thinking) autoMoveHuman();
      else timeLeft = TURN_TIME;
      renderTimer();
      return;
    }
    timeLeft = t;
    renderTimer();
  }
  function renderTimer() {
    var pct = Math.max(0, Math.min(100, (timeLeft / TURN_TIME) * 100));
    var low = timeLeft <= 5;
    els['timer-bar'].style.width = pct + '%';
    els['timer-bar'].classList.toggle('low', low);
    els['timer-num'].classList.toggle('low', low);
    els['timer-num'].textContent = (timeLeft < 0 ? 0 : timeLeft) + 's';
  }

  /* ------------------------------------------------------------ pause / quit */

  // Pausing is allowed at any point during an active game, regardless of
  // whose turn it is — it only freezes THIS browser's timer/input, never the
  // shared game state, so there is nothing turn-sensitive to protect here.
  function canPause() {
    return screen === 'play' && !over && !paused;
  }

  function openPause() {
    if (!canPause()) return;
    ensureAudio();
    paused = true;
    var sub;
    if (mode === 'mp' && state.turn !== mySide) {
      sub = 'Your opponent can still move while you are paused.';
    } else if (mode === 'solo' && state.turn !== mySide) {
      sub = 'The agent will finish its move in the background.';
    } else {
      sub = 'Your timer is stopped.';
    }
    els['pause-sub'].textContent = sub;
    els['pause-overlay'].classList.remove('hidden');
    track('game_paused', { mode: mode });
    sfx('select');
    render();
  }

  function resumeGame() {
    if (!paused) return;
    paused = false;
    els['pause-overlay'].classList.add('hidden');
    track('game_resumed', { mode: mode });
    sfx('select');
    render();
  }

  function quitGame() {
    if (screen !== 'play' || over) return;
    var confirmMsg = (mode === 'mp')
      ? 'Quit this match? Your opponent will be notified and the match ends immediately.'
      : 'Quit this game? It will count as a loss.';
    if (!window.confirm(confirmMsg)) return;
    els['pause-overlay'].classList.add('hidden');
    paused = false;
    if (mode === 'mp') {
      leaveMultiplayer();
    } else {
      var loserSide = (mySide === E.RED) ? E.BLACK : E.RED;
      finishGame(loserSide, true);
    }
  }

  /* ------------------------------------------------------------ adaptation card */

  var levelCache = 0;
  function currentLevel() { return levelCache; }

  function refreshInsights() {
    var ins = safeInsights();
    if (!ins) return;
    var k = ins.knowledge || {};
    var a = ins.analyze || {};
    var p = ins.plan || {};
    var mon = ins.monitor || {};
    var ex = ins.execute || {};
    var games = k.gamesPlayed || 0;
    var record = k.record || { w: 0, l: 0, d: 0 };
    var profile = a.profile || {};
    var movesSeen = profile.moves || 0;
    var conf = (typeof a.confidence === 'number') ? a.confidence : 0;
    var adapts = (p.strategy && p.strategy.adaptations) ? p.strategy.adaptations.length : 0;

    levelCache = Math.round(100 * Math.min(1,
      0.55 * conf + 0.25 * Math.min(1, games / 6) + 0.20 * Math.min(1, adapts / 3)));

    els['brain-games'].textContent = String(games);
    els['brain-moves'].textContent = String(movesSeen);
    els['agent-wins'].textContent = String(record.w || 0);
    els['player-wins'].textContent = String(record.l || 0);
    els['brain-draws'].textContent = String(record.d || 0);
    els['level-num'].textContent = String(levelCache);

    // MAPE-K live panel: five labelled sections fed from getInsights()
    // (SPEC UI contract), null-safe before the first AI move.
    var events = mon.recentEvents || [];
    els['live-monitor'].textContent = events.length
      ? events[0] + ' · ' + events.length + ' event' + (events.length === 1 ? '' : 's')
      : 'No events yet';
    els['live-analyze'].textContent = (a.style || 'unknown') + ' · confidence ' + Math.round(conf * 100) + '%';
    var rationale = p.rationale || [];
    els['live-plan'].textContent = rationale.length ? rationale[0] : 'Baseline strategy';
    els['live-execute'].textContent = 'eval ' + Math.round((typeof ex.lastEval === 'number') ? ex.lastEval : 0) +
      ' · depth ' + (ex.depth || 0) + ' · ' + (ex.nodes || 0) + ' nodes';
    els['live-knowledge'].textContent = (k.adaptationLevel || 'baseline') + ' · ' +
      (record.w || 0) + 'W ' + (record.l || 0) + 'L ' + (record.d || 0) + 'D';

    var C = 2 * Math.PI * 42;
    els['ring-arc'].setAttribute('stroke-dasharray', String(C));
    els['ring-arc'].setAttribute('stroke-dashoffset', String(C * (1 - levelCache / 100)));

    var skill;
    if (difficulty === 'easy') skill = 12;
    else if (difficulty === 'hard') skill = 95;
    else skill = 18 + Math.round(77 * levelCache / 100);
    els['skill-pct'].textContent = skill + '%';
  }

  function updateTitleBrain() {
    var ins = safeInsights();
    var games = ins && ins.knowledge ? (ins.knowledge.gamesPlayed || 0) : 0;
    els['title-brain'].textContent = games > 0
      ? "It already knows " + currentLevel() + "% of how you play, across " + games + " games. It's not done watching."
      : 'It knows nothing about you. Yet.';
  }

  /* ------------------------------------------------------------ settings */

  function applyPrefsToUI() {
    els.app.classList.toggle('colorblind', colorblind);
    els['icon-sound-on'].classList.toggle('hidden', muted);
    els['icon-sound-off'].classList.toggle('hidden', !muted);
    var st = els['btn-sound-toggle'];
    st.classList.toggle('on', !muted);
    st.textContent = muted ? 'Off' : 'On';
    var cb = els['btn-cb-toggle'];
    cb.classList.toggle('on', colorblind);
    cb.textContent = colorblind ? 'On' : 'Off';
    var chips = els['diff-row'].querySelectorAll('.diff-chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].classList.toggle('active', chips[i].getAttribute('data-diff') === difficulty);
    }
    var notes = {
      adaptive: 'The agent scales with what it has learned about you.',
      easy: 'The agent plays loose and forgiving.',
      hard: 'The agent plays its strongest at all times.'
    };
    els['diff-note'].textContent = notes[difficulty];
  }
  function toggleMute() {
    ensureAudio();
    muted = !muted;
    savePrefs();
    applyPrefsToUI();
    track('sound_toggled', { muted: muted });
  }
  function toggleColorblind() {
    colorblind = !colorblind;
    savePrefs();
    applyPrefsToUI();
    track('colorblind_toggled', { colorblind: colorblind });
  }
  function setDifficulty(d) {
    if (d !== 'easy' && d !== 'hard' && d !== 'adaptive') return;
    difficulty = d;
    // Switching to easy mid-game taints the whole game for learning purposes;
    // the flag is recomputed at the next gameStart.
    if (d === 'easy') handicappedGame = true;
    savePrefs();
    applyPrefsToUI();
    refreshInsights();
    track('difficulty_changed', { difficulty: d });
  }
  function resetBrain() {
    if (!agent) return;
    if (!window.confirm('Erase everything the agent has learned about you?')) return;
    try { agent.resetKnowledge(); } catch (err) {}
    refreshInsights();
    updateTitleBrain();
    sfx('select');
    track('reset_brain_clicked');
  }

  /* ------------------------------------------------------------ render */

  function render() {
    // The title overlay visually covers the topbar/board completely (it's an
    // opaque position:absolute layer), but they were still sitting in normal
    // document flow underneath it, stretching .app (and the whole page) far
    // taller than the title screen's own content needs. Take them out of
    // flow entirely while not in play instead of just covering them.
    els['topbar'].classList.toggle('hidden', screen !== 'play');
    els['layout'].classList.toggle('hidden', screen !== 'play');

    renderTimer();

    var humanTurn = screen === 'play' && !over && !paused && !thinking && !committing && state.turn === mySide;
    els['btn-pause'].disabled = !canPause();

    // Status card
    var dot = els['turn-dot'];
    // While thinking the engine state may already hold the applied AI move
    // (turn flipped back to mySide mid-animation); the dot stays on the agent.
    dot.classList.toggle('ai', !over && (thinking || state.turn !== mySide));
    if (paused) {
      els['status-main'].textContent = 'Paused';
      els['status-sub'].textContent = 'Tap Resume to continue';
    } else if (thinking) {
      els['status-main'].textContent = 'Agent thinking…';
      els['status-sub'].textContent = 'MAPE-K · loop';
    } else if (over) {
      els['status-main'].textContent = winnerSide === mySide ? 'You win' : (winnerSide === 'draw' ? 'Draw' : (mode === 'mp' ? oppName + ' wins' : 'Agent wins'));
      els['status-sub'].textContent = 'Game over';
    } else if (state.turn === mySide) {
      els['status-main'].textContent = mustContinue ? 'Keep jumping!' : 'Your move';
      // SPEC UI contract: surface the forced-capture rule in the status bar.
      // Mid-chain keeps the prototype's 'Move a glowing piece' sub-text.
      var lmAll = E.legalMoves(state);
      var forcedCap = lmAll.length > 0 && lmAll[0].captures.length > 0;
      els['status-sub'].textContent = (forcedCap && !mustContinue) ? 'Capture is mandatory' : 'Move a glowing piece';
    } else if (mode === 'mp') {
      els['status-main'].textContent = oppName + '’s move';
      els['status-sub'].textContent = '…';
    } else {
      els['status-main'].textContent = 'Agent’s move';
      els['status-sub'].textContent = '…';
    }

    // Piece counts
    var humanCount = 0, aiCount = 0;
    for (var r = 0; r < 8; r++) {
      for (var c = 0; c < 8; c++) {
        var cellData = state.board[r][c];
        if (cellData) { if (cellData.p === mySide) humanCount++; else aiCount++; }
      }
    }
    // pending.human: shown as captured on the board, not yet in engine state.
    // pending.ai: removed from engine state, still visible on the board.
    els['human-count'].textContent = String(humanCount + pending.ai.length);
    els['ai-count'].textContent = String(aiCount - pending.human.length);

    // Targets of the current selection step
    var stepSet = {}, capSet = {};
    if (selected && candidates.length) {
      for (var i = 0; i < candidates.length; i++) {
        var m = candidates[i];
        if (m.path.length > stepIndex) {
          var key = posKey(m.path[stepIndex]);
          stepSet[key] = true;
          if (m.captures.length > stepIndex) capSet[key] = true;
        }
      }
    }
    var hFrom = hintCells ? posKey(hintCells.from) : null;
    var hTo = hintCells ? posKey(hintCells.to) : null;
    var lmFrom = lastMove ? posKey(lastMove.from) : null;
    var lmTo = lastMove ? posKey(lastMove.to) : null;

    for (r = 0; r < 8; r++) {
      for (c = 0; c < 8; c++) {
        var cell = cellEls[r][c];
        var key2 = r + ',' + c;
        cell.classList.toggle('clickable', humanTurn);
        cell.classList.toggle('lastmove', key2 === lmFrom || key2 === lmTo);
        cell.classList.toggle('selected', !!(selected && samePos(selected, [r, c])));
        var old = cell.querySelectorAll('.step-hint, .cap-hint, .hint-square');
        for (var o = 0; o < old.length; o++) cell.removeChild(old[o]);
        if (stepSet[key2]) {
          var dotEl = document.createElement('div');
          dotEl.className = capSet[key2] ? 'cap-hint' : 'step-hint';
          cell.appendChild(dotEl);
        }
        if (key2 === hFrom || key2 === hTo) {
          var hintEl = document.createElement('div');
          hintEl.className = 'hint-square';
          cell.appendChild(hintEl);
        }
      }
    }

    // Movable-piece rings (only when nothing is selected)
    var movable = {};
    if (humanTurn && !selected) {
      var all = E.legalMoves(state);
      for (var j = 0; j < all.length; j++) movable[posKey(all[j].from)] = true;
    }
    for (r = 0; r < 8; r++) {
      for (c = 0; c < 8; c++) {
        var node = nodes[r][c];
        if (!node) continue;
        var ring = node.querySelector('.movable-ring');
        if (ring) ring.classList.toggle('hidden', !movable[r + ',' + c]);
        node.classList.toggle('front', !!(selected && samePos(selected, [r, c])));
      }
    }

    // Capture trays (pending.human already popped on the board, so it shows;
    // pending.ai is not yet popped, so it does not)
    renderTray(els['human-tray'], trays.human.concat(pending.human), 'p2'); // human captured agent pieces
    renderTray(els['ai-tray'], trays.ai, 'p1');                             // agent captured human pieces
    els['stat-you'].textContent = String(trays.human.length + pending.human.length);
    els['stat-agent'].textContent = String(trays.ai.length);
  }

  function renderTray(container, list, cls) {
    container.textContent = '';
    for (var i = 0; i < list.length; i++) {
      var t = document.createElement('div');
      t.className = 'tray-piece ' + cls;
      if (list[i].king) {
        var kr = document.createElement('div');
        kr.className = 'tray-king';
        t.appendChild(kr);
      }
      container.appendChild(t);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
