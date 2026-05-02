import { useEffect, useRef, useState } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { getSocket } from '../lib/socket';
import type { Player, ChatMsg, GuessEntry, GamePhase } from '../types';

const MAX_MESSAGES = 200;

interface TossInfo { id: string; name: string }
interface GameResult { winner: string | null; winnerName: string | null; secrets: Record<string, number> }

interface ClientGameState {
  phase: GamePhase;
  currentTurn: string | null;
  tossWinner: string | null;
  guessLog: GuessEntry[];
  mySecretSet: boolean;
  winner?: string | null;
  winnerName?: string | null;
  secrets?: Record<string, number>;
}

interface StoredSession { roomId: string; playerName: string; token: string }

function loadSession(): StoredSession | null {
  try { return JSON.parse(sessionStorage.getItem('gameSession') ?? 'null'); } catch { return null; }
}
function clearSession() { sessionStorage.removeItem('gameSession'); }

export default function Room() {
  const { roomId } = useParams<{ roomId: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  // playerName comes from router state (fresh join) or sessionStorage (page reload)
  const storedSession = loadSession();
  const playerName: string =
    (location.state as { playerName?: string })?.playerName ?? storedSession?.playerName ?? '';

  const socketRef = useRef(getSocket());
  const socket = socketRef.current;

  // ── connection ───────────────────────────────────────────────────────────────
  const [myId, setMyId] = useState<string | undefined>(() => socket.id);
  const [connError, setConnError] = useState(false);

  // ── room ─────────────────────────────────────────────────────────────────────
  const [players, setPlayers] = useState<Player[]>([]);
  const [isReady, setIsReady] = useState(false);
  const [opponentLeft, setOpponentLeft] = useState(false);
  const [opponentDisconnected, setOpponentDisconnected] = useState(false);

  // ── game ─────────────────────────────────────────────────────────────────────
  const [gamePhase, setGamePhase] = useState<GamePhase>('lobby');
  const [secretInput, setSecretInput] = useState('');
  const [secretSubmitted, setSecretSubmitted] = useState(false);
  const [tossInfo, setTossInfo] = useState<TossInfo | null>(null);
  const [currentTurn, setCurrentTurn] = useState<string | null>(null);
  const [guessInput, setGuessInput] = useState('');
  const [guessLog, setGuessLog] = useState<GuessEntry[]>([]);
  const [gameResult, setGameResult] = useState<GameResult | null>(null);

  // ── chat ─────────────────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const chatOpenRef = useRef(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // ── misc ─────────────────────────────────────────────────────────────────────
  const [copied, setCopied] = useState(false);
  const guessInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { chatOpenRef.current = chatOpen; }, [chatOpen]);

  useEffect(() => { if (!playerName) navigate('/', { replace: true }); }, [playerName, navigate]);

  // ── socket events ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playerName) return;

    const onConnect = () => {
      setMyId(socket.id);
      setConnError(false);
      socket.emit('room:request_state');
    };

    const onConnectError = () => setConnError(true);

    const onNotFound = () => {
      const session = loadSession();
      if (session && session.roomId === roomId) {
        socket.emit('room:reconnect', { roomId: session.roomId, token: session.token }, (res: { ok: true } | { error: string }) => {
          if ('error' in res) {
            clearSession();
            navigate('/', { replace: true });
          }
          // On success the server emits room:state which restores everything
        });
      } else {
        navigate('/', { replace: true });
      }
    };

    const onState = ({ players: p, gameState }: { players: Player[]; gameState: ClientGameState | null }) => {
      setPlayers(p);
      setOpponentDisconnected(false);
      if (!gameState) return;

      setGamePhase(gameState.phase);
      setSecretSubmitted(gameState.mySecretSet);
      setCurrentTurn(gameState.currentTurn);
      setGuessLog(gameState.guessLog);

      if (gameState.phase === 'toss' && gameState.tossWinner) {
        const tw = gameState.tossWinner;
        const name = p.find(pl => pl.socketId === tw)?.name ?? '';
        setTossInfo({ id: tw, name });
      }

      if (gameState.phase === 'ended' && gameState.secrets) {
        setGameResult({
          winner: gameState.winner ?? null,
          winnerName: gameState.winnerName ?? null,
          secrets: gameState.secrets,
        });
      }
    };

    const onPlayersUpdate = ({ players: p }: { players: Player[] }) => setPlayers(p);

    const onPlayerJoined = ({ player }: { player: Player }) => {
      setOpponentLeft(false);
      setPlayers(prev => prev.some(p => p.socketId === player.socketId) ? prev : [...prev, player]);
    };

    const onPlayerLeft = () => {
      setOpponentLeft(true);
      setOpponentDisconnected(false);
      setIsReady(false);
      resetGameState();
    };

    const onPlayerDisconnected = () => setOpponentDisconnected(true);
    const onPlayerReconnected = () => setOpponentDisconnected(false);

    const onChat = (msg: ChatMsg) => {
      setMessages(prev => {
        const next = [...prev, msg];
        return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
      });
      if (!chatOpenRef.current) setUnread(u => u + 1);
    };

    // ── game events ──────────────────────────────────────────────────────────
    const onGameStarting = () => setGamePhase('selecting');

    const onSecretAck = () => setSecretSubmitted(true);

    const onTossResult = ({ firstGuesser, firstName }: { firstGuesser: string; firstName: string }) => {
      setTossInfo({ id: firstGuesser, name: firstName });
      setCurrentTurn(firstGuesser);
      setGamePhase('toss');
    };

    const onGuessingStart = ({ currentTurn: ct }: { currentTurn: string }) => {
      setCurrentTurn(ct);
      setGamePhase('guessing');
    };

    const onGuessResult = ({ entry, nextTurn }: { entry: GuessEntry; nextTurn: string | null }) => {
      setGuessLog(prev => [...prev, entry]);
      setCurrentTurn(nextTurn);
    };

    const onGameEnded = (result: GameResult & { guessLog: GuessEntry[] }) => {
      setGuessLog(result.guessLog);
      setGameResult({ winner: result.winner, winnerName: result.winnerName, secrets: result.secrets });
      setGamePhase('ended');
    };

    const onGameReset = () => {
      resetGameState();
      setPlayers(prev => prev.map(p => ({ ...p, ready: false })));
    };

    socket.on('connect', onConnect);
    socket.on('connect_error', onConnectError);
    socket.on('room:not_found', onNotFound);
    socket.on('room:state', onState);
    socket.on('room:players_update', onPlayersUpdate);
    socket.on('room:player_joined', onPlayerJoined);
    socket.on('room:player_left', onPlayerLeft);
    socket.on('room:player_disconnected', onPlayerDisconnected);
    socket.on('room:player_reconnected', onPlayerReconnected);
    socket.on('chat:message', onChat);
    socket.on('game:starting', onGameStarting);
    socket.on('game:secret_ack', onSecretAck);
    socket.on('game:toss_result', onTossResult);
    socket.on('game:guessing_start', onGuessingStart);
    socket.on('game:guess_result', onGuessResult);
    socket.on('game:ended', onGameEnded);
    socket.on('game:reset', onGameReset);

    socket.emit('room:request_state');

    return () => {
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
      socket.off('room:not_found', onNotFound);
      socket.off('room:state', onState);
      socket.off('room:players_update', onPlayersUpdate);
      socket.off('room:player_joined', onPlayerJoined);
      socket.off('room:player_left', onPlayerLeft);
      socket.off('room:player_disconnected', onPlayerDisconnected);
      socket.off('room:player_reconnected', onPlayerReconnected);
      socket.off('chat:message', onChat);
      socket.off('game:starting', onGameStarting);
      socket.off('game:secret_ack', onSecretAck);
      socket.off('game:toss_result', onTossResult);
      socket.off('game:guessing_start', onGuessingStart);
      socket.off('game:guess_result', onGuessResult);
      socket.off('game:ended', onGameEnded);
      socket.off('game:reset', onGameReset);
    };
  }, [playerName, socket, navigate, roomId]);

  useEffect(() => {
    if (chatOpen) {
      setUnread(0);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
  }, [chatOpen, messages]);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);

  const isMyTurn = currentTurn === myId;
  useEffect(() => {
    if (isMyTurn && gamePhase === 'guessing') {
      guessInputRef.current?.focus();
    }
  }, [isMyTurn, gamePhase]);

  function resetGameState() {
    setGamePhase('lobby');
    setSecretInput('');
    setSecretSubmitted(false);
    setTossInfo(null);
    setCurrentTurn(null);
    setGuessInput('');
    setGuessLog([]);
    setGameResult(null);
  }

  // ── actions ───────────────────────────────────────────────────────────────────
  function handleReady() { socket.emit('game:ready'); setIsReady(true); }

  function handleSetSecret(e: React.FormEvent) {
    e.preventDefault();
    const val = parseInt(secretInput, 10);
    if (isNaN(val) || val < 0 || val > 99) return;
    socket.emit('game:set_secret', { value: val });
  }

  function handleGuess(e: React.FormEvent) {
    e.preventDefault();
    const val = parseInt(guessInput, 10);
    if (isNaN(val) || val < 0 || val > 99) return;
    socket.emit('game:guess', { value: val });
    setGuessInput('');
  }

  function handleRematch() { socket.emit('game:rematch'); }

  function handleChat(e: React.FormEvent) {
    e.preventDefault();
    const text = chatInput.trim();
    if (!text) return;
    socket.emit('chat:message', { text });
    setChatInput('');
  }

  function handleLeave() {
    clearSession();
    socket.emit('room:leave');
    navigate('/');
  }

  function copyCode() {
    navigator.clipboard.writeText(roomId ?? '').then(() => setCopied(true));
  }

  // ── derived ───────────────────────────────────────────────────────────────────
  const me = players.find(p => p.socketId === myId);
  const opponent = players.find(p => p.socketId !== myId);
  const bothReady = players.length === 2 && players.every(p => p.ready);

  // ── render ────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">

      {/* ── Header ── */}
      <header className="border-b border-gray-800 px-4 py-3 flex items-center justify-between shrink-0">
        <button onClick={handleLeave} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
          ← Leave
        </button>

        <div className="flex items-center gap-2">
          <span className="font-mono text-base font-bold text-indigo-400 tracking-[0.2em]">{roomId}</span>
          <button onClick={copyCode} className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-1 rounded-lg transition-colors">
            {copied ? '✓' : 'Copy'}
          </button>
        </div>

        <button
          onClick={() => { setChatOpen(o => !o); setUnread(0); }}
          className="relative text-sm bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-1.5 rounded-lg transition-colors"
        >
          💬 Chat
          {unread > 0 && (
            <span className="absolute -top-1 -right-1 bg-indigo-500 text-white text-xs w-4 h-4 rounded-full flex items-center justify-center">
              {unread}
            </span>
          )}
        </button>
      </header>

      {connError && (
        <div className="bg-red-950 border-b border-red-900 text-red-400 text-sm px-4 py-2 text-center">
          Connection lost. Reconnecting...
        </div>
      )}

      {opponentDisconnected && (
        <div className="bg-yellow-950 border-b border-yellow-900 text-yellow-400 text-sm px-4 py-2 text-center animate-pulse">
          Opponent disconnected. Waiting for them to reconnect (15 s)...
        </div>
      )}

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden relative">

        {/* ── Game Area ── */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8">

          {/* Players strip */}
          <div className="flex gap-3 mb-6">
            {([me, opponent] as (Player | undefined)[]).map((player, i) => (
              <div key={i} className={`flex-1 bg-gray-900 rounded-xl p-3 flex items-center gap-3 border ${player ? 'border-gray-800' : 'border-gray-800 border-dashed opacity-30'}`}>
                {player ? (
                  <>
                    <div className="w-9 h-9 rounded-full bg-indigo-800 flex items-center justify-center font-bold text-sm shrink-0">
                      {player.name[0].toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-sm text-white truncate">
                        {player.name}{player.socketId === myId && <span className="text-gray-500 font-normal"> (you)</span>}
                      </p>
                      <span className={`text-xs ${player.ready ? 'text-green-400' : 'text-gray-600'}`}>
                        {player.ready ? '✓ Ready' : 'Not ready'}
                      </span>
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-gray-600">Waiting for player...</p>
                )}
              </div>
            ))}
          </div>

          {/* ── LOBBY ── */}
          {gamePhase === 'lobby' && (
            <div className="flex flex-col items-center gap-5 pt-4">
              {opponentLeft && (
                <div className="bg-yellow-950 border border-yellow-900 text-yellow-400 text-sm px-4 py-3 rounded-xl text-center">
                  Opponent left. Waiting for someone to join...
                </div>
              )}

              {players.length < 2 && !opponentLeft ? (
                <p className="text-gray-600 text-sm">Share the room code with a friend to start.</p>
              ) : bothReady ? (
                <p className="text-green-400 font-semibold animate-pulse">Both players ready! Starting...</p>
              ) : (
                <button
                  onClick={handleReady}
                  disabled={isReady}
                  className={`px-10 py-3 rounded-xl font-semibold transition-colors ${isReady ? 'bg-green-950 text-green-400 border border-green-900 cursor-default' : 'bg-indigo-600 hover:bg-indigo-500 text-white'}`}
                >
                  {isReady ? '✓ Ready' : 'Ready Up'}
                </button>
              )}
            </div>
          )}

          {/* ── SELECTING ── */}
          {gamePhase === 'selecting' && (
            <div className="flex flex-col items-center gap-5 pt-4 max-w-sm mx-auto">
              <div className="text-center">
                <p className="text-2xl mb-1">🔒</p>
                <h3 className="text-lg font-bold text-white">Pick your secret number</h3>
                <p className="text-sm text-gray-500 mt-1">Choose a number from 0 to 99. Your opponent can't see it.</p>
              </div>
              {!secretSubmitted ? (
                <form onSubmit={handleSetSecret} className="w-full flex flex-col gap-3">
                  <input
                    type="number"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    min="0"
                    max="99"
                    value={secretInput}
                    onChange={e => setSecretInput(e.target.value)}
                    placeholder="0 – 99"
                    className="bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-center text-2xl font-bold text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 transition-colors w-full"
                  />
                  <button
                    type="submit"
                    disabled={secretInput === '' || parseInt(secretInput) < 0 || parseInt(secretInput) > 99}
                    className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl transition-colors"
                  >
                    Lock In
                  </button>
                </form>
              ) : (
                <div className="text-center bg-green-950 border border-green-900 rounded-xl px-6 py-4 w-full">
                  <p className="text-green-400 font-semibold">✓ Secret locked in!</p>
                  <p className="text-gray-500 text-sm mt-1">Waiting for opponent to pick their number...</p>
                </div>
              )}
            </div>
          )}

          {/* ── TOSS ── */}
          {gamePhase === 'toss' && (
            <div className="flex flex-col items-center gap-4 pt-8 text-center">
              <div className="text-6xl animate-bounce">🪙</div>
              <h3 className="text-xl font-bold text-white">Coin Toss!</h3>
              <p className="text-lg text-indigo-300 font-semibold">{tossInfo?.name} goes first!</p>
              {tossInfo?.id === myId
                ? <p className="text-green-400 text-sm">That's you! Get ready to guess.</p>
                : <p className="text-gray-500 text-sm">Your opponent goes first this round.</p>}
              <p className="text-xs text-gray-600 mt-2 animate-pulse">Game starting...</p>
            </div>
          )}

          {/* ── GUESSING ── */}
          {gamePhase === 'guessing' && (
            <div className="flex flex-col gap-5 max-w-lg mx-auto">
              <div className={`text-center py-3 px-4 rounded-xl font-semibold ${isMyTurn ? 'bg-green-950 border border-green-900 text-green-400' : 'bg-gray-900 border border-gray-800 text-yellow-400'}`}>
                {isMyTurn ? '🎯 Your turn — guess their number!' : `⏳ Waiting for ${opponent?.name ?? 'opponent'} to guess...`}
              </div>

              {isMyTurn && (
                <form onSubmit={handleGuess} className="flex gap-2">
                  <input
                    ref={guessInputRef}
                    type="number"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    min="0"
                    max="99"
                    value={guessInput}
                    onChange={e => setGuessInput(e.target.value)}
                    placeholder="0 – 99"
                    className="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-center text-xl font-bold text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                  <button
                    type="submit"
                    disabled={guessInput === ''}
                    className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-semibold px-5 rounded-xl transition-colors"
                  >
                    Guess
                  </button>
                </form>
              )}

              <div className="flex flex-col gap-2">
                <h4 className="text-xs text-gray-500 uppercase tracking-widest">Your Guesses</h4>
                {guessLog.filter(e => e.guesser === myId).length === 0
                  ? <p className="text-gray-700 text-sm text-center py-4">No guesses yet</p>
                  : [...guessLog].filter(e => e.guesser === myId).reverse().map(entry => (
                      <div key={entry.id} className="flex items-center gap-3 bg-gray-900 rounded-xl px-4 py-3 border border-indigo-900">
                        <span className="text-xs text-gray-500 w-16 shrink-0">You</span>
                        <span className="font-bold text-white text-lg w-10 text-center">{entry.value}</span>
                        <span className={`text-sm font-semibold ml-auto ${
                          entry.result === 'correct' ? 'text-green-400'
                          : entry.result === 'higher' ? 'text-blue-400'
                          : 'text-orange-400'
                        }`}>
                          {entry.result === 'correct' ? '✓ Correct!' : entry.result === 'higher' ? '↑ Go Higher' : '↓ Go Lower'}
                        </span>
                      </div>
                    ))
                }
              </div>
            </div>
          )}

          {/* ── ENDED ── */}
          {gamePhase === 'ended' && gameResult && (
            <div className="flex flex-col items-center gap-5 max-w-sm mx-auto text-center">
              <div className="text-5xl">
                {gameResult.winner === myId ? '🏆' : gameResult.winner === null ? '🤝' : '😔'}
              </div>
              <h3 className="text-2xl font-bold text-white">
                {gameResult.winner === myId ? 'You Win!'
                  : gameResult.winner === null ? 'Draw!'
                  : `${gameResult.winnerName} Wins!`}
              </h3>

              <div className="w-full bg-gray-900 border border-gray-800 rounded-2xl p-4 flex gap-4">
                {players.map(p => (
                  <div key={p.socketId} className="flex-1 text-center">
                    <p className="text-xs text-gray-500 mb-1">{p.socketId === myId ? 'Your' : `${p.name}'s`} secret</p>
                    <p className="text-4xl font-bold text-indigo-400">{gameResult.secrets[p.socketId] ?? '?'}</p>
                  </div>
                ))}
              </div>

              {guessLog.length > 0 && (
                <div className="w-full flex flex-col gap-1.5 max-h-56 overflow-y-auto">
                  <h4 className="text-xs text-gray-500 uppercase tracking-widest mb-1">Full Game Log</h4>
                  {guessLog.map((entry, i) => {
                    const isMine = entry.guesser === myId;
                    return (
                      <div key={entry.id} className={`flex items-center gap-3 rounded-xl px-4 py-2.5 border text-sm ${isMine ? 'bg-gray-900 border-indigo-900' : 'bg-gray-900/60 border-gray-800'}`}>
                        <span className="text-gray-600 text-xs w-5 shrink-0 text-right">{i + 1}.</span>
                        <span className={`w-16 shrink-0 text-xs font-medium ${isMine ? 'text-indigo-400' : 'text-gray-400'}`}>{isMine ? 'You' : entry.guesserName}</span>
                        <span className="font-bold text-white w-8 text-center">{entry.value}</span>
                        <span className={`ml-auto font-semibold ${entry.result === 'correct' ? 'text-green-400' : entry.result === 'higher' ? 'text-blue-400' : 'text-orange-400'}`}>
                          {entry.result === 'correct' ? '✓ Correct' : entry.result === 'higher' ? '↑ Higher' : '↓ Lower'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              <button
                onClick={handleRematch}
                className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-3 rounded-xl transition-colors"
              >
                Play Again
              </button>
            </div>
          )}
        </div>

        {/* ── Chat Panel ── */}
        {chatOpen && (
          <>
            <div className="fixed inset-0 bg-black/50 z-20 lg:hidden" onClick={() => setChatOpen(false)} />
            <div className="
              fixed bottom-0 left-0 right-0 h-[60vh]
              lg:static lg:h-auto lg:w-72
              bg-gray-900 border-t border-gray-800
              lg:border-t-0 lg:border-l
              flex flex-col z-30
              rounded-t-2xl lg:rounded-none
            ">
              <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between shrink-0">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-widest">Chat</h3>
                <button onClick={() => setChatOpen(false)} className="text-gray-600 hover:text-gray-300 transition-colors text-lg leading-none">×</button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2" role="log" aria-live="polite">
                {messages.length === 0 && (
                  <p className="text-xs text-gray-700 text-center mt-6">No messages yet</p>
                )}
                {messages.map(msg => (
                  <div key={msg.id} className="text-sm break-words">
                    <span className="font-semibold text-indigo-400">{msg.sender}</span>
                    <span className="text-gray-500">: </span>
                    <span className="text-gray-300">{msg.text}</span>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
              <form onSubmit={handleChat} className="p-3 border-t border-gray-800 flex gap-2 shrink-0">
                <label htmlFor="chat-input" className="sr-only">Message</label>
                <input
                  id="chat-input"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  placeholder="Message..."
                  maxLength={300}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-600 transition-colors min-w-0"
                />
                <button type="submit" className="bg-indigo-600 hover:bg-indigo-500 text-white px-3 rounded-lg text-sm transition-colors shrink-0">
                  →
                </button>
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
