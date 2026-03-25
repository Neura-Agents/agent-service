export interface Agent {
    id: string;
    name: string;
    slug: string;
    icon: string;
    description: string;
    version: string;
    tags: string[];
    visibility: 'private' | 'public';
    model_name: string;
    temperature: number;
    max_tokens: number;
    system_prompt: string;
    user_id: string;
    capabilities: AgentCapability[];
    created_at?: Date;
    updated_at?: Date;
    status?: string;
}

export interface AgentCapability {
    capability_id: string;
    capability_type: 'tool' | 'mcp' | 'kb' | 'kg';
}

export interface CreateAgentDTO extends Omit<Agent, 'id' | 'created_at' | 'updated_at' | 'user_id'> {
    user_id?: string;
    status?: string;
}
