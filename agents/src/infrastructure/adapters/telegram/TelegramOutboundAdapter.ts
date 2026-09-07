import type { Telegraf } from "telegraf";
import type { OutboundMessagingPort } from "../../../app/ports/messaging/OutboundMessagingPort.js";

export class TelegramOutboundAdapter implements OutboundMessagingPort {
  constructor(private readonly bot: Telegraf) {}

  async send(message: {
    channel: string;
    recipientId: string;
    message: string;
  }): Promise<void> {
    if (message.channel !== "telegram") {
      throw new Error(
        `TelegramOutboundAdapter cannot send on channel "${message.channel}"`,
      );
    }
    await this.bot.telegram.sendMessage(message.recipientId, message.message);
  }
}