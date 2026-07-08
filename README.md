# Neon Checkers — vs. a MAPE-K Agent, or vs. a Friend

A complete browser checkers game (American checkers / English draughts) in the
"Neon Grid" theme. Play solo against an autonomic agent built on IBM's classic
**MAPE-K loop** (Kephart & Chess, 2003) that learns *you* across games and
adapts its strategy to beat you — always at full strength, never handicapped —
or play a friend head-to-head over a 4-digit code (see **Multiplayer** below).

Solo play (`engine.js` + `ai.js`) is 100% offline and has zero external
dependencies. Multiplayer additionally needs a network connection and the
vendored [PeerJS](https://peerjs.com) library (`vendor/peerjs.min.js`, fetched
once from the npm registry and committed into this repo) — see the
**Multiplayer** section for why that's the one exception to "zero dependencies".
Optional, opt-in usage analytics (`analytics.js`) is the one *other* exception
— see **Analytics, NPS survey & Share** below; it no-ops entirely until a
PostHog project key is configured, so the "zero dependencies" claim for solo
play holds by default.

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
node tests/net.test.js          # multiplayer: code/name validation, wire-move security check
```

Each test is a plain Node script that prints `PASS`/`FAIL` per case and exits
non-zero on any failure.

## Architecture map

```
index.html            page shell; loads analytics.js -> engine.js -> ai.js -> vendor/peerjs.min.js -> net.js -> ui.js
styles.css            "Neon Grid" theme, frosted-glass panels, animations
analytics.js          global Analytics — thin PostHog wrapper; no-ops until configured
engine.js             global CheckersEngine — pure rules engine, no AI, no DOM
ai.js                 global CheckersAI — the MAPE-K agent (five explicit classes)
net.js                global NetCheckers — multiplayer code/name validation + PeerJS wrapper
vendor/peerjs.min.js  vendored third-party library (WebRTC signaling), not authored here
ui.js                 board rendering, input, animation, MAPE-K live panel, multiplayer flow,
                      NPS survey, and the Share button
tests/
  engine.test.js      engine unit tests
  ai.test.js          agent learning/adaptation tests
  selfplay.js         agent-vs-agent soak test
  integration.test.js full-system test driving the exact UI event sequence
  net.test.js         multiplayer pure-logic tests (code/name validation, wire-move security)
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

## Multiplayer

Click **Multiplayer** on the title screen instead of **Play vs Agent**. Enter
a display name, then either:

- **Generate a code** — get a 4-digit code, share it with a friend any way you
  like (text, chat, voice). Your browser waits for them to connect.
- **I have a code** — enter the 4-digit code someone shared with you.

Once connected, the code's generator plays Red (moves first) and the joiner
plays Black — but on-screen, each player's own pieces always render in "your"
color (cyan) and the opponent's in "theirs" (violet), the same way chess
sites keep your own pieces visually consistent regardless of which side
you're assigned. **The board is not flipped** — both players see the same
fixed orientation (row 1 at the bottom, same file/rank labels).

A multiplayer match never touches the MAPE-K agent's knowledge — there is no
agent in this mode, so playing a friend never mixes into (or is affected by)
what the agent has learned about you from solo play. **Undo is disabled** in
multiplayer (it would desync the two browsers' replicated game state); Hint
still works as a personal aid. The turn timer, capture rules, and animations
are identical to solo play.

**Why this needs the network (unlike solo play):** two browsers that don't
know each other's address inherently need *some* rendezvous point to connect
— the actual moves then travel directly peer-to-peer over a native WebRTC
data channel (no library needed for that part). We use [PeerJS](https://peerjs.com)'s
free public broker purely to turn the 4-digit code into that first
connection; once connected, the broker is no longer involved. The PeerJS
client library is vendored into this repo (`vendor/peerjs.min.js`, pulled
from the npm registry, not a CDN) rather than authored from scratch — WebRTC
signaling is a solved problem and reimplementing it wasn't warranted here.

Every incoming move is re-validated against the real rules engine
(`Net.isLegalWireMove`, see `net.js` and `tests/net.test.js`) before it's
ever applied — a malformed or fabricated move from a hostile or buggy peer is
silently dropped, never trusted.

**Known limitations:** a 4-digit code is a shared namespace of only 10,000
values on PeerJS's public broker — collisions with unrelated PeerJS users
elsewhere are unlikely but not impossible for a casual feature like this.
There's no reconnect-after-drop; if a peer disconnects mid-game the other
side sees "Opponent disconnected" and the match ends.

## Analytics, NPS survey & Share

**Analytics (`analytics.js`)** is a thin wrapper around
[PostHog](https://posthog.com) (free tier: 1M events/month). Until a project
key is configured it does nothing but log each event to the console — the
game behaves identically either way, and analytics can never throw an error
that breaks play (every call is wrapped in `try`/`catch`).

To enable it: create a free project at posthog.com, copy its **Project API
key** from Project Settings, and paste it into the `POSTHOG_KEY` constant at
the top of `analytics.js` (set `POSTHOG_HOST` to `https://eu.i.posthog.com`
instead if your project is on PostHog's EU cloud). No build step or npm
install is involved — the SDK itself loads asynchronously from PostHog's own
CDN at runtime, the same `array.js` bundle their official install snippet
injects.

Events captured: `game_started`, `game_ended` (mode, result, moves, duration,
quit flag), `hint_used`, `undo_used`, `difficulty_changed`, `sound_toggled`,
`colorblind_toggled`, `reset_brain_clicked`, `game_paused` / `game_resumed`,
`multiplayer_modal_opened` / `_host_started` / `_join_attempted` / `_left`,
`share_clicked` / `_completed` / `_dismissed` / `_failed`, and
`nps_shown` / `_submitted` / `_dismissed`. Page views are captured
automatically by PostHog once configured. Nothing board-state- or
PII-related is ever sent — only interaction and outcome metadata.

**NPS survey**: after the 1st, 4th, and 9th completed game (win, loss, draw,
or quit — tracked in `localStorage['checkers-nps-state']`), the game-over
modal shows a standard 0–10 "how likely are you to recommend this to a
friend" scale under the result stats. Submitting is recorded as
`nps_submitted` with a derived `category` (`promoter` 9–10, `passive` 7–8,
`detractor` 0–6). "Not now" is tracked as `nps_dismissed`; after 2 dismissals
(or one submission) it stops asking.

**Share**: the topbar's share icon and the game-over modal's **Share**
button both call the same handler. On browsers with the Web Share API
(most mobile browsers, and increasingly desktop Chrome/Edge), it opens the
OS's native share sheet — Messages, WhatsApp, Mail, whatever the user has —
pre-filled with a short pitch and the page's own URL. Everywhere else it
copies the URL to the clipboard and shows a small toast ("Link copied —
paste it anywhere!"), with an `execCommand`-based fallback for older
browsers without the Clipboard API.

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
