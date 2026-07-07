import React, { useState, useEffect } from "react";
import { Card, Spinner, Badge } from "../components/UI";
import { useToast } from "../lib/contexts";
import { onboardingApi } from "../lib/api";
import type { ScheduleConstraints, Weekday, StudyTime } from "../types";
import { VALID_DAYS, VALID_STUDY_TIMES } from "../types";

const STUDY_TIME_LABELS: Record<StudyTime, string> = {
  early_morning: "Early Morning (5–8 am)",
  morning:       "Morning (8 am–12 pm)",
  afternoon:     "Afternoon (12–5 pm)",
  evening:       "Evening (5–9 pm)",
  night:         "Night (9 pm–12 am)",
};

const STUDY_TIME_ICONS: Record<StudyTime, string> = {
  early_morning: "bedtime",
  morning:       "wb_sunny",
  afternoon:     "partly_cloudy_day",
  evening:       "nights_stay",
  night:         "dark_mode",
};

const DEFAULT_FREE_HOURS: Record<Weekday, number> = {
  Monday: 3, Tuesday: 3, Wednesday: 3,
  Thursday: 3, Friday: 3, Saturday: 5, Sunday: 5,
};

export function OnboardingPage() {
  const toast = useToast();
  const [loading, setLoading]   = useState(true);
  const [saving,  setSaving]    = useState(false);
  const [saved,   setSaved]     = useState(false);

  // Form state
  const [blockedDays, setBlockedDays]         = useState<Set<Weekday>>(new Set());
  const [freeHours,   setFreeHours]           = useState<Record<Weekday, number>>({ ...DEFAULT_FREE_HOURS });
  const [studyTimes,  setStudyTimes]          = useState<Set<StudyTime>>(new Set(["morning", "afternoon"]));
  const [breakRatio,  setBreakRatio]          = useState(0.22); // ≈ 13-min break per hour (10/45)
  const [sessionLen,  setSessionLen]          = useState(1.5);  // hours

  // Behavior-derived suggestions — days the user appears to never study on
  const [suggestedDays, setSuggestedDays]     = useState<Weekday[]>([]);
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<Weekday>>(new Set());

  useEffect(() => {
    onboardingApi.getSchedule()
      .then((data: ScheduleConstraints) => {
        if (data.has_constraints) {
          setSaved(true);
          if (data.blocked_days)          setBlockedDays(new Set(data.blocked_days as Weekday[]));
          if (data.weekday_free_hours)    setFreeHours({ ...DEFAULT_FREE_HOURS, ...data.weekday_free_hours } as Record<Weekday, number>);
          if (data.preferred_study_times) setStudyTimes(new Set(data.preferred_study_times as StudyTime[]));
          if (data.default_break_ratio)   setBreakRatio(data.default_break_ratio);
          if (data.preferred_session_length) setSessionLen(data.preferred_session_length);
        }
        if (data.suggested_blocked_days?.length) setSuggestedDays(data.suggested_blocked_days as Weekday[]);
      })
      .catch(() => {/* no constraints yet — use defaults */})
      .finally(() => setLoading(false));
  }, []);

  const toggleDay = (day: Weekday) => {
    setBlockedDays(prev => {
      const next = new Set(prev);
      next.has(day) ? next.delete(day) : next.add(day);
      return next;
    });
  };

  const acceptSuggestion = (day: Weekday) => {
    setBlockedDays(prev => new Set(prev).add(day));
    setDismissedSuggestions(prev => new Set(prev).add(day));
  };

  const dismissSuggestion = (day: Weekday) => {
    setDismissedSuggestions(prev => new Set(prev).add(day));
  };

  const visibleSuggestions = suggestedDays.filter(d => !dismissedSuggestions.has(d));

  const toggleTime = (t: StudyTime) => {
    setStudyTimes(prev => {
      const next = new Set(prev);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });
  };

  const updateHours = (day: Weekday, val: string) => {
    const n = parseFloat(val);
    if (!isNaN(n) && n >= 0 && n <= 24) {
      setFreeHours(prev => ({ ...prev, [day]: n }));
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onboardingApi.saveSchedule({
        blocked_days:            Array.from(blockedDays),
        weekday_free_hours:      freeHours,
        preferred_study_times:   Array.from(studyTimes),
        default_break_ratio:     breakRatio,
        preferred_session_length: sessionLen,
      });
      setSaved(true);
      toast("Schedule constraints saved! New timetables will respect these settings.", "success");
    } catch (err: any) {
      toast(err.message ?? "Failed to save constraints", "error");
    } finally {
      setSaving(false);
    }
  };

  const activeDays = VALID_DAYS.filter(d => !blockedDays.has(d));

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Spinner size={32} />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-tertiary-container flex items-center justify-center">
            <span
              className="material-symbols-outlined text-xl text-tertiary"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              edit_calendar
            </span>
          </div>
          <div>
            <h1 className="font-headline text-2xl font-bold text-on-background">
              My Study Schedule
            </h1>
            <p className="text-sm text-on-surface-variant">
              Tell us when you're free so we can plan smarter timetables for you.
            </p>
          </div>
          {saved && (
            <Badge variant="success" className="ml-auto">
              <span className="material-symbols-outlined text-xs" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
              {" "}Saved
            </Badge>
          )}
        </div>
      </div>

      {/* Info banner (first-time only) */}
      {!saved && (
        <div className="flex items-start gap-3 p-4 bg-primary-container/30 rounded-2xl border border-primary/10">
          <span className="material-symbols-outlined text-primary mt-0.5" style={{ fontVariationSettings: "'FILL' 1" }}>info</span>
          <p className="text-sm text-on-surface-variant leading-relaxed">
            This is optional — if you skip it, timetables will be generated with equal time
            across all your chosen study days. Setting constraints here helps Cognitive Sanctuary
            respect your real schedule.
          </p>
        </div>
      )}

      {/* Behavior-derived blocked-day suggestions */}
      {visibleSuggestions.length > 0 && (
        <div className="space-y-2">
          {visibleSuggestions.map(day => (
            <div key={day} className="flex items-center justify-between gap-3 p-4 bg-amber-50 border border-amber-200 rounded-2xl">
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-amber-600 mt-0.5" style={{ fontVariationSettings: "'FILL' 1" }}>lightbulb</span>
                <p className="text-sm text-amber-800">
                  We noticed you've never studied on a <strong>{day}</strong> — want to mark it as unavailable?
                </p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => dismissSuggestion(day)}
                  className="px-3 py-2 rounded-xl text-xs font-semibold text-amber-800 hover:bg-amber-100 transition-colors"
                >
                  Not now
                </button>
                <button
                  onClick={() => acceptSuggestion(day)}
                  className="px-4 py-2 bg-amber-500 text-white rounded-xl text-xs font-bold hover:bg-amber-600 transition-colors"
                >
                  Mark {day.slice(0, 3)} unavailable
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Blocked Days ─────────────────────────────────────────────────────── */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>event_busy</span>
          <h2 className="font-headline text-base font-bold text-on-background">Unavailable Days</h2>
        </div>
        <p className="text-xs text-on-surface-variant">
          Select days you <strong>cannot</strong> study. Timetable generation will skip these entirely.
        </p>
        <div className="flex flex-wrap gap-2">
          {VALID_DAYS.map(day => {
            const blocked = blockedDays.has(day);
            return (
              <button
                key={day}
                onClick={() => toggleDay(day)}
                className={`px-4 py-2 rounded-full text-sm font-semibold transition-all duration-200 border ${
                  blocked
                    ? "bg-error/10 border-error/40 text-error line-through"
                    : "bg-surface-container border-outline-variant/30 text-on-surface hover:bg-primary-container hover:border-primary/20 hover:text-primary"
                }`}
              >
                {day.slice(0, 3)}
              </button>
            );
          })}
        </div>
        {blockedDays.size > 0 && (
          <p className="text-xs text-error">
            {blockedDays.size} day{blockedDays.size > 1 ? "s" : ""} blocked.{" "}
            {activeDays.length} available for study.
          </p>
        )}
      </Card>

      {/* ── Free Hours Per Day ───────────────────────────────────────────────── */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>hourglass</span>
          <h2 className="font-headline text-base font-bold text-on-background">Daily Study Budget</h2>
        </div>
        <p className="text-xs text-on-surface-variant">
          How many hours can you study on each available day? Timetables won't exceed these limits.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {VALID_DAYS.map(day => {
            const isBlocked = blockedDays.has(day);
            return (
              <div
                key={day}
                className={`rounded-2xl border p-3 transition-all ${
                  isBlocked
                    ? "bg-surface-container-low border-outline-variant/10 opacity-40"
                    : "bg-surface-container-low border-outline-variant/20"
                }`}
              >
                <label className="text-xs font-bold text-on-surface-variant block mb-2">
                  {day.slice(0, 3)}
                  {isBlocked && " (blocked)"}
                </label>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={0}
                    max={24}
                    step={0.5}
                    value={freeHours[day]}
                    disabled={isBlocked}
                    onChange={e => updateHours(day, e.target.value)}
                    className="w-full bg-background border-none rounded-lg px-2 py-1.5 text-sm font-semibold text-on-surface focus:ring-2 focus:ring-primary/30 disabled:cursor-not-allowed"
                  />
                  <span className="text-xs text-on-surface-variant whitespace-nowrap">h</span>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* ── Preferred Study Times ────────────────────────────────────────────── */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>schedule</span>
          <h2 className="font-headline text-base font-bold text-on-background">Preferred Study Times</h2>
        </div>
        <p className="text-xs text-on-surface-variant">
          When do you study best? Select all that apply — your timetable's daily start time will be anchored to the earliest one you pick.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {VALID_STUDY_TIMES.map(t => {
            const active = studyTimes.has(t);
            return (
              <button
                key={t}
                onClick={() => toggleTime(t)}
                className={`flex items-center gap-2 px-4 py-3 rounded-2xl text-sm font-semibold transition-all duration-200 border text-left ${
                  active
                    ? "bg-primary-container border-primary/20 text-on-primary-container"
                    : "bg-surface-container border-outline-variant/20 text-on-surface-variant hover:bg-primary-container/30"
                }`}
              >
                <span
                  className={`material-symbols-outlined text-base ${active ? "text-primary" : "text-outline"}`}
                  style={{ fontVariationSettings: active ? "'FILL' 1" : "'FILL' 0" }}
                >
                  {STUDY_TIME_ICONS[t]}
                </span>
                {STUDY_TIME_LABELS[t]}
              </button>
            );
          })}
        </div>
      </Card>

      {/* ── Study Rhythm ─────────────────────────────────────────────────────── */}
      <Card className="p-6 space-y-5">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>tune</span>
          <h2 className="font-headline text-base font-bold text-on-background">Study Rhythm</h2>
        </div>

        {/* Break ratio */}
        <div className="space-y-2">
          <div className="flex justify-between items-baseline">
            <label className="text-sm font-semibold text-on-surface-variant">Break time per hour</label>
            <span className="text-sm font-bold text-primary">{Math.round(breakRatio * 60)} min / hr</span>
          </div>
          <input
            type="range"
            min={0.1}
            max={0.5}
            step={0.02}
            value={breakRatio}
            onChange={e => setBreakRatio(parseFloat(e.target.value))}
            className="w-full accent-primary"
          />
          <div className="flex justify-between text-xs text-on-surface-variant">
            <span>6 min (intense)</span>
            <span>30 min (relaxed)</span>
          </div>
        </div>

        {/* Preferred session length */}
        <div className="space-y-2">
          <div className="flex justify-between items-baseline">
            <label className="text-sm font-semibold text-on-surface-variant">Preferred session length</label>
            <span className="text-sm font-bold text-primary">
              {sessionLen % 1 === 0 ? `${sessionLen}h` : `${sessionLen}h (${Math.round(sessionLen * 60)} min)`}
            </span>
          </div>
          <input
            type="range"
            min={0.25}
            max={4}
            step={0.25}
            value={sessionLen}
            onChange={e => setSessionLen(parseFloat(e.target.value))}
            className="w-full accent-primary"
          />
          <div className="flex justify-between text-xs text-on-surface-variant">
            <span>15 min</span>
            <span>4 hours</span>
          </div>
        </div>
      </Card>

      {/* Save button */}
      <div className="flex justify-end pb-8">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-8 py-3.5 bg-primary text-on-primary rounded-full font-bold text-sm shadow-lg shadow-primary/20 hover:scale-[1.02] hover:bg-primary-dim active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 w-full sm:w-auto justify-center"
        >
          {saving ? (
            <Spinner size={18} />
          ) : (
            <span className="material-symbols-outlined text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>save</span>
          )}
          {saving ? "Saving…" : "Save Schedule"}
        </button>
      </div>
    </div>
  );
}
