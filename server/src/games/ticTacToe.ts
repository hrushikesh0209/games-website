export type TTTState = {
  phase: 'playing' | 'ended';
  board: (string | null)[];
  marks: Record<string, 'X' | 'O'>;
  currentTurn: string | null;
  winner: string | null;
  winnerName: string | null;
  winLine: number[] | null;
};

const WIN_LINES = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6],
];

export function initGame(playerIds: [string, string]): TTTState {
  const [a, b] = playerIds;
  const xPlayer = Math.random() < 0.5 ? a : b;
  const oPlayer = xPlayer === a ? b : a;
  return {
    phase: 'playing',
    board: Array(9).fill(null),
    marks: { [xPlayer]: 'X', [oPlayer]: 'O' },
    currentTurn: xPlayer,
    winner: null,
    winnerName: null,
    winLine: null,
  };
}

export function makeMove(
  state: TTTState,
  playerId: string,
  cell: number,
): { valid: false } | { valid: true; ended: boolean; state: TTTState } {
  if (state.phase !== 'playing') return { valid: false };
  if (state.currentTurn !== playerId) return { valid: false };
  if (!Number.isInteger(cell) || cell < 0 || cell > 8) return { valid: false };
  if (state.board[cell] !== null) return { valid: false };

  state.board[cell] = playerId;

  for (const line of WIN_LINES) {
    if (line.every(idx => state.board[idx] === playerId)) {
      state.phase = 'ended';
      state.winner = playerId;
      state.currentTurn = null;
      state.winLine = line;
      return { valid: true, ended: true, state };
    }
  }

  if (state.board.every(c => c !== null)) {
    state.phase = 'ended';
    state.winner = 'draw';
    state.currentTurn = null;
    return { valid: true, ended: true, state };
  }

  const otherPlayer = Object.keys(state.marks).find(id => id !== playerId)!;
  state.currentTurn = otherPlayer;
  return { valid: true, ended: false, state };
}

export function replaceSocketId(state: TTTState, oldId: string, newId: string): void {
  state.board = state.board.map(cell => (cell === oldId ? newId : cell));
  if (oldId in state.marks) {
    state.marks[newId] = state.marks[oldId];
    delete state.marks[oldId];
  }
  if (state.currentTurn === oldId) state.currentTurn = newId;
  if (state.winner === oldId) state.winner = newId;
}
