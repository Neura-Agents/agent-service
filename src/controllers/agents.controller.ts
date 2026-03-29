import { Response } from 'express';
import { AgentsService } from '../services/agents.service';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import logger from '../config/logger';

const agentsService = new AgentsService();

export const createAgent = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const userId = req.user?.id || 'default_user';
        const agent = await agentsService.createAgent(req.body, userId);
        res.status(201).json(agent);
    } catch (error: any) {
        logger.error({ error }, 'Controller: Failed to create agent');
        res.status(400).json({ error: error.message || 'Failed to create agent' });
    }
};

export const listAgents = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const userId = req.user?.id || 'default_user';
        const { query, page, limit } = req.query;

        const result = await agentsService.listAgents(userId, {
            query: query as string,
            page: page ? parseInt(page as string) : 1,
            limit: limit ? parseInt(limit as string) : 9
        });

        res.status(200).json(result);
    } catch (error: any) {
        logger.error({ error }, 'Controller: Failed to list agents');
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const getAgentCard = async (req: any, res: Response) => {
    try {
        const { slug } = req.params;
        const agent = await agentsService.getAgentBySlug(slug);

        if (!agent) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        const baseUrl = process.env.BASE_URL || 'http://localhost:8000';
        const agentUrl = `${baseUrl}/backend/api/v1/agent-execution/${slug}/stream`;

        // Format to the requested structure
        const agentCard = {
            protocolVersion: "0.3.0",
            capabilities: {
                pushNotifications: false,
                stateTransitionHistory: false,
                streaming: true
            },
            defaultInputModes: ["text"],
            defaultOutputModes: ["text"],
            name: agent.name,
            description: agent.description,
            version: agent.version || '1.0.0',
            url: agentUrl,
            tags: agent.tags || [],
            provider: {
                organization: "Acme AI",
                url: "https://acme-ai.example.com"
            },
            model: {
                id: agent.model_name,
                name: agent.model_name
            },
            config: {
                temperature: Number(agent.temperature || 0.7),
                max_tokens: Number(agent.max_tokens || 2048)
            },
            auth: {
                type: "api_key",
                in: "header",
                name: "x-api-key"
            },
            endpoints: {
                invoke: `${agentUrl}/invoke`,
                stream: `${agentUrl}/stream`,
                health: `${agentUrl}/health`
            },
            supportedInterfaces: [
                {
                    transport: "http+sse",
                    url: `${agentUrl}/stream`
                },
                {
                    transport: "http",
                    url: `${agentUrl}/invoke`
                }
            ],
            preferredTransport: "JSONRPC",
            skills: (agent.capabilities || []).map((cap: any) => ({
                id: cap.capability_id,
                name: cap.name || cap.capability_id,
                description: cap.description || `A ${cap.capability_type} capability`,
                inputModes: ["text"],
                outputModes: ["text"],
                tags: [cap.capability_type || "general"],
                examples: []
            })),
            supportsAuthenticatedExtendedCard: false
        };

        res.json(agentCard);
    } catch (error: any) {
        logger.error({ error }, 'Controller: Failed to get agent card');
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const getAgentById = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const idOrSlug = req.params.id as string;
        const userId = req.user?.id || 'default_user';
        const agent = await agentsService.getAgentById(idOrSlug, userId);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        res.json(agent);
    } catch (error: any) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const updateAgent = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const idOrSlug = req.params.id as string;
        const userId = req.user?.id || 'default_user';
        const agent = await agentsService.updateAgent(idOrSlug, req.body, userId);
        res.json(agent);
    } catch (error: any) {
        res.status(400).json({ error: error.message || 'Failed to update agent' });
    }
};

export const deleteAgent = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const idOrSlug = req.params.id as string;
        const userId = req.user?.id || 'default_user';
        await agentsService.deleteAgent(idOrSlug, userId);
        res.status(204).send();
    } catch (error: any) {
        logger.error({ error, id: req.params.id }, 'Controller: Failed to delete agent');
        res.status(400).json({ error: error.message || 'Failed to delete agent' });
    }
};

export const getAgentCreationOptions = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const userId = req.user?.id || 'default_user';
        const options = await agentsService.getCreationOptions(userId);
        res.status(200).json(options);
    } catch (error: any) {
        logger.error({ error }, 'Controller: Failed to get agent creation options');
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const generateCreationLink = async (req: AuthenticatedRequest, res: Response) => {
    try {
        const userId = req.user?.id || 'default_user';
        const link = await agentsService.generateCreationLink(req.body, userId);
        res.status(200).json(link);
    } catch (error: any) {
        logger.error({ err: error }, 'Controller: Failed to generate creation link');
        if (error.message.startsWith('Validation Error:')) {
            return res.status(400).json({ error: error.message });
        }
        res.status(500).json({ error: 'Internal Server Error' });
    }
};


