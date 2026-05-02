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
import { initGame, allSecretsSet, evaluate, replaceSocketId, HoLState } from './games/higherOrLower';

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';
const PORT = parseInt(process.env.PORT ?? '3001', 10);
const RECONNECT_GRACE_MS = 15_000;

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
// Uses socketId string so it works for already-disconnected sockets too.
function handleLeave(socketId: string): void {
  const room = rm.getRoomBySocketId(socketId);
  if (!room) return;
  const roomId = room.id;
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
// If the player doesn't reconnect in time, call handleLeave to clean up.
function scheduleLeave(socketId: string): void {
  const room = rm.getRoomBySocketId(socketId);
  if (!room) return;
  io.to(room.id).except(socketId).emit('room:player_disconnected', { playerId: socketId });
  const timer = setTimeout(() => {
    disconnectTimers.delete(socketId);
    handleLeave(socketId);
  }, RECONNECT_GRACE_MS);
  disconnectTimers.set(socketId, timer);
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
    if (!rateAllow(socket.id, 'room:create', 5, 60_000)) {
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
    if (!rateAllow(socket.id, 'room:join', 10, 60_000)) {
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
    if (!rateAllow(socket.id, 'room:reconnect', 3, 10_000)) {
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
      replaceSocketId(room.gameState as HoLState, oldSocketId, socket.id);
    }

    // Re-join the Socket.IO room and notify others
    socket.join(room.id);
    socket.to(room.id).emit('room:player_reconnected', { playerId: socket.id });

    // Send full state to the reconnected player
    const gs = room.gameState ? buildClientGameState(room.gameState as HoLState, socket.id) : null;
    socket.emit('room:state', {
      room: { id: room.id, game: room.game },
      players: room.players.map(rm.toPublicPlayer),
      gameState: gs,
    });

    callback({ ok: true });
  });

  // ── room:request_state ───────────────────────────────────────────────────────
  socket.on('room:request_state', () => {
    const room = rm.getRoomBySocketId(socket.id);
    if (!room) { socket.emit('room:not_found'); return; }
    const gs = room.gameState ? buildClientGameState(room.gameState as HoLState, socket.id) : null;
    socket.emit('room:state', {
      room: { id: room.id, game: room.game },
      players: room.players.map(rm.toPublicPlayer),
      gameState: gs,
    });
  });

  // ── game:ready ───────────────────────────────────────────────────────────────
  socket.on('game:ready', () => {
    if (!rateAllow(socket.id, 'game:ready', 3, 10_000)) return;
    const room = rm.setPlayerReady(socket.id);
    if (!room) return;
    io.to(room.id).emit('room:players_update', { players: room.players.map(rm.toPublicPlayer) });
    if (room.players.length === 2 && room.players.every(p => p.ready)) {
      room.gameState = initGame(room.players.map(p => p.socketId));
      io.to(room.id).emit('game:starting', { game: room.game });
    }
  });

  // ── game:set_secret ──────────────────────────────────────────────────────────
  socket.on('game:set_secret', (payload: unknown) => {
    if (!rateAllow(socket.id, 'game:set_secret', 3, 10_000)) return;
    const data = payload as Record<string, unknown>;
    if (!isInt(data?.value, 0, 99)) return;

    const room = rm.getRoomBySocketId(socket.id);
    if (!room?.gameState) return;
    const state = room.gameState as HoLState;
    if (state.phase !== 'selecting') return;
    if (state.secrets[socket.id] !== null) return;

    state.secrets[socket.id] = data.value as number;
    socket.emit('game:secret_ack');

    if (!allSecretsSet(state)) return;

    // Both secrets set — coin toss
    const ids = room.players.map(p => p.socketId);
    const firstGuesser = ids[Math.floor(Math.random() * 2)];
    const firstName = room.players.find(p => p.socketId === firstGuesser)!.name;
    state.currentTurn = firstGuesser;
    state.tossWinner = firstGuesser;
    state.phase = 'toss';

    io.to(room.id).emit('game:toss_result', { firstGuesser, firstName });

    // Compare by reference — stale timeouts from old games are ignored
    setTimeout(() => {
      if (room.gameState === state && state.phase === 'toss') {
        state.phase = 'guessing';
        io.to(room.id).emit('game:guessing_start', { currentTurn: firstGuesser });
      }
    }, 3000);
  });

  // ── game:guess ───────────────────────────────────────────────────────────────
  socket.on('game:guess', (payload: unknown) => {
    if (!rateAllow(socket.id, 'game:guess', 20, 30_000)) return;
    const data = payload as Record<string, unknown>;
    if (!isInt(data?.value, 0, 99)) return;

    const room = rm.getRoomBySocketId(socket.id);
    if (!room?.gameState) return;
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

  // ── game:rematch ─────────────────────────────────────────────────────────────
  socket.on('game:rematch', () => {
    const room = rm.getRoomBySocketId(socket.id);
    if (!room) return;
    room.gameState = null;
    room.players.forEach(p => { p.ready = false; });
    io.to(room.id).emit('room:players_update', { players: room.players.map(rm.toPublicPlayer) });
    io.to(room.id).emit('game:reset');
  });

  // ── chat:message ─────────────────────────────────────────────────────────────
  socket.on('chat:message', (payload: unknown) => {
    if (!rateAllow(socket.id, 'chat:message', 10, 5_000)) return;
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
    // Cancel any pending grace timer (safety — normally only set on disconnect)
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
