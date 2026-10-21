import { useUIMessages } from "@convex-dev/agent/react";
import { useMutation, useQuery } from "convex/react";
import {
  Activity,
  ArrowUp,
  Bot,
  Check,
  CirclePlus,
  LoaderCircle,
  Moon,
  PanelRight,
  Sparkles,
  Sun,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";

import { api } from "./convex-api";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { ScrollArea } from "./components/ui/scroll-area";
import { Textarea } from "./components/ui/textarea";

export function ChatPlayground() {
  const [threadId, setThreadId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [dark, setDark] = useState(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("agevex-theme") !== "light";
  });
  const open = useMutation(api.agents.open);
  const send = useMutation(api.agents.send);
  const activity = useQuery(api.agents.activity, threadId ? { threadId } : "skip");
  const messages = useUIMessages(api.agents.messages, threadId ? { threadId } : "skip", {
    initialNumItems: 50,
    stream: true,
  });

  useEffect(() => {
    document.documentElement.classList.toggle("light", !dark);
    localStorage.setItem("agevex-theme", dark ? "dark" : "light");
  }, [dark]);

  function resetSession() {
    setThreadId(undefined);
    setDraft("");
    setError(undefined);
  }

  async function submit() {
    const text = draft.trim();
    if (!text || sending) return;

    setSending(true);
    setError(undefined);
    try {
      const requestKey = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      setDraft("");
      const receipt = threadId
        ? await send({ threadId, text, requestKey })
        : await open({ agent: "main", prompt: text, requestKey });
      setThreadId(receipt.threadId);
    } catch (cause) {
      setDraft(text);
      setError(cause instanceof Error ? cause.message : "The message could not be sent.");
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/60 bg-background/75 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-[0_0_24px_color-mix(in_oklab,var(--primary)_35%,transparent)]">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight">Agevex</div>
              <div className="text-[11px] text-muted-foreground">Convex agent runtime</div>
            </div>
            <Badge className="ml-2 hidden border-primary/20 bg-primary/10 text-primary sm:inline-flex">
              Playground
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Badge className="hidden gap-1.5 border-emerald-500/20 bg-emerald-500/10 text-emerald-400 sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_currentColor]" />
              Local runtime
            </Badge>
            <Button
              aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
              className="text-muted-foreground"
              size="icon"
              variant="ghost"
              onClick={() => setDark((value) => !value)}
            >
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl lg:grid-cols-[minmax(0,1fr)_260px]">
        <section className="flex min-h-[calc(100vh-4rem)] min-w-0 flex-col">
          <ScrollArea className="flex-1">
            <div className="mx-auto flex w-full max-w-3xl flex-col px-5 pb-40 pt-10">
              {messages.results.length === 0 ? (
                <div className="flex flex-1 flex-col justify-center py-20">
                  <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
                    <Sparkles className="h-5 w-5" />
                  </div>
                  <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-primary">
                    Managed agent session
                  </p>
                  <h1 className="max-w-xl text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
                    A clean Convex runtime for agents that keep moving.
                  </h1>
                  <p className="mt-4 max-w-lg text-sm leading-6 text-muted-foreground">
                    Try a prompt to open a durable session, stream a native transcript, and inspect
                    the coordination state behind it.
                  </p>
                  <div className="mt-8 flex flex-wrap gap-2">
                    {["Ask a question", "Delegate research", "Queue a follow-up"].map((label) => (
                      <button
                        className="rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                        key={label}
                        onClick={() => setDraft(label)}
                        type="button"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-8">
                  {messages.results.map((message) => {
                    const isUser = message.role === "user";
                    return (
                      <div className={`flex gap-3 ${isUser ? "justify-end" : ""}`} key={message.key}>
                        {!isUser ? (
                          <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                            <Bot className="h-3.5 w-3.5" />
                          </div>
                        ) : null}
                        <div
                          className={`max-w-[min(90%,680px)] ${
                            isUser
                              ? "rounded-2xl rounded-br-md bg-primary px-4 py-3 text-primary-foreground"
                              : "pt-1 text-foreground"
                          }`}
                        >
                          <div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                            {isUser ? <UserRound className="h-3 w-3" /> : null}
                            {isUser ? "You" : "Agevex"}
                            {message.status === "streaming" ? (
                              <span className="text-primary">streaming</span>
                            ) : null}
                          </div>
                          <div className="whitespace-pre-wrap text-sm leading-7">
                            {message.text || (message.status === "streaming" ? "…" : "")}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </ScrollArea>

          <div className="pointer-events-none fixed inset-x-0 bottom-0 z-10 px-4 pb-5 lg:static lg:px-5 lg:pb-7">
            <div className="pointer-events-auto mx-auto max-w-3xl">
              <div className="rounded-2xl border border-border bg-card/90 p-2 shadow-2xl shadow-black/20 backdrop-blur-xl">
                <Textarea
                  aria-label="Message"
                  className="min-h-16 border-0 bg-transparent px-3 py-2 shadow-none focus-visible:ring-0"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                  placeholder="Ask anything…"
                />
                <div className="flex items-center justify-between px-2 pb-1">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Button className="h-8 w-8" size="icon" variant="ghost" onClick={resetSession}>
                      <CirclePlus className="h-4 w-4" />
                    </Button>
                    <span className="hidden sm:inline">Enter to send · Shift + Enter for a new line</span>
                  </div>
                  <Button
                    aria-label="Send message"
                    className="h-9 w-9 rounded-xl"
                    disabled={!draft.trim() || sending}
                    size="icon"
                    onClick={() => void submit()}
                  >
                    {sending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              {error ? (
                <p className="mt-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </div>
        </section>

        <aside className="hidden border-l border-border/60 bg-card/20 px-5 py-8 lg:block">
          <div className="sticky top-8">
            <div className="mb-6 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <PanelRight className="h-4 w-4 text-primary" />
                Runtime
              </div>
              <Badge className="border-border bg-background text-muted-foreground">
                {activity?.turnStatus ?? "new"}
              </Badge>
            </div>
            <div className="space-y-2">
              {[
                ["Thread", threadId ? `${threadId.slice(0, 8)}…` : "Not opened"],
                ["Queued", String(activity?.queuedMessages ?? 0)],
                ["Child runs", String(activity?.subagents.total ?? 0)],
              ].map(([label, value]) => (
                <div className="flex items-center justify-between rounded-xl border border-border/60 bg-background/60 px-3 py-2.5 text-xs" key={label}>
                  <span className="text-muted-foreground">{label}</span>
                  <span className="max-w-28 truncate font-medium">{value}</span>
                </div>
              ))}
            </div>
            <div className="mt-8 rounded-2xl border border-border/60 bg-background/50 p-4">
              <div className="mb-3 flex items-center gap-2 text-xs font-medium">
                <Activity className="h-3.5 w-3.5 text-primary" />
                What this tests
              </div>
              <ul className="space-y-2 text-xs leading-5 text-muted-foreground">
                {["Native transcript streaming", "Durable request receipts", "Queue and delegation state"].map(
                  (item) => (
                    <li className="flex items-start gap-2" key={item}>
                      <Check className="mt-1 h-3 w-3 shrink-0 text-emerald-400" />
                      {item}
                    </li>
                  ),
                )}
              </ul>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
