import { Logger } from '@nestjs/common';
import type { BaseMessage } from '@langchain/core/messages';
import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from 'langchain';
import { z } from 'zod';
import type { CreateEnsSubname } from '../../../../app/use-cases/CreateEnsSubname/CreateEnsSubname.js';
import { EnsSubnameError } from '../../../../app/use-cases/CreateEnsSubname/EnsSubnameError.js';
import type { IssuePaymentSession } from '../../../../app/use-cases/Billing/IssuePaymentSession.js';
import { PaymentError } from '../../../../app/use-cases/Billing/PaymentError.js';
import type { ValidatedEnsSubname } from '../../../../domain/ens/EnsSubnamePolicy.js';
import { DomainError } from '../../../../domain/errors/DomainError.js';
import { telegramChatId } from './telegramChatId.js';

type MessagesState = { messages: BaseMessage[] };

const schema = z.object({
  action: z
    .enum(['check', 'buy'])
    .describe(
      'check validates availability and ownership; buy creates a payment link',
    ),
  name: z.string().describe('Full ENS subname, e.g. me.kikoulol.eth'),
});

export function createEnsSubnameTool(opts: {
  createEnsSubname: CreateEnsSubname;
  issuePayment: IssuePaymentSession;
  allowedTelegramChatIds: ReadonlySet<string>;
  networkLabel?: string;
}) {
  const logger = new Logger('EnsSubnameTool');
  const networkLabel = opts.networkLabel ?? 'Ethereum';

  return tool(
    async (input, runtime: ToolRuntime<MessagesState>): Promise<string> => {
      let valid: ValidatedEnsSubname;
      try {
        valid = opts.createEnsSubname.validate({ name: input.name });
      } catch (error) {
        return failure(logger, input.action, input.name, error);
      }

      const confirmation = confirmationPhrase(valid.name);
      let quote;
      try {
        quote = await opts.createEnsSubname.quote(valid);
      } catch (error) {
        return failure(logger, input.action, valid.name, error);
      }

      if (input.action === 'check') {
        return JSON.stringify({
          action: 'check',
          created: false,
          ...quote,
          parentExpiry: quote.parentExpiry?.toISOString() ?? null,
          confirmationRequired:
            quote.available && quote.parentOwnedByAgent
              ? confirmation
              : undefined,
          message: quoteMessage(quote, confirmation),
        });
      }

      const chatId = telegramChatId(runtime.config.configurable?.thread_id);
      const authorization = authorizeEnsSubnamePurchase({
        threadId: runtime.config.configurable?.thread_id,
        latestUserText: latestHumanText(runtime.state.messages),
        allowedTelegramChatIds: opts.allowedTelegramChatIds,
        name: valid.name,
      });
      if (!authorization.allowed || chatId === undefined) {
        return JSON.stringify({
          action: 'buy',
          created: false,
          code: 'NOT_AUTHORIZED',
          retryable: false,
          confirmationRequired: confirmation,
          error:
            'This chat is not authorized or the exact confirmation phrase is missing',
          guidance:
            'Ask the authorized user to send the exact confirmation phrase alone.',
        });
      }
      if (!quote.parentOwnedByAgent || !quote.available) {
        return JSON.stringify({
          action: 'buy',
          created: false,
          name: quote.name,
          available: quote.available,
          parentOwnedByAgent: quote.parentOwnedByAgent,
          message: quoteMessage(quote, confirmation),
        });
      }

      try {
        const invoice = await opts.issuePayment.execute({
          channel: 'telegram',
          recipientId: chatId,
          intent: { type: 'ens.subname', name: valid.name },
        });
        return JSON.stringify({
          action: 'buy',
          created: false,
          code: 'PAYMENT_REQUIRED',
          sku: invoice.offer.sku,
          amountUsdc: (
            Number(invoice.offer.amountAtomic) / 1_000_000
          ).toString(),
          payUrl: invoice.payUrl,
          expiresAt: invoice.expiresAt.toISOString(),
          guidance:
            'Tell the user to pay at payUrl. The subname is created only after settlement.',
        });
      } catch (error) {
        return failure(logger, 'buy', valid.name, error);
      }
    },
    {
      name: 'purchase_ens_subname',
      description: `Check or invoice creation of an ENS subname such as me.kikoulol.eth on ${networkLabel}. The agent must own the wrapped parent. Always call check first; buy only after the exact confirmation phrase. The subname is owned by the agent and expires with its parent.`,
      schema,
    },
  );
}

function quoteMessage(
  quote: {
    name: string;
    parentName: string;
    available: boolean;
    parentOwnedByAgent: boolean;
  },
  confirmation: string,
): string {
  if (!quote.parentOwnedByAgent) {
    return `The agent does not own the wrapped parent ${quote.parentName}, so it cannot create this subname.`;
  }
  if (!quote.available) return `${quote.name} is already registered.`;
  return `Ask the user to send exactly: ${confirmation}`;
}

function failure(
  logger: Logger,
  action: string,
  name: string,
  error: unknown,
): string {
  logger.error(
    `ENS subname ${action} failed for ${name}: ${describe(error)}`,
    error instanceof Error ? error.stack : undefined,
  );
  if (error instanceof EnsSubnameError || error instanceof PaymentError) {
    return JSON.stringify({
      action,
      created: false,
      code: error.code,
      retryable: error.retryable,
      error: error.message,
      guidance:
        error.code === 'CHAIN_UNAVAILABLE'
          ? 'Tell the user Ethereum is temporarily unreachable.'
          : 'Repeat the error accurately. Never claim the subname was created.',
    });
  }
  if (error instanceof DomainError) {
    return JSON.stringify({
      action,
      created: false,
      code: 'INVALID_REQUEST',
      retryable: false,
      error: error.message,
    });
  }
  return JSON.stringify({
    action,
    created: false,
    code: 'UNEXPECTED_ERROR',
    retryable: false,
    error: 'The ENS subname tool failed unexpectedly',
  });
}

function confirmationPhrase(name: string): string {
  return `CONFIRM BUY ${name.toUpperCase()}`;
}

export function authorizeEnsSubnamePurchase(opts: {
  threadId: unknown;
  latestUserText: string;
  allowedTelegramChatIds: ReadonlySet<string>;
  name: string;
}): { allowed: true } | { allowed: false } {
  const chatId = telegramChatId(opts.threadId);
  if (
    chatId === undefined ||
    !opts.allowedTelegramChatIds.has(chatId) ||
    normalize(opts.latestUserText) !== confirmationPhrase(opts.name)
  ) {
    return { allowed: false };
  }
  return { allowed: true };
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

function latestHumanText(messages: BaseMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.getType() === 'human') {
      return typeof message.content === 'string' ? message.content : '';
    }
  }
  return '';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
