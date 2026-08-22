import bcrypt from "bcryptjs";
import he from "he";
import jwt from "jsonwebtoken";
import type { Redis } from "ioredis";
import type { Socket } from "socket.io";

import { config } from "../config.ts";
import { UserAccount } from "../db/models.ts";
import { logger } from "../logger.ts";
import type { HttpRequestLike, HttpResponseLike } from "../transport/http.ts";

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
  exp?: number;
}

import {
  generateCorsHeaders,
  MIME_TYPES,
  parseRequestJson,
} from "../utils/http.ts";
import { IsRegistrationAllowedSchema, UserAuthSchema } from "./validator.ts";
import type { RequestContext } from "./rateLimit.ts";
type NextHandler = (
  data: unknown,
  res: HttpResponseLike,
  context?: RequestContext,
) => unknown;
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

/**
 * The `exp` claim of a token this server just minted, in epoch seconds.
 *
 * Returned alongside the token so the client can schedule its renewal without
 * decoding a JWT it has no key to verify. `jwt.decode` is safe here for the
 * same reason: the token came from `generateAuthToken` two lines earlier, so
 * there is nothing to authenticate.
 */
export function expiryOf(token: string): number | null {
  const decoded = jwt.decode(token);
  if (
    decoded && typeof decoded === "object" && typeof decoded.exp === "number"
  ) {
    return decoded.exp;
  }
  return null;
}

let dummyPasswordHash: Promise<string> | null = null;

/**
 * A bcrypt hash of a value no one can log in with, used to give the
 * username-miss path in `authenticateUser` the same cost as a hit.
 *
 * Generated once at the configured cost rather than hardcoded, so it stays in
 * step if `saltRounds` ever changes — a dummy hash at a different cost than
 * the real ones would reintroduce the timing difference it exists to remove.
 * `createAuthMiddleware` warms it at startup so that even the first miss after
 * a restart pays the same price as every later one.
 */
export function getDummyPasswordHash(): Promise<string> {
  if (!dummyPasswordHash) {
    dummyPasswordHash = bcrypt.hash(
      "yt-diff::no-such-user::placeholder",
      config.saltRounds,
    );
  }
  return dummyPasswordHash;
}

export function createAuthMiddleware({
  redis,
  generateAuthToken,
  hashPassword,
  emitTokenExpired,
}: AuthDependencies) {
  const jsonMimeType = MIME_TYPES[".json"];
  // Warm the dummy hash so the first failed login after a restart is not
  // measurably slower than the ones after it.
  void getDummyPasswordHash();
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
        requestData = await parseRequestJson(request) as Record<
          string,
          unknown
        >;
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

      const parsed = UserAuthSchema.safeParse(requestData);
      if (!parsed.success) {
        logger.error("Registration payload invalid", {
          errors: JSON.stringify(parsed.error.format()),
        });
        response.writeHead(400, generateCorsHeaders(jsonMimeType));
        return response.end(JSON.stringify({
          status: "error",
          message: "Invalid payload",
        }));
      }
      const { username, password } = parsed.data;

      const existingUser = await UserAccount.findOne({
        where: { username: username },
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
        username: username,
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

    const parsed = IsRegistrationAllowedSchema.safeParse(requestData);
    const sendStats = parsed.success ? (parsed.data.sendStats || false) : false;
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
        requestData = await parseRequestJson(request) as Record<
          string,
          unknown
        >;
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

      // Forward who this is alongside the body. This is the only point in the
      // chain where the verified user and the parsed request exist together,
      // which is what lets a downstream handler charge cost against an account
      // rather than an IP. Handlers that take two arguments simply ignore it.
      next(requestData, response, {
        userId: String(user.id),
        userName: user.username,
        clientIp: request.socket.remoteAddress,
      });
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
        requestData = await parseRequestJson(request) as Record<
          string,
          unknown
        >;
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

      const parsed = UserAuthSchema.safeParse(requestData);
      if (!parsed.success) {
        response.writeHead(400, generateCorsHeaders(jsonMimeType));
        return response.end(JSON.stringify({
          status: "error",
          message: "Invalid credentials format",
        }));
      }
      const { username, password } = parsed.data;

      const user = await UserAccount.findOne({
        where: { username: username },
      });

      if (!user) {
        // Spend a bcrypt round against a throwaway hash before answering.
        // Without it a miss returns in about a millisecond and a hit takes as
        // long as bcrypt does, which is a timing oracle for "does this
        // username exist" — and registration is open by default, so the answer
        // is worth something. The response body and status are already
        // identical on both paths; this makes the timing identical too.
        await bcrypt.compare(password, await getDummyPasswordHash());
        logger.warn(`Authentication failed for user ${username}`);
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
        logger.warn(`Authentication failed for user ${username}`);
        response.writeHead(401, generateCorsHeaders(jsonMimeType));
        return response.end(JSON.stringify({
          status: "error",
          message: "Invalid credentials",
        }));
      }

      const token = generateAuthToken(
        user as unknown as { id: string; updatedAt: Date },
        config.auth.tokenExpiry,
      );
      logger.info(`Authentication successful for user ${username}`);

      response.writeHead(200, generateCorsHeaders(jsonMimeType));
      return response.end(JSON.stringify({
        status: "success",
        token,
        // The client schedules its own renewal off this rather than parsing
        // the JWT, which would mean trusting a payload it cannot verify.
        expiresAt: expiryOf(token),
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

  /**
   * Mints a fresh token for the caller of an already-valid one.
   *
   * Shaped as an `authenticateRequest` continuation, so it only ever runs
   * after the incoming token has been verified, the user has been loaded and
   * the password-change check has passed. That is what makes this safe without
   * a separate refresh-token type: this is not an offline-verifiable grant
   * that outlives the session, it is the same session re-stamped.
   *
   * The consequence is a sliding window rather than an unlimited one — a tab
   * asleep longer than `TOKEN_EXPIRY` comes back to a 401 and a login form,
   * because `authenticateRequest` rejects the expired token before this runs.
   * That is the trade the short lifetime is buying.
   */
  async function refreshAuthToken(
    _data: unknown,
    response: HttpResponseLike,
    context?: RequestContext,
  ): Promise<unknown> {
    try {
      if (!context?.userId) {
        // Unreachable through the router — authenticateRequest always supplies
        // a context — but this must never mint a token for nobody.
        response.writeHead(401, generateCorsHeaders(jsonMimeType));
        return response.end(JSON.stringify({
          status: "error",
          message: "Token required",
        }));
      }

      const user = await UserAccount.findByPk(context.userId);
      if (!user) {
        response.writeHead(404, generateCorsHeaders(jsonMimeType));
        return response.end(JSON.stringify({
          status: "error",
          message: "User not found",
        }));
      }

      // Re-read updatedAt from the row rather than carrying the old token's
      // claim forward: it is what the password-change check compares against,
      // so a token minted from a stale value would survive a password change.
      const token = generateAuthToken(
        user.toJSON() as unknown as { id: string; updatedAt: Date },
        config.auth.tokenExpiry,
      );

      logger.debug(`Refreshed token for user ${context.userName}`);
      response.writeHead(200, generateCorsHeaders(jsonMimeType));
      return response.end(JSON.stringify({
        status: "success",
        token,
        expiresAt: expiryOf(token),
      }));
    } catch (error) {
      logger.error("Token refresh failed", {
        error: (error as Error).message,
      });
      response.writeHead(500, generateCorsHeaders(jsonMimeType));
      return response.end(JSON.stringify({
        status: "error",
        message: "Token refresh failed",
      }));
    }
  }

  return {
    authenticateRequest,
    authenticateSocket,
    authenticateUser,
    isRegistrationAllowed,
    refreshAuthToken,
    registerUser,
  };
}
