import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { TavilySearch } from "@langchain/tavily";
import type { ConversationPort } from "../../../app/ports/conversation/ConversationPort.js";

type Graph = ReturnType<typeof createAgent>;

export class LangGraphConversationAdapter implements ConversationPort {
  constructor(private readonly graph: Graph) {}

  static create(opts: {
    apiKey: string;
    baseURL: string;
    tavilyApiKey: string;
    model: string;
    systemPrompt: string;
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
      topic: "general",
    });
    const graph = createAgent({
      model,
      tools: [search],
      checkpointer: new MemorySaver(),
      systemPrompt: opts.systemPrompt,
    });
    return new LangGraphConversationAdapter(graph);
  }

  async reply(threadId: string, message: string): Promise<string> {
    const result = await this.graph.invoke(
      { messages: [{ role: "user", content: message }] },
      { configurable: { thread_id: threadId } },
    );
    const last = result.messages.at(-1);
    if (last === undefined) return "";
    const content = last.content;
    return typeof content === "string" ? content : JSON.stringify(content);
  }
}
