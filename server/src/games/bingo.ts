export type BingoCard = (number | 'FREE')[][];

export type BingoState = {
  phase: 'playing' | 'ended';
  cards: Record<string, BingoCard>;
  marked: Record<string, boolean[][]>;
  available: number[];      // numbers 1-75 not yet drawn; user picks from these
  drawn: number[];
  currentNumber: number | null;
  currentDrawer: string | null;  // whose turn it is to pick a number
  tossWinner: string | null;
  winner: string | null;
  winnerName: string | null;
  winLine: { type: 'row' | 'col' | 'diag'; index: number } | null;
};

const COL_RANGES: [number, number][] = [
  [1, 15], [16, 30], [31, 45], [46, 60], [61, 75],
];

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickUnique(min: number, max: number, count: number): number[] {
  const pool: number[] = [];
  for (let i = min; i <= max; i++) pool.push(i);
  shuffle(pool);
  return pool.slice(0, count);
}

export function generateCard(): BingoCard {
  const cols: (number | 'FREE')[][] = COL_RANGES.map(([min, max]) =>
    pickUnique(min, max, 5) as (number | 'FREE')[],
  );
  const card: (number | 'FREE')[][] = Array.from({ length: 5 }, (_, r) =>
    Array.from({ length: 5 }, (_, c) => cols[c][r]),
  );
  card[2][2] = 'FREE';
  return card;
}

export function initGame(playerIds: [string, string], firstDrawer: string): BingoState {
  const cards: Record<string, BingoCard> = {};
  const marked: Record<string, boolean[][]> = {};
  for (const id of playerIds) {
    cards[id] = generateCard();
    const m: boolean[][] = Array.from({ length: 5 }, () => Array(5).fill(false));
    m[2][2] = true;
    marked[id] = m;
  }
  return {
    phase: 'playing',
    cards,
    marked,
    available: Array.from({ length: 75 }, (_, i) => i + 1),
    drawn: [],
    currentNumber: null,
    currentDrawer: firstDrawer,
    tossWinner: firstDrawer,
    winner: null,
    winnerName: null,
    winLine: null,
  };
}

// L-9: The number that was overwritten by 'FREE' at card[2][2] remains in the
// available pool. When drawn it simply marks nothing on either card, which is
// correct bingo behaviour — the FREE space is pre-marked independently.

// Player picks a specific number from the available pool. Returns false if invalid.
export function drawNumber(state: BingoState, number: number): boolean {
  const idx = state.available.indexOf(number);
  if (idx === -1) return false;
  state.available.splice(idx, 1);
  state.drawn.push(number);
  state.currentNumber = number;
  return true;
}

export function autoMark(state: BingoState, number: number): void {
  for (const [playerId, card] of Object.entries(state.cards)) {
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        if (card[r][c] === number) {
          state.marked[playerId][r][c] = true;
        }
      }
    }
  }
}

export function checkBingo(
  state: BingoState,
  playerId: string,
): { hasBingo: true; winLine: { type: 'row' | 'col' | 'diag'; index: number } } | { hasBingo: false } {
  const m = state.marked[playerId];
  if (!m) return { hasBingo: false };

  for (let r = 0; r < 5; r++) {
    if (m[r].every(Boolean)) return { hasBingo: true, winLine: { type: 'row', index: r } };
  }
  for (let c = 0; c < 5; c++) {
    if (m.every(row => row[c])) return { hasBingo: true, winLine: { type: 'col', index: c } };
  }
  if ([0,1,2,3,4].every(i => m[i][i])) return { hasBingo: true, winLine: { type: 'diag', index: 0 } };
  if ([0,1,2,3,4].every(i => m[i][4-i])) return { hasBingo: true, winLine: { type: 'diag', index: 1 } };

  return { hasBingo: false };
}

export function replaceSocketId(state: BingoState, oldId: string, newId: string): void {
  if (oldId in state.cards) {
    state.cards[newId] = state.cards[oldId];
    delete state.cards[oldId];
  }
  if (oldId in state.marked) {
    state.marked[newId] = state.marked[oldId];
    delete state.marked[oldId];
  }
  if (state.winner === oldId) state.winner = newId;
  if (state.currentDrawer === oldId) state.currentDrawer = newId;
  if (state.tossWinner === oldId) state.tossWinner = newId;
}
