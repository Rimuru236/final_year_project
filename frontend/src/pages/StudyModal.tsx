import React, { useEffect, useRef, useState } from "react";
import { Spinner } from "../components/UI";
import type { StudySession } from "../types";

interface StudyModalProps {
  session: StudySession;
  onClose: () => void;
  onStartQuiz: () => void;
  onSelectOption: (opt: string) => void;
  // elapsedFraction: fraction (0-1) of timerSeconds used for this question,
  // only passed when the timer is enabled. Undefined otherwise.
  onSubmitAnswer: (elapsedFraction?: number) => void;
  onNextQuestion: () => Promise<void>;
  timerEnabled?: boolean;
  timerSeconds?: number;
  quizQuestionCount?: number;
}

export function StudyModal({
  session, onClose, onStartQuiz, onSelectOption, onSubmitAnswer, onNextQuestion,
  timerEnabled = false,
  timerSeconds = 60,
  quizQuestionCount = 5,
}: StudyModalProps) {
  const { slot, mode, mcqs, quizIdx, selected, revealed, score } = session;
  const contentRef = useRef<HTMLDivElement>(null);
  const [readProgress, setReadProgress] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // Timer state
  const [timeLeft, setTimeLeft] = useState(timerSeconds);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Kept in sync below so the keyboard-shortcut handler (which doesn't
  // re-subscribe every second) can read the current value without going stale.
  const timeLeftRef = useRef(timeLeft);
  useEffect(() => { timeLeftRef.current = timeLeft; }, [timeLeft]);

  // Body scroll lock
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  // Reset scroll on study mode
  useEffect(() => {
    if (mode === "study" && contentRef.current) {
      contentRef.current.scrollTop = 0;
      setReadProgress(0);
    }
  }, [mode]);

  const handleScroll = () => {
    const el = contentRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const max = scrollHeight - clientHeight;
    if (max <= 0) { setReadProgress(100); return; }
    setReadProgress(Math.round((scrollTop / max) * 100));
  };

  // Keyboard shortcuts
  useEffect(() => {
    if (mode !== "quiz" || mcqs.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = e.key.toUpperCase();
      if (["A", "B", "C", "D"].includes(key) && !revealed) {
        e.preventDefault();
        onSelectOption(key);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (!revealed && selected) onSubmitAnswer(timerEnabled ? (timerSeconds - timeLeftRef.current) / timerSeconds : undefined);
        else if (revealed) handleNext();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mode, mcqs.length, revealed, selected]);

  // Timer: start when a new question is shown (quizIdx changes)
  useEffect(() => {
    if (!timerEnabled || mode !== "quiz" || revealed) return;
    setTimeLeft(timerSeconds);
    timerRef.current = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(timerRef.current!);
          onSubmitAnswer(1.0);   // auto-submit as wrong when time runs out — full time used
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [quizIdx, mode, timerEnabled, timerSeconds, onSubmitAnswer]);

  // Stop timer when revealed (question answered)
  useEffect(() => {
    if (revealed && timerRef.current) clearInterval(timerRef.current);
  }, [revealed]);

  const handleNext = async () => {
    setSubmitting(true);
    try { await onNextQuestion(); } finally { setSubmitting(false); }
  };

  const hasContent = slot.section_content && slot.section_content.trim().length > 0;
  const estimatedMin = Math.ceil(slot.hours_allocated * 60);
  const currentMcq = mcqs[quizIdx];
  const isLastQuestion = quizIdx >= mcqs.length - 1;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200"
      onClick={() => { if (mode === "study") onClose(); }}
    >
      <div
        className={`relative w-full max-w-2xl max-h-[90vh] flex flex-col rounded-3xl border bg-surface-container-lowest shadow-2xl ${mode === "study" ? "border-blue-300 shadow-blue-500/10" : "border-primary/30 shadow-primary/10"}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-outline-variant/20 flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${mode === "study" ? "bg-blue-400" : mode === "quiz-loading" ? "bg-amber-400 animate-pulse" : "bg-primary"}`} />
            <div className="min-w-0">
              <p className="text-xs font-bold text-on-surface-variant uppercase tracking-widest">
                {mode === "study" ? "Study Mode" : mode === "quiz-loading" ? "Preparing Quiz…" : "Quiz Mode"}
              </p>
              <p className="font-headline text-sm font-bold text-on-surface truncate">{slot.section_title}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {mode === "quiz" && (
              <span className="text-xs font-bold text-primary bg-primary-container px-3 py-1 rounded-full">
                {quizIdx + 1}/{mcqs.length}
              </span>
            )}
            {timerEnabled && mode === "quiz" && (
              <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-bold tabular-nums transition-colors ${
                timeLeft <= 10 ? "bg-red-100 text-red-600" : "bg-surface-container text-on-surface"
              }`}>
                <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>timer</span>
                {timeLeft}s
              </div>
            )}
            <span className="text-xs text-on-surface-variant bg-surface-container px-3 py-1 rounded-full">
              {estimatedMin}min
            </span>
            <button onClick={onClose} className="p-2 rounded-xl hover:bg-surface-container transition-colors">
              <span className="material-symbols-outlined text-on-surface-variant">close</span>
            </button>
          </div>
        </div>

        {/* Read progress bar */}
        {mode === "study" && hasContent && (
          <div className="h-1 bg-surface-container-high flex-shrink-0">
            <div className="h-full bg-blue-400 transition-all duration-150 rounded-full" style={{ width: `${readProgress}%` }} />
          </div>
        )}

        {/* Body */}
        <div ref={contentRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-5">
          {/* ── Study Mode ─────────────────────────────────────────── */}
          {mode === "study" && (
            <div className="space-y-6">
              {hasContent ? (
                <div className="prose prose-sm max-w-none">
                  <div className="text-sm text-on-surface leading-relaxed whitespace-pre-wrap">
                    {slot.section_content}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <span className="material-symbols-outlined text-4xl text-outline mb-3">description</span>
                  <p className="font-semibold text-on-surface-variant">No content preview available</p>
                  <p className="text-sm text-outline mt-1">Content will be used to generate your quiz questions</p>
                </div>
              )}
            </div>
          )}

          {/* ── Quiz Loading ────────────────────────────────────────── */}
          {mode === "quiz-loading" && (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <Spinner size={40} />
              <p className="font-semibold text-on-surface-variant">Generating quiz with AI…</p>
              <p className="text-sm text-outline">Powered by Groq LLaMA 3.3</p>
            </div>
          )}

          {/* ── Quiz Mode ───────────────────────────────────────────── */}
          {mode === "quiz" && currentMcq && (
            <div className="space-y-5">
              {/* Score */}
              <div className="flex items-center justify-between text-sm">
                <span className="text-on-surface-variant font-semibold">Question {quizIdx + 1} of {mcqs.length}</span>
                <span className="font-bold text-primary">{score.correct}/{score.total} correct</span>
              </div>

              {/* Question */}
              <div className="bg-surface-container-low rounded-2xl p-5">
                <p className="font-semibold text-on-surface leading-relaxed">{currentMcq.question}</p>
              </div>

              {/* Options */}
              <div className="space-y-2">
                {(["A", "B", "C", "D"] as const).map((opt) => {
                  const text = currentMcq.options[opt];
                  const isSelected = selected === opt;
                  const isCorrect = currentMcq.correct_answer === opt;

                  let cls = "border-outline-variant/30 bg-surface-container-low hover:bg-surface-container hover:border-primary/30 cursor-pointer";
                  if (revealed) {
                    if (isCorrect) cls = "border-emerald-300 bg-emerald-50 cursor-default";
                    else if (isSelected && !isCorrect) cls = "border-red-300 bg-red-50 cursor-default";
                    else cls = "border-outline-variant/20 bg-surface-container-low opacity-60 cursor-default";
                  } else if (isSelected) {
                    cls = "border-primary bg-primary-container/50 cursor-pointer";
                  }

                  return (
                    <button
                      key={opt}
                      onClick={() => !revealed && onSelectOption(opt)}
                      className={`w-full flex items-center gap-4 p-4 rounded-xl border text-left transition-all duration-150 ${cls}`}
                    >
                      <span className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-black flex-shrink-0 transition-colors ${revealed && isCorrect ? "bg-emerald-500 text-white" : revealed && isSelected && !isCorrect ? "bg-red-500 text-white" : isSelected ? "bg-primary text-on-primary" : "bg-surface-container text-on-surface-variant"}`}>
                        {opt}
                      </span>
                      <span className="text-sm font-medium text-on-surface leading-snug">{text}</span>
                      {revealed && isCorrect && <span className="material-symbols-outlined text-emerald-500 ml-auto flex-shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>}
                      {revealed && isSelected && !isCorrect && <span className="material-symbols-outlined text-red-500 ml-auto flex-shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>cancel</span>}
                    </button>
                  );
                })}
              </div>

              {/* Explanation */}
              {revealed && (
                <div className="p-4 bg-blue-50 border border-blue-200 rounded-2xl">
                  <div className="flex items-start gap-2">
                    <span className="material-symbols-outlined text-blue-500 text-lg flex-shrink-0 mt-0.5" style={{ fontVariationSettings: "'FILL' 1" }}>info</span>
                    <p className="text-sm text-blue-800 leading-relaxed">{currentMcq.explanation}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-outline-variant/20 flex-shrink-0">
          {mode === "study" && (
            <div className="flex gap-3">
              <button onClick={onClose} className="px-5 py-3 rounded-xl text-sm font-semibold text-on-surface-variant hover:bg-surface-container transition-colors border border-outline-variant/30">
                Close
              </button>
              <button
                onClick={onStartQuiz}
                className="flex-1 py-3 bg-primary text-on-primary rounded-xl font-bold text-sm shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>quiz</span>
                Start Quiz
                <span className="text-xs opacity-70">{quizQuestionCount} questions</span>
              </button>
            </div>
          )}

          {mode === "quiz" && !revealed && (
            <button
              onClick={() => onSubmitAnswer(timerEnabled ? (timerSeconds - timeLeft) / timerSeconds : undefined)}
              disabled={!selected}
              className="w-full py-3.5 bg-primary text-on-primary rounded-xl font-bold text-sm shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              Submit Answer
            </button>
          )}

          {mode === "quiz" && revealed && (
            <button
              onClick={handleNext}
              disabled={submitting}
              className="w-full py-3.5 bg-primary text-on-primary rounded-xl font-bold text-sm shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-40 transition-all flex items-center justify-center gap-2"
            >
              {submitting ? <Spinner size={18} /> : null}
              {isLastQuestion ? "Finish Quiz & Save" : "Next Question"}
              {!submitting && <span className="material-symbols-outlined text-xl">arrow_forward</span>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
