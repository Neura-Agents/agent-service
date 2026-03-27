import { Request, Response } from 'express';
import { getTemporalClient } from '../temporal/client';
import { getEventsQuery, isCompletedQuery, pauseSignal, resumeSignal, cancelSignal } from '../temporal/workflows';
import { WorkflowHandle, WorkflowNotFoundError } from '@temporalio/client';
import { v4 as uuidv4 } from 'uuid';


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
  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowId as string);
    await handle.signal(cancelSignal);
    res.json({ status: 'success', message: 'Cancel signal sent' });
  } catch (error) {
    console.error('Error cancelling workflow:', error);
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
  } catch (error) {
    console.error('Error terminating workflow:', error);
    res.status(500).json({ error: 'Failed to terminate workflow' });
  }
};

// Helper to format SSE events exactly as requested
/**
 * WIRE FORMAT (EXACTLY)
 * event:  {EventName}\n  (TWO spaces after event: before newline)
 * data:{json_string}\n    (NO space after data:)
 * \n
 */
function sendSSEEvent(res: Response, type: string, data: any) {
  res.write(`event:  ${type}\n`);
  res.write(`data:${JSON.stringify(data)}\n\n`);
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
  isSubscription: boolean = false
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
          sendSSEEvent(res, event.type, event.data);
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
            sendSSEEvent(res, event.type, event.data);
          }
        }

        // Fire-and-forget analytics embed call (just a log for simulation)
        console.log('Final result fetch and fire-and-forget analytics...');

        res.end();
      }
    } catch (error) {
      console.error('Error polling workflow events:', error);
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

import { AuthenticatedRequest } from '../middlewares/auth.middleware';

export const triggerTemporalWorkflow = async (req: Request, res: Response) => {
  const { slug } = req.params;
  const { messages } = req.body;
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.user?.id || 'system';
  const userRoles = authReq.user?.roles || [];
  
  const workflowId = `agent-simulation-${slug}-${uuidv4()}`;

  // Set headers for SSE
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
  });

  try {
    const client = await getTemporalClient();
    const handle = await client.workflow.start('SimulatedAgentWorkflow', {
      args: [{
        slug: slug,
        messages: messages || [],
        traceId: traceId,
        userId: userId,
        userRoles: userRoles,
        maxIterations: parseInt(process.env.AGENT_MAX_ITERATIONS || '10'),
        maxToolOutputTokens: parseInt(process.env.AGENT_MAX_TOOL_OUTPUT_TOKENS || '10000'),
        maxContextTokens: parseInt(process.env.AGENT_MAX_CONTEXT_TOKENS || '50000')
      }],
      taskQueue: 'simulated-agent-queue',
      workflowId,
    });

    // Start poll loop
    await pollAndStreamEvents(res, handle, 0);

  } catch (error) {
    console.error('Error triggering workflow:', error);
    sendSSEEvent(res, 'Error', { message: 'Failed to start workflow' });
    res.end();
  }
};

export const subscribeTemporalWorkflow = async (req: Request, res: Response) => {
  const { workflowId } = req.params;

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
        sendSSEEvent(res, 'Error', { message: 'Workflow not found' });
        res.end();
        return;
      }
      throw e;
    }

    // Emit WorkflowStarted { reconnected: true }
    sendSSEEvent(res, 'WorkflowStarted', { reconnected: true, workflowId });

    // Start poll loop with last_event_count = 0 to replay history
    await pollAndStreamEvents(res, handle, 0, true);

  } catch (error) {
    console.error('Error subscribing to workflow:', error);
    sendSSEEvent(res, 'Error', { message: 'Failed to subscribe to workflow' });
    res.end();
  }
};

export const getActiveWorkflows = async (req: Request, res: Response) => {
  const { slug } = req.params;
  try {
    const client = await getTemporalClient();
    
    // Use the listOpenWorkflowExecutions to find running workflows for this slug
    const response = await client.workflowService.listOpenWorkflowExecutions({
      namespace: 'default'
    });

    const activeWorkflows = (response.executions || [])
      .filter(info => info.execution?.workflowId?.startsWith(`agent-simulation-${slug}-`))
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
