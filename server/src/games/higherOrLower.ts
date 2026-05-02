import crypto from 'crypto';

export interface GuessEntry {
  id: string;
  guesser: string;
  guesserName: string;
  value: number;
  result: 'higher' | 'lower' | 'correct';
}

export interface HoLState {
  phase: 'selecting' | 'toss' | 'guessing' | 'ended';
  secrets: Record<string, number | null>;
  currentTurn: string | null;
  guessLog: GuessEntry[];
  winner: string | null;
  winnerName: string | null;
}

export function initGame(playerIds: string[]): HoLState {
  const secrets: Record<string, number | null> = {};
  playerIds.forEach(id => { secrets[id] = null; });
  return { phase: 'selecting', secrets, currentTurn: null, guessLog: [], winner: null, winnerName: null };
}

export function allSecretsSet(state: HoLState): boolean {
  return Object.values(state.secrets).every(s => s !== null);
}

export function evaluate(
  state: HoLState,
  guesserSocketId: string,
  guesserName: string,
  opponentSocketId: string,
  value: number,
): GuessEntry {
  const secret = state.secrets[opponentSocketId]!;
  const result: GuessEntry['result'] =
    value === secret ? 'correct' : value < secret ? 'higher' : 'lower';
  const entry: GuessEntry = { id: crypto.randomUUID(), guesser: guesserSocketId, guesserName, value, result };
  state.guessLog.push(entry);
  return entry;
}
