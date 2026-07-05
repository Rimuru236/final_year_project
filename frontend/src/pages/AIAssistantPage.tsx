import React, { useState, useRef, useEffect } from "react";
import { Spinner, Card } from "../components/UI";
import { useAuth } from "../lib/contexts";
import { api, timetableApi, progressApi } from "../lib/api";
import type { Page, Timetable, MasteryReport } from "../types";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const SUGGESTIONS = [
  "How should I prioritise my weak topics?",
  "Explain the Pomodoro technique for studying",
  "How can I improve retention of complex topics?",
  "What's an effective revision strategy before exams?",
];

// Build a system prompt that includes the user's context
function buildSystemPrompt(userName: string, level: string, weakTopics: string[]): string {
  const weakTopicsSection = weakTopics.length > 0
    ? `\n\nThis student's current weak/shaky topics, based on recent quiz performance, are: ${weakTopics.join(", ")}. When the student asks about prioritising, revising, or improving, proactively reference these topics by name instead of speaking generically.`
    : "";

  return `You are an expert academic coach and study assistant for Cognitive Sanctuary, an AI-powered learning platform.

Student profile:
- Name: ${userName}
- Level: ${level}${weakTopicsSection}

Your role:
- Give personalised, actionable study advice
- Help with understanding concepts from any subject
- Suggest effective study techniques
- Motivate and encourage the student
- Keep answers concise and focused (3-5 sentences unless detail is needed)
- Use a warm, encouraging tone

Do NOT provide answers that facilitate academic dishonesty (e.g. writing assignments for submission).`;
}

interface AIAssistantPageProps {
  onNavigate: (page: Page) => void;
}

export function AIAssistantPage({ onNavigate }: AIAssistantPageProps) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [weakTopics, setWeakTopics] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Load the active timetable's mastery report so the assistant knows this
  // student's actual weak/shaky topics rather than only their name and level.
  useEffect(() => {
    timetableApi.list()
      .then((list: Timetable[]) => {
        if (list.length === 0) return null;
        return progressApi.mastery(list[0].timetable_id);
      })
      .then((r: MasteryReport | null) => {
        if (r) setWeakTopics([...r.revise, ...r.shaky].map((s) => s.section_title));
      })
      .catch(() => { /* weak-topic context is best-effort — chat still works without it */ });
  }, []);

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const userMsg: Message = { role: "user", content: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);
    setError(null);

    // Build conversation history for the API
    const history: Message[] = [...messages, userMsg];

    try {
      // Call the Anthropic API directly from the browser via the artifact proxy
      const response = await fetch("http://localhost:8000/chat", {
      method: "POST",
      headers: {
      "Content-Type": "application/json",
      },
  body: JSON.stringify({
    message: trimmed,
    history: history,
    user_name: user?.name ?? "Student",
    level: user?.level ?? "Undergraduate",
    system_prompt: buildSystemPrompt(
      user?.name ?? "Student",
      user?.level ?? "Undergraduate",
      weakTopics
    ),
  }),
});

if (!response.ok) {
  const errData = await response.json().catch(() => ({}));
  throw new Error(errData?.error ?? `API error ${response.status}`);
}

const data = await response.json();

const assistantText =
  data.response ?? "I'm not sure how to answer that.";

      setMessages((prev) => [...prev, { role: "assistant", content: assistantText }]);
    } catch (err: any) {
      // If direct Anthropic API unavailable, show informative message
      setError(
        err.message?.includes("fetch") || err.message?.includes("network")
          ? "Unable to reach the AI service. Check your internet connection."
          : err.message ?? "AI service temporarily unavailable."
      );
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const clearChat = () => {
    setMessages([]);
    setError(null);
    inputRef.current?.focus();
  };

  return (
    <div className="p-4 sm:p-6 lg:p-10 max-w-4xl mx-auto flex flex-col" style={{ height: "calc(100dvh - 4rem)" }}>
      {/* Header */}
      <div className="mb-6 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <div className="inline-flex items-center gap-2 mb-3 px-3 py-1.5 bg-primary-container/40 rounded-full">
              <span className="material-symbols-outlined text-sm text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>psychology</span>
              <span className="text-xs font-bold text-on-primary-container uppercase tracking-widest">AI Assistant</span>
            </div>
            <h1 className="font-headline text-2xl font-extrabold text-on-background tracking-tight">
              Study Coach
            </h1>
            <p className="text-sm text-on-surface-variant">Personalised academic guidance for {user?.name?.split(" ")[0] ?? "you"}</p>
          </div>
          {messages.length > 0 && (
            <button
              onClick={clearChat}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-on-surface-variant hover:bg-surface-container-high transition-colors"
            >
              <span className="material-symbols-outlined text-lg">restart_alt</span>
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 overflow-y-auto rounded-2xl bg-surface-container-low border border-outline-variant/20 p-4 space-y-4 mb-4 min-h-0">
        {/* Welcome state */}
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center py-8 gap-4">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-indigo-700 flex items-center justify-center shadow-xl shadow-primary/20">
              <span className="material-symbols-outlined text-white text-2xl" style={{ fontVariationSettings: "'FILL' 1" }}>psychology</span>
            </div>
            <div>
              <p className="font-headline font-bold text-on-background">Your AI Study Coach</p>
              <p className="text-sm text-on-surface-variant mt-1 max-w-xs">
                Ask me anything about study strategies, concepts, or how to improve your performance.
              </p>
            </div>
            {/* Suggestion chips */}
            <div className="flex flex-wrap justify-center gap-2 mt-2 px-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => sendMessage(s)}
                  className="px-4 py-2 bg-primary-container/60 text-on-primary-container rounded-full text-xs font-semibold hover:bg-primary-container transition-colors text-left"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Messages */}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            {msg.role === "assistant" && (
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary to-indigo-700 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-md shadow-primary/20">
                <span className="material-symbols-outlined text-white text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>psychology</span>
              </div>
            )}
            <div
              className={`max-w-[90%] sm:max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-primary text-on-primary rounded-tr-md"
                  : "bg-surface-container-lowest border border-outline-variant/20 text-on-surface rounded-tl-md"
              }`}
            >
              {msg.content}
            </div>
            {msg.role === "user" && (
              <div className="w-8 h-8 rounded-xl bg-primary-container flex items-center justify-center flex-shrink-0 mt-0.5">
                <span className="text-xs font-black text-primary">{user?.name?.charAt(0).toUpperCase() ?? "U"}</span>
              </div>
            )}
          </div>
        ))}

        {/* Loading indicator */}
        {loading && (
          <div className="flex gap-3 justify-start">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary to-indigo-700 flex items-center justify-center flex-shrink-0 shadow-md shadow-primary/20">
              <span className="material-symbols-outlined text-white text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>psychology</span>
            </div>
            <div className="bg-surface-container-lowest border border-outline-variant/20 rounded-2xl rounded-tl-md px-4 py-3 flex items-center gap-2">
              <Spinner size={14} />
              <span className="text-xs text-on-surface-variant font-semibold">Thinking…</span>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-2xl flex items-start gap-2">
            <span className="material-symbols-outlined text-red-500 text-lg flex-shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>error</span>
            <p className="text-xs text-red-700 font-semibold">{error}</p>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div className="flex-shrink-0 flex gap-2 sm:gap-3 items-end">
        <div className="flex-1 relative">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask your study coach… (Enter to send)"
            rows={2}
            className="w-full px-4 py-3.5 pr-12 bg-surface-container-lowest border border-outline-variant/30 rounded-2xl text-sm text-on-surface focus:ring-2 focus:ring-primary/30 focus:border-primary/30 resize-none transition-all"
          />
        </div>
        <button
          onClick={() => sendMessage(input)}
          disabled={!input.trim() || loading}
          className="w-12 h-12 bg-primary text-on-primary rounded-2xl flex items-center justify-center flex-shrink-0 hover:scale-[1.05] active:scale-[0.95] disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-lg shadow-primary/20"
        >
          <span className="material-symbols-outlined text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>send</span>
        </button>
      </div>

      <p className="text-xs text-outline text-center mt-2 flex-shrink-0">
        Press <kbd className="bg-surface-container px-1 py-0.5 rounded text-on-surface-variant font-mono">Enter</kbd> to send · <kbd className="bg-surface-container px-1 py-0.5 rounded text-on-surface-variant font-mono">Shift+Enter</kbd> for new line
      </p>
    </div>
  );
}
