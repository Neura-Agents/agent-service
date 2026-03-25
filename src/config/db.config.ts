import { Pool } from 'pg';
import { ENV } from './env.config';
import logger from './logger';

export const pool = new Pool({
    host: ENV.DB.DB_HOST,
    port: ENV.DB.DB_PORT,
    user: ENV.DB.DB_USER,
    password: ENV.DB.DB_PASSWORD,
    database: ENV.DB.DB_NAME,
});

export const initDb = async () => {
    try {
        await pool.query(`
            CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

            CREATE TABLE IF NOT EXISTS agents (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                name VARCHAR(255) NOT NULL,
                slug VARCHAR(255) UNIQUE NOT NULL,
                icon VARCHAR(255) DEFAULT 'UserCircle02Icon',
                description TEXT,
                version VARCHAR(50) DEFAULT '1.0.0',
                status VARCHAR(20) DEFAULT 'published',
                tags TEXT[] DEFAULT '{}',
                visibility VARCHAR(20) DEFAULT 'private',
                
                -- Model Brain
                model_name VARCHAR(255) NOT NULL,
                temperature NUMERIC(3, 2) DEFAULT 0.7,
                max_tokens INTEGER DEFAULT 2048,
                system_prompt TEXT,

                -- Ownership & Audit
                user_id VARCHAR(255) NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS agent_capabilities (
                agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
                capability_id VARCHAR(255) NOT NULL,
                capability_type VARCHAR(50) NOT NULL, -- 'tool', 'mcp', 'kb', 'kg'
                PRIMARY KEY (agent_id, capability_id, capability_type)
            );

            CREATE INDEX IF NOT EXISTS idx_agents_slug ON agents(slug);
            CREATE INDEX IF NOT EXISTS idx_agents_user_id ON agents(user_id);
        `);
        logger.info('Agent database initialized successfully');
    } catch (error) {
        logger.error({ error }, 'Failed to initialize agent database');
        throw error;
    }
};

