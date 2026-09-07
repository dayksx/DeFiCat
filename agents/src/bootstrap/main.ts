import { NestFactory } from "@nestjs/core";
import { AppModule } from "./AppModule.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();