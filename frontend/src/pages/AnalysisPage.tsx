import React, { useState, useEffect } from "react";
import { Spinner, Card, Badge } from "../components/UI";
import { useToast } from "../lib/contexts";
import { predictApi, timetableApi, notesApi } from "../lib/api";
import type { Page, PredictResult, Note } from "../types";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

interface AnalysisPageProps {
  onNavigate: (page: Page) => void;
  onTimetableGenerated: (id: string) => void;
  onPredictResult: (r: PredictResult) => void;
}

export function AnalysisPage({ onNavigate, onTimetableGenerated, onPredictResult }: AnalysisPageProps) {
  const toast = useToast();
  const [form, setForm] = useState({
    subject: "Mathematics",
    topic: "Algebra",
    exam_score: 55,
    study_time: 6,
    weakness_score: 0.5,
    topic_difficulty: 2,
  });
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedNote, setSelectedNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<PredictResult | null>(null);
  const [mlUnavailable, setMlUnavailable] = useState(false);
  // FIX: load dynamic subject/topic lists from backend predict/subjects endpoint
  const [knownSubjects, setKnownSubjects] = useState<string[]>([]);
  const [knownTopics, setKnownTopics] = useState<string[]>([]);

  useEffect(() => {
    notesApi.list().then(setNotes).catch(() => {});
    // FIX: fetch known subjects from backend for dropdown hints
    predictApi.subjects().then((d: any) => {
      if (d?.subjects?.length) setKnownSubjects(d.subjects.slice(0, 20));
      if (d?.topics?.length) setKnownTopics(d.topics);
    }).catch(() => {});
  }, []);

  const setF = (k: keyof typeof form) => (v: number | string) =>
    setForm((f) => ({ ...f, [k]: v }));

  // Soft, non-blocking heads-up — the model still produces an estimate for an
  // unrecognised subject/topic (see safe_encode's fallback), just a rougher one.
  const isKnownValue = (value: string, known: string[]) =>
    known.length === 0 || known.some((k) => k.trim().toLowerCase() === value.trim().toLowerCase());
  const subjectRecognised = isKnownValue(form.subject, knownSubjects);
  const topicRecognised = isKnownValue(form.topic, knownTopics);

  const predict = async () => {
    setLoading(true);
    setMlUnavailable(false);
    try {
      const data: PredictResult = await predictApi.run(form);
      setResult(data);
      onPredictResult(data);
      toast("Analysis complete!", "success");
    } catch (err: any) {
      if (err.message?.toLowerCase().includes("ml models") || err.status === 503) {
        setMlUnavailable(true);
      } else {
        toast(err.message, "error");
      }
    } finally {
      setLoading(false);
    }
  };

  // FIX: graceful fallback when ML models unavailable — kept but clearly labelled
  const proceedWithDefaults = () => {
    const defaults: PredictResult = {
      subject: form.subject,
      topic: form.topic,
      exam_score: form.exam_score,
      is_weak: form.exam_score < 60,
      confidence: 0.5,
      recommended_hours: 10,
      study_days: 5,
      daily_schedule: {
        Monday:    { study: 2, breaks: 0.5, total: 2.5 },
        Tuesday:   { study: 2, breaks: 0.5, total: 2.5 },
        Wednesday: { study: 2, breaks: 0.5, total: 2.5 },
        Thursday:  { study: 2, breaks: 0.5, total: 2.5 },
        Friday:    { study: 2, breaks: 0.5, total: 2.5 },
        Saturday:  { study: 0, breaks: 0, total: 0 },
        Sunday:    { study: 0, breaks: 0, total: 0 },
      },
      known_subjects: knownSubjects,
      // Fallback path never ran the real model, so neither bias nor vocabulary lookup applied
      bias_applied: false,
      is_known_subject: false,
      is_known_topic: false,
    };
    setResult(defaults);
    onPredictResult(defaults);
    setMlUnavailable(false);
    toast("Using default study plan (ML models unavailable)", "info");
  };

  const generateTimetable = async () => {
    if (!result || !selectedNote) {
      toast("Select a note and run analysis first", "error");
      return;
    }
    setGenerating(true);
    try {
      const tt = await timetableApi.generate({
        note_id: selectedNote,
        recommended_hours: result.recommended_hours,
        study_days: result.study_days,
        is_weak: result.is_weak,
        // FIX: send topic_difficulty from form — backend requires it
        topic_difficulty: form.topic_difficulty,
      });
      onTimetableGenerated(tt.timetable_id);
      toast("Timetable generated!", "success");
      onNavigate("timetable");
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setGenerating(false);
    }
  };

  const SliderField = ({
    label, value, min, max, step, onChange, format,
  }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string }) => (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-semibold text-on-surface-variant">{label}</label>
        <span className="text-sm font-bold text-primary">{format ? format(value) : value}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-2 bg-surface-container-high rounded-full appearance-none cursor-pointer accent-primary"
      />
      <div className="flex justify-between text-xs text-outline">
        <span>{format ? format(min) : min}</span>
        <span>{format ? format(max) : max}</span>
      </div>
    </div>
  );

  return (
    <div className="p-4 sm:p-6 lg:p-10 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="inline-flex items-center gap-2 mb-3 px-3 py-1.5 bg-secondary-container/40 rounded-full">
          <span className="material-symbols-outlined text-sm text-secondary" style={{ fontVariationSettings: "'FILL' 1" }}>analytics</span>
          <span className="text-xs font-bold text-on-secondary-container uppercase tracking-widest">AI Analysis</span>
        </div>
        <h1 className="font-headline text-3xl font-extrabold text-on-background tracking-tight mb-2">Performance Analysis</h1>
        <p className="text-on-surface-variant">Enter your study data to get AI-powered recommendations and a personalised timetable.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Input form */}
        <Card className="p-6 space-y-5">
          <h2 className="font-headline text-lg font-bold text-on-background">Study Parameters</h2>

          {/* Subject */}
          <div className="space-y-1.5">
            <label className="text-sm font-semibold text-on-surface-variant">Subject</label>
            <input
              type="text"
              value={form.subject}
              onChange={(e) => setF("subject")(e.target.value)}
              list="subject-list"
              placeholder="e.g. Mathematics"
              className="w-full px-4 py-3 bg-surface-container-low border-none rounded-xl focus:ring-2 focus:ring-primary/30 text-sm"
            />
            {knownSubjects.length > 0 && (
              <datalist id="subject-list">
                {knownSubjects.map((s) => <option key={s} value={s} />)}
              </datalist>
            )}
            {form.subject.trim() && !subjectRecognised && (
              <p className="text-xs text-amber-600">
                Not in our model's training vocabulary — you'll still get an estimate, just a rougher one.
              </p>
            )}
          </div>

          {/* Topic */}
          <div className="space-y-1.5">
            <label className="text-sm font-semibold text-on-surface-variant">Topic</label>
            <input
              type="text"
              value={form.topic}
              onChange={(e) => setF("topic")(e.target.value)}
              list="topic-list"
              placeholder="e.g. Differential Equations"
              className="w-full px-4 py-3 bg-surface-container-low border-none rounded-xl focus:ring-2 focus:ring-primary/30 text-sm"
            />
            {knownTopics.length > 0 && (
              <datalist id="topic-list">
                {knownTopics.map((t) => <option key={t} value={t} />)}
              </datalist>
            )}
            {form.topic.trim() && !topicRecognised && (
              <p className="text-xs text-amber-600">
                Not in our model's training vocabulary — you'll still get an estimate, just a rougher one.
              </p>
            )}
          </div>

          <SliderField label="Last Exam Score" value={form.exam_score} min={0} max={100} step={1} onChange={setF("exam_score")} format={(v) => `${v}%`} />
          <SliderField label="Weekly Study Hours" value={form.study_time} min={1} max={40} step={0.5} onChange={setF("study_time")} format={(v) => `${v}h`} />
          <SliderField label="Weakness Score" value={form.weakness_score} min={0} max={1} step={0.05} onChange={setF("weakness_score")} format={(v) => v.toFixed(2)} />

          {/* Topic difficulty */}
          <div className="space-y-2">
            <label className="text-sm font-semibold text-on-surface-variant">Topic Difficulty</label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {[{ v: 1, label: "Easy" }, { v: 2, label: "Medium" }, { v: 3, label: "Hard" }].map(({ v, label }) => (
                <button
                  key={v}
                  onClick={() => setF("topic_difficulty")(v)}
                  className={`py-2.5 rounded-xl text-sm font-bold transition-all ${form.topic_difficulty === v ? "bg-primary text-on-primary shadow-md shadow-primary/20" : "bg-surface-container-low text-on-surface-variant hover:bg-surface-container"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={predict}
            disabled={loading}
            className="w-full py-4 bg-primary text-on-primary rounded-xl font-bold text-sm shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 transition-all flex items-center justify-center gap-2"
          >
            {loading ? <Spinner size={18} /> : <span className="material-symbols-outlined text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>psychology</span>}
            {loading ? "Analysing…" : "Run AI Analysis"}
          </button>
        </Card>

        {/* Results */}
        <div className="space-y-4">
          {/* ML unavailable banner */}
          {mlUnavailable && (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl">
              <div className="flex items-start gap-3 mb-3">
                <span className="material-symbols-outlined text-amber-500" style={{ fontVariationSettings: "'FILL' 1" }}>warning</span>
                <div>
                  <p className="font-bold text-amber-800 text-sm">ML Models Unavailable</p>
                  <p className="text-xs text-amber-700 mt-0.5">The prediction models are not loaded on the backend. You can proceed with default values.</p>
                </div>
              </div>
              <button onClick={proceedWithDefaults} className="w-full py-2.5 bg-amber-500 text-white rounded-xl font-bold text-sm hover:bg-amber-600 transition-colors">
                Use Default Plan
              </button>
            </div>
          )}

          {result && (
            <>
              {/* Result summary */}
              <Card className="p-5">
                <h3 className="font-headline text-base font-bold text-on-background mb-4">Analysis Results</h3>

                {result.bias_applied && (
                  <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-xl">
                    <span className="material-symbols-outlined text-emerald-600 text-lg flex-shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
                    <p className="text-xs text-emerald-800 font-semibold">Personalised using your own quiz history for this subject</p>
                  </div>
                )}

                {(!result.is_known_subject || !result.is_known_topic) && (
                  <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-xl">
                    <span className="material-symbols-outlined text-amber-600 text-lg flex-shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>info</span>
                    <p className="text-xs text-amber-800 font-semibold">
                      Rough estimate — {
                        !result.is_known_subject && !result.is_known_topic
                          ? "this subject and topic aren't"
                          : !result.is_known_subject
                          ? "this subject isn't"
                          : "this topic isn't"
                      } recognised by our prediction model yet
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: "Status", value: result.is_weak ? "Needs Focus" : "On Track", color: result.is_weak ? "text-red-600" : "text-emerald-600" },
                    { label: "Confidence", value: `${(result.confidence * 100).toFixed(0)}%`, color: "text-primary" },
                    { label: "Recommended Hours", value: `${result.recommended_hours}h / week`, color: "text-on-background" },
                    { label: "Study Days", value: `${result.study_days} days / week`, color: "text-on-background" },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="bg-surface-container-low rounded-xl p-3">
                      <p className="text-xs text-on-surface-variant mb-1">{label}</p>
                      <p className={`font-bold text-sm ${color}`}>{value}</p>
                    </div>
                  ))}
                </div>
              </Card>

              {/* Daily schedule */}
              <Card className="p-5">
                <h3 className="font-headline text-base font-bold text-on-background mb-4">Daily Schedule</h3>
                <div className="space-y-2">
                  {DAYS.map((day) => {
                    const s = result.daily_schedule[day];
                    if (!s || s.total === 0) return (
                      <div key={day} className="flex items-center justify-between py-1.5 px-3 rounded-lg">
                        <span className="text-xs text-outline">{day.slice(0, 3)}</span>
                        <span className="text-xs text-outline">Rest</span>
                      </div>
                    );
                    return (
                      <div key={day} className="flex items-center gap-3">
                        <span className="w-8 text-xs font-semibold text-on-surface-variant flex-shrink-0">{day.slice(0, 3)}</span>
                        <div className="flex-1 h-6 bg-surface-container-low rounded-full overflow-hidden">
                          <div
                            className="h-full bg-primary rounded-full transition-all duration-500"
                            style={{ width: `${Math.min((s.study / result.recommended_hours) * result.study_days * 100, 100)}%` }}
                          />
                        </div>
                        <span className="text-xs font-bold text-on-surface w-10 text-right flex-shrink-0">{s.study}h</span>
                      </div>
                    );
                  })}
                </div>
              </Card>

              {/* Generate timetable */}
              <Card className="p-5">
                <h3 className="font-headline text-base font-bold text-on-background mb-3">Generate Timetable</h3>
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <label className="text-sm font-semibold text-on-surface-variant">Select Note</label>
                    <select
                      value={selectedNote}
                      onChange={(e) => setSelectedNote(e.target.value)}
                      className="w-full px-4 py-3 bg-surface-container-low border-none rounded-xl focus:ring-2 focus:ring-primary/30 text-sm appearance-none"
                    >
                      <option value="">Choose a note…</option>
                      {notes.map((n) => (
                        <option key={n.note_id} value={n.note_id}>{n.filename} — {n.topic}</option>
                      ))}
                    </select>
                  </div>
                  <button
                    onClick={generateTimetable}
                    disabled={!selectedNote || generating}
                    className="w-full py-3.5 bg-secondary text-on-secondary rounded-xl font-bold text-sm hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                  >
                    {generating ? <Spinner size={18} /> : <span className="material-symbols-outlined text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>calendar_add_on</span>}
                    {generating ? "Generating…" : "Generate Timetable"}
                  </button>
                </div>
              </Card>
            </>
          )}

          {!result && !mlUnavailable && (
            <div className="h-full flex flex-col items-center justify-center py-20 rounded-2xl border border-dashed border-outline-variant/30 text-center">
              <span className="material-symbols-outlined text-5xl text-outline mb-4">insights</span>
              <p className="font-semibold text-on-surface-variant">Results will appear here</p>
              <p className="text-sm text-outline mt-1">Run the analysis to see AI recommendations</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
