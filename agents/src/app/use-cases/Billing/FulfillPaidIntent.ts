import { Logger } from "@nestjs/common";
import { formatEther } from "viem";
import type { PaidIntent } from "../../../domain/billing/PaidIntent.js";
import { A2A_CHANNEL } from "../../../domain/billing/PaymentPolicy.js";
import {
  ensAppUrl,
  explorerTxUrl,
} from "../../../domain/billing/PaymentPolicy.js";
import type { PaymentSession } from "../../../domain/billing/PaymentSession.js";
import type { OutboundMessagingPort } from "../../ports/messaging/OutboundMessagingPort.js";
import type { PurchaseEnsName } from "../PurchaseEnsName/PurchaseEnsName.js";
import type { ScheduleEnsPurchase } from "../EnsWatch/ScheduleEnsPurchase.js";
import type { CreateEnsSubname } from "../CreateEnsSubname/CreateEnsSubname.js";
import type { EnsRegistrationReceipt } from "../../ports/ens/EnsRegistrarPort.js";
import type { EnsDropWatch } from "../../../domain/ens/EnsDropWatch.js";
import type { EnsPurchaseQuote } from "../PurchaseEnsName/PurchaseEnsName.js";

export type PaidIntentOutcome =
  | {
      type: "ens.buy";
      name: string;
      owner: string;
      transactionHash: string;
      totalPaidWei: string;
      message: string;
    }
  | {
      type: "ens.subname";
      name: string;
      owner: string;
      transactionHash: string;
      message: string;
    }
  | {
      type: "ens.schedule";
      kind: "scheduled";
      name: string;
      workflowId: string;
      watch: EnsDropWatch;
      quote: EnsPurchaseQuote;
      message: string;
    }
  | {
      type: "ens.schedule";
      kind: "buy-now";
      name: string;
      quote: EnsPurchaseQuote;
      message: string;
    };

export class FulfillPaidIntent {
  private readonly logger = new Logger(FulfillPaidIntent.name);

  constructor(
    private readonly purchase: PurchaseEnsName,
    private readonly createSubname: CreateEnsSubname,
    private readonly schedule: ScheduleEnsPurchase,
    private readonly messaging: OutboundMessagingPort,
    private readonly ensChainId: number,
  ) {}

  public async execute(
    intent: PaidIntent,
    session: PaymentSession,
  ): Promise<PaidIntentOutcome> {
    try {
      const outcome = await this.run(intent, session);
      if (session.channel === "telegram") {
        await this.messaging.send({
          channel: session.channel,
          recipientId: session.recipientId,
          message: outcome.message,
        });
      }
      return outcome;
    } catch (error) {
      this.logger.error(
        `Paid intent failed after settlement (${session.nonce})`,
        error instanceof Error ? error.stack : String(error),
      );
      if (session.channel === "telegram") {
        await this.messaging.send({
          channel: session.channel,
          recipientId: session.recipientId,
          message:
            "Payment was received, but the job failed. The USDC is not refunded automatically. Tell DeFiCat support with your Telegram chat.",
        });
      }
      throw error;
    }
  }

  private async run(
    intent: PaidIntent,
    session: PaymentSession,
  ): Promise<PaidIntentOutcome> {
    if (intent.type === "ens.buy") {
      const receipt = await this.purchase.execute({
        label: intent.label,
        years: intent.years,
      });
      return this.bought(receipt);
    }

    if (intent.type === "ens.subname") {
      const receipt = await this.createSubname.execute({ name: intent.name });
      return {
        type: "ens.subname",
        name: receipt.name,
        owner: receipt.owner,
        transactionHash: receipt.transactionHash,
        message: this.ensMintedMessage({
          title: `Created ${receipt.name}.`,
          name: receipt.name,
          transactionHash: receipt.transactionHash,
          extra: [`Owner: ${receipt.owner}`],
        }),
      };
    }

    const result = await this.schedule.execute({
      label: intent.label,
      years: intent.years,
      chatId: session.recipientId,
      skipAllowlist: session.channel === A2A_CHANNEL,
    });
    if (result.kind === "buy-now") {
      return {
        type: "ens.schedule",
        kind: "buy-now",
        name: result.quote.name,
        quote: result.quote,
        message: `${result.quote.name} is available within budget now. Use purchase_ens instead of a watch.`,
      };
    }
    return {
      type: "ens.schedule",
      kind: "scheduled",
      name: result.watch.name,
      workflowId: result.workflowId,
      watch: result.watch,
      quote: result.quote,
      message: `Watching ${result.watch.name}. It will be bought automatically once it drops within budget.`,
    };
  }

  private bought(receipt: EnsRegistrationReceipt): PaidIntentOutcome {
    return {
      type: "ens.buy",
      name: receipt.name,
      owner: receipt.owner,
      transactionHash: receipt.registrationTransactionHash,
      totalPaidWei: receipt.totalPaidWei,
      message: this.ensMintedMessage({
        title: `Registered ${receipt.name}.`,
        name: receipt.name,
        transactionHash: receipt.registrationTransactionHash,
        extra: [
          `Owner: ${receipt.owner}`,
          `Paid onchain: ${formatEther(BigInt(receipt.totalPaidWei))} ETH`,
        ],
      }),
    };
  }

  private ensMintedMessage(input: {
    title: string;
    name: string;
    transactionHash: string;
    extra: string[];
  }): string {
    const txUrl =
      explorerTxUrl(this.ensChainId, input.transactionHash) ??
      input.transactionHash;
    return [
      input.title,
      ...input.extra,
      "",
      txUrl,
      ensAppUrl(this.ensChainId, input.name),
    ].join('\n');
  }
}
