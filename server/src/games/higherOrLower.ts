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
  tossWinner: string | null;
  guessLog: GuessEntry[];
  winner: string | null;
  winnerName: string | null;
}

export function initGame(playerIds: [string, string]): HoLState {
  const secrets: Record<string, number | null> = {};
  playerIds.forEach(id => { secrets[id] = null; });
  return { phase: 'selecting', secrets, currentTurn: null, tossWinner: null, guessLog: [], winner: null, winnerName: null };
}

export function allSecretsSet(state: HoLState): boolean {
  return Object.values(state.secrets).every(s => s !== null);
}

export function replaceSocketId(state: HoLState, oldId: string, newId: string): void {
  if (oldId in state.secrets) {
    state.secrets[newId] = state.secrets[oldId];
    delete state.secrets[oldId];
  }
  if (state.currentTurn === oldId) state.currentTurn = newId;
  if (state.winner === oldId) state.winner = newId;
  if (state.tossWinner === oldId) state.tossWinner = newId;
  state.guessLog.forEach(e => { if (e.guesser === oldId) e.guesser = newId; });
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
