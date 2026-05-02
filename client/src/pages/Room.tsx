import { useEffect, useRef, useState } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { getSocket } from '../lib/socket';
import type { Player, ChatMsg } from '../types';

const MAX_MESSAGES = 200;

export default function Room() {
  const { roomId } = useParams<{ roomId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const playerName: string = (location.state as { playerName?: string })?.playerName ?? '';

  // Stable socket reference — does not change across renders
  const socketRef = useRef(getSocket());
  const socket = socketRef.current;

  // socket.id is undefined until the handshake completes
  const [myId, setMyId] = useState<string | undefined>(() => socket.id);
  const [players, setPlayers] = useState<Player[]>([]);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isReady, setIsReady] = useState(false);
  const [gameStarting, setGameStarting] = useState(false);
  const [opponentLeft, setOpponentLeft] = useState(false);
  const [connError, setConnError] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Redirect to home on direct URL access (no playerName in navigation state)
  useEffect(() => {
    if (!playerName) navigate('/', { replace: true });
  }, [playerName, navigate]);

  useEffect(() => {
    if (!playerName) return;

    // ── handler references so socket.off removes exactly the right listener ──
    const onConnect = () => { setMyId(socket.id); setConnError(false); };
    const onConnectError = () => setConnError(true);

    const onState = ({ players: p }: { players: Player[] }) => setPlayers(p);
    const onPlayersUpdate = ({ players: p }: { players: Player[] }) => setPlayers(p);

    const onPlayerJoined = ({ player }: { player: Player }) => {
      setOpponentLeft(false);
      setPlayers(prev =>
        prev.some(p => p.socketId === player.socketId) ? prev : [...prev, player],
      );
    };

    const onPlayerLeft = () => {
      setOpponentLeft(true);
      setIsReady(false);
      setGameStarting(false);
    };

    const onChatMessage = (msg: ChatMsg) => {
      setMessages(prev => {
        const next = [...prev, msg];
        // Bounded: keep only the latest MAX_MESSAGES entries
        return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
      });
    };

    const onGameStarting = () => setGameStarting(true);

    socket.on('connect', onConnect);
    socket.on('connect_error', onConnectError);
    socket.on('room:state', onState);
    socket.on('room:players_update', onPlayersUpdate);
    socket.on('room:player_joined', onPlayerJoined);
    socket.on('room:player_left', onPlayerLeft);
    socket.on('chat:message', onChatMessage);
    socket.on('game:starting', onGameStarting);

    socket.emit('room:request_state');

    return () => {
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
      socket.off('room:state', onState);
      socket.off('room:players_update', onPlayersUpdate);
      socket.off('room:player_joined', onPlayerJoined);
      socket.off('room:player_left', onPlayerLeft);
      socket.off('chat:message', onChatMessage);
      socket.off('game:starting', onGameStarting);
    };
  }, [playerName, socket]);

  // Auto-scroll chat to bottom on new message
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── copy-to-clipboard with proper timeout cleanup ──────────────────────────
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);

  function copyCode() {
    navigator.clipboard.writeText(roomId ?? '').then(() => setCopied(true));
  }

  function handleReady() {
    socket.emit('game:ready');
    setIsReady(true);
  }

  function handleChat(e: React.FormEvent) {
    e.preventDefault();
    const text = chatInput.trim();
    if (!text) return;
    socket.emit('chat:message', { text });
    setChatInput('');
  }

  function handleLeave() {
    socket.emit('room:leave');
    navigate('/');
  }

  const me = players.find(p => p.socketId === myId);
  const opponent = players.find(p => p.socketId !== myId);
  const bothReady = players.length === 2 && players.every(p => p.ready);

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">

      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-3 flex items-center justify-between shrink-0">
        <button
          onClick={handleLeave}
          className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
        >
          ← Leave
        </button>

        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500 uppercase tracking-wide">Room</span>
          <span className="font-mono text-lg font-bold text-indigo-400 tracking-[0.25em]">{roomId}</span>
          <button
            onClick={copyCode}
            className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-1 rounded-lg transition-colors"
          >
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>

        <div className="w-20" />
      </header>

      {connError && (
        <div className="bg-red-950 border-b border-red-900 text-red-400 text-sm px-6 py-2 text-center">
          Connection lost. Trying to reconnect...
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">

        {/* Game area */}
        <div className="flex-1 flex flex-col p-8 gap-8 overflow-y-auto">
          <div>
            <h2 className="text-base font-semibold text-gray-400 uppercase tracking-wide mb-6">
              Higher or Lower
            </h2>

            {/* Player cards */}
            <div className="flex gap-4 flex-wrap">
              {([me, opponent] as (Player | undefined)[]).map((player, i) => (
                <div
                  key={i}
                  className={`flex-1 min-w-48 max-w-xs bg-gray-900 rounded-2xl p-5 flex flex-col items-center gap-3 border transition-colors ${
                    player ? 'border-gray-800' : 'border-gray-800 border-dashed opacity-30'
                  }`}
                >
                  {player ? (
                    <>
                      <div className="w-14 h-14 rounded-full bg-indigo-800 flex items-center justify-center text-xl font-bold text-indigo-200">
                        {player.name[0].toUpperCase()}
                      </div>
                      <div className="text-center">
                        <p className="font-semibold text-white text-sm">{player.name}</p>
                        {player.socketId === myId && (
                          <p className="text-xs text-gray-500 mt-0.5">you</p>
                        )}
                      </div>
                      <span className={`text-xs px-3 py-1 rounded-full font-medium ${
                        player.ready
                          ? 'bg-green-950 text-green-400 border border-green-900'
                          : 'bg-gray-800 text-gray-500'
                      }`}>
                        {player.ready ? '✓ Ready' : 'Not ready'}
                      </span>
                    </>
                  ) : (
                    <>
                      <div className="w-14 h-14 rounded-full bg-gray-800 flex items-center justify-center text-gray-600 text-xl">?</div>
                      <p className="text-xs text-gray-600">Waiting for player...</p>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Status / action area */}
          <div className="flex flex-col items-center gap-4">
            {opponentLeft && (
              <div className="bg-yellow-950 border border-yellow-900 text-yellow-400 text-sm px-5 py-3 rounded-xl">
                Your opponent left. Waiting for someone to join...
              </div>
            )}

            {gameStarting ? (
              <div className="text-center">
                <p className="text-green-400 font-semibold text-lg">Both players ready!</p>
                <p className="text-gray-500 text-sm mt-1">Game starts soon...</p>
              </div>
            ) : players.length < 2 && !opponentLeft ? (
              <p className="text-gray-600 text-sm">Share the room code with a friend to start.</p>
            ) : !opponentLeft && !bothReady ? (
              <button
                onClick={handleReady}
                disabled={isReady}
                className={`px-10 py-3 rounded-xl font-semibold text-base transition-colors ${
                  isReady
                    ? 'bg-green-950 text-green-400 border border-green-900 cursor-default'
                    : 'bg-indigo-600 hover:bg-indigo-500 text-white'
                }`}
              >
                {isReady ? '✓ Ready' : 'Ready Up'}
              </button>
            ) : null}
          </div>
        </div>

        {/* Chat sidebar */}
        <aside className="w-72 border-l border-gray-800 flex flex-col shrink-0">
          <div className="px-4 py-3 border-b border-gray-800 shrink-0">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-widest">Chat</h3>
          </div>

          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2" role="log" aria-live="polite">
            {messages.length === 0 && (
              <p className="text-xs text-gray-700 text-center mt-6">No messages yet</p>
            )}
            {messages.map(msg => (
              // Use stable msg.id from server — not array index
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
              className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-600 transition-colors min-w-0"
            />
            <button
              type="submit"
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-3 rounded-lg text-sm transition-colors shrink-0"
            >
              →
            </button>
          </form>
        </aside>

      </div>
    </div>
  );
}
