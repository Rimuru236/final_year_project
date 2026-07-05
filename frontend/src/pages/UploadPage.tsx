import React, { useState, useRef, useEffect } from "react";
import { Spinner, Card, Badge } from "../components/UI";
import { useToast } from "../lib/contexts";
import { notesApi } from "../lib/api";
import type { Page, Note, NoteResponse, Section, GlossaryResponse } from "../types";


interface UploadPageProps {
  onNavigate: (page: Page) => void;
}

export function UploadPage({ onNavigate }: UploadPageProps) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [subject, setSubject] = useState("");
  const [topic, setTopic] = useState("");
  const [uploading, setUploading] = useState(false);
  const [segmenting, setSegmenting] = useState(false);
  // FIX: use NoteResponse (includes raw_text) for the upload result
  const [note, setNote] = useState<NoteResponse | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // D8: track previously uploaded notes to show Archived badge
  const [pastNotes, setPastNotes] = useState<Note[]>([]);
  // Feature 3: Glossary state
  const [glossary, setGlossary] = useState<GlossaryResponse | null>(null);
  const [generatingGlossary, setGeneratingGlossary] = useState(false);
  const [glossaryFilter, setGlossaryFilter] = useState("");

  useEffect(() => {
    notesApi.list().then((data: Note[]) => setPastNotes(data)).catch(() => {});
  }, []);

  // Load cached glossary when a note is available
  useEffect(() => {
    if (!note) { setGlossary(null); setGlossaryFilter(""); return; }
    notesApi.getGlossary(note.note_id)
      .then((data: GlossaryResponse) => {
        if (data.terms.length > 0) setGlossary(data);
      })
      .catch(() => { /* no cached glossary yet — that's fine */ });
  }, [note?.note_id]);

  // Computed value for filtered glossary terms
  const filteredGlossaryTerms = glossary
    ? glossary.terms
        .filter(t =>
          t.term.toLowerCase().includes(glossaryFilter.toLowerCase()) ||
          t.definition.toLowerCase().includes(glossaryFilter.toLowerCase())
        )
        .sort((a, b) => a.term.localeCompare(b.term))
    : [];

  const handleFile = (f: File) => {
    const allowed = [".pdf", ".docx", ".txt", ".md"];
    const ext = "." + (f.name.split(".").pop()?.toLowerCase() ?? "");
    if (!allowed.includes(ext)) {
      toast("Only PDF, DOCX, TXT and MD files are supported", "error");
      return;
    }
    setFile(f);
    if (!subject) {
      const name = f.name.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ");
      setSubject(name.charAt(0).toUpperCase() + name.slice(1));
    }
  };

  const upload = async () => {
    if (!file || !subject || !topic) {
      toast("Please fill in subject, topic, and select a file", "error");
      return;
    }
    setUploading(true);
    try {
      // FIX: backend auto-segments on upload — load sections immediately
      const data: NoteResponse = await notesApi.upload(file, subject, topic);
      setNote(data);
      setSections([]);
      toast("Notes uploaded! Loading sections…", "success");
      // Auto-load sections since backend segments on upload
      const segData = await notesApi.segment(data.note_id).catch(() => null);
      if (segData) {
        setSections(segData.sections ?? []);
        toast(`${segData.total_sections} sections identified`, "info");
      }
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setUploading(false);
    }
  };

  const segment = async () => {
    if (!note) return;
    setSegmenting(true);
    try {
      const data = await notesApi.segment(note.note_id);
      setSections(data.sections ?? []);
      toast(`${data.total_sections} sections identified`, "success");
      // Refresh past notes list so newly uploaded note appears
      notesApi.list().then((d: Note[]) => setPastNotes(d)).catch(() => {});
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setSegmenting(false);
    }
  };

  const reset = () => {
    setFile(null);
    setSubject("");
    setTopic("");
    setNote(null);
    setSections([]);
  };

  const handleGenerateGlossary = async () => {
    if (!note) return;
    setGeneratingGlossary(true);
    try {
      const data: GlossaryResponse = await notesApi.generateGlossary(note.note_id);
      setGlossary(data);
      toast(`${data.terms.length} terms extracted`, "success");
    } catch (e: any) {
      toast(e.message ?? "Glossary generation failed", "error");
    } finally {
      setGeneratingGlossary(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 lg:p-10 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="inline-flex items-center gap-2 mb-3 px-3 py-1.5 bg-primary-container/40 rounded-full">
          <span className="material-symbols-outlined text-sm text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>upload_file</span>
          <span className="text-xs font-bold text-on-primary-container uppercase tracking-widest">Upload Notes</span>
        </div>
        <h1 className="font-headline text-3xl font-extrabold text-on-background tracking-tight mb-2">Study Materials</h1>
        <p className="text-on-surface-variant">Upload your notes and we'll segment them intelligently using AI.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Upload form */}
        <div className="space-y-4">
          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            onClick={() => fileRef.current?.click()}
            className={`relative rounded-2xl border-2 border-dashed cursor-pointer transition-all duration-200 p-10 text-center ${dragging ? "border-primary bg-primary-container/20 scale-[1.01]" : "border-outline-variant/40 hover:border-primary/40 hover:bg-surface-container-low"}`}
          >
            <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
            {file ? (
              <div className="flex flex-col items-center gap-3">
                <div className="w-14 h-14 rounded-2xl bg-primary-container flex items-center justify-center">
                  <span className="material-symbols-outlined text-2xl text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>description</span>
                </div>
                <div>
                  <p className="font-bold text-on-surface text-sm">{file.name}</p>
                  <p className="text-xs text-on-surface-variant mt-1">{(file.size / 1024).toFixed(0)} KB · Click to change</p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4">
                <div className="w-16 h-16 rounded-2xl bg-surface-container-high flex items-center justify-center">
                  <span className="material-symbols-outlined text-3xl text-on-surface-variant">cloud_upload</span>
                </div>
                <div>
                  <p className="font-bold text-on-surface">Drop your file here</p>
                  <p className="text-sm text-on-surface-variant mt-1">or click to browse</p>
                  <p className="text-xs text-outline mt-2">PDF, DOCX, TXT, MD · Max 10 MB</p>
                </div>
              </div>
            )}
          </div>

          {/* Subject & Topic */}
          {[
            { label: "Subject", value: subject, setter: setSubject, placeholder: "e.g. Mathematics", icon: "subject" },
            { label: "Topic",   value: topic,   setter: setTopic,   placeholder: "e.g. Differential Equations", icon: "tag" },
          ].map(({ label, value, setter, placeholder, icon }) => (
            <div key={label} className="space-y-1.5">
              <label className="text-sm font-semibold text-on-surface-variant ml-1">{label}</label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline text-xl">{icon}</span>
                <input type="text" value={value} onChange={(e) => setter(e.target.value)} placeholder={placeholder} className="w-full pl-12 pr-4 py-3.5 bg-surface-container-low border-none rounded-xl focus:ring-2 focus:ring-primary/30 transition-all text-sm text-on-surface" />
              </div>
            </div>
          ))}

          {/* Action buttons */}
          <div className="flex gap-3">
            <button
              onClick={upload}
              disabled={!file || !subject || !topic || uploading}
              className="flex-1 py-3.5 bg-primary text-on-primary rounded-xl font-bold text-sm shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
            >
              {uploading ? <Spinner size={18} /> : <span className="material-symbols-outlined text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>upload</span>}
              {uploading ? "Uploading…" : "Upload Notes"}
            </button>
            {note && (
              <button
                onClick={segment}
                disabled={segmenting}
                className="px-5 py-3.5 bg-secondary-container text-on-secondary-container rounded-xl font-bold text-sm hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 transition-all flex items-center justify-center gap-2"
              >
                {segmenting ? <Spinner size={18} /> : <span className="material-symbols-outlined text-xl">auto_awesome</span>}
                Re-segment
              </button>
            )}
          </div>

          {note && (
            <button onClick={reset} className="w-full py-3 text-sm font-semibold text-on-surface-variant hover:text-on-surface border border-outline-variant/30 rounded-xl hover:bg-surface-container transition-all">
              Upload another note
            </button>
          )}
        </div>

        {/* Right: Sections preview */}
        <div>
          {!note && (
            <div className="h-full flex flex-col items-center justify-center py-20 text-center rounded-2xl border border-dashed border-outline-variant/30">
              <span className="material-symbols-outlined text-5xl text-outline mb-4">auto_stories</span>
              <p className="font-semibold text-on-surface-variant">Sections will appear here</p>
              <p className="text-sm text-outline mt-1">Upload a note to see AI-generated segments</p>
            </div>
          )}

          {note && sections.length === 0 && (
            <div className="space-y-4">
              <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-2xl flex items-center gap-3">
                <span className="material-symbols-outlined text-emerald-500" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                <div>
                  <p className="font-bold text-emerald-800 text-sm">Uploaded: {note.filename}</p>
                  <p className="text-xs text-emerald-700">{note.subject} · {note.topic}</p>
                </div>
              </div>
              <button onClick={segment} disabled={segmenting} className="w-full py-3.5 bg-primary text-on-primary rounded-xl font-bold text-sm flex items-center justify-center gap-2 hover:scale-[1.02] transition-all disabled:opacity-50">
                {segmenting ? <Spinner size={18} /> : <span className="material-symbols-outlined text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>}
                {segmenting ? "Segmenting…" : "Segment Notes"}
              </button>
            </div>
          )}

          {sections.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-headline text-base font-bold text-on-background">
                  {sections.length} Sections Found
                </h3>
                <button
                  onClick={() => onNavigate("analysis")}
                  className="text-sm font-bold text-primary hover:text-primary-dim transition-colors flex items-center gap-1"
                >
                  Run Analysis <span className="material-symbols-outlined text-lg">arrow_forward</span>
                </button>
              </div>
              <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
                {sections.map((s, i) => (
                  <Card key={s.section_id} className="p-4">
                    <div className="flex items-start gap-3">
                      <span className="text-xs font-black text-primary bg-primary-container/50 rounded-lg px-2 py-1 flex-shrink-0">
                        §{i + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-sm text-on-surface leading-tight">{s.title}</p>
                        <div className="flex items-center gap-3 mt-1.5">
                          <Badge variant="neutral">{s.word_count} words</Badge>
                          <span className="text-xs text-outline">{s.estimated_read_time} min read</span>
                        </div>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Feature 3: Glossary panel */}
          {note && (
            <div className="mt-8 space-y-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>
                    menu_book
                  </span>
                  <h3 className="font-headline text-base font-bold text-on-background">Key Terms Glossary</h3>
                  {glossary && <Badge variant="neutral">{glossary.terms.length} terms</Badge>}
                </div>
                <button
                  onClick={handleGenerateGlossary}
                  disabled={generatingGlossary}
                  className="flex items-center gap-2 px-5 py-2 bg-primary text-on-primary rounded-full text-sm font-bold hover:scale-[1.02] disabled:opacity-50 transition-all"
                >
                  {generatingGlossary
                    ? <Spinner size={16} />
                    : <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
                  }
                  {glossary && glossary.terms.length > 0 ? "Regenerate" : "Generate Glossary"}
                </button>
              </div>

              {/* Search filter */}
              {glossary && glossary.terms.length > 0 && (
                <>
                  <div className="relative">
                    <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-xl">search</span>
                    <input
                      type="text"
                      value={glossaryFilter}
                      onChange={e => setGlossaryFilter(e.target.value)}
                      placeholder="Search terms…"
                      className="w-full pl-10 pr-4 py-2.5 bg-surface-container-low rounded-xl text-sm border-none focus:ring-2 focus:ring-primary/30 transition-all"
                    />
                  </div>

                  {/* Alphabetical term list */}
                  <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                    {filteredGlossaryTerms.map((t, i) => (
                      <Card key={i} className="p-3">
                        <p className="font-bold text-sm text-on-background">{t.term}</p>
                        <p className="text-xs text-on-surface-variant mt-1 leading-relaxed">{t.definition}</p>
                      </Card>
                    ))}
                    {filteredGlossaryTerms.length === 0 && glossaryFilter && (
                      <p className="text-sm text-on-surface-variant text-center py-4">
                        No terms match "{glossaryFilter}"
                      </p>
                    )}
                  </div>
                </>
              )}

              {!glossary || glossary.terms.length === 0 && !generatingGlossary && (
                <p className="text-sm text-on-surface-variant">
                  Click "Generate Glossary" to extract key terms from this note using AI.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
      {/* D8: Past notes list with Archived badge ─────────────────────── */}
      {pastNotes.length > 0 && (
        <div className="mt-10 space-y-3">
          <h3 className="font-headline text-base font-bold text-on-background">Your Uploaded Notes</h3>
          <div className="space-y-2">
            {pastNotes.map((n) => (
              <Card key={n.note_id} className="p-4">
                <div className="flex items-center gap-3">
                  <span
                    className={`material-symbols-outlined text-xl ${n.content_archived ? "text-outline" : "text-primary"}`}
                    style={{ fontVariationSettings: "'FILL' 1" }}
                  >
                    {n.content_archived ? "inventory_2" : "description"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-on-surface truncate">{n.filename}</p>
                    <p className="text-xs text-on-surface-variant">{n.subject} · {n.topic}</p>
                  </div>
                  {n.content_archived ? (
                    <Badge variant="neutral">
                      <span className="material-symbols-outlined text-xs" style={{ fontVariationSettings: "'FILL' 1" }}>archive</span>
                      {" "}Archived
                    </Badge>
                  ) : (
                    <Badge variant="success">Active</Badge>
                  )}
                </div>
                {n.content_archived && n.archived_at && (
                  <p className="text-xs text-on-surface-variant mt-1.5 pl-9">
                    Content archived {new Date(n.archived_at).toLocaleDateString()} — re-upload to restore quiz access.
                  </p>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
