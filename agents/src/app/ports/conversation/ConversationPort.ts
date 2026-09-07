export const CONVERSATION_PORT = Symbol("ConversationPort");

export interface ConversationPort {
  reply(threadId: string, message: string): Promise<string>;
}