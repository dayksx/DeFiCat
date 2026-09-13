import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';
import { parseEther, type Hex } from 'viem';
import { ENS_LOOKUP_PORT } from '../app/ports/graph/EnsLookupPort.js';
import {
  ENS_REGISTRAR_PORT,
  type EnsRegistrarPort,
} from '../app/ports/ens/EnsRegistrarPort.js';
import {
  ENS_SUBNAME_PORT,
  type EnsSubnamePort,
} from '../app/ports/ens/EnsSubnamePort.js';
import { MESSAGING_PORT } from '../app/ports/messaging/OutboundMessagingPort.js';
import { EnsPurchasePolicy } from '../domain/ens/EnsPurchasePolicy.js';
import { EnsSubnamePolicy } from '../domain/ens/EnsSubnamePolicy.js';
import { PurchaseEnsName } from '../app/use-cases/PurchaseEnsName/PurchaseEnsName.js';
import { CreateEnsSubname } from '../app/use-cases/CreateEnsSubname/CreateEnsSubname.js';
import { TheGraphEnsAdapter } from '../infrastructure/adapters/thegraph/TheGraphEnsAdapter.js';
import { ViemEnsRegistrarAdapter } from '../infrastructure/adapters/ens/ViemEnsRegistrarAdapter.js';
import { TelegramOutboundAdapter } from '../infrastructure/adapters/telegram/TelegramOutboundAdapter.js';
import {
  parseChainId,
  resolveEthereumNetwork,
  type EthereumNetwork,
} from '../infrastructure/chain/ethereumNetwork.js';

export const TELEGRAM_BOT = Symbol('TelegramBot');
/** Single source for the chats allowed to spend agent funds. */
export const ENS_BUYER_CHAT_IDS = Symbol('EnsBuyerChatIds');
export const ETHEREUM_NETWORK = Symbol('EthereumNetwork');

/**
 * Everything the bot and the Temporal worker both need: ENS reads, on-chain
 * writes, the purchase policy and outbound Telegram.
 *
 * A Nest module does not inherit another module's providers, and the worker is
 * a separate process with its own composition root. Declaring these twice would
 * mean two places to keep the signer, the budget and the allowlist in sync, so
 * both `BotModule` and `WorkerModule` import this one instead.
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  providers: [
    {
      provide: ENS_BUYER_CHAT_IDS,
      useFactory: (config: ConfigService): ReadonlySet<string> =>
        new Set(
          config
            .getOrThrow<string>('ENS_BUYER_ALLOWED_TELEGRAM_CHAT_IDS')
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean),
        ),
      inject: [ConfigService],
    },
    {
      provide: ETHEREUM_NETWORK,
      useFactory: (config: ConfigService): EthereumNetwork =>
        resolveEthereumNetwork(
          parseChainId(
            config.get<string>('CHAIN_ID') ??
              config.get<string>('SIWE_CHAIN_ID'),
          ),
          {
            ensRegistry: config.get<string>('ENS_REGISTRY'),
            ensNameWrapper: config.get<string>('ENS_NAME_WRAPPER'),
            ensRegistrarController: config.get<string>(
              'ENS_REGISTRAR_CONTROLLER',
            ),
            ensPublicResolver: config.get<string>('ENS_PUBLIC_RESOLVER'),
            ensSubgraphId: config.get<string>('ENS_SUBGRAPH_ID'),
          },
        ),
      inject: [ConfigService],
    },
    // Driven : lecture ENS (The Graph). Cotation et date de libération.
    {
      provide: ENS_LOOKUP_PORT,
      useFactory: (config: ConfigService, network: EthereumNetwork) =>
        TheGraphEnsAdapter.create({
          apiKey: config.getOrThrow<string>('THEGRAPH_API_KEY'),
          subgraphId: network.ensSubgraphId,
        }),
      inject: [ConfigService, ETHEREUM_NETWORK],
    },
    // Driven : écriture on-chain (commit/register). Seul détenteur de la clé.
    {
      provide: ENS_REGISTRAR_PORT,
      useFactory: (config: ConfigService, network: EthereumNetwork) =>
        ViemEnsRegistrarAdapter.create({
          privateKey: readPrivateKey(config),
          rpcUrl: config.getOrThrow<string>('ETHEREUM_RPC_URL'),
          chain: network.chain,
          registry: network.ensRegistry,
          nameWrapper: network.ensNameWrapper,
          registrarController: network.ensRegistrarController,
          publicResolver: network.ensPublicResolver,
        }),
      inject: [ConfigService, ETHEREUM_NETWORK],
    },
    {
      provide: ENS_SUBNAME_PORT,
      useExisting: ENS_REGISTRAR_PORT,
    },
    {
      provide: EnsPurchasePolicy,
      useValue: new EnsPurchasePolicy(1, 5),
    },
    { provide: EnsSubnamePolicy, useValue: new EnsSubnamePolicy() },
    // Use case achat immédiat, réutilisé par le worker pour recoter un watch.
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
      provide: CreateEnsSubname,
      useFactory: (subnames: EnsSubnamePort, policy: EnsSubnamePolicy) =>
        new CreateEnsSubname(subnames, policy),
      inject: [ENS_SUBNAME_PORT, EnsSubnamePolicy],
    },
    // Infra partagée : un seul Telegraf. Le worker s'en sert sans jamais lancer
    // de long polling, `bot.telegram.sendMessage` n'a pas besoin de `launch()`.
    {
      provide: TELEGRAM_BOT,
      useFactory: (config: ConfigService) =>
        new Telegraf(config.getOrThrow<string>('TELEGRAM_BOT_TOKEN'), {
          // An ENS buy is commit + minCommitmentAge (60s) + register, so it
          // runs past Telegraf's 90s default and the update would be killed
          // mid-purchase, after the commit has already spent gas.
          handlerTimeout: Number(
            config.get<string>('TELEGRAM_HANDLER_TIMEOUT_MS') ?? '900000',
          ),
        }),
      inject: [ConfigService],
    },
    {
      provide: MESSAGING_PORT,
      useFactory: (bot: Telegraf) => new TelegramOutboundAdapter(bot),
      inject: [TELEGRAM_BOT],
    },
  ],
  exports: [
    ConfigModule,
    ETHEREUM_NETWORK,
    ENS_BUYER_CHAT_IDS,
    ENS_LOOKUP_PORT,
    ENS_REGISTRAR_PORT,
    ENS_SUBNAME_PORT,
    EnsPurchasePolicy,
    EnsSubnamePolicy,
    PurchaseEnsName,
    CreateEnsSubname,
    TELEGRAM_BOT,
    MESSAGING_PORT,
  ],
})
export class EnsCoreModule {}

function readPrivateKey(config: ConfigService): Hex {
  const value = config.getOrThrow<string>('AGENT_PRIVATE_KEY').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(
      'AGENT_PRIVATE_KEY must be a 32-byte 0x-prefixed private key',
    );
  }
  return value as Hex;
}
