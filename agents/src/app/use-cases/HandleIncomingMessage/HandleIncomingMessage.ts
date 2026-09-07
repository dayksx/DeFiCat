import type { Agent } from "../../../domain/agent/Agent.js";
import type { ConversationPort } from "../../ports/conversation/ConversationPort.js";
import type {
  InboundMessage,
  OutboundMessagingPort,
} from "../../ports/messaging/OutboundMessagingPort.js";

export class HandleIncomingMessage {
  constructor(
    private readonly conversation: ConversationPort,
    private readonly messaging: OutboundMessagingPort,
    private readonly agent: Agent,
  ) {}

  public async execute(inbound: InboundMessage): Promise<void> {
    this.agent.assertCanHandle(inbound.channel);
    const threadId = `${this.agent.id}:${inbound.channel}:${inbound.recipientId}`;
    const reply = await this.conversation.reply(threadId, inbound.message);
    await this.messaging.send({
      channel: inbound.channel,
      recipientId: inbound.recipientId,
      message: reply,
    });
  }
}