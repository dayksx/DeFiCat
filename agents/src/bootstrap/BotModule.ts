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
import { ScheduleEnsPurchase } from '../app/use-cases/EnsWatch/ScheduleEnsPurchase.js';
import { CancelEnsWatch } from '../app/use-cases/EnsWatch/CancelEnsWatch.js';
import { ListEnsWatches } from '../app/use-cases/EnsWatch/ListEnsWatches.js';
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
  ETHEREUM_NETWORK,
} from './EnsCoreModule.js';
import { SiweBindPolicy } from '../domain/identity/SiweBindPolicy.js';
import { CLOCK_PORT, type ClockPort } from '../app/ports/clock/ClockPort.js';
import {
  IDENTITY_STORE_PORT,
  type IdentityStorePort,
} from '../app/ports/identity/IdentityStorePort.js';
import {
  TOKEN_GENERATOR_PORT,
  type TokenGeneratorPort,
} from '../app/ports/identity/TokenGeneratorPort.js';
import {
  SIWE_VERIFIER_PORT,
  type SiweVerifierPort,
} from '../app/ports/identity/SiweVerifierPort.js';
import type { SiweIssuance } from '../app/use-cases/SiweAuth/SiweIssuance.js';
import type { EthereumNetwork } from '../infrastructure/chain/ethereumNetwork.js';
import { GetSiweChallenge } from '../app/use-cases/SiweAuth/GetSiweChallenge.js';
import { CompleteSiweBind } from '../app/use-cases/SiweAuth/CompleteSiweBind.js';
import { SystemClockAdapter } from '../infrastructure/adapters/clock/SystemClockAdapter.js';
import { InMemoryIdentityStore } from '../infrastructure/adapters/identity/InMemoryIdentityStore.js';
import { ViemSiweNonceAdapter } from '../infrastructure/adapters/siwe/ViemSiweNonceAdapter.js';
import { ViemSiweVerifierAdapter } from '../infrastructure/adapters/siwe/ViemSiweVerifierAdapter.js';
import { SiweAuthController } from '../infrastructure/adapters/http/SiweAuthController.js';
import {
  PAYMENT_STORE_PORT,
  type PaymentStorePort,
} from '../app/ports/billing/PaymentStorePort.js';
import {
  X402_FACILITATOR_PORT,
  type X402FacilitatorPort,
} from '../app/ports/billing/X402FacilitatorPort.js';
import {
  PaymentPolicy,
  PAYMENT_SESSION_TTL_MS,
} from '../domain/billing/PaymentPolicy.js';
import type { PaymentIssuance } from '../app/use-cases/Billing/PaymentIssuance.js';
import { IssuePaymentSession } from '../app/use-cases/Billing/IssuePaymentSession.js';
import { GetX402Requirements } from '../app/use-cases/Billing/GetX402Requirements.js';
import { FulfillPaidIntent } from '../app/use-cases/Billing/FulfillPaidIntent.js';
import { SettlePaymentAndFulfill } from '../app/use-cases/Billing/SettlePaymentAndFulfill.js';
import { InMemoryPaymentStore } from '../infrastructure/adapters/billing/InMemoryPaymentStore.js';
import { HttpX402FacilitatorAdapter } from '../infrastructure/adapters/x402/HttpX402FacilitatorAdapter.js';
import { X402PayController } from '../infrastructure/adapters/http/X402PayController.js';

const SIWE_ISSUANCE = Symbol('SiweIssuance');
const PAYMENT_ISSUANCE = Symbol('PaymentIssuance');
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
  controllers: [SiweAuthController, X402PayController],
  providers: [
    // Domaine : id + persona. Persona → LangGraph ; canaux → HandleIncomingMessage.
    {
      provide: Agent,
      useFactory: (network: EthereumNetwork) =>
        new Agent(
          AgentId.of('defichat'),
          [
            'You are DeFiChat, a helpful DeFi assistant.',
            `You operate on ${network.label} (chain id ${network.chainId}). ENS lookups and purchases use that chain only.`,
            'The user signed in with Ethereum (SIWE) before this chat. Every turn includes a verified wallet address and link time — treat that as ground truth. If they ask who they are, their address, or when they connected, answer from it. Never invent or change the address.',
            'For ENS data use lookup_ens. For ENS availability, quotes, and purchases use purchase_ens. Always quote first and never claim a purchase succeeded unless purchase_ens returns purchased=true.',
            'When a quote comes back with schedulable=true, meaning the name is taken or above budget, offer schedule_ens so the name is bought automatically once it drops within budget. Never offer schedule_ens for a name that is already available within budget: buy it instead.',
            'Paid actions return PAYMENT_REQUIRED with payUrl. Never invent a tx hash. Never ask CONFIRM again after they paid.',
            'Use list_ens_watches whenever the user asks what is scheduled, watched or pending, and cancel_ens_watch to stop one. Report the statuses exactly as the tools return them.',
            'Use web search for news and prices.',
          ].join(' '),
        ),
      inject: [ETHEREUM_NETWORK],
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
        cancelEnsWatch: CancelEnsWatch,
        listEnsWatches: ListEnsWatches,
        issuePayment: IssuePaymentSession,
        network: EthereumNetwork,
      ) =>
        LangGraphConversationAdapter.create({
          apiKey: config.getOrThrow<string>('LITELLM_API_KEY'),
          baseURL: config.getOrThrow<string>('LITELLM_BASE_URL'),
          tavilyApiKey: config.getOrThrow<string>('TAVILY_API_KEY'),
          model: config.get<string>('LITELLM_MODEL') ?? 'claude-haiku-4.5',
          systemPrompt: agent.persona,
          ensLookup,
          purchaseEnsName,
          issuePayment,
          cancelEnsWatch,
          listEnsWatches,
          ensBuyerAllowedTelegramChatIds: ensBuyerChatIds,
          networkLabel: network.label,
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
        CancelEnsWatch,
        ListEnsWatches,
        IssuePaymentSession,
        ETHEREUM_NETWORK,
      ],
    },

    { provide: CLOCK_PORT, useClass: SystemClockAdapter },
    { provide: TOKEN_GENERATOR_PORT, useClass: ViemSiweNonceAdapter },
    { provide: IDENTITY_STORE_PORT, useClass: InMemoryIdentityStore },
    { provide: SIWE_VERIFIER_PORT, useClass: ViemSiweVerifierAdapter },
    { provide: SiweBindPolicy, useValue: new SiweBindPolicy() },
    {
      provide: SIWE_ISSUANCE,
      useFactory: (
        config: ConfigService,
        network: EthereumNetwork,
      ): SiweIssuance => ({
        domain: config.getOrThrow<string>('SIWE_DOMAIN'),
        chainId: network.chainId,
        statement: config.getOrThrow<string>('SIWE_STATEMENT'),
        uiOrigin: config.getOrThrow<string>('UI_ORIGIN'),
      }),
      inject: [ConfigService, ETHEREUM_NETWORK],
    },
    {
      provide: GetSiweChallenge,
      useFactory: (
        identities: IdentityStorePort,
        clock: ClockPort,
        policy: SiweBindPolicy,
        issuance: SiweIssuance,
      ) => new GetSiweChallenge(identities, clock, policy, issuance),
      inject: [IDENTITY_STORE_PORT, CLOCK_PORT, SiweBindPolicy, SIWE_ISSUANCE],
    },
    {
      provide: CompleteSiweBind,
      useFactory: (
        identities: IdentityStorePort,
        verifier: SiweVerifierPort,
        messaging: OutboundMessagingPort,
        clock: ClockPort,
        policy: SiweBindPolicy,
        issuance: SiweIssuance,
      ) =>
        new CompleteSiweBind(
          identities,
          verifier,
          messaging,
          clock,
          policy,
          issuance,
        ),
      inject: [
        IDENTITY_STORE_PORT,
        SIWE_VERIFIER_PORT,
        MESSAGING_PORT,
        CLOCK_PORT,
        SiweBindPolicy,
        SIWE_ISSUANCE,
      ],
    },
    {
      provide: HandleIncomingMessage,
      useFactory: (
        conversation: ConversationPort,
        messaging: OutboundMessagingPort,
        agent: Agent,
        identities: IdentityStorePort,
        tokens: TokenGeneratorPort,
        clock: ClockPort,
        policy: SiweBindPolicy,
        issuance: SiweIssuance,
      ) =>
        new HandleIncomingMessage(
          conversation,
          messaging,
          agent,
          identities,
          tokens,
          clock,
          policy,
          issuance,
        ),
      inject: [
        CONVERSATION_PORT,
        MESSAGING_PORT,
        Agent,
        IDENTITY_STORE_PORT,
        TOKEN_GENERATOR_PORT,
        CLOCK_PORT,
        SiweBindPolicy,
        SIWE_ISSUANCE,
      ],
    },
    { provide: PAYMENT_STORE_PORT, useClass: InMemoryPaymentStore },
    {
      provide: PaymentPolicy,
      useFactory: (config: ConfigService) => {
        const minutes = config.get<string>('X402_SESSION_TTL_MINUTES');
        return new PaymentPolicy(
          minutes === undefined
            ? PAYMENT_SESSION_TTL_MS
            : Number(minutes) * 60_000,
        );
      },
      inject: [ConfigService],
    },
    {
      provide: PAYMENT_ISSUANCE,
      useFactory: (config: ConfigService): PaymentIssuance => ({
        payTo: config.getOrThrow<string>('X402_PAY_TO'),
        chainId: Number(config.getOrThrow<string>('PAYMENT_CHAIN_ID')),
        asset: config.getOrThrow<string>('X402_USDC_ADDRESS'),
        network: `eip155:${config.getOrThrow<string>('PAYMENT_CHAIN_ID')}`,
        uiOrigin: config.getOrThrow<string>('UI_ORIGIN'),
        extraName: 'USDC',
        extraVersion: '2',
      }),
      inject: [ConfigService],
    },
    {
      provide: X402_FACILITATOR_PORT,
      useFactory: (config: ConfigService) =>
        new HttpX402FacilitatorAdapter(
          config.getOrThrow<string>('X402_FACILITATOR_URL'),
        ),
      inject: [ConfigService],
    },
    {
      provide: IssuePaymentSession,
      useFactory: (
        identities: IdentityStorePort,
        payments: PaymentStorePort,
        tokens: TokenGeneratorPort,
        clock: ClockPort,
        policy: PaymentPolicy,
        issuance: PaymentIssuance,
      ) =>
        new IssuePaymentSession(
          identities, payments, tokens, clock, policy, issuance,
        ),
      inject: [
        IDENTITY_STORE_PORT,
        PAYMENT_STORE_PORT,
        TOKEN_GENERATOR_PORT,
        CLOCK_PORT,
        PaymentPolicy,
        PAYMENT_ISSUANCE,
      ],
    },
    {
      provide: GetX402Requirements,
      useFactory: (
        payments: PaymentStorePort,
        clock: ClockPort,
        policy: PaymentPolicy,
        issuance: PaymentIssuance,
      ) => new GetX402Requirements(payments, clock, policy, issuance),
      inject: [PAYMENT_STORE_PORT, CLOCK_PORT, PaymentPolicy, PAYMENT_ISSUANCE],
    },
    {
      provide: FulfillPaidIntent,
      useFactory: (
        purchase: PurchaseEnsName,
        schedule: ScheduleEnsPurchase,
        messaging: OutboundMessagingPort,
      ) => new FulfillPaidIntent(purchase, schedule, messaging),
      inject: [PurchaseEnsName, ScheduleEnsPurchase, MESSAGING_PORT],
    },
    {
      provide: SettlePaymentAndFulfill,
      useFactory: (
        payments: PaymentStorePort,
        facilitator: X402FacilitatorPort,
        clock: ClockPort,
        policy: PaymentPolicy,
        messaging: OutboundMessagingPort,
        getRequirements: GetX402Requirements,
        fulfill: FulfillPaidIntent,
      ) =>
        new SettlePaymentAndFulfill(
          payments, facilitator, clock, policy, messaging, getRequirements, fulfill,
        ),
      inject: [
        PAYMENT_STORE_PORT,
        X402_FACILITATOR_PORT,
        CLOCK_PORT,
        PaymentPolicy,
        MESSAGING_PORT,
        GetX402Requirements,
        FulfillPaidIntent,
      ],
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
export class BotModule {}
