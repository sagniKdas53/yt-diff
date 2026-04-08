import type Redis from "ioredis";
import jwt from "jsonwebtoken";
import type { Server as HttpServer } from "node:http";
import type { Socket } from "socket.io";
import { Server } from "socket.io";

import { config } from "../config.ts";
import { UserAccount } from "../db/models.ts";
import { logger } from "../logger.ts";

type AuthenticateSocket = (socket: Socket) => Promise<boolean>;

interface SocketDependencies {
  server: HttpServer;
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
    let decodedToken: jwt.JwtPayload | null = null;
    let expiryTimeout: ReturnType<typeof setTimeout> | null = null;
    let verificationInterval: ReturnType<typeof setInterval> | null = null;

    try {
      decodedToken = jwt.verify(
        token,
        config.secretKey as string,
      ) as jwt.JwtPayload;
      if (decodedToken && decodedToken.exp) {
        const timeUntilExpiry = (decodedToken.exp * 1000) - Date.now();
        if (timeUntilExpiry > 0) {
          const delay = Math.min(timeUntilExpiry, 2147483647);
          expiryTimeout = setTimeout(() => {
            logger.info(`Token expired for socket ${socket.id}, disconnecting`);
            socket.emit("token-expired", {
              message: "Your session has expired.",
            });
            socket.disconnect(true);
          }, delay);
        } else {
          socket.emit("token-expired", { message: "Your session has expired." });
          socket.disconnect(true);
          return;
        }
      }

      if (decodedToken) {
        const pingInterval = config.cache.maxAge * 1000;
        verificationInterval = setInterval(async () => {
          try {
            const cachedUser = await redis.get(`user:${decodedToken?.id}`);
            if (cachedUser) {
              const user = JSON.parse(cachedUser);
              const lastPasswordUpdate = new Date(user.updatedAt || 0).getTime();
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
              const user = await UserAccount.findByPk(decodedToken?.id);
              if (!user) {
                logger.error(
                  "Socket auth check failed mid-session - user not found",
                );
                socket.emit("token-expired", {
                  message: "Authentication invalidated.",
                });
                socket.disconnect(true);
              } else {
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
