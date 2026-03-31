import {
  proxyActivities,
  defineQuery,
  defineSignal,
  setHandler,
  condition,
} from '@temporalio/workflow';
import type * as activities from './activities';

const { callLLM } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2m',
  retry: {
    maximumAttempts: 3,
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumInterval: '30s',
  }
});

const { 
  getAgentConfig, 
  buildSystemPrompt, 
  callStandardTool, 
  callMCPTool,
  queryKnowledgeBase,
  queryKnowledgeGraph,
  summarizeContent,
  recordUsage,
  checkBalance
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '2m',
});

export const getEventsQuery = defineQuery<Array<{ type: string, data: object, timestamp: string }>>('getEvents');
// ... rest of queries and signals ...
export const isCompletedQuery = defineQuery<boolean>('isCompleted');
export const getStatusQuery = defineQuery<string>('getStatus');

export const pauseSignal = defineSignal('pauseWorkflow');
export const resumeSignal = defineSignal('resumeWorkflow');
export const cancelSignal = defineSignal('cancelWorkflow');

export interface SimulatedAgentInput {
  slug: string;
  messages?: any[];
  traceId?: string;
  userId?: string;
  userRoles?: string[];
  apiKey?: string; // Track the API Key used (hash/raw)
  apiKeyId?: string; // Explicit ID for DB tracking
  maxIterations?: number;
  maxToolOutputTokens?: number;
  maxToolOutputChars?: number;
  maxContextTokens?: number;
}

/**
 * Parses tool calls from LLM response if they are in the message's tool_calls field
 * or if they are embedded in the text (fallback - though we prefer native tool calling).
 */
function parseToolCalls(message: any): any[] {
  if (message.tool_calls && message.tool_calls.length > 0) {
    return message.tool_calls;
  }
  return [];
}

/**
 * Extracts <thinking> content from text
 */
function extractThinking(text: string): { thinking: string, remainingText: string } {
  const match = text.match(/<thinking>([\s\S]*?)<\/thinking>/);
  if (match) {
    return {
      thinking: match[1].trim(),
      remainingText: text.replace(match[0], '').trim()
    };
  }
  return { thinking: '', remainingText: text };
}

/**
 * Ensures that all 'array' type properties in a JSON schema have an 'items' field.
 * Gemini/Google AI API requires this.
 */
function fixSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;

  if (schema.type === 'array' && !schema.items) {
    schema.items = { type: 'string' }; // Default to string if unknown
  }

  if (schema.properties) {
    for (const key in schema.properties) {
      schema.properties[key] = fixSchema(schema.properties[key]);
    }
  }

  if (schema.items) {
    schema.items = fixSchema(schema.items);
  }

  return schema;
}

export async function SimulatedAgentWorkflow(input: SimulatedAgentInput): Promise<object> {
  const currentEvents: Array<{ type: string, data: object, timestamp: string }> = [];
  let completed = false;
  let status = 'RUNNING';
  let isPaused = false;
  let isCancelled = false;
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let totalCost = 0;
  const llmUsageHistory: any[] = [];
  let usageRecorded = false;
  let finalAssistantResponse: string | null = null;
  const history = [...(input.messages || [])];
  const initialUserMessage = history.length > 0 ? history[history.length - 1] : null;

  let recordIncrementalUsage: (status: string, incrementalUsage?: any, overrideResponse?: string) => Promise<void> = async () => {};

  // Thresholds with defaults
  const maxIterations = input.maxIterations || 10;
  const maxToolOutputChars = (input.maxToolOutputTokens || 10000) * 4;
  const maxContextChars = (input.maxContextTokens || 50000) * 4;

  const emitEvent = (type: string, data: object) => {
    currentEvents.push({
      type,
      data,
      timestamp: new Date().toISOString(),
    });
  };

  setHandler(getEventsQuery, () => currentEvents);
  setHandler(isCompletedQuery, () => completed);
  setHandler(getStatusQuery, () => status);
  setHandler(pauseSignal, () => { isPaused = true; });
  setHandler(resumeSignal, () => { isPaused = false; });
  setHandler(cancelSignal, () => { isCancelled = true; });

  const checkPauseAndCancel = async (stepInfo: string): Promise<boolean> => {
    if (isCancelled) {
      status = 'CANCELLED';
      emitEvent('end', { status: 'cancelled', message: 'Workflow cancelled by user' });
      completed = true;
      return true;
    }
    if (isPaused) {
      status = 'PAUSED';
      emitEvent('info', { status: 'paused', step: stepInfo });
      await condition(() => !isPaused || isCancelled);
      if (isCancelled) {
        status = 'CANCELLED';
        emitEvent('end', { status: 'cancelled', details: 'cancelled during pause' });
        completed = true;
        return true;
      }
      status = 'RUNNING';
      emitEvent('info', { status: 'resumed', step: stepInfo });
    }
    return false;
  };

  try {
    // 1. Get Agent Config
    emitEvent('info', { status: 'fetching_config' });
    const agentConfig = await getAgentConfig(input.slug);
    
    // 1.5 Check Credits Balance (Initial)
    if (input.userId) {
        await checkBalance(input.userId, 0); 
    }
    
    emitEvent('info', { 
      status: 'config_fetched', 
      name: agentConfig.name,
      capabilities: (agentConfig.capabilities || []).map((c: any) => ({ 
        name: c.name, 
        type: c.capability_type, 
        server: c.server_name || 'NULL',
        server_id: c.server_id || 'NULL'
      }))
    });

    recordIncrementalUsage = async (status: string, incrementalUsage?: any, overrideResponse?: string) => {
      try {
        const usagePayload: any = {
            execution_id: input.traceId,
            resource_id: input.slug,
            resource_type: 'agent',
            action_type: 'execution',
            api_key: input.apiKeyId || input.apiKey,
            user_id: input.userId,
            total_input_tokens: incrementalUsage?.prompt_tokens || 0,
            total_completion_tokens: incrementalUsage?.completion_tokens || 0,
            total_tokens: incrementalUsage?.total_tokens || 0,
            total_cost: incrementalUsage?.total_cost || 0,
            initial_request: initialUserMessage,
            final_response: overrideResponse || finalAssistantResponse || (status === 'RUNNING' ? 'In progress...' : 'No content'),
            llm_calls: incrementalUsage ? [{
                model: agentConfig.model_name,
                tokens: incrementalUsage,
                cost: incrementalUsage.total_cost || 0,
                timestamp: new Date().toISOString()
            }] : []
        };
        await recordUsage(usagePayload);
      } catch (e: any) {
        if (e.type === 'InsufficientCreditsError') throw e;
        console.error('Failed to record incremental usage:', e);
      }
    };

    // 2. Build System Prompt
    const userLastPrompt = history[history.length - 1]?.content || '';
    const finalSystemPrompt = (await buildSystemPrompt({ 
      slug: input.slug, 
      userPrompt: userLastPrompt,
      userId: input.userId,
      userRoles: input.userRoles
    })) + '\n\nIMPORTANT: Do not include ANY internal thinking process, monologue, or <thinking> tags in your output. Provide ONLY the final response or tool calls directly.';
    emitEvent('info', { status: 'system_prompt_built' });

    // 3. Execution Loop
    let turn = 1;
    
    // --- ENSURE FIRST MESSAGE ---
    if (history.length === 0) {
      history.push({ role: 'user', content: 'Hello' });
      emitEvent('info', { status: 'injected_starter_message' });
    }

    while (turn <= maxIterations) {
      if (await checkPauseAndCancel(`Turn ${turn}`)) return { status: 'cancelled' };

      // --- CONTEXT WINDOW MANAGEMENT ---
      const totalHistoryLength = JSON.stringify(history).length;
      if (totalHistoryLength > maxContextChars) {
          emitEvent('info', { status: 'summarizing_history', current_length: totalHistoryLength });
          for (let i = 0; i < history.length - 1; i++) {
             if (history[i].content && history[i].content.length > 2000 && history[i].role !== 'system') {
                const summaryResult = await summarizeContent({ 
                  content: history[i].content, 
                  model: agentConfig.model_name,
                  instruction: 'Provide a very high-level summary of this step to save space.'
                });
                history[i].content = summaryResult.content;
                
                if (summaryResult.usage) {
                    totalUsage.prompt_tokens += summaryResult.usage.prompt_tokens || 0;
                    totalUsage.completion_tokens += summaryResult.usage.completion_tokens || 0;
                    totalUsage.total_tokens += summaryResult.usage.total_tokens || 0;
                    totalCost += summaryResult.usage.total_cost || 0;
                    
                    // INCREMENTAL RECORDING (FOR SUMMARIZATION)
                    await recordIncrementalUsage('RUNNING', summaryResult.usage);
                }
                
                // Check balance after summarization
                if (input.userId) {
                    await checkBalance(input.userId, 0);
                }
             }
          }
      }

      emitEvent('info', { status: 'executing_turn', turn });
      
      const payload: any = {
        model: agentConfig.model_name,
        systemPrompt: finalSystemPrompt,
        messages: history,
        temperature: agentConfig.temperature,
        maxTokens: agentConfig.max_tokens,
      };

      const agentTools = (agentConfig.capabilities || [])
        .filter((c: any) => ['tool', 'mcp', 'kb', 'kg'].includes(c.capability_type))
        .map((c: any) => {
          let schema = JSON.parse(JSON.stringify(c.input_schema || { type: 'object', properties: {}, required: [] }));
          if ((c.capability_type === 'kb' || c.capability_type === 'kg') && (!schema.properties || !schema.properties.query)) {
            schema.properties = schema.properties || {};
            schema.properties.query = { type: 'string', description: `Semantic search query for ${c.name}` };
            schema.required = schema.required || [];
            if (!schema.required.includes('query')) schema.required.push('query');
          }
          schema.properties = schema.properties || {};
          schema.properties.capability_type = { type: 'string', enum: [c.capability_type], description: `Type: ${c.capability_type}` };
          schema.required = schema.required || [];
          if (!schema.required.includes('capability_type')) schema.required.push('capability_type');
          return { type: 'function', function: { name: c.name.replace(/\s+/g, '_'), description: c.description, parameters: fixSchema(schema) }};
        });

      if (agentTools.length > 0) {
        payload.tools = agentTools;
      }

      const llmResponse = await callLLM(payload);
      const assistantMessage = llmResponse.choices[0].message;
      const content = assistantMessage.content || '';
      
      // Track detailed usage
      if (llmResponse.usage) {
        const usage = llmResponse.usage;
        totalUsage.prompt_tokens += usage.prompt_tokens;
        totalUsage.completion_tokens += usage.completion_tokens;
        totalUsage.total_tokens += usage.total_tokens;
        totalCost += (usage.total_cost || 0);

        // INCREMENTAL RECORDING (FOR MAIN TURN)
        await recordIncrementalUsage('RUNNING', usage);

        // Check balance after primary LLM call
        if (input.userId) {
            await checkBalance(input.userId, 0);
        }
      }

      let toolCalls = parseToolCalls(assistantMessage);
      let toolCallStrings: string[] = [];

      if (toolCalls.length === 0) {
        let jsonCandidate = '';
        let matchedRange: [number, number] | null = null;
        const markdownMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (markdownMatch) {
          jsonCandidate = markdownMatch[1].trim();
          matchedRange = [markdownMatch.index!, markdownMatch.index! + markdownMatch[0].length];
        } else {
          const firstBrace = content.indexOf('{');
          if (firstBrace !== -1) {
            let depth = 0;
            let lastBrace = -1;
            for (let i = firstBrace; i < content.length; i++) {
              if (content[i] === '{') depth++;
              else if (content[i] === '}') { depth--; if (depth === 0) { lastBrace = i; break; } }
            }
            if (lastBrace !== -1) { jsonCandidate = content.substring(firstBrace, lastBrace + 1); matchedRange = [firstBrace, lastBrace + 1]; }
          }
        }
        if (jsonCandidate) {
          try {
            const parsed = JSON.parse(jsonCandidate);
            const toolName = parsed.name || (parsed.function && parsed.function.name) || (parsed.call && parsed.call.name);
            let toolArgs = parsed.parameters || parsed.arguments || (parsed.function && parsed.function.arguments) || parsed.args;
            if (toolName) {
              toolCalls = [{ id: `call_parsed_${Date.now()}`, type: 'function', function: { name: toolName, arguments: typeof toolArgs === 'object' ? JSON.stringify(toolArgs) : (toolArgs || '{}') } }];
              if (matchedRange) toolCallStrings.push(content.substring(matchedRange[0], matchedRange[1]));
              emitEvent('info', { status: 'fallback_tool_detected', name: toolName });
            }
          } catch (e) { /* silent fail */ }
        }
      }

      let cleanText = content.replace(/<thinking>[\s\S]*?<\/thinking>/, '');
      toolCallStrings.forEach(s => { cleanText = cleanText.replace(s, ''); });
      const trimmedCleanText = cleanText.trim();
      const isJustFiller = toolCalls.length > 0 && (trimmedCleanText.length < 100 && (trimmedCleanText.endsWith(':') || trimmedCleanText.startsWith('Here')));
      if (trimmedCleanText && !isJustFiller) emitEvent('token', { delta: trimmedCleanText });
      
      if (toolCalls.length > 0) {
        emitEvent('info', { status: 'executing_tools', count: toolCalls.length });
        history.push(assistantMessage);
        
        const toolResults = await Promise.all(toolCalls.map(async (tc: any) => {
          const rawName = tc.function.name;
          const args = tc.function.arguments;
          const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
          const normalizedCalledName = decodeURIComponent(rawName).toLowerCase().replace(/[\s_-]/g, '');
          const capability = agentConfig.capabilities.find((c: any) => {
             const normalizedCapName = c.name.toLowerCase().replace(/[\s_-]/g, '');
             return normalizedCapName === normalizedCalledName || c.name === rawName;
          });
          const name = capability ? capability.name : rawName;
          emitEvent('tool_call', { name, arguments: parsedArgs, call_id: tc.id });
          
          let result: any;
          switch (capability?.capability_type) {
            case 'tool': result = await callStandardTool({ toolName: name, arguments: parsedArgs, userId: agentConfig.user_id }); break;
            case 'mcp': result = await callMCPTool({ serverName: capability.server_name || capability.server_id || 'unknown', toolName: name, arguments: parsedArgs, userId: agentConfig.user_id }); break;
            case 'kb': result = await queryKnowledgeBase({ kbId: capability.id, query: parsedArgs.query || cleanText || 'General information', userId: agentConfig.user_id }); break;
            case 'kg': result = await queryKnowledgeGraph({ kgId: capability.id, query: parsedArgs.query || cleanText || 'General information', userId: agentConfig.user_id }); break;
            default: result = { error: `Tool ${name} not recognized.` };
          }

          let toolContent = typeof result === 'string' ? result : JSON.stringify(result);
          if (toolContent.length > maxToolOutputChars) {
            const summaryResult = await summarizeContent({ 
                content: toolContent, 
                model: agentConfig.model_name, 
                instruction: `Summarize output of and focus on: ${JSON.stringify(parsedArgs)}` 
            });
            toolContent = summaryResult.content;
            
            if (summaryResult.usage) {
                totalUsage.prompt_tokens += summaryResult.usage.prompt_tokens || 0;
                totalUsage.completion_tokens += summaryResult.usage.completion_tokens || 0;
                totalUsage.total_tokens += summaryResult.usage.total_tokens || 0;
                totalCost += summaryResult.usage.total_cost || 0;

                // INCREMENTAL RECORDING (FOR TOOL OUTPUT SUMMARIZATION)
                await recordIncrementalUsage('RUNNING', summaryResult.usage);

                // Check balance after tool output summarization
                if (input.userId) {
                    await checkBalance(input.userId, 0);
                }
            }
          }
          emitEvent('tool_result', { name, result: toolContent, call_id: tc.id });
          return { role: 'tool', tool_call_id: tc.id, name: name, content: toolContent };
        }));
        history.push(...toolResults);
      } else {
        finalAssistantResponse = content;
        emitEvent('info', { status: 'finishing' });
        break;
      }
      turn++;
    }

    emitEvent('end', { status: 'success', usage: totalUsage });
    
    // Final update to set the finalized response
    await recordIncrementalUsage('SUCCESS', undefined, finalAssistantResponse || 'Execution completed');

    return { status: 'completed', usage: totalUsage };

  } catch (error: any) {
    status = 'FAILED';
    console.error('Workflow execution error:', error);
    
    let errorMessage = error.message || 'Workflow internal error';
    if (error.cause && error.cause.message) {
        errorMessage = error.cause.message;
    } else if (error.details && error.details[0]) {
        errorMessage = error.details[0];
    }

    emitEvent('Error', { message: errorMessage });
    
    // FINAL RECORDING ON ERROR (No new tokens, just status update)
    await recordIncrementalUsage('FAILED', undefined, `Error: ${errorMessage}`);

    throw error;
  } finally {
    completed = true;
  }
}
