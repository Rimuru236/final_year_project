# Cognitive Sanctuary — Move Topic Mastery Into Daily Breakdown (Per-Day Tap)

## Context & Problem

The Topic Mastery dashboard (added by `html-features-integration.md`, Feature 4) currently renders as its own large `<Card>` at the top of `ReportPage.tsx`, directly above the Overall Score / Improvement / Total Attempts / Week stat row. With many sections (the screenshot shows 200 "Total Sections"), this card produces a long grid of section tiles that pushes all other content far down the page and makes the Progress tab feel cluttered and repetitive before the user even reaches their actual weekly metrics.

**The fix:** Remove the standalone Topic Mastery card entirely. Instead, make each day tile inside the existing **Daily Breakdown** section tappable — tapping a day (e.g. "Monday") expands an inline panel directly under that day's tile showing the mastery breakdown **for sections studied on that specific day only**. This keeps the Progress page short and scannable, while still giving the user access to the same mastery insight, scoped per day.

Read the files listed below in full before writing any code. This is a restructuring task — you are moving and adapting existing UI, not building net-new backend functionality (though one new backend filter is required, described in Feature 1 below).

---

## Stack (do not assume anything different)

**Backend** — `backend/app/`
- FastAPI (Python 3.11), fully async, MongoDB via Motor
- The mastery endpoint already exists: `GET /progress/mastery/{timetable_id}` in `backend/app/routers/progress.py`, returning a `MasteryReport` (see `backend/app/schemas.py` for `SectionMastery` / `MasteryReport` models)
- The weekly report endpoint already exists: `GET /progress/report/{timetable_id}` in the same file, returning `WeeklyReport` with `daily_breakdown: dict[str, DayProgress]`

**Frontend** — `frontend/src/`
- React 18 + TypeScript (strict) + Vite 5 + Tailwind 3
- The page to modify is `frontend/src/pages/ReportPage.tsx`
- Shared primitives only: `Spinner`, `Badge`, `Card`, `Toggle` in `src/components/UI.tsx`
- Icons: Material Symbols Outlined, filled via `style={{ fontVariationSettings: "'FILL' 1" }}`
- Existing types: `DayProgress`, `MasteryReport`, `SectionMastery` already exist in `src/types.ts`
- Existing API helpers: `progressApi.report()` and `progressApi.mastery()` already exist in `src/lib/api.ts`

---

## Non-negotiable constraints

1. **Read before writing.** Open and read `ReportPage.tsx`, `progress.py`, and `schemas.py` in full before touching anything.
2. **Do not remove the Daily Breakdown section itself** — only change how it renders and add the new tap-to-expand behaviour.
3. **Do not change any existing backend response shape that other pages depend on.** `WeeklyReport` and `MasteryReport` are also potentially used elsewhere — check for other callers before changing field types.
4. **No new UI libraries.** Use only `Card`, `Badge`, `Spinner`, `Toggle`, and Tailwind classes already in the project.
5. **Responsive from the start.** The day tiles already use `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4` — preserve this, and make sure the expanded per-day panel reflows correctly at 360px width (single column).
6. **TypeScript strict.** No `any` types. Extend interfaces, don't replace them.
7. **One day expanded at a time.** Tapping a second day collapses the first (accordion behaviour, not multi-expand) — this is what keeps the page from becoming long again.

---

## Files to read before starting

```
backend/app/routers/progress.py          # weekly_report() and section_mastery() — both your working endpoints
backend/app/schemas.py                   # WeeklyReport, DayProgress, MasteryReport, SectionMastery
frontend/src/pages/ReportPage.tsx        # the page you are restructuring — read in full
frontend/src/types.ts                    # DayProgress, MasteryReport, SectionMastery interfaces
frontend/src/lib/api.ts                  # progressApi.report, progressApi.mastery
frontend/src/components/UI.tsx           # Card, Badge, Spinner — use only these
```

---

## What currently exists (for reference — do not assume this is wrong, just understand it)

In `ReportPage.tsx`, the render order is currently:

1. Header + timetable selector
2. **Topic Mastery card** (large — stat row, recommendation zones, full section grid) ← **this is being removed from here**
3. Overall Score / Improvement / Total Attempts / Week stat row
4. Section Performance list
5. **Daily Breakdown** — a grid of day tiles (Monday, Tuesday, etc.), each showing average score and `attempted_count/section_count` ← **the new tap behaviour goes here**
6. RL Adaptation Log

The `MasteryReport` returned by `GET /progress/mastery/{timetable_id}` currently has **no day-level grouping** — it only groups by classification (`solid`/`shaky`/`revise`/`untouched`) across the *whole timetable*, not per individual day. This needs a small backend addition (Feature 1) before the frontend can filter by day.

---

## Feature 1 — Backend: Add Day-Scoped Section IDs to MasteryReport

**What it does:** Lets the frontend know which `section_id`s belong to which weekday, so it can filter the already-fetched `MasteryReport` data to "sections studied on Monday" without a new network call per day-tap.

**File to modify:** `backend/app/schemas.py`

Add one field to the existing `MasteryReport` model — **do not remove or rename any existing field**:

```python
class MasteryReport(BaseModel):
    timetable_id:   str
    solid:   list[SectionMastery]
    shaky:   list[SectionMastery]
    revise:  list[SectionMastery]
    untouched: list[SectionMastery]
    total_sections: int
    overall_mastery_pct: Optional[float]
    # NEW — maps day name -> list of section_ids scheduled on that day.
    # Lets the frontend filter the four classification lists above by day
    # without an additional API call.
    sections_by_day: dict[str, list[str]] = {}
```

**File to modify:** `backend/app/routers/progress.py`, inside `section_mastery()` (the handler for `GET /progress/mastery/{timetable_id}`)

Read the function fully first. It already fetches the timetable document and iterates over `timetable["days"]` to collect `section_id`s. Reuse that same loop (or add a small additional pass over `timetable["days"].items()`) to build:

```python
sections_by_day: dict[str, list[str]] = {
    day_name: [slot["section_id"] for slot in day_slots]
    for day_name, day_slots in timetable["days"].items()
    if day_slots  # skip empty days
}
```

Include `sections_by_day=sections_by_day` in the `MasteryReport(...)` return statement at the end of the function — this is the only change to the return value; every other field stays exactly as it is now.

**Verification for this feature:** `GET /progress/mastery/{timetable_id}` still returns all existing fields unchanged, plus the new `sections_by_day` dict. Existing callers of this endpoint (the Smart Drill panel on `TimetablePage.tsx`, if implemented) must continue to work without modification, since this is a purely additive field.

---

## Feature 2 — Frontend: Remove Standalone Topic Mastery Card

**File to modify:** `frontend/src/pages/ReportPage.tsx`

Find and **delete** the entire Topic Mastery `<Card>` block — the one that currently renders directly after the timetable selector and before the Overall Score / Improvement / Total Attempts / Week stat row. This is the large card containing:
- The "Topic Mastery" header with the overall percentage in the top-right
- The 4-stat row (Total Sections / Solid / Shaky / Revise)
- The coloured recommendation zones ("Consolidate these:", "Revise these now:", "Strong performance:")
- The per-section grid with progress bars

Delete this block in its entirety. Do **not** delete the `masteryReport` state variable or the `useEffect` that fetches it via `progressApi.mastery(selectedId)` — that data is still needed, just rendered in a different place (see Feature 3).

After this change, the page order should be:

1. Header + timetable selector
2. Overall Score / Improvement / Total Attempts / Week stat row
3. Section Performance list
4. Daily Breakdown (modified in Feature 3)
5. RL Adaptation Log

---

## Feature 3 — Frontend: Tappable Day Tiles with Inline Mastery Panel

**File to modify:** `frontend/src/pages/ReportPage.tsx`

This replaces the current static Daily Breakdown grid (where day tiles are plain, non-interactive `<div>`s) with tappable tiles that expand an inline mastery panel scoped to that day's sections.

### State to add

```typescript
const [expandedDay, setExpandedDay] = useState<string | null>(null);
```

Accordion behaviour: tapping a day that is already expanded collapses it (`setExpandedDay(null)`); tapping a different day switches the expansion to that day.

### Helper — derive a day's mastery sections from the existing `masteryReport`

Add this as a plain function inside the component (not a hook, just a computed lookup) — it filters the four classification arrays already present in `masteryReport` down to only the sections scheduled on the given day, using the new `sections_by_day` field from Feature 1:

```typescript
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
```

### Replace the Daily Breakdown grid rendering

Find the existing block (currently a `<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">` mapping over `Object.values(report.daily_breakdown)`). Replace the day-tile rendering so that:

1. Each tile becomes a `<button>` (or a `<div>` with `onClick` + `role="button"` + `tabIndex={0}` if you prefer to keep the existing tile markup) that toggles `expandedDay`.
2. A small chevron icon indicates expand/collapse state.
3. When a day is expanded, render an inline panel **directly below that day's row** (not below the whole grid) containing that day's mastery sections.

Because the grid is multi-column (`grid-cols-2 sm:grid-cols-3 lg:grid-cols-4`), the expanded panel must span the full row width regardless of which column the tapped tile is in. The simplest correct approach: render the day tiles as normal grid items, and render the expanded panel as a **separate full-width block placed immediately after the grid**, conditionally shown based on `expandedDay`. This avoids broken grid layouts when a tile in the middle of a row is tapped.

```tsx
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
```

### Important behavioural notes

- Days with **no sections in `masteryReport.sections_by_day`** (i.e., `hasMasteryData === false`) render as non-interactive tiles — no chevron, no hover effect, `disabled` on the button. This typically means the timetable has no slots scheduled for that day at all.
- Days with sections but zero quiz attempts still expand — they just show sections with `classification: "untouched"` and `"No data yet"` mastery text, which is correct and expected.
- `getDayMasterySections` reads from `masteryReport`, which is fetched once per timetable selection (already existing logic) — tapping a day does **not** trigger a new network request. This is the entire point of Feature 1's `sections_by_day` field.

---

## Feature 4 — Update TypeScript Types

**File to modify:** `frontend/src/types.ts`

Find the existing `MasteryReport` interface and add the one new field — do not remove or rename anything else:

```typescript
export interface MasteryReport {
  timetable_id: string;
  solid: SectionMastery[];
  shaky: SectionMastery[];
  revise: SectionMastery[];
  untouched: SectionMastery[];
  total_sections: number;
  overall_mastery_pct: number | null;
  // NEW — maps day name to the section_ids scheduled on that day
  sections_by_day: Record<string, string[]>;
}
```

---

## Verification checklist

After completing all changes, confirm the following before finishing:

- [ ] `python -c "from app.schemas import MasteryReport; m = MasteryReport(timetable_id='x', solid=[], shaky=[], revise=[], untouched=[], total_sections=0, overall_mastery_pct=None); print(m.sections_by_day)"` runs from `backend/` and prints `{}`
- [ ] `GET /progress/mastery/{timetable_id}` response includes `sections_by_day` as a dict of day names to section ID arrays
- [ ] The standalone Topic Mastery card (with the 4-stat row, recommendation zones, and full section grid) no longer appears above the Overall Score row in `ReportPage.tsx`
- [ ] The Overall Score / Improvement / Total Attempts / Week stat row is now the **first** content block after the timetable selector
- [ ] Daily Breakdown day tiles are clickable buttons with a chevron icon that rotates on expand
- [ ] Tapping a day with scheduled sections expands a panel directly below the grid showing that day's mastery sections only
- [ ] Tapping the same day again collapses the panel (accordion — only one day open at a time)
- [ ] Tapping a different day while one is already open switches the expansion (does not show two panels at once)
- [ ] Days with no sections scheduled (not present in `sections_by_day`) are visually non-interactive (no chevron, `disabled`, reduced opacity) and do not respond to clicks
- [ ] `src/types.ts`'s `MasteryReport` interface has the new `sections_by_day` field
- [ ] No existing fields were removed from `MasteryReport`, `WeeklyReport`, `DayProgress`, or `SectionMastery` on either backend or frontend
- [ ] Page works correctly at 360px width — the expanded panel's `grid-cols-1 sm:grid-cols-2` collapses to one column on narrow screens
- [ ] `masteryReport` state and its `useEffect` fetch in `ReportPage.tsx` are still present — only the rendering location of that data changed, not the data-fetching logic

---

## Order of implementation

1. `backend/app/schemas.py` — add `sections_by_day` field to `MasteryReport`
2. `backend/app/routers/progress.py` — populate `sections_by_day` in `section_mastery()`
3. `frontend/src/types.ts` — add `sections_by_day` to the `MasteryReport` interface
4. `frontend/src/pages/ReportPage.tsx` — delete the standalone Topic Mastery card (Feature 2)
5. `frontend/src/pages/ReportPage.tsx` — add `expandedDay` state and `getDayMasterySections` helper
6. `frontend/src/pages/ReportPage.tsx` — replace the Daily Breakdown grid with tappable tiles + expanded panel (Feature 3)