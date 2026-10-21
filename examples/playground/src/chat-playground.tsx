import { useUIMessages } from "@convex-dev/agent/react";
import { useMutation, useQuery } from "convex/react";
import { LoaderCircle, Send } from "lucide-react";
import { useState } from "react";

import { api } from "./convex-api";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { ScrollArea } from "./components/ui/scroll-area";
import { Textarea } from "./components/ui/textarea";

export function ChatPlayground() {
  const [threadId, setThreadId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [requestNumber, setRequestNumber] = useState(0);
  const [sending, setSending] = useState(false);
  const open = useMutation(api.agents.open);
  const send = useMutation(api.agents.send);
  const activity = useQuery(api.agents.activity, threadId ? { threadId } : "skip");
  const messages = useUIMessages(api.agents.messages, threadId ? { threadId } : "skip", {
    initialNumItems: 50,
    stream: true,
  });

  async function submit() {
    const text = draft.trim();
    if (!text || sending) return;

    setSending(true);
    setDraft("");
    const requestKey = `playground-${requestNumber + 1}`;
    setRequestNumber((value) => value + 1);

    try {
      const receipt = threadId
        ? await send({ threadId, text, requestKey })
        : await open({ agent: "main", prompt: text, requestKey });
      setThreadId(receipt.threadId);
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="min-h-screen bg-muted/30 p-6 text-foreground">
      <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1fr_280px]">
        <Card className="flex min-h-[calc(100vh-3rem)] flex-col">
          <CardHeader className="border-b">
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle>Agevex playground</CardTitle>
                <CardDescription>
                  Native Convex Agent messages with managed queueing.
                </CardDescription>
              </div>
              <Badge>{activity?.turnStatus ?? "new"}</Badge>
            </div>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-4 pt-6">
            <ScrollArea className="flex-1 space-y-4">
              {messages.results.length === 0 ? (
                <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                  Ask the agent anything to open a managed session.
                </div>
              ) : (
                messages.results.map((message) => (
                  <div
                    className={`mb-4 rounded-lg px-4 py-3 text-sm ${
                      message.role === "user"
                        ? "ml-10 bg-primary text-primary-foreground"
                        : "mr-10 bg-muted"
                    }`}
                    key={message.key}
                  >
                    <div className="mb-1 text-xs font-medium opacity-70">{message.role}</div>
                    <div className="whitespace-pre-wrap">{message.text}</div>
                  </div>
                ))
              )}
            </ScrollArea>
            <div className="flex gap-3">
              <Textarea
                aria-label="Message"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void submit();
                  }
                }}
                placeholder="Ask the managed agent..."
              />
              <Button
                aria-label="Send message"
                disabled={!draft.trim() || sending}
                size="icon"
                onClick={() => void submit()}
              >
                {sending ? <LoaderCircle className="animate-spin" /> : <Send />}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">Runtime activity</CardTitle>
            <CardDescription>Coordination state comes from Convex.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Thread</span>
              <span className="max-w-32 truncate">{threadId ?? "Not opened"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Queued messages</span>
              <span>{activity?.queuedMessages ?? 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Child runs</span>
              <span>{activity?.subagents.total ?? 0}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
