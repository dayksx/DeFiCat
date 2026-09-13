import { Logger } from "@nestjs/common";
import { formatEther } from "viem";
import type { PaidIntent } from "../../../domain/billing/PaidIntent.js";
import type { PaymentSession } from "../../../domain/billing/PaymentSession.js";
import type { OutboundMessagingPort } from "../../ports/messaging/OutboundMessagingPort.js";
import type { PurchaseEnsName } from "../PurchaseEnsName/PurchaseEnsName.js";
import type { ScheduleEnsPurchase } from "../EnsWatch/ScheduleEnsPurchase.js";

export class FulfillPaidIntent {
  private readonly logger = new Logger(FulfillPaidIntent.name);

  constructor(
    private readonly purchase: PurchaseEnsName,
    private readonly schedule: ScheduleEnsPurchase,
    private readonly messaging: OutboundMessagingPort,
  ) {}

  public async execute(
    intent: PaidIntent,
    session: PaymentSession,
  ): Promise<void> {
    try {
      const message = await this.run(intent, session);
      await this.messaging.send({
        channel: session.channel,
        recipientId: session.recipientId,
        message,
      });
    } catch (error) {
      this.logger.error(
        `Paid intent failed after settlement (${session.nonce})`,
        error instanceof Error ? error.stack : String(error),
      );
      await this.messaging.send({
        channel: session.channel,
        recipientId: session.recipientId,
        message:
          "Payment was received, but the job failed. The USDC is not refunded automatically. Tell DeFiCat support with your Telegram chat.",
      });
    }
  }

  private async run(
    intent: PaidIntent,
    session: PaymentSession,
  ): Promise<string> {
    if (intent.type === "ens.buy") {
      const receipt = await this.purchase.execute({
        label: intent.label,
        years: intent.years,
      });
      return [
        `Registered ${receipt.name}.`,
        `Owner: ${receipt.owner}`,
        `Tx: ${receipt.registrationTransactionHash}`,
        `Paid onchain: ${formatEther(BigInt(receipt.totalPaidWei))} ETH`,
      ].join("\n");
    }

    const result = await this.schedule.execute({
      label: intent.label,
      years: intent.years,
      chatId: session.recipientId,
    });
    if (result.kind === "buy-now") {
      return `${result.quote.name} is available within budget now. Use purchase_ens instead of a watch.`;
    }
    return `Watching ${result.watch.name}. It will be bought automatically once it drops within budget.`;
  }
}
