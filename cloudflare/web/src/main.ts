import DOMPurify from "dompurify";
import { marked } from "marked";
import { ApiError, SignInRequired, fetchConfig, streamChat, type Config } from "./api";
import { loadChats, newChat, saveChats, type Chat, type Message } from "./store";
import "./style.css";

// AgentCore ends a runtime session after it has been idle this long (the default), and the agent
// then starts the next message without the earlier context.
const IDLE_SESSION_MS = 15 * 60 * 1000;
// The Lambda writes these markers into the stream when the harness fails mid-reply.
const STREAM_ERROR = /\n?\[error: ([^\]]+)\]$/;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const els = {
  newChat: $<HTMLButtonElement>("new-chat"),
  chatList: $<HTMLUListElement>("chat-list"),
  user: $<HTMLDivElement>("user"),
  toggleSidebar: $<HTMLButtonElement>("toggle-sidebar"),
  harness: $<HTMLSelectElement>("harness"),
  maxTokens: $<HTMLInputElement>("max-tokens"),
  messages: $<HTMLElement>("messages"),
  notice: $<HTMLDivElement>("notice"),
  composer: $<HTMLFormElement>("composer"),
  input: $<HTMLTextAreaElement>("input"),
  send: $<HTMLButtonElement>("send"),
  session: $<HTMLSpanElement>("session"),
  copySession: $<HTMLButtonElement>("copy-session"),
  count: $<HTMLSpanElement>("count"),
};

let config: Config = { harnesses: [], default: "", user: "" };
let chats = loadChats();
let current: Chat = newChat("");
let inFlight: AbortController | undefined;

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }));
}

function messageElement(msg: Message): HTMLElement {
  const el = document.createElement("article");
  el.className = `message ${msg.role}`;
  fillMessage(el, msg);
  return el;
}

function fillMessage(el: HTMLElement, msg: Message): void {
  if (msg.role === "agent") el.innerHTML = renderMarkdown(msg.text);
  else el.textContent = msg.text;
  if (msg.error) {
    const err = document.createElement("p");
    err.className = "error";
    err.textContent = msg.error;
    el.append(err);
  }
}

function showNotice(text: string, action?: { label: string; run: () => void }): void {
  els.notice.textContent = text;
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "link";
    btn.textContent = action.label;
    btn.onclick = action.run;
    els.notice.append(" ", btn);
  }
  els.notice.hidden = false;
}

function renderChatList(): void {
  els.chatList.replaceChildren(
    ...chats
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((chat) => {
        const li = document.createElement("li");
        li.classList.toggle("active", chat.id === current.id);
        const open = document.createElement("button");
        open.type = "button";
        open.className = "chat-title";
        open.textContent = chat.title;
        open.title = `${chat.harness} · ${new Date(chat.updatedAt).toLocaleString()}`;
        open.onclick = () => selectChat(chat);
        const del = document.createElement("button");
        del.type = "button";
        del.className = "icon";
        del.textContent = "×";
        del.setAttribute("aria-label", `Delete "${chat.title}"`);
        del.onclick = () => deleteChat(chat);
        li.append(open, del);
        return li;
      }),
  );
}

function renderCurrent(): void {
  els.messages.replaceChildren(...current.messages.map(messageElement));
  els.messages.scrollTop = els.messages.scrollHeight;
  // A session belongs to one harness, so the harness is fixed once the chat has started.
  els.harness.value = current.harness;
  els.harness.disabled = current.messages.length > 0 || !!inFlight;
  els.session.textContent = current.messages.length ? current.id : "new session";
  els.copySession.hidden = current.messages.length === 0;
  els.notice.hidden = true;
  if (current.messages.length && Date.now() - current.updatedAt > IDLE_SESSION_MS) {
    showNotice("This chat has been idle for over 15 minutes. The agent may no longer remember earlier messages.", {
      label: "Start a new chat",
      run: startNewChat,
    });
  }
  renderChatList();
  updateCount();
}

function updateCount(): void {
  const n = els.input.value.length;
  els.count.textContent = n ? `${n.toLocaleString()} chars` : "";
}

function setBusy(busy: boolean): void {
  els.send.textContent = busy ? "Stop" : "Send";
  els.send.classList.toggle("danger", busy);
  els.harness.disabled = busy || current.messages.length > 0;
}

function selectChat(chat: Chat): void {
  if (inFlight) return;
  current = chat;
  document.body.classList.remove("sidebar-open");
  renderCurrent();
  els.input.focus();
}

function startNewChat(): void {
  if (inFlight) return;
  selectChat(newChat(els.harness.value || config.default));
}

function deleteChat(chat: Chat): void {
  if (inFlight && chat.id === current.id) return;
  chats = chats.filter((c) => c.id !== chat.id);
  saveChats(chats);
  if (chat.id === current.id) startNewChat();
  else renderChatList();
}

function persist(): void {
  current.updatedAt = Date.now();
  if (!chats.includes(current)) chats.push(current);
  saveChats(chats);
}

async function send(): Promise<void> {
  const text = els.input.value.trim();
  if (!text || inFlight) return;

  if (current.messages.length === 0) {
    current.harness = els.harness.value;
    current.title = text.length > 48 ? `${text.slice(0, 47)}…` : text;
  }
  current.messages.push({ role: "user", text });
  const reply: Message = { role: "agent", text: "" };
  current.messages.push(reply);
  els.input.value = "";
  persist();
  renderCurrent();

  const replyEl = els.messages.lastElementChild as HTMLElement;
  replyEl.classList.add("streaming");
  inFlight = new AbortController();
  setBusy(true);

  try {
    const stream = streamChat(
      {
        message: text,
        session_id: current.id,
        harness: current.harness,
        max_tokens: Number(els.maxTokens.value) || 1000,
      },
      inFlight.signal,
    );
    for await (const chunk of stream) {
      reply.text += chunk;
      fillMessage(replyEl, reply);
      els.messages.scrollTop = els.messages.scrollHeight;
    }
    const marker = reply.text.match(STREAM_ERROR);
    if (marker) {
      reply.text = reply.text.slice(0, marker.index);
      reply.error = `The reply stopped: ${marker[1]}.`;
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      reply.error = "Stopped.";
    } else if (err instanceof SignInRequired) {
      reply.error = "Your Cloudflare Access session has expired.";
      showNotice("Sign in again, then resend your message.", { label: "Sign in", run: () => location.reload() });
    } else if (err instanceof ApiError) {
      reply.error = err.message;
    } else {
      reply.error = "Could not reach the proxy. Check your connection and try again.";
      console.error(err);
    }
    if (!reply.text && reply.error !== "Stopped.") els.input.value = text;
  } finally {
    inFlight = undefined;
    replyEl.classList.remove("streaming");
    fillMessage(replyEl, reply);
    persist();
    setBusy(false);
    renderChatList();
    els.input.focus();
  }
}

els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  if (inFlight) inFlight.abort();
  else void send();
});
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});
els.input.addEventListener("input", updateCount);
els.newChat.addEventListener("click", startNewChat);
els.toggleSidebar.addEventListener("click", () => document.body.classList.toggle("sidebar-open"));
els.copySession.addEventListener("click", () => {
  void navigator.clipboard.writeText(current.id).then(() => {
    els.copySession.textContent = "copied";
    setTimeout(() => (els.copySession.textContent = "copy"), 1500);
  });
});

async function init(): Promise<void> {
  try {
    config = await fetchConfig();
  } catch (err) {
    if (err instanceof SignInRequired) {
      showNotice("Your Cloudflare Access session has expired.", { label: "Sign in", run: () => location.reload() });
    } else {
      showNotice(`Could not load the harness list: ${err instanceof Error ? err.message : err}`);
    }
    els.send.disabled = true;
    return;
  }
  els.harness.replaceChildren(...config.harnesses.map((name) => new Option(name, name)));
  // Chats whose harness is no longer offered stay readable, so keep their name selectable.
  for (const chat of chats) {
    if (!config.harnesses.includes(chat.harness)) els.harness.append(new Option(`${chat.harness} (removed)`, chat.harness));
  }
  els.user.textContent = `Signed in as ${config.user}`;
  current = newChat(config.default);
  renderCurrent();
  els.input.focus();
}

renderChatList();
void init();
