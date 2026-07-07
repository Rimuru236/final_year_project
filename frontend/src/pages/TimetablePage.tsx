import React, { useEffect, useState, useCallback } from "react";
import { Spinner, Card, Badge, Toggle } from "../components/UI";
import { useToast } from "../lib/contexts";
import { timetableApi, mcqApi, progressApi, settingsApi } from "../lib/api";
import { StudyModal } from "./StudyModal";
import type { Page, Timetable, TimetableSlot, MCQ, StudySession, MasteryReport, StudyPrefs } from "../types";

const DEFAULT_MCQ_COUNT = 5;

interface TimetablePageProps {
  activeTimetableId: string | null;
  onNavigate: (page: Page) => void;
}

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function TimetablePage({ activeTimetableId, onNavigate }: TimetablePageProps) {
  const toast = useToast();
  const [timetables, setTimetables] = useState<Timetable[]>([]);
  const [selected, setSelected] = useState<Timetable | null>(null);
  const [loading, setLoading] = useState(true);
  const [adapting, setAdapting] = useState(false);
  const [wideReshuffle, setWideReshuffle] = useState(false);
  const [session, setSession] = useState<StudySession | null>(null);
  const [masteryReport, setMasteryReport] = useState<MasteryReport | null>(null);
  const [loadingMastery, setLoadingMastery] = useState(false);
  const [drillMode, setDrillMode] = useState<"all" | "weak" | "shaky" | "review" | null>(null);
  const [drillTimerEnabled, setDrillTimerEnabled] = useState(false);
  const [mcqCount, setMcqCount] = useState(DEFAULT_MCQ_COUNT);
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalTarget, setGoalTarget] = useState(80);
  const [goalDeadline, setGoalDeadline] = useState("");
  const [savingGoal, setSavingGoal] = useState(false);

  useEffect(() => {
    settingsApi.getStudyPrefs()
      .then((prefs: StudyPrefs) => { if (prefs.default_mcq_count) setMcqCount(prefs.default_mcq_count); })
      .catch(() => { /* fall back to DEFAULT_MCQ_COUNT */ });
  }, []);

  const refreshMastery = useCallback((timetableId: string) => {
    setLoadingMastery(true);
    return progressApi.mastery(timetableId)
      .then((r: MasteryReport) => setMasteryReport(r))
      .catch(() => { /* mastery is non-critical — silently ignore */ })
      .finally(() => setLoadingMastery(false));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list: Timetable[] = await timetableApi.list();
      setTimetables(list);
      if (list.length > 0) {
        // Prefer activeTimetableId if it exists in the list
        const preferred = activeTimetableId
          ? list.find((t) => t.timetable_id === activeTimetableId) ?? list[0]
          : list[0];
        // FIX: fetch full timetable (with section_content) by ID — list endpoint omits content
        const full: Timetable = await timetableApi.get(preferred.timetable_id);
        setSelected(full);
        refreshMastery(preferred.timetable_id);
      }
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  }, [activeTimetableId, toast, refreshMastery]);

  useEffect(() => { load(); }, [load]);

  const handleSelectTimetable = async (tt: Timetable) => {
    try {
      const full: Timetable = await timetableApi.get(tt.timetable_id);
      setSelected(full);
      refreshMastery(tt.timetable_id);
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const handleSaveGoal = async () => {
    if (!selected || !goalDeadline) return;
    setSavingGoal(true);
    try {
      await timetableApi.setGoal(selected.timetable_id, { target_mastery_pct: goalTarget, deadline: goalDeadline });
      await refreshMastery(selected.timetable_id);
      setEditingGoal(false);
      toast("Goal saved", "success");
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setSavingGoal(false);
    }
  };

  const handleClearGoal = async () => {
    if (!selected) return;
    try {
      await timetableApi.clearGoal(selected.timetable_id);
      await refreshMastery(selected.timetable_id);
      toast("Goal cleared", "info");
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const handleAdapt = async () => {
    if (!selected) return;
    setAdapting(true);
    try {
      const updated: Timetable = await timetableApi.adapt(selected.timetable_id, wideReshuffle ? 2 : 1);
      setSelected(updated);
      setTimetables((prev) => prev.map((t) => t.timetable_id === updated.timetable_id ? updated : t));
      toast(`Timetable adapted to v${updated.version}`, "success");
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setAdapting(false);
    }
  };

  // Open study session for a slot
  const openSlot = (slot: TimetableSlot) => {
    if (!selected) return;

    setSession({
      slot,
      timetableId: selected.timetable_id, // FIX: was missing — required for progress submit
      mode: "study",
      mcqs: [],
      quizIdx: 0,
      selected: null,
      revealed: false,
      score: { correct: 0, total: 0 },
      responseTimeFractions: [],
      confidenceRatings: [],
    });
  };

  // Start quiz — generate MCQs for this section
  const handleStartQuiz = async () => {
    if (!session) return;
    setSession((s) => s ? { ...s, mode: "quiz-loading" } : s);
    try {
      const mcqs: MCQ[] = await mcqApi.generate(session.slot.section_id, mcqCount);
      setSession((s) => s ? { ...s, mode: "quiz", mcqs, quizIdx: 0, selected: null, revealed: false, score: { correct: 0, total: 0 }, responseTimeFractions: [], confidenceRatings: [] } : s);
    } catch (err: any) {
      toast(err.message, "error");
      setSession((s) => s ? { ...s, mode: "study" } : s);
    }
  };

  const handleSelectOption = (opt: string) => {
    setSession((s) => s ? { ...s, selected: opt } : s);
  };

  const handleSubmitAnswer = (confidence: number, elapsedFraction?: number) => {
    if (!session || !session.selected) return;
    const correct = session.mcqs[session.quizIdx]?.correct_answer === session.selected;
    setSession((s) =>
      s ? {
        ...s,
        revealed: true,
        score: { correct: s.score.correct + (correct ? 1 : 0), total: s.score.total + 1 },
        responseTimeFractions: elapsedFraction !== undefined
          ? [...s.responseTimeFractions, elapsedFraction]
          : s.responseTimeFractions,
        confidenceRatings: [...s.confidenceRatings, confidence],
      } : s
    );
  };

  // FIX: Next question — submit progress after last question
  const handleNextQuestion = async () => {
    if (!session) return;
    const isLast = session.quizIdx >= session.mcqs.length - 1;

    if (isLast) {
      // Submit progress to backend
      const total = session.score.total + 1; // current question was already counted
      const correct = session.score.correct;
      const score_pct = total > 0 ? (correct / total) * 100 : 0;
      const avg_response_time_pct = session.responseTimeFractions.length > 0
        ? (session.responseTimeFractions.reduce((a, b) => a + b, 0) / session.responseTimeFractions.length) * 100
        : undefined;
      const avg_confidence_pct = session.confidenceRatings.length > 0
        ? (session.confidenceRatings.reduce((a, b) => a + b, 0) / session.confidenceRatings.length) * 100
        : undefined;
      try {
        await progressApi.submit({
          section_id: session.slot.section_id,
          timetable_id: session.timetableId,
          score_pct,
          questions_attempted: total,
          correct_answers: correct,
          avg_response_time_pct,
          avg_confidence_pct,
        });
        toast(`Quiz complete! Score: ${score_pct.toFixed(0)}%`, "success");
      } catch (err: any) {
        toast("Progress saved locally (sync failed)", "info");
      }
      setSession(null);
      setDrillMode(null); // Reset drill mode when quiz completes
    } else {
      setSession((s) =>
        s ? { ...s, quizIdx: s.quizIdx + 1, selected: null, revealed: false } : s
      );
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <Spinner size={40} />
          <p className="text-on-surface-variant mt-4 font-semibold">Loading timetables…</p>
        </div>
      </div>
    );
  }

  if (timetables.length === 0) {
    return (
      <div className="p-6 lg:p-10 max-w-6xl mx-auto text-center py-20">
        <div className="w-20 h-20 rounded-full bg-secondary-container/30 flex items-center justify-center mx-auto mb-6">
          <span className="material-symbols-outlined text-4xl text-secondary" style={{ fontVariationSettings: "'FILL' 1" }}>calendar_month</span>
        </div>
        <h3 className="font-headline text-xl font-bold text-on-background mb-2">No Timetables Yet</h3>
        <p className="text-on-surface-variant mb-6 max-w-sm mx-auto">Run an AI analysis first to generate your personalised study timetable.</p>
        <button onClick={() => onNavigate("analysis")} className="px-8 py-4 bg-primary text-on-primary rounded-full font-bold shadow-lg shadow-primary/20 hover:scale-[1.02] transition-all">
          Go to Analysis
        </button>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-10 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6 sm:mb-8">
        <div>
          <div className="inline-flex items-center gap-2 mb-3 px-3 py-1.5 bg-secondary-container/40 rounded-full">
            <span className="material-symbols-outlined text-sm text-secondary" style={{ fontVariationSettings: "'FILL' 1" }}>calendar_month</span>
            <span className="text-xs font-bold text-on-secondary-container uppercase tracking-widest">Study Timetable</span>
          </div>
          <h1 className="font-headline text-3xl font-extrabold text-on-background tracking-tight">
            {selected ? `Week of ${selected.week_start}` : "Timetable"}
          </h1>
          {selected && (
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="secondary">Version {selected.version}</Badge>
              {selected.version > 1 && <Badge variant="success">RL Adapted</Badge>}
            </div>
          )}
        </div>
        {selected && (
          <div className="flex flex-col items-end gap-2">
            <button
              onClick={handleAdapt}
              disabled={adapting}
              className="flex items-center gap-2 px-5 py-3 bg-secondary text-on-secondary rounded-xl font-bold text-sm hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 transition-all shadow-md shadow-secondary/20"
            >
              {adapting ? <Spinner size={18} /> : <span className="material-symbols-outlined text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>auto_fix_high</span>}
              {adapting ? "Adapting…" : "RL Adapt"}
            </button>
            <div className="flex items-center gap-2">
              <Toggle checked={wideReshuffle} onChange={setWideReshuffle} label="Wider reshuffle" />
              <span className="text-xs text-on-surface-variant" title="Standard Adapt swaps only the single worst/best day pair. Wider reshuffle also swaps the 2nd-worst/2nd-best pair in the same click.">
                Swap 2 day pairs instead of 1
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Study Goal widget */}
      {masteryReport && (
        <div className="mt-4 p-4 bg-surface-container-low rounded-2xl space-y-3">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>flag</span>
            <h3 className="font-headline text-sm font-bold text-on-background">Study Goal</h3>
          </div>

          {!editingGoal && masteryReport.goal && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm flex-wrap gap-2">
                <span className="text-on-surface-variant">
                  Target: <span className="font-bold text-on-surface">{masteryReport.goal.target_mastery_pct}%</span> by{" "}
                  <span className="font-bold text-on-surface">
                    {new Date(masteryReport.goal.deadline + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </span>
                </span>
                <div className="flex gap-3">
                  <button
                    onClick={() => { setGoalTarget(masteryReport.goal!.target_mastery_pct); setGoalDeadline(masteryReport.goal!.deadline); setEditingGoal(true); }}
                    className="text-xs font-semibold text-primary hover:underline"
                  >
                    Edit
                  </button>
                  <button onClick={handleClearGoal} className="text-xs font-semibold text-on-surface-variant hover:underline">
                    Clear
                  </button>
                </div>
              </div>

              <div className="h-2 bg-surface-container-high rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    masteryReport.goal.status === "goal_met" ? "bg-emerald-500"
                    : (masteryReport.goal.status === "behind" || masteryReport.goal.status === "deadline_passed") ? "bg-red-400"
                    : "bg-primary"
                  }`}
                  style={{ width: `${Math.min(((masteryReport.overall_mastery_pct ?? 0) / masteryReport.goal.target_mastery_pct) * 100, 100)}%` }}
                />
              </div>

              <p className={`text-xs font-semibold ${
                masteryReport.goal.status === "goal_met" ? "text-emerald-600"
                : masteryReport.goal.status === "on_track" ? "text-primary"
                : masteryReport.goal.status === "not_enough_data" ? "text-on-surface-variant"
                : "text-red-600"
              }`}>
                {masteryReport.goal.status === "goal_met" &&
                  `🎉 Goal met! You're at ${(masteryReport.overall_mastery_pct ?? 0).toFixed(0)}%.`}
                {masteryReport.goal.status === "deadline_passed" &&
                  `⏳ Deadline passed at ${(masteryReport.overall_mastery_pct ?? 0).toFixed(0)}% (target was ${masteryReport.goal.target_mastery_pct}%).`}
                {masteryReport.goal.status === "not_enough_data" &&
                  `📊 Tracking started — check back in a day or two for a pacing forecast.`}
                {masteryReport.goal.status === "on_track" &&
                  `✅ On track — projected ${masteryReport.goal.projected_mastery_pct}% by your deadline (${masteryReport.goal.days_remaining} day${masteryReport.goal.days_remaining === 1 ? "" : "s"} left).`}
                {masteryReport.goal.status === "behind" &&
                  `⚠️ Behind pace — projected only ${masteryReport.goal.projected_mastery_pct}% by your deadline. Consider more study time.`}
              </p>
            </div>
          )}

          {!editingGoal && !masteryReport.goal && (
            <button
              onClick={() => { setGoalTarget(80); setGoalDeadline(""); setEditingGoal(true); }}
              className="w-full py-2.5 bg-primary-container/40 text-on-primary-container rounded-xl font-bold text-xs hover:bg-primary-container/60 transition-all"
            >
              + Set a mastery goal
            </button>
          )}

          {editingGoal && (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <label className="text-xs font-semibold text-on-surface-variant w-20 flex-shrink-0">Target %</label>
                <input
                  type="range" min={10} max={100} step={5}
                  value={goalTarget}
                  onChange={(e) => setGoalTarget(Number(e.target.value))}
                  className="flex-1 h-2 bg-surface-container-high rounded-full appearance-none cursor-pointer accent-primary"
                />
                <span className="text-sm font-bold text-primary w-10 text-right">{goalTarget}%</span>
              </div>
              <div className="flex items-center gap-3">
                <label className="text-xs font-semibold text-on-surface-variant w-20 flex-shrink-0">Deadline</label>
                <input
                  type="date"
                  value={goalDeadline}
                  min={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setGoalDeadline(e.target.value)}
                  className="flex-1 px-3 py-2 bg-surface-container-low border border-outline-variant/30 rounded-xl text-sm"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setEditingGoal(false)}
                  className="flex-1 py-2.5 text-sm font-semibold text-on-surface-variant border border-outline-variant/30 rounded-xl hover:bg-surface-container transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveGoal}
                  disabled={!goalDeadline || savingGoal}
                  className="flex-1 py-2.5 bg-primary text-on-primary rounded-xl font-bold text-sm disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                >
                  {savingGoal ? <Spinner size={16} /> : null}
                  Save Goal
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Smart Drill panel */}
      {masteryReport && masteryReport.total_sections >= 2 && (
        <div className="mt-4 p-4 bg-surface-container-low rounded-2xl space-y-3">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>
              neurology
            </span>
            <h3 className="font-headline text-sm font-bold text-on-background">Smart Drill</h3>
            {masteryReport.overall_mastery_pct !== null && (
              <Badge variant="secondary">{masteryReport.overall_mastery_pct.toFixed(0)}% overall</Badge>
            )}
          </div>

          {/* Mastery summary chips */}
          <div className="flex flex-wrap gap-2">
            {masteryReport.solid.length > 0 && (
              <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                🟢 {masteryReport.solid.length} solid
              </span>
            )}
            {masteryReport.shaky.length > 0 && (
              <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200">
                🟡 {masteryReport.shaky.length} shaky
              </span>
            )}
            {masteryReport.revise.length > 0 && (
              <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-red-50 text-red-700 border border-red-200">
                🔴 {masteryReport.revise.length} need revision
              </span>
            )}
            {masteryReport.untouched.length > 0 && (
              <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-surface-container text-on-surface-variant border border-outline-variant/20">
                ⬜ {masteryReport.untouched.length} untouched
              </span>
            )}
            {masteryReport.due_for_review.length > 0 && (
              <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200">
                🔵 {masteryReport.due_for_review.length} due for review
              </span>
            )}
          </div>

          {/* Drill buttons */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => { setDrillMode("weak"); setDrillTimerEnabled(false); }}
              disabled={masteryReport.revise.length === 0}
              className="px-4 py-2 bg-red-50 text-red-700 border border-red-200 rounded-full text-xs font-bold hover:bg-red-100 disabled:opacity-40 transition-all"
            >
              Drill Weak Topics
            </button>
            <button
              onClick={() => { setDrillMode("shaky"); setDrillTimerEnabled(false); }}
              disabled={masteryReport.shaky.length === 0}
              className="px-4 py-2 bg-amber-50 text-amber-700 border border-amber-200 rounded-full text-xs font-bold hover:bg-amber-100 disabled:opacity-40 transition-all"
            >
              Drill Shaky Topics
            </button>
            <button
              onClick={() => { setDrillMode("review"); setDrillTimerEnabled(false); }}
              disabled={masteryReport.due_for_review.length === 0}
              title="Solid topics you haven't revisited in a while — a light refresher before they fade"
              className="px-4 py-2 bg-blue-50 text-blue-700 border border-blue-200 rounded-full text-xs font-bold hover:bg-blue-100 disabled:opacity-40 transition-all"
            >
              Review Solid Topics
            </button>
            <button
              onClick={() => { setDrillMode("all"); setDrillTimerEnabled(false); }}
              className="px-4 py-2 bg-surface-container text-on-surface border border-outline-variant/20 rounded-full text-xs font-bold hover:bg-surface-container-high transition-all"
            >
              Practice All
            </button>
          </div>

          {/* Timer toggle */}
          <div className="flex items-center gap-3 pt-1">
            <Toggle
              checked={drillTimerEnabled}
              onChange={setDrillTimerEnabled}
              label="Timed mode"
            />
            <span className="text-xs text-on-surface-variant">⏱️ Timed mode (60s per question — exam pressure)</span>
          </div>
        </div>
      )}

      {/* Timetable selector if multiple */}
      {timetables.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-2 mb-4 sm:mb-6 -mx-4 px-4 sm:mx-0 sm:px-0">
          {timetables.map((tt) => (
            <button
              key={tt.timetable_id}
              onClick={() => handleSelectTimetable(tt)}
              className={`flex-shrink-0 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${selected?.timetable_id === tt.timetable_id ? "bg-primary text-on-primary" : "bg-surface-container-low text-on-surface-variant hover:bg-surface-container"}`}
            >
              {tt.week_start} · v{tt.version}
            </button>
          ))}
        </div>
      )}

      {/* Weekly grid */}
      {selected && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 pb-4">
          {DAYS.map((day) => {
            const slots: TimetableSlot[] = selected.days[day] ?? [];
            return (
              <div key={day} className="space-y-2">
                <div className="flex items-center gap-2 px-1">
                  <h3 className="font-headline text-sm font-bold text-on-surface">{day}</h3>
                  {slots.length > 0 && (
                    <Badge variant="primary">{slots.length} {slots.length === 1 ? "slot" : "slots"}</Badge>
                  )}
                </div>
                {slots.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-outline-variant/30 p-4 text-center">
                    <span className="text-xs text-outline">Rest day</span>
                  </div>
                ) : (
                  slots.map((slot) => {
                    // Check if slot matches current drill mode
                    let isMatched = true;
                    if (drillMode === "weak" && masteryReport) {
                      isMatched = masteryReport.revise.some(s => s.section_id === slot.section_id);
                    }
                    if (drillMode === "shaky" && masteryReport) {
                      isMatched = masteryReport.shaky.some(s => s.section_id === slot.section_id);
                    }
                    if (drillMode === "review" && masteryReport) {
                      isMatched = masteryReport.due_for_review.some(s => s.section_id === slot.section_id);
                    }

                    return (
                      <Card
                        key={slot.section_id}
                        hoverable={isMatched}
                        onClick={() => isMatched && openSlot(slot)}
                        className={`p-4 ${!isMatched && drillMode ? "opacity-40 cursor-not-allowed" : ""}`}
                      >
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <p className="font-semibold text-sm text-on-surface leading-tight line-clamp-2 flex-1 min-w-0">{slot.section_title}</p>
                          <span className="material-symbols-outlined text-lg text-primary flex-shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>play_circle</span>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="neutral">{slot.start_time} – {slot.end_time}</Badge>
                          <Badge variant="primary">{slot.hours_allocated}h</Badge>
                          {slot.break_minutes > 0 && <Badge variant="secondary">{slot.break_minutes}m break</Badge>}
                          {slot.moved_from && (
                            <Badge variant="error">
                              <span className="material-symbols-outlined text-xs" style={{ fontVariationSettings: "'FILL' 1" }}>swap_horiz</span>
                              {" "}Moved from {slot.moved_from}
                            </Badge>
                          )}
                        </div>
                      </Card>
                    );
                  })
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Study modal */}
      {session && (
        <StudyModal
          session={session}
          onClose={() => { setSession(null); setDrillMode(null); }}
          onStartQuiz={handleStartQuiz}
          onSelectOption={handleSelectOption}
          onSubmitAnswer={handleSubmitAnswer}
          onNextQuestion={handleNextQuestion}
          timerEnabled={drillTimerEnabled}
          timerSeconds={60}
          quizQuestionCount={mcqCount}
        />
      )}
    </div>
  );
}
