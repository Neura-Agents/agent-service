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
    INTERNAL_SERVICE_SECRET: process.env.INTERNAL_SERVICE_SECRET || 'super-secret-key',
    LITELLM: {
        API_KEY: process.env.LITELLM_API_KEY || '',
        AI_GATEWAY_URL: process.env.AI_GATEWAY_URL || 'http://localhost:4000',
    },
    FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:8080',
    TOOLS_SERVICE_URL: process.env.TOOLS_SERVICE_URL || 'http://localhost:3001',
    API_KEY_SERVICE_URL: process.env.API_KEY_SERVICE_URL || 'http://api-key-service:3008',
    PLATFORM_SERVICE_URL: process.env.PLATFORM_SERVICE_URL || 'http://platform-service:3006',
    BILLING_SERVICE_URL: process.env.BILLING_SERVICE_URL || 'http://billing-service:3007',
    KEYCLOAK: {
        ISSUER_URL: process.env.KEYCLOAK_ISSUER_URL || 'http://keycloak:8080/realms/neura-agents',
        PUBLIC_ISSUER_URL: process.env.KEYCLOAK_PUBLIC_ISSUER_URL || 'http://localhost:8081/realms/neura-agents',
        REALM: process.env.VITE_KEYCLOAK_REALM || 'neura-agents'
    }
};
