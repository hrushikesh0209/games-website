import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import * as rm from './roomManager';
import { allow as rateAllow, cleanup as rateCleanup } from './rateLimit';
import { VALID_GAMES, GameId } from './types';
import { initGame as initHoL, allSecretsSet, evaluate, replaceSocketId as holReplaceId, HoLState } from './games/higherOrLower';
import * as ttt from './games/ticTacToe';
import * as bingo from './games/bingo';

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';
const PORT = parseInt(process.env.PORT ?? '3001', 10);
const RECONNECT_GRACE_MS = 15_000;

// Rate-limit budgets [maxEvents, windowMs] — named so magic numbers live in one place.
const RL = {
  roomCreate:    [5,  60_000] as const,
  roomJoin:      [10, 60_000] as const,
  roomReconnect: [3,  10_000] as const,
  gameReady:     [3,  10_000] as const,
  setSecret:     [3,  10_000] as const,
  guess:         [20, 30_000] as const,
  tttMove:       [10,  5_000] as const,
  bingoDraw:     [10,  5_000] as const,
  bingoClaim:    [3,  10_000] as const,
  rematch:       [3,  10_000] as const,
  chat:          [10,  5_000] as const,
  voiceOffer:    [3,  30_000] as const,
  voiceAnswer:   [3,  30_000] as const,
  voiceIce:      [50, 10_000] as const,
};

const app = express();
app.use(helmet());
app.use(cors({ origin: CLIENT_ORIGIN }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] },
});

// socketId → pending grace timer
const disconnectTimers = new Map<string, NodeJS.Timeout>();

// ── helpers ───────────────────────────────────────────────────────────────────

function buildClientGameState(state: HoLState, socketId: string) {
  const base = {
    phase: state.phase,
    currentTurn: state.currentTurn,
    tossWinner: state.tossWinner,
    guessLog: state.guessLog,
    mySecretSet: socketId in state.secrets && state.secrets[socketId] !== null,
  };
  if (state.phase === 'ended') {
    return { ...base, winner: state.winner, winnerName: state.winnerName, secrets: state.secrets as Record<string, number> };
  }
  return base;
}

function isString(v: unknown, maxLen: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
}

function isValidGame(v: unknown): v is GameId {
  return VALID_GAMES.includes(v as GameId);
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

// Fully remove player and reset game for remaining players.
function handleLeave(socketId: string): void {
  const room = rm.getRoomBySocketId(socketId);
  if (!room) return;
  const roomId = room.id;

  // Cancel any pending rematch votes and notify remaining player
  const hadVotes = room.rematchVotes.size > 0;
  room.rematchVotes.delete(socketId);
  if (hadVotes) {
    room.rematchVotes.clear();
    io.to(roomId).except(socketId).emit('game:rematch_cancelled');
  }

  io.to(roomId).except(socketId).emit('room:player_left', { playerId: socketId });
  const remaining = rm.removePlayer(socketId);
  if (remaining) {
    remaining.gameState = null;
    remaining.players.forEach(p => { p.ready = false; });
    io.to(roomId).emit('room:players_update', { players: remaining.players.map(rm.toPublicPlayer) });
    io.to(roomId).emit('game:reset');
  }
}

// On disconnect: notify others but keep game state alive for RECONNECT_GRACE_MS.
function scheduleLeave(socketId: string): void {
  const room = rm.getRoomBySocketId(socketId);
  if (!room) return;
  io.to(room.id).except(socketId).emit('room:player_disconnected', { playerId: socketId });

  // Cancel this player's rematch vote on disconnect
  if (room.rematchVotes.has(socketId)) {
    room.rematchVotes.delete(socketId);
    io.to(room.id).except(socketId).emit('game:rematch_cancelled');
  }

  const timer = setTimeout(() => {
    disconnectTimers.delete(socketId);
    handleLeave(socketId);
  }, RECONNECT_GRACE_MS);
  disconnectTimers.set(socketId, timer);
}

// Send game-specific state to a single socket (reconnect / request_state).
function sendGameState(socketId: string, room: NonNullable<ReturnType<typeof rm.getRoomBySocketId>>): void {
  if (room.game === 'higher-or-lower' && room.gameState) {
    const gs = buildClientGameState(room.gameState as HoLState, socketId);
    io.to(socketId).emit('room:state', {
      room: { id: room.id, game: room.game },
      players: room.players.map(rm.toPublicPlayer),
      gameState: gs,
    });
  } else {
    io.to(socketId).emit('room:state', {
      room: { id: room.id, game: room.game },
      players: room.players.map(rm.toPublicPlayer),
      gameState: null,
    });
    if (room.game === 'tic-tac-toe' && room.gameState) {
      const gs = room.gameState as ttt.TTTState;
      io.to(socketId).emit('game:ttt_start', {
        board: gs.board,
        marks: gs.marks,
        currentTurn: gs.currentTurn,
        phase: gs.phase,
        winner: gs.winner,
        winnerName: gs.winnerName,
        winLine: gs.winLine,
      });
    } else if (room.game === 'bingo' && room.gameState) {
      const gs = room.gameState as bingo.BingoState;
      io.to(socketId).emit('game:bingo_init', {
        card: gs.cards[socketId],
        marked: gs.marked[socketId],
        drawn: gs.drawn,
        available: gs.available,
        currentDrawer: gs.currentDrawer,
        currentNumber: gs.currentNumber,   // H-3: restore last-drawn on reconnect
      });
      if (gs.phase === 'ended') {
        io.to(socketId).emit('game:ended', { winner: gs.winner, winnerName: gs.winnerName });
      }
    }
  }
}

// ── connections ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`+ ${socket.id}`);

  // ── room:create ─────────────────────────────────────────────────────────────
  socket.on('room:create', (
    payload: unknown,
    callback: (res: { roomId: string; token: string } | { error: string }) => void,
  ) => {
    if (typeof callback !== 'function') return;
    if (!rateAllow(socket.id, 'room:create', ...RL.roomCreate)) {
      callback({ error: 'Too many rooms created. Try again later.' }); return;
    }
    const data = payload as Record<string, unknown>;
    if (!isValidGame(data?.game)) { callback({ error: 'Invalid game.' }); return; }
    if (!isString(data?.playerName, 20)) { callback({ error: 'Name must be 1–20 characters.' }); return; }

    const room = rm.createRoom(data.game);
    const token = crypto.randomUUID();
    const added = rm.addPlayer(room.id, { socketId: socket.id, name: (data.playerName as string).trim(), ready: false, reconnectToken: token });
    if (!added) { callback({ error: 'Failed to create room.' }); return; }
    socket.join(room.id);
    callback({ roomId: room.id, token });
  });

  // ── room:join ────────────────────────────────────────────────────────────────
  socket.on('room:join', (
    payload: unknown,
    callback: (res: { roomId: string; token: string } | { error: string }) => void,
  ) => {
    if (typeof callback !== 'function') return;
    if (!rateAllow(socket.id, 'room:join', ...RL.roomJoin)) {
      callback({ error: 'Too many join attempts. Try again later.' }); return;
    }
    const data = payload as Record<string, unknown>;
    if (!isString(data?.roomId, 6)) { callback({ error: 'Invalid room code.' }); return; }
    if (!isString(data?.playerName, 20)) { callback({ error: 'Name must be 1–20 characters.' }); return; }

    const room = rm.getRoom((data.roomId as string).trim().toUpperCase());
    if (!room) { callback({ error: 'Room not found.' }); return; }
    if (room.players.length >= 2) { callback({ error: 'Room is full.' }); return; }
    if (room.players.some(p => p.socketId === socket.id)) { callback({ error: 'Already in this room.' }); return; }

    const name = (data.playerName as string).trim();
    const token = crypto.randomUUID();
    rm.addPlayer(room.id, { socketId: socket.id, name, ready: false, reconnectToken: token });
    socket.join(room.id);
    const updated = rm.getRoom(room.id)!;
    const newPlayer = updated.players[updated.players.length - 1];
    socket.to(room.id).emit('room:player_joined', { player: rm.toPublicPlayer(newPlayer) });
    callback({ roomId: room.id, token });
  });

  // ── room:reconnect ───────────────────────────────────────────────────────────
  socket.on('room:reconnect', (
    payload: unknown,
    callback: (res: { ok: true } | { error: string }) => void,
  ) => {
    if (typeof callback !== 'function') return;
    if (!rateAllow(socket.id, 'room:reconnect', ...RL.roomReconnect)) {
      callback({ error: 'Too many reconnect attempts.' }); return;
    }
    const data = payload as Record<string, unknown>;
    if (!isString(data?.roomId, 6) || !isString(data?.token, 40)) {
      callback({ error: 'Invalid.' }); return;
    }

    const result = rm.reconnectByToken(data.roomId as string, data.token as string, socket.id);
    if (!result) { callback({ error: 'Session expired or room not found.' }); return; }

    const { room, oldSocketId } = result;

    // Cancel the grace period timer for the old socket
    const timer = disconnectTimers.get(oldSocketId);
    if (timer) { clearTimeout(timer); disconnectTimers.delete(oldSocketId); }

    // Update socketId references in active game state
    if (room.gameState) {
      if (room.game === 'tic-tac-toe') {
        ttt.replaceSocketId(room.gameState as ttt.TTTState, oldSocketId, socket.id);
      } else if (room.game === 'bingo') {
        bingo.replaceSocketId(room.gameState as bingo.BingoState, oldSocketId, socket.id);
      } else {
        holReplaceId(room.gameState as HoLState, oldSocketId, socket.id);
      }
    }

    socket.join(room.id);
    socket.to(room.id).emit('room:player_reconnected', { playerId: socket.id });
    sendGameState(socket.id, room);
    callback({ ok: true });
  });

  // ── room:request_state ───────────────────────────────────────────────────────
  socket.on('room:request_state', () => {
    const room = rm.getRoomBySocketId(socket.id);
    if (!room) { socket.emit('room:not_found'); return; }
    sendGameState(socket.id, room);
  });

  // ── game:ready ───────────────────────────────────────────────────────────────
  socket.on('game:ready', () => {
    if (!rateAllow(socket.id, 'game:ready', ...RL.gameReady)) return;
    const room = rm.setPlayerReady(socket.id);
    if (!room) return;
    io.to(room.id).emit('room:players_update', { players: room.players.map(rm.toPublicPlayer) });

    if (room.players.length === 2 && room.players.every(p => p.ready)) {
      room.rematchVotes.clear();
      const ids = room.players.map(p => p.socketId);

      if (room.game === 'tic-tac-toe') {
        const state = ttt.initGame([ids[0], ids[1]]);
        room.gameState = state;

        // Coin toss: X player goes first
        const xPlayer = Object.entries(state.marks).find(([, m]) => m === 'X')![0];
        const xName = room.players.find(p => p.socketId === xPlayer)!.name;
        io.to(room.id).emit('game:toss_result', { firstGuesser: xPlayer, firstName: xName });

        setTimeout(() => {
          if (room.gameState !== state) return;
          io.to(room.id).emit('game:ttt_start', {
            board: state.board,
            marks: state.marks,
            currentTurn: state.currentTurn,
            phase: state.phase,
            winner: null,
            winnerName: null,
            winLine: null,
          });
        }, 3000);

      } else if (room.game === 'bingo') {
        const firstDrawer = ids[Math.floor(Math.random() * 2)];
        const drawerName = room.players.find(p => p.socketId === firstDrawer)!.name;
        const state = bingo.initGame([ids[0], ids[1]], firstDrawer);
        room.gameState = state;

        io.to(room.id).emit('game:toss_result', { firstGuesser: firstDrawer, firstName: drawerName });

        setTimeout(() => {
          if (room.gameState !== state) return;
          for (const player of room.players) {
            io.to(player.socketId).emit('game:bingo_init', {
              card: state.cards[player.socketId],
              marked: state.marked[player.socketId],
              drawn: [],
              available: state.available,
              currentDrawer: state.currentDrawer,
              currentNumber: null,
            });
          }
        }, 3000);

      } else {
        // Higher or Lower
        room.gameState = initHoL([ids[0], ids[1]]);
        io.to(room.id).emit('game:starting', { game: room.game });
      }
    }
  });

  // ── game:set_secret ──────────────────────────────────────────────────────────
  socket.on('game:set_secret', (payload: unknown) => {
    if (!rateAllow(socket.id, 'game:set_secret', ...RL.setSecret)) return;
    const data = payload as Record<string, unknown>;
    if (!isInt(data?.value, 0, 99)) return;

    const room = rm.getRoomBySocketId(socket.id);
    if (!room?.gameState || room.game !== 'higher-or-lower') return;
    const state = room.gameState as HoLState;
    if (state.phase !== 'selecting') return;
    if (state.secrets[socket.id] !== null) return;

    state.secrets[socket.id] = data.value as number;
    socket.emit('game:secret_ack');

    if (!allSecretsSet(state)) return;

    const ids = room.players.map(p => p.socketId);
    const firstGuesser = ids[Math.floor(Math.random() * 2)];
    const firstName = room.players.find(p => p.socketId === firstGuesser)!.name;
    state.currentTurn = firstGuesser;
    state.tossWinner = firstGuesser;
    state.phase = 'toss';

    io.to(room.id).emit('game:toss_result', { firstGuesser, firstName });

    setTimeout(() => {
      if (room.gameState === state && state.phase === 'toss') {
        state.phase = 'guessing';
        io.to(room.id).emit('game:guessing_start', { currentTurn: firstGuesser });
      }
    }, 3000);
  });

  // ── game:guess ───────────────────────────────────────────────────────────────
  socket.on('game:guess', (payload: unknown) => {
    if (!rateAllow(socket.id, 'game:guess', ...RL.guess)) return;
    const data = payload as Record<string, unknown>;
    if (!isInt(data?.value, 0, 99)) return;

    const room = rm.getRoomBySocketId(socket.id);
    if (!room?.gameState || room.game !== 'higher-or-lower') return;
    const state = room.gameState as HoLState;
    if (state.phase !== 'guessing') return;
    if (state.currentTurn !== socket.id) return;

    const me = room.players.find(p => p.socketId === socket.id);
    const opponent = room.players.find(p => p.socketId !== socket.id);
    if (!me || !opponent) return;
    const entry = evaluate(state, socket.id, me.name, opponent.socketId, data.value as number);

    if (entry.result === 'correct') {
      state.phase = 'ended';
      state.winner = socket.id;
      state.winnerName = me.name;
      io.to(room.id).emit('game:guess_result', { entry, nextTurn: null });
      io.to(room.id).emit('game:ended', {
        winner: socket.id,
        winnerName: me.name,
        secrets: state.secrets,
        guessLog: state.guessLog,
      });
    } else {
      state.currentTurn = opponent.socketId;
      io.to(room.id).emit('game:guess_result', { entry, nextTurn: opponent.socketId });
    }
  });

  // ── game:ttt_move ────────────────────────────────────────────────────────────
  socket.on('game:ttt_move', (payload: unknown) => {
    if (!rateAllow(socket.id, 'game:ttt_move', ...RL.tttMove)) return;
    const data = payload as Record<string, unknown>;
    if (!isInt(data?.cell, 0, 8)) return;

    const room = rm.getRoomBySocketId(socket.id);
    if (!room?.gameState || room.game !== 'tic-tac-toe') return;
    const state = room.gameState as ttt.TTTState;
    if (state.phase !== 'playing') return;

    const result = ttt.makeMove(state, socket.id, data.cell as number);
    if (!result.valid) return;

    if (result.ended && result.state.winner && result.state.winner !== 'draw') {
      const winnerPlayer = room.players.find(p => p.socketId === result.state.winner);
      result.state.winnerName = winnerPlayer?.name ?? null;
    }

    io.to(room.id).emit('game:ttt_update', {
      board: result.state.board,
      currentTurn: result.state.currentTurn,
      phase: result.state.phase,
      winner: result.state.winner,
      winnerName: result.state.winnerName,
      winLine: result.state.winLine,
    });

    if (result.ended) {
      io.to(room.id).emit('game:ended', {
        winner: result.state.winner,
        winnerName: result.state.winnerName,
      });
    }
  });

  // ── game:bingo_draw ──────────────────────────────────────────────────────────
  socket.on('game:bingo_draw', (payload: unknown) => {
    if (!rateAllow(socket.id, 'game:bingo_draw', ...RL.bingoDraw)) return;
    const data = payload as Record<string, unknown>;
    if (!isInt(data?.number, 1, 75)) return;

    const room = rm.getRoomBySocketId(socket.id);
    if (!room?.gameState || room.game !== 'bingo') return;
    const state = room.gameState as bingo.BingoState;
    if (state.phase !== 'playing') return;
    if (state.currentDrawer !== socket.id) return;

    const ok = bingo.drawNumber(state, data.number as number);
    if (!ok) return;

    bingo.autoMark(state, data.number as number);

    // M-2: resolve pool exhaustion BEFORE switching the drawer, so the emitted
    // currentDrawer is null rather than pointing at a player whose turn never comes.
    const poolExhausted = state.available.length === 0;
    const other = room.players.find(p => p.socketId !== socket.id);
    state.currentDrawer = poolExhausted ? null : (other?.socketId ?? null);

    // C-1: send each player only their own marked grid (not the full Record).
    for (const player of room.players) {
      io.to(player.socketId).emit('game:bingo_drawn', {
        number: data.number as number,
        drawn: state.drawn,
        available: state.available,
        marked: state.marked[player.socketId],
        currentDrawer: state.currentDrawer,
      });
    }

    if (poolExhausted) {
      state.phase = 'ended';
      io.to(room.id).emit('game:ended', { winner: 'draw', winnerName: 'No one' });
    }
  });

  // ── game:bingo_claim ─────────────────────────────────────────────────────────
  socket.on('game:bingo_claim', () => {
    if (!rateAllow(socket.id, 'game:bingo_claim', ...RL.bingoClaim)) return;

    const room = rm.getRoomBySocketId(socket.id);
    if (!room?.gameState || room.game !== 'bingo') return;
    const state = room.gameState as bingo.BingoState;
    if (state.phase !== 'playing') return;

    const claimResult = bingo.checkBingo(state, socket.id);
    if (!claimResult.hasBingo) return;

    state.phase = 'ended';
    state.winner = socket.id;
    const player = room.players.find(p => p.socketId === socket.id);
    const winnerName = player?.name ?? null;
    state.winnerName = winnerName;
    state.winLine = claimResult.winLine;

    io.to(room.id).emit('game:ended', {
      winner: socket.id,
      winnerName,
      winLine: claimResult.winLine,
    });
  });

  // ── game:rematch ─────────────────────────────────────────────────────────────
  socket.on('game:rematch', () => {
    if (!rateAllow(socket.id, 'game:rematch', ...RL.rematch)) return;  // H-1
    const room = rm.getRoomBySocketId(socket.id);
    if (!room) return;
    if (room.players.length < 2) return;

    room.rematchVotes.add(socket.id);

    if (room.rematchVotes.size === 1) {
      io.to(room.id).emit('game:rematch_pending', { voterId: socket.id });
    } else if (room.rematchVotes.size >= 2) {
      room.gameState = null;
      room.rematchVotes.clear();
      room.players.forEach(p => { p.ready = false; });
      io.to(room.id).emit('room:players_update', { players: room.players.map(rm.toPublicPlayer) });
      io.to(room.id).emit('game:reset');
    }
  });

  // ── voice relay handlers ─────────────────────────────────────────────────────
  // H-2: rate-limited and shape-validated to prevent relay abuse.
  socket.on('voice:offer', (payload: unknown) => {
    if (!rateAllow(socket.id, 'voice:offer', ...RL.voiceOffer)) return;
    if (typeof payload !== 'object' || payload === null || !('sdp' in payload)) return;
    const room = rm.getRoomBySocketId(socket.id);
    if (!room) return;
    socket.to(room.id).emit('voice:offer', payload);
  });

  socket.on('voice:answer', (payload: unknown) => {
    if (!rateAllow(socket.id, 'voice:answer', ...RL.voiceAnswer)) return;
    if (typeof payload !== 'object' || payload === null || !('sdp' in payload)) return;
    const room = rm.getRoomBySocketId(socket.id);
    if (!room) return;
    socket.to(room.id).emit('voice:answer', payload);
  });

  socket.on('voice:ice', (payload: unknown) => {
    if (!rateAllow(socket.id, 'voice:ice', ...RL.voiceIce)) return;
    if (typeof payload !== 'object' || payload === null || !('candidate' in payload)) return;
    const room = rm.getRoomBySocketId(socket.id);
    if (!room) return;
    socket.to(room.id).emit('voice:ice', payload);
  });

  // ── chat:message ─────────────────────────────────────────────────────────────
  socket.on('chat:message', (payload: unknown) => {
    if (!rateAllow(socket.id, 'chat:message', ...RL.chat)) return;
    const data = payload as Record<string, unknown>;
    if (!isString(data?.text, 300)) return;
    const room = rm.getRoomBySocketId(socket.id);
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;
    io.to(room.id).emit('chat:message', {
      id: crypto.randomUUID(),
      sender: player.name,
      text: (data.text as string).trim(),
      ts: Date.now(),
    });
  });

  // ── room:leave ───────────────────────────────────────────────────────────────
  socket.on('room:leave', () => {
    const timer = disconnectTimers.get(socket.id);
    if (timer) { clearTimeout(timer); disconnectTimers.delete(socket.id); }
    const roomId = rm.getRoomBySocketId(socket.id)?.id;
    handleLeave(socket.id);
    if (roomId) socket.leave(roomId);
  });

  // ── disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`- ${socket.id}`);
    rateCleanup(socket.id);
    scheduleLeave(socket.id);
  });
});

// ── room eviction ─────────────────────────────────────────────────────────────
setInterval(() => rm.evictExpiredRooms(), 5 * 60 * 1000);

httpServer.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
