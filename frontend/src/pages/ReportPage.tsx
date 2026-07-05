import React, { useEffect, useState } from "react";
import { Spinner, Card, Badge } from "../components/UI";
import { useToast } from "../lib/contexts";
import { timetableApi, progressApi } from "../lib/api";
import type { Page, Timetable, ProgressReport, DayProgress, MasteryReport, SectionMastery } from "../types";

interface ReportPageProps {
  activeTimetableId: string | null;
  onNavigate: (page: Page) => void;
}

export function ReportPage({ activeTimetableId, onNavigate }: ReportPageProps) {
  const toast = useToast();
  const [timetables, setTimetables] = useState<Timetable[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [report, setReport] = useState<ProgressReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [reportLoading, setReportLoading] = useState(false);
  const [masteryReport, setMasteryReport] = useState<MasteryReport | null>(null);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);

  // Load timetable list on mount
  useEffect(() => {
    timetableApi.list()
      .then((list: Timetable[]) => {
        setTimetables(list);
        // Prefer activeTimetableId, else first timetable
        const preferred = activeTimetableId
          ? list.find((t) => t.timetable_id === activeTimetableId)?.timetable_id ?? list[0]?.timetable_id
          : list[0]?.timetable_id;
        if (preferred) setSelectedId(preferred);
      })
      .catch((err: any) => toast(err.message, "error"))
      .finally(() => setLoading(false));
  }, [activeTimetableId]);

  // Load report whenever selectedId changes
  useEffect(() => {
    if (!selectedId) return;
    setReportLoading(true);
    // FIX: backend returns WeeklyReport — field mapping: week_label, user_id,
    // overall_score, overall_improvement, total_attempts, sections, reassignment_log
    progressApi.report(selectedId)
      .then((r: any) => {
        // Attach timetable_id for reference since backend doesn't echo it
        setReport({ ...r, timetable_id: selectedId });
      })
      .catch((err: any) => {
        // 404 = no progress yet for this timetable — show empty state, not error
        if (err.status !== 404) toast(err.message, "error");
        setReport(null);
      })
      .finally(() => setReportLoading(false));

    // Load mastery report alongside progress report
    progressApi.mastery(selectedId)
      .then((r: MasteryReport) => setMasteryReport(r))
      .catch(() => { /* non-critical — silent fail */ });
  }, [selectedId]);

  // Score colour helper
  const scoreColor = (score: number) => {
    if (score >= 80) return "text-emerald-600";
    if (score >= 60) return "text-amber-600";
    return "text-red-600";
  };

  const scoreBg = (score: number) => {
    if (score >= 80) return "bg-emerald-50 border-emerald-200";
    if (score >= 60) return "bg-amber-50 border-amber-200";
    return "bg-red-50 border-red-200";
  };

  const improvementBadge = (imp: number) => {
    if (imp > 0) return <Badge variant="success">+{imp.toFixed(0)}%</Badge>;
    if (imp < 0) return <Badge variant="error">{imp.toFixed(0)}%</Badge>;
    return <Badge variant="neutral">—</Badge>;
  };

  // Helper — derive a day's mastery sections from the existing masteryReport
  function getDayMasterySections(dayName: string): SectionMastery[] {
    if (!masteryReport) return [];
    const sectionIdsForDay = new Set(masteryReport.sections_by_day[dayName] ?? []);
    if (sectionIdsForDay.size === 0) return [];
    return [
      ...masteryReport.revise,
      ...masteryReport.shaky,
      ...masteryReport.untouched,
      ...masteryReport.solid,
    ].filter(s => sectionIdsForDay.has(s.section_id));
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <Spinner size={40} />
          <p className="text-on-surface-variant mt-4 font-semibold">Loading reports…</p>
        </div>
      </div>
    );
  }

  if (timetables.length === 0) {
    return (
      <div className="p-6 lg:p-10 max-w-6xl mx-auto text-center py-20">
        <div className="w-20 h-20 rounded-full bg-tertiary-container/30 flex items-center justify-center mx-auto mb-6">
          <span className="material-symbols-outlined text-4xl text-tertiary" style={{ fontVariationSettings: "'FILL' 1" }}>bar_chart</span>
        </div>
        <h3 className="font-headline text-xl font-bold text-on-background mb-2">No Progress Yet</h3>
        <p className="text-on-surface-variant mb-6 max-w-sm mx-auto">
          Complete your first study session with a quiz to see your progress report here.
        </p>
        <button
          onClick={() => onNavigate("analysis")}
          className="px-8 py-4 bg-primary text-on-primary rounded-full font-bold shadow-lg shadow-primary/20 hover:scale-[1.02] transition-all"
        >
          Generate Timetable
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-10 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="inline-flex items-center gap-2 mb-3 px-3 py-1.5 bg-tertiary-container/40 rounded-full">
          <span className="material-symbols-outlined text-sm text-tertiary" style={{ fontVariationSettings: "'FILL' 1" }}>bar_chart</span>
          <span className="text-xs font-bold text-on-tertiary-container uppercase tracking-widest">Progress Report</span>
        </div>
        <h1 className="font-headline text-3xl font-extrabold text-on-background tracking-tight mb-2">
          Weekly Progress
        </h1>
        <p className="text-on-surface-variant">
          Track your quiz performance and RL-driven timetable adaptations.
        </p>
      </div>

      {/* Timetable selector */}
      {timetables.length > 0 && (
        <div className="mb-6">
          <label className="text-sm font-semibold text-on-surface-variant block mb-1.5">Select Timetable</label>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="w-full max-w-sm px-4 py-3 bg-surface-container-low border-none rounded-xl focus:ring-2 focus:ring-primary/30 text-sm appearance-none"
          >
            {timetables.map((t) => (
              <option key={t.timetable_id} value={t.timetable_id}>
                Week of {t.week_start} · v{t.version}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Report loading */}
      {reportLoading && (
        <div className="flex items-center justify-center py-16">
          <div className="text-center">
            <Spinner size={32} />
            <p className="text-on-surface-variant mt-3 text-sm font-semibold">Fetching report…</p>
          </div>
        </div>
      )}

      {/* No progress for this timetable */}
      {!reportLoading && !report && selectedId && (
        <div className="text-center py-16 rounded-2xl border border-dashed border-outline-variant/30">
          <span className="material-symbols-outlined text-5xl text-outline mb-4 block">hourglass_empty</span>
          <p className="font-semibold text-on-surface-variant">No quiz attempts yet</p>
          <p className="text-sm text-outline mt-1">
            Open your timetable, study a section, and complete a quiz to generate a report.
          </p>
          <button
            onClick={() => onNavigate("timetable")}
            className="mt-6 px-6 py-3 bg-primary text-on-primary rounded-full font-bold text-sm hover:scale-[1.02] transition-all shadow-md shadow-primary/20"
          >
            Go to Timetable
          </button>
        </div>
      )}

      {/* Full report */}
      {!reportLoading && report && (
        <div className="space-y-6">
          {/* Overview cards */}
          <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              {
                label: "Overall Score",
                value: `${report.overall_score?.toFixed(0) ?? 0}%`,
                icon: "grade",
                color: "bg-primary-container text-on-primary-container",
                iconColor: "text-primary",
              },
              {
                label: "Improvement",
                value: `${report.overall_improvement >= 0 ? "+" : ""}${report.overall_improvement?.toFixed(0) ?? 0}%`,
                icon: "trending_up",
                color: "bg-secondary-container text-on-secondary-container",
                iconColor: "text-secondary",
              },
              {
                label: "Total Attempts",
                value: String(report.total_attempts ?? 0),
                icon: "quiz",
                color: "bg-tertiary-container text-on-tertiary-container",
                iconColor: "text-tertiary",
              },
              {
                label: "Week",
                // FIX: backend WeeklyReport.week_label — was timetable_id in old frontend
                value: report.week_label ?? "This week",
                icon: "calendar_today",
                color: "bg-surface-container-high text-on-surface",
                iconColor: "text-on-surface-variant",
              },
            ].map((s) => (
              <Card key={s.label} className="p-5">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 ${s.color}`}>
                  <span className={`material-symbols-outlined text-xl ${s.iconColor}`} style={{ fontVariationSettings: "'FILL' 1" }}>{s.icon}</span>
                </div>
                <p className="text-xl font-black text-on-background font-headline mb-0.5">{s.value}</p>
                <p className="text-xs font-bold text-on-surface-variant uppercase tracking-wide">{s.label}</p>
              </Card>
            ))}
          </div>

          {/* Section breakdown */}
          {report.sections?.length > 0 && (
            <Card className="p-6">
              <h2 className="font-headline text-lg font-bold text-on-background mb-4">
                Section Performance
              </h2>
              <div className="space-y-3">
                {report.sections.map((sec) => (
                  <div
                    key={sec.section_id}
                    className={`p-4 rounded-2xl border ${scoreBg(sec.current_score)}`}
                  >
                    <div className="flex items-start justify-between gap-3 flex-wrap min-w-0">
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-sm text-on-surface truncate">{sec.section_title}</p>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          <span className={`text-sm font-black ${scoreColor(sec.current_score)}`}>
                            {sec.current_score.toFixed(0)}%
                          </span>
                          {improvementBadge(sec.improvement)}
                          <Badge variant="neutral">Attempt #{sec.attempt_number}</Badge>
                          <Badge variant="neutral">{sec.hours_allocated}h allocated</Badge>
                        </div>
                      </div>
                      {/* Score bar */}
                      <div className="w-24 flex-shrink-0">
                        <div className="h-2 bg-white/60 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-700 ${sec.current_score >= 80 ? "bg-emerald-500" : sec.current_score >= 60 ? "bg-amber-500" : "bg-red-500"}`}
                            style={{ width: `${sec.current_score}%` }}
                          />
                        </div>
                        {sec.previous_score !== null && sec.previous_score !== undefined && (
                          <p className="text-xs text-on-surface-variant mt-1 text-right">
                            prev: {sec.previous_score.toFixed(0)}%
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* D2-1 + mastery-relocation: Per-day breakdown with tap-to-expand mastery */}
          {report.daily_breakdown && Object.keys(report.daily_breakdown).length > 0 && (
            <Card className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-primary-container flex items-center justify-center">
                  <span className="material-symbols-outlined text-xl text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>
                    calendar_view_week
                  </span>
                </div>
                <div>
                  <h2 className="font-headline text-lg font-bold text-on-background">Daily Breakdown</h2>
                  <p className="text-xs text-on-surface-variant">
                    Average quiz score per study day — tap a day to see topic mastery
                  </p>
                </div>
              </div>

              {/* Day tiles grid — unchanged columns, now tappable */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {Object.values(report.daily_breakdown).map((day: DayProgress) => {
                  const color =
                    day.average_score >= 80 ? "bg-emerald-50 border-emerald-200 text-emerald-700" :
                    day.average_score >= 60 ? "bg-amber-50 border-amber-200 text-amber-700" :
                    day.attempted_count === 0 ? "bg-surface-container-low border-outline-variant/20 text-on-surface-variant" :
                    "bg-red-50 border-red-200 text-red-700";
                  const scoreLabel = day.attempted_count === 0 ? "—" : `${day.average_score.toFixed(0)}%`;
                  const isExpanded = expandedDay === day.day_name;
                  const hasMasteryData = (masteryReport?.sections_by_day[day.day_name]?.length ?? 0) > 0;

                  return (
                    <button
                      key={day.day_name}
                      onClick={() => hasMasteryData && setExpandedDay(isExpanded ? null : day.day_name)}
                      disabled={!hasMasteryData}
                      className={`text-left rounded-2xl border p-4 transition-all ${color} ${
                        isExpanded ? "ring-2 ring-primary/40" : ""
                      } ${hasMasteryData ? "cursor-pointer hover:scale-[1.02]" : "cursor-default opacity-80"}`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <p className="text-xs font-bold uppercase tracking-wide opacity-70">{day.day_name}</p>
                        {hasMasteryData && (
                          <span
                            className="material-symbols-outlined text-base opacity-60 transition-transform duration-200"
                            style={{ transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)" }}
                          >
                            expand_more
                          </span>
                        )}
                      </div>
                      <p className="text-2xl font-black font-headline">{scoreLabel}</p>
                      <p className="text-xs mt-1 opacity-70">
                        {day.attempted_count}/{day.section_count} sections attempted
                      </p>
                    </button>
                  );
                })}
              </div>

              {/* Expanded mastery panel — full width, appears below the grid */}
              {expandedDay && (
                <div className="mt-4 p-4 bg-surface-container-low rounded-2xl animate-in fade-in duration-200">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <p className="text-sm font-bold text-on-background">
                      {expandedDay} · Topic Mastery
                    </p>
                    <button
                      onClick={() => setExpandedDay(null)}
                      className="text-on-surface-variant hover:text-on-surface transition-colors"
                      aria-label="Collapse"
                    >
                      <span className="material-symbols-outlined text-xl">close</span>
                    </button>
                  </div>

                  {getDayMasterySections(expandedDay).length === 0 ? (
                    <p className="text-sm text-on-surface-variant text-center py-4">
                      No mastery data for {expandedDay} yet.
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {getDayMasterySections(expandedDay).map(s => {
                        const barColor =
                          s.classification === "solid"  ? "bg-emerald-500" :
                          s.classification === "shaky"  ? "bg-amber-400"   :
                          s.classification === "revise" ? "bg-red-500"     :
                          "bg-outline-variant";
                        const labelText =
                          s.classification === "solid"  ? "🟢 Solid" :
                          s.classification === "shaky"  ? "🟡 Shaky" :
                          s.classification === "revise" ? "🔴 Revise" :
                          "⬜ Untouched";
                        return (
                          <div key={s.section_id} className="p-3 bg-surface-container-lowest rounded-xl">
                            <p className="font-semibold text-sm text-on-background line-clamp-2 mb-1">
                              {s.section_title}
                            </p>
                            <p className="text-xs text-on-surface-variant mb-2">
                              {labelText} · {s.attempt_count} attempt{s.attempt_count !== 1 ? "s" : ""}
                            </p>
                            <div className="w-full bg-surface-container-high rounded-full h-1.5 mb-1.5">
                              <div
                                className={`h-1.5 rounded-full transition-all duration-500 ${barColor}`}
                                style={{ width: `${s.mastery_pct ?? 0}%` }}
                              />
                            </div>
                            <p className="text-xs font-bold text-on-surface-variant">
                              {s.mastery_pct !== null ? `${s.mastery_pct.toFixed(0)}% mastery` : "No data yet"}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </Card>
          )}

          {/* RL Reassignment Log */}
          {report.reassignment_log?.length > 0 && (
            <Card className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-secondary-container flex items-center justify-center">
                  <span className="material-symbols-outlined text-xl text-secondary" style={{ fontVariationSettings: "'FILL' 1" }}>auto_fix_high</span>
                </div>
                <div>
                  <h2 className="font-headline text-lg font-bold text-on-background">RL Adaptation Log</h2>
                  <p className="text-xs text-on-surface-variant">Automatic time adjustments from the reinforcement learning engine</p>
                </div>
              </div>
              <div className="space-y-2">
                {report.reassignment_log.map((entry, i) => (
                  <div key={i} className="flex items-start gap-3 p-3 bg-surface-container-low rounded-xl">
                    <span className="material-symbols-outlined text-lg text-secondary flex-shrink-0 mt-0.5" style={{ fontVariationSettings: "'FILL' 1" }}>
                      {entry.includes("increased") ? "arrow_upward" : entry.includes("reduced") ? "arrow_downward" : "swap_horiz"}
                    </span>
                    <p className="text-sm text-on-surface">{entry}</p>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Empty sections state */}
          {(!report.sections || report.sections.length === 0) && (
            <div className="text-center py-12 rounded-2xl border border-dashed border-outline-variant/30">
              <span className="material-symbols-outlined text-4xl text-outline mb-3 block">pending</span>
              <p className="font-semibold text-on-surface-variant">No section data yet</p>
              <p className="text-sm text-outline mt-1">Complete quiz sessions to populate your report.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
