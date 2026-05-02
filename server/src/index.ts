import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import * as rm from './roomManager';
import { allow as rateAllow, cleanup as rateCleanup } from './rateLimit';
import { VALID_GAMES, GameId } from './types';
import crypto from 'crypto';

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';
const PORT = parseInt(process.env.PORT ?? '3001', 10);

const app = express();
app.use(helmet());
app.use(cors({ origin: CLIENT_ORIGIN }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] },
});

// ─── input validation helpers ────────────────────────────────────────────────

function isString(v: unknown, maxLen: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
}

function isValidGame(v: unknown): v is GameId {
  return VALID_GAMES.includes(v as GameId);
}

// ─── per-socket leave logic (shared by room:leave and disconnect) ─────────────

function handleLeave(socket: Socket): void {
  const room = rm.getRoomBySocketId(socket.id);
  if (!room) return;
  const roomId = room.id;
  // Notify others before removing from state so we can still reach the room
  socket.to(roomId).emit('room:player_left', { playerId: socket.id });
  const remaining = rm.removePlayer(socket.id);
  if (remaining) {
    io.to(roomId).emit('room:players_update', { players: remaining.players });
  }
}

// ─── socket connection ────────────────────────────────────────────────────────

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
    if (!isValidGame(data?.game)) {
      callback({ error: 'Invalid game.' }); return;
    }
    if (!isString(data?.playerName, 20)) {
      callback({ error: 'Player name must be 1–20 characters.' }); return;
    }

    const room = rm.createRoom(data.game);
    const added = rm.addPlayer(room.id, { socketId: socket.id, name: data.playerName.trim(), ready: false });
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
    if (!isString(data?.roomId, 6)) {
      callback({ error: 'Invalid room code.' }); return;
    }
    if (!isString(data?.playerName, 20)) {
      callback({ error: 'Player name must be 1–20 characters.' }); return;
    }

    const room = rm.getRoom((data.roomId as string).trim().toUpperCase());
    if (!room) { callback({ error: 'Room not found.' }); return; }
    if (room.players.length >= 2) { callback({ error: 'Room is full.' }); return; }
    if (room.players.some(p => p.socketId === socket.id)) {
      callback({ error: 'Already in this room.' }); return;
    }

    const playerName = (data.playerName as string).trim();
    rm.addPlayer(room.id, { socketId: socket.id, name: playerName, ready: false });
    socket.join(room.id);

    const updated = rm.getRoom(room.id)!;
    socket.to(room.id).emit('room:player_joined', {
      player: updated.players[updated.players.length - 1],
    });

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
    if (!room) return; // null means already ready or no room
    io.to(room.id).emit('room:players_update', { players: room.players });
    if (room.players.length === 2 && room.players.every(p => p.ready)) {
      io.to(room.id).emit('game:starting', { game: room.game });
    }
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

// ─── periodic room eviction ───────────────────────────────────────────────────
setInterval(() => {
  rm.evictExpiredRooms();
}, 5 * 60 * 1000);

httpServer.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
