import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities';
import { ENV } from '../config/env.config';


export async function runWorker() {
  const address = ENV.TEMPORAL.ADDRESS;
  const connection = await NativeConnection.connect({
    address,
  });

  const worker = await Worker.create({
    connection,
    workflowsPath: require.resolve('./workflows'),
    activities,
    taskQueue: 'simulated-agent-queue',
    namespace: ENV.TEMPORAL.NAMESPACE,
  });


  console.log(`Worker is starting on ${address}...`);
  await worker.run();
}

