import { Server as HttpServer } from 'http';
import { Server as SocketServer, type Socket } from 'socket.io';
import { verifyAccessToken, type JwtPayload } from '@arda/auth-utils';
import { config, createLogger } from '@arda/config';
import { getEventBus, type ArdaEvent } from '@arda/events';
import { db, schema } from '@arda/db';
import { eq, and } from 'drizzle-orm';
import { mapBackendEventToWSEvent } from './event-mapper.js';

interface AuthenticatedSocket extends Socket {
  user: JwtPayload;
}

const log = createLogger('ws');

interface TenantRoomEmitter {
  to: (room: string) => { emit: (eventName: string, payload: unknown) => void };
}

interface MappingLogger {
  debug: (context: Record<string, unknown>, message: string) => void;
}

export function emitMappedTenantEvent(
  io: TenantRoomEmitter,
  room: string,
  event: ArdaEvent,
  logger: MappingLogger = log,
): boolean {
  const mapped = mapBackendEventToWSEvent(event);
  if (!mapped) {
    logger.debug({ eventType: event.type }, 'Ignoring non-forwarded backend event');
    return false;
  }

  io.to(room).emit(mapped.type, mapped);
  return true;
}

export function setupWebSocket(httpServer: HttpServer, redisUrl: string): SocketServer {
  const io = new SocketServer(httpServer, {
    cors: {
      origin: config.APP_URL,
      credentials: true,
    },
    path: '/socket.io',
    // Socket.IO built-in heartbeat (transport-level ping/pong)
    pingInterval: 25_000,
    pingTimeout: 10_000,
  });

  const eventBus = getEventBus(redisUrl);

  // Auth middleware — verify JWT from handshake
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
      if (!token) {
        return next(new Error('Authentication required'));
      }
      const payload = verifyAccessToken(token);
      (socket as AuthenticatedSocket).user = payload;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const user = (socket as AuthenticatedSocket).user;
    const tenantId = user.tenantId;

    log.info({ userId: user.sub, tenantId }, 'Client connected');

    // Join tenant room
    const tenantRoom = `tenant:${tenantId}`;
    socket.join(tenantRoom);

    // Subscribe to tenant events via Redis and forward to Socket.io room
    const handler = (event: ArdaEvent) => {
      emitMappedTenantEvent(io, tenantRoom, event);
    };

    eventBus.subscribeTenant(tenantId, handler);

    // Send welcome message
    socket.emit('connected', {
      tenantId,
      userId: user.sub,
      timestamp: new Date().toISOString(),
    });

    // Handle client-side ping (application-level keepalive)
    socket.on('ping', () => {
      socket.emit('pong', { timestamp: new Date().toISOString() });
    });

    // Client can request specific event subscriptions (verify tenant ownership)
    socket.on('subscribe:loop', async (loopId: string) => {
      try {
        const loop = await db.query.kanbanLoops.findFirst({
          where: and(
            eq(schema.kanbanLoops.id, loopId),
            eq(schema.kanbanLoops.tenantId, tenantId)
          ),
          columns: { id: true },
        });
        if (!loop) {
          socket.emit('error', { message: 'Loop not found or access denied' });
          return;
        }
        socket.join(`loop:${loopId}`);
      } catch {
        socket.emit('error', { message: 'Failed to subscribe to loop' });
      }
    });

    socket.on('unsubscribe:loop', (loopId: string) => {
      socket.leave(`loop:${loopId}`);
    });

    socket.on('disconnect', () => {
      log.info({ userId: user.sub }, 'Client disconnected');
      eventBus.unsubscribeTenant(tenantId, handler);
    });
  });

  log.info('Socket.IO WebSocket handler ready on /socket.io');
  return io;
}
