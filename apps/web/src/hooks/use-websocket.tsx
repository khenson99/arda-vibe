import * as React from 'react';
import { io, type Socket } from 'socket.io-client';
import { readStoredSession } from '@/lib/api-client';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

interface WebSocketContextValue {
  status: ConnectionStatus;
  socket: Socket | null;
  /** Last event ID received — passed on reconnect for replay */
  lastEventId: string | null;
}

const WebSocketContext = React.createContext<WebSocketContextValue>({
  status: 'disconnected',
  socket: null,
  lastEventId: null,
});

export function useWebSocket() {
  return React.useContext(WebSocketContext);
}

/** Subscribe to a specific realtime event. The callback is stable across renders. */
export function useRealtimeEvent<T = unknown>(eventName: string, callback: (data: T) => void) {
  const { socket } = useWebSocket();
  const callbackRef = React.useRef(callback);
  callbackRef.current = callback;

  React.useEffect(() => {
    if (!socket) return;
    const handler = (data: T) => callbackRef.current(data);
    socket.on(eventName, handler);
    return () => {
      socket.off(eventName, handler);
    };
  }, [socket, eventName]);
}

/* ─── Provider ──────────────────────────────────────────────────────  */

const WS_URL = import.meta.env.VITE_API_URL?.replace(/\/api\/?$/, '') || window.location.origin;

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<ConnectionStatus>('disconnected');
  const [socket, setSocket] = React.useState<Socket | null>(null);
  const [lastEventId, setLastEventId] = React.useState<string | null>(null);

  React.useEffect(() => {
    const session = readStoredSession();
    if (!session?.tokens?.accessToken) return;

    const s = io(WS_URL, {
      path: '/socket.io',
      auth: {
        token: session.tokens.accessToken,
        lastEventId: lastEventId ?? undefined,
        protocolVersion: '2',
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
    });

    setSocket(s);
    setStatus('connecting');

    s.on('connect', () => setStatus('connected'));
    s.on('disconnect', () => setStatus('disconnected'));
    s.on('reconnect_attempt', () => setStatus('reconnecting'));
    s.on('connect_error', () => setStatus('disconnected'));

    // Track last event ID for replay on reconnect
    s.onAny((_event: string, data: unknown) => {
      if (data && typeof data === 'object' && 'eventId' in data) {
        setLastEventId((data as { eventId: string }).eventId);
      }
    });

    return () => {
      s.disconnect();
      setSocket(null);
      setStatus('disconnected');
    };
  }, []);

  const value = React.useMemo(
    () => ({ status, socket, lastEventId }),
    [status, socket, lastEventId],
  );

  return <WebSocketContext.Provider value={value}>{children}</WebSocketContext.Provider>;
}
