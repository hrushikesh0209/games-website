import { Room, Player, PublicPlayer, GameId } from './types';

const rooms = new Map<string, Room>();
const socketToRoom = new Map<string, string>(); // O(1) reverse lookup

const ROOM_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return code;
}

function touch(room: Room): void {
  room.lastActivityAt = Date.now();
}

export function createRoom(game: GameId): Room {
  let id = generateRoomCode();
  while (rooms.has(id)) id = generateRoomCode();
  const now = Date.now();
  const room: Room = { id, game, players: [], gameState: null, createdAt: now, lastActivityAt: now };
  rooms.set(id, room);
  return room;
}

export function getRoom(id: string): Room | undefined {
  return rooms.get(id);
}

export function addPlayer(roomId: string, player: Player): boolean {
  const room = rooms.get(roomId);
  if (!room || room.players.length >= 2) return false;
  room.players.push(player);
  socketToRoom.set(player.socketId, roomId);
  touch(room);
  return true;
}

export function removePlayer(socketId: string): Room | null {
  const roomId = socketToRoom.get(socketId);
  if (!roomId) return null;
  socketToRoom.delete(socketId);

  const room = rooms.get(roomId);
  if (!room) return null;

  room.players = room.players.filter(p => p.socketId !== socketId);

  if (room.players.length === 0) {
    rooms.delete(roomId);
    return null;
  }

  room.players.forEach(p => { p.ready = false; });
  touch(room);
  return room;
}

export function getRoomBySocketId(socketId: string): Room | undefined {
  const roomId = socketToRoom.get(socketId);
  return roomId ? rooms.get(roomId) : undefined;
}

export function setPlayerReady(socketId: string): Room | null {
  const room = getRoomBySocketId(socketId);
  if (!room) return null;
  const player = room.players.find(p => p.socketId === socketId);
  if (!player || player.ready) return null; // guard: already ready
  player.ready = true;
  touch(room);
  return room;
}

// Called on a schedule to evict rooms with no activity
export function evictExpiredRooms(): void {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [id, room] of rooms) {
    if (room.lastActivityAt < cutoff) {
      room.players.forEach(p => socketToRoom.delete(p.socketId));
      rooms.delete(id);
    }
  }
}

export function getRoomCount(): number {
  return rooms.size;
}

export function toPublicPlayer(p: Player): PublicPlayer {
  return { socketId: p.socketId, name: p.name, ready: p.ready };
}

export function reconnectByToken(
  roomId: string,
  token: string,
  newSocketId: string,
): { room: Room; oldSocketId: string } | null {
  const room = rooms.get(roomId.toUpperCase());
  if (!room) return null;
  const player = room.players.find(p => p.reconnectToken === token);
  if (!player || player.socketId === newSocketId) return null;
  const oldSocketId = player.socketId;
  socketToRoom.delete(oldSocketId);
  socketToRoom.set(newSocketId, roomId.toUpperCase());
  player.socketId = newSocketId;
  touch(room);
  return { room, oldSocketId };
}
