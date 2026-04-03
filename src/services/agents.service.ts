import axios from 'axios';
import { pool } from '../config/db.config';
import { CreateAgentDTO, Agent } from '../types/agent.types';
import logger from '../config/logger';
import { ENV } from '../config/env.config';
import { ModelsService } from './models.service';


export class AgentsService {
    async createAgent(dto: CreateAgentDTO, userId: string = 'default_user'): Promise<Agent> {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const {
                name,
                icon,
                description,
                version,
                status = 'published',
                tags,
                visibility,
                model_name,
                temperature,
                max_tokens,
                system_prompt,
                capabilities = []
            } = dto;

            // 1. Generate unique slug
            let initialSlug = dto.slug || this.generateSlug(name);
            const slug = await this.ensureUniqueSlug(initialSlug);

            // 2. Insert Agent
            const agentResult = await client.query(
                `INSERT INTO agents (
                    name, slug, icon, description, version, status, tags, visibility, 
                    model_name, temperature, max_tokens, system_prompt, user_id
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                RETURNING *`,
                [name, slug, icon, description, version, status, tags, visibility, model_name, temperature, max_tokens, system_prompt, userId]
            );


            const newAgent = agentResult.rows[0];

            // 3. Insert Capabilities
            if (capabilities.length > 0) {
                for (const cap of capabilities) {
                    await client.query(
                        `INSERT INTO agent_capabilities (agent_id, capability_id, capability_type) VALUES ($1, $2, $3)`,
                        [newAgent.id, cap.capability_id, cap.capability_type]
                    );
                }
            }

            await client.query('COMMIT');
            return {
                ...newAgent,
                capabilities
            };
        } catch (error) {
            await client.query('ROLLBACK');
            logger.error({ error }, 'Service: Failed to create agent');
            throw error;
        } finally {
            client.release();
        }
    }

    async listAgents(userId: string, options: { query?: string, page?: number, limit?: number } = {}): Promise<{ agents: Agent[], total: number }> {
        const { query, page = 1, limit = 9 } = options;
        const offset = (page - 1) * limit;

        try {
            let whereClause = 'WHERE 1=1';
            const params: any[] = [];

            if (query) {
                params.push(`%${query}%`);
                whereClause += ` AND (name ILIKE $${params.length} OR description ILIKE $${params.length})`;
            }

            // Get total count
            const countResult = await pool.query(
                `SELECT COUNT(*) FROM agents ${whereClause}`,
                params
            );
            const total = parseInt(countResult.rows[0].count);

            // Get paginated agents
            const agentsParams = [...params, limit, offset];
            const result = await pool.query(
                `SELECT a.*, 
                 COALESCE(
                   (SELECT json_agg(json_build_object('capability_id', ac.capability_id, 'capability_type', ac.capability_type))
                    FROM agent_capabilities ac WHERE ac.agent_id = a.id),
                   '[]'
                 ) as capabilities
                 FROM agents a ${whereClause} 
                 ORDER BY created_at DESC 
                 LIMIT $${agentsParams.length - 1} OFFSET $${agentsParams.length}`,
                agentsParams
            );

            return {
                agents: result.rows,
                total
            };
        } catch (error) {
            logger.error({ error }, 'Service: Failed to list agents');
            throw error;
        }
    }

    async getAgentBySlug(slug: string, requestingUserId?: string): Promise<Agent | null> {
        try {
            // 1. Fetch Agent with basic capabilities join
            // SECURE: Enforce visibility checks in the query
            const query = `
                SELECT a.*, 
                 COALESCE(
                   (SELECT json_agg(json_build_object(
                      'capability_id', COALESCE(t.id::text, kb.id::text, kg.id::text, mcp.id::text, ac.capability_id), 
                      'capability_type', ac.capability_type,
                      'name', COALESCE(t.name, kb.name, kg.name, mcp.name, ac.capability_id),
                      'description', COALESCE(t.description, kb.description, kg.description, mcp.description, '')
                   ))
                    FROM agent_capabilities ac 
                    LEFT JOIN tools t ON ac.capability_type = 'tool' AND ac.capability_id = t.id::text
                    LEFT JOIN knowledge_bases kb ON ac.capability_type = 'kb' AND ac.capability_id = kb.id::text
                    LEFT JOIN knowledge_graphs kg ON ac.capability_type = 'kg' AND ac.capability_id = kg.id::text
                    LEFT JOIN mcp_tools mcp ON ac.capability_type = 'mcp' AND (ac.capability_id = mcp.id::text OR ac.capability_id = (mcp.name || '-' || mcp.server_id))
                    WHERE ac.agent_id = a.id),
                   '[]'
                 ) as capabilities
                 FROM agents a 
                 WHERE a.slug = $1
            `;
            
            const result = await pool.query(query, [slug]);

            if (result.rows.length === 0) return null;
            return result.rows[0];

        } catch (error) {
            logger.error({ error }, 'Service: Failed to get agent by slug');
            throw error;
        }
    }



    async getAgentById(idOrSlug: string, userId: string = 'default_user'): Promise<Agent | null> {
        try {
            const result = await pool.query(
                `SELECT a.*, 
                 COALESCE(
                   (SELECT json_agg(json_build_object('capability_id', ac.capability_id, 'capability_type', ac.capability_type))
                    FROM agent_capabilities ac WHERE ac.agent_id = a.id),
                   '[]'
                 ) as capabilities
                 FROM agents a WHERE (a.id::text = $1 OR a.slug = $1)`,
                [idOrSlug]
            );
            return result.rows.length ? result.rows[0] : null;
        } catch (error) {
            logger.error({ error, idOrSlug }, 'Service: Failed to get agent by id or slug');
            throw error;
        }
    }

    async updateAgent(idOrSlug: string, dto: CreateAgentDTO, userId: string = 'default_user'): Promise<Agent> {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const {
                name, icon, description, version, status = 'published', tags,
                visibility, model_name, temperature, max_tokens, system_prompt, capabilities = []
            } = dto;

            const res = await client.query(
                `UPDATE agents SET 
                    name = $1, icon = $2, description = $3, version = $4, status = $5,
                    tags = $6, visibility = $7, model_name = $8, temperature = $9,
                    max_tokens = $10, system_prompt = $11, updated_at = CURRENT_TIMESTAMP
                WHERE (id::text = $12 OR slug = $12) AND user_id = $13 RETURNING *`,
                [name, icon, description, version, status, tags, visibility, model_name, temperature, max_tokens, system_prompt, idOrSlug, userId]
            );

            if (res.rowCount === 0) throw new Error('Agent not found or unauthorized');

            const actualId = res.rows[0].id;
            await client.query('DELETE FROM agent_capabilities WHERE agent_id = $1', [actualId]);
            for (const cap of capabilities) {
                await client.query(
                    'INSERT INTO agent_capabilities (agent_id, capability_id, capability_type) VALUES ($1, $2, $3)',
                    [actualId, cap.capability_id, cap.capability_type]
                );
            }

            await client.query('COMMIT');
            return { ...res.rows[0], capabilities };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async deleteAgent(idOrSlug: string, userId: string = 'default_user'): Promise<void> {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Resolve real ID first for consistency
            const agentRes = await client.query('SELECT id FROM agents WHERE (id::text = $1 OR slug = $1) AND user_id = $2', [idOrSlug, userId]);
            if (agentRes.rowCount === 0) {
                throw new Error('Agent not found or unauthorized');
            }
            const actualId = agentRes.rows[0].id;

            // Delete capabilities
            await client.query('DELETE FROM agent_capabilities WHERE agent_id = $1', [actualId]);

            // Delete agent
            await client.query('DELETE FROM agents WHERE id = $1', [actualId]);

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            logger.error({ error, id: idOrSlug }, 'Service: Failed to delete agent');
            throw error;
        } finally {
            client.release();
        }
    }

    async getCreationOptions(userId: string): Promise<any> {
        try {
            const [toolsRes, mcpRes, kbRes, kgRes] = await Promise.all([
                axios.get(`${ENV.TOOLS_SERVICE_URL}/backend/api/tools`, { headers: { 'x-user-id': userId } }).catch(e => ({ data: { tools: [] } })),
                axios.get(`${ENV.TOOLS_SERVICE_URL}/backend/api/mcp/tools`, { headers: { 'x-user-id': userId } }).catch(e => ({ data: { tools: [] } })),
                axios.get(`${ENV.TOOLS_SERVICE_URL}/backend/api/knowledge/bases`, { headers: { 'x-user-id': userId } }).catch(e => ({ data: { items: [] } })),
                axios.get(`${ENV.TOOLS_SERVICE_URL}/backend/api/knowledge/graphs`, { headers: { 'x-user-id': userId } }).catch(e => ({ data: { items: [] } }))
            ]);

            const modelsService = new ModelsService();
            const models = await modelsService.getModels().catch((e: any) => []);

            return {
                tools: toolsRes.data.tools || [],
                mcp_tools: mcpRes.data.tools || mcpRes.data || [],
                knowledge_bases: kbRes.data.items || [],
                knowledge_graphs: kgRes.data.items || [],
                models
            };
        } catch (error) {
            logger.error({ error }, 'Service: Failed to fetch creation options');
            throw error;
        }
    }

    async generateCreationLink(dto: any, userId: string): Promise<{ url: string }> {
        // 1. Basic Schema Validation
        const requiredFields = ['name', 'model_name', 'system_prompt'];
        for (const field of requiredFields) {
            if (!dto[field]) {
                throw new Error(`Validation Error: Missing required field '${field}'`);
            }
        }

        // 2. Options Validation (against user's actual assets)
        const options = await this.getCreationOptions(userId);

        // Validate Model
        const validModelNames = options.models.map((m: any) => m.model_name);
        if (!validModelNames.includes(dto.model_name)) {
            throw new Error(`Validation Error: Invalid model_name '${dto.model_name}'. Available models: ${validModelNames.join(', ')}`);
        }

        // Validate Capabilities
        if (dto.capabilities && typeof dto.capabilities === 'string') {
            try {
                dto.capabilities = JSON.parse(dto.capabilities);
            } catch (e) {
                // Keep as is if not parseable
            }
        }

        if (dto.capabilities && Array.isArray(dto.capabilities)) {
            for (const cap of dto.capabilities) {
                let isValid = false;
                switch (cap.capability_type) {
                    case 'tool':
                        isValid = options.tools.some((t: any) => t.id === cap.capability_id);
                        break;
                    case 'mcp':
                        isValid = options.mcp_tools.some((m: any) => m.id === cap.capability_id || m.name === cap.capability_id);
                        break;
                    case 'kb':
                        isValid = options.knowledge_bases.some((kb: any) => kb.id === cap.capability_id);
                        break;
                    case 'kg':
                        isValid = options.knowledge_graphs.some((kg: any) => kg.id === cap.capability_id);
                        break;
                    default:
                        const receivedStr = typeof cap === 'object' ? JSON.stringify(cap) : String(cap);
                        throw new Error(`Validation Error: Invalid capability object or type. Received: ${receivedStr}. Expected { capability_type: 'tool'|'mcp'|'kb'|'kg', capability_id: 'string' }`);
                }

                if (!isValid) {
                    throw new Error(`Validation Error: ${cap.capability_type.toUpperCase()} with ID '${cap.capability_id}' not found or unauthorized for this user.`);
                }
            }
        }

        const params = new URLSearchParams();
        if (dto.name) params.set('name', dto.name);
        if (dto.icon) params.set('icon', dto.icon);
        if (dto.description) params.set('description', dto.description);
        if (dto.version) params.set('version', dto.version);
        if (dto.tags && dto.tags.length > 0) params.set('tags', Array.isArray(dto.tags) ? dto.tags.join(',') : dto.tags);
        if (dto.visibility) params.set('visibility', dto.visibility);
        if (dto.model_name) params.set('model', dto.model_name);
        if (dto.temperature !== undefined) params.set('temperature', dto.temperature.toString());
        if (dto.max_tokens !== undefined) params.set('maxTokens', dto.max_tokens.toString());
        if (dto.system_prompt) params.set('systemPrompt', dto.system_prompt);

        if (dto.capabilities && dto.capabilities.length > 0) {
            const caps = dto.capabilities.map((c: any) => `${c.capability_type}-${c.capability_id}`).join(',');
            params.set('capabilities', caps);
        }

        const url = `${ENV.FRONTEND_URL}/agent-create?${params.toString()}`;
        return { url };
    }

    private generateSlug(name: string): string {

        return name
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    private async ensureUniqueSlug(initialSlug: string): Promise<string> {
        let slug = initialSlug;
        let counter = 1;

        while (true) {
            const result = await pool.query('SELECT id FROM agents WHERE slug = $1', [slug]);
            if (!result.rowCount || result.rowCount === 0) return slug;
            slug = `${initialSlug}-${counter}`;
            counter++;
        }
    }
}

