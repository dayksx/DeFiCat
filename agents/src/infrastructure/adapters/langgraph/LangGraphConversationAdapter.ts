import { SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import {
  MemorySaver,
  MessagesAnnotation,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { TavilySearch } from '@langchain/tavily';
import type { ConversationPort } from '../../../app/ports/conversation/ConversationPort.js';
import type { EnsLookupPort } from '../../../app/ports/graph/EnsLookupPort.js';
import type { PurchaseEnsName } from '../../../app/use-cases/PurchaseEnsName/PurchaseEnsName.js';
import { createEnsLookupTool } from './tools/createEnsLookupTool.js';
import { createEnsPurchaseTool } from './tools/createEnsPurchaseTool.js';

type Graph = ReturnType<typeof compileConversationGraph>;

function compileConversationGraph(opts: {
  modelWithTools: ReturnType<ChatOpenAI['bindTools']>;
  tools: ToolNode;
  systemPrompt: string;
}) {
  const callModel = async (state: typeof MessagesAnnotation.State) => {
    const response = await opts.modelWithTools.invoke([
      new SystemMessage(opts.systemPrompt),
      ...state.messages,
    ]);
    return { messages: [response] };
  };

  return new StateGraph(MessagesAnnotation)
    .addNode('agent', callModel)
    .addNode('tools', opts.tools)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', toolsCondition)
    .addEdge('tools', 'agent')
    .compile({ checkpointer: new MemorySaver() });
}

export class LangGraphConversationAdapter implements ConversationPort {
  constructor(private readonly graph: Graph) {}

  static create(opts: {
    apiKey: string;
    baseURL: string;
    tavilyApiKey: string;
    model: string;
    systemPrompt: string;
    ensLookup: EnsLookupPort;
    purchaseEnsName: PurchaseEnsName;
    ensBuyerAllowedTelegramChatIds: ReadonlySet<string>;
  }): LangGraphConversationAdapter {
    const model = new ChatOpenAI({
      apiKey: opts.apiKey,
      model: opts.model,
      configuration: {
        baseURL: opts.baseURL,
      },
    });
    const search = new TavilySearch({
      tavilyApiKey: opts.tavilyApiKey,
      maxResults: 5,
      topic: 'general',
    });
    const lookupEns = createEnsLookupTool(opts.ensLookup);
    const purchaseEns = createEnsPurchaseTool({
      purchaseEnsName: opts.purchaseEnsName,
      allowedTelegramChatIds: opts.ensBuyerAllowedTelegramChatIds,
    });
    const tools = [search, lookupEns, purchaseEns];
    const graph = compileConversationGraph({
      modelWithTools: model.bindTools(tools),
      tools: new ToolNode(tools),
      systemPrompt: opts.systemPrompt,
    });
    return new LangGraphConversationAdapter(graph);
  }

  async reply(threadId: string, message: string): Promise<string> {
    const result = await this.graph.invoke(
      { messages: [{ role: 'user', content: message }] },
      { configurable: { thread_id: threadId } },
    );
    const last = result.messages.at(-1);
    if (last === undefined) return '';
    const content = last.content;
    return typeof content === 'string' ? content : JSON.stringify(content);
  }
}
