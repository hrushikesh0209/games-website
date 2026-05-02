# Games Website — Product & Technical Plan

---

## 1. Vision

A multiplayer browser-based games platform where two players join a private room, communicate via voice and text chat, and play turn-based games together. The platform is designed to be **extensible** — new games can be added without rearchitecting the core.

---

## 2. Architecture Overview

```
games_website/
├── client/                  # React frontend
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Home.tsx         # Game lobby / game picker
│   │   │   └── Room.tsx         # In-room game shell
│   │   ├── games/
│   │   │   └── HigherOrLower/   # Game-specific UI + logic
│   │   ├── components/
│   │   │   ├── Chat.tsx
│   │   │   ├── VoiceCall.tsx
│   │   │   └── CoinToss.tsx
│   │   └── lib/
│   │       └── socket.ts        # Socket.IO client wrapper
├── server/                  # Node.js + Express backend
│   ├── rooms/               # Room state management
│   ├── games/
│   │   └── higherOrLower.ts # Game logic engine
│   └── index.ts             # Express + Socket.IO server
└── PLAN.md
```

### Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Frontend | React + TypeScript | Component model fits per-game UI isolation |
| Styling | Tailwind CSS | Fast, no custom CSS conflicts between games |
| Realtime | Socket.IO | Rooms, namespaces, reliable WebSocket fallback |
| Voice/Audio | WebRTC (via PeerJS) | Peer-to-peer voice; no media server needed for 2-player |
| Backend | Node.js + Express | Non-blocking I/O fits real-time game events |
| State | In-memory (Map of rooms) | No persistence needed; rooms are ephemeral sessions |

---

## 3. Home Page

The home page acts as a **game catalog**. Each game is a card with:

- Game name + icon
- Short description
- "Create Room" button

Adding a new game = adding a new card + registering a new game handler on the server. No structural changes needed.

**Wireframe (text)**

```
┌──────────────────────────────────────────────────────┐
│  🎮  GameZone                                        │
├──────────────────────────────────────────────────────┤
│                                                      │
│   ┌────────────────────┐   ┌────────────────────┐   │
│   │  Higher or Lower   │   │   Coming Soon...   │   │
│   │                    │   │                    │   │
│   │  2 players • rooms │   │                    │   │
│   │                    │   │                    │   │
│   │  [ Create Room ]   │   │                    │   │
│   └────────────────────┘   └────────────────────┘   │
│                                                      │
└──────────────────────────────────────────────────────┘
```

---

## 4. Room System

### Room Lifecycle

```
Player A clicks "Create Room"
        │
        ▼
Server generates a random 6-char Room Code  (e.g. "XK92PL")
        │
        ▼
Player A lands on /room/XK92PL  → shares code with Player B
        │
Player B enters code on Home page → joins /room/XK92PL
        │
        ▼
Both players are connected → game can start
        │
        ▼
Game ends → players can rematch or leave
        │
        ▼
Room is destroyed when both players disconnect
```

### Room State (server-side)

```ts
interface Room {
  id: string;                  // 6-char code
  game: "higher-or-lower";     // which game is being played
  players: [Player, Player?];  // max 2
  gameState: GameState;        // game-specific state object
  createdAt: number;
}

interface Player {
  socketId: string;
  name: string;
  ready: boolean;
}
```

---

## 5. Higher or Lower — Full Game Design

### Concept

- Two players privately pick a **secret number** (0–99).
- A **coin toss** decides who guesses first.
- Players alternate guessing the **other player's** secret number.
- After each guess, the number's owner responds: **Higher**, **Lower**, or **Correct!**
- The player who correctly guesses the opponent's number **wins**.
- Tie: both guess correctly on the same round → draw.

### Detailed Game Flow

```
Phase 0 — Lobby
  Both players connected, click "Ready"

Phase 1 — Number Selection
  Each player privately types their secret number (0–99)
  Input is hidden (like a password field)
  Player sees "Waiting for opponent..." once they submit

Phase 2 — Coin Toss
  Animated coin flip shown to both players
  Result: Player A goes first / Player B goes first
  3-second countdown before guessing begins

Phase 3 — Guessing Turns
  Active player sees:
    - Their own guess history
    - A number input (0–99)
    - "Guess" button
  After submitting:
    - Opponent's client evaluates the guess against their secret number
    - Response: "Higher ↑" / "Lower ↓" / "Correct! 🎉"
    - Guess + result appended to guess log for both players
    - Turn passes to the other player

Phase 4 — Win Condition Check (after every guess)
  If correct → guesser wins
  If both guessed correctly this round → draw

Phase 5 — End Screen
  Shows winner / draw
  Guess history summary for both sides
  "Rematch" button (resets to Phase 1, same room)
  "Leave Room" button
```

### Guess Log (shown to both players)

```
Round 1 — Player A guesses Player B's number
  A guessed: 50  →  Higher ↑

Round 1 — Player B guesses Player A's number
  B guessed: 50  →  Lower ↓

Round 2 — Player A guesses
  A guessed: 75  →  Lower ↓

Round 2 — Player B guesses
  B guessed: 30  →  Correct! 🎉  Player B wins!
```

### Anti-cheat Consideration

The secret number must **never** be sent to the opponent's client until the game ends. The server holds both secret numbers and evaluates all guesses server-side. The owning player never sends "Higher/Lower" directly — the server computes and broadcasts it. This prevents cheating via browser devtools.

### Game State (server)

```ts
interface HigherOrLowerState {
  phase: "selecting" | "toss" | "guessing" | "ended";
  secrets: { [socketId: string]: number | null };  // hidden from opponents
  firstGuesser: string | null;                     // socket ID
  currentTurn: string | null;                      // socket ID
  guessLog: GuessEntry[];
  winner: string | "draw" | null;
}

interface GuessEntry {
  round: number;
  guesser: string;     // socket ID
  value: number;
  result: "higher" | "lower" | "correct";
}
```

---

## 6. Voice Chat

### Approach: WebRTC via PeerJS

- No media server required for 2-player rooms.
- Player A creates a PeerJS peer using their socket ID as the peer ID.
- Player B calls Player A's peer ID (exchanged via Socket.IO signaling).
- Audio streams directly between browsers.

### Controls (shown in-room)

- Mute / Unmute button
- Speaker indicator (shows who is speaking via Web Audio API volume detection)
- Permissions prompt handled gracefully — if denied, voice is disabled with a tooltip explaining why

### Fallback

If WebRTC fails (firewall, browser support), a toast message appears: "Voice unavailable — use the text chat below."

---

## 7. Text Chat

- Persistent within the room session (cleared on room destroy).
- Messages scoped to the room via Socket.IO room namespace.
- Simple structure: sender name, message, timestamp.
- Character limit: 300 chars per message.
- No message history persistence — chat is live only.

```
┌─────────────────────────────┐
│  Room Chat                  │
├─────────────────────────────┤
│  Alice: good luck!          │
│  Bob:   you too 😄          │
│  Alice: is it higher?       │
├─────────────────────────────┤
│  [ Type a message...  ] [→] │
└─────────────────────────────┘
```

---

## 8. Socket.IO Event Map

| Event | Direction | Payload | Description |
|---|---|---|---|
| `room:create` | C→S | `{ game, playerName }` | Create a new room |
| `room:created` | S→C | `{ roomId }` | Room code returned |
| `room:join` | C→S | `{ roomId, playerName }` | Join existing room |
| `room:joined` | S→C | `{ room, players }` | Confirmed join |
| `room:player_joined` | S→C | `{ player }` | Notify existing player |
| `room:player_left` | S→C | `{ playerId }` | Opponent disconnected |
| `game:ready` | C→S | — | Player marked ready |
| `game:secret_set` | C→S | `{ value }` | Submit secret number |
| `game:toss_result` | S→C | `{ firstGuesser }` | Coin toss outcome |
| `game:guess` | C→S | `{ value }` | Submit a guess |
| `game:guess_result` | S→C | `{ entry, nextTurn }` | Guess evaluation |
| `game:ended` | S→C | `{ winner, secrets }` | Game over, reveal secrets |
| `game:rematch` | C→S | — | Request rematch |
| `chat:message` | C→S | `{ text }` | Send chat message |
| `chat:message` | S→C | `{ sender, text, ts }` | Broadcast chat message |
| `webrtc:signal` | C→S | `{ to, signal }` | WebRTC signaling relay |
| `webrtc:signal` | S→C | `{ from, signal }` | WebRTC signal forwarded |

---

## 9. Extensibility — Adding New Games

To add a new game (e.g., "Tic Tac Toe"):

1. **Server**: Create `server/games/ticTacToe.ts` implementing a standard `GameHandler` interface:
   ```ts
   interface GameHandler {
     init(): GameState;
     onEvent(state: GameState, event: GameEvent): GameState;
     checkWin(state: GameState): WinResult;
   }
   ```
2. **Client**: Create `client/src/games/TicTacToe/` with game UI components.
3. **Home page**: Add a new game card pointing to the new game route.
4. **Room router**: Register the new game slug with its handler.

No changes to the room system, chat, or voice infrastructure are needed.

---

## 10. UI/UX Notes

- **Dark theme** by default — suits gaming aesthetic.
- **Responsive** — playable on desktop and mobile browsers.
- Room code is displayed prominently with a **copy-to-clipboard** button.
- All game state transitions have **animations** (coin flip, guess result reveal).
- Turn indicator clearly shows whose turn it is at all times.
- On disconnect mid-game, opponent sees a "Player left" overlay with option to wait or leave.

---

## 11. Phased Build Plan

### Phase 1 — Core Infrastructure
- [ ] Project scaffold (Vite + React + TypeScript client, Node + Express server)
- [ ] Socket.IO setup, room create/join flow
- [ ] Basic home page with one game card
- [ ] Room page shell with player list

### Phase 2 — Higher or Lower Game
- [ ] Number selection UI (private input)
- [ ] Server-side game state machine
- [ ] Coin toss animation + first-turn assignment
- [ ] Guessing UI + server evaluation
- [ ] Guess log display
- [ ] Win/draw detection + end screen
- [ ] Rematch flow

### Phase 3 — Communication
- [ ] Text chat (Socket.IO)
- [ ] WebRTC voice via PeerJS
- [ ] Mute toggle + speaking indicator
- [ ] Voice fallback handling

### Phase 4 — Polish
- [ ] Animations and transitions
- [ ] Mobile layout
- [ ] Error states (disconnection, invalid room code)
- [ ] Room expiry (auto-destroy after 30 min of inactivity)

---

## 12. Out of Scope (for now)

- User accounts / authentication
- Game history / leaderboards
- Spectator mode
- More than 2 players per room
- Persistent chat history
