import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { getSocket } from '../lib/socket';
import type { Player, ChatMsg, GuessEntry, GamePhase } from '../types';

const MAX_MESSAGES = 200;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

interface TossInfo { id: string; name: string }
interface GameResult { winner: string | null; winnerName: string | null; secrets: Record<string, number> }

interface TTTState {
  board: (string | null)[];
  marks: Record<string, 'X' | 'O'>;
  currentTurn: string | null;
  winner: string | null;
  winnerName: string | null;
  winLine: number[] | null;
}

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

// M-4: extracted outside the parent so React can memoise it and avoids
// unmounting the component on every parent render.
interface RematchControlsProps {
  rematchVoted: boolean;
  rematchPending: boolean;
  onRematch: () => void;
}
function RematchControls({ rematchVoted, rematchPending, onRematch }: RematchControlsProps) {
  if (rematchVoted) {
    return (
      <div className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-center text-gray-400 text-sm">
        Waiting for opponent...
      </div>
    );
  }
  return (
    <div className="w-full flex flex-col gap-2">
      {rematchPending && (
        <div className="bg-indigo-950 border border-indigo-700 text-indigo-300 text-sm px-4 py-2.5 rounded-xl text-center font-medium">
          Opponent wants to play again!
        </div>
      )}
      <button
        onClick={onRematch}
        className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-3 rounded-xl transition-colors"
      >
        Play Again
      </button>
    </div>
  );
}

function loadSession(): StoredSession | null {
  try { return JSON.parse(sessionStorage.getItem('gameSession') ?? 'null'); } catch { return null; }
}
function clearSession() { sessionStorage.removeItem('gameSession'); }

// L-7: mirrors server-side checkBingo in bingo.ts — keep both in sync if win
// conditions ever change.
function checkClientBingo(marked: boolean[][]): boolean {
  for (let r = 0; r < 5; r++) {
    if (marked[r].every(Boolean)) return true;
  }
  for (let c = 0; c < 5; c++) {
    if (marked.every(row => row[c])) return true;
  }
  if ([0,1,2,3,4].every(i => marked[i][i])) return true;
  if ([0,1,2,3,4].every(i => marked[i][4-i])) return true;
  return false;
}

export default function Room() {
  const { roomId } = useParams<{ roomId: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  const storedSession = loadSession();
  const playerName: string =
    (location.state as { playerName?: string })?.playerName ?? storedSession?.playerName ?? '';

  const socketRef = useRef(getSocket());
  const socket = socketRef.current;

  // ── connection ───────────────────────────────────────────────────────────────
  const [myId, setMyId] = useState<string | undefined>(() => socket.id);
  const myIdRef = useRef<string | undefined>(socket.id);
  const [connError, setConnError] = useState(false);

  // ── room ─────────────────────────────────────────────────────────────────────
  const [roomGame, setRoomGame] = useState('');
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

  // ── rematch vote ─────────────────────────────────────────────────────────────
  const [rematchVoted, setRematchVoted] = useState(false);
  const [rematchPending, setRematchPending] = useState(false);

  // ── tic-tac-toe ──────────────────────────────────────────────────────────────
  const [tttState, setTttState] = useState<TTTState | null>(null);

  // ── bingo ─────────────────────────────────────────────────────────────────────
  const [bingoCard, setBingoCard] = useState<(number | 'FREE')[][] | null>(null);
  const [bingoMarked, setBingoMarked] = useState<boolean[][] | null>(null);
  const [bingoDrawn, setBingoDrawn] = useState<number[]>([]);
  const [bingoCurrent, setBingoCurrent] = useState<number | null>(null);
  const [bingoAvailable, setBingoAvailable] = useState<number[]>([]);
  const [bingoCurrentDrawer, setBingoCurrentDrawer] = useState<string | null>(null);

  // ── voice ─────────────────────────────────────────────────────────────────────
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const pendingOfferRef = useRef<RTCSessionDescriptionInit | null>(null);
  const [voiceState, setVoiceState] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [isMuted, setIsMuted] = useState(false);

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
  useEffect(() => { myIdRef.current = myId; }, [myId]);

  // ── voice functions ───────────────────────────────────────────────────────────
  function stopVoice() {
    peerRef.current?.close();
    peerRef.current = null;
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    localStreamRef.current = null;
    setVoiceState('idle');
    setIsMuted(false);
  }

  async function startVoice() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStreamRef.current = stream;

      const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      peerRef.current = peer;

      stream.getTracks().forEach(track => peer.addTrack(track, stream));

      peer.ontrack = (e) => {
        if (remoteAudioRef.current) remoteAudioRef.current.srcObject = e.streams[0];
      };
      peer.onicecandidate = (e) => {
        if (e.candidate) socket.emit('voice:ice', { candidate: e.candidate });
      };
      peer.onconnectionstatechange = () => {
        const s = peer.connectionState;
        if (s === 'connected') setVoiceState('connected');
        else if (s === 'failed' || s === 'disconnected' || s === 'closed') setVoiceState('error');
      };

      setVoiceState('connecting');

      // H-4: guard against players array not yet populated before determining the offerer role.
      const firstPlayerId = players[0]?.socketId;
      if (!firstPlayerId) {
        // Role will be determined when the offer arrives via onVoiceOffer.
        return;
      }

      if (myIdRef.current === firstPlayerId) {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socket.emit('voice:offer', { sdp: offer });
      } else if (pendingOfferRef.current) {
        const buffered = pendingOfferRef.current;
        pendingOfferRef.current = null;
        await peer.setRemoteDescription(new RTCSessionDescription(buffered));
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        socket.emit('voice:answer', { sdp: answer });
      }
      // else: peer is ready and waiting — onVoiceOffer will handle the offer when it arrives.
    } catch {
      stopVoice();
      setVoiceState('error');
    }
  }

  function toggleMute() {
    const tracks = localStreamRef.current?.getAudioTracks();
    if (!tracks?.[0]) return;
    tracks[0].enabled = !tracks[0].enabled;
    setIsMuted(!tracks[0].enabled);
  }

  // ── reset ─────────────────────────────────────────────────────────────────────
  function resetGameState() {
    setGamePhase('lobby');
    setSecretInput('');
    setSecretSubmitted(false);
    setTossInfo(null);
    setCurrentTurn(null);
    setGuessInput('');
    setGuessLog([]);
    setGameResult(null);
    setRematchVoted(false);
    setRematchPending(false);
    setTttState(null);
    setBingoCard(null);
    setBingoMarked(null);
    setBingoDrawn([]);
    setBingoCurrent(null);
    setBingoAvailable([]);
    setBingoCurrentDrawer(null);
  }

  // ── socket events ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playerName) return;

    const onConnect = () => {
      setMyId(socket.id);
      myIdRef.current = socket.id;
      setConnError(false);
      socket.emit('room:request_state');
    };

    const onConnectError = () => setConnError(true);

    const onNotFound = () => {
      const session = loadSession();
      if (session && session.roomId === roomId) {
        socket.emit('room:reconnect', { roomId: session.roomId, token: session.token }, (res: { ok: true } | { error: string }) => {
          if ('error' in res) { clearSession(); navigate('/', { replace: true }); }
        });
      } else {
        navigate('/', { replace: true });
      }
    };

    const onState = ({
      room: r,
      players: p,
      gameState,
    }: {
      room?: { id: string; game: string };
      players: Player[];
      gameState: ClientGameState | null;
    }) => {
      if (r?.game) setRoomGame(r.game);
      setPlayers(p);
      // M-1: derive isReady from the authoritative server player list so that
      // reconnecting players don't see a stale "Ready Up" button.
      setIsReady(p.some(pl => pl.socketId === socket.id && pl.ready));
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

    const onPlayersUpdate = ({ players: p }: { players: Player[] }) => {
      setPlayers(p);
      // M-1: keep isReady in sync with server state on every player list update.
      setIsReady(p.some(pl => pl.socketId === socket.id && pl.ready));
    };

    const onPlayerJoined = ({ player }: { player: Player }) => {
      setOpponentLeft(false);
      setPlayers(prev => prev.some(p => p.socketId === player.socketId) ? prev : [...prev, player]);
    };

    const onPlayerLeft = () => {
      stopVoice();
      setOpponentLeft(true);
      setOpponentDisconnected(false);
      setIsReady(false);
      resetGameState();
    };

    const onPlayerDisconnected = () => {
      stopVoice();
      setOpponentDisconnected(true);
    };

    const onPlayerReconnected = () => setOpponentDisconnected(false);

    const onChat = (msg: ChatMsg) => {
      setMessages(prev => {
        const next = [...prev, msg];
        return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
      });
      if (!chatOpenRef.current) setUnread(u => u + 1);
    };

    // ── HoL game events ───────────────────────────────────────────────────────
    const onGameStarting = () => { setRoomGame('higher-or-lower'); setGamePhase('selecting'); };

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

    const onGameEnded = (result: {
      winner: string | null;
      winnerName: string | null;
      secrets?: Record<string, number>;
      guessLog?: GuessEntry[];
    }) => {
      if (result.guessLog) setGuessLog(result.guessLog);
      setGameResult({
        winner: result.winner,
        winnerName: result.winnerName,
        secrets: result.secrets ?? {},
      });
      setGamePhase(prev => {
        if (prev === 'ttt_playing' || prev === 'bingo_playing') return prev;
        return 'ended';
      });
    };

    const onGameReset = () => {
      resetGameState();
      setIsReady(false);
      setPlayers(prev => prev.map(p => ({ ...p, ready: false })));
    };

    // ── rematch vote ──────────────────────────────────────────────────────────
    const onRematchPending = () => setRematchPending(true);
    const onRematchCancelled = () => {
      setRematchVoted(false);
      setRematchPending(false);
    };

    // ── TTT events ────────────────────────────────────────────────────────────
    const onTTTStart = (data: TTTState & { phase: string }) => {
      setRoomGame('tic-tac-toe');
      setTttState({
        board: data.board,
        marks: data.marks,
        currentTurn: data.currentTurn,
        winner: data.winner,
        winnerName: data.winnerName,
        winLine: data.winLine,
      });
      setGamePhase('ttt_playing');
    };

    const onTTTUpdate = (data: Partial<TTTState>) => {
      setTttState(prev => (prev ? { ...prev, ...data } : null));
    };

    // ── Bingo events ──────────────────────────────────────────────────────────
    const onBingoInit = (data: {
      card: (number | 'FREE')[][];
      marked: boolean[][];
      drawn: number[];
      available: number[];
      currentDrawer: string | null;
      currentNumber: number | null;   // H-3: restored on reconnect
    }) => {
      setRoomGame('bingo');
      setBingoCard(data.card);
      setBingoMarked(data.marked);
      setBingoDrawn(data.drawn);
      setBingoCurrent(data.currentNumber);   // H-3: was always null before
      setBingoAvailable(data.available);
      setBingoCurrentDrawer(data.currentDrawer);
      setGamePhase('bingo_playing');
    };

    const onBingoDrawn = (data: {
      number: number;
      drawn: number[];
      available: number[];
      marked: boolean[][];          // C-1: server now sends only this player's grid
      currentDrawer: string | null;
    }) => {
      setBingoDrawn(data.drawn);
      setBingoCurrent(data.number);
      setBingoAvailable(data.available);
      setBingoCurrentDrawer(data.currentDrawer);
      setBingoMarked(data.marked);  // C-1: direct assignment, no id lookup needed
    };

    // ── voice events ──────────────────────────────────────────────────────────
    const onVoiceOffer = async ({ sdp }: { sdp: RTCSessionDescriptionInit }) => {
      if (!peerRef.current) { pendingOfferRef.current = sdp; return; }
      try {
        await peerRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await peerRef.current.createAnswer();
        await peerRef.current.setLocalDescription(answer);
        socket.emit('voice:answer', { sdp: answer });
      } catch { /* ignore */ }
    };

    const onVoiceAnswer = async ({ sdp }: { sdp: RTCSessionDescriptionInit }) => {
      if (!peerRef.current) return;
      try { await peerRef.current.setRemoteDescription(new RTCSessionDescription(sdp)); } catch { /* ignore */ }
    };

    const onVoiceIce = async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
      if (!peerRef.current) return;
      try { await peerRef.current.addIceCandidate(new RTCIceCandidate(candidate)); } catch { /* ignore */ }
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
    socket.on('game:rematch_pending', onRematchPending);
    socket.on('game:rematch_cancelled', onRematchCancelled);
    socket.on('game:ttt_start', onTTTStart);
    socket.on('game:ttt_update', onTTTUpdate);
    socket.on('game:bingo_init', onBingoInit);
    socket.on('game:bingo_drawn', onBingoDrawn);
    socket.on('voice:offer', onVoiceOffer);
    socket.on('voice:answer', onVoiceAnswer);
    socket.on('voice:ice', onVoiceIce);

    // M-5: only emit if already connected; onConnect handles the not-yet-connected case.
    if (socket.connected) socket.emit('room:request_state');

    return () => {
      stopVoice();
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
      socket.off('game:rematch_pending', onRematchPending);
      socket.off('game:rematch_cancelled', onRematchCancelled);
      socket.off('game:ttt_start', onTTTStart);
      socket.off('game:ttt_update', onTTTUpdate);
      socket.off('game:bingo_init', onBingoInit);
      socket.off('game:bingo_drawn', onBingoDrawn);
      socket.off('voice:offer', onVoiceOffer);
      socket.off('voice:answer', onVoiceAnswer);
      socket.off('voice:ice', onVoiceIce);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (isMyTurn && gamePhase === 'guessing') guessInputRef.current?.focus();
  }, [isMyTurn, gamePhase]);

  // ── actions ───────────────────────────────────────────────────────────────────
  function handleReady() { socket.emit('game:ready'); setIsReady(true); }

  function handleSetSecret(e: { preventDefault(): void }) {
    e.preventDefault();
    const val = parseInt(secretInput, 10);
    if (isNaN(val) || val < 0 || val > 99) return;
    socket.emit('game:set_secret', { value: val });
  }

  function handleGuess(e: { preventDefault(): void }) {
    e.preventDefault();
    const val = parseInt(guessInput, 10);
    if (isNaN(val) || val < 0 || val > 99) return;
    socket.emit('game:guess', { value: val });
    setGuessInput('');
  }

  function handleRematch() {
    if (rematchVoted) return;
    socket.emit('game:rematch');
    setRematchVoted(true);
  }

  function handleTTTMove(cell: number) {
    if (!tttState || tttState.winner !== null) return;
    if (tttState.currentTurn !== myId) return;
    if (tttState.board[cell] !== null) return;
    socket.emit('game:ttt_move', { cell });
  }

  function handleBingoDraw(number: number) {
    socket.emit('game:bingo_draw', { number });
  }

  function handleBingoClaim() { socket.emit('game:bingo_claim'); }

  function handleChat(e: { preventDefault(): void }) {
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
  const canClaimBingo = bingoMarked !== null && checkClientBingo(bingoMarked);
  const isMyDrawTurn = bingoCurrentDrawer === myId;
  // L-1: memoised so it is not rebuilt on every render (e.g. chat messages, cursor).
  const availableSet = useMemo(() => new Set(bingoAvailable), [bingoAvailable]);

  // Toss message depends on which game we're in
  const tossSubMessage = (() => {
    if (tossInfo?.id !== myId) return 'Your opponent goes first this round.';
    if (roomGame === 'bingo') return "That's you! Pick the first number.";
    if (roomGame === 'tic-tac-toe') return "That's you! You play as X.";
    return "That's you! Get ready to guess.";
  })();

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

      {/* ── Voice Controls Bar ── */}
      {players.length === 2 && (
        <div className="border-b border-gray-800 px-4 py-2 flex items-center gap-3 bg-gray-900/50">
          {voiceState === 'idle' && (
            <button onClick={startVoice} className="flex items-center gap-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-1.5 rounded-lg transition-colors">
              🎙 Start Voice
            </button>
          )}
          {voiceState === 'connecting' && (
            <span className="text-xs text-gray-500 flex items-center gap-1.5">
              <span className="animate-spin inline-block">⟳</span> Connecting...
            </span>
          )}
          {voiceState === 'connected' && (
            <>
              <span className="text-xs text-green-400">🟢 Voice on</span>
              <button
                onClick={toggleMute}
                className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${isMuted ? 'bg-red-900 text-red-300 hover:bg-red-800' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
              >
                {isMuted ? '🔇 Unmute' : '🔊 Mute'}
              </button>
              <button onClick={stopVoice} className="text-xs bg-red-950 hover:bg-red-900 text-red-400 px-3 py-1.5 rounded-lg transition-colors">
                End Call
              </button>
            </>
          )}
          {voiceState === 'error' && (
            <>
              <span className="text-xs text-red-400">Voice failed</span>
              <button onClick={() => { stopVoice(); setTimeout(startVoice, 100); }} className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-1.5 rounded-lg transition-colors">
                Retry
              </button>
            </>
          )}
        </div>
      )}

      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden relative">
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

          {/* ── SELECTING (Higher or Lower) ── */}
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

          {/* ── TOSS (all games) ── */}
          {gamePhase === 'toss' && (
            <div className="flex flex-col items-center gap-4 pt-8 text-center">
              <div className="text-6xl animate-bounce">🪙</div>
              <h3 className="text-xl font-bold text-white">Coin Toss!</h3>
              <p className="text-lg text-indigo-300 font-semibold">{tossInfo?.name} goes first!</p>
              <p className={`text-sm ${tossInfo?.id === myId ? 'text-green-400' : 'text-gray-500'}`}>
                {tossSubMessage}
              </p>
              <p className="text-xs text-gray-600 mt-2 animate-pulse">Game starting...</p>
            </div>
          )}

          {/* ── GUESSING (Higher or Lower) ── */}
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
                        <span className={`text-sm font-semibold ml-auto ${entry.result === 'correct' ? 'text-green-400' : entry.result === 'higher' ? 'text-blue-400' : 'text-orange-400'}`}>
                          {entry.result === 'correct' ? '✓ Correct!' : entry.result === 'higher' ? '↑ Go Higher' : '↓ Go Lower'}
                        </span>
                      </div>
                    ))
                }
              </div>
            </div>
          )}

          {/* ── ENDED (Higher or Lower) ── */}
          {gamePhase === 'ended' && gameResult && (
            <div className="flex flex-col items-center gap-5 max-w-sm mx-auto text-center">
              <div className="text-5xl">
                {gameResult.winner === myId ? '🏆' : gameResult.winner === null ? '🤝' : '😔'}
              </div>
              <h3 className="text-2xl font-bold text-white">
                {gameResult.winner === myId ? 'You Win!' : gameResult.winner === null ? 'Draw!' : `${gameResult.winnerName} Wins!`}
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
              <RematchControls rematchVoted={rematchVoted} rematchPending={rematchPending} onRematch={handleRematch} />
            </div>
          )}

          {/* ── TIC TAC TOE ── */}
          {gamePhase === 'ttt_playing' && tttState && (
            <div className="flex flex-col items-center gap-5 max-w-sm mx-auto">
              {tttState.winner === null && (
                <div className={`w-full text-center py-2.5 px-4 rounded-xl font-semibold text-sm ${tttState.currentTurn === myId ? 'bg-green-950 border border-green-900 text-green-400' : 'bg-gray-900 border border-gray-800 text-yellow-400'}`}>
                  {tttState.currentTurn === myId
                    ? `🎯 Your turn (${tttState.marks[myId ?? ''] ?? ''})`
                    : `⏳ Opponent's turn (${tttState.marks[opponent?.socketId ?? ''] ?? ''})`}
                </div>
              )}

              <div className="relative w-full">
                <div className="grid grid-cols-3 gap-2 w-full">
                  {tttState.board.map((cell, i) => {
                    const symbol = cell ? tttState.marks[cell] : null;
                    const isWinCell = tttState.winLine?.includes(i) ?? false;
                    const canClick = tttState.winner === null && tttState.currentTurn === myId && !cell;
                    return (
                      <button
                        key={i}
                        onClick={() => canClick && handleTTTMove(i)}
                        disabled={!canClick}
                        className={`
                          aspect-square min-h-20 rounded-xl text-4xl font-bold border-2 transition-colors
                          ${isWinCell ? 'bg-green-900 border-green-500' : 'bg-gray-900 border-gray-800'}
                          ${canClick ? 'hover:bg-gray-800 cursor-pointer' : 'cursor-default'}
                          ${symbol === 'X' ? 'text-indigo-400' : symbol === 'O' ? 'text-orange-400' : ''}
                        `}
                      >
                        {symbol ?? ''}
                      </button>
                    );
                  })}
                </div>
                {tttState.winner !== null && (
                  <div className="absolute inset-0 bg-gray-950/80 backdrop-blur-sm rounded-xl flex flex-col items-center justify-center gap-4 p-6">
                    <div className="text-5xl">
                      {tttState.winner === 'draw' ? '🤝' : tttState.winner === myId ? '🏆' : '😔'}
                    </div>
                    <p className="text-2xl font-bold text-white">
                      {tttState.winner === 'draw' ? 'Draw!' : tttState.winner === myId ? 'You Win!' : 'Opponent Wins!'}
                    </p>
                    <RematchControls rematchVoted={rematchVoted} rematchPending={rematchPending} onRematch={handleRematch} />
                  </div>
                )}
              </div>

              <div className="flex gap-6 text-sm text-gray-500">
                {players.map(p => (
                  <span key={p.socketId}>
                    <span className={tttState.marks[p.socketId] === 'X' ? 'text-indigo-400 font-bold' : 'text-orange-400 font-bold'}>
                      {tttState.marks[p.socketId]}
                    </span>
                    {' '}{p.socketId === myId ? '(you)' : p.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* ── BINGO ── */}
          {gamePhase === 'bingo_playing' && bingoCard && (
            <div className="flex flex-col gap-5">

              {/* Turn banner */}
              {gameResult === null && (
                <div className={`text-center py-2.5 px-4 rounded-xl font-semibold text-sm ${isMyDrawTurn ? 'bg-green-950 border border-green-900 text-green-400' : 'bg-gray-900 border border-gray-800 text-yellow-400'}`}>
                  {isMyDrawTurn
                    ? '🎱 Your turn — pick a number from the grid below!'
                    : `⏳ Waiting for ${opponent?.name ?? 'opponent'} to pick a number...`}
                </div>
              )}

              <div className="flex flex-col lg:flex-row gap-5">

                {/* Left: My card */}
                <div className="flex flex-col gap-2 flex-shrink-0">
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest text-center">Your Card</h3>
                  <div className="grid grid-cols-5 gap-0.5">
                    {['B','I','N','G','O'].map(col => (
                      <div key={col} className="text-center font-bold text-indigo-400 py-1 text-sm">{col}</div>
                    ))}
                    {bingoCard.flatMap((row, r) =>
                      row.map((cell, c) => {
                        const isMarked = bingoMarked?.[r][c] ?? false;
                        const isFree = cell === 'FREE';
                        const isCurrent = typeof cell === 'number' && cell === bingoCurrent;
                        return (
                          <div
                            key={`${r}-${c}`}
                            className={`
                              aspect-square flex items-center justify-center text-xs font-bold rounded
                              ${isFree ? 'bg-indigo-700 text-white'
                                : isMarked ? 'bg-green-800 text-white'
                                : isCurrent ? 'bg-yellow-900 text-yellow-200 ring-1 ring-yellow-500'
                                : 'bg-gray-900 text-gray-300'}
                            `}
                          >
                            {isFree ? '★' : cell}
                          </div>
                        );
                      })
                    )}
                  </div>

                  {/* Claim button */}
                  <button
                    onClick={handleBingoClaim}
                    disabled={!canClaimBingo || gameResult !== null}
                    className="mt-1 w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-2.5 rounded-xl transition-colors text-base tracking-widest"
                  >
                    BINGO!
                  </button>

                  {/* Result overlay */}
                  {gameResult !== null && (
                    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center flex flex-col gap-3">
                      <div className="text-4xl">
                        {gameResult.winner === myId ? '🏆' : gameResult.winner === 'draw' ? '🤝' : '😔'}
                      </div>
                      <p className="text-xl font-bold text-white">
                        {gameResult.winner === myId ? 'You called BINGO!'
                          : gameResult.winner === 'draw' ? 'No winner — all numbers drawn!'
                          : `${gameResult.winnerName} called BINGO!`}
                      </p>
                      <RematchControls rematchVoted={rematchVoted} rematchPending={rematchPending} onRematch={handleRematch} />
                    </div>
                  )}
                </div>

                {/* Right: Number picker / drawn tracker */}
                <div className="flex flex-col gap-3 flex-1">
                  {/* Last drawn + count */}
                  <div className="flex items-center gap-3">
                    <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-2 text-center min-w-20">
                      <p className="text-xs text-gray-500">Last drawn</p>
                      <p className="text-3xl font-bold text-indigo-400">{bingoCurrent ?? '—'}</p>
                    </div>
                    <p className="text-sm text-gray-500">{bingoDrawn.length} / 75 drawn</p>
                  </div>

                  {/* Number picker grid — 5 columns (B,I,N,G,O) × 15 rows */}
                  <div>
                    <p className="text-xs text-gray-500 mb-1">
                      {isMyDrawTurn && gameResult === null ? 'Click a number to draw it' : 'Numbers drawn so far'}
                    </p>
                    <div className="grid grid-cols-5 gap-x-2 gap-y-1">
                      {/* Column headers */}
                      {['B','I','N','G','O'].map(col => (
                        <div key={col} className="text-center text-xs font-bold text-indigo-400 py-0.5">{col}</div>
                      ))}
                      {/* Number cells — rendered column by column, 15 rows deep */}
                      {Array.from({ length: 15 }, (_, row) =>
                        [0,1,2,3,4].map(col => {
                          const num = col * 15 + row + 1;
                          const isAvail = availableSet.has(num);
                          const isDrawn = !isAvail;
                          const isCurr = num === bingoCurrent;
                          const clickable = isMyDrawTurn && isAvail && gameResult === null;
                          return (
                            <button
                              key={num}
                              onClick={() => clickable && handleBingoDraw(num)}
                              disabled={!clickable}
                              title={`${num}`}
                              className={`
                                h-8 rounded text-xs font-bold transition-colors
                                ${isCurr ? 'bg-yellow-600 text-white ring-2 ring-yellow-400'
                                  : isDrawn ? 'bg-gray-800 text-gray-600 line-through cursor-default'
                                  : clickable ? 'bg-indigo-700 hover:bg-indigo-500 text-white cursor-pointer'
                                  : 'bg-gray-800 text-gray-500 cursor-default'}
                              `}
                            >
                              {num}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              </div>
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
                {messages.length === 0 && <p className="text-xs text-gray-700 text-center mt-6">No messages yet</p>}
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
                <button type="submit" className="bg-indigo-600 hover:bg-indigo-500 text-white px-3 rounded-lg text-sm transition-colors shrink-0">→</button>
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
