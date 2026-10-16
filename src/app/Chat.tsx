"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Msg = { id: string; role: "user" | "assistant"; content: string };
type ToolCallTrace = { name: string; arguments: string; ok: boolean; code?: string; deduplicated?: boolean; ms: number };
type Trace = {
  id: string;
  promptVersion: string;
  model: string;
  contextTokens: number;
  includedMemoryIds: string[];
  droppedMessageCount: number;
  toolCalls: ToolCallTrace[];
  unbackedClaims: string[];
  latencyMs: number;
  costUsd: number | null;
  error: string | null;
};
type MemoryView = { id: string; key: string; content: string; scope: "USER" | "CONVERSATION" };

export default function Chat({ conversationId, userName }: { conversationId: string; userName: string }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [memories, setMemories] = useState<MemoryView[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/chat?conversationId=${encodeURIComponent(conversationId)}`);
    if (!res.ok) return;
    const data = await res.json();
    setMessages(data.messages);
    setTraces(data.traces);
    setMemories(data.memories);
    setSummary(data.summary);
  }, [conversationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setInput("");
    setMessages((m) => [...m, { id: `pending-${Date.now()}`, role: "user", content: text }]);

    // One requestId per message: if the network drops and we retry, the
    // server resumes the same turn instead of running its actions twice.
    const requestId = crypto.randomUUID();
    const body = JSON.stringify({ conversationId, text, requestId });
    try {
      let res = await post(body);
      if (!res.ok && res.status >= 500) res = await post(body);
      if (!res.ok) setError((await res.json().catch(() => null))?.error ?? `Request failed (${res.status})`);
    } catch {
      setError("Network error. Your message may not have been processed.");
    } finally {
      await refresh();
      setBusy(false);
    }
  }

  const last = traces[0];

  return (
    <div className="shell">
      <section className="chat">
        <header>
          <h1>Ask</h1>
          <span className="muted">signed in as {userName}</span>
        </header>
        <div className="log">
          {messages.length === 0 && (
            <div className="hint">
              Try: <em>“What should I focus on today?”</em>, <em>“From now on, answer in Spanish”</em>,{" "}
              <em>“Add a task to call Lena on Friday”</em>, <em>“What do my notes say about Northwind?”</em>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.content}
            </div>
          ))}
          {busy && <div className="msg assistant thinking">Thinking…</div>}
          <div ref={bottom} />
        </div>
        {error && <div className="error">{error}</div>}
        <form onSubmit={send}>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Message Ask…" disabled={busy} />
          <button disabled={busy || !input.trim()}>Send</button>
        </form>
      </section>

      <aside className="panel">
        <h2>Under the hood</h2>

        <h3>Memory</h3>
        {memories.length === 0 ? (
          <p className="muted">Nothing remembered yet.</p>
        ) : (
          <ul className="mem">
            {memories.map((m) => (
              <li key={m.id}>
                <code>{m.key}</code> {m.content}
                <span className="tag">{m.scope === "USER" ? "lasting" : "this chat"}</span>
              </li>
            ))}
          </ul>
        )}

        {summary && (
          <>
            <h3>Rolling summary</h3>
            <p className="small">{summary}</p>
          </>
        )}

        <h3>Last turn</h3>
        {!last ? (
          <p className="muted">No turns yet.</p>
        ) : (
          <div className="trace">
            <div>
              prompt <b>{last.promptVersion}</b> · {last.model}
            </div>
            <div>
              ~{last.contextTokens} context tokens · {last.latencyMs} ms
              {last.costUsd != null && ` · $${last.costUsd.toFixed(5)}`}
            </div>
            <div>
              {last.includedMemoryIds.length} memories in context · {last.droppedMessageCount} older messages summarized
            </div>
            {last.toolCalls.length > 0 && (
              <ul className="calls">
                {last.toolCalls.map((c, i) => (
                  <li key={i} className={c.ok ? "ok" : "fail"}>
                    {c.ok ? "✓" : "✗"} <code>{c.name}</code> <span className="args">{c.arguments}</span>
                    {c.code && <span className="tag">{c.code}</span>}
                    {c.deduplicated && <span className="tag">deduplicated</span>}
                  </li>
                ))}
              </ul>
            )}
            {last.unbackedClaims.length > 0 && (
              <div className="warn">Reply claims an action with no successful tool call: {last.unbackedClaims.join(", ")}</div>
            )}
            {last.error && <div className="warn">Error: {last.error}</div>}
          </div>
        )}
      </aside>
    </div>
  );

  function post(body: string) {
    return fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  }
}
