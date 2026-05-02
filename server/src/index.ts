import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import * as rm from './roomManager';
import { allow as rateAllow, cleanup as rateCleanup } from './rateLimit';
import { VALID_GAMES, GameId } from './types';
import { initGame, allSecretsSet, evaluate, HoLState } from './games/higherOrLower';

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';
const PORT = parseInt(process.env.PORT ?? '3001', 10);

const app = express();
app.use(helmet());
app.use(cors({ origin: CLIENT_ORIGIN }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] },
});

// ── helpers ───────────────────────────────────────────────────────────────────

function isString(v: unknown, maxLen: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
}

function isValidGame(v: unknown): v is GameId {
  return VALID_GAMES.includes(v as GameId);
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function handleLeave(socket: Socket): void {
  const room = rm.getRoomBySocketId(socket.id);
  if (!room) return;
  const roomId = room.id;
  socket.to(roomId).emit('room:player_left', { playerId: socket.id });
  const remaining = rm.removePlayer(socket.id);
  if (remaining) {
    // Reset game if it was in progress
    remaining.gameState = null;
    remaining.players.forEach(p => { p.ready = false; });
    io.to(roomId).emit('room:players_update', { players: remaining.players });
    io.to(roomId).emit('game:reset');
  }
}

// ── connections ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`+ ${socket.id}`);

  // ── room:create ─────────────────────────────────────────────────────────────
  socket.on('room:create', (
    payload: unknown,
    callback: (res: { roomId: string } | { error: string }) => void,
  ) => {
    if (typeof callback !== 'function') return;
    if (!rateAllow(socket.id, 'room:create', 5, 60_000)) {
      callback({ error: 'Too many rooms created. Try again later.' }); return;
    }
    const data = payload as Record<string, unknown>;
    if (!isValidGame(data?.game)) { callback({ error: 'Invalid game.' }); return; }
    if (!isString(data?.playerName, 20)) { callback({ error: 'Name must be 1–20 characters.' }); return; }

    const room = rm.createRoom(data.game);
    const added = rm.addPlayer(room.id, { socketId: socket.id, name: (data.playerName as string).trim(), ready: false });
    if (!added) { callback({ error: 'Failed to create room.' }); return; }
    socket.join(room.id);
    callback({ roomId: room.id });
  });

  // ── room:join ────────────────────────────────────────────────────────────────
  socket.on('room:join', (
    payload: unknown,
    callback: (res: { roomId: string } | { error: string }) => void,
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
    rm.addPlayer(room.id, { socketId: socket.id, name, ready: false });
    socket.join(room.id);
    const updated = rm.getRoom(room.id)!;
    socket.to(room.id).emit('room:player_joined', { player: updated.players[updated.players.length - 1] });
    callback({ roomId: room.id });
  });

  // ── room:request_state ───────────────────────────────────────────────────────
  socket.on('room:request_state', () => {
    const room = rm.getRoomBySocketId(socket.id);
    if (!room) return;
    socket.emit('room:state', { room: { id: room.id, game: room.game }, players: room.players });
  });

  // ── game:ready ───────────────────────────────────────────────────────────────
  socket.on('game:ready', () => {
    if (!rateAllow(socket.id, 'game:ready', 3, 10_000)) return;
    const room = rm.setPlayerReady(socket.id);
    if (!room) return;
    io.to(room.id).emit('room:players_update', { players: room.players });
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
    if (state.secrets[socket.id] !== null) return; // already set

    state.secrets[socket.id] = data.value as number;
    socket.emit('game:secret_ack');

    if (!allSecretsSet(state)) return;

    // Both secrets set — coin toss
    const ids = room.players.map(p => p.socketId);
    const firstGuesser = ids[Math.floor(Math.random() * 2)];
    const firstName = room.players.find(p => p.socketId === firstGuesser)!.name;
    state.currentTurn = firstGuesser;
    state.phase = 'toss';

    io.to(room.id).emit('game:toss_result', { firstGuesser, firstName });

    // Transition to guessing after 3 s
    setTimeout(() => {
      if ((room.gameState as HoLState | null)?.phase === 'toss') {
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

    const me = room.players.find(p => p.socketId === socket.id)!;
    const opponent = room.players.find(p => p.socketId !== socket.id)!;
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
    io.to(room.id).emit('room:players_update', { players: room.players });
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
    const room = rm.getRoomBySocketId(socket.id);
    const roomId = room?.id;
    handleLeave(socket);
    if (roomId) socket.leave(roomId);
  });

  // ── disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`- ${socket.id}`);
    rateCleanup(socket.id);
    handleLeave(socket);
  });
});

// ── room eviction ─────────────────────────────────────────────────────────────
setInterval(() => rm.evictExpiredRooms(), 5 * 60 * 1000);

httpServer.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
