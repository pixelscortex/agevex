export type ChatStatus = "online" | "offline" | "busy" | "away";

export type MessageAttachment = {
  icon: string;
  file: string;
  fileSize: string;
};

export type ChatMessage = {
  id: number;
  senderId: number;
  msg: string;
  type: "text" | "image";
  createdAt: Date;
  attachment: MessageAttachment[];
};

export type Chat = {
  id: number;
  name: string;
  status: ChatStatus;
  thumb: string;
  excerpt: string;
  messages: ChatMessage[];
};

// Id used for the current logged-in user ("Cameron") when sending a message.
export const CURRENT_USER_ID = 0;
