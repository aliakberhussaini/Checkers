# Checkers vs. MAPE-K Agent — Build Contract (BINDING)

Every builder, reviewer, and fixer must follow this spec exactly. It is the coupling
contract that lets modules built in parallel integrate cleanly. Deviations are bugs.

## Overview

A complete, offline, zero-dependency browser checkers game:
- **Human plays Red** (bottom), **AI plays Black** (top). Red moves first.
- The AI is an autonomic agent built on **IBM's classic MAPE-K loop**
  (Monitor → Analyze → Plan → Execute over a shared Knowledge base; Kephart & Chess 2003).
- The agent **learns the specific player across games** (persisted in localStorage) and
  adapts its strategy to beat them. It always plays to win; adaptation means *exploiting
  this player better*, never handicapping itself.

## File layout (ownership is exclusive per builder)

```
checkers/
  SPEC.md               (this file — read-only)
  engine.js             (engine builder)
  tests/engine.test.js  (engine builder)
  ai.js                 (AI builder)
  tests/ai.test.js      (AI builder)
  tests/selfplay.js     (AI builder)
  index.html            (frontend builder)
  styles.css            (frontend builder)
  ui.js                 (frontend builder)
  README.md             (integrator)
```

## Code conventions

- Vanilla ES2020. **No frameworks, no npm deps, no build step, no external URLs**
  (no CDN scripts, fonts, or images — the game must work opened via `file://`).
- No ES modules. Each file attaches one global (`CheckersEngine`, `CheckersAI`) and adds
  a CommonJS guard so node tests can `require()` it:
  `if (typeof module !== 'undefined' && module.exports) module.exports = CheckersEngine;`
- Tests are plain node scripts: print `PASS`/`FAIL` per case, `process.exit(1)` on any failure.

## Game rules (American checkers / English draughts)

- 8×8 board. Play happens only on dark squares where `(row + col) % 2 === 1`. Row 0 is top.
- Black (`'B'`) starts on dark squares of rows 0–2; Red (`'R'`) on rows 5–7. 12 pieces each.
- Red moves toward decreasing row; Black toward increasing row.
- Men move diagonally forward one square to an empty square.
- **Captures are mandatory**: if any capture exists for the side to move, only capture
  moves are legal. A capture jumps an adjacent enemy piece to the empty square beyond it.
- **Multi-jumps are mandatory**: after a jump, if the same piece can jump again it must
  continue; the whole sequence is a single move. When several sequences exist the player
  may choose any one (maximal capture is NOT required — American rules).
- **Promotion**: a man reaching the far row (Red → row 0, Black → row 7) becomes a king.
  If promotion happens mid-jump, the move **ends immediately** (no continuing as king).
- **Kings** move and capture diagonally in all 4 directions, one square (no flying kings).
- **Win**: the side to move has no legal moves (all pieces captured or blocked) → the
  *other* side wins.
- **Draw**: 80 consecutive half-moves with no capture and no promotion.

## State shape

```js
state = {
  board: Piece[8][8],   // Piece = null | { p: 'R'|'B', k: boolean }
  turn:  'R' | 'B',
  quiet: number,        // half-moves since last capture or promotion
  ply:   number         // total half-moves played
}
```

`applyMove` is pure: deep-copies, never mutates its input.

## Move shape

```js
move = {
  from:     [r, c],
  path:     [[r1, c1], ...],   // squares visited after `from`; length >= 1
  captures: [[r, c], ...]      // squares of captured pieces; [] for a simple move
}
```

`legalMoves(state)` returns **fully expanded** jump sequences (never partial jumps).

## Engine API — global `CheckersEngine` (+ CommonJS export)

- `RED` = `'R'`, `BLACK` = `'B'` (constants)
- `initialState() → state`
- `legalMoves(state) → Move[]` — for `state.turn`, forced-capture rule enforced
- `applyMove(state, move) → state'` — pure; applies captures/promotion, switches turn,
  updates `quiet` (reset to 0 on capture or promotion, else +1) and `ply`
- `winner(state) → 'R' | 'B' | 'draw' | null` — evaluated for the side to move;
  `'draw'` when `quiet >= 80`
- `hash(state) → string` — stable compact key: the 32 dark squares in row-major order as
  chars `.` (empty) `r` `R` (red man/king) `b` `B` (black man/king), then `:` + turn
- `clone(state) → state`

## AI API — global `CheckersAI` (+ CommonJS export)

`class MapeKAgent`:

- `constructor({ storage = 'auto', storageKey = 'checkers-kb' } = {})`
  — `'auto'`: use `localStorage` when available, else an in-memory shim (node-safe).
- Internally structured as **four explicit components + knowledge base**, each its own
  class: `Monitor`, `Analyzer`, `Planner`, `Executor`, `KnowledgeBase`. All four phases
  read/write ONLY through the KnowledgeBase (that is what makes it MAPE-K and not just
  a minimax bot with globals).
- Public methods:
  - `monitor(event)` — event types:
    - `{ type: 'gameStart' }`
    - `{ type: 'playerMove', before, move, legalMoves }` (state before the move)
    - `{ type: 'aiMove', before, move }`
    - `{ type: 'gameEnd', winner }`  (`'R' | 'B' | 'draw'`)
  - `chooseMove(state) → Move` — runs Analyze → Plan → Execute over Knowledge; MUST
    return a member of `CheckersEngine.legalMoves(state)`.
  - `getInsights()` — live data for the UI panel:
    ```js
    {
      monitor:   { recentEvents: string[] },          // human-readable, newest first
      analyze:   { profile: {...}, style: string, confidence: number },
      plan:      { strategy: {...}, rationale: string[] },
      execute:   { lastEval: number, depth: number, nodes: number },
      knowledge: { gamesPlayed, record: {w, l, d}, adaptationLevel: string }
    }
    ```
  - `resetKnowledge()`
- Knowledge is persisted (JSON, schema-versioned, corrupt-data-safe) after every
  `gameEnd` and after each AI move.

### Learning requirements (must be real and covered by tests)

1. **Blunder detection** (Monitor): a player move is a blunder when a ≥4-ply search says
   it worsens the player's evaluation by at least a man's value vs. their best alternative.
2. **Player profile** (Analyze), aggregated across all games with confidence based on
   sample size: `exposureRate` (moves that let the AI capture next turn), `edgePreference`
   (fraction of moves to columns 0/7), `advanceRate`, `kingUsage`, `blunderRate`, plus an
   opening book: `hash(state) → { playerReplies: counts, outcomes }` for the first ~8 plies.
3. **Plan adaptations** (each must demonstrably change Executor behavior):
   - high `exposureRate` → enable **trap-seeking bonus** (prefer lines where the player's
     likely/forced replies lose material);
   - high `edgePreference` → raise **center-control weight**;
   - opening book: prefer opening lines with the best historical outcome vs. THIS player,
     avoid lines the AI previously lost;
   - low `blunderRate` (skilled player) → increase search depth toward the time cap.
4. **Executor**: iterative-deepening alpha-beta with capture-first move ordering and
   quiescence on captures, wall-clock cap ≈ 400ms. Eval = material (man 100, king 160)
   + positional terms (advance, center control, back-row guard, mobility, trap bonus)
   weighted by the Planner's current strategy.

## UI contract

- `index.html` loads `styles.css` then scripts in order: `engine.js`, `ai.js`, `ui.js`.
- Human = Red. Clicking a red piece highlights its legal destinations (dots along jump
  paths); ambiguous multi-jump sequences are resolvable by clicking intermediate squares;
  the executed move animates step-by-step along the path.
- Input is locked while the AI is thinking; AI move is computed off the click handler
  (setTimeout) with a visible "thinking" state.
- **MAPE-K live panel**: five labelled sections (Monitor / Analyze / Plan / Execute /
  Knowledge) refreshed from `agent.getInsights()` after every AI move. Null-safe before
  the first AI move.
- Scoreboard (W/L/D from knowledge), **New Game** and **Reset AI Memory** (with confirm)
  buttons, status bar (whose turn, "capture is mandatory" notice, win/draw banner).
- Because knowledge is in localStorage, the agent gets stronger against the same player
  across sessions.

### Design brief — "refreshing"

Light aqua→mint gradient background; frosted-glass side panels (translucency + blur);
board framed in deep teal; dark squares ~#2f6f6a, light squares ~#f6f1e7; Red pieces
coral gradient, Black pieces charcoal with inner highlight; inline SVG gold crown on
kings; 200ms ease piece movement, capture fade/pop, promotion glow, subtle win shine;
legal-move dots; hover affordances; responsive (panel stacks under the board ≤ 900px,
playable at 375px); system font stack; zero external assets.

NOTE: the shipped v1.0 build supersedes this brief's visuals with a "Neon Grid" dark
theme imported from a user-supplied Claude Design prototype; the UI contract's
functional requirements above (five-section live panel, W/L/D scoreboard, mandatory-
capture notice, etc.) still hold and are met by the current `index.html`/`styles.css`/
`ui.js`. This file was not retroactively rewritten for that visual pivot — treat the
running app as the visual source of truth, this section as the functional one.

## Multiplayer (v1.1 addendum)

Human-vs-human play over a 4-digit code, added alongside (not replacing) solo vs. the
MAPE-K agent. Engine/AI/SPEC rules above are unchanged and fully reused; multiplayer
adds one new module (`net.js`, global `NetCheckers`) and extends `ui.js`.

- **Never touches agent knowledge.** No `MapeKAgent` instance is involved in a
  multiplayer match; none of `monitor()`/`chooseMove()`/`getInsights()` are called for
  it. The solo agent's persistent profile, opening book, and W/L/D record must be
  byte-identical before and after any number of multiplayer games.
- **Side assignment**: the code generator (host) plays Red and moves first; the joiner
  plays Black. The board is NOT flipped for the joiner — both peers share one fixed
  (row, col) coordinate system (row 0 top). Piece color in the UI is relative ("mine"
  = p1/cyan, "theirs" = p2/violet) via `mySide`, not literally Red/Black.
- **Transport**: WebRTC data channel (native browser API, ordered + reliable) carries
  all gameplay traffic directly peer-to-peer. PeerJS's public broker is used only for
  the initial handshake (turning a 4-digit code into a connection); once `onOpen`
  fires, the broker is no longer in the loop. The PeerJS client is vendored at
  `vendor/peerjs.min.js` (pulled from the npm registry) — the one sanctioned
  exception to this project's zero-external-dependency rule, and only loaded/used
  when a player opens Multiplayer.
- **Wire protocol** (JSON messages over the data channel):
  - `{type:'hello', name}` — sent by both sides immediately on channel open; the
    receiving side does not consider the match "connected" (does not fire `onOpen`)
    until its own hello has been sent AND the peer's hello has been received.
  - `{type:'move', move}` — `move` is exactly `{from, path, captures}` (SPEC Move
    shape). The receiver MUST re-validate via `NetCheckers.isLegalWireMove(move,
    state, CheckersEngine)` before ever applying it — the wire is never trusted, and
    the receiver applies the engine's own matching move object, not the wire copy.
  - `{type:'rematch'}` — either side may send; receipt resets both sides to a fresh
    `initialState()` without renegotiating a code.
  - `{type:'leave'}` — sent when a player intentionally leaves; the peer surfaces
    "Opponent disconnected" rather than a generic connection-close.
- **`NetCheckers` API** (`net.js`, CommonJS-exported like `engine.js`/`ai.js`):
  `makeCode()`, `idFor(code)`, `isValidCode(code)`, `sanitizeName(name)`,
  `isLegalWireMove(move, state, Engine)` (pure, unit-tested in `tests/net.test.js`
  without a live network), and `Session` (thin PeerJS wrapper: `host(code, name)`,
  `join(code, name)`, `send(msg)`, `close()`; not unit-tested — covered by manual
  two-browser verification instead, since it needs a live browser + network).
- **Known limitation**: a 4-digit code is a shared namespace on PeerJS's public
  broker (10,000 values) — not collision-proof against unrelated PeerJS users
  worldwide, only unlikely in practice. No reconnect-after-drop.
