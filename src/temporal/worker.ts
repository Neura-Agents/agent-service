import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities';

export async function runWorker() {
  const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  const connection = await NativeConnection.connect({
    address,
  });

  const worker = await Worker.create({
    connection,
    workflowsPath: require.resolve('./workflows'),
    activities,
    taskQueue: 'simulated-agent-queue',
    namespace: process.env.TEMPORAL_NAMESPACE || 'default',
  });

  console.log(`Worker is starting on ${address}...`);
  await worker.run();
}

