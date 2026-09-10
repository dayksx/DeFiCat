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
import { createEnsWatchTools } from './tools/createEnsWatchTools.js';
import { createIsoZoneFormatter } from '../../time/createIsoZoneFormatter.js';
import type { ScheduleEnsPurchase } from '../../../app/use-cases/ScheduleEnsPurchase/ScheduleEnsPurchase.js';
import type { CancelEnsWatch } from '../../../app/use-cases/ScheduleEnsPurchase/CancelEnsWatch.js';
import type { ListEnsWatches } from '../../../app/use-cases/ScheduleEnsPurchase/ListEnsWatches.js';

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
    scheduleEnsPurchase: ScheduleEnsPurchase;
    cancelEnsWatch: CancelEnsWatch;
    listEnsWatches: ListEnsWatches;
    ensBuyerAllowedTelegramChatIds: ReadonlySet<string>;
    /** IANA zone the agent reports dates in, e.g. `Europe/Paris`. */
    timeZone: string;
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
    const toLocalIso = createIsoZoneFormatter(opts.timeZone);
    const lookupEns = createEnsLookupTool(opts.ensLookup, toLocalIso);
    const purchaseEns = createEnsPurchaseTool({
      purchaseEnsName: opts.purchaseEnsName,
      allowedTelegramChatIds: opts.ensBuyerAllowedTelegramChatIds,
    });
    const watchTools = createEnsWatchTools({
      scheduleEnsPurchase: opts.scheduleEnsPurchase,
      cancelEnsWatch: opts.cancelEnsWatch,
      listEnsWatches: opts.listEnsWatches,
      allowedTelegramChatIds: opts.ensBuyerAllowedTelegramChatIds,
      toLocalIso,
    });
    const tools = [search, lookupEns, purchaseEns, ...watchTools];
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
