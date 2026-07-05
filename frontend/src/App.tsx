import React, { useEffect, useState, useCallback } from "react";
import { AuthProvider, ToastProvider, useAuth } from "./lib/contexts";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Sidebar, TopBar } from "./components/UI";
import { LoginPage, SignupPage } from "./pages/AuthPages";
import { DashboardPage } from "./pages/DashboardPage";
import { UploadPage } from "./pages/UploadPage";
import { AnalysisPage } from "./pages/AnalysisPage";
import { TimetablePage } from "./pages/TimetablePage";
import { ReportPage } from "./pages/ReportPage";
import { AIAssistantPage } from "./pages/AIAssistantPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { SettingsPage } from "./pages/SettingsPage";
import { authApi } from "./lib/api";
import type { Page, PredictResult } from "./types";

// ── Authenticated shell ───────────────────────────────────────────────────────
// Wraps all protected pages with the sidebar/topbar layout.

function AppShell({
  page,
  onNavigate,
  activeTimetableId,
  onTimetableGenerated,
  onPredictResult,
  lastPredictResult,
}: {
  page: Page;
  onNavigate: (p: Page) => void;
  activeTimetableId: string | null;
  onTimetableGenerated: (id: string) => void;
  onPredictResult: (r: PredictResult) => void;
  lastPredictResult: PredictResult | null;
}) {
  const renderPage = () => {
    switch (page) {
      case "dashboard":
        return <DashboardPage onNavigate={onNavigate} />;
      case "upload":
        return <UploadPage onNavigate={onNavigate} />;
      case "analysis":
        return (
          <AnalysisPage
            onNavigate={onNavigate}
            onTimetableGenerated={onTimetableGenerated}
            onPredictResult={onPredictResult}
          />
        );
      case "timetable":
        return (
          <TimetablePage
            activeTimetableId={activeTimetableId}
            onNavigate={onNavigate}
          />
        );
      case "report":
        return (
          <ReportPage
            activeTimetableId={activeTimetableId}
            onNavigate={onNavigate}
          />
        );
      case "ai-assistant":
        return <AIAssistantPage onNavigate={onNavigate} />;
      case "schedule":
        return <OnboardingPage />;
      case "settings":
        return <SettingsPage />;
      default:
        return <DashboardPage onNavigate={onNavigate} />;
    }
  };

  return (
    <div className="flex min-h-screen bg-background">
      {/* Fixed sidebar (desktop) */}
      <Sidebar currentPage={page} onNavigate={onNavigate} />

      {/* Main content — offset by sidebar width on desktop */}
      <div className="flex-1 lg:ml-64 flex flex-col min-h-screen overflow-x-hidden">
        {/* Mobile top bar */}
        <TopBar currentPage={page} onNavigate={onNavigate} />

        {/* Page content */}
        <main className="flex-1 overflow-auto overflow-x-hidden min-w-0">
          <ErrorBoundary key={page}>
            {renderPage()}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

// ── Auth-aware router ─────────────────────────────────────────────────────────

function AuthRouter() {
  const { user, setUser } = useAuth();
  const [page, setPage] = useState<Page>("login");
  const [sessionChecked, setSessionChecked] = useState(false);
  const [activeTimetableId, setActiveTimetableId] = useState<string | null>(null);
  const [lastPredictResult, setLastPredictResult] = useState<PredictResult | null>(null);

  // On mount: try to restore session from httpOnly cookies via /auth/me
  useEffect(() => {
    authApi.me()
      .then((data) => {
        setUser(data);
        setPage("dashboard");
      })
      .catch(() => {
        // No valid session — stay on login
      })
      .finally(() => setSessionChecked(true));
  }, []);

  const handleLogout = useCallback(() => {
    setPage("login");
    setActiveTimetableId(null);
    setLastPredictResult(null);
  }, []);

  const handleNavigate = useCallback((p: Page) => {
    setPage(p);
  }, []);

  const handleTimetableGenerated = useCallback((id: string) => {
    setActiveTimetableId(id);
  }, []);

  const handlePredictResult = useCallback((r: PredictResult) => {
    setLastPredictResult(r);
  }, []);

  // Show nothing until session check completes — prevents login flash
  if (!sessionChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary to-indigo-700 flex items-center justify-center mx-auto mb-4 shadow-xl shadow-primary/20">
            <span className="material-symbols-outlined text-white text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>psychology</span>
          </div>
          <p className="text-sm font-semibold text-on-surface-variant">Loading Cognitive Sanctuary…</p>
        </div>
      </div>
    );
  }

  // Auth pages (no sidebar)
  if (!user || page === "login" || page === "signup") {
    if (page === "signup") return <SignupPage setPage={setPage} />;
    return <LoginPage setPage={setPage} />;
  }

  // Protected pages
  return (
    <AppShell
      page={page}
      onNavigate={handleNavigate}
      activeTimetableId={activeTimetableId}
      onTimetableGenerated={handleTimetableGenerated}
      onPredictResult={handlePredictResult}
      lastPredictResult={lastPredictResult}
    />
  );
}

// ── Root App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [loggedOut, setLoggedOut] = useState(false); // trigger re-mount of AuthRouter on logout

  return (
    <ErrorBoundary>
      <ToastProvider>
        <AuthProvider onLogout={() => setLoggedOut((v) => !v)}>
          <AuthRouter key={String(loggedOut)} />
        </AuthProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}
