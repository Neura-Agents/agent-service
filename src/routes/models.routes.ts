import { Router } from 'express';
import { getModels } from '../controllers/models.controller';

const router = Router();

router.get('/list', getModels);

export default router;
