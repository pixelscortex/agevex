"use client";
import { Input } from "@/components/ui/input";
import { ChangeEvent, SubmitEvent, useState } from "react";
import { Send, Smile, Image, Paperclip, Mic } from "lucide-react";
import { Chat } from "@/components/shadcn-space/blocks/chat-application-01/types";

type Props = {
  selectedChat: Chat | null;
  onSendMessage: (chatId: number, message: string) => void;
};

const ChatMsgSent = ({ selectedChat, onSendMessage }: Props) => {
  const [msg, setMsg] = useState<string>("");

  const handleChatMsgChange = (e: ChangeEvent<HTMLInputElement>) => {
    setMsg(e.target.value);
  };

  const onChatMsgSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!msg.trim() || !selectedChat) return;
    onSendMessage(selectedChat.id, msg.trim());
    setMsg("");
  };

  return (
    <>
      <form onSubmit={onChatMsgSubmit}>
        <div className="flex flex-wrap gap-3 items-center py-2 px-5">
          <div>
            <div className="h-9 w-9 flex justify-center items-center rounded-lg hover:bg-primary/5 hover:text-primary cursor-pointer bg-transparent ">
              <Smile size="20" />
            </div>
          </div>
          <div className="flex-1 min-w-37.5">
            <Input
              className=" border-0 shadow-none"
              required
              value={msg}
              onChange={handleChatMsgChange}
              placeholder="Type here"
            />
          </div>
          <div className="flex gap-3 items-center">
            <div className="h-9 w-9 flex justify-center items-center rounded-lg hover:bg-primary/5 hover:text-primary cursor-pointer bg-transparent  ">
              <Send
                size="20"
                onClick={() => {
                  if (!msg.trim() || !selectedChat) return;
                  onSendMessage(selectedChat.id, msg.trim());
                  setMsg("");
                }}
              />
            </div>
            <div className="h-9 w-9 flex justify-center items-center rounded-lg hover:bg-primary/5 hover:text-primary cursor-pointer bg-transparent ">
              <Image size="20" />
            </div>
            <div className="h-9 w-9 flex justify-center items-center rounded-lg hover:bg-primary/5 hover:text-primary cursor-pointer bg-transparent ">
              <Paperclip size="20" />
            </div>
            <div className="h-9 w-9 flex justify-center items-center rounded-lg hover:bg-primary/5 hover:text-primary cursor-pointer bg-transparent ">
              <Mic size="20" />
            </div>
          </div>
        </div>
      </form>
    </>
  );
};

export default ChatMsgSent;
