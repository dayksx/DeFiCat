import type { Agent } from "../../../domain/agent/Agent.js";
import type { SiweBindPolicy } from "../../../domain/identity/SiweBindPolicy.js";
import type { ClockPort } from "../../ports/clock/ClockPort.js";
import type { ConversationPort } from "../../ports/conversation/ConversationPort.js";
import type { IdentityStorePort } from "../../ports/identity/IdentityStorePort.js";
import type { TokenGeneratorPort } from "../../ports/identity/TokenGeneratorPort.js";
import type {
  InboundMessage,
  OutboundMessagingPort,
} from "../../ports/messaging/OutboundMessagingPort.js";
import type { SiweIssuance } from "../SiweAuth/SiweIssuance.js";

export class HandleIncomingMessage {
  constructor(
    private readonly conversation: ConversationPort,
    private readonly messaging: OutboundMessagingPort,
    private readonly agent: Agent,
    private readonly identities: IdentityStorePort,
    private readonly tokens: TokenGeneratorPort,
    private readonly clock: ClockPort,
    private readonly policy: SiweBindPolicy,
    private readonly issuance: SiweIssuance,
  ) {}

  public async execute(inbound: InboundMessage): Promise<void> {
    this.agent.assertCanHandle(inbound.channel);

    const binding = await this.identities.findBinding(
      inbound.channel,
      inbound.recipientId,
    );
    if (binding === undefined) {
      await this.messaging.send({
        channel: inbound.channel,
        recipientId: inbound.recipientId,
        message: this.policy.wallMessage(
          await this.ensureChallenge(inbound),
        ),
      });
      return;
    }

    const threadId = `${this.agent.id}:${inbound.channel}:${inbound.recipientId}`;
    const reply = await this.conversation.reply(threadId, inbound.message, {
      address: binding.address,
      boundAt: binding.boundAt,
    });
    await this.messaging.send({
      channel: inbound.channel,
      recipientId: inbound.recipientId,
      message: reply,
    });
  }

  private async ensureChallenge(inbound: InboundMessage) {
    const now = this.clock.now();
    const open = await this.identities.findOpenChallenge(
      inbound.channel,
      inbound.recipientId,
    );
    if (open !== undefined && !this.policy.isExpired(open, now)) {
      return open;
    }
    const challenge = this.policy.issue({
      nonce: this.tokens.nextSiweNonce(),
      channel: inbound.channel,
      recipientId: inbound.recipientId,
      now,
      uiOrigin: this.issuance.uiOrigin,
    });
    await this.identities.saveChallenge(challenge);
    return challenge;
  }
}