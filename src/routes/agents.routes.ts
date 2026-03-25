import { Router } from 'express';
import { createAgent, listAgents, getAgentById, updateAgent, deleteAgent, getAgentCreationOptions, generateCreationLink } from '../controllers/agents.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();

router.post('/', authenticate, createAgent);
router.get('/', authenticate, listAgents);
router.get('/creation-options', authenticate, getAgentCreationOptions);
router.post('/generation-link', authenticate, generateCreationLink);
router.get('/:id', authenticate, getAgentById);
router.put('/:id', authenticate, updateAgent);
router.delete('/:id', authenticate, deleteAgent);

export default router;

