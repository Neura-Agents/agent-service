import { Router } from 'express';
import {
  triggerTemporalWorkflow,
  subscribeTemporalWorkflow,
  pauseTemporalWorkflow,
  resumeTemporalWorkflow,
  cancelTemporalWorkflow,
  terminateTemporalWorkflow,
  getActiveWorkflows
} from '../controllers/temporal.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();

// Apply authentication to all routes
router.use(authenticate);

// Endpoint for triggering: http://localhost:3002/<agent-slug>/stream
router.post('/:slug/stream', triggerTemporalWorkflow);

// Endpoint for checking active/running workflows: http://localhost:3002/<agent-slug>/active
router.get('/:slug/active', getActiveWorkflows);

// Lifecycle management
router.post('/workflow/pause/:workflowId', pauseTemporalWorkflow);
router.post('/workflow/resume/:workflowId', resumeTemporalWorkflow);
router.post('/workflow/cancel/:workflowId', cancelTemporalWorkflow);
router.post('/workflow/terminate/:workflowId', terminateTemporalWorkflow);


// Keep subscription route
router.get('/agent/workflow/subscribe/:workflowId', subscribeTemporalWorkflow);

export default router;
