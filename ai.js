/*
 * ai.js — MAPE-K autonomic checkers agent (IBM autonomic computing reference
 * architecture; Kephart & Chess 2003, "The Vision of Autonomic Computing").
 *
 * The managed element is the checkers match against one specific human player.
 * The autonomic manager is composed of five explicit classes:
 *
 *   Monitor        — ingests game events (sensors), extracts per-move features
 *                    (exposure, edge use, advancement, king usage, >=4-ply
 *                    blunder detection) and records raw observations.
 *   Analyzer       — aggregates raw observations into a player profile with
 *                    sample-size confidence and a style classification.
 *   Planner        — turns the analysis + opening-book history into a concrete
 *                    strategy (eval weights, trap-seeking, search depth,
 *                    opening-line biases) with a human-readable rationale.
 *   Executor       — effects the strategy: iterative-deepening alpha-beta with
 *                    capture-first ordering, quiescence on captures and a
 *                    ~400ms wall-clock cap.
 *   KnowledgeBase  — the K in MAPE-K. Schema-versioned, corrupt-data-safe,
 *                    persisted knowledge plus volatile session data. The four
 *                    phases communicate ONLY through this class: no phase holds
 *                    a reference to another phase and no data is passed between
 *                    them directly. (Shared stateless helpers — move keys,
 *                    evaluation, search — are pure functions, not channels.)
 *
 * The agent always plays to win at full strength; adaptation exploits the
 * observed player better (traps, center squeeze, deeper search, opening lines),
 * it never handicaps the agent.
 *
 * Attaches one global `CheckersAI`; CommonJS guard for node tests.
 */
(function (global) {
  'use strict';

  var Engine = (typeof module !== 'undefined' && module.exports)
    ? require('./engine.js')
    : global.CheckersEngine;

  const SCHEMA_VERSION = 1;
  const MATE = 30000;
  const TIMEOUT = { timeout: true }; // sentinel thrown when the clock runs out

  // Baseline evaluation weights (SPEC: man 100, king 160 + positional terms).
  const DEFAULT_WEIGHTS = Object.freeze({
    man: 100,
    king: 160,
    advance: 4,   // per row of forward progress for men
    center: 6,    // per column-centrality point
    backRow: 12,  // per own man still guarding the back row
    mobility: 3,  // per empty adjacent destination square
    trap: 0       // per immediate capture threat (enabled by the Planner)
  });

  // All tunables in one place so Planner adaptations are explicit and testable.
  const TUNING = Object.freeze({
    timeCapMs: 400,       // Executor wall-clock cap
    baseDepth: 8,         // default iterative-deepening cap
    deepDepth: 11,        // depth vs low-blunder (skilled) players
    qDepth: 8,            // max quiescence extension plies
    minMoves: 6,          // min observed moves before style adaptations
    trapExposure: 0.22,   // exposureRate threshold -> trap-seeking
    trapWeight: 16,       // eval weight per capture threat when trap-seeking
    trapRootScale: 3,     // root bonus scale for exposing-reply fraction
    centerEdge: 0.35,     // edgePreference threshold -> center boost
    centerBoost: 14,      // raised center weight
    skilledBlunder: 0.10, // blunderRate at/below which player is "skilled"
    minEvaluated: 10,     // min blunder-evaluated moves for depth adaptation
    blunderMargin: 100,   // a man's value; loss vs best alternative = blunder
    blunderDepth: 4,      // >= 4-ply comparison search
    blunderTimeMs: 250,   // safety cap for the blunder check
    bookPlies: 8,         // opening book covers positions with ply < 8
    bookCap: 400,         // max distinct positions kept in the book
    openingWeight: 90,    // max root bias from opening-book outcomes (< man)
    confidenceMoves: 40,  // moves at which profile confidence reaches 1.0
    recentCap: 24         // recent-event log length
  });

  // ------------------------------------------------------------------
  // Shared pure helpers (stateless; used by phases but carry no state).
  // ------------------------------------------------------------------

  function moveKey(move) {
    return move.from.join(',') + '>' + move.path.map(function (p) { return p.join(','); }).join('>');
  }

  function opposite(side) {
    return side === Engine.RED ? Engine.BLACK : Engine.RED;
  }

  const CENTER_SCORE = [0, 1, 2, 3, 3, 2, 1, 0];
  const DIRS_ALL = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const DIRS_RED = [[-1, -1], [-1, 1]];
  const DIRS_BLACK = [[1, -1], [1, 1]];

  /*
   * Static evaluation from the perspective of `state.turn`.
   * Material + advance + center control + back-row guard + mobility + trap
   * (immediate capture threats), each weighted by the Planner's strategy.
   */
  function evaluate(state, w) {
    const board = state.board;
    const me = state.turn;
    let score = 0;
    for (let r = 0; r < 8; r++) {
      for (let c = (r % 2 === 0) ? 1 : 0; c < 8; c += 2) {
        const cell = board[r][c];
        if (!cell) continue;
        let v = cell.k ? w.king : w.man;
        if (!cell.k) {
          v += w.advance * (cell.p === Engine.RED ? 7 - r : r);
          if ((cell.p === Engine.RED && r === 7) || (cell.p === Engine.BLACK && r === 0)) {
            v += w.backRow;
          }
        }
        v += w.center * CENTER_SCORE[c];
        const dirs = cell.k ? DIRS_ALL : (cell.p === Engine.RED ? DIRS_RED : DIRS_BLACK);
        for (let i = 0; i < dirs.length; i++) {
          const nr = r + dirs[i][0];
          const nc = c + dirs[i][1];
          if (nr < 0 || nr > 7 || nc < 0 || nc > 7) continue;
          const n = board[nr][nc];
          if (!n) {
            v += w.mobility;
          } else if (n.p !== cell.p && w.trap) {
            const jr = r + 2 * dirs[i][0];
            const jc = c + 2 * dirs[i][1];
            if (jr >= 0 && jr < 8 && jc >= 0 && jc < 8 && !board[jr][jc]) v += w.trap;
          }
        }
        score += (cell.p === me) ? v : -v;
      }
    }
    return score;
  }

  /*
   * Negamax alpha-beta with capture-first ordering and quiescence on captures
   * (forced-capture rule means "all moves are captures" marks a noisy node,
   * which we keep searching for up to `qdepth` extra plies past `depth`).
   * Throws TIMEOUT when ctx.deadline passes.
   */
  function negamax(state, depth, qdepth, alpha, beta, ctx, ply) {
    ctx.nodes++;
    if ((ctx.nodes & 255) === 0 && Date.now() > ctx.deadline) throw TIMEOUT;
    if (state.quiet >= 80) return 0; // draw by rule
    const moves = Engine.legalMoves(state);
    if (moves.length === 0) return -(MATE - ply); // side to move loses
    const noisy = moves[0].captures.length > 0;   // forced captures: all-or-none
    if (depth <= 0 && (!noisy || qdepth <= 0)) return evaluate(state, ctx.w);
    if (noisy && moves.length > 1) {
      moves.sort(function (a, b) { return b.captures.length - a.captures.length; });
    }
    let best = -Infinity;
    for (let i = 0; i < moves.length; i++) {
      const v = -negamax(
        Engine.applyMove(state, moves[i]),
        depth - 1,
        depth <= 0 ? qdepth - 1 : qdepth,
        -beta, -alpha, ctx, ply + 1
      );
      if (v > best) {
        best = v;
        if (v > alpha) alpha = v;
        if (alpha >= beta) break;
      }
    }
    return best;
  }

  /*
   * Root search: iterative deepening with per-root-move biases (opening book
   * preference/avoidance and trap-seeking bonuses). Biases are bounded below a
   * man's value, so they steer between near-equal lines but never buy a lost
   * piece. Keeps the best move of the last fully completed iteration.
   */
  function searchRoot(state, strategy, biases, moves) {
    const start = Date.now();
    const ctx = { nodes: 0, deadline: start + strategy.timeCapMs, w: strategy.weights };
    if (!moves || moves.length === 0) return { move: null, value: 0, depth: 0, nodes: 0 };
    if (moves.length === 1) return { move: moves[0], value: 0, depth: 0, nodes: 1 };

    const root = moves.map(function (m) {
      const k = moveKey(m);
      return { m: m, key: k, bias: biases[k] || 0, score: 0, caps: m.captures.length };
    });

    let best = root[0];
    let bestValue = 0;
    let completed = 0;

    for (let depth = 1; depth <= strategy.maxDepth; depth++) {
      if (completed > 0 && Date.now() - start > strategy.timeCapMs * 0.5) break;
      root.sort(function (a, b) {
        return (b.score + b.bias) - (a.score + a.bias) || (b.caps - a.caps);
      });
      let iterBest = null;
      let iterBestEff = -Infinity;
      let finished = true;
      try {
        for (let i = 0; i < root.length; i++) {
          const rm = root[i];
          // Shifted-alpha window: rm only matters if value + bias beats best.
          const alphaLocal = iterBest ? (iterBestEff - rm.bias) : -Infinity;
          const v = -negamax(
            Engine.applyMove(state, rm.m),
            depth - 1, TUNING.qDepth,
            -Infinity, alphaLocal === -Infinity ? Infinity : -alphaLocal,
            ctx, 1
          );
          rm.score = v;
          const eff = v + rm.bias;
          if (!iterBest || eff > iterBestEff) { iterBest = rm; iterBestEff = eff; }
        }
      } catch (e) {
        if (e !== TIMEOUT) throw e;
        finished = false;
      }
      if (finished && iterBest) {
        best = iterBest;
        bestValue = iterBest.score;
        completed = depth;
        if (Math.abs(bestValue) >= MATE - 200) break; // forced result found
      } else {
        break; // out of time: keep the last completed iteration's choice
      }
    }
    return { move: best.m, value: bestValue, depth: completed, nodes: ctx.nodes };
  }

  /*
   * Blunder detection (SPEC Learning requirement 1): a >=4-ply search compares
   * the played move against the player's best alternative; a drop of at least
   * a man's value is a blunder. Neutral baseline weights keep the yardstick
   * stable regardless of the current adapted strategy.
   */
  function assessBlunder(before, playedMove, legal) {
    // A forced move (fewer than 2 choices) carries zero information about
    // skill: it must not count as an evaluated non-blunder, or blunderRate
    // would be deflated and the deeper-search adaptation gamed by captures.
    if (!legal || legal.length < 2) return { evaluated: false, blunder: false };
    const ctx = { nodes: 0, deadline: Date.now() + TUNING.blunderTimeMs, w: DEFAULT_WEIGHTS };
    const playedKey = moveKey(playedMove);
    let best = -Infinity;
    let played = null;
    try {
      for (let i = 0; i < legal.length; i++) {
        const v = -negamax(
          Engine.applyMove(before, legal[i]),
          TUNING.blunderDepth - 1, TUNING.qDepth,
          -Infinity, Infinity, ctx, 1
        );
        if (v > best) best = v;
        if (moveKey(legal[i]) === playedKey) played = v;
      }
    } catch (e) {
      if (e !== TIMEOUT) throw e;
      return { evaluated: false, blunder: false };
    }
    if (played === null) return { evaluated: false, blunder: false };
    return { evaluated: true, blunder: (best - played) >= TUNING.blunderMargin };
  }

  /*
   * Trap-seeking root bonus: weighted fraction of the player's replies (after
   * our candidate move) that would let us capture. Against a player with a
   * high observed exposureRate, lines with many losing replies pay off.
   * When the opening book has recorded THIS player's reply frequencies for
   * the resulting position, each reply is weighted by how often the player
   * actually chose it (add-one smoothed), so likely replies count more;
   * with no book data every reply weighs 1 and the fraction is uniform.
   */
  function rootTrapBonus(state, move, trapWeight, book) {
    const after = Engine.applyMove(state, move);
    const replies = Engine.legalMoves(after);
    if (replies.length === 0) return 0;
    let seen = null;
    if (book && after.ply < TUNING.bookPlies) {
      const entry = book[Engine.hash(after)];
      if (entry && entry.playerReplies) seen = entry.playerReplies;
    }
    let exposing = 0;
    let total = 0;
    for (let i = 0; i < replies.length; i++) {
      const w = 1 + (seen ? (seen[moveKey(replies[i])] || 0) : 0);
      total += w;
      const s2 = Engine.applyMove(after, replies[i]);
      const ms2 = Engine.legalMoves(s2);
      if (ms2.length > 0 && ms2[0].captures.length > 0) exposing += w;
    }
    return Math.round(trapWeight * TUNING.trapRootScale * (exposing / total));
  }

  function pct(x) { return Math.round(x * 100) + '%'; }

  // ------------------------------------------------------------------
  // KnowledgeBase — the K in MAPE-K.
  // ------------------------------------------------------------------

  class MemoryStorage {
    constructor() { this._map = Object.create(null); }
    getItem(key) { return (key in this._map) ? this._map[key] : null; }
    setItem(key, value) { this._map[key] = String(value); }
    removeItem(key) { delete this._map[key]; }
  }

  function resolveStorage(mode) {
    if (mode === 'memory') return new MemoryStorage();
    if (mode && typeof mode === 'object' &&
        typeof mode.getItem === 'function' && typeof mode.setItem === 'function') {
      return mode;
    }
    // 'auto': localStorage when available and writable, else in-memory shim.
    try {
      const ls = (typeof localStorage !== 'undefined') ? localStorage : (global.localStorage || null);
      if (ls) {
        const probe = '__checkers_kb_probe__';
        ls.setItem(probe, '1');
        ls.removeItem(probe);
        return ls;
      }
    } catch (e) { /* blocked or unavailable */ }
    return new MemoryStorage();
  }

  function defaultKnowledge() {
    return {
      schema: SCHEMA_VERSION,
      gamesPlayed: 0,
      record: { w: 0, l: 0, d: 0 }, // from the AI's perspective
      profile: { moves: 0, exposed: 0, edge: 0, advance: 0, kings: 0, blunders: 0, evaluated: 0 },
      book: {} // CheckersEngine.hash -> { outcomes, playerReplies, aiMoves }
    };
  }

  function defaultSession() {
    return {
      recentEvents: [],
      aiSide: Engine.BLACK,
      game: { openings: [] },
      analysis: null,
      strategy: null,
      rationale: [],
      currentState: null,
      execute: { lastEval: 0, depth: 0, nodes: 0 },
      lastResult: null
    };
  }

  class KnowledgeBase {
    constructor(opts) {
      const o = opts || {};
      this.storageKey = o.storageKey || 'checkers-kb';
      this.storage = resolveStorage(o.storage === undefined ? 'auto' : o.storage);
      this.knowledge = this._load(); // persistent, schema-versioned
      this.session = defaultSession(); // volatile, per-process
    }

    // Corrupt-data-safe load: any malformed field falls back to defaults.
    _load() {
      const base = defaultKnowledge();
      let raw = null;
      try { raw = this.storage.getItem(this.storageKey); } catch (e) { return base; }
      if (!raw || typeof raw !== 'string') return base;
      let p = null;
      try { p = JSON.parse(raw); } catch (e) { return base; }
      if (!p || typeof p !== 'object' || Array.isArray(p) || p.schema !== SCHEMA_VERSION) return base;
      if (Number.isFinite(p.gamesPlayed) && p.gamesPlayed >= 0) base.gamesPlayed = p.gamesPlayed;
      if (p.record && typeof p.record === 'object') {
        ['w', 'l', 'd'].forEach(function (k) {
          if (Number.isFinite(p.record[k]) && p.record[k] >= 0) base.record[k] = p.record[k];
        });
      }
      if (p.profile && typeof p.profile === 'object') {
        Object.keys(base.profile).forEach(function (k) {
          if (Number.isFinite(p.profile[k]) && p.profile[k] >= 0) base.profile[k] = p.profile[k];
        });
      }
      if (p.book && typeof p.book === 'object' && !Array.isArray(p.book)) {
        Object.keys(p.book).forEach(function (h) {
          const e = p.book[h];
          if (!e || typeof e !== 'object') return;
          const entry = { outcomes: { w: 0, l: 0, d: 0 }, playerReplies: {}, aiMoves: {} };
          if (e.outcomes && typeof e.outcomes === 'object') {
            ['w', 'l', 'd'].forEach(function (k) {
              if (Number.isFinite(e.outcomes[k]) && e.outcomes[k] >= 0) entry.outcomes[k] = e.outcomes[k];
            });
          }
          if (e.playerReplies && typeof e.playerReplies === 'object') {
            Object.keys(e.playerReplies).forEach(function (mk) {
              if (Number.isFinite(e.playerReplies[mk]) && e.playerReplies[mk] >= 0) {
                entry.playerReplies[mk] = e.playerReplies[mk];
              }
            });
          }
          if (e.aiMoves && typeof e.aiMoves === 'object') {
            Object.keys(e.aiMoves).forEach(function (mk) {
              const s = e.aiMoves[mk];
              if (!s || typeof s !== 'object') return;
              const st = { w: 0, l: 0, d: 0 };
              ['w', 'l', 'd'].forEach(function (k) {
                if (Number.isFinite(s[k]) && s[k] >= 0) st[k] = s[k];
              });
              entry.aiMoves[mk] = st;
            });
          }
          base.book[h] = entry;
        });
      }
      return base;
    }

    save() {
      try { this.storage.setItem(this.storageKey, JSON.stringify(this.knowledge)); }
      catch (e) { /* quota/unavailable — knowledge stays in memory */ }
    }

    reset() {
      this.knowledge = defaultKnowledge();
      this.session = defaultSession();
      this.save();
    }

    read(key) { return this.session[key]; }
    write(key, value) { this.session[key] = value; }

    pushEvent(text) {
      this.session.recentEvents.unshift(text); // newest first
      if (this.session.recentEvents.length > TUNING.recentCap) {
        this.session.recentEvents.length = TUNING.recentCap;
      }
    }
  }

  // ------------------------------------------------------------------
  // Monitor — sensors. Writes raw observations into the KnowledgeBase.
  // ------------------------------------------------------------------

  class Monitor {
    constructor(kb) { this.kb = kb; }

    // Sense the position the manager was asked to act on.
    observeState(state) {
      this.kb.write('currentState', Engine.clone(state));
    }

    handle(event) {
      if (!event || typeof event.type !== 'string') return;
      switch (event.type) {
        case 'gameStart': {
          this.kb.write('game', { openings: [] });
          // A new game invalidates the previously sensed position; without
          // this, plan()/getInsights() before the first chooseMove would
          // build the opening-book plan for the OLD game's last position.
          this.kb.write('currentState', null);
          this.kb.pushEvent('Game started');
          break;
        }
        case 'playerMove': this._playerMove(event); break;
        case 'aiMove': this._aiMove(event); break;
        case 'gameEnd': this._gameEnd(event); break;
        default: this.kb.pushEvent('Ignored unknown event: ' + event.type);
      }
    }

    _playerMove(event) {
      const before = event.before;
      const move = event.move;
      if (!before || !move || !move.from || !move.path || !move.path.length) return;
      const legal = (Array.isArray(event.legalMoves) && event.legalMoves.length)
        ? event.legalMoves
        : Engine.legalMoves(before);
      const playerSide = before.turn;
      this.kb.write('aiSide', opposite(playerSide));

      const piece = before.board[move.from[0]][move.from[1]];
      const last = move.path[move.path.length - 1];
      const after = Engine.applyMove(before, move);
      const aiMoves = Engine.legalMoves(after);
      const exposed = aiMoves.length > 0 && aiMoves[0].captures.length > 0; // AI can capture next
      const edge = last[1] === 0 || last[1] === 7;
      const isKing = !!(piece && piece.k);
      const advance = !!piece && !piece.k &&
        (playerSide === Engine.RED ? last[0] < move.from[0] : last[0] > move.from[0]);
      const quality = assessBlunder(before, move, legal);

      const prof = this.kb.knowledge.profile;
      prof.moves++;
      if (exposed) prof.exposed++;
      if (edge) prof.edge++;
      if (advance) prof.advance++;
      if (isKing) prof.kings++;
      if (quality.evaluated) prof.evaluated++;
      if (quality.blunder) prof.blunders++;

      if (before.ply < TUNING.bookPlies) {
        this.kb.read('game').openings.push({ h: Engine.hash(before), key: moveKey(move), by: 'player' });
      }

      let txt = 'Player: ' + moveKey(move);
      if (move.captures.length) txt += ' (x' + move.captures.length + ')';
      if (exposed) txt += ' [exposes a piece]';
      if (quality.blunder) txt += ' [blunder]';
      this.kb.pushEvent(txt);
    }

    _aiMove(event) {
      const before = event.before;
      const move = event.move;
      if (!before || !move || !move.from || !move.path) return;
      this.kb.write('aiSide', before.turn);
      if (before.ply < TUNING.bookPlies) {
        this.kb.read('game').openings.push({ h: Engine.hash(before), key: moveKey(move), by: 'ai' });
      }
      this.kb.pushEvent('AI: ' + moveKey(move) + (move.captures.length ? ' (x' + move.captures.length + ')' : ''));
      this.kb.save(); // persist after each AI move
    }

    _gameEnd(event) {
      const w = event.winner;
      const aiSide = this.kb.read('aiSide');
      const res = (w === 'draw') ? 'd' : (w === aiSide ? 'w' : 'l');
      const k = this.kb.knowledge;
      k.gamesPlayed++;
      k.record[res]++;

      // Fold this game's opening line into the book with its outcome.
      const openings = (this.kb.read('game') || { openings: [] }).openings || [];
      for (let i = 0; i < openings.length; i++) {
        const o = openings[i];
        let entry = k.book[o.h];
        if (!entry) {
          if (Object.keys(k.book).length >= TUNING.bookCap) continue;
          entry = k.book[o.h] = { outcomes: { w: 0, l: 0, d: 0 }, playerReplies: {}, aiMoves: {} };
        }
        entry.outcomes[res]++;
        if (o.by === 'player') {
          entry.playerReplies[o.key] = (entry.playerReplies[o.key] || 0) + 1;
        } else {
          const s = entry.aiMoves[o.key] || (entry.aiMoves[o.key] = { w: 0, l: 0, d: 0 });
          s[res]++;
        }
      }
      this.kb.write('game', { openings: [] });
      this.kb.pushEvent('Game over: ' + (w === 'draw' ? 'draw' : w + ' wins') +
        ' (AI result: ' + res + ')');
      this.kb.save(); // persist after every gameEnd
    }
  }

  // ------------------------------------------------------------------
  // Analyzer — turns raw observations into a profile with confidence.
  // ------------------------------------------------------------------

  class Analyzer {
    constructor(kb) { this.kb = kb; }

    analyze() {
      const p = this.kb.knowledge.profile;
      const n = p.moves;
      const div = function (a, b) { return b > 0 ? a / b : 0; };
      const profile = {
        exposureRate: div(p.exposed, n),
        edgePreference: div(p.edge, n),
        advanceRate: div(p.advance, n),
        kingUsage: div(p.kings, n),
        blunderRate: div(p.blunders, p.evaluated),
        moves: n,
        evaluated: p.evaluated
      };
      const confidence = Math.min(1, n / TUNING.confidenceMoves);
      let style = 'unknown (still learning)';
      if (n >= TUNING.minMoves) {
        const traits = [];
        if (profile.exposureRate >= TUNING.trapExposure) traits.push('exposure-prone');
        if (profile.edgePreference >= TUNING.centerEdge) traits.push('edge-hugging');
        if (p.evaluated >= TUNING.minEvaluated && profile.blunderRate <= TUNING.skilledBlunder) {
          traits.push('precise');
        } else if (profile.blunderRate >= 0.3) {
          traits.push('blunder-prone');
        }
        if (profile.advanceRate >= 0.7) traits.push('fast-advancing');
        if (profile.kingUsage >= 0.4) traits.push('king-reliant');
        style = traits.length ? traits.join(', ') : 'balanced';
      }
      this.kb.write('analysis', { profile: profile, style: style, confidence: confidence });
    }
  }

  // ------------------------------------------------------------------
  // Planner — converts the analysis into an executable strategy.
  // Every adaptation measurably changes the Executor (weights, biases, depth).
  // ------------------------------------------------------------------

  class Planner {
    constructor(kb) { this.kb = kb; }

    plan() {
      const a = this.kb.read('analysis');
      const k = this.kb.knowledge;
      const strategy = {
        weights: Object.assign({}, DEFAULT_WEIGHTS),
        trapSeeking: false,   // derived below from weights.trap (never diverges)
        maxDepth: TUNING.baseDepth,
        timeCapMs: TUNING.timeCapMs,
        useOpeningBook: false, // derived below: true iff a book bias was applied
        rootBias: {},   // moveKey -> centipawn bias for the current position
        adaptations: []
      };
      const rationale = [];
      const prof = a && a.profile;

      if (!prof || prof.moves < TUNING.minMoves) {
        rationale.push('Insufficient observations (' + (prof ? prof.moves : 0) +
          ' player moves) - full-strength baseline strategy.');
      } else {
        if (prof.exposureRate >= TUNING.trapExposure) {
          strategy.weights.trap = TUNING.trapWeight;
          strategy.adaptations.push('trap-seeking');
          rationale.push('Player exposes pieces on ' + pct(prof.exposureRate) +
            ' of moves -> trap-seeking bonus enabled (weight ' + TUNING.trapWeight + ').');
        }
        if (prof.edgePreference >= TUNING.centerEdge) {
          strategy.weights.center = TUNING.centerBoost;
          strategy.adaptations.push('center-control');
          rationale.push('Player hugs the edges on ' + pct(prof.edgePreference) +
            ' of moves -> center-control weight raised ' + DEFAULT_WEIGHTS.center +
            ' -> ' + TUNING.centerBoost + '.');
        }
        if (prof.evaluated >= TUNING.minEvaluated && prof.blunderRate <= TUNING.skilledBlunder) {
          strategy.maxDepth = TUNING.deepDepth;
          strategy.adaptations.push('deeper-search');
          rationale.push('Low blunder rate (' + pct(prof.blunderRate) +
            ') -> search depth raised ' + TUNING.baseDepth + ' -> ' + TUNING.deepDepth +
            ' toward the time cap.');
        }
      }

      // Opening book: prefer lines that historically beat THIS player,
      // avoid lines the AI previously lost.
      const st = this.kb.read('currentState');
      let bookUsed = false;
      if (st && st.ply < TUNING.bookPlies) {
        const entry = k.book[Engine.hash(st)];
        const perMove = {}; // moveKey -> true when direct per-move stats exist
        if (entry && entry.aiMoves) {
          const keys = Object.keys(entry.aiMoves);
          for (let i = 0; i < keys.length; i++) {
            const s = entry.aiMoves[keys[i]];
            const games = s.w + s.l + s.d;
            if (!games) continue;
            perMove[keys[i]] = true;
            const net = (s.w - s.l) / games;
            const bias = Math.round(TUNING.openingWeight * net * Math.min(1, games / 3));
            if (bias !== 0) {
              strategy.rootBias[keys[i]] = bias;
              bookUsed = true;
              rationale.push('Opening book: line ' + keys[i] + ' scored ' +
                s.w + '-' + s.l + '-' + s.d + ' vs this player -> bias ' +
                (bias > 0 ? '+' : '') + bias + '.');
            }
          }
        }
        // Recorded position outcomes cover transpositions: a candidate move
        // with no direct per-move record can still lead to a position this
        // player was seen in. Bias by that position's outcomes at half
        // weight (attribution to the single move is weaker).
        const legal = Engine.legalMoves(st);
        for (let i = 0; i < legal.length; i++) {
          const mk = moveKey(legal[i]);
          if (perMove[mk]) continue;
          const succ = k.book[Engine.hash(Engine.applyMove(st, legal[i]))];
          if (!succ || !succ.outcomes) continue;
          const games = succ.outcomes.w + succ.outcomes.l + succ.outcomes.d;
          if (!games) continue;
          const net = (succ.outcomes.w - succ.outcomes.l) / games;
          const bias = Math.round((TUNING.openingWeight / 2) * net * Math.min(1, games / 3));
          if (bias !== 0) {
            strategy.rootBias[mk] = bias;
            bookUsed = true;
            rationale.push('Opening book: position after ' + mk + ' scored ' +
              succ.outcomes.w + '-' + succ.outcomes.l + '-' + succ.outcomes.d +
              ' vs this player -> bias ' + (bias > 0 ? '+' : '') + bias + '.');
          }
        }
        if (bookUsed) strategy.adaptations.push('opening-book');
      }

      // Display flags derived FROM the mechanisms that actually fire, so the
      // insights panel can never diverge from Executor behavior.
      strategy.trapSeeking = strategy.weights.trap > 0;
      strategy.useOpeningBook = bookUsed;

      rationale.push('Search: depth cap ' + strategy.maxDepth + ', time cap ' +
        strategy.timeCapMs + 'ms - always playing to win.');
      this.kb.write('strategy', strategy);
      this.kb.write('rationale', rationale);
    }
  }

  // ------------------------------------------------------------------
  // Executor — effects the planned strategy on the current position.
  // ------------------------------------------------------------------

  class Executor {
    constructor(kb) { this.kb = kb; }

    execute() {
      const state = this.kb.read('currentState');
      const strategy = this.kb.read('strategy');
      if (!state || !strategy) {
        this.kb.write('lastResult', null);
        return;
      }
      const moves = Engine.legalMoves(state);
      const biases = {};
      if (moves.length > 1) {
        const book = this.kb.knowledge.book;
        for (let i = 0; i < moves.length; i++) {
          const k = moveKey(moves[i]);
          let b = strategy.rootBias[k] || 0;
          if (strategy.weights.trap > 0) {
            b += rootTrapBonus(state, moves[i], strategy.weights.trap, book);
          }
          // Enforce the searchRoot invariant where the biases are summed:
          // the COMBINED bias stays below a man's value (100), so steering
          // between near-equal lines can never buy a lost piece.
          if (b > TUNING.openingWeight) b = TUNING.openingWeight;
          else if (b < -TUNING.openingWeight) b = -TUNING.openingWeight;
          if (b) biases[k] = b;
        }
      }
      const result = searchRoot(state, strategy, biases, moves);
      this.kb.write('lastResult', result);
      this.kb.write('execute', {
        lastEval: result.value,
        depth: result.depth,
        nodes: result.nodes
      });
    }
  }

  // ------------------------------------------------------------------
  // MapeKAgent — the autonomic manager. Orchestrates the loop; passes no
  // data between phases (everything flows through the KnowledgeBase).
  // ------------------------------------------------------------------

  class MapeKAgent {
    constructor(opts) {
      const o = opts || {};
      this._kb = new KnowledgeBase({
        storage: o.storage === undefined ? 'auto' : o.storage,
        storageKey: o.storageKey || 'checkers-kb'
      });
      this._monitor = new Monitor(this._kb);
      this._analyzer = new Analyzer(this._kb);
      this._planner = new Planner(this._kb);
      this._executor = new Executor(this._kb);
    }

    monitor(event) {
      this._monitor.handle(event);
    }

    chooseMove(state) {
      if (!state || !state.board) return null;
      this._monitor.observeState(state); // M: sense the position
      this._analyzer.analyze();          // A: refresh player profile
      this._planner.plan();              // P: refresh strategy
      this._executor.execute();          // E: search under that strategy
      const result = this._kb.read('lastResult');
      this._kb.save();                   // persist after each AI move
      return result ? result.move : null;
    }

    getInsights() {
      this._analyzer.analyze();
      this._planner.plan();
      const kb = this._kb;
      const a = kb.read('analysis');
      const strategy = kb.read('strategy');
      const ex = kb.read('execute');
      const k = kb.knowledge;
      const active = strategy.adaptations;
      let level;
      if (k.gamesPlayed === 0 && a.profile.moves === 0) level = 'baseline (no data yet)';
      else if (active.length === 0) level = 'observing';
      else if (active.length <= 2) level = 'adapting (' + active.join(', ') + ')';
      else level = 'exploiting (' + active.join(', ') + ')';
      return {
        monitor: { recentEvents: kb.session.recentEvents.slice() },
        analyze: {
          profile: Object.assign({}, a.profile),
          style: a.style,
          confidence: a.confidence
        },
        plan: {
          strategy: JSON.parse(JSON.stringify(strategy)),
          rationale: kb.read('rationale').slice()
        },
        execute: { lastEval: ex.lastEval, depth: ex.depth, nodes: ex.nodes },
        knowledge: {
          gamesPlayed: k.gamesPlayed,
          record: Object.assign({}, k.record),
          adaptationLevel: level
        }
      };
    }

    resetKnowledge() {
      this._kb.reset();
    }
  }

  const CheckersAI = {
    MapeKAgent: MapeKAgent,
    KnowledgeBase: KnowledgeBase,
    Monitor: Monitor,
    Analyzer: Analyzer,
    Planner: Planner,
    Executor: Executor,
    MemoryStorage: MemoryStorage,
    moveKey: moveKey,
    DEFAULT_WEIGHTS: DEFAULT_WEIGHTS,
    TUNING: TUNING
  };

  global.CheckersAI = CheckersAI;
  if (typeof module !== 'undefined' && module.exports) module.exports = CheckersAI;
})(typeof globalThis !== 'undefined' ? globalThis : this);
