import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import axios from 'axios';
import logger from '../config/logger';
import { ENV } from '../config/env.config';

const client = jwksClient({
    jwksUri: `${ENV.KEYCLOAK?.ISSUER_URL || `http://keycloak:8080/realms/${ENV.KEYCLOAK?.REALM || 'neura-agents'}`}/protocol/openid-connect/certs`,
    cache: true,
    rateLimit: true,
    jwksRequestsPerMinute: 5
});

function getKey(header: any, callback: any) {
    client.getSigningKey(header.kid, (err, key: any) => {
        if (err) {
            callback(err);
            return;
        }
        const signingKey = key.getPublicKey();
        callback(null, signingKey);
    });
}

export interface AuthenticatedRequest extends Request {
        user?: {
        id: string;
        username?: string;
        email?: string;
        roles?: string[];
        apiKey?: string;
        apiKeyId?: string; // Add this
    };
}

export const authenticate = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    let token: string | undefined;
    const authHeader = req.headers.authorization;
    const queryToken = req.query.jwt as string;
    const userIdHeader = req.headers['x-user-id'] as string;
    const apiKeyHeader = req.headers['x-api-key'] as string;

    // 1. API Key Authentication (Highest Priority if provided via header)
    if (apiKeyHeader) {
        try {
            const validationResponse = await axios.post(`${ENV.API_KEY_SERVICE_URL}/backend/api/api-keys/validate`, {
                apiKey: apiKeyHeader,
                endpoint: req.originalUrl,
                method: req.method
            }, {
                headers: { 'x-internal-key': ENV.INTERNAL_SERVICE_SECRET }
            });

            if (validationResponse.data.valid) {
                req.user = {
                    id: validationResponse.data.user.id,
                    username: `api-key-${apiKeyHeader.slice(-4)}`,
                    roles: ['api-user'],
                    apiKey: apiKeyHeader, // Raw key for authorization
                    apiKeyId: validationResponse.data.user.apiKeyId || validationResponse.data.data?.id // ID for tracking
                };
                return next();
            }
        } catch (err: any) {
            if (err.response?.status === 401) {
                res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
                return;
            }
            logger.error({ err: err.message }, 'Auth Middleware: API Key validation error');
        }
    }

    // 2. JWT Authentication
    if (authHeader) {
        if (authHeader.startsWith('Bearer ')) {
            token = authHeader.split(' ')[1];
        } else {
            token = authHeader;
        }
    } else if (queryToken) {
        token = queryToken;
    }

    if (token) {
        try {
            // SECURE: Actually verify the token signature
            const decoded = await new Promise<any>((resolve, reject) => {
                jwt.verify(token, getKey, {
                    issuer: [ENV.KEYCLOAK?.ISSUER_URL, ENV.KEYCLOAK?.PUBLIC_ISSUER_URL],
                    algorithms: ['RS256']
                }, (err, payload) => {
                    if (err) return reject(err);
                    resolve(payload);
                });
            });

            if (decoded && decoded.sub) {
                req.user = {
                    id: decoded.sub,
                    username: decoded.preferred_username,
                    email: decoded.email,
                    roles: [
                        ...(decoded.realm_access?.roles || []),
                        ...(decoded.resource_access?.['neura-agents-client']?.roles || [])
                    ]
                };

                // Fetch default API key for this user for tracking during this session
                try {
                    const defaultKeyRes = await axios.get(`${ENV.API_KEY_SERVICE_URL}/backend/api/api-keys/default/${decoded.sub}`, {
                        headers: { 'x-internal-key': ENV.INTERNAL_SERVICE_SECRET }
                    });
                    if (defaultKeyRes.data.found) {
                        req.user.apiKeyId = defaultKeyRes.data.data.id;
                        req.user.apiKey = defaultKeyRes.data.data.api_key_hash; 
                    }
                } catch (err: any) {
                    logger.warn({ userId: decoded.sub, error: err.message }, 'Auth Middleware: Failed to fetch default API key');
                }

                return next();
            }
        } catch (err: any) {
            logger.error({ err: err.message }, 'Auth Middleware: Token verification failed');
            // If token was provided but invalid, we don't fall back to userIdHeader
            res.status(401).json({ error: `Unauthorized: ${err.message}` });
            return;
        }
    }

    // 3. Dev fallback (ONLY if NOT in production)
    if (process.env.NODE_ENV === 'development' && userIdHeader) {
        logger.warn({ userId: userIdHeader }, 'Auth Middleware: Using X-User-Id development fallback');
        req.user = { id: userIdHeader, roles: ['admin'] };
        return next();
    }

    res.status(401).json({ error: 'Unauthorized: No valid API Key or JWT provided' });
};

/**
 * Optional authentication middleware.
 * Populates req.user if a valid token is provided, but does not reject the request if missing.
 */
export const tryAuthenticate = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    let token: string | undefined;
    const authHeader = req.headers.authorization;
    const queryToken = req.query.jwt as string;

    if (authHeader) {
        if (authHeader.startsWith('Bearer ')) {
            token = authHeader.split(' ')[1];
        } else {
            token = authHeader;
        }
    } else if (queryToken) {
        token = queryToken;
    }

    if (!token) return next();

    try {
        const decoded = await new Promise<any>((resolve, reject) => {
            jwt.verify(token!, getKey, {
                issuer: [ENV.KEYCLOAK?.ISSUER_URL, ENV.KEYCLOAK?.PUBLIC_ISSUER_URL],
                algorithms: ['RS256']
            }, (err, payload) => {
                if (err) return reject(err);
                resolve(payload);
            });
        });

        if (decoded && decoded.sub) {
            req.user = {
                id: decoded.sub,
                username: decoded.preferred_username,
                email: decoded.email,
                roles: decoded.realm_access?.roles || []
            };
        }
    } catch (err) {
        // Silently fail authentication for "try" middleware
        logger.debug({ err: (err as any).message }, 'Try-Auth: Token verification failed (ignoring)');
    }
    
    next();
};
