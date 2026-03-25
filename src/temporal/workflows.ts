import {
  proxyActivities,
  defineQuery,
  defineSignal,
  setHandler,
  condition,
} from '@temporalio/workflow';
import type * as activities from './activities';

const { 
  getAgentConfig, 
  buildSystemPrompt, 
  callLLM, 
  callStandardTool, 
  callMCPTool,
  queryKnowledgeBase,
  queryKnowledgeGraph,
  summarizeContent
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
  maxIterations?: number;
  maxToolOutputTokens?: number;
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

  const history = [...(input.messages || [])];

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

  // 1. Get Agent Config
  emitEvent('info', { status: 'fetching_config' });
  try {
    const agentConfig = await getAgentConfig(input.slug);
    emitEvent('info', { 
      status: 'config_fetched', 
      name: agentConfig.name,
      capabilities: agentConfig.capabilities.map((c: any) => ({ 
        name: c.name, 
        type: c.capability_type, 
        server: c.server_name || 'NULL',
        server_id: c.server_id || 'NULL'
      }))
    });

    // 2. Build System Prompt
    const userLastPrompt = history[history.length - 1]?.content || '';
    const finalSystemPrompt = await buildSystemPrompt({ slug: input.slug, userPrompt: userLastPrompt });
    emitEvent('info', { status: 'system_prompt_built' });

    // 3. Execution Loop
    let turn = 1;
    
    while (turn <= maxIterations) {
      if (await checkPauseAndCancel(`Turn ${turn}`)) return { status: 'cancelled' };

      // --- CONTEXT WINDOW MANAGEMENT ---
      const totalHistoryLength = JSON.stringify(history).length;
      if (totalHistoryLength > maxContextChars) {
         emitEvent('info', { status: 'summarizing_history', current_length: totalHistoryLength });
         // Summarize older turns if history gets too long
         for (let i = 0; i < history.length - 1; i++) {
            if (history[i].content && history[i].content.length > 2000 && history[i].role !== 'system') {
               history[i].content = await summarizeContent({ 
                 content: history[i].content, 
                 model: agentConfig.model_name,
                 instruction: 'Provide a very high-level summary of this step to save space.'
               });
            }
         }
      }

      emitEvent('info', { status: 'thinking', turn });
      
      const llmResponse = await callLLM({
        model: agentConfig.model_name,
        systemPrompt: finalSystemPrompt,
        messages: history,
        temperature: agentConfig.temperature,
        maxTokens: agentConfig.max_tokens,
        tools: agentConfig.capabilities
          .filter((c: any) => ['tool', 'mcp', 'kb', 'kg'].includes(c.capability_type))
          .map((c: any) => {
            let schema = JSON.parse(JSON.stringify(c.input_schema || { type: 'object', properties: {}, required: [] }));
            
            // For KB/KG, ensure a query parameter exists if not defined
            if ((c.capability_type === 'kb' || c.capability_type === 'kg') && (!schema.properties || !schema.properties.query)) {
              schema.properties = schema.properties || {};
              schema.properties.query = { type: 'string', description: `Semantic search query for ${c.name}` };
              schema.required = schema.required || [];
              if (!schema.required.includes('query')) schema.required.push('query');
            }

            // Always provide capability_type to LLM for observability and disambiguation
            schema.properties = schema.properties || {};
            schema.properties.capability_type = { 
              type: 'string', 
              enum: [c.capability_type], 
              description: `The type of this capability: ${c.capability_type}`
            };
            schema.required = schema.required || [];
            if (!schema.required.includes('capability_type')) schema.required.push('capability_type');
            
            return {
              type: 'function',
              function: {
                name: c.name.replace(/\s+/g, '_'),
                description: c.description,
                parameters: fixSchema(schema)
              }
            };
          })
      });

      const assistantMessage = llmResponse.choices[0].message;
      const content = assistantMessage.content || '';
      
      // Accumulate tokens
      if (llmResponse.usage) {
        totalUsage.prompt_tokens += llmResponse.usage.prompt_tokens;
        totalUsage.completion_tokens += llmResponse.usage.completion_tokens;
        totalUsage.total_tokens += llmResponse.usage.total_tokens;
      }

      // Extract thinking
      const { thinking, remainingText } = extractThinking(content);
      if (thinking) {
        emitEvent('thinking', { content: thinking });
        // Send thinking as tokens so it's visible in the UI chat bubbles
        emitEvent('token', { delta: `> ${thinking}\n\n` });
      }

      // Check for tool calls (Native OR Regex Fallback)
      let toolCalls = parseToolCalls(assistantMessage);
      let toolCallStrings: string[] = [];

      // FALLBACK: If no native tool calls, search for JSON patterns in the content
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
              else if (content[i] === '}') {
                depth--;
                if (depth === 0) {
                  lastBrace = i;
                  break;
                }
              }
            }
            if (lastBrace !== -1) {
              jsonCandidate = content.substring(firstBrace, lastBrace + 1);
              matchedRange = [firstBrace, lastBrace + 1];
            }
          }
        }

        if (jsonCandidate) {
          try {
            const parsed = JSON.parse(jsonCandidate);
            const toolName = parsed.name || (parsed.function && parsed.function.name) || (parsed.call && parsed.call.name);
            let toolArgs = parsed.parameters || parsed.arguments || (parsed.function && parsed.function.arguments) || parsed.args;

            if (toolName) {
              toolCalls = [{
                id: `call_parsed_${Date.now()}`,
                type: 'function',
                function: {
                  name: toolName,
                  arguments: typeof toolArgs === 'object' ? JSON.stringify(toolArgs) : (toolArgs || '{}')
                }
              }];
              if (matchedRange) {
                 toolCallStrings.push(content.substring(matchedRange[0], matchedRange[1]));
              }
              emitEvent('info', { status: 'fallback_tool_detected', name: toolName });
            }
          } catch (e) {
            emitEvent('info', { status: 'json_parse_failed', error: (e as Error).message });
          }
        }
      }

      // Clean response text
      let cleanText = content.replace(/<thinking>[\s\S]*?<\/thinking>/, '');
      toolCallStrings.forEach(s => {
        cleanText = cleanText.replace(s, '');
      });
      
      const trimmedCleanText = cleanText.trim();
      const isJustFiller = toolCalls.length > 0 && 
        (trimmedCleanText.length < 100 && (trimmedCleanText.endsWith(':') || trimmedCleanText.startsWith('Here')));

      if (trimmedCleanText && !isJustFiller) {
        emitEvent('token', { delta: trimmedCleanText });
      }
      
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
          
          if (!capability) {
             emitEvent('info', { status: 'capability_not_found', tool: rawName });
          }

          switch (capability?.capability_type) {
            case 'tool':
              result = await callStandardTool({ toolName: name, arguments: parsedArgs, userId: agentConfig.user_id });
              break;
            case 'mcp':
              result = await callMCPTool({ 
                serverName: capability.server_name || capability.server_id || 'unknown', 
                toolName: name, 
                arguments: parsedArgs,
                userId: agentConfig.user_id
              });
              break;
            case 'kb':
              result = await queryKnowledgeBase({ kbId: capability.id, query: parsedArgs.query || cleanText || 'General information', userId: agentConfig.user_id });
              break;
            case 'kg':
              result = await queryKnowledgeGraph({ kgId: capability.id, query: parsedArgs.query || cleanText || 'General information', userId: agentConfig.user_id });
              break;
            default:
              result = { error: `Tool ${name} not recognized as a capability.` };
          }

          let toolContent = typeof result === 'string' ? result : JSON.stringify(result);
          if (toolContent.length > maxToolOutputChars) {
            emitEvent('info', { status: 'summarizing_tool_output', tool: name, original_length: toolContent.length });
            toolContent = await summarizeContent({ 
              content: toolContent, 
              model: agentConfig.model_name,
              instruction: `Summarize the output of the ${name} tool. Focus on the data requested: ${JSON.stringify(parsedArgs)}`
            });
          }
          emitEvent('tool_result', { name, result: toolContent, call_id: tc.id });
          
          return {
            role: 'tool',
            tool_call_id: tc.id,
            name: name,
            content: toolContent
          };
        }));

        history.push(...toolResults);
      } else {
        emitEvent('info', { status: 'no_tools_detected_finishing' });
        break;
      }

      turn++;
    }

    emitEvent('end', {
      status: 'success',
      usage: totalUsage
    });
    return { status: 'completed', usage: totalUsage };

  } catch (error: any) {
    emitEvent('Error', { message: error.message || 'Workflow internal error' });
    throw error;
  } finally {
    completed = true;
  }
}
