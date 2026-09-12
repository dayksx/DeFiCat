import type {
  ConversationIdentity,
  ConversationPort,
} from "../../../app/ports/conversation/ConversationPort.js";

export class EchoConversationAdapter implements ConversationPort {
  async reply(
    _threadId: string,
    message: string,
    _identity: ConversationIdentity,
  ): Promise<string> {
    return `echo: ${message}`;
  }
}