import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { BotModule } from "./BotModule.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(BotModule);
  const config = app.get(ConfigService);
  app.enableCors({
    origin: config.getOrThrow<string>("UI_ORIGIN"),
  });
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();