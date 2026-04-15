import bcrypt from "bcryptjs";
import he from "he";
import jwt from "jsonwebtoken";
import type Redis from "ioredis";
import type { Socket } from "socket.io";

import { config } from "../config.ts";
import { UserAccount } from "../db/models.ts";
import { logger } from "../logger.ts";
import type {
  HttpRequestLike,
  HttpResponseLike,
} from "../transport/http.ts";

export interface CachedUser {
  id: string;
  username: string;
  passwordHash: string;
  passwordSalt: string;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface AuthJwtPayload extends jwt.JwtPayload {
  id: string;
  lastPasswordChangeTime?: number;
}


import { parseRequestJson, generateCorsHeaders, MIME_TYPES } from "../utils/http.ts";
type NextHandler = (data: unknown, res: HttpResponseLike) => unknown;
type TokenExpiredEmitter = (payload: { error: string }) => void;
type GenerateAuthToken = (
  user: { id: string; updatedAt: Date },
  expiryDuration: string,
) => string;
type HashPassword = (password: string) => Promise<[string, string]>;

interface AuthDependencies {
  redis: Redis;
  generateAuthToken: GenerateAuthToken;
  hashPassword: HashPassword;
  emitTokenExpired?: TokenExpiredEmitter;
}

const utf8Encoder = new TextEncoder();

async function getAuthenticatedUser(
  redis: Redis,
  decodedToken: AuthJwtPayload,
) {
  let user: CachedUser | null = null;
  const cachedUser = await redis.get(`user:${decodedToken.id}`);

  if (cachedUser) {
    user = JSON.parse(cachedUser) as CachedUser;
    const lastPasswordUpdate = new Date(user.updatedAt || 0).getTime();
    const tokenTime = new Date(decodedToken.lastPasswordChangeTime || 0)
      .getTime();
    if (lastPasswordUpdate !== tokenTime) {
      return { user: null, passwordChanged: true };
    }
  }

  if (!user) {
    logger.debug(`Fetching user data for ID ${decodedToken.id}`);
    const dbUser = await UserAccount.findByPk(decodedToken.id);
    if (dbUser) {
      user = dbUser.toJSON() as CachedUser;
      await redis.set(
        `user:${decodedToken.id}`,
        JSON.stringify(user),
        "EX",
        config.cache.maxAge,
      );
    }
  }

  return { user, passwordChanged: false };
}

export function createAuthMiddleware({
  redis,
  generateAuthToken,
  hashPassword,
  emitTokenExpired,
}: AuthDependencies) {
  const jsonMimeType = MIME_TYPES[".json"];
  async function registerUser(
    request: HttpRequestLike,
    response: HttpResponseLike,
  ): Promise<unknown> {
    try {
      if (!config.registration.allowed) {
        response.writeHead(403, generateCorsHeaders(jsonMimeType));
        return response.end(JSON.stringify({
          status: "error",
          message: "Registration is currently disabled",
        }));
      }

      const userCount = await UserAccount.count();
      if (userCount >= config.registration.maxUsers) {
        response.writeHead(403, generateCorsHeaders(jsonMimeType));
        return response.end(JSON.stringify({
          status: "error",
          message: "Maximum number of users reached",
        }));
      }

      let requestData = {};
      try {
        requestData = await parseRequestJson(request) as Record<string, unknown>;
      } catch (error) {
        logger.error("Failed to parse request JSON", {
          error: (error as Error).message,
        });
        response.writeHead(400, generateCorsHeaders(jsonMimeType));
        return response.end(JSON.stringify({
          status: "error",
          message: `${(error as Error).message || "Invalid request"}`,
        }));
      }

      const { userName, password } = requestData as {
        userName: string;
        password: string;
      };

      const passwordLength = utf8Encoder.encode(password).byteLength;
      if (passwordLength > 72) {
        logger.error("Password too long", {
          userName,
          passwordLength,
        });
        response.writeHead(400, generateCorsHeaders(jsonMimeType));
        return response.end(JSON.stringify({
          status: "error",
          message: "Password exceeds maximum length",
        }));
      }

      const existingUser = await UserAccount.findOne({
        where: { username: userName },
      });

      if (existingUser) {
        response.writeHead(409, generateCorsHeaders(jsonMimeType));
        return response.end(JSON.stringify({
          status: "error",
          message: "Username already exists",
        }));
      }

      const [salt, hashedPassword] = await hashPassword(password);
      await UserAccount.create({
        username: userName,
        passwordSalt: salt,
        passwordHash: hashedPassword,
      });

      response.writeHead(201, generateCorsHeaders(jsonMimeType));
      response.end(JSON.stringify({
        status: "success",
        message: "User registered successfully",
      }));
    } catch (error) {
      logger.error("Registration failed", { error: (error as Error).message });
      response.writeHead(500, generateCorsHeaders(jsonMimeType));
      response.end(JSON.stringify({
        status: "error",
        message: "Registration failed",
      }));
    }
  }

  async function isRegistrationAllowed(
    request: HttpRequestLike,
    response: HttpResponseLike,
  ): Promise<unknown> {
    let allow = true;
    if (!config.registration.allowed) {
      allow = false;
    }

    let requestData = {};
    try {
      requestData = await parseRequestJson(request) as Record<string, unknown>;
    } catch (err) {
      logger.error("Failed to parse request JSON", {
        error: (err as Error).message,
      });
      response.writeHead(400, generateCorsHeaders(jsonMimeType));
      return response.end(JSON.stringify({
        status: "error",
        message: `${(err as Error).message || "Invalid request"}`,
      }));
    }

    const { sendStats } = (requestData as { sendStats?: boolean }) ||
      { sendStats: false };
    const userCount = await UserAccount.count();
    if (userCount >= config.registration.maxUsers) {
      allow = false;
    }

    response.writeHead(200, generateCorsHeaders(jsonMimeType));
    if (sendStats === true) {
      return response.end(JSON.stringify({
        registrationAllowed: allow,
        currentUsers: userCount,
        maxUsers: config.registration.maxUsers,
      }));
    }

    return response.end(JSON.stringify({
      registrationAllowed: allow,
    }));
  }

  async function authenticateRequest(
    request: HttpRequestLike,
    response: HttpResponseLike,
    next: NextHandler,
  ): Promise<unknown> {
    try {
      const authHeader = request.headers &&
        (request.headers.authorization || request.headers.Authorization);
      let headerToken = null;
      if (authHeader && typeof authHeader === "string") {
        const parts = authHeader.split(" ");
        if (parts.length === 2 && /^Bearer$/i.test(parts[0])) {
          headerToken = parts[1];
        } else {
          headerToken = authHeader;
        }
      }

      const token = headerToken;
      if (!token) {
        response.writeHead(401, generateCorsHeaders(jsonMimeType));
        return response.end(
          JSON.stringify({ status: "error", message: "Token required" }),
        );
      }

      const decodedToken = jwt.verify(
        token,
        config.secretKey as string,
      ) as AuthJwtPayload;

      const { user, passwordChanged } = await getAuthenticatedUser(
        redis,
        decodedToken,
      );

      if (passwordChanged) {
        logger.error("Token invalid - password changed");
        response.writeHead(401, generateCorsHeaders(jsonMimeType));
        return response.end(JSON.stringify({
          status: "error",
          message: "Token expired",
        }));
      }

      if (!user) {
        logger.error("User not found");
        response.writeHead(404, generateCorsHeaders(jsonMimeType));
        return response.end(JSON.stringify({
          status: "error",
          message: "User not found",
        }));
      }

      let requestData = {};
      try {
        requestData = await parseRequestJson(request) as Record<string, unknown>;
      } catch (error) {
        logger.error("Failed to parse request JSON", {
          error: (error as Error).message,
        });
        response.writeHead(400, generateCorsHeaders(jsonMimeType));
        return response.end(JSON.stringify({
          status: "error",
          message: `${(error as Error).message || "Invalid request"}`,
        }));
      }

      next(requestData, response);
    } catch (error) {
      logger.error("Token verification failed", {
        error: (error as Error).message,
      });

      const statusCode = (error as Error).name === "TokenExpiredError"
        ? 401
        : 500;
      const message = (error as Error).name === "TokenExpiredError"
        ? "Token expired"
        : "Authentication failed";

      if (
        (error as Error).name === "TokenExpiredError" && emitTokenExpired
      ) {
        try {
          emitTokenExpired({ error: (error as Error).message });
        } catch (e) {
          logger.warn("Failed to emit token-expired on sock", {
            error: (e as Error).message,
          });
        }
      }

      response.writeHead(statusCode, generateCorsHeaders(jsonMimeType));
      return response.end(JSON.stringify({
        status: "error",
        message: he.escape(message),
      }));
    }
  }

  async function authenticateSocket(socket: Socket): Promise<boolean> {
    try {
      const token = socket.handshake.auth.token;
      const decodedToken = jwt.verify(
        token,
        config.secretKey as string,
      ) as AuthJwtPayload;

      const { user, passwordChanged } = await getAuthenticatedUser(
        redis,
        decodedToken,
      );

      if (passwordChanged) {
        logger.error("Socket auth failed - password changed");
        return false;
      }

      if (!user) {
        logger.error("Socket auth failed - user not found");
        return false;
      }

      return true;
    } catch (error) {
      if ((error as Error).name === "JsonWebTokenError") {
        logger.error("Invalid token format");
      } else if ((error as Error).name === "TokenExpiredError") {
        logger.error("Token expired");
      } else {
        logger.error("Socket authentication failed", {
          error: (error as Error).message,
        });
      }
      return false;
    }
  }

  async function authenticateUser(
    request: HttpRequestLike,
    response: HttpResponseLike,
  ): Promise<unknown> {
    try {
      let requestData = {};
      try {
        requestData = await parseRequestJson(request) as Record<string, unknown>;
      } catch (error) {
        logger.error("Failed to parse request JSON", {
          error: (error as Error).message,
        });
        response.writeHead(400, generateCorsHeaders(jsonMimeType));
        return response.end(JSON.stringify({
          status: "error",
          message: `${(error as Error).message || "Invalid request"}`,
        }));
      }

      const data = requestData as {
        userName?: string;
        password?: string;
        expiry_time?: string;
      };
      if (!data.userName || !data.password) {
        response.writeHead(400, generateCorsHeaders(jsonMimeType));
        return response.end(JSON.stringify({
          status: "error",
          message: "userName and password are required",
        }));
      }

      const {
        userName,
        password,
        expiry_time: expiryTime = "31d",
      } = data;

      const passwordLength = utf8Encoder.encode(password).byteLength;
      if (passwordLength > 72) {
        logger.error("Password too long", {
          userName,
          passwordLength,
        });
        response.writeHead(400, generateCorsHeaders(jsonMimeType));
        return response.end(JSON.stringify({
          status: "error",
          message: "Password exceeds maximum length",
        }));
      }

      const user = await UserAccount.findOne({
        where: { username: userName },
      });

      if (!user) {
        logger.warn(`Authentication failed for user ${userName}`);
        response.writeHead(401, generateCorsHeaders(jsonMimeType));
        return response.end(JSON.stringify({
          status: "error",
          message: "Invalid credentials",
        }));
      }

      const isPasswordValid = await bcrypt.compare(
        password,
        (user as unknown as { passwordHash: string }).passwordHash,
      );

      if (!isPasswordValid) {
        logger.warn(`Authentication failed for user ${userName}`);
        response.writeHead(401, generateCorsHeaders(jsonMimeType));
        return response.end(JSON.stringify({
          status: "error",
          message: "Invalid credentials",
        }));
      }

      const token = generateAuthToken(
        user as unknown as { id: string; updatedAt: Date },
        expiryTime,
      );
      logger.info(`Authentication successful for user ${userName}`);

      response.writeHead(200, generateCorsHeaders(jsonMimeType));
      return response.end(JSON.stringify({
        status: "success",
        token: he.escape(token),
      }));
    } catch (error) {
      logger.error("Authentication failed", {
        error: (error as Error).message,
      });
      response.writeHead(500, generateCorsHeaders(jsonMimeType));
      response.end(JSON.stringify({
        status: "error",
        message: "Authentication failed",
      }));
    }
  }

  return {
    authenticateRequest,
    authenticateSocket,
    authenticateUser,
    isRegistrationAllowed,
    registerUser,
  };
}
