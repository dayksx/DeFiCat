import { Logger } from '@nestjs/common';
import type { BaseMessage } from '@langchain/core/messages';
import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from 'langchain';
import { formatEther } from 'viem';
import { z } from 'zod';
import { DomainError } from '../../../../domain/errors/DomainError.js';
import { EnsWatchError } from '../../../../app/use-cases/EnsWatch/EnsWatchError.js';
import type { ScheduleEnsPurchase } from '../../../../app/use-cases/EnsWatch/ScheduleEnsPurchase.js';
import type { CancelEnsWatch } from '../../../../app/use-cases/EnsWatch/CancelEnsWatch.js';
import type { ListEnsWatches } from '../../../../app/use-cases/EnsWatch/ListEnsWatches.js';
import type { EnsWatchView } from '../../../../app/ports/watch/EnsWatchSchedulerPort.js';
import type { IsoZoneFormatter } from '../../../time/createIsoZoneFormatter.js';
import { telegramChatId } from './telegramChatId.js';

type MessagesState = { messages: BaseMessage[] };

/** Told to the model so it reacts to each failure instead of improvising. */
const GUIDANCE: Record<string, string> = {
  UNAUTHORIZED_CHAT:
    'Tell the user this chat cannot manage agent watches. Do not retry.',
  ALREADY_WATCHED:
    'Tell the user this name is already being watched, and offer list_ens_watches. Do not retry.',
  WATCH_NOT_FOUND: 'Tell the user no watch exists for that name. Do not retry.',
  WATCH_NOT_ACTIVE:
    'Tell the user that watch already finished, and report its status. Do not retry.',
  NOT_WATCH_OWNER:
    'Tell the user the watch belongs to another chat and cannot be cancelled here.',
  DROP_DATE_UNKNOWN:
    'Tell the user the release date is unknown, so no watch can be armed. Do not retry.',
  LOOKUP_UNAVAILABLE:
    'Tell the user ENS records are unreachable and offer to try again in a moment.',
  SCHEDULER_UNAVAILABLE:
    'Tell the user the scheduler is unreachable and offer to try again in a moment.',
  NOT_AUTHORIZED:
    'Tell the user this chat cannot commit agent funds, or ask for the exact confirmation phrase.',
  UNEXPECTED_ERROR:
    'Tell the user the request failed. Never claim a watch was armed.',
};

export function createEnsWatchTools(opts: {
  scheduleEnsPurchase: ScheduleEnsPurchase;
  cancelEnsWatch: CancelEnsWatch;
  listEnsWatches: ListEnsWatches;
  allowedTelegramChatIds: ReadonlySet<string>;
  toLocalIso: IsoZoneFormatter;
}) {
  const logger = new Logger('EnsWatchTools');

  const scheduleEns = tool(
    async (input, runtime: ToolRuntime<MessagesState>): Promise<string> => {
      const chatId = telegramChatId(runtime.config.configurable?.thread_id);
      if (chatId === undefined || !opts.allowedTelegramChatIds.has(chatId)) {
        return unauthorized('schedule');
      }

      // Un watch dépense sans nouvelle validation humaine le jour venu, donc il
      // demande la même confirmation explicite qu'un achat immédiat.
      const confirmation = confirmationPhrase(input.name, input.years);
      if (
        normalize(latestHumanText(runtime.state.messages)) !== confirmation
      ) {
        return JSON.stringify({
          action: 'schedule',
          scheduled: false,
          code: 'NOT_AUTHORIZED',
          retryable: false,
          error:
            'Explicit confirmation is missing. Ask the user to send the exact confirmation phrase alone.',
          confirmationRequired: confirmation,
          guidance: GUIDANCE.NOT_AUTHORIZED,
        });
      }

      try {
        const result = await opts.scheduleEnsPurchase.execute({
          label: input.name,
          years: input.years,
          chatId,
        });

        if (result.kind === 'buy-now') {
          return JSON.stringify({
            action: 'schedule',
            scheduled: false,
            name: result.quote.name,
            message: `${result.quote.name} is already available within budget. No watch is needed: use purchase_ens instead.`,
          });
        }

        logger.log(`Armed watch ${result.workflowId} for chat ${chatId}`);
        return JSON.stringify({
          action: 'schedule',
          scheduled: true,
          // Retourné ici pour que le modèle n'ait pas à re-lister : la
          // visibility de Temporal est en cohérence différée.
          watch: describeWatch(
            { ...result.watch, workflowId: result.workflowId, status: 'scheduled', armedAt: new Date().toISOString() },
            opts.toLocalIso,
          ),
          message: `Watching ${result.watch.name}. It will be bought automatically once it drops and its price is within budget.`,
        });
      } catch (error) {
        return failure(logger, 'schedule', input.name, error);
      }
    },
    {
      name: 'schedule_ens',
      description:
        'Watch a .eth name that cannot be bought right now, and buy it automatically the moment it drops and its price falls within the agent budget. Only for names that purchase_ens reported as taken or over budget: never call it for a name that is already available within budget. Requires the exact confirmation phrase, because the purchase happens later without asking again.',
      schema: z.object({
        name: z.string().describe('Second-level ENS name, e.g. deficat.eth'),
        years: z.number().int().min(1).max(5).default(1),
      }),
    },
  );

  const listEnsWatches = tool(
    async (input, runtime: ToolRuntime<MessagesState>): Promise<string> => {
      const chatId = telegramChatId(runtime.config.configurable?.thread_id);
      if (chatId === undefined || !opts.allowedTelegramChatIds.has(chatId)) {
        return unauthorized('list');
      }

      try {
        const watches = await opts.listEnsWatches.execute({
          chatId,
          includeFinished: input.includeFinished,
        });

        return JSON.stringify({
          action: 'list',
          count: watches.length,
          watches: watches.map((watch) =>
            describeWatch(watch, opts.toLocalIso),
          ),
          message:
            watches.length === 0
              ? 'No ENS watch is armed for this chat.'
              : `${watches.length} ENS watch(es) for this chat.`,
        });
      } catch (error) {
        return failure(logger, 'list', 'watches', error);
      }
    },
    {
      name: 'list_ens_watches',
      description:
        'List the ENS names this chat is waiting to buy, with the status of each one. Use it whenever the user asks what is scheduled, watched, or pending. Set includeFinished to also report watches that already succeeded, expired or were cancelled.',
      schema: z.object({
        includeFinished: z.boolean().default(false),
      }),
    },
  );

  const cancelEnsWatch = tool(
    async (input, runtime: ToolRuntime<MessagesState>): Promise<string> => {
      const chatId = telegramChatId(runtime.config.configurable?.thread_id);
      if (chatId === undefined || !opts.allowedTelegramChatIds.has(chatId)) {
        return unauthorized('cancel');
      }

      try {
        const result = await opts.cancelEnsWatch.execute({
          label: input.name,
          chatId,
        });
        logger.log(`Cancelled watch ${result.workflowId} for chat ${chatId}`);
        return JSON.stringify({
          action: 'cancel',
          cancelled: true,
          name: result.name,
          message: `Stopped watching ${result.name}. Nothing will be bought.`,
        });
      } catch (error) {
        return failure(logger, 'cancel', input.name, error);
      }
    },
    {
      name: 'cancel_ens_watch',
      description:
        'Stop watching a .eth name, so it will not be bought when it drops. Only the chat that armed the watch can cancel it.',
      schema: z.object({
        name: z.string().describe('Second-level ENS name, e.g. deficat.eth'),
      }),
    },
  );

  return [scheduleEns, listEnsWatches, cancelEnsWatch];
}

/** Wei and unix timestamps are unreadable, and the model would convert them wrong. */
function describeWatch(watch: EnsWatchView, toLocalIso: IsoZoneFormatter) {
  return {
    name: watch.name,
    years: watch.years,
    status: watch.status,
    budgetEth: formatEther(BigInt(watch.maxWei)),
    expectedDropAt: toLocalIso(
      new Date(watch.gracePeriodEndUnix * 1000).toISOString(),
    ),
    armedAt: toLocalIso(watch.armedAt),
  };
}

function unauthorized(action: string): string {
  return JSON.stringify({
    action,
    scheduled: false,
    code: 'UNAUTHORIZED_CHAT',
    retryable: false,
    error: 'This Telegram chat is not authorized to manage agent watches',
    guidance: GUIDANCE.UNAUTHORIZED_CHAT,
  });
}

/**
 * Turns any thrown value into a stable payload for the model. Raw adapter
 * messages (Temporal internals, RPC URLs) stay in the logs.
 */
function failure(
  logger: Logger,
  action: string,
  name: string,
  error: unknown,
): string {
  logger.error(
    `ENS watch ${action} failed for ${name}: ${describe(error)}`,
    error instanceof Error ? error.stack : undefined,
  );

  if (error instanceof EnsWatchError) {
    return JSON.stringify({
      action,
      scheduled: false,
      code: error.code,
      retryable: error.retryable,
      error: error.message,
      guidance: GUIDANCE[error.code],
    });
  }

  // Un label refusé remonte en EnsPurchaseError : ScheduleEnsPurchase valide
  // par la même policy que l'achat immédiat.
  if (error instanceof DomainError) {
    const code = 'code' in error ? String(error.code) : 'UNEXPECTED_ERROR';
    return JSON.stringify({
      action,
      scheduled: false,
      code,
      retryable: false,
      error: error.message,
      guidance: GUIDANCE[code] ?? GUIDANCE.UNEXPECTED_ERROR,
    });
  }

  return JSON.stringify({
    action,
    scheduled: false,
    code: 'UNEXPECTED_ERROR',
    retryable: false,
    error: 'The ENS watch tool failed unexpectedly',
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
  const label = name.trim().toLowerCase().replace(/\.eth$/, '');
  return `CONFIRM WATCH ${label.toUpperCase()}.ETH FOR ${years} YEAR${years === 1 ? '' : 'S'}`;
}

function normalize(value: string): string {
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
