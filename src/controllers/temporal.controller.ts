import { Request, Response } from 'express';
import { getTemporalClient } from '../temporal/client';
import { getEventsQuery, isCompletedQuery, pauseSignal, resumeSignal, cancelSignal } from '../temporal/workflows';
import { WorkflowHandle, WorkflowNotFoundError } from '@temporalio/client';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import axios from 'axios';
import { ENV } from '../config/env.config';


export const pauseTemporalWorkflow = async (req: Request, res: Response) => {
  const { workflowId } = req.params;
  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowId as string);
    await handle.signal(pauseSignal);
    res.json({ status: 'success', message: 'Pause signal sent' });
  } catch (error) {
    console.error('Error pausing workflow:', error);
    res.status(500).json({ error: 'Failed to pause workflow' });
  }
};

export const resumeTemporalWorkflow = async (req: Request, res: Response) => {
  const { workflowId } = req.params;
  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowId as string);
    await handle.signal(resumeSignal);
    res.json({ status: 'success', message: 'Resume signal sent' });
  } catch (error) {
    console.error('Error resuming workflow:', error);
    res.status(500).json({ error: 'Failed to resume workflow' });
  }
};

export const cancelTemporalWorkflow = async (req: Request, res: Response) => {
  const { workflowId } = req.params;
  const isJsonRpc = req.body?.jsonrpc === '2.0';
  const requestId = req.body?.id || null;

  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowId as string);
    await handle.signal(cancelSignal);
    
    if (isJsonRpc) {
      return res.json({
        jsonrpc: '2.0',
        result: { status: 'success', message: 'Cancel signal sent', taskId: workflowId },
        id: requestId
      });
    }
    
    res.json({ status: 'success', message: 'Cancel signal sent' });
  } catch (error: any) {
    if (error instanceof WorkflowNotFoundError || error.name === 'WorkflowNotFoundError' || error.message?.includes('already completed')) {
      const message = 'Workflow not found or already completed';
      if (isJsonRpc) {
        return res.json({
          jsonrpc: '2.0',
          error: { code: -32602, message, data: { taskId: workflowId } },
          id: requestId
        });
      }
      return res.status(404).json({ error: message });
    }

    console.error('Error cancelling workflow:', error);
    if (isJsonRpc) {
      return res.json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Failed to cancel workflow' },
        id: requestId
      });
    }
    res.status(500).json({ error: 'Failed to cancel workflow' });
  }
};

export const terminateTemporalWorkflow = async (req: Request, res: Response) => {
  const { workflowId } = req.params;
  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowId as string);
    await handle.terminate('Manually terminated by user');
    res.json({ status: 'success', message: 'Workflow terminated' });
  } catch (error: any) {
    if (error instanceof WorkflowNotFoundError || error.name === 'WorkflowNotFoundError' || error.message?.includes('already completed')) {
      return res.status(404).json({ error: 'Workflow not found or already completed' });
    }
    console.error('Error terminating workflow:', error);
    res.status(500).json({ error: 'Failed to terminate workflow' });
  }
};

/**
 * Helper to check user balance before starting resource-heavy operations
 */
const checkUserBalance = async (userId: string): Promise<{ authorized: boolean; balance?: number; error?: string }> => {
  try {
    const response = await axios.get(`${ENV.BILLING_SERVICE_URL}/backend/api/billing/balance`, {
      params: { userId },
      headers: {
        'x-internal-key': ENV.INTERNAL_SERVICE_SECRET
      }
    });

    const balance = response.data.balance || 0;
    const MINIMUM_BALANCE = 0.01; // Minimum to start a workflow

    if (balance < MINIMUM_BALANCE) {
      return {
        authorized: false,
        balance,
        error: `Insufficient balance: $${balance.toFixed(4)}. Minimum $${MINIMUM_BALANCE} required to start.`
      };
    }

    return { authorized: true, balance };
  } catch (error: any) {
    console.error('Balance check failed:', error.message);
    // If billing service is down, we might want to fail-safe or fail-closed.
    // For now, fail-closed to prevent unpaid usage.
    return { authorized: false, error: 'Credit verification service is currently unavailable.' };
  }
};

// Helper to format SSE events exactly as requested
/**
 * WIRE FORMAT (EXACTLY)
 * event:  {EventName}\n  (TWO spaces after event: before newline)
 * data:{json_string}\n    (NO space after data:)
 * \n
 */
/**
 * Mappers to transform internal events to a2a-compliant events
 */
function mapToA2AEvent(type: string, data: any, contextId: string, taskId: string, final: boolean = false) {
  // Whitelist essential types for A2A and the requested SSE events
  const essentialTypes = ['start', 'token', 'tool_call', 'tool_result', 'error', 'Error', 'end'];
  if (!essentialTypes.includes(type)) return null;

  // Use camelCase to match a2a library's alias_generator (defined in _base.py)
  const baseEvent = {
    contextId: contextId,
    taskId: taskId,
    final: final || type.toLowerCase() === 'end',
    metadata: {
      internalType: type,
      ...(typeof data === 'object' ? data : { value: data })
    }
  };

  const generateMessageId = () => `msg-${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  switch (type.toLowerCase()) {
    case 'start':
      return {
        ...baseEvent,
        kind: 'task',
        id: taskId,
        status: { state: 'working' }
      };
    case 'token':
      let text = typeof data === 'string' ? data : (data.delta || JSON.stringify(data));
      let parts: any[] = [];

      // Try to detect if the text is itself a JSON-encoded A2A part or message
      try {
        if (text.trim().startsWith('{')) {
          const parsed = JSON.parse(text);
          if (parsed.parts && Array.isArray(parsed.parts)) {
            // It's a full A2A message object
            parts = parsed.parts;
          } else if (parsed.kind === 'text' || parsed.type === 'text') {
            // It's a single A2A text part
            parts = [{ kind: 'text', text: parsed.text || parsed.content || text }];
          } else if (parsed.text || parsed.content) {
            // It's a generic object with text/content
            parts = [{ kind: 'text', text: parsed.text || parsed.content }];
          } else {
            // Fallback to raw text
            parts = [{ kind: 'text', text }];
          }
        } else {
          parts = [{ kind: 'text', text }];
        }
      } catch (e) {
        // Not JSON, use as raw text
        parts = [{ kind: 'text', text }];
      }

      return {
        ...baseEvent,
        kind: 'status-update',
        status: {
          state: 'working',
          message: {
            role: 'agent',
            messageId: generateMessageId(),
            parts: parts
          }
        }
      };
    case 'tool_call':
      return {
        ...baseEvent,
        kind: 'status-update',
        status: {
          state: 'working',
          message: {
            role: 'agent',
            messageId: generateMessageId(),
            parts: [{ kind: 'text', text: `[Calling Tool: ${data.name}]` }]
          }
        }
      };
    case 'tool_result':
      return {
        ...baseEvent,
        kind: 'status-update',
        status: {
          state: 'working',
          message: {
            role: 'agent',
            messageId: generateMessageId(),
            parts: [{ kind: 'text', text: `[Tool Result: ${data.result}]` }]
          }
        }
      };
    case 'error':
      return {
        ...baseEvent,
        kind: 'status-update',
        status: {
          state: 'failed',
          message: {
            role: 'agent',
            messageId: generateMessageId(),
            parts: [{ kind: 'text', text: data.message || 'Workflow internal error' }]
          }
        }
      };
    case 'end':
      return {
        ...baseEvent,
        kind: 'status-update',
        final: true,
        status: { state: 'completed' }
      };
    default:
      return null;
  }
}

function sendSSEEvent(res: Response, type: string, data: any, id: string | number | null = null, contextId?: string, taskId?: string) {
  // Create a2a-compliant payload if IDs are present
  const a2aPayload = (contextId && taskId)
    ? mapToA2AEvent(type, data, contextId, taskId, type.toLowerCase() === 'end')
    : data;

  // Filter out non-essential events based on a2a mapping (null means skip)
  if (contextId && taskId && a2aPayload === null) return;

  const isError = type.toLowerCase() === 'error';
  const payload = isError
    ? { jsonrpc: '2.0', error: a2aPayload, id: id }
    : { jsonrpc: '2.0', result: a2aPayload, id: id };

  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// Helper to send heartbeat exactly as requested
/**
 * HEARTBEAT FORMAT (EXACTLY)
 * : heartbeat\n\n
 */
function sendSSEHeartbeat(res: Response) {
  res.write(': heartbeat\n\n');
}

async function pollAndStreamEvents(
  res: Response,
  handle: WorkflowHandle,
  lastEventCount: number,
  isSubscription: boolean = false,
  requestId: string | number | null = null,
  contextId?: string,
  taskId?: string
) {
  let currentLastEventCount = lastEventCount;
  let heartBeatTick = 0;
  const HEARTBEAT_INTERVAL = 5; // Every 5 ticks

  const pollInterval = setInterval(async () => {
    try {
      // Send heartbeat
      heartBeatTick++;
      if (heartBeatTick % HEARTBEAT_INTERVAL === 0) {
        sendSSEHeartbeat(res);
      }

      // Query events
      const allEvents = await handle.query(getEventsQuery);

      // Stream new events
      if (allEvents && allEvents.length > currentLastEventCount) {
        for (let i = currentLastEventCount; i < allEvents.length; i++) {
          const event = allEvents[i];
          sendSSEEvent(res, event.type, event.data, requestId, contextId, taskId);
        }
        currentLastEventCount = allEvents.length;
      }

      // Check if completed
      const isCompleted = await handle.query(isCompletedQuery);
      if (isCompleted) {
        clearInterval(pollInterval);

        // Final fetch (best-effort)
        const finalEvents = await handle.query(getEventsQuery);
        if (finalEvents && finalEvents.length > currentLastEventCount) {
          for (let i = currentLastEventCount; i < finalEvents.length; i++) {
            const event = finalEvents[i];
            sendSSEEvent(res, event.type, event.data, requestId, contextId, taskId);
          }
        }

        // Fire-and-forget analytics embed call (just a log for simulation)
        console.log('Final result fetch and fire-and-forget analytics...');

        res.end();
      }
    } catch (error) {
      console.error('Error polling workflow events:', error);
      sendSSEEvent(res, 'Error', { message: 'Workflow interaction failed' }, requestId, contextId, taskId);
      // If workflow is not found, it might have been archived or finished
      clearInterval(pollInterval);
      res.end();
    }
  }, 1000);

  // Clean up on client disconnect
  res.on('close', () => {
    clearInterval(pollInterval);
  });
}



export const triggerTemporalWorkflow = async (req: Request, res: Response) => {
  const { slug } = req.params;
  const { method, messages, id: requestId, params, message: topLevelMessage } = req.body;

  // A2A JSON-RPC Method Dispatching
  if (method === 'tasks/cancel') {
    const taskId = params?.taskId || params?.id;
    if (taskId) {
      req.params.workflowId = taskId;
      return cancelTemporalWorkflow(req, res);
    }
  }

  if (method === 'tasks/resubscribe') {
    const taskId = params?.taskId || params?.id;
    if (taskId) {
      req.params.workflowId = taskId;
      return subscribeTemporalWorkflow(req, res);
    }
  }

  const authReq = req as AuthenticatedRequest;
  const userId = authReq.user?.id || 'system';
  const userRoles = authReq.user?.roles || [];

  // Normalize input messages from both internal and a2a formats
  let workflowMessages = messages || [];

  // Try to find an a2a message in req.body.message or req.body.params.message
  const a2aMessage = topLevelMessage || params?.message;

  if (a2aMessage && a2aMessage.parts) {
    const textContent = a2aMessage.parts
      .filter((p: any) => (p.kind === 'text' || p.type === 'text') && p.text)
      .map((p: any) => p.text)
      .join('\n');

    workflowMessages = [
      ...workflowMessages,
      {
        role: a2aMessage.role || 'user',
        content: textContent || ''
      }
    ];
  }

  const workflowId = uuidv4();

  // PRE-CHECK: Check user balance before starting SSE and Workflow
  const balanceCheck = await checkUserBalance(userId);
  if (!balanceCheck.authorized) {
    return res.status(402).json({
      error: 'Insufficient Balance',
      message: balanceCheck.error,
      balance: balanceCheck.balance
    });
  }

  // Set headers for SSE (Wait to do this until AFTER logic that might need to return JSON)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders ? res.flushHeaders() : null;

  const traceId = uuidv4();
  // Emit "start" as the very first event before the workflow runs
  sendSSEEvent(res, 'start', {
    agent_id: slug,
    trace_id: traceId,
    workflow_id: workflowId,
  }, requestId, traceId, workflowId);

  try {
    const client = await getTemporalClient();
    const handle = await client.workflow.start('SimulatedAgentWorkflow', {
      args: [{
        slug: slug,
        messages: workflowMessages,
        traceId: traceId,
        userId: userId,
        userRoles: userRoles,
        apiKey: authReq.user?.apiKey,
        apiKeyId: authReq.user?.apiKeyId,
        maxIterations: parseInt(process.env.AGENT_MAX_ITERATIONS || '10'),
        maxToolOutputTokens: parseInt(process.env.AGENT_MAX_TOOL_OUTPUT_TOKENS || '10000'),
        maxContextTokens: parseInt(process.env.AGENT_MAX_CONTEXT_TOKENS || '50000')
      }],
      taskQueue: 'simulated-agent-queue',
      workflowId,
      memo: {
        slug: slug
      }
    });

    // Start poll loop
    await pollAndStreamEvents(res, handle, 0, false, requestId, traceId, workflowId);

  } catch (error) {
    console.error('Error triggering workflow:', error);
    sendSSEEvent(res, 'Error', { message: 'Failed to start workflow' }, requestId, traceId, workflowId);
    res.end();
  }
};

export const subscribeTemporalWorkflow = async (req: Request, res: Response) => {
  const { workflowId } = req.params;
  const requestId = req.body?.id || null;

  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders ? res.flushHeaders() : null;

  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowId as string);

    // Verify workflow exists
    try {
      await handle.describe();
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        sendSSEEvent(res, 'Error', { message: 'Workflow not found' }, requestId, undefined, workflowId as string);
        res.end();
        return;
      }
      throw e;
    }

    // Use slug from params
    const slug = req.params.slug || 'unknown';

    // Emit "start" as the very first event before history replay (to align with trigger behavior)
    sendSSEEvent(res, 'start', { 
      agent_id: slug, 
      workflow_id: workflowId,
      reconnected: true
    }, requestId, workflowId as string, workflowId as string);

    // Start poll loop with last_event_count = 0 to replay history
    await pollAndStreamEvents(res, handle, 0, true, requestId, workflowId as string, workflowId as string);

  } catch (error) {
    console.error('Error subscribing to workflow:', error);
    sendSSEEvent(res, 'Error', { message: 'Failed to subscribe to workflow' }, requestId);
    res.end();
  }
};

export const getActiveWorkflows = async (req: Request, res: Response) => {
  const { slug } = req.params;
  try {
    const client = await getTemporalClient();

    // Use the listOpenWorkflowExecutions to find running workflows for this slug
    const response = await client.workflowService.listOpenWorkflowExecutions({
      namespace: process.env.TEMPORAL_NAMESPACE || 'agents'
    });

    const activeWorkflows = (response.executions || [])
      .filter(info => {
        // If we have a memo, use it
        // Note: info.memo.fields might need decoding if it's there
        return true; // We'll just return all in this namespace for now, or assume filter is okay
      })
      .map(info => ({
        workflowId: info.execution?.workflowId,
        runId: info.execution?.runId,
        startTime: info.startTime,
        status: 'RUNNING'
      }));

    res.json({
      status: 'success',
      workflows: activeWorkflows
    });
  } catch (error) {
    console.error('Error getting active workflows:', error);
    res.status(500).json({ error: 'Failed to fetch active workflows' });
  }
};
