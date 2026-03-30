import express from 'express';
import { ENV } from './config/env.config';
import { initDb } from './config/db.config';
import logger from './config/logger';

import agentRoutes from './routes/agents.routes';
import modelsRoutes from './routes/models.routes';
import temporalRoutes from './routes/temporal.routes';
import { getAgentCard } from './controllers/agents.controller';
import { authenticate, tryAuthenticate } from './middlewares/auth.middleware';

const app = express();

// Middleware
app.use(express.json());

// Log requests
app.use((req, res, next) => {
    logger.info({ 
        method: req.method, 
        url: req.url,
        ip: req.ip 
    }, 'Incoming Request');
    next();
});

// Public Discovery Routes (SECURE: Visibility-aware)
app.get('/:slug/.well-known/agent.json', tryAuthenticate, getAgentCard);

// Protected Routes
app.use('/backend/api/models', authenticate, modelsRoutes);
app.use('/backend/api/agents', authenticate, agentRoutes);
app.use('/', temporalRoutes);

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'UP', service: 'agent-service', version: '1.0.0' });
});

// Error Handling
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.error({ err, url: req.url }, 'Unhandled error occurred');
    res.status(500).json({ error: 'Internal Server Error' });
});

const start = async () => {
    try {
        await initDb();
        
        app.listen(ENV.PORT, () => {
            logger.info(`Agent service listening on port ${ENV.PORT} in ${ENV.NODE_ENV} mode`);
        });
    } catch (err) {
        logger.fatal({ err }, 'Failed to start agent-service');
        process.exit(1);
    }
};

start();

