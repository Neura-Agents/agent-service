import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import logger from '../config/logger';

export interface AuthenticatedRequest extends Request {
    user?: {
        id: string;
        username?: string;
        email?: string;
        roles?: string[];
    };
}

export const authenticate = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    // Check Authorization header (standard)
    // Also check x-user-id for dev/local testing (matching tool-service)
    let token: string | undefined;
    const authHeader = req.headers.authorization;
    const queryToken = req.query.jwt as string;
    const userIdHeader = req.headers['x-user-id'] as string;

    if (authHeader) {
        if (authHeader.startsWith('Bearer ')) {
            token = authHeader.split(' ')[1];
        } else {
            token = authHeader; // In case Kong forwards without prefix
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
                return next();
            }
        } catch (err) {
            logger.error({ err }, 'Auth Middleware: Token decode error');
        }
    }

    // Dev/Local fallback
    if (userIdHeader) {
        req.user = { id: userIdHeader, roles: ['admin'] };
        return next();
    }

    res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
};
