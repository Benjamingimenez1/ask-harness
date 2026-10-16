// Model access behind a small interface, so the harness can run against
// OpenRouter in production and against a scripted fake in tests and evals.

export type ToolCall = {
  id: string;
  name: string;
  /** Raw JSON string exactly as the model produced it. Parsed and validated later. */
  arguments: string;
};

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; name: string };

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
};

export type ModelRequest = {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
};

export type ModelResponse = {
  content: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
};

export interface ModelClient {
  readonly name: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

// ---------------------------------------------------------------------------
// OpenRouter (OpenAI-compatible chat completions)
// ---------------------------------------------------------------------------

type OpenRouterChoice = {
  message: {
    content: string | null;
    tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  };
};

export class OpenRouterClient implements ModelClient {
  constructor(
    private readonly apiKey: string,
    readonly name: string,
    private readonly baseUrl = "https://openrouter.ai/api/v1",
    private readonly timeoutMs = 45_000,
  ) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const body = {
      model: this.name,
      temperature: req.temperature ?? 0.3,
      max_tokens: req.maxTokens ?? 800,
      messages: req.messages.map(toOpenAIMessage),
      tools: req.tools?.length
        ? req.tools.map((t) => ({ type: "function", function: t }))
        : undefined,
      // Ask OpenRouter to report cost alongside token counts.
      usage: { include: true },
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // "fetch failed" alone is useless when debugging; the cause has the real reason (ECONNREFUSED, timeout, DNS...).
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      const detail = cause ? ` (${cause.code ?? cause.message})` : "";
      throw new ModelError(`Network error calling model: ${(err as Error).message}${detail}`, true);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 429 and 5xx are worth one retry; 4xx means the request itself is wrong.
      const retryable = res.status === 429 || res.status >= 500;
      throw new ModelError(`Model returned HTTP ${res.status}: ${text.slice(0, 300)}`, retryable);
    }

    const json = (await res.json()) as {
      choices?: OpenRouterChoice[];
      usage?: { prompt_tokens: number; completion_tokens: number; cost?: number };
    };
    const choice = json.choices?.[0];
    if (!choice) throw new ModelError("Model returned no choices", true);

    return {
      content: choice.message.content ?? "",
      toolCalls: (choice.message.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })),
      usage: json.usage && {
        inputTokens: json.usage.prompt_tokens,
        outputTokens: json.usage.completion_tokens,
        costUsd: json.usage.cost,
      },
    };
  }
}

function toOpenAIMessage(m: ChatMessage) {
  switch (m.role) {
    case "assistant":
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls?.length
          ? m.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments },
            }))
          : undefined,
      };
    case "tool":
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
    default:
      return { role: m.role, content: m.content };
  }
}

// ---------------------------------------------------------------------------
// Scripted model for tests and offline evals
// ---------------------------------------------------------------------------

/** A step receives the full request and returns what the "model" says next. */
export type ScriptStep = (req: ModelRequest) => ModelResponse | Promise<ModelResponse>;

export class ScriptedModel implements ModelClient {
  readonly name = "scripted";
  readonly requests: ModelRequest[] = [];
  private i = 0;

  constructor(private readonly steps: ScriptStep[]) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(req));
    const step = this.steps[this.i++];
    if (!step) throw new ModelError("ScriptedModel ran out of steps", false);
    return step(req);
  }
}

export const say = (content: string): ScriptStep => () => ({ content, toolCalls: [] });

let callCounter = 0;
export const callTool =
  (name: string, args: Record<string, unknown>, content = ""): ScriptStep =>
  () => ({
    content,
    toolCalls: [{ id: `call_${++callCounter}`, name, arguments: JSON.stringify(args) }],
  });

export function modelFromEnv(): ModelClient {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set. Copy .env.example to .env and add a key.");
  return new OpenRouterClient(
    key,
    process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
    // Overridable so the client can be pointed at any OpenAI-compatible server (or a local mock).
    process.env.OPENROUTER_BASE_URL || undefined,
  );
}
