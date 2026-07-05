import React, { useEffect, useState } from "react";
import { Spinner, Card } from "../components/UI";
import { useAuth } from "../lib/contexts";
import { notesApi, timetableApi, progressApi, onboardingApi } from "../lib/api";
import type { Page, Note, Timetable } from "../types";

interface DashboardPageProps {
  onNavigate: (page: Page) => void;
}

export function DashboardPage({ onNavigate }: DashboardPageProps) {
  const { user } = useAuth();
  const [notes, setNotes] = useState<Note[]>([]);
  const [timetables, setTimetables] = useState<Timetable[]>([]);
  const [loading, setLoading] = useState(true);
  const [overallScore, setOverallScore] = useState<number | null>(null);
  const [showOnboardingBanner, setShowOnboardingBanner] = useState(false);

  useEffect(() => {
    Promise.all([
      notesApi.list().catch(() => [] as Note[]),
      timetableApi.list().catch(() => [] as Timetable[]),
    ]).then(([n, t]) => {
      setNotes(n);
      setTimetables(t);
      // FIX: backend WeeklyReport uses overall_score — was correct, just ensure it resolves
      if (t.length > 0) {
        progressApi.report(t[0].timetable_id).then((r: any) => {
          setOverallScore(r.overall_score ?? null);
        }).catch(() => {});
      }
      setLoading(false);
    });

    // Surface an adoption nudge for users who have never set schedule
    // constraints — this personalization exists but was going unused.
    onboardingApi.getSchedule()
      .then((r: { has_constraints: boolean }) => setShowOnboardingBanner(!r.has_constraints))
      .catch(() => { /* non-critical — just skip the banner */ });
  }, []);

  const greet = () => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    return "Good evening";
  };

  const statsCards = [
    {
      label: "Study Notes",
      value: loading ? "—" : String(notes.length),
      icon: "description",
      color: "bg-primary-container text-on-primary-container",
      iconColor: "text-primary",
      action: () => onNavigate("upload"),
      actionLabel: "Upload new",
    },
    {
      label: "Study Plans",
      value: loading ? "—" : String(timetables.length),
      icon: "calendar_month",
      color: "bg-secondary-container text-on-secondary-container",
      iconColor: "text-secondary",
      action: () => onNavigate("timetable"),
      actionLabel: "View plans",
    },
    {
      label: "Quiz Score",
      value: loading ? "—" : overallScore !== null ? `${overallScore.toFixed(0)}%` : "—",
      icon: "bar_chart",
      color: "bg-tertiary-container text-on-tertiary-container",
      iconColor: "text-tertiary",
      action: () => onNavigate("report"),
      actionLabel: "Full report",
    },
    {
      label: "AI Analysis",
      value: "Ready",
      icon: "psychology",
      color: "bg-surface-container-high text-on-surface",
      iconColor: "text-on-surface-variant",
      action: () => onNavigate("analysis"),
      actionLabel: "Run analysis",
    },
  ];

  const quickActions = [
    { label: "Upload Notes",    icon: "upload_file",  page: "upload" as Page,       description: "Add study materials" },
    { label: "Run AI Analysis", icon: "analytics",    page: "analysis" as Page,     description: "Detect weaknesses" },
    { label: "View Timetable",  icon: "calendar_month",page: "timetable" as Page,   description: "Your study plan" },
    { label: "Progress Report", icon: "bar_chart",    page: "report" as Page,       description: "Track improvement" },
    { label: "AI Assistant",    icon: "psychology",   page: "ai-assistant" as Page, description: "Chat with AI" },
  ];

  return (
    <div className="p-4 sm:p-6 lg:p-10 max-w-6xl mx-auto">
      {/* Welcome header */}
      <div className="mb-10">
        <div className="flex items-center gap-3 mb-2">
          <span className="material-symbols-outlined text-3xl text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>waving_hand</span>
          <h1 className="font-headline text-3xl font-extrabold text-on-background tracking-tight">
            {greet()}, {user?.name?.split(" ")[0] ?? "Scholar"}
          </h1>
        </div>
        <p className="text-on-surface-variant ml-12">
          Welcome to your Cognitive Sanctuary. Ready to continue your journey?
        </p>
      </div>

      {/* Onboarding schedule constraints adoption banner */}
      {showOnboardingBanner && (
        <div className="mb-10 p-5 bg-primary-container/30 border border-primary/20 rounded-2xl flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 rounded-xl bg-primary-container flex items-center justify-center flex-shrink-0">
              <span className="material-symbols-outlined text-xl text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>edit_calendar</span>
            </div>
            <div>
              <p className="font-headline font-bold text-on-background text-sm">Tell us when you're free to study</p>
              <p className="text-xs text-on-surface-variant mt-0.5">
                Set your available hours and blocked days so your timetable is built around your real schedule, not a generic one.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => setShowOnboardingBanner(false)}
              className="px-3 py-2 rounded-xl text-xs font-semibold text-on-surface-variant hover:bg-surface-container-high transition-colors"
            >
              Maybe later
            </button>
            <button
              onClick={() => onNavigate("schedule")}
              className="px-4 py-2 bg-primary text-on-primary rounded-xl text-xs font-bold hover:scale-[1.02] active:scale-[0.98] transition-all"
            >
              Set my schedule
            </button>
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
        {statsCards.map((s) => (
          <Card key={s.label} hoverable onClick={s.action} className="p-5">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 ${s.color}`}>
              <span className={`material-symbols-outlined text-xl ${s.iconColor}`} style={{ fontVariationSettings: "'FILL' 1" }}>{s.icon}</span>
            </div>
            <p className="text-2xl font-black text-on-background font-headline mb-0.5">
              {loading
                ? <span className="inline-block w-8 h-6 bg-surface-container-high rounded animate-pulse" />
                : s.value
              }
            </p>
            <p className="text-xs font-bold text-on-surface-variant uppercase tracking-wide">{s.label}</p>
            <p className="text-xs text-primary font-semibold mt-2">{s.actionLabel} →</p>
          </Card>
        ))}
      </div>

      {/* Quick actions */}
      <div className="mb-10">
        <h2 className="font-headline text-xl font-bold text-on-background mb-4">Quick Actions</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {quickActions.map((qa) => (
            <button
              key={qa.page}
              onClick={() => onNavigate(qa.page)}
              className="flex items-center gap-4 p-5 bg-surface-container-lowest rounded-2xl border border-outline-variant/20 hover:-translate-y-1 hover:shadow-md transition-all duration-200 text-left group"
            >
              <div className="w-12 h-12 rounded-xl bg-primary-container/50 flex items-center justify-center flex-shrink-0 group-hover:bg-primary-container transition-colors">
                <span className="material-symbols-outlined text-xl text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>{qa.icon}</span>
              </div>
              <div>
                <p className="font-bold text-on-surface text-sm">{qa.label}</p>
                <p className="text-xs text-on-surface-variant">{qa.description}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Recent notes */}
      {notes.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-headline text-xl font-bold text-on-background">Recent Notes</h2>
            <button onClick={() => onNavigate("upload")} className="text-sm font-bold text-primary hover:text-primary-dim transition-colors">View all →</button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {notes.slice(0, 6).map((note) => (
              <Card key={note.note_id} className="p-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-surface-container-high flex items-center justify-center flex-shrink-0">
                    <span className="material-symbols-outlined text-xl text-on-surface-variant">description</span>
                  </div>
                  <div className="min-w-0">
                    <p className="font-bold text-sm text-on-surface truncate">{note.filename}</p>
                    <p className="text-xs text-on-surface-variant">{note.subject} · {note.topic}</p>
                    <p className="text-xs text-outline mt-1">{new Date(note.created_at).toLocaleDateString()}</p>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && notes.length === 0 && (
        <div className="text-center py-16">
          <div className="w-20 h-20 rounded-full bg-primary-container/30 flex items-center justify-center mx-auto mb-6">
            <span className="material-symbols-outlined text-4xl text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>auto_stories</span>
          </div>
          <h3 className="font-headline text-xl font-bold text-on-background mb-2">Your sanctuary awaits</h3>
          <p className="text-on-surface-variant mb-6 max-w-sm mx-auto">
            Upload your first study notes to begin your AI-powered learning journey.
          </p>
          <button onClick={() => onNavigate("upload")} className="px-8 py-4 bg-primary text-on-primary rounded-full font-bold shadow-lg shadow-primary/20 hover:scale-[1.02] transition-all">
            Upload Your First Notes
          </button>
        </div>
      )}
    </div>
  );
}
