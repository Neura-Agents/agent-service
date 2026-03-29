import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

export const ENV = {
    PORT: process.env.PORT || 3002,
    NODE_ENV: process.env.NODE_ENV || 'development',
    DB: {
        DB_HOST: process.env.DB_HOST || 'localhost',
        DB_PORT: parseInt(process.env.DB_PORT || '5432', 10),
        DB_USER: process.env.DB_USER || 'postgres',
        DB_PASSWORD: process.env.DB_PASSWORD || 'postgres',
        DB_NAME: process.env.DB_NAME || 'neura-agents-platform',
    },
    LOG: {
        LEVEL: process.env.LOG_LEVEL || 'info',
    },
    LITELLM: {
        API_KEY: process.env.LITELLM_API_KEY || '',
        AI_GATEWAY_URL: process.env.AI_GATEWAY_URL || 'http://localhost:4000',
    },
    FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:8080',
    TOOLS_SERVICE_URL: process.env.TOOLS_SERVICE_URL || 'http://localhost:3001',
    API_KEY_SERVICE_URL: process.env.API_KEY_SERVICE_URL || 'http://api-key-service:3008',
    PLATFORM_SERVICE_URL: process.env.PLATFORM_SERVICE_URL || 'http://platform-service:3006',
};
