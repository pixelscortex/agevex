import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import React, { useState, useEffect } from "react";
import { last } from "lodash";
import { formatDistanceToNowStrict } from "date-fns";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  AlignHorizontalSpaceAround,
  ChevronDown,
  EllipsisVertical,
  Keyboard,
  LogOut,
  SearchIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Chat, CURRENT_USER_ID } from "@/components/shadcn-space/blocks/chat-application-01/types";

import { Settings, CircleQuestionMark } from "lucide-react";

type Props = {
  chatData: Chat[];
  chatSearch: string;
  setChatSearch: (value: string) => void;
  activeChatId: number | null;
  onSelectChat: (chat: Chat) => void;
};

const ChatListing = ({
  chatData,
  chatSearch,
  setChatSearch,
  activeChatId,
  onSelectChat,
}: Props) => {
  const DropdownAction = [
    {
      icon: Settings,
      listtitle: "Setting",
      divider: true,
    },
    {
      icon: CircleQuestionMark,
      listtitle: "Help and feedback",
      divider: false,
    },
    {
      icon: AlignHorizontalSpaceAround,
      listtitle: "Enable split View mode",
      divider: false,
    },
    {
      icon: Keyboard,
      listtitle: "Keyboard shortcut",
      divider: true,
    },
    {
      icon: LogOut,
      listtitle: "Sign Out",
      divider: false,
    },
  ];

  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const lastActivity = (chat: Chat) => last(chat.messages)?.createdAt;

  const getDetails = (conversation: Chat) => {
    let displayText = "";
    const lastMessage = conversation.messages[conversation.messages.length - 1];
    if (lastMessage) {
      const sender = lastMessage.senderId === CURRENT_USER_ID ? "You: " : "";
      const message = lastMessage.type === "image" ? "Sent a photo" : lastMessage.msg;
      displayText = `${sender}${message}`;
    }
    return displayText;
  };

  const filteredChats = chatData.filter((chat) =>
    chat.name.toLowerCase().includes(chatSearch.toLowerCase()),
  );

  return (
    <>
      <div className="w-80 pt-6 h-full flex flex-col">
        <div className="shrink-0 flex justify-between items-center px-6">
          <div className="flex items-center gap-2">
            <div className="relative">
              <img
                src={chatData[0]?.thumb}
                height={56}
                width={56}
                alt="user"
                className="rounded-full"
              />
              <span className="p-0 h-2 w-2 rounded-full absolute bottom-1 inset-e-1 bg-teal-400" />
            </div>
            <div>
              <h5 className="text-sm mb-1">You</h5>
              <p className=" text-xs text-muted-foreground">Playground session</p>
            </div>
          </div>

          {/* ShadCN Dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger>
              <span className="h-9 w-9 flex justify-center items-center rounded-lg hover:bg-primary/5 hover:text-primary cursor-pointer">
                <EllipsisVertical size={20} />
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {DropdownAction.map((item, index) => (
                <React.Fragment key={index}>
                  <DropdownMenuItem className="flex items-center gap-3 cursor-pointer">
                    <item.icon size={18} />
                    <span>{item.listtitle}</span>
                  </DropdownMenuItem>
                  {item.divider && <DropdownMenuSeparator />}
                </React.Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Search Box */}
        <div className="shrink-0 px-6">
          <div className="flex gap-3  py-4 items-center">
            <div className="relative w-full">
              <SearchIcon
                size={18}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
              />

              <Input
                className="pl-8"
                value={chatSearch}
                onChange={(e) => setChatSearch(e.target.value)}
                placeholder="Search Chats..."
              />
            </div>
          </div>

          {/* Sorting Dropdown (Also converted to ShadCN) */}
          <div className="sorting mb-3">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button className="flex items-center gap-2 cursor-pointer text-sm font-medium" />
                }
              >
                Recent Chats
                <ChevronDown size={16} />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-48">
                <DropdownMenuItem>Sort by Time</DropdownMenuItem>
                <DropdownMenuItem>Sort by Unread</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem>Sort by Favourites</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Chat Listing */}
        <ScrollArea className="flex-1 min-h-0">
          {filteredChats.map((chat) => (
            <div
              key={chat.id}
              className={`cursor-pointer py-4 px-5 mb-0.5 gap-0 flex justify-between group  hover:bg-primary/5 ${
                activeChatId === chat.id ? "bg-primary/5 " : "initial"
              }`}
              onClick={() => onSelectChat(chat)}
            >
              <div className="flex items-center gap-2 max-w-58.75 w-full">
                <div className="relative min-w-12">
                  <img
                    src={chat.thumb}
                    height={48}
                    width={48}
                    alt="user"
                    className="rounded-full"
                  />
                  <span
                    className={cn(
                      "p-0 h-2 w-2 rounded-full absolute bottom-1 inset-e-0",
                      chat.status === "online"
                        ? "bg-teal-400"
                        : chat.status === "busy"
                          ? "bg-red-500"
                          : chat.status === "away"
                            ? "bg-amber-300"
                            : "bg-orange-400",
                    )}
                  />
                </div>
                <div>
                  <h5 className="text-sm mb-1">{chat.name}</h5>
                  <div className="text-sm text-muted-foreground font-normal  line-clamp-1">
                    {getDetails(chat)}
                  </div>
                </div>
              </div>
              <div className="text-xs pt-1 whitespace-nowrap text-muted-foreground">
                {mounted &&
                  formatDistanceToNowStrict(new Date(lastActivity(chat)!), {
                    addSuffix: false,
                  })
                    .replace(/minutes?/, "mins")
                    .replace(/hours?/, "hrs")
                    .replace(/seconds?/, "secs")}
              </div>
            </div>
          ))}
        </ScrollArea>
      </div>
    </>
  );
};

export default ChatListing;
