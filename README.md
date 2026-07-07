# Checkers vs. MAPE-K Agent

A complete, offline, zero-dependency browser checkers game (American checkers /
English draughts). You play **Red**; the opponent playing **Black** is an
autonomic agent built on IBM's classic **MAPE-K loop** (Kephart & Chess, 2003)
that learns *you* across games and adapts its strategy to beat you — always at
full strength, never handicapped.

## How to run

No build step, no npm install, no network access needed.

**Option 1 — open directly:**

Double-click `index.html` (or drag it into any modern browser). The game works
over `file://`.

**Option 2 — local web server:**

```sh
cd /path/to/Checkers
python3 -m http.server 8000
# then open http://localhost:8000
```

**Run the tests (Node v22+):**

```sh
node tests/engine.test.js       # rules engine: moves, jumps, promotion, win/draw
node tests/ai.test.js           # MAPE-K learning + adaptation requirements
node tests/selfplay.js          # two agents play 3 full games against each other
node tests/integration.test.js  # scripted greedy human vs one persistent agent, 5 games
```

Each test is a plain Node script that prints `PASS`/`FAIL` per case and exits
non-zero on any failure.

## Architecture map

```
index.html            page shell; loads styles.css then engine.js -> ai.js -> ui.js
styles.css            "refreshing" aqua/mint theme, frosted-glass panels, animations
engine.js             global CheckersEngine — pure rules engine, no AI, no DOM
ai.js                 global CheckersAI — the MAPE-K agent (five explicit classes)
ui.js                 board rendering, input, animation, MAPE-K live panel
tests/
  engine.test.js      engine unit tests
  ai.test.js          agent learning/adaptation tests
  selfplay.js         agent-vs-agent soak test
  integration.test.js full-system test driving the exact UI event sequence
```

- **engine.js** exposes `CheckersEngine`: `initialState()`, `legalMoves(state)`
  (forced captures and fully-expanded multi-jumps), pure `applyMove(state, move)`,
  `winner(state)` (`'R' | 'B' | 'draw' | null`), `hash(state)`, `clone(state)`.
- **ai.js** exposes `CheckersAI.MapeKAgent` with `monitor(event)`,
  `chooseMove(state)`, `getInsights()`, `resetKnowledge()`.
- **ui.js** wires them together: it reports every event to the agent, asks it
  for Black's moves (off the click handler, with a visible "thinking" state),
  and refreshes the live MAPE-K panel from `agent.getInsights()` after every
  AI move.

Both `engine.js` and `ai.js` attach one global each and include a CommonJS
guard, so the same files run unmodified in the browser and under `node`.

## The MAPE-K loop, concretely

MAPE-K is IBM's reference architecture for autonomic (self-managing) systems:
a **M**onitor–**A**nalyze–**P**lan–**E**xecute control loop closed over a shared
**K**nowledge base. Here, the "managed element" is the match against one
specific human player. Each part is its own class in `ai.js`, and the four
phases communicate *only* through the KnowledgeBase — no phase calls another
or passes data directly. That discipline is what makes it MAPE-K rather than
a minimax bot with globals.

- **Monitor (sensors)** — ingests game events from the UI: `gameStart`,
  `playerMove` (with the state *before* the move and the legal alternatives),
  `aiMove`, `gameEnd`. For every player move it extracts raw features: did the
  move expose a piece to capture, did it hug the board edge, did it advance,
  was it a king move — and runs a ≥4-ply **blunder check** (the move is a
  blunder if it is at least a man's value worse than the player's best
  alternative). It also records the opening line (first ~8 plies). Everything
  is written into the KnowledgeBase.

- **Analyze** — aggregates those raw counts into a player profile with
  sample-size confidence: `exposureRate`, `edgePreference`, `advanceRate`,
  `kingUsage`, `blunderRate`, plus a style label such as "exposure-prone,
  edge-hugging" or "precise".

- **Plan** — converts the profile and the opening-book history into a concrete
  strategy, with a human-readable rationale (shown in the panel). Every
  adaptation measurably changes the Executor:
  - high `exposureRate` → enables a **trap-seeking bonus** (prefer lines where
    your likely/forced replies lose material);
  - high `edgePreference` → raises the **center-control weight**;
  - opening book → biases toward opening lines that historically beat *you*
    and away from lines the AI previously lost;
  - low `blunderRate` (skilled player) → raises search depth toward the time cap.

- **Execute (effectors)** — plays the move: iterative-deepening negamax
  alpha-beta with capture-first move ordering, quiescence search on captures,
  and a ~400 ms wall-clock cap, using exactly the evaluation weights, root
  biases, and depth the Planner selected. Evaluation = material (man 100,
  king 160) + advance + center control + back-row guard + mobility + trap
  threats.

- **Knowledge (the K)** — the single shared store the other four read and
  write: the persistent player profile, win/loss/draw record, opening book,
  and the volatile per-session data (current strategy, rationale, recent
  events, last search stats). It is schema-versioned and corrupt-data-safe:
  malformed or wrong-version data is discarded field-by-field and the agent
  falls back to clean defaults instead of crashing.

The loop runs on every AI turn: `chooseMove(state)` = Monitor senses the
position → Analyzer refreshes the profile → Planner refreshes the strategy →
Executor searches under that strategy → the chosen move (and updated
knowledge) come back out. The right-hand panel in the UI shows all five parts
live.

## Where knowledge lives, and how to reset it

Knowledge is persisted as JSON in the browser's **`localStorage` under the key
`checkers-kb`**, saved after every AI move and every game end. That is why the
agent gets stronger against the same player across sessions — close the tab,
come back tomorrow, and it still knows your habits (per browser profile and
origin; Node tests use an in-memory shim instead).

To reset it:

- **In the game:** click **Reset AI Memory** (top right) and confirm. This
  calls `agent.resetKnowledge()`, wiping the profile, opening book, and the
  W/L/D record, both in memory and in storage.
- **Manually:** open the browser devtools console on the game page and run
  `localStorage.removeItem('checkers-kb')`, then reload.
