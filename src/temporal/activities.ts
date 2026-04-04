import { ApplicationFailure } from '@temporalio/activity';
import { pool } from '../config/db.config';
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { ENV } from '../config/env.config';

/**
 * Builds a JSON schema from a flat list of tool parameters, respecting hierarchy.
 */
function buildToolSchema(parameters: any[]): any {
  if (!parameters || parameters.length === 0) {
    return { type: 'object', properties: {}, required: [] };
  }

  // Create a map for quick lookup and initialize properties
  const paramMap = new Map();
  const rootParams: any[] = [];

  parameters.forEach(p => {
    paramMap.set(p.id, { ...p, properties: {}, required_fields: [] });
  });

  // Build the tree
  parameters.forEach(p => {
    if (p.parent_id && paramMap.has(p.parent_id)) {
      const parent = paramMap.get(p.parent_id);
      parent.properties[p.name] = paramMap.get(p.id);
      if (p.required) {
        parent.required_fields.push(p.name);
      }
    } else {
      rootParams.push(paramMap.get(p.id));
    }
  });

  // Recursive function to convert our tree to JSON Schema format
  const convertToSchema = (param: any): any => {
    const schema: any = {
      type: param.type,
      description: param.description || '',
    };

    if (param.type === 'object') {
      schema.properties = {};
      schema.required = param.required_fields || [];
      Object.keys(param.properties).forEach(key => {
        schema.properties[key] = convertToSchema(param.properties[key]);
      });
    } else if (param.type === 'array') {
      schema.items = param.item_type === 'object'
        ? convertToSchema({
          type: 'object',
          properties: param.properties,
          required_fields: param.required_fields
        })
        : { type: param.item_type || 'string' };
    }

    return schema;
  };

  // Build final root object
  const rootSchema: any = {
    type: 'object',
    properties: {},
    required: []
  };

  rootParams.forEach(p => {
    rootSchema.properties[p.name] = convertToSchema(p);
    if (p.required) {
      rootSchema.required.push(p.name);
    }
  });

  return rootSchema;
}

export async function getAgentConfig(slug: string): Promise<any> {
  const result = await pool.query(
    `SELECT a.*, 
     COALESCE(
       (SELECT json_agg(json_build_object(
          'id', COALESCE(t.id::text, mcp.id::text, kb.id::text, kg.id::text, ac.capability_id), 
          'capability_type', ac.capability_type,
          'name', COALESCE(t.name, mcp.name, kb.name, kg.name, ac.capability_id),
          'description', COALESCE(t.description, mcp.description, kb.description, kg.description, ''),
          'input_schema_raw', (
            SELECT json_agg(tp.*) FROM tool_parameters tp WHERE tp.tool_id = t.id
          ),
          'mcp_input_schema', mcp.input_schema,
          'base_url', t.base_url,
          'path', t.path,
          'method', t.method,
          'server_name', ms.name,
          'server_id', mcp.server_id
       ))
        FROM agent_capabilities ac 
        LEFT JOIN tools t ON ac.capability_type = 'tool' AND ac.capability_id = t.id::text
        LEFT JOIN mcp_tools mcp ON ac.capability_type = 'mcp' AND (ac.capability_id = mcp.id::text OR ac.capability_id = (mcp.name || '-' || mcp.server_id))
        LEFT JOIN mcp_servers ms ON (mcp.server_id::text = ms.server_id::text OR mcp.server_id::text = ms.id::text)
        LEFT JOIN knowledge_bases kb ON ac.capability_type = 'kb' AND ac.capability_id = kb.id::text
        LEFT JOIN knowledge_graphs kg ON ac.capability_type = 'kg' AND ac.capability_id = kg.id::text
        WHERE ac.agent_id = a.id),
       '[]'
     ) as capabilities
     FROM agents a WHERE slug = $1`,
    [slug]
  );

  if (result.rows.length === 0) {
    throw ApplicationFailure.create({
      message: `Agent with slug ${slug} not found`,
      type: 'NotFoundError',
      nonRetryable: true,
    });
  }

  const agent = result.rows[0];

  // Post-process capabilities to build proper schemas
  if (agent.capabilities) {
    agent.capabilities = agent.capabilities.map((cap: any) => {
      if (cap.capability_type === 'tool' && cap.input_schema_raw) {
        cap.input_schema = buildToolSchema(cap.input_schema_raw);
      } else if (cap.capability_type === 'mcp' && cap.mcp_input_schema) {
        cap.input_schema = cap.mcp_input_schema;
      } else {
        cap.input_schema = cap.input_schema || { type: 'object', properties: {}, required: [] };
      }
      return cap;
    });
  }

  return agent;
}

export async function callLLM(input: {
  model: string,
  systemPrompt: string,
  messages: any[],
  temperature?: number,
  maxTokens?: number,
  tools?: any[]
}): Promise<any> {
  try {
    const payload: any = {
      model: input.model,
      messages: [
        { role: 'system', content: input.systemPrompt },
        ...input.messages
      ],
      temperature: input.temperature ?? 0.7,
      max_tokens: input.maxTokens ?? 2048,
    };

    if (input.tools && input.tools.length > 0) {
      payload.tools = input.tools;
      payload.tool_choice = 'auto';
    }

    const response = await axios.post(`${ENV.LITELLM.LITELLM_URL}/chat/completions`, payload, {
      headers: {
        'Authorization': `Bearer ${ENV.LITELLM.API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const data = response.data;
    const costHeader = response.headers['x-litellm-response-cost'] || response.headers['x-litellm-cost'];

    // If usage exists in response, ensure we inject the cost from the header
    if (data.usage) {
      data.usage.total_cost = data.usage.total_cost || (costHeader ? parseFloat(costHeader) : 0);
    }

    return data;
  } catch (error: any) {
    const status = error.response?.status;
    const errorMessage = error.response?.data?.error?.message || error.response?.data?.message || error.message;
    console.error(`LLM Call failed [Status ${status}]:`, errorMessage);

    // Differentiate between retryable (5xx, 429, Network) and non-retryable (400, 401, 403, 404)
    const isNonRetryable = status && status >= 400 && status < 500 && status !== 429;

    throw ApplicationFailure.create({
      message: `LLM Call failed: ${errorMessage}`,
      type: 'LLMError',
      nonRetryable: isNonRetryable
    });
  }
}

export async function recordUsage(usage: any): Promise<void> {
  try {
    await axios.post(`${ENV.PLATFORM_SERVICE_URL}/backend/api/platform/usage`, usage, {
      headers: {
        'x-internal-key': ENV.INTERNAL_SERVICE_SECRET
      }
    });
  } catch (error: any) {
    const errorData = error.response?.data || error.message;
    console.error('Failed to record usage in platform-service:', errorData);

    // If platform-service (via billing-service) returns a termination signal
    if (error.response?.status === 402 || (typeof errorData === 'string' && errorData.includes('TERMINATE_EXECUTION'))) {
      throw ApplicationFailure.create({
        message: 'Insufficient credits to continue execution.',
        type: 'InsufficientCreditsError',
        nonRetryable: true
      });
    }
  }
}

export async function checkBalance(userId: string, currentSpent: number = 0, minAmount: number = 0.001): Promise<void> {
  try {
    const response = await axios.get(`${ENV.BILLING_SERVICE_URL}/backend/api/billing/balance`, {
      params: { userId },
      headers: {
        'x-internal-key': ENV.INTERNAL_SERVICE_SECRET
      }
    });

    const balance = parseFloat(response.data.balance || '0');
    const effectiveBalance = balance - currentSpent;

    if (effectiveBalance < minAmount) {
      throw ApplicationFailure.create({
        message: `Insufficient balance: $${balance.toFixed(4)}. Current session spent: $${currentSpent.toFixed(4)}. Effective balance: $${effectiveBalance.toFixed(4)}. Minimum $${minAmount} required to continue.`,
        type: 'InsufficientCreditsError',
        nonRetryable: true
      });
    }
  } catch (error: any) {
    if (error instanceof ApplicationFailure) throw error;

    console.error('Failed to check balance:', error.response?.data || error.message);
    if (error.response?.status === 402) {
      throw ApplicationFailure.create({
        message: 'Insufficient credits.',
        type: 'InsufficientCreditsError',
        nonRetryable: true
      });
    }
  }
}

export async function callStandardTool(input: {
  toolName: string,
  arguments: any,
  userId: string
}): Promise<any> {
  try {
    const response = await axios.post(`${ENV.TOOLS_SERVICE_URL}/backend/api/tools/execute`, {
      name: input.toolName,
      parameters: input.arguments
    }, {
      headers: {
        'x-user-id': input.userId || 'system'
      }
    });
    return response.data;
  } catch (error: any) {
    return { error: error.response?.data?.message || (error.response?.data?.error) || error.message };
  }
}

export async function callMCPTool(input: {
  serverName: string,
  toolName: string,
  arguments: any,
  userId: string
}): Promise<any> {
  try {
    const response = await axios.post(`${ENV.TOOLS_SERVICE_URL}/backend/api/mcp/call`, {
      server_id: input.serverName,
      name: input.toolName,
      arguments: input.arguments
    }, {
      headers: {
        'x-user-id': input.userId || 'system'
      }
    });
    return response.data;
  } catch (error: any) {
    return { error: error.response?.data?.details || error.message || 'Call failed' };
  }
}

export async function queryKnowledgeBase(input: {
  kbId: string,
  query: string,
  userId: string
}): Promise<any> {
  try {
    const response = await axios.post(`${ENV.TOOLS_SERVICE_URL}/backend/api/knowledge/bases/${input.kbId}/query`, {
      query: input.query,
      limit: 10
    }, {
      headers: {
        'x-user-id': input.userId || 'system'
      }
    });
    return response.data;
  } catch (error: any) {
    return { error: error.response?.data?.error || error.message || 'Call failed' };
  }
}

export async function queryKnowledgeGraph(input: {
  kgId: string,
  query: string,
  userId: string
}): Promise<any> {
  try {
    const response = await axios.post(`${ENV.TOOLS_SERVICE_URL}/backend/api/knowledge/graphs/${input.kgId}/query`, {
      query: input.query,
      depth: 2
    }, {
      headers: {
        'x-user-id': input.userId || 'system'
      }
    });
    return response.data;
  } catch (error: any) {
    return { error: error.response?.data?.error || error.message || 'Call failed' };
  }
}

export async function buildSystemPrompt(input: {
  slug: string,
  userPrompt: string,
  executionContext?: string,
  userId?: string,
  userRoles?: string[]
}): Promise<string> {
  const agent = await getAgentConfig(input.slug);

  const currentTime = new Date().toLocaleString();
  const workspacePath = process.cwd();

  const tools: any[] = [];
  const mcpTools: any[] = [];
  const kbs: any[] = [];
  const kgs: any[] = [];

  (agent.capabilities || []).forEach((cap: any) => {
    switch (cap.capability_type) {
      case 'tool': tools.push(cap); break;
      case 'mcp': mcpTools.push(cap); break;
      case 'kb': kbs.push(cap); break;
      case 'kg': kgs.push(cap); break;
    }
  });

  const formatTools = (toolList: any[]) => {
    if (toolList.length === 0) return 'None';
    return toolList.map(t =>
      `- **${t.name}**: ${t.description}\n  Arguments (schema): ${JSON.stringify(t.input_schema)}`
    ).join('\n');
  };

  const formatList = (infoList: any[]) => {
    if (infoList.length === 0) return 'None';
    return infoList.map(i => `- **${i.name.replace(/\s+/g, '_')}**: ${i.description}`).join('\n');
  };

  const formatNames = (infoList: any[]) => infoList.length > 0 ? infoList.map(i => i.name.replace(/\s+/g, '_')).join(', ') : 'None';

  let template: string;
  try {
    const userId = input.userId || 'unknown';
    const roles = input.userRoles || [];
    const agentSlug = agent.slug;

    const promptResult = await pool.query(
      `SELECT p.content, p.prompt_text 
       FROM prompts p
       JOIN prompt_types pt ON p.prompt_type_id = pt.id
       WHERE pt.name = $1 
       AND (
         $2 = ANY(p.targeting_agents) OR 
         $3 = ANY(p.targeting_users) OR 
         p.targeting_roles && $4 OR
         p.is_active = true
       )
       ORDER BY 
         ($2 = ANY(p.targeting_agents)) DESC,
         ($3 = ANY(p.targeting_users)) DESC,
         (p.targeting_roles && $4) DESC,
         p.is_active DESC
       LIMIT 1`,
      ['agent-execution', agentSlug, userId, roles]
    );

    if (promptResult.rows.length > 0) {
      template = promptResult.rows[0].prompt_text || promptResult.rows[0].content;
      if (!promptResult.rows[0].prompt_text) {
        template = template.replace(/^---[\s\S]*?---\n*/, '');
      }
    } else {
      const templatePath = path.join(__dirname, '../prompts/agent_system.prompt');
      template = await fs.readFile(templatePath, 'utf8');
      template = template.replace(/^---[\s\S]*?---\n*/, '');
    }
  } catch (err: any) {
    console.error('Prompt selection error:', err);
    throw ApplicationFailure.create({
      message: `System prompt template missing or database error: ${err.message}`,
      type: 'TemplateError',
      nonRetryable: true
    });
  }

  const replacements: Record<string, string> = {
    '${agent_name}': agent.name,
    '${agent_description}': agent.description || 'No description provided.',
    '${agent_specific_system_prompt}': agent.system_prompt || '',
    '${tools_list}': formatTools(tools),
    '${mcp_tools_list}': formatTools(mcpTools),
    '${knowledge_bases_names}': formatNames(kbs),
    '${knowledge_graphs_names}': formatNames(kgs),
    '${knowledge_bases_details}': formatList(kbs),
    '${knowledge_graphs_details}': formatList(kgs),
    '${current_time}': currentTime,
    '${workspace_path}': workspacePath,
    '${user_prompt}': input.userPrompt,
    '${execution_context}': input.executionContext || 'General execution.',
    '${llm_model}': agent.model_name
  };

  let finalPrompt = template;
  for (const [key, value] of Object.entries(replacements)) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    finalPrompt = finalPrompt.replace(new RegExp(escapedKey, 'g'), value);
  }

  return finalPrompt;
}

export async function summarizeContent(input: {
  content: string,
  model: string,
  instruction?: string
}): Promise<{ content: string, usage?: any }> {
  try {
    const response = await axios.post(`${ENV.LITELLM.LITELLM_URL}/chat/completions`, {
      model: input.model,
      messages: [
        {
          role: 'system',
          content: 'Keep the summary brief and focus on facts, code or essential data requested. Summarize under 500 characters'
        },
        {
          role: 'user',
          content: `Instruction: ${input.instruction || 'Summarize for a general AI assistant'}\n\nContent:\n${input.content}`
        }
      ],
      max_tokens: 1500
    }, {
      headers: {
        'Authorization': `Bearer ${ENV.LITELLM.API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const data = response.data;
    const costHeader = response.headers['x-litellm-response-cost'] || response.headers['x-litellm-cost'];

    let usage = data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    if (costHeader) {
      usage.total_cost = parseFloat(costHeader);
    }

    return {
      content: data.choices[0].message.content || 'Failed to summarize',
      usage
    };
  } catch (error: any) {
    return {
      content: input.content.substring(0, 5000) + '... (Truncated)',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, total_cost: 0 }
    };
  }
}
