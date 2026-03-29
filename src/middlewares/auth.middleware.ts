import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import logger from '../config/logger';
import { ENV } from '../config/env.config';

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
            const decoded = jwt.decode(token) as any;
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
                    const defaultKeyRes = await axios.get(`${ENV.API_KEY_SERVICE_URL}/backend/api/api-keys/default/${decoded.sub}`);
                    if (defaultKeyRes.data.found) {
                        req.user.apiKeyId = defaultKeyRes.data.data.id;
                        req.user.apiKey = defaultKeyRes.data.data.api_key_hash; // We use the hash as a fallback identifier
                    }
                } catch (err: any) {
                    logger.warn({ userId: decoded.sub }, 'Auth Middleware: Failed to fetch default API key for JWT user');
                }

                return next();
            }
        } catch (err) {
            logger.error({ err }, 'Auth Middleware: Token decode error');
        }
    }

    // 3. Dev/Local fallback
    if (userIdHeader) {
        req.user = { id: userIdHeader, roles: ['admin'] };
        return next();
    }

    res.status(401).json({ error: 'Unauthorized: No valid API Key or JWT provided' });
};
