import axios from 'axios';
import { ENV } from '../config/env.config';
import logger from '../config/logger';

export class ModelsService {
    async getModels() {
        try {
            const url = `${ENV.LITELLM.LITELLM_URL}/model_group/info`;
            logger.info(`Fetching models from ${url}`);

            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${ENV.LITELLM.API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.data || !Array.isArray(response.data.data)) {
                return [];
            }

            return response.data.data.map((m: any) => ({
                model_name: m.model_group,
                provider: m.providers && m.providers.length > 0 ? m.providers[0] : null,
                inputtokens: m.max_input_tokens,
                outputtokens: m.max_output_tokens,
                cost_input: m.input_cost_per_token,
                cost_output: m.output_cost_per_token
            }));
        } catch (err: any) {
            logger.error({
                err: err.response?.data || err.message,
                status: err.response?.status
            }, 'Error fetching models from AI Gateway');
            throw err;
        }
    }
}
