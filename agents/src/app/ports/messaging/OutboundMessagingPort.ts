export const MESSAGING_PORT = Symbol("OutboundMessagingPort");

export type InboundMessage = {
  channel: string;
  recipientId: string;
  message: string;
};

export type OutboundMessage = InboundMessage;

export interface OutboundMessagingPort {
  send(message: OutboundMessage): Promise<void>;
}