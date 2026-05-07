export interface Player {
  socketId: string;
  name: string;
  ready: boolean;
}

export interface ChatMsg {
  id: string;
  sender: string;
  text: string;
  ts: number;
}

export interface GuessEntry {
  id: string;
  guesser: string;
  guesserName: string;
  value: number;
  result: 'higher' | 'lower' | 'correct';
}

export type GamePhase = 'lobby' | 'selecting' | 'toss' | 'guessing' | 'ended' | 'ttt_playing' | 'bingo_playing';
