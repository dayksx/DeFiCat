import { Logger } from '@nestjs/common';
import type { BaseMessage } from '@langchain/core/messages';
import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from 'langchain';
import { formatEther } from 'viem';
import { z } from 'zod';
import type { ValidatedEnsPurchase } from '../../../../domain/ens/EnsPurchasePolicy.js';
import { DomainError } from '../../../../domain/errors/DomainError.js';
import { PaymentError } from '../../../../app/use-cases/Billing/PaymentError.js';
import type { IssuePaymentSession } from '../../../../app/use-cases/Billing/IssuePaymentSession.js';
import { EnsPurchaseError } from '../../../../app/use-cases/PurchaseEnsName/EnsPurchaseError.js';
import type { PurchaseEnsName } from '../../../../app/use-cases/PurchaseEnsName/PurchaseEnsName.js';
import { telegramChatId } from './telegramChatId.js';

type MessagesState = { messages: BaseMessage[] };

const schema = z.object({
  action: z
    .enum(['quote', 'buy'])
    .describe('quote checks price; buy spends ETH after explicit confirmation'),
  name: z.string().describe('Second-level ENS name, e.g. deficat.eth'),
  years: z.number().int().min(1).max(5).default(1),
});

/** Told to the model so it reacts to each failure instead of improvising. */
const GUIDANCE: Record<string, string> = {
  INVALID_REQUEST:
    'Ask the user for a valid second-level .eth name and a duration of 1-5 years.',
  NAME_UNAVAILABLE: 'Tell the user the name is taken. Do not retry.',
  OVER_BUDGET:
    'Tell the user the price is above the agent budget. Do not retry.',
  INSUFFICIENT_FUNDS:
    'Tell the user the agent wallet needs more ETH. Do not retry.',
  CHAIN_UNAVAILABLE:
    'Tell the user Ethereum is unreachable and offer to try again in a moment.',
  COMMITTED_NOT_REGISTERED:
    'Tell the user the name was NOT registered even though gas was spent. Do not retry without a fresh confirmation.',
  PURCHASE_FAILED:
    'Tell the user the purchase did not go through and that no name was registered.',
  NOT_AUTHORIZED:
    'Tell the user this chat cannot spend agent funds, or ask for the exact confirmation phrase.',
  PAYMENT_REQUIRED:
    'Tell the user to open payUrl and pay the quoted USDC. Do not claim the name is bought. The agent will message Telegram after payment.',
  NOT_LINKED:
    'Tell the user to sign in with Ethereum before paying. Do not retry the purchase.',
  UNEXPECTED_ERROR:
    'Tell the user the request failed. Never claim the name was purchased.',
};

export function createEnsPurchaseTool(opts: {
  purchaseEnsName: PurchaseEnsName;
  issuePayment: IssuePaymentSession;
  allowedTelegramChatIds: ReadonlySet<string>;
  networkLabel?: string;
}) {
  const networkLabel = opts.networkLabel ?? 'Ethereum';
  const logger = new Logger('EnsPurchaseTool');

  return tool(
    async (input, runtime: ToolRuntime<MessagesState>): Promise<string> => {
      // Pure policy check first: it costs nothing and yields the canonical name.
      let valid: ValidatedEnsPurchase;
      try {
        valid = opts.purchaseEnsName.validate({
          label: input.name,
          years: input.years,
        });
      } catch (error) {
        return failure(logger, input.action, input.name, error);
      }

      const confirmation = confirmationPhrase(valid.name, valid.years);

      if (input.action === 'quote') {
        try {
          const quote = await opts.purchaseEnsName.quote(valid);
          return JSON.stringify({
            action: 'quote',
            purchased: false,
            name: quote.name,
            available: quote.available,
            years: quote.years,
            totalEth: formatEther(BigInt(quote.totalWei)),
            maximumSentEth: formatEther(BigInt(quote.valueWithSlippageWei)),
            budgetEth: formatEther(BigInt(quote.maxBudgetWei)),
            withinBudget: quote.withinBudget,
            confirmationRequired: confirmation,
            // Porté par le résultat d'outil plutôt que laissé à l'initiative du
            // modèle : c'est la seule condition où un watch a du sens.
            schedulable: !quote.available || !quote.withinBudget,
            message: quoteMessage(quote, confirmation),
          });
        } catch (error) {
          return failure(logger, 'quote', valid.name, error);
        }
      }

      // Authorize before invoicing so an unauthorized chat cannot mint a pay
      // link. The ENS commit-reveal runs later, after x402 settlement.
      const chatId = telegramChatId(runtime.config.configurable?.thread_id);
      const authorization = authorizeEnsPurchase({
        threadId: runtime.config.configurable?.thread_id,
        latestUserText: latestHumanText(runtime.state.messages),
        allowedTelegramChatIds: opts.allowedTelegramChatIds,
        name: valid.name,
        years: valid.years,
      });
      if (!authorization.allowed || chatId === undefined) {
        logger.warn(
          `Blocked ENS purchase: ${authorization.allowed ? 'missing chat id' : authorization.reason}`,
        );
        return JSON.stringify({
          action: 'buy',
          purchased: false,
          code: 'NOT_AUTHORIZED',
          retryable: false,
          error: authorization.allowed
            ? 'This Telegram chat is not authorized to spend agent funds'
            : authorization.reason,
          confirmationRequired: confirmation,
          guidance: GUIDANCE.NOT_AUTHORIZED,
        });
      }

      let quote;
      try {
        quote = await opts.purchaseEnsName.quote(valid);
      } catch (error) {
        return failure(logger, 'buy', valid.name, error);
      }
      if (!quote.available || !quote.withinBudget) {
        return JSON.stringify({
          action: 'buy',
          purchased: false,
          name: quote.name,
          available: quote.available,
          withinBudget: quote.withinBudget,
          schedulable: true,
          message: quoteMessage(quote, confirmation),
        });
      }

      logger.log(`Invoicing ENS purchase for ${valid.name} (${valid.years}y)`);
      try {
        const invoice = await opts.issuePayment.execute({
          channel: 'telegram',
          recipientId: chatId,
          intent: {
            type: 'ens.buy',
            label: valid.label,
            years: valid.years,
          },
        });
        return JSON.stringify({
          action: 'buy',
          purchased: false,
          code: 'PAYMENT_REQUIRED',
          sku: invoice.offer.sku,
          amountUsdc: (
            Number(invoice.offer.amountAtomic) / 1_000_000
          ).toString(),
          payUrl: invoice.payUrl,
          expiresAt: invoice.expiresAt.toISOString(),
          guidance: GUIDANCE.PAYMENT_REQUIRED,
        });
      } catch (error) {
        return failure(logger, 'buy', valid.name, error);
      }
    },
    {
      name: 'purchase_ens',
      description: `Quote or invoice a second-level .eth name bought with the agent's own ${networkLabel} EOA. Always call quote first. Call buy only after the authorized user sends the exact confirmation phrase returned by quote. Buy returns a payUrl; the name is registered after USDC payment, not in this call.`,
      schema,
    },
  );
}

function quoteMessage(
  quote: { name: string; available: boolean; withinBudget: boolean },
  confirmation: string,
): string {
  if (!quote.available) {
    return `${quote.name} is already registered. Offer to watch it with schedule_ens so it is bought as soon as it drops within budget.`;
  }
  if (!quote.withinBudget) {
    return `${quote.name} costs more than the agent budget right now. Offer to watch it with schedule_ens: the premium falls over time and the purchase fires once it is affordable.`;
  }
  return `Ask the user to send exactly: ${confirmation}`;
}

/**
 * Turns any thrown value into a stable payload for the model. Raw adapter
 * messages (viem dumps, RPC URLs, request bodies) stay in the logs.
 */
function failure(
  logger: Logger,
  action: string,
  name: string,
  error: unknown,
): string {
  logger.error(
    `ENS ${action} failed for ${name}: ${describe(error)}`,
    error instanceof Error ? error.stack : undefined,
  );

  if (error instanceof EnsPurchaseError || error instanceof PaymentError) {
    return JSON.stringify({
      action,
      purchased: false,
      code: error.code,
      retryable: error.retryable,
      error: error.message,
      ...(error instanceof EnsPurchaseError &&
      error.commitmentTransactionHash !== undefined
        ? { commitmentTransactionHash: error.commitmentTransactionHash }
        : {}),
      guidance: GUIDANCE[error.code] ?? GUIDANCE.UNEXPECTED_ERROR,
    });
  }

  // A policy refusal (e.g. the linked wallet is the treasury) already reads as
  // an instruction: dropping it into UNEXPECTED_ERROR would hide the fix.
  if (error instanceof DomainError) {
    return JSON.stringify({
      action,
      purchased: false,
      code: 'INVALID_REQUEST',
      retryable: false,
      error: error.message,
      guidance: 'Repeat this reason to the user verbatim. Do not retry.',
    });
  }

  return JSON.stringify({
    action,
    purchased: false,
    code: 'UNEXPECTED_ERROR',
    retryable: false,
    error: 'The ENS tool failed unexpectedly',
    guidance: GUIDANCE.UNEXPECTED_ERROR,
  });
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause === undefined) return error.message;
  return `${error.message} <- ${cause instanceof Error ? cause.message : String(cause)}`;
}

function confirmationPhrase(name: string, years: number): string {
  return `CONFIRM BUY ${name.toUpperCase()} FOR ${years} YEAR${years === 1 ? '' : 'S'}`;
}

export function authorizeEnsPurchase(opts: {
  threadId: unknown;
  latestUserText: string;
  allowedTelegramChatIds: ReadonlySet<string>;
  name: string;
  years: number;
}): { allowed: true } | { allowed: false; reason: string } {
  const chatId = telegramChatId(opts.threadId);
  if (chatId === undefined || !opts.allowedTelegramChatIds.has(chatId)) {
    return {
      allowed: false,
      reason: 'This Telegram chat is not authorized to spend agent funds',
    };
  }
  if (
    normalizeConfirmation(opts.latestUserText) !==
    confirmationPhrase(opts.name, opts.years)
  ) {
    return {
      allowed: false,
      reason:
        'Explicit confirmation is missing. Ask the user to send the exact confirmation phrase alone.',
    };
  }
  return { allowed: true };
}

function normalizeConfirmation(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

function latestHumanText(messages: BaseMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.getType() !== 'human') continue;
    return typeof message.content === 'string' ? message.content : '';
  }
  return '';
}
