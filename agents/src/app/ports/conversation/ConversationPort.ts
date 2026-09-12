export const CONVERSATION_PORT = Symbol("ConversationPort");

/** Proven by SIWE on the agent, never taken from the user's chat text. */
export type ConversationIdentity = {
  address: string;
  boundAt: Date;
};

export interface ConversationPort {
  reply(
    threadId: string,
    message: string,
    identity: ConversationIdentity,
  ): Promise<string>;
}