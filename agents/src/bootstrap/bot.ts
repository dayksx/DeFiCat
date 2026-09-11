import { NestFactory } from '@nestjs/core';
import { BotModule } from './BotModule.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(BotModule);
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
