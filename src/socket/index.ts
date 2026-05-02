import type Redis from "ioredis";
import jwt from "jsonwebtoken";
import type { Socket } from "socket.io";
import { Server } from "socket.io";

import { config } from "../config.ts";
import { UserAccount } from "../db/models.ts";
import { logger } from "../logger.ts";
import type { AuthJwtPayload, CachedUser } from "../middleware/auth.ts";

type AuthenticateSocket = (socket: Socket) => Promise<boolean>;

interface SocketDependencies {
  server: ConstructorParameters<typeof Server>[0];
  corsAllowedOrigins: string[];
  authenticateSocket: AuthenticateSocket;
  redis: Redis;
}

export function createSocketServer({
  server,
  corsAllowedOrigins,
  authenticateSocket,
  redis,
}: SocketDependencies) {
  const io = new Server(server, {
    path: config.urlBase + "/socket.io/",
    cors: {
      origin: corsAllowedOrigins,
    },
  });

  io.use((socket: Socket, next: (err?: Error) => void) => {
    authenticateSocket(socket).then((result) => {
      if (result) {
        logger.debug("Valid socket", {
          id: socket.id,
          ip: socket.handshake.address,
        });
        next();
      } else {
        logger.error("Invalid socket", {
          id: socket.id,
          ip: socket.handshake.address,
        });
        next(new Error("Invalid socket"));
      }
    }).catch((err) => {
      logger.error("Error in verifying socket", {
        id: socket.id,
        ip: socket.handshake.address,
        error: err as Error,
      });
      next(new Error((err as Error).message));
    });
  });

  const sock = io.on("connection", (socket: Socket) => {
    if (config.connectedClients >= config.maxClients) {
      logger.info("Rejecting client", {
        id: socket.id,
        ip: socket.handshake.address,
        reason: "Server full",
      });
      socket.emit("connection-error", "Server full");
      socket.disconnect(true);
      return;
    }

    const token = socket.handshake.auth.token;
    let decodedToken: AuthJwtPayload | null = null;
    let expiryTimeout: ReturnType<typeof setTimeout> | null = null;
    let verificationInterval: ReturnType<typeof setInterval> | null = null;

    try {
      decodedToken = jwt.verify(
        token,
        config.secretKey as string,
      ) as AuthJwtPayload;
      if (decodedToken && decodedToken.exp) {
        const timeUntilExpiry = (decodedToken.exp * 1000) - Date.now();
        if (timeUntilExpiry > 0) {
          // setTimeout is capped at a signed 32-bit integer (~24.8 days), so
          // clamp the delay for long-lived tokens.
          const delay = Math.min(timeUntilExpiry, 2147483647);
          expiryTimeout = setTimeout(() => {
            logger.info(`Token expired for socket ${socket.id}, disconnecting`);
            socket.emit("token-expired", {
              message: "Your session has expired.",
            });
            socket.disconnect(true);
          }, delay);
        } else {
          socket.emit("token-expired", {
            message: "Your session has expired.",
          });
          socket.disconnect(true);
          return;
        }
      }

      if (decodedToken) {
        // Re-verify on the same cadence as the auth cache TTL so password/user
        // changes invalidate live sockets without hammering the database.
        const pingInterval = config.cache.maxAge * 1000;
        verificationInterval = setInterval(async () => {
          try {
            const cachedUser = await redis.get(`user:${decodedToken?.id}`);
            if (cachedUser) {
              const user = JSON.parse(cachedUser) as CachedUser;
              const lastPasswordUpdate = new Date(user.updatedAt || 0)
                .getTime();
              const tokenTime = new Date(
                decodedToken?.lastPasswordChangeTime || 0,
              ).getTime();
              if (lastPasswordUpdate !== tokenTime) {
                logger.error(
                  "Socket auth check failed mid-session - password changed",
                );
                socket.emit("token-expired", {
                  message: "Authentication invalidated.",
                });
                socket.disconnect(true);
              }
            } else {
              const dbUser = await UserAccount.findByPk(decodedToken?.id);
              if (!dbUser) {
                logger.error(
                  "Socket auth check failed mid-session - user not found",
                );
                socket.emit("token-expired", {
                  message: "Authentication invalidated.",
                });
                socket.disconnect(true);
              } else {
                const user = dbUser.toJSON() as CachedUser;
                await redis.set(
                  `user:${decodedToken?.id}`,
                  JSON.stringify(user),
                  "EX",
                  config.cache.maxAge,
                );
              }
            }
          } catch (error) {
            logger.error("Mid-session socket verification error", {
              error: (error as Error).message,
            });
          }
        }, pingInterval);
      }
    } catch (e) {
      logger.error("Failed to decode token on active connection.", {
        error: (e as Error).message,
      });
      socket.disconnect(true);
      return;
    }

    socket.emit("init", { message: "Connected", id: socket.id });
    socket.on("acknowledge", ({ data, id }: { data: string; id: string }) => {
      logger.info(`Acknowledged from client id ${id}`, {
        id,
        ip: socket.handshake.address,
        data,
      });
      config.connectedClients++;
    });

    socket.on("disconnect", () => {
      if (expiryTimeout) clearTimeout(expiryTimeout);
      if (verificationInterval) clearInterval(verificationInterval);

      logger.info(`Disconnected from client id ${socket.id}`, {
        id: socket.id,
        ip: socket.handshake.address,
      });
      config.connectedClients--;
    });

    return socket;
  });

  return { io, sock };
}
