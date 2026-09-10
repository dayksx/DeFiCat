import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';
import { Agent } from '../domain/agent/Agent.js';
import { AgentId } from '../domain/agent/AgentId.js';
import { HandleIncomingMessage } from '../app/use-cases/HandleIncomingMessage/HandleIncomingMessage.js';
import {
  CONVERSATION_PORT,
  type ConversationPort,
} from '../app/ports/conversation/ConversationPort.js';
import {
  MESSAGING_PORT,
  type OutboundMessagingPort,
} from '../app/ports/messaging/OutboundMessagingPort.js';
import { TelegramOutboundAdapter } from '../infrastructure/adapters/telegram/TelegramOutboundAdapter.js';
import { TelegramInboundAdapter } from '../infrastructure/adapters/telegram/TelegramInboundAdapter.js';
import { LangGraphConversationAdapter } from '../infrastructure/adapters/langgraph/LangGraphConversationAdapter.js';
import {
  ENS_LOOKUP_PORT,
  type EnsLookupPort,
} from '../app/ports/graph/EnsLookupPort.js';
import { TheGraphEnsAdapter } from '../infrastructure/adapters/thegraph/TheGraphEnsAdapter.js';
import {
  ENS_REGISTRAR_PORT,
  type EnsRegistrarPort,
} from '../app/ports/ens/EnsRegistrarPort.js';
import { EnsPurchasePolicy } from '../domain/ens/EnsPurchasePolicy.js';
import { PurchaseEnsName } from '../app/use-cases/PurchaseEnsName/PurchaseEnsName.js';
import { ViemEnsRegistrarAdapter } from '../infrastructure/adapters/ens/ViemEnsRegistrarAdapter.js';
import { parseEther, type Hex } from 'viem';

const TELEGRAM_BOT = Symbol('TelegramBot');

@Module({
  imports: [ConfigModule.forRoot()],
  providers: [
    {
      provide: ENS_LOOKUP_PORT,
      useFactory: (config: ConfigService) =>
        TheGraphEnsAdapter.create({
          apiKey: config.getOrThrow<string>('THEGRAPH_API_KEY'),
        }),
      inject: [ConfigService],
    },
    {
      provide: ENS_REGISTRAR_PORT,
      useFactory: (config: ConfigService) =>
        ViemEnsRegistrarAdapter.create({
          privateKey: readPrivateKey(config),
          rpcUrl: config.getOrThrow<string>('ETHEREUM_RPC_URL'),
        }),
      inject: [ConfigService],
    },
    {
      provide: EnsPurchasePolicy,
      useValue: new EnsPurchasePolicy(1, 5),
    },
    {
      provide: PurchaseEnsName,
      useFactory: (
        registrar: EnsRegistrarPort,
        policy: EnsPurchasePolicy,
        config: ConfigService,
      ) =>
        new PurchaseEnsName(
          registrar,
          policy,
          parseEther(
            config.getOrThrow<string>('ENS_MAX_PURCHASE_ETH'),
          ).toString(),
        ),
      inject: [ENS_REGISTRAR_PORT, EnsPurchasePolicy, ConfigService],
    },
    {
      provide: CONVERSATION_PORT,
      useFactory: (
        config: ConfigService,
        agent: Agent,
        ensLookup: EnsLookupPort,
        purchaseEnsName: PurchaseEnsName,
      ) =>
        LangGraphConversationAdapter.create({
          apiKey: config.getOrThrow<string>('LITELLM_API_KEY'),
          baseURL: config.getOrThrow<string>('LITELLM_BASE_URL'),
          tavilyApiKey: config.getOrThrow<string>('TAVILY_API_KEY'),
          model: config.get<string>('LITELLM_MODEL') ?? 'claude-haiku-4.5',
          systemPrompt: agent.persona,
          ensLookup,
          purchaseEnsName,
          ensBuyerAllowedTelegramChatIds: new Set(
            config
              .getOrThrow<string>('ENS_BUYER_ALLOWED_TELEGRAM_CHAT_IDS')
              .split(',')
              .map((id) => id.trim())
              .filter(Boolean),
          ),
          timeZone:
            config.get<string>('AGENT_TIMEZONE') ??
            Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      inject: [ConfigService, Agent, ENS_LOOKUP_PORT, PurchaseEnsName],
    },
    {
      provide: TELEGRAM_BOT,
      useFactory: (config: ConfigService) =>
        new Telegraf(config.getOrThrow<string>('TELEGRAM_BOT_TOKEN')),
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
        AgentId.of('defichat'),
        'You are DeFiChat, a helpful DeFi assistant. For ENS data use lookup_ens. For ENS availability, quotes, and purchases use purchase_ens. Always quote first and never claim a purchase succeeded unless purchase_ens returns purchased=true. Use web search for news and prices.',
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

function readPrivateKey(config: ConfigService): Hex {
  const value = config.getOrThrow<string>('AGENT_PRIVATE_KEY').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(
      'AGENT_PRIVATE_KEY must be a 32-byte 0x-prefixed private key',
    );
  }
  return value as Hex;
}
