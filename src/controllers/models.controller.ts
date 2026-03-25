import { Request, Response } from 'express';
import { ModelsService } from '../services/models.service';
import logger from '../config/logger';

const modelsService = new ModelsService();

export const getModels = async (req: Request, res: Response) => {
    try {
        const models = await modelsService.getModels();
        res.json({ data: models });
    } catch (err: any) {
        logger.error({ 
            err: err.response?.data || err.message,
            status: err.response?.status
        }, 'Failed to get models');

        res.status(err.response?.status || 500).json({
            error: true,
            message: 'Failed to fetch models',
            details: err.response?.data || err.message
        });
    }
};
