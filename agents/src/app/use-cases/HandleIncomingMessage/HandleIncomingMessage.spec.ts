import { describe, expect, it } from "vitest";
import { HandleIncomingMessage } from "./HandleIncomingMessage.js";
import { Agent } from "../../../domain/agent/Agent.js";
import { AgentId } from "../../../domain/agent/AgentId.js";
import type { ConversationPort } from "../../ports/conversation/ConversationPort.js";
import type {
  OutboundMessagingPort,
  OutboundMessage,
} from "../../ports/messaging/OutboundMessagingPort.js";

class FakeConversation implements ConversationPort {
  lastThreadId: string | undefined;

  async reply(threadId: string, message: string): Promise<string> {
    this.lastThreadId = threadId;
    return `ok:${message}`;
  }
}

class FakeMessaging implements OutboundMessagingPort {
  sent: OutboundMessage[] = [];
  async send(m: OutboundMessage): Promise<void> {
    this.sent.push(m);
  }
}

describe("HandleIncomingMessage", () => {
  it("replies to any telegram recipient", async () => {
    const agent = new Agent(AgentId.of("defichat"), "p");
    const conversation = new FakeConversation();
    const messaging = new FakeMessaging();
    const uc = new HandleIncomingMessage(conversation, messaging, agent);

    await uc.execute({
      channel: "telegram",
      recipientId: "999",
      message: "gm",
    });

    expect(conversation.lastThreadId).toBe("defichat:telegram:999");
    expect(messaging.sent[0]?.message).toBe("ok:gm");
    expect(messaging.sent[0]?.recipientId).toBe("999");
  });
});