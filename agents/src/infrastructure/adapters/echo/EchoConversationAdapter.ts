import type { ConversationPort } from "../../../app/ports/conversation/ConversationPort.js";

export class EchoConversationAdapter implements ConversationPort {
  async reply(_threadId: string, message: string): Promise<string> {
    return `echo: ${message}`;
  }
}