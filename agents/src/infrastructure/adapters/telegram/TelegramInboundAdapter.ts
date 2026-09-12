import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { Telegraf } from "telegraf";
import { DomainError } from "../../../domain/errors/DomainError.js";
import type { HandleIncomingMessage } from "../../../app/use-cases/HandleIncomingMessage/HandleIncomingMessage.js";

@Injectable()
export class TelegramInboundAdapter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramInboundAdapter.name);

  constructor(
    private readonly bot: Telegraf,
    private readonly handleIncomingMessage: HandleIncomingMessage,
  ) {}

  async onModuleInit(): Promise<void> {
    // Telegraf's default handler rethrows, which sets a failing exit code and
    // tears down long polling: one bad update would silence the bot until a
    // manual restart.
    this.bot.catch((err, ctx) => {
      this.logger.error(
        `Dropped update ${ctx.update.update_id}`,
        err instanceof Error ? err.stack : String(err),
      );
    });

    this.bot.on("message", async (ctx) => {
      const msg = ctx.message;
      if (msg === undefined || !("text" in msg)) return;
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      try {
        await this.handleIncomingMessage.execute({
          channel: "telegram",
          recipientId: String(chatId),
          message: msg.text,
        });
      } catch (err) {
        if (err instanceof DomainError) {
          await ctx.reply(err.message);
          return;
        }
        this.logger.error(
          `Failed to handle message from chat ${chatId}`,
          err instanceof Error ? err.stack : String(err),
        );
        await ctx.reply("Sorry, I could not answer that.");
      }
    });
    // `launch()` ne résout qu'à l'arrêt du bot : l'attendre bloquerait
    // `onModuleInit`, et donc le `app.listen()` qui expose /auth/siwe.
    void this.bot
      .launch(() => this.logger.log("Telegram long polling started"))
      .catch((err) =>
        this.logger.error(
          "Telegram long polling stopped",
          err instanceof Error ? err.stack : String(err),
        ),
      );
  }

  async onModuleDestroy(): Promise<void> {
    this.bot.stop("SIGTERM");
  }
}