import React from "react";
import { uniq, flatten } from "lodash";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Download } from "lucide-react";
import { Chat } from "@/components/shadcn-space/blocks/chat-application-01/types";

type Props = {
  selectedChat: Chat | null;
};

const ChatInsideSidebar = ({ selectedChat }: Props) => {
  const totalAttachment = uniq(
    flatten(selectedChat?.messages.map((item) => item.attachment)),
  ).length;
  const totalMedia = uniq(
    flatten(
      selectedChat?.messages.map((item) => (item?.type === "image" ? item.msg : null)),
    ).filter((item): item is string => Boolean(item)),
  ).length;

  return (
    <>
      <div className="p-0">
        {/* Media */}
        <div className="p-5">
          <h6 className="text-sm"> Media ({totalMedia})</h6>
          <div className="mt-4">
            <>
              <React.Fragment>
                {selectedChat?.messages.map((c, index) => {
                  return (
                    <div className="md:col-span-4 sm:col-span-6 col-span-12" key={index}>
                      {c?.type === "image" ? (
                        <img
                          src={c.msg}
                          alt="media"
                          className="rounded-md"
                          height={100}
                          width={100}
                        />
                      ) : null}
                    </div>
                  );
                })}
              </React.Fragment>
            </>
          </div>
        </div>
        {/* Files */}
        <div>
          <ScrollArea className="h-[calc(100vh-230px)]">
            <div className="px-5">
              <h6 className="text-sm"> Attachments ({totalAttachment})</h6>
              {selectedChat?.messages.map((c, index) => {
                return (
                  <div key={index}>
                    <div className="flex flex-col gap-4 mt-4">
                      {c?.attachment?.map((a, index) => {
                        return (
                          <div key={index}>
                            <div className="flex items-center gap-3 group cursor-pointer">
                              <div className="bg-background border border-border p-3 rounded-md">
                                <img src={a.icon || ""} height={24} width={24} alt="download" />
                              </div>
                              <div>
                                <h5 className="text-sm group-hover:text-primary">{a.file}</h5>
                                <p className="text-xs text-muted-foreground">{a.fileSize}</p>
                              </div>
                              <div className="h-9 w-9 flex justify-center items-center rounded-lg hover:bg-primary/5 hover:text-primary cursor-pointer bg-transparent invisible  group-hover:visible ms-auto  opacity:50">
                                <Download size="20" />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </div>
      </div>
    </>
  );
};

export default ChatInsideSidebar;
