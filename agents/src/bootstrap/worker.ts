import { NestFactory } from '@nestjs/core';
import type { Worker } from '@temporalio/worker';
import { TEMPORAL_WORKER, WorkerModule } from './WorkerModule.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const worker = app.get<Worker>(TEMPORAL_WORKER);

  // `worker.run()` ne rend la main qu'à l'arrêt : on laisse les activités en
  // cours se terminer plutôt que de couper une transaction en vol.
  const shutdown = () => worker.shutdown();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    await worker.run();
  } finally {
    await app.close();
  }
}

void bootstrap();
