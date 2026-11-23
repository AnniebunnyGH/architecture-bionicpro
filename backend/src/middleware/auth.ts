import { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { AuthenticatedUser } from '../types/report';

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

interface KeycloakJwtPayload extends JWTPayload {
  preferred_username?: string;
  email?: string;
  realm_access?: {
    roles?: string[];
  };
}

export type TokenVerifier = (token: string) => Promise<AuthenticatedUser>;

export function createKeycloakTokenVerifier(
  jwksUri: string,
  allowedIssuers: string[]
): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL(jwksUri));

  return async (token: string): Promise<AuthenticatedUser> => {
    const { payload } = await jwtVerify<KeycloakJwtPayload>(token, jwks, {
      issuer: allowedIssuers,
    });

    const sub = payload.sub;
    const username = payload.preferred_username;

    if (!sub || !username) {
      throw new Error('Token missing required subject or preferred_username claim');
    }

    const roles = Array.isArray(payload.realm_access?.roles)
      ? payload.realm_access.roles
      : [];

    return {
      sub,
      username,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      roles,
    };
  };
}

export function createAuthMiddleware(verifyToken: TokenVerifier) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing or malformed Authorization Bearer token',
      });
      return;
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Empty Bearer token',
      });
      return;
    }

    try {
      req.user = await verifyToken(token);
      next();
    } catch (err) {
      res.status(401).json({
        error: 'Unauthorized',
        message:
          err instanceof Error ? err.message : 'Invalid or expired JWT token',
      });
    }
  };
}

export function requireRole(role: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    if (!req.user.roles.includes(role)) {
      res.status(403).json({
        error: 'Forbidden',
        message: `Access denied: required role '${role}' is missing`,
      });
      return;
    }

    next();
  };
}
