import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import {
  ENS_LOOKUP_PORT,
  type EnsLookupPort,
} from '../app/ports/graph/EnsLookupPort.js';
import {
  ENS_WATCH_SCHEDULER_PORT,
  type EnsWatchSchedulerPort,
} from '../app/ports/watch/EnsWatchSchedulerPort.js';
import { EnsPurchasePolicy } from '../domain/ens/EnsPurchasePolicy.js';
import { PurchaseEnsName } from '../app/use-cases/PurchaseEnsName/PurchaseEnsName.js';
import { ScheduleEnsPurchase } from '../app/use-cases/ScheduleEnsPurchase/ScheduleEnsPurchase.js';
import { CancelEnsWatch } from '../app/use-cases/ScheduleEnsPurchase/CancelEnsWatch.js';
import { ListEnsWatches } from '../app/use-cases/ScheduleEnsPurchase/ListEnsWatches.js';
import { TemporalWatchSchedulerAdapter } from '../infrastructure/adapters/temporal/TemporalWatchSchedulerAdapter.js';
import { readTemporalConfig } from '../infrastructure/adapters/temporal/temporal.config.js';
import { Client, Connection } from '@temporalio/client';
import { TelegramInboundAdapter } from '../infrastructure/adapters/telegram/TelegramInboundAdapter.js';
import { LangGraphConversationAdapter } from '../infrastructure/adapters/langgraph/LangGraphConversationAdapter.js';
import { InMemoryEnsWatchScheduler } from '../infrastructure/adapters/watch/InMemoryEnsWatchScheduler.js';
import {
  EnsCoreModule,
  ENS_BUYER_CHAT_IDS,
  TELEGRAM_BOT,
} from './EnsCoreModule.js';

/**
 * Composition root du processus bot : Nest câble ports → adapters, sans métier.
 * Les adapters partagés avec le worker viennent d'`EnsCoreModule`.
 *
 * Flux chat : Telegram inbound → HandleIncomingMessage → ConversationPort
 *   → (lookup ENS / purchase) → OutboundMessagingPort → Telegram.
 * Flux watch : LLM → ScheduleEnsPurchase → EnsWatchSchedulerPort
 *   (le worker, ailleurs, exécute l'achat le jour du drop).
 */
@Module({
  imports: [EnsCoreModule],
  providers: [
    // Domaine : id + persona. Persona → LangGraph ; canaux → HandleIncomingMessage.
    {
      provide: Agent,
      useValue: new Agent(
        AgentId.of('defichat'),
        [
          'You are DeFiChat, a helpful DeFi assistant.',
          'For ENS data use lookup_ens. For ENS availability, quotes, and purchases use purchase_ens. Always quote first and never claim a purchase succeeded unless purchase_ens returns purchased=true.',
          'When a quote comes back with schedulable=true, meaning the name is taken or above budget, offer schedule_ens so the name is bought automatically once it drops within budget. Never offer schedule_ens for a name that is already available within budget: buy it instead.',
          'Use list_ens_watches whenever the user asks what is scheduled, watched or pending, and cancel_ens_watch to stop one. Report the statuses exactly as the tools return them.',
          'Use web search for news and prices.',
        ].join(' '),
      ),
    },
    // Driven : cerveau LLM. Reçoit persona + lookup + purchase ; appelé par le use case chat.
    {
      provide: CONVERSATION_PORT,
      useFactory: (
        config: ConfigService,
        agent: Agent,
        ensLookup: EnsLookupPort,
        purchaseEnsName: PurchaseEnsName,
        ensBuyerChatIds: ReadonlySet<string>,
        scheduleEnsPurchase: ScheduleEnsPurchase,
        cancelEnsWatch: CancelEnsWatch,
        listEnsWatches: ListEnsWatches,
      ) =>
        LangGraphConversationAdapter.create({
          apiKey: config.getOrThrow<string>('LITELLM_API_KEY'),
          baseURL: config.getOrThrow<string>('LITELLM_BASE_URL'),
          tavilyApiKey: config.getOrThrow<string>('TAVILY_API_KEY'),
          model: config.get<string>('LITELLM_MODEL') ?? 'claude-haiku-4.5',
          systemPrompt: agent.persona,
          ensLookup,
          purchaseEnsName,
          scheduleEnsPurchase,
          cancelEnsWatch,
          listEnsWatches,
          ensBuyerAllowedTelegramChatIds: ensBuyerChatIds,
          timeZone:
            config.get<string>('AGENT_TIMEZONE') ??
            Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      inject: [
        ConfigService,
        Agent,
        ENS_LOOKUP_PORT,
        PurchaseEnsName,
        ENS_BUYER_CHAT_IDS,
        ScheduleEnsPurchase,
        CancelEnsWatch,
        ListEnsWatches,
      ],
    },
    // Use case chat : Agent.assertCanHandle → ConversationPort.reply → MessagingPort.send.
    {
      provide: HandleIncomingMessage,
      useFactory: (
        conversation: ConversationPort,
        messaging: OutboundMessagingPort,
        agent: Agent,
      ) => new HandleIncomingMessage(conversation, messaging, agent),
      inject: [CONVERSATION_PORT, MESSAGING_PORT, Agent],
    },
    // Driving : Telegraf écoute Telegram et appelle HandleIncomingMessage.
    {
      provide: TelegramInboundAdapter,
      useFactory: (bot: Telegraf, uc: HandleIncomingMessage) =>
        new TelegramInboundAdapter(bot, uc),
      inject: [TELEGRAM_BOT, HandleIncomingMessage],
    },
    // Driven : attente d'un drop ENS.
    //
    // Le choix passe par l'environnement et non par le code, parce que Nest
    // instancie ses providers au démarrage : câbler Temporal en dur empêche le
    // bot de booter dès que le serveur est éteint.
    {
      provide: ENS_WATCH_SCHEDULER_PORT,
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        if (config.get<string>('ENS_WATCH_SCHEDULER') !== 'temporal') {
          return new InMemoryEnsWatchScheduler();
        }
        const t = readTemporalConfig(config);
        const connection = await Connection.connect({
          address: t.address,
          tls: t.tls ? true : undefined,
          apiKey: t.apiKey,
        });
        return new TemporalWatchSchedulerAdapter(
          new Client({ connection, namespace: t.namespace }),
          t.taskQueue,
        );
      },
    },
    // Use case watch : quote → snapshot de la date de libération → scheduler.start.
    {
      provide: ScheduleEnsPurchase,
      useFactory: (
        purchase: PurchaseEnsName,
        lookup: EnsLookupPort,
        scheduler: EnsWatchSchedulerPort,
        chatIds: ReadonlySet<string>,
      ) => new ScheduleEnsPurchase(purchase, lookup, scheduler, chatIds),
      inject: [
        PurchaseEnsName,
        ENS_LOOKUP_PORT,
        ENS_WATCH_SCHEDULER_PORT,
        ENS_BUYER_CHAT_IDS,
      ],
    },
    // Use case watch : annulation, réservée au chat qui a armé le watch.
    {
      provide: CancelEnsWatch,
      useFactory: (
        policy: EnsPurchasePolicy,
        scheduler: EnsWatchSchedulerPort,
        chatIds: ReadonlySet<string>,
      ) => new CancelEnsWatch(policy, scheduler, chatIds),
      inject: [
        EnsPurchasePolicy,
        ENS_WATCH_SCHEDULER_PORT,
        ENS_BUYER_CHAT_IDS,
      ],
    },
    // Use case watch : rendre compte, en ne montrant que les watchs du chat.
    {
      provide: ListEnsWatches,
      useFactory: (
        scheduler: EnsWatchSchedulerPort,
        chatIds: ReadonlySet<string>,
      ) => new ListEnsWatches(scheduler, chatIds),
      inject: [ENS_WATCH_SCHEDULER_PORT, ENS_BUYER_CHAT_IDS],
    },
  ],
})
export class AppModule {}
