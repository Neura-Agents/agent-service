import { Worker } from '@temporalio/worker';
import * as activities from './activities';

async function run() {
  const worker = await Worker.create({
    workflowsPath: require.resolve('./workflows'),
    activities,
    taskQueue: 'simulated-agent-queue',
    namespace: 'default', // Using default namespace as it's the standard for local development
  });

  console.log('Worker is starting...');
  await worker.run();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
