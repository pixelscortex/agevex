import { useUIMessages } from "@convex-dev/agent/react";
import { useMutation, useQuery } from "convex/react";
import { Moon, Sparkles, Sun } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import ChatApplication from "./components/shadcn-space/blocks/chat-application-01";
import type { Chat, ChatStatus } from "./components/shadcn-space/blocks/chat-application-01/types";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { api } from "./convex-api";

const AVATAR = "/agent-avatar.svg";

export function ChatPlayground() {
  const [threadId, setThreadId] = useState<string>();
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

  const liveChat = useMemo<Chat>(() => {
    const status: ChatStatus =
      activity?.turnStatus === "recovery_required"
        ? "offline"
        : activity?.turnStatus === "queued" || activity?.turnStatus === "running"
          ? "busy"
          : "online";

    return {
      id: 1,
      name: "Main agent",
      status,
      thumb: AVATAR,
      excerpt: "Native Convex Agent with managed queueing",
      messages: messages.results.map((message, index) => ({
        id: index + 1,
        senderId: message.role === "user" ? 0 : 1,
        msg: message.text,
        type: "text" as const,
        createdAt: new Date(message._creationTime),
        attachment: [],
      })),
    };
  }, [activity?.turnStatus, messages.results]);

  async function sendMessage(text: string) {
    const requestKey = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    setError(undefined);
    try {
      const receipt = threadId
        ? await send({ threadId, text, requestKey })
        : await open({ agent: "main", prompt: text, requestKey });
      setThreadId(receipt.threadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The message could not be sent.");
    }
  }

  function resetSession() {
    setThreadId(undefined);
    setError(undefined);
  }

  const recoveryRequired = activity?.turnStatus === "recovery_required";

  return (
    <main className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between px-5 py-3">
        <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-xs shadow-lg backdrop-blur">
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Sparkles className="h-3 w-3" />
          </div>
          <span className="font-semibold">Agevex</span>
          <Badge className="hidden border-primary/20 bg-primary/10 text-primary sm:inline-flex">
            Convex agent runtime
          </Badge>
        </div>
        <Button
          aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
          className="pointer-events-auto rounded-full border border-border/70 bg-background/80 text-muted-foreground shadow-lg backdrop-blur"
          size="icon"
          variant="ghost"
          onClick={() => setDark((value) => !value)}
        >
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
      </div>

      {recoveryRequired ? (
        <div className="absolute inset-x-0 top-14 z-20 mx-auto flex max-w-xl items-center justify-between gap-4 rounded-xl border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-200 shadow-lg backdrop-blur">
          <span>Session recovery required: {activity?.errorCode ?? "turn did not finish"}.</span>
          <Button className="shrink-0" size="sm" variant="outline" onClick={resetSession}>
            New session
          </Button>
        </div>
      ) : null}

      <ChatApplication chatData={[liveChat]} onSendMessage={(_chatId, text) => sendMessage(text)} />

      {error ? (
        <div className="absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive shadow-lg">
          {error}
        </div>
      ) : null}
    </main>
  );
}
