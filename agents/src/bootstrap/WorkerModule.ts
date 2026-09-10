import { fileURLToPath } from 'node:url';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApplicationFailure } from '@temporalio/activity';
import { NativeConnection, Worker } from '@temporalio/worker';
import {
  ENS_LOOKUP_PORT,
  type EnsLookupPort,
} from '../app/ports/graph/EnsLookupPort.js';
import {
  ENS_REGISTRAR_PORT,
  type EnsRegistrarPort,
} from '../app/ports/ens/EnsRegistrarPort.js';
import {
  MESSAGING_PORT,
  type OutboundMessagingPort,
} from '../app/ports/messaging/OutboundMessagingPort.js';
import { EnsPurchasePolicy } from '../domain/ens/EnsPurchasePolicy.js';
import { PurchaseEnsName } from '../app/use-cases/PurchaseEnsName/PurchaseEnsName.js';
import { EnsPurchaseError } from '../app/use-cases/PurchaseEnsName/EnsPurchaseError.js';
import { readTemporalConfig } from '../infrastructure/adapters/temporal/temporal.config.js';
import type { EnsDropActivities } from '../infrastructure/adapters/temporal/activities/ensDrop.activities.js';
import { EnsCoreModule } from './EnsCoreModule.js';

export const TEMPORAL_WORKER = Symbol('TemporalWorker');

/**
 * Le worker charge les workflows depuis un fichier, pas depuis un import : ils
 * tournent dans un isolat séparé. Le chemin est résolu depuis le fichier émis,
 * donc `dist/bootstrap/` vers `dist/infrastructure/...`.
 */
const workflowsPath = fileURLToPath(
  new URL(
    '../infrastructure/adapters/temporal/workflows/watchEnsDrop.workflow.js',
    import.meta.url,
  ),
);

/**
 * Composition root du processus worker. C'est lui qui signe les transactions
 * d'un achat planifié, des mois après que le chat l'ait demandé.
 *
 * Une seule instance en production : les adapters partagent une EOA, donc un
 * nonce. Deux workers qui prennent la même activité se marcheraient dessus.
 */
@Module({
  imports: [EnsCoreModule],
  providers: [
    {
      provide: TEMPORAL_WORKER,
      inject: [
        ConfigService,
        PurchaseEnsName,
        EnsPurchasePolicy,
        ENS_REGISTRAR_PORT,
        ENS_LOOKUP_PORT,
        MESSAGING_PORT,
      ],
      useFactory: async (
        config: ConfigService,
        purchase: PurchaseEnsName,
        policy: EnsPurchasePolicy,
        registrar: EnsRegistrarPort,
        lookup: EnsLookupPort,
        messaging: OutboundMessagingPort,
      ): Promise<Worker> => {
        const temporal = readTemporalConfig(config);
        const connection = await NativeConnection.connect({
          address: temporal.address,
          tls: temporal.tls ? true : undefined,
          apiKey: temporal.apiKey,
        });

        const activities: EnsDropActivities = {
          async refreshQuote({ label, years, maxWei }) {
            const quote = await asActivityFailure(() =>
              purchase.quote({ label, years }),
            );
            return {
              available: quote.available,
              // Contre le plafond du watch, pas celui de l'agent : un watch
              // peut viser moins que le budget global.
              withinBudget: policy.isWithinBudget(
                quote.valueWithSlippageWei,
                maxWei,
              ),
              totalWei: quote.totalWei,
              premiumWei: quote.premiumWei,
              gracePeriodEndUnix: await readDropUnix(lookup, quote.name),
            };
          },

          async commitName({ label, durationSeconds, secret }) {
            const commitment = await registrar.commit({
              label,
              durationSeconds,
              secret,
            });
            return {
              secret: commitment.secret,
              commitmentTransactionHash: commitment.commitmentTransactionHash,
            };
          },

          async registerName(input) {
            const receipt = await registrar.register({
              label: input.label,
              durationSeconds: input.durationSeconds,
              maxTotalCostWei: input.maxWei,
              secret: input.secret,
              commitmentTransactionHash: input.commitmentTransactionHash,
            });
            return {
              registrationTransactionHash: receipt.registrationTransactionHash,
              totalPaidWei: receipt.totalPaidWei,
            };
          },

          async notifyChat({ chatId, message }) {
            await messaging.send({
              channel: 'telegram',
              recipientId: chatId,
              message,
            });
          },
        };

        return Worker.create({
          connection,
          namespace: temporal.namespace,
          taskQueue: temporal.taskQueue,
          workflowsPath,
          activities,
        });
      },
    },
  ],
  exports: [TEMPORAL_WORKER],
})
export class WorkerModule {}

async function readDropUnix(
  lookup: EnsLookupPort,
  name: string,
): Promise<number> {
  const { domains } = await lookup.lookup({ kind: 'name', name });
  const gracePeriodEndDate = domains[0]?.gracePeriodEndDate ?? null;
  if (gracePeriodEndDate === null) return 0;

  const unix = Math.floor(Date.parse(gracePeriodEndDate) / 1000);
  return Number.isFinite(unix) ? unix : 0;
}

/**
 * `nonRetryableErrorTypes` du workflow compare des *types* de failure, pas des
 * classes JavaScript. Sans cette traduction, un dépassement de budget serait
 * réessayé cinq fois avant d'échouer.
 */
async function asActivityFailure<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof EnsPurchaseError) {
      throw error.retryable
        ? ApplicationFailure.retryable(error.message, error.code)
        : ApplicationFailure.nonRetryable(error.message, error.code);
    }
    throw error;
  }
}
