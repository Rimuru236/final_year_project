import React, { useEffect, useState, useCallback } from "react";
import { Spinner, Badge, Toggle } from "../components/UI";
import { useToast } from "../lib/contexts";
import { timetableApi, mcqApi, progressApi, settingsApi, notesApi } from "../lib/api";
import { StudyModal } from "./StudyModal";
import type { Page, Timetable, TimetableSlot, MCQ, StudySession, MasteryReport, StudyPrefs, Note } from "../types";

const DEFAULT_MCQ_COUNT = 5;

interface TimetablePageProps {
  activeTimetableId: string | null;
  onNavigate: (page: Page) => void;
}

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// Keyword → icon mapping so each subject card gets a recognizable glyph, mirroring time.html's per-subject icons.
const SUBJECT_ICON_RULES: [RegExp, string][] = [
  [/calc|math|algebra|integral|deriv|geometry|statistic/i, "calculate"],
  [/physi|chem|bio|science/i, "science"],
  [/language|linguist|english|grammar|vocab|literat/i, "language"],
  [/code|program|data structure|algorithm|software|develop/i, "code"],
  [/quiz|exam|test/i, "quiz"],
  [/histor/i, "history_edu"],
  [/psych|cognit|\bai\b|artificial intelligence|neuro/i, "psychology"],
];

function getSubjectIcon(title: string): string {
  for (const [pattern, icon] of SUBJECT_ICON_RULES) {
    if (pattern.test(title)) return icon;
  }
  return "menu_book";
}

// Uploaded-note filename -> clean display title (strip extension), e.g. "calculus_ii.pdf" -> "calculus_ii"
function getNoteDisplayName(note: Note | undefined): string {
  if (!note) return "Uploaded Note";
  return note.filename.replace(/\.[^/.]+$/, "");
}

// Rotating accent per slot so a day's cards read as distinct subjects at a glance, not a uniform stack.
const SLOT_ACCENTS = [
  { card: "bg-primary text-on-primary", pill: "bg-white/20 text-on-primary", subtext: "text-on-primary/75", icon: "text-on-primary/80" },
  { card: "bg-tertiary text-on-tertiary", pill: "bg-white/20 text-on-tertiary", subtext: "text-on-tertiary/75", icon: "text-on-tertiary/80" },
  { card: "bg-secondary text-on-secondary", pill: "bg-white/20 text-on-secondary", subtext: "text-on-secondary/75", icon: "text-on-secondary/80" },
  { card: "bg-surface-container-lowest text-on-surface border border-outline-variant/20", pill: "bg-surface-container text-on-surface-variant", subtext: "text-on-surface-variant", icon: "text-primary" },
];

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
  const [showMasteryBreakdown, setShowMasteryBreakdown] = useState(false);
  const [showDrillActions, setShowDrillActions] = useState(false);
  const [expandedNoteGroups, setExpandedNoteGroups] = useState<Set<string>>(new Set());
  const [notesById, setNotesById] = useState<Record<string, Note>>({});
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalTarget, setGoalTarget] = useState(80);
  const [goalDeadline, setGoalDeadline] = useState("");
  const [savingGoal, setSavingGoal] = useState(false);

  useEffect(() => {
    settingsApi.getStudyPrefs()
      .then((prefs: StudyPrefs) => { if (prefs.default_mcq_count) setMcqCount(prefs.default_mcq_count); })
      .catch(() => { /* fall back to DEFAULT_MCQ_COUNT */ });
  }, []);

  useEffect(() => {
    notesApi.list()
      .then((list: Note[]) => {
        const map: Record<string, Note> = {};
        for (const n of list) map[n.note_id] = n;
        setNotesById(map);
      })
      .catch(() => { /* note titles are non-critical — falls back to "Uploaded Note" */ });
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

  const toggleNoteGroup = (day: string) => {
    setExpandedNoteGroups((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day); else next.add(day);
      return next;
    });
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

          {/* Mastery summary chips — collapsed by default to keep the panel from feeling packed */}
          <button
            onClick={() => setShowMasteryBreakdown((v) => !v)}
            className="flex items-center gap-2 px-3 py-1.5 bg-surface-container border border-outline-variant/20 text-on-surface rounded-full text-xs font-semibold hover:bg-surface-container-high transition-all"
          >
            <span className="material-symbols-outlined text-base">
              {showMasteryBreakdown ? "expand_less" : "expand_more"}
            </span>
            {showMasteryBreakdown ? "Hide" : "Show"} mastery breakdown
          </button>
          {showMasteryBreakdown && (
            <div className="flex flex-nowrap gap-2 overflow-x-auto pb-1 -mx-1 px-1">
              {masteryReport.solid.length > 0 && (
                <span className="flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                  🟢 {masteryReport.solid.length} solid
                </span>
              )}
              {masteryReport.shaky.length > 0 && (
                <span className="flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200">
                  🟡 {masteryReport.shaky.length} shaky
                </span>
              )}
              {masteryReport.revise.length > 0 && (
                <span className="flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-bold bg-red-50 text-red-700 border border-red-200">
                  🔴 {masteryReport.revise.length} need revision
                </span>
              )}
              {masteryReport.untouched.length > 0 && (
                <span className="flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-bold bg-surface-container text-on-surface-variant border border-outline-variant/20">
                  ⬜ {masteryReport.untouched.length} untouched
                </span>
              )}
              {masteryReport.due_for_review.length > 0 && (
                <span className="flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200">
                  🔵 {masteryReport.due_for_review.length} due for review
                </span>
              )}
            </div>
          )}

          {/* Drill buttons — collapsed by default; toggle reveals them in one straight horizontal row */}
          <button
            onClick={() => setShowDrillActions((v) => !v)}
            className="flex items-center gap-2 px-3 py-1.5 bg-surface-container border border-outline-variant/20 text-on-surface rounded-full text-xs font-semibold hover:bg-surface-container-high transition-all"
          >
            <span className="material-symbols-outlined text-base">
              {showDrillActions ? "expand_less" : "expand_more"}
            </span>
            {showDrillActions ? "Hide" : "Show"} drill options
          </button>
          {showDrillActions && (
            <div className="flex flex-nowrap gap-2 overflow-x-auto pb-1 -mx-1 px-1">
              <button
                onClick={() => { setDrillMode("weak"); setDrillTimerEnabled(false); }}
                disabled={masteryReport.revise.length === 0}
                className="flex-shrink-0 px-4 py-2 bg-red-50 text-red-700 border border-red-200 rounded-full text-xs font-bold hover:bg-red-100 disabled:opacity-40 transition-all"
              >
                Drill Weak Topics
              </button>
              <button
                onClick={() => { setDrillMode("shaky"); setDrillTimerEnabled(false); }}
                disabled={masteryReport.shaky.length === 0}
                className="flex-shrink-0 px-4 py-2 bg-amber-50 text-amber-700 border border-amber-200 rounded-full text-xs font-bold hover:bg-amber-100 disabled:opacity-40 transition-all"
              >
                Drill Shaky Topics
              </button>
              <button
                onClick={() => { setDrillMode("review"); setDrillTimerEnabled(false); }}
                disabled={masteryReport.due_for_review.length === 0}
                title="Solid topics you haven't revisited in a while — a light refresher before they fade"
                className="flex-shrink-0 px-4 py-2 bg-blue-50 text-blue-700 border border-blue-200 rounded-full text-xs font-bold hover:bg-blue-100 disabled:opacity-40 transition-all"
              >
                Review Solid Topics
              </button>
              <button
                onClick={() => { setDrillMode("all"); setDrillTimerEnabled(false); }}
                className="flex-shrink-0 px-4 py-2 bg-surface-container text-on-surface border border-outline-variant/20 rounded-full text-xs font-bold hover:bg-surface-container-high transition-all"
              >
                Practice All
              </button>
            </div>
          )}

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

      {/* Weekly grid — days arranged in one horizontal row (mirrors time.html's bento layout);
          each day always shows its uploaded-note container directly beneath it, which itself
          expands to reveal that note's sections when tapped */}
      {selected && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3 pb-4">
          {DAYS.map((day) => {
            const slots: TimetableSlot[] = selected.days[day] ?? [];
            const isNoteGroupExpanded = expandedNoteGroups.has(day);
            const noteName = getNoteDisplayName(notesById[selected.note_id]);
            return (
              <div key={day} className="flex flex-col gap-2">
                <div className="flex flex-col items-center gap-1.5 p-3 rounded-2xl text-center bg-surface-container-low">
                  <p className="text-[10px] font-black uppercase tracking-widest text-outline">
                    {day.slice(0, 3)}
                  </p>
                  {slots.length === 0 && (
                    <span className="text-[10px] font-semibold text-outline">Rest day</span>
                  )}
                </div>

                {slots.length === 0 ? (
                  <div className="rounded-3xl border-2 border-dashed border-outline-variant/30 p-6 min-h-[100px] flex items-center justify-center bg-surface-container-low/40">
                    <span className="text-[10px] text-outline font-bold tracking-widest uppercase">Rest day</span>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {/* Uploaded-note container — always shown directly under the day, no need to open the day itself;
                        clicking it toggles the note's sections open/closed. */}
                    <button
                      onClick={() => toggleNoteGroup(day)}
                      className={`w-full p-4 rounded-3xl min-h-[84px] flex flex-col justify-between text-left transition-all duration-200 ${
                        isNoteGroupExpanded
                          ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/20"
                          : "bg-surface-container-lowest border border-outline-variant/10 hover:bg-slate-50 hover:-translate-y-0.5"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <span
                          className={`material-symbols-outlined text-xl ${isNoteGroupExpanded ? "text-indigo-200" : "text-primary"}`}
                          style={{ fontVariationSettings: "'FILL' 1" }}
                        >
                          {getSubjectIcon(noteName)}
                        </span>
                        <span className={`text-[10px] font-bold px-2 py-1 rounded-full flex-shrink-0 ${isNoteGroupExpanded ? "bg-white/20 text-white" : "bg-surface-container text-on-surface-variant"}`}>
                          {slots.length} {slots.length === 1 ? "section" : "sections"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-bold text-sm leading-tight truncate">{noteName}</p>
                        <span className={`material-symbols-outlined text-base flex-shrink-0 ${isNoteGroupExpanded ? "text-white" : "text-outline"}`}>
                          {isNoteGroupExpanded ? "expand_less" : "expand_more"}
                        </span>
                      </div>
                    </button>

                    {isNoteGroupExpanded && (
                      <div className="space-y-2 pl-2 border-l-2 border-outline-variant/20">
                        {slots.map((slot, idx) => {
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

                        const accent = SLOT_ACCENTS[idx % SLOT_ACCENTS.length];

                        return (
                          <div
                            key={slot.section_id}
                            onClick={() => isMatched && openSlot(slot)}
                            className={`p-4 rounded-3xl min-h-[132px] flex flex-col justify-between transition-all duration-200 ${accent.card} ${
                              isMatched ? "cursor-pointer hover:-translate-y-1 hover:shadow-xl" : ""
                            } ${!isMatched && drillMode ? "opacity-40 cursor-not-allowed" : ""}`}
                          >
                            <div>
                              <div className="flex items-start justify-between gap-2 mb-2">
                                <span className={`material-symbols-outlined text-xl ${accent.icon}`} style={{ fontVariationSettings: "'FILL' 1" }}>
                                  {getSubjectIcon(slot.section_title)}
                                </span>
                                <span className={`text-[10px] font-bold px-2 py-1 rounded-full flex-shrink-0 ${accent.pill}`}>
                                  {slot.hours_allocated}h
                                </span>
                              </div>
                              <p className="font-bold text-sm leading-tight line-clamp-2">{slot.section_title}</p>
                            </div>
                            <div className="mt-2 space-y-1.5">
                              <p className={`text-[10px] font-medium ${accent.subtext}`}>{slot.start_time} – {slot.end_time}</p>
                              {(slot.break_minutes > 0 || slot.moved_from) && (
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  {slot.break_minutes > 0 && (
                                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${accent.pill}`}>
                                      {slot.break_minutes}m break
                                    </span>
                                  )}
                                  {slot.moved_from && (
                                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-500 text-white flex items-center gap-1">
                                      <span className="material-symbols-outlined text-[10px]" style={{ fontVariationSettings: "'FILL' 1" }}>swap_horiz</span>
                                      Moved from {slot.moved_from}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                        })}
                      </div>
                    )}
                  </div>
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
