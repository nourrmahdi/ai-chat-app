"use client";

import { useCallback, useEffect, useState } from "react";
import { Menu, MessageSquare, Pencil, Plus, Trash2, X } from "lucide-react";
import { Chat, type ChatMessage } from "@/components/chat";
import { ThemeToggle } from "@/components/theme-toggle";
import { DEFAULT_MODEL } from "@/lib/models";

type Conversation = {
  id: string;
  title: string;
  model: string;
  messages: ChatMessage[];
  updatedAt: number;
};

const STORAGE_KEY = "ai-chat-conversations";

function newConversation(model = DEFAULT_MODEL): Conversation {
  return { id: crypto.randomUUID(), title: "New chat", model, messages: [], updatedAt: Date.now() };
}

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Load saved chats from the browser
  useEffect(() => {
    let saved: Conversation[] = [];
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    } catch {}
    if (saved.length === 0) saved = [newConversation()];
    setConversations(saved);
    setActiveId(saved[0].id);
    setLoaded(true);
  }, []);

  // Save chats whenever they change
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    } catch {}
  }, [conversations, loaded]);

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);

  function createChat() {
    const c = newConversation(active?.model);
    setConversations((prev) => [c, ...prev]);
    setActiveId(c.id);
    setSidebarOpen(false);
  }

  function renameChat(id: string) {
    const current = conversations.find((c) => c.id === id);
    const title = window.prompt("Rename chat", current?.title ?? "");
    if (!title?.trim()) return;
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: title.trim() } : c)));
  }

  function deleteChat(id: string) {
    if (!window.confirm("Delete this chat?")) return;
    const rest = conversations.filter((c) => c.id !== id);
    if (rest.length === 0) {
      const c = newConversation();
      setConversations([c]);
      setActiveId(c.id);
    } else {
      setConversations(rest);
      if (id === activeId) setActiveId(rest[0].id);
    }
  }

  const setModel = useCallback((id: string, model: string) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, model } : c)));
  }, []);

  const saveMessages = useCallback((id: string, messages: ChatMessage[]) => {
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        let title = c.title;
        if (title === "New chat") {
          const first = messages.find((m) => m.role === "user");
          const text = first?.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim();
          if (text) title = text.length > 40 ? text.slice(0, 40) + "…" : text;
        }
        return { ...c, messages, title, updatedAt: Date.now() };
      })
    );
  }, []);

  if (!loaded || !active) {
    return <div className="flex h-dvh items-center justify-center text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      {/* Dark overlay behind the sidebar on mobile */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-border bg-background transition-transform md:static md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2 p-3">
          <button
            onClick={createChat}
            className="flex flex-1 items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted"
          >
            <Plus className="size-4" /> New chat
          </button>
          <button onClick={() => setSidebarOpen(false)} aria-label="Close menu" className="rounded-lg p-2 hover:bg-muted md:hidden">
            <X className="size-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          {sorted.map((c) => (
            <div
              key={c.id}
              className={`flex items-center gap-1 rounded-lg px-2 py-2 text-sm ${
                c.id === activeId ? "bg-muted" : "hover:bg-muted/60"
              }`}
            >
              <button
                onClick={() => {
                  setActiveId(c.id);
                  setSidebarOpen(false);
                }}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{c.title}</span>
              </button>
              <button onClick={() => renameChat(c.id)} aria-label="Rename chat" className="rounded p-1 text-muted-foreground hover:text-foreground">
                <Pencil className="size-3.5" />
              </button>
              <button onClick={() => deleteChat(c.id)} aria-label="Delete chat" className="rounded p-1 text-muted-foreground hover:text-destructive">
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </nav>

        <p className="border-t border-border p-3 text-xs text-muted-foreground">
          Chats are saved in this browser.
        </p>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <Chat
          key={active.id}
          id={active.id}
          initialMessages={active.messages}
          model={active.model}
          onModelChange={(m) => setModel(active.id, m)}
          onSave={(msgs) => saveMessages(active.id, msgs)}
          headerLeft={
            <button onClick={() => setSidebarOpen(true)} aria-label="Open menu" className="rounded-lg p-2 hover:bg-muted md:hidden">
              <Menu className="size-4" />
            </button>
          }
          headerRight={<ThemeToggle />}
        />
      </main>
    </div>
  );
}