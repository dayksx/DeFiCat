import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Telegraf } from "telegraf";
import { Agent } from "../domain/agent/Agent.js";
import { AgentId } from "../domain/agent/AgentId.js";
import { HandleIncomingMessage } from "../app/use-cases/HandleIncomingMessage/HandleIncomingMessage.js";
import {
  CONVERSATION_PORT,
  type ConversationPort,
} from "../app/ports/conversation/ConversationPort.js";
import {
  MESSAGING_PORT,
  type OutboundMessagingPort,
} from "../app/ports/messaging/OutboundMessagingPort.js";
import { EchoConversationAdapter } from "../infrastructure/adapters/echo/EchoConversationAdapter.js";
import { TelegramOutboundAdapter } from "../infrastructure/adapters/telegram/TelegramOutboundAdapter.js";
import { TelegramInboundAdapter } from "../infrastructure/adapters/telegram/TelegramInboundAdapter.js";

const TELEGRAM_BOT = Symbol("TelegramBot");

@Module({
  imports: [ConfigModule.forRoot()],
  providers: [
    {
      provide: CONVERSATION_PORT,
      useClass: EchoConversationAdapter,
    },
    {
      provide: TELEGRAM_BOT,
      useFactory: (config: ConfigService) =>
        new Telegraf(config.getOrThrow<string>("TELEGRAM_BOT_TOKEN")),
      inject: [ConfigService],
    },
    {
      provide: MESSAGING_PORT,
      useFactory: (bot: Telegraf) => new TelegramOutboundAdapter(bot),
      inject: [TELEGRAM_BOT],
    },
    {
      provide: Agent,
      useValue: new Agent(
        AgentId.of("defichat"),
        "You are DeFiChat, a helpful DeFi assistant.",
      ),
    },
    {
      provide: HandleIncomingMessage,
      useFactory: (
        conversation: ConversationPort,
        messaging: OutboundMessagingPort,
        agent: Agent,
      ) => new HandleIncomingMessage(conversation, messaging, agent),
      inject: [CONVERSATION_PORT, MESSAGING_PORT, Agent],
    },
    {
      provide: TelegramInboundAdapter,
      useFactory: (bot: Telegraf, uc: HandleIncomingMessage) =>
        new TelegramInboundAdapter(bot, uc),
      inject: [TELEGRAM_BOT, HandleIncomingMessage],
    },
  ],
})
export class AppModule {}