// Chats live in this browser only: the proxy keeps no history it could return.

export interface Message {
  role: "user" | "agent";
  text: string;
  error?: string;
}

export interface Chat {
  /** Also the harness session id, so it must be at least 33 characters of A-Za-z0-9_-. */
  id: string;
  harness: string;
  title: string;
  updatedAt: number;
  messages: Message[];
}

const KEY = "harness-ui:chats";

export function loadChats(): Chat[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveChats(chats: Chat[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(chats));
  } catch {
    // Storage is full or blocked; the chat still works for this page load.
  }
}

export function newChat(harness: string): Chat {
  return { id: `web-${crypto.randomUUID()}`, harness, title: "New chat", updatedAt: Date.now(), messages: [] };
}
