import { Connection, Client } from '@temporalio/client';
import { ENV } from '../config/env.config';


let client: Client | null = null;

export async function getTemporalClient(): Promise<Client> {
  if (client) return client;

  const connection = await Connection.connect({
    address: ENV.TEMPORAL.ADDRESS,
  });

  client = new Client({
    connection,
    namespace: ENV.TEMPORAL.NAMESPACE,
  });

  return client;
}

