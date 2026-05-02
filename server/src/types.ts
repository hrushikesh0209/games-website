export const VALID_GAMES = ['higher-or-lower'] as const;
export type GameId = typeof VALID_GAMES[number];

export interface Player {
  socketId: string;
  name: string;
  ready: boolean;
  reconnectToken: string;
}

export interface PublicPlayer {
  socketId: string;
  name: string;
  ready: boolean;
}

export interface Room {
  id: string;
  game: GameId;
  players: Player[];
  gameState: unknown;
  createdAt: number;
  lastActivityAt: number;
}

export interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  ts: number;
}
