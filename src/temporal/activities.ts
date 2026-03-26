import { ApplicationFailure } from '@temporalio/activity';
import { pool } from '../config/db.config';
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { ENV } from '../config/env.config';

export async function getAgentConfig(slug: string): Promise<any> {
  const result = await pool.query(
    `SELECT a.*, 
     COALESCE(
       (SELECT json_agg(json_build_object(
          'id', COALESCE(t.id::text, mcp.id::text, kb.id::text, kg.id::text, ac.capability_id), 
          'capability_type', ac.capability_type,
          'name', COALESCE(t.name, mcp.name, kb.name, kg.name, ac.capability_id),
          'description', COALESCE(t.description, mcp.description, kb.description, kg.description, ''),
          'input_schema', COALESCE(mcp.input_schema, (
            SELECT jsonb_build_object(
              'type', 'object',
              'properties', COALESCE(jsonb_object_agg(tp.name, jsonb_strip_nulls(jsonb_build_object(
                'type', tp.type, 
                'description', tp.description,
                'items', CASE WHEN tp.type = 'array' THEN jsonb_build_object('type', COALESCE(tp.item_type, 'string')) ELSE NULL END
              ))), '{}'::jsonb),
              'required', COALESCE((SELECT json_agg(tp2.name) FROM tool_parameters tp2 WHERE tp2.tool_id = t.id AND tp2.required = true), '[]'::json)
            )
            FROM tool_parameters tp WHERE tp.tool_id = t.id
          ), '{}'::jsonb),
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

  return result.rows[0];
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

    const response = await axios.post(`${ENV.LITELLM.AI_GATEWAY_URL}/chat/completions`, payload, {
      headers: {
        'Authorization': `Bearer ${ENV.LITELLM.API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return response.data;
  } catch (error: any) {
    console.error('LLM Call failed:', error.response?.data || error.message);
    throw ApplicationFailure.create({
      message: `LLM Call failed: ${error.response?.data?.error?.message || error.message}`,
      type: 'LLMError'
    });
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
  executionContext?: string
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

  const templatePath = path.join(__dirname, '../prompts/agent_system.prompt');
  let template: string;
  try {
    template = await fs.readFile(templatePath, 'utf8');
    template = template.replace(/^---[\s\S]*?---\n*/, '');
  } catch (err) {
    throw ApplicationFailure.create({
      message: 'System prompt template missing',
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
}): Promise<string> {
  try {
    const response = await axios.post(`${ENV.LITELLM.AI_GATEWAY_URL}/chat/completions`, {
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
    });
    return response.data.choices[0].message.content || 'Failed to summarize';
  } catch (error: any) {
    return input.content.substring(0, 5000) + '... (Truncated)';
  }
}
