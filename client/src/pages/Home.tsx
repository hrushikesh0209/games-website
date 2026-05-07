import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSocket } from '../lib/socket';

type GameId = 'higher-or-lower' | 'tic-tac-toe' | 'bingo';
// L-8: 'joining' is a separate sentinel so the game-card loading spinners don't
// misfire when the player submits the join form.
type LoadingState = GameId | 'joining' | null;

export default function Home() {
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState<LoadingState>(null);
  const [connError, setConnError] = useState(false);
  const navigate = useNavigate();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const socket = getSocket();
    const onConnectError = () => { if (mounted.current) setConnError(true); };
    const onConnect = () => { if (mounted.current) setConnError(false); };
    socket.on('connect_error', onConnectError);
    socket.on('connect', onConnect);
    return () => {
      mounted.current = false;
      socket.off('connect_error', onConnectError);
      socket.off('connect', onConnect);
    };
  }, []);

  function clearError() { setError(''); }

  function handleCreateRoom(game: GameId) {
    if (!name.trim()) { setError('Enter your name first.'); return; }
    if (loading) return;
    setLoading(game);
    const socket = getSocket();
    socket.emit('room:create', { game, playerName: name.trim() }, (res: { roomId: string; token: string } | { error: string }) => {
      if (!mounted.current) return;
      setLoading(null);
      if ('error' in res) { setError(res.error); return; }
      sessionStorage.setItem('gameSession', JSON.stringify({ roomId: res.roomId, playerName: name.trim(), token: res.token }));
      navigate(`/room/${res.roomId}`, { state: { playerName: name.trim() } });
    });
  }

  function handleJoinRoom(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!name.trim()) { setError('Enter your name first.'); return; }
    if (joinCode.trim().length !== 6) { setError('Room code must be 6 characters.'); return; }
    if (loading) return;
    setLoading('joining');
    const socket = getSocket();
    const code = joinCode.trim().toUpperCase();
    socket.emit('room:join', { roomId: code, playerName: name.trim() }, (res: { roomId: string; token: string } | { error: string }) => {
      if (!mounted.current) return;
      setLoading(null);
      if ('error' in res) { setError(res.error); return; }
      sessionStorage.setItem('gameSession', JSON.stringify({ roomId: res.roomId, playerName: name.trim(), token: res.token }));
      navigate(`/room/${res.roomId}`, { state: { playerName: name.trim() } });
    });
  }

  const games: { id: GameId; icon: string; name: string; description: string; tags: string[] }[] = [
    {
      id: 'higher-or-lower',
      icon: '🔢',
      name: 'Higher or Lower',
      description: 'Pick a secret number (0–99). Guess your opponent\'s number before they guess yours.',
      tags: ['2 players', 'Private room', 'Voice + Chat'],
    },
    {
      id: 'tic-tac-toe',
      icon: '⭕',
      name: 'Tic Tac Toe',
      description: 'Classic 3×3 grid game. Get three in a row to win. X always goes first.',
      tags: ['2 players', 'Private room', 'Voice + Chat'],
    },
    {
      id: 'bingo',
      icon: '🎱',
      name: 'Bingo',
      description: 'Get a unique 5×5 card. Numbers are drawn every 3 seconds. First to complete a line wins!',
      tags: ['2 players', 'Auto-draw', 'Voice + Chat'],
    },
  ];

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center gap-3">
        <span className="text-2xl">🎮</span>
        <h1 className="text-xl font-bold text-indigo-400 tracking-tight">GameZone</h1>
      </header>

      {connError && (
        <div className="bg-red-950 border-b border-red-900 text-red-400 text-sm px-6 py-2 text-center">
          Cannot connect to server. Make sure the server is running.
        </div>
      )}

      <main className="max-w-4xl mx-auto px-6 py-12 flex flex-col gap-12">

        <div className="flex flex-col gap-2 max-w-xs">
          <label htmlFor="player-name" className="text-sm text-gray-400 font-medium">
            Your Name
          </label>
          <input
            id="player-name"
            value={name}
            onChange={e => { setName(e.target.value); clearError(); }}
            placeholder="Enter your name..."
            maxLength={20}
            autoComplete="off"
            className="bg-gray-900 border border-gray-700 rounded-xl px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 transition-colors"
          />
        </div>

        <section>
          <h2 className="text-lg font-semibold text-gray-400 mb-5">Games</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {games.map(game => (
              <div key={game.id} className="bg-gray-900 border border-gray-800 rounded-2xl p-6 flex flex-col gap-4 hover:border-gray-700 transition-colors">
                <div className="text-3xl">{game.icon}</div>
                <div className="flex-1">
                  <h3 className="text-base font-bold text-white">{game.name}</h3>
                  <p className="text-sm text-gray-500 mt-1 leading-relaxed">{game.description}</p>
                  <div className="flex gap-2 mt-3 flex-wrap">
                    {game.tags.map((tag, i) => (
                      <span key={i} className={`text-xs px-2 py-0.5 rounded-full ${i === 0 ? 'text-indigo-400 bg-indigo-950 border border-indigo-900' : 'text-gray-500 bg-gray-800'}`}>
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
                <button
                  onClick={() => handleCreateRoom(game.id)}
                  disabled={loading !== null}
                  className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-xl transition-colors"
                >
                  {loading === game.id ? 'Creating...' : 'Create Room'}
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="max-w-sm">
          <h2 className="text-lg font-semibold text-gray-400 mb-4">Join a Room</h2>
          <form onSubmit={handleJoinRoom} className="bg-gray-900 border border-gray-800 rounded-2xl p-5 flex flex-col gap-3">
            <p className="text-sm text-gray-500">Got a room code from a friend? Enter it below.</p>
            <div className="flex gap-2">
              <label htmlFor="join-code" className="sr-only">Room code</label>
              <input
                id="join-code"
                value={joinCode}
                onChange={e => { setJoinCode(e.target.value.toUpperCase()); clearError(); }}
                placeholder="XXXXXX"
                maxLength={6}
                autoComplete="off"
                className="bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 flex-1 text-white placeholder-gray-600 uppercase tracking-[0.2em] font-mono focus:outline-none focus:border-indigo-500 transition-colors"
              />
              <button
                type="submit"
                disabled={loading !== null}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-5 rounded-xl font-medium transition-colors"
              >
                Join
              </button>
            </div>
            {error && <p role="alert" className="text-red-400 text-sm">{error}</p>}
          </form>
        </section>

      </main>
    </div>
  );
}
