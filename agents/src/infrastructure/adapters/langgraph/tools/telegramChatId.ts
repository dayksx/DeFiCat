/**
 * Le `thread_id` LangGraph encode le canal et le destinataire. C'est la seule
 * source de l'identité de l'appelant : le modèle ne doit jamais fournir un
 * chatId lui-même, sinon il suffirait de le lui souffler pour dépenser.
 */
export function telegramChatId(threadId: unknown): string | undefined {
  if (typeof threadId !== 'string') return undefined;
  const match = /^.+:telegram:([^:]+)$/.exec(threadId);
  return match?.[1];
}
