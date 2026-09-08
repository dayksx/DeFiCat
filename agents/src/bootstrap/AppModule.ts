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
import { TelegramOutboundAdapter } from "../infrastructure/adapters/telegram/TelegramOutboundAdapter.js";
import { TelegramInboundAdapter } from "../infrastructure/adapters/telegram/TelegramInboundAdapter.js";
import { LangGraphConversationAdapter } from "../infrastructure/adapters/langgraph/LangGraphConversationAdapter.js";
import {
  ENS_LOOKUP_PORT,
  type EnsLookupPort,
} from "../app/ports/graph/EnsLookupPort.js";
import { TheGraphEnsAdapter } from "../infrastructure/adapters/thegraph/TheGraphEnsAdapter.js";

const TELEGRAM_BOT = Symbol("TelegramBot");

@Module({
  imports: [ConfigModule.forRoot()],
  providers: [
    {
      provide: ENS_LOOKUP_PORT,
      useFactory: (config: ConfigService) =>
        TheGraphEnsAdapter.create({
          apiKey: config.getOrThrow<string>("THEGRAPH_API_KEY"),
        }),
      inject: [ConfigService],
    },
    {
      provide: CONVERSATION_PORT,
      useFactory: (
        config: ConfigService,
        agent: Agent,
        ensLookup: EnsLookupPort,
      ) =>
        LangGraphConversationAdapter.create({
          apiKey: config.getOrThrow<string>("LITELLM_API_KEY"),
          baseURL: config.getOrThrow<string>("LITELLM_BASE_URL"),
          tavilyApiKey: config.getOrThrow<string>("TAVILY_API_KEY"),
          model:
            config.get<string>("LITELLM_MODEL") ?? "claude-haiku-4.5",
          systemPrompt: agent.persona,
          ensLookup,
        }),
      inject: [ConfigService, Agent, ENS_LOOKUP_PORT],
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
        "You are DeFiChat, a helpful DeFi assistant. For ENS names, owners, reverse records, expiry, or recent ENS transfers on Ethereum mainnet, use the lookup_ens tool (The Graph). Use web search for news and prices.",
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