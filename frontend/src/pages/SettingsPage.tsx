import React, { useState, useEffect, useRef } from "react";
import { Card, Spinner, Badge, Toggle } from "../components/UI";
import { useToast, useAuth } from "../lib/contexts";
import { settingsApi, twofaApi } from "../lib/api";
import { useTheme } from "../lib/useTheme";
import type { SettingsData, SessionItem, StreakData, ActivityEntry, DisplayPrefs, StudyPrefs } from "../types";

// ── Section header helper ─────────────────────────────────────────────────────
function SectionHeader({ icon, title, subtitle }: { icon: string; title: string; subtitle?: string }) {
  return (
    <div className="flex items-center gap-3 mb-5">
      <div className="w-10 h-10 rounded-xl bg-primary-container flex items-center justify-center flex-shrink-0">
        <span className="material-symbols-outlined text-xl text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>
          {icon}
        </span>
      </div>
      <div>
        <h2 className="font-headline text-base font-bold text-on-background">{title}</h2>
        {subtitle && <p className="text-xs text-on-surface-variant">{subtitle}</p>}
      </div>
    </div>
  );
}

// ── Labelled row for toggle settings ─────────────────────────────────────────
function ToggleRow({
  label, description, checked, onChange, disabled,
}: {
  label: string; description?: string; checked: boolean;
  onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <div className="flex items-start sm:items-center justify-between gap-4 py-3 border-b border-outline-variant/10 last:border-0">
      <div>
        <p className="text-sm font-semibold text-on-surface">{label}</p>
        {description && <p className="text-xs text-on-surface-variant mt-0.5">{description}</p>}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} label={label} />
    </div>
  );
}

// ── Main Settings Page ────────────────────────────────────────────────────────
export function SettingsPage() {
  const toast = useToast();
  const { user, setUser, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [loading, setLoading]   = useState(true);

  // Profile form
  const [name,  setName]  = useState("");
  const [level, setLevel] = useState("Undergraduate");
  const [savingProfile, setSavingProfile] = useState(false);

  // Password form
  const [currentPw, setCurrentPw]  = useState("");
  const [newPw,     setNewPw]       = useState("");
  const [confirmPw, setConfirmPw]   = useState("");
  const [showPw,    setShowPw]      = useState(false);
  const [savingPw,  setSavingPw]    = useState(false);

  // Study prefs
  const [sessionLen,  setSessionLen]  = useState(1.5);
  const [breakRatio,  setBreakRatio]  = useState(0.22);
  const [savingStudy, setSavingStudy] = useState(false);

  // Notification prefs
  const [notifEvents, setNotifEvents] = useState<Set<string>>(new Set());
  const [savingNotif, setSavingNotif] = useState(false);

  // Delete confirm
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting,      setDeleting]      = useState(false);

  // D7: 2FA enrollment state
  const [enrolling,   setEnrolling]   = useState(false);
  const [qrUri,       setQrUri]       = useState<string | null>(null);
  const [enrollSecret, setEnrollSecret] = useState<string | null>(null);
  const [enableCode,  setEnableCode]  = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [showDisable, setShowDisable] = useState(false);

  // Feature 1: Session Management
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);

  // Feature 2: Study Streak
  const [streak, setStreak] = useState<StreakData | null>(null);

  // Feature 3: Email Change
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [emailConfirmPw, setEmailConfirmPw] = useState("");
  const [savingEmail, setSavingEmail] = useState(false);

  // Feature 4: Activity Log
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [showActivity, setShowActivity] = useState(false);
  const [loadingActivity, setLoadingActivity] = useState(false);

  // Feature 5: Timezone & Locale
  const [timezone, setTimezone] = useState("UTC");
  const [locale, setLocale] = useState("en-GB");

  // Feature 6: Display Preferences
  const [displayPrefs, setDisplayPrefs] = useState<DisplayPrefs | null>(null);
  const [savingDisplay, setSavingDisplay] = useState(false);

  // Feature 7 & 8: Extended Study Preferences
  const [defaultMcqCount, setDefaultMcqCount] = useState(5);
  const [defaultMcqDifficulty, setDefaultMcqDifficulty] = useState("medium");
  const [archiveAfterDays, setArchiveAfterDays] = useState(30);

  useEffect(() => {
    settingsApi.get()
      .then((data: SettingsData) => {
        setSettings(data);
        setName(data.name);
        setLevel(data.level);
        setSessionLen(data.default_session_length ?? 1.5);
        setBreakRatio(data.default_break_ratio   ?? 0.22);
        setNotifEvents(new Set(data.notification_prefs));
        setTimezone(data.timezone ?? "UTC");
        setLocale(data.locale ?? "en-GB");
        // Apply server-persisted theme on load
        if (data.theme && data.theme !== theme) {
          setTheme(data.theme);
        }
      })
      .catch(() => toast("Could not load settings", "error"))
      .finally(() => setLoading(false));

    // Load streak data
    settingsApi.getStreak()
      .then((data: StreakData) => setStreak(data))
      .catch(() => console.error("Failed to load streak"));

    // Load display preferences
    settingsApi.getDisplayPrefs()
      .then((data: DisplayPrefs) => setDisplayPrefs(data))
      .catch(() => console.error("Failed to load display prefs"));

    // Load study preferences (for Features 7 & 8)
    settingsApi.getStudyPrefs()
      .then((data: StudyPrefs) => {
        setDefaultMcqCount(data.default_mcq_count ?? 5);
        setDefaultMcqDifficulty(data.default_mcq_difficulty ?? "medium");
        setArchiveAfterDays(data.archive_after_days ?? 30);
      })
      .catch(() => console.error("Failed to load study prefs"));

    // Load sessions
    setLoadingSessions(true);
    settingsApi.getSessions()
      .then((data: SessionItem[]) => setSessions(data))
      .catch(() => console.error("Failed to load sessions"))
      .finally(() => setLoadingSessions(false));
  }, []);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleSaveProfile = async () => {
    setSavingProfile(true);
    try {
      const data = await settingsApi.patch({ name, level, timezone, locale });
      setSettings(data);
      if (user) setUser({ ...user, name: data.name, level: data.level, avatar_b64: data.avatar_b64 });
      toast("Profile updated", "success");
    } catch (e: any) { toast(e.message, "error"); }
    finally { setSavingProfile(false); }
  };

  const handleRevokeSession = async (sessionId: string) => {
    try {
      await settingsApi.revokeSession(sessionId);
      setSessions(prev => prev.filter(s => s.session_id !== sessionId));
      toast("Session revoked", "success");
    } catch (e: any) { toast(e.message, "error"); }
  };

  const handleRevokeOtherSessions = async () => {
    try {
      await settingsApi.revokeOtherSessions();
      setSessions(prev => prev.filter(s => s.is_current));
      toast("Other sessions revoked", "success");
    } catch (e: any) { toast(e.message, "error"); }
  };

  const handleChangeEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingEmail(true);
    try {
      const data = await settingsApi.changeEmail({ new_email: newEmail, current_password: emailConfirmPw });
      setSettings(s => s ? { ...s, email: data.new_email } : s);
      setShowEmailForm(false);
      setNewEmail("");
      setEmailConfirmPw("");
      toast("Email updated successfully", "success");
    } catch (e: any) { toast(e.message, "error"); }
    finally { setSavingEmail(false); }
  };

  const handleLoadActivity = async () => {
    if (showActivity && activity.length === 0) {
      setLoadingActivity(true);
      try {
        const data = await settingsApi.getActivity();
        setActivity(data);
      } catch (e: any) { toast(e.message, "error"); }
      finally { setLoadingActivity(false); }
    }
    setShowActivity(!showActivity);
  };

  const handleSaveDisplayPrefs = async () => {
    setSavingDisplay(true);
    try {
      const data = await settingsApi.setDisplayPrefs(displayPrefs);
      setDisplayPrefs(data);
      toast("Display preferences saved", "success");
    } catch (e: any) { toast(e.message, "error"); }
    finally { setSavingDisplay(false); }
  };

  const handleDeleteAvatar = async () => {
    try {
      const data = await settingsApi.deleteAvatar();
      setSettings(data);
      if (user) setUser({ ...user, avatar_b64: null });
      toast("Profile picture removed", "success");
    } catch (e: any) { toast(e.message, "error"); }
  };

  const handleThemeToggle = async (dark: boolean) => {
    const t = dark ? "dark" : "light";
    setTheme(t);
    try { await settingsApi.setTheme(t); }
    catch { /* local toggle already applied; server sync is best-effort */ }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const data = await fetch("/settings/avatar", {
        method: "POST", credentials: "include", body: fd,
      }).then(r => { if (!r.ok) throw new Error("Upload failed"); return r.json(); });
      setSettings(data);
      if (user) setUser({ ...user, avatar_b64: data.avatar_b64 });
      toast("Profile picture updated", "success");
    } catch (e: any) { toast(e.message ?? "Upload failed", "error"); }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPw !== confirmPw) { toast("Passwords don't match", "error"); return; }
    setSavingPw(true);
    try {
      await settingsApi.changePassword({ current_password: currentPw, new_password: newPw });
      setCurrentPw(""); setNewPw(""); setConfirmPw("");
      toast("Password changed successfully", "success");
    } catch (e: any) { toast(e.message, "error"); }
    finally { setSavingPw(false); }
  };

  const handleSaveStudyPrefs = async () => {
    setSavingStudy(true);
    try {
      await settingsApi.setStudyPrefs({ 
        default_session_length: sessionLen, 
        default_break_ratio: breakRatio,
        default_mcq_count: defaultMcqCount,
        default_mcq_difficulty: defaultMcqDifficulty,
        archive_after_days: archiveAfterDays
      });
      toast("Study preferences saved", "success");
    } catch (e: any) { toast(e.message, "error"); }
    finally { setSavingStudy(false); }
  };

  const handleSaveNotifs = async () => {
    setSavingNotif(true);
    try {
      await settingsApi.setNotifPrefs(Array.from(notifEvents));
      toast("Notification preferences saved", "success");
    } catch (e: any) { toast(e.message, "error"); }
    finally { setSavingNotif(false); }
  };

  const handleEnroll = async () => {
    setEnrolling(true);
    try {
      const data = await twofaApi.enroll();
      setQrUri(data.qr_uri);
      setEnrollSecret(data.secret);
    } catch (e: any) { toast(e.message, "error"); }
    finally { setEnrolling(false); }
  };

  const handleEnable2FA = async () => {
    if (enableCode.length !== 6) { toast("Enter the 6-digit code", "error"); return; }
    try {
      await twofaApi.enable(enableCode);
      setSettings(s => s ? { ...s, two_factor_enabled: true } : s);
      setQrUri(null); setEnrollSecret(null); setEnableCode("");
      toast("Two-factor authentication enabled!", "success");
    } catch (e: any) { toast(e.message, "error"); }
  };

  const handleDisable2FA = async () => {
    if (disableCode.length !== 6) { toast("Enter your 6-digit code to confirm", "error"); return; }
    try {
      await twofaApi.disable(disableCode);
      setSettings(s => s ? { ...s, two_factor_enabled: false } : s);
      setDisableCode(""); setShowDisable(false);
      toast("Two-factor authentication disabled", "success");
    } catch (e: any) { toast(e.message, "error"); }
  };

  const handleExport = async () => {
    try {
      const data = await settingsApi.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = "cognitive-sanctuary-export.json"; a.click();
      URL.revokeObjectURL(url);
      toast("Data exported", "success");
    } catch (e: any) { toast(e.message, "error"); }
  };

  const handleDeleteAccount = async () => {
    if (!deleteConfirm) { setDeleteConfirm(true); return; }
    setDeleting(true);
    try {
      await settingsApi.deleteAccount();
      toast("Account deleted", "success");
      window.location.reload();
    } catch (e: any) { toast(e.message, "error"); setDeleting(false); }
  };

  const handleSignOut = async () => {
    try {
      await logout();
    } catch (e: any) {
      toast(e.message, "error");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Spinner size={32} />
      </div>
    );
  }

  const ALL_NOTIF_EVENTS = [
    { id: "account_created",    label: "Account & Security",    description: "Registration confirmations and security alerts" },
    { id: "password_changed",   label: "Password Changes",      description: "Notification when your password is updated" },
    { id: "day_sections_ready", label: "Study Reminders",       description: "When your daily study sections are ready" },
    { id: "weekly_digest",      label: "Weekly Digest",         description: "Summary of your progress every week" },
  ];

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-2xl mx-auto space-y-6 pb-12">
      {/* Page header */}
      <div className="space-y-1">
        <h1 className="font-headline text-2xl font-bold text-on-background">Settings</h1>
        <p className="text-sm text-on-surface-variant">Manage your account and study preferences.</p>
      </div>

      {/* ── D6-1: Profile ──────────────────────────────────────────────────── */}
      <Card className="p-6">
        <SectionHeader icon="person" title="Profile" subtitle="Your name and student level" />

        {/* D6-2: Avatar */}
        <div className="flex items-center gap-4 mb-5">
          <div
            className="w-16 h-16 rounded-2xl bg-primary-container flex items-center justify-center cursor-pointer overflow-hidden flex-shrink-0 hover:ring-2 hover:ring-primary/40 transition-all"
            onClick={() => avatarInputRef.current?.click()}
          >
            {settings?.avatar_b64 ? (
              <img src={settings.avatar_b64} alt="Avatar" className="w-full h-full object-cover" />
            ) : (
              <span className="text-2xl font-black text-primary">{name.charAt(0).toUpperCase() || "U"}</span>
            )}
          </div>
          <div>
            <button
              onClick={() => avatarInputRef.current?.click()}
              className="text-sm font-semibold text-primary hover:text-primary-dim transition-colors"
            >
              Change photo
            </button>
            <p className="text-xs text-on-surface-variant mt-0.5">PNG, JPG, WEBP · max 2 MB</p>
            {settings?.avatar_b64 && (
              <button
                onClick={handleDeleteAvatar}
                className="text-sm text-error hover:text-red-700 transition-colors mt-1"
              >
                Remove photo
              </button>
            )}
          </div>
          <input
            ref={avatarInputRef} type="file"
            accept=".png,.jpg,.jpeg,.webp,.gif"
            onChange={handleAvatarUpload}
            className="hidden"
          />
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide">Full name</label>
            <div className="relative">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-xl">person</span>
              <input
                value={name} onChange={e => setName(e.target.value)}
                className="w-full pl-10 pr-4 py-3 bg-surface-container-low rounded-xl text-sm border-none focus:ring-2 focus:ring-primary/30 transition-all"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide">Student level</label>
            <div className="relative">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-xl">school</span>
              <select
                value={level} onChange={e => setLevel(e.target.value)}
                className="w-full pl-10 pr-4 py-3 bg-surface-container-low rounded-xl text-sm border-none focus:ring-2 focus:ring-primary/30 transition-all appearance-none cursor-pointer"
              >
                <option>High School</option>
                <option>Undergraduate</option>
                <option>Postgraduate</option>
              </select>
            </div>
          </div>
          <button
            onClick={handleSaveProfile} disabled={savingProfile}
            className="flex items-center gap-2 px-6 py-2.5 bg-primary text-on-primary rounded-full text-sm font-bold hover:scale-[1.02] disabled:opacity-50 transition-all w-full sm:w-auto justify-center sm:justify-start"
          >
            {savingProfile ? <Spinner size={16} /> : <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>save</span>}
            Save Profile
          </button>
        </div>

        {/* Feature 2: Study Streak Display */}
        {streak && (
          <div className="mt-4 pt-4 border-t border-outline-variant/10">
            <div className="flex items-center gap-2 text-sm">
              <span className="material-symbols-outlined text-orange-500" style={{ fontVariationSettings: "'FILL' 1" }}>local_fire_department</span>
              <span className="font-bold text-on-surface">{streak.current_streak} day streak</span>
              {streak.studied_today === false && streak.current_streak > 0 && (
                <span className="text-xs text-orange-600 ml-2">Study today to keep your streak!</span>
              )}
            </div>
            <div className="text-xs text-on-surface-variant mt-1">Best: {streak.longest_streak} days</div>
          </div>
        )}

        {/* Feature 5: Timezone & Locale */}
        <div className="mt-4 pt-4 border-t border-outline-variant/10 space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide">Timezone</label>
            <div className="relative">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-xl">public</span>
              <select
                value={timezone} onChange={e => setTimezone(e.target.value)}
                className="w-full pl-10 pr-4 py-3 bg-surface-container-low rounded-xl text-sm border-none focus:ring-2 focus:ring-primary/30 transition-all appearance-none cursor-pointer"
              >
                <option value="UTC">UTC</option>
                <option value="Africa/Douala">Africa/Douala</option>
                <option value="Africa/Lagos">Africa/Lagos</option>
                <option value="Africa/Nairobi">Africa/Nairobi</option>
                <option value="Europe/London">Europe/London</option>
                <option value="Europe/Paris">Europe/Paris</option>
                <option value="America/New_York">America/New_York</option>
                <option value="America/Chicago">America/Chicago</option>
                <option value="America/Los_Angeles">America/Los_Angeles</option>
                <option value="Asia/Dubai">Asia/Dubai</option>
                <option value="Asia/Kolkata">Asia/Kolkata</option>
                <option value="Asia/Singapore">Asia/Singapore</option>
                <option value="Asia/Tokyo">Asia/Tokyo</option>
                <option value="Australia/Sydney">Australia/Sydney</option>
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide">Locale / Date format</label>
            <div className="relative">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-xl">language</span>
              <select
                value={locale} onChange={e => setLocale(e.target.value)}
                className="w-full pl-10 pr-4 py-3 bg-surface-container-low rounded-xl text-sm border-none focus:ring-2 focus:ring-primary/30 transition-all appearance-none cursor-pointer"
              >
                <option value="en-GB">en-GB (DD/MM/YYYY)</option>
                <option value="en-US">en-US (MM/DD/YYYY)</option>
                <option value="fr-FR">fr-FR (DD/MM/YYYY French)</option>
                <option value="de-DE">de-DE (DD.MM.YYYY)</option>
              </select>
            </div>
          </div>
        </div>
      </Card>

      {/* ── D6-4: Theme ────────────────────────────────────────────────────── */}
      <Card className="p-6">
        <SectionHeader icon="dark_mode" title="Appearance" subtitle="Toggle light or dark theme" />
        <ToggleRow
          label="Dark mode"
          description="Switch to a dark colour scheme — easier on the eyes at night."
          checked={theme === "dark"}
          onChange={handleThemeToggle}
        />
      </Card>

      {/* ── Feature 1: Active Sessions ─────────────────────────────────────── */}
      <Card className="p-6">
        <SectionHeader icon="devices" title="Active Sessions" subtitle="Manage your login sessions across devices" />
        {loadingSessions ? (
          <div className="flex justify-center py-4">
            <Spinner size={24} />
          </div>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-on-surface-variant">No active sessions found.</p>
        ) : (
          <div className="space-y-3">
            {sessions.map(session => (
              <div key={session.session_id} className="flex items-center justify-between p-3 bg-surface-container-low rounded-xl">
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-outline text-xl">
                    {session.user_agent.toLowerCase().includes('mobile') ? 'smartphone' : 'computer'}
                  </span>
                  <div>
                    <div className="text-sm font-medium text-on-surface">
                      {session.user_agent.length > 30 ? session.user_agent.substring(0, 30) + '...' : session.user_agent}
                    </div>
                    <div className="text-xs text-on-surface-variant">
                      {session.ip_address} · {new Date(session.last_seen).toLocaleString()}
                    </div>
                  </div>
                </div>
                {session.is_current ? (
                  <Badge variant="success">Current</Badge>
                ) : (
                  <button
                    onClick={() => handleRevokeSession(session.session_id)}
                    className="px-3 py-1 bg-error/10 text-error rounded-full text-xs font-semibold hover:bg-error/20 transition-colors"
                  >
                    Revoke
                  </button>
                )}
              </div>
            ))}
            {sessions.length > 1 && (
              <button
                onClick={handleRevokeOtherSessions}
                className="w-full mt-2 px-4 py-2 bg-surface-container border border-outline-variant/20 text-on-surface rounded-full text-sm font-semibold hover:bg-surface-container-high transition-all"
              >
                Sign out all other devices
              </button>
            )}
          </div>
        )}
      </Card>

      {/* ── Feature 3: Email Address Change ───────────────────────────────── */}
      <Card className="p-6">
        <SectionHeader icon="mail" title="Email Address" subtitle="Change your account email" />
        <div className="space-y-4">
          <div className="p-3 bg-surface-container-low rounded-xl">
            <label className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide">Current email</label>
            <div className="text-sm font-medium text-on-surface mt-1">{settings?.email}</div>
          </div>
          {showEmailForm ? (
            <form onSubmit={handleChangeEmail} className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide">New email</label>
                <div className="relative">
                  <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-xl">mail</span>
                  <input
                    type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)}
                    placeholder="your@email.com" required
                    className="w-full pl-10 pr-4 py-3 bg-surface-container-low rounded-xl text-sm border-none focus:ring-2 focus:ring-primary/30 transition-all"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide">Current password</label>
                <div className="relative">
                  <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-xl">lock</span>
                  <input
                    type="password" value={emailConfirmPw} onChange={e => setEmailConfirmPw(e.target.value)}
                    placeholder="Confirm with your password" required
                    className="w-full pl-10 pr-4 py-3 bg-surface-container-low rounded-xl text-sm border-none focus:ring-2 focus:ring-primary/30 transition-all"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button type="submit" disabled={savingEmail}
                  className="flex items-center gap-2 px-5 py-2.5 bg-primary text-on-primary rounded-full text-sm font-bold hover:scale-[1.02] disabled:opacity-50 transition-all">
                  {savingEmail ? <Spinner size={16} /> : <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>save</span>}
                  Update Email
                </button>
                <button type="button" onClick={() => { setShowEmailForm(false); setNewEmail(""); setEmailConfirmPw(""); }}
                  className="px-5 py-2.5 bg-surface-container border border-outline-variant/20 text-on-surface rounded-full text-sm font-bold transition-all">
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button onClick={() => setShowEmailForm(true)}
              className="flex items-center gap-2 px-6 py-2.5 bg-surface-container border border-outline-variant/20 text-on-surface rounded-full text-sm font-bold hover:bg-surface-container-high transition-all">
              <span className="material-symbols-outlined text-base">edit</span>
              Change email
            </button>
          )}
        </div>
      </Card>

      {/* ── Feature 4: Account Activity Log ─────────────────────────────────── */}
      <Card className="p-6">
        <SectionHeader icon="history" title="Recent Account Activity" subtitle="Security-relevant events on your account" />
        <button onClick={handleLoadActivity}
          className="flex items-center gap-2 px-4 py-2 bg-surface-container border border-outline-variant/20 text-on-surface rounded-full text-sm font-semibold hover:bg-surface-container-high transition-all mb-4">
          <span className="material-symbols-outlined text-base">{showActivity ? 'expand_less' : 'expand_more'}</span>
          {showActivity ? 'Hide' : 'Show'} activity log
        </button>
        {showActivity && (
          <div className="max-h-64 overflow-y-auto space-y-2">
            {loadingActivity ? (
              <div className="flex justify-center py-4">
                <Spinner size={24} />
              </div>
            ) : activity.length === 0 ? (
              <p className="text-sm text-on-surface-variant">No recent activity.</p>
            ) : (
              activity.map((entry, idx) => {
                const ACTIVITY_LABELS: Record<string, string> = {
                  login: "Signed in",
                  password_changed: "Password changed",
                  email_changed: "Email address changed",
                  "2fa_enabled": "2FA enabled",
                  "2fa_disabled": "2FA disabled",
                  data_exported: "Data exported",
                };
                const label = ACTIVITY_LABELS[entry.event] || entry.event;
                let badgeVariant: "success" | "error" | "neutral" = "neutral";
                if (entry.event === "login") badgeVariant = "success";
                else if (["password_changed", "email_changed", "2fa_enabled", "2fa_disabled"].includes(entry.event)) badgeVariant = "error";
                
                return (
                  <div key={idx} className="flex items-start gap-3 p-3 bg-surface-container-low rounded-xl">
                    <Badge variant={badgeVariant} className="mt-0.5">{label}</Badge>
                    <div className="flex-1 min-w-0">
                      {entry.detail && <div className="text-xs text-on-surface-variant truncate">{entry.detail}</div>}
                      <div className="text-xs text-on-surface-variant/70 mt-0.5">{new Date(entry.at).toLocaleString()}</div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </Card>

      {/* ── Feature 6: Timetable Display Preferences ────────────────────────── */}
      <Card className="p-6">
        <SectionHeader icon="calendar_view_week" title="Timetable Display" subtitle="Customize how your timetable appears" />
        <div className="space-y-4">
          <div>
            <label className="text-sm font-semibold text-on-surface-variant mb-2 block">Week starts on</label>
            <div className="flex gap-2">
              {["Monday", "Sunday"].map(day => (
                <button
                  key={day}
                  onClick={() => setDisplayPrefs(prev => prev ? { ...prev, week_start_day: day as any } : null)}
                  className={`px-4 py-2 rounded-full text-sm font-semibold transition-all ${
                    displayPrefs?.week_start_day === day
                      ? "bg-primary text-on-primary"
                      : "bg-surface-container text-on-surface hover:bg-surface-container-high"
                  }`}
                >
                  {day}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-sm font-semibold text-on-surface-variant mb-2 block">Time format</label>
            <div className="flex gap-2">
              {[
                { value: "24h", label: "24-hour (14:30)" },
                { value: "12h", label: "12-hour (2:30 PM)" }
              ].map(format => (
                <button
                  key={format.value}
                  onClick={() => setDisplayPrefs(prev => prev ? { ...prev, time_format: format.value as any } : null)}
                  className={`px-4 py-2 rounded-full text-sm font-semibold transition-all ${
                    displayPrefs?.time_format === format.value
                      ? "bg-primary text-on-primary"
                      : "bg-surface-container text-on-surface hover:bg-surface-container-high"
                  }`}
                >
                  {format.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-sm font-semibold text-on-surface-variant mb-2 block">Default view</label>
            <div className="flex gap-2">
              {[
                { value: "current_day", label: "Current day" },
                { value: "full_week", label: "Full week" }
              ].map(view => (
                <button
                  key={view.value}
                  onClick={() => setDisplayPrefs(prev => prev ? { ...prev, timetable_default_view: view.value as any } : null)}
                  className={`px-4 py-2 rounded-full text-sm font-semibold transition-all ${
                    displayPrefs?.timetable_default_view === view.value
                      ? "bg-primary text-on-primary"
                      : "bg-surface-container text-on-surface hover:bg-surface-container-high"
                  }`}
                >
                  {view.label}
                </button>
              ))}
            </div>
          </div>
          <button onClick={handleSaveDisplayPrefs} disabled={savingDisplay}
            className="flex items-center gap-2 px-6 py-2.5 bg-primary text-on-primary rounded-full text-sm font-bold hover:scale-[1.02] disabled:opacity-50 transition-all">
            {savingDisplay ? <Spinner size={16} /> : <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>save</span>}
            Save Preferences
          </button>
        </div>
      </Card>

      {/* ── D6-5: Change Password ───────────────────────────────────────────── */}
      <Card className="p-6">
        <SectionHeader icon="lock" title="Change Password" subtitle="Must meet the 8–12 char complexity policy" />
        <form onSubmit={handleChangePassword} className="space-y-3">
          {[
            { label: "Current password", value: currentPw, set: setCurrentPw, placeholder: "Your current password" },
            { label: "New password",     value: newPw,     set: setNewPw,     placeholder: "8–12 chars, upper, lower, digit, special" },
            { label: "Confirm new",      value: confirmPw, set: setConfirmPw, placeholder: "Repeat new password" },
          ].map(({ label, value, set, placeholder }) => (
            <div key={label} className="space-y-1">
              <label className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide">{label}</label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-xl">lock</span>
                <input
                  type={showPw ? "text" : "password"} value={value}
                  onChange={e => set(e.target.value)} placeholder={placeholder} required
                  className="w-full pl-10 pr-12 py-3 bg-surface-container-low rounded-xl text-sm border-none focus:ring-2 focus:ring-primary/30 transition-all"
                />
                <button type="button" onClick={() => setShowPw(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-outline">
                  <span className="material-symbols-outlined text-xl">{showPw ? "visibility_off" : "visibility"}</span>
                </button>
              </div>
            </div>
          ))}
          {confirmPw && newPw !== confirmPw && (
            <p className="text-xs text-red-500 font-semibold">Passwords don't match</p>
          )}
          <button
            type="submit" disabled={savingPw || (!!confirmPw && newPw !== confirmPw)}
            className="flex items-center gap-2 px-6 py-2.5 bg-primary text-on-primary rounded-full text-sm font-bold hover:scale-[1.02] disabled:opacity-50 transition-all"
          >
            {savingPw ? <Spinner size={16} /> : <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>key</span>}
            Change Password
          </button>
        </form>
      </Card>

      {/* ── D6-6: Notification Preferences ────────────────────────────────── */}
      <Card className="p-6">
        <SectionHeader icon="notifications" title="Notification Preferences" subtitle="Choose which emails you receive" />
        <div className="space-y-0">
          {ALL_NOTIF_EVENTS.map(({ id, label, description }) => (
            <ToggleRow
              key={id} label={label} description={description}
              checked={notifEvents.has(id)}
              onChange={v => {
                setNotifEvents(prev => {
                  const next = new Set(prev);
                  v ? next.add(id) : next.delete(id);
                  return next;
                });
              }}
            />
          ))}
        </div>
        <button
          onClick={handleSaveNotifs} disabled={savingNotif}
          className="mt-4 flex items-center gap-2 px-6 py-2.5 bg-primary text-on-primary rounded-full text-sm font-bold hover:scale-[1.02] disabled:opacity-50 transition-all w-full sm:w-auto justify-center sm:justify-start"
        >
          {savingNotif ? <Spinner size={16} /> : <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>save</span>}
          Save Preferences
        </button>
      </Card>

      {/* ── D7: Two-Factor Authentication ───────────────────────────────────── */}
      <Card className="p-6">
        <SectionHeader icon="security" title="Two-Factor Authentication" subtitle="TOTP — compatible with Google Authenticator, Authy, etc." />

        {settings?.two_factor_enabled ? (
          /* ── Already enabled ─────────────────────────────────────────────── */
          <div className="space-y-4">
            <div className="flex items-center gap-2 p-3 bg-emerald-50 rounded-xl border border-emerald-200">
              <span className="material-symbols-outlined text-emerald-600 text-base" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
              <p className="text-sm text-emerald-700 font-semibold">2FA is active on your account.</p>
            </div>
            {showDisable ? (
              <div className="space-y-3">
                <p className="text-sm text-on-surface-variant">Enter your authenticator code to confirm disabling 2FA:</p>
                <div className="relative">
                  <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-xl">pin</span>
                  <input
                    type="text" inputMode="numeric" maxLength={6}
                    value={disableCode}
                    onChange={e => setDisableCode(e.target.value.replace(/\D/g, ""))}
                    placeholder="123456"
                    className="w-full pl-10 pr-4 py-3 bg-surface-container-low rounded-xl text-sm font-mono tracking-widest border-none focus:ring-2 focus:ring-red-300 transition-all"
                  />
                </div>
                <div className="flex gap-2">
                  <button onClick={handleDisable2FA}
                    className="px-5 py-2 bg-red-600 text-white rounded-full text-sm font-bold hover:bg-red-700 transition-all">
                    Confirm disable
                  </button>
                  <button onClick={() => { setShowDisable(false); setDisableCode(""); }}
                    className="px-5 py-2 bg-surface-container text-on-surface rounded-full text-sm font-bold transition-all">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => setShowDisable(true)}
                className="flex items-center gap-2 px-5 py-2.5 bg-surface-container border border-outline-variant/20 text-on-surface rounded-full text-sm font-bold hover:bg-surface-container-high transition-all">
                <span className="material-symbols-outlined text-base">lock_open</span>
                Disable 2FA
              </button>
            )}
          </div>
        ) : qrUri ? (
          /* ── Enrollment in progress — show QR + code entry ──────────────── */
          <div className="space-y-4">
            <div className="p-3 bg-primary-container/30 rounded-xl">
              <p className="text-sm text-on-surface-variant leading-relaxed">
                <strong>Step 1:</strong> Scan the QR code below with your authenticator app
                (Google Authenticator, Authy, 1Password, etc.).<br />
                <strong>Step 2:</strong> Enter the 6-digit code to confirm setup.
              </p>
            </div>
            {/* QR code rendered via Google Charts API */}
            <div className="flex justify-center">
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrUri)}`}
                alt="2FA QR Code"
                className="rounded-2xl border border-outline-variant/20 p-2 bg-white"
                width={200} height={200}
              />
            </div>
            {enrollSecret && (
              <div className="p-3 bg-surface-container-low rounded-xl">
                <p className="text-xs text-on-surface-variant mb-1">Manual entry key:</p>
                <code className="text-xs font-mono text-primary break-all">{enrollSecret}</code>
              </div>
            )}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide">
                Authenticator Code
              </label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-xl">pin</span>
                <input
                  type="text" inputMode="numeric" maxLength={6}
                  value={enableCode}
                  onChange={e => setEnableCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="Enter 6-digit code"
                  className="w-full pl-10 pr-4 py-3 bg-surface-container-low rounded-xl text-sm font-mono tracking-widest border-none focus:ring-2 focus:ring-primary/30 transition-all"
                />
              </div>
              <div className="flex gap-2">
                <button onClick={handleEnable2FA} disabled={enableCode.length !== 6}
                  className="flex items-center gap-2 px-5 py-2.5 bg-primary text-on-primary rounded-full text-sm font-bold hover:scale-[1.02] disabled:opacity-50 transition-all">
                  <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>verified_user</span>
                  Enable 2FA
                </button>
                <button onClick={() => { setQrUri(null); setEnrollSecret(null); setEnableCode(""); }}
                  className="px-5 py-2.5 bg-surface-container border border-outline-variant/20 text-on-surface rounded-full text-sm font-bold transition-all">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* ── Not enrolled ────────────────────────────────────────────────── */
          <div className="space-y-4">
            <ToggleRow
              label="Enable 2FA (TOTP)"
              description="Adds a second verification step at login using an authenticator app."
              checked={false}
              onChange={() => handleEnroll()}
            />
            <button onClick={handleEnroll} disabled={enrolling}
              className="flex items-center gap-2 px-6 py-2.5 bg-primary text-on-primary rounded-full text-sm font-bold hover:scale-[1.02] disabled:opacity-50 transition-all">
              {enrolling ? <Spinner size={16} /> : <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>security</span>}
              Set up 2FA
            </button>
          </div>
        )}
      </Card>

      {/* ── D6-8: Study Preferences ───────────────────────────────────────── */}
      <Card className="p-6">
        <SectionHeader icon="tune" title="Study Preferences" subtitle="Default session length and break rhythm" />
        <div className="space-y-5">
          <div className="space-y-2">
            <div className="flex justify-between">
              <label className="text-sm font-semibold text-on-surface-variant">Default session length</label>
              <span className="text-sm font-bold text-primary">{sessionLen}h</span>
            </div>
            <input type="range" min={0.25} max={4} step={0.25} value={sessionLen}
              onChange={e => setSessionLen(parseFloat(e.target.value))}
              className="w-full accent-primary" />
            <div className="flex justify-between text-xs text-on-surface-variant">
              <span>15 min</span><span>4 hours</span>
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between">
              <label className="text-sm font-semibold text-on-surface-variant">Break time per hour</label>
              <span className="text-sm font-bold text-primary">{Math.round(breakRatio * 60)} min</span>
            </div>
            <input type="range" min={0.1} max={0.5} step={0.02} value={breakRatio}
              onChange={e => setBreakRatio(parseFloat(e.target.value))}
              className="w-full accent-primary" />
            <div className="flex justify-between text-xs text-on-surface-variant">
              <span>6 min (intense)</span><span>30 min (relaxed)</span>
            </div>
          </div>

          {/* Feature 7: Default MCQ Preferences */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide">Default questions per quiz</label>
            <div className="relative">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-xl">quiz</span>
              <input
                type="number" min={1} max={20} step={1} value={defaultMcqCount}
                onChange={e => setDefaultMcqCount(parseInt(e.target.value) || 5)}
                className="w-full pl-10 pr-4 py-3 bg-surface-container-low rounded-xl text-sm border-none focus:ring-2 focus:ring-primary/30 transition-all"
              />
            </div>
          </div>
          <div>
            <label className="text-sm font-semibold text-on-surface-variant mb-2 block">Default difficulty</label>
            <div className="flex gap-2">
              {["easy", "medium", "hard"].map(difficulty => (
                <button
                  key={difficulty}
                  onClick={() => setDefaultMcqDifficulty(difficulty)}
                  className={`px-4 py-2 rounded-full text-sm font-semibold transition-all capitalize ${
                    defaultMcqDifficulty === difficulty
                      ? "bg-primary text-on-primary"
                      : "bg-surface-container text-on-surface hover:bg-surface-container-high"
                  }`}
                >
                  {difficulty}
                </button>
              ))}
            </div>
          </div>

          {/* Feature 8: Archive Threshold */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-on-surface-variant uppercase tracking-wide">Keep notes for</label>
            <div className="relative">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-xl">inventory_2</span>
              <select
                value={archiveAfterDays} onChange={e => setArchiveAfterDays(parseInt(e.target.value))}
                className="w-full pl-10 pr-4 py-3 bg-surface-container-low rounded-xl text-sm border-none focus:ring-2 focus:ring-primary/30 transition-all appearance-none cursor-pointer"
              >
                <option value={14}>14 days</option>
                <option value={30}>30 days</option>
                <option value={60}>60 days</option>
                <option value={90}>90 days</option>
                <option value={180}>180 days</option>
                <option value={365}>1 year</option>
              </select>
            </div>
            <p className="text-xs text-on-surface-variant mt-1">
              Content is archived after this period if your score is ≥ 80%, or unconditionally at 90 days.
            </p>
          </div>

          <button onClick={handleSaveStudyPrefs} disabled={savingStudy}
            className="flex items-center gap-2 px-6 py-2.5 bg-primary text-on-primary rounded-full text-sm font-bold hover:scale-[1.02] disabled:opacity-50 transition-all">
            {savingStudy ? <Spinner size={16} /> : <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>save</span>}
            Save Preferences
          </button>
        </div>
      </Card>

      {/* ── D6-9: Export Data ─────────────────────────────────────────────── */}
      <Card className="p-6">
        <SectionHeader icon="download" title="Export My Data" subtitle="Download everything as JSON" />
        <p className="text-sm text-on-surface-variant mb-4 leading-relaxed">
          Download a complete copy of your notes, timetables, progress records, and MCQ history.
        </p>
        <button onClick={handleExport}
          className="flex items-center gap-2 px-6 py-2.5 bg-surface-container border border-outline-variant/20 text-on-surface rounded-full text-sm font-bold hover:bg-surface-container-high transition-all">
          <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>download</span>
          Download my data
        </button>
      </Card>

      {/* ── Sign Out ───────────────────────────────────────────────────────── */}
      <Card className="p-6">
        <SectionHeader icon="logout" title="Sign Out" subtitle="End your session and return to login" />
        <p className="text-sm text-on-surface-variant mb-4 leading-relaxed">
          Sign out of your account securely. You can always sign back in later.
        </p>
        <button
          onClick={handleSignOut}
          className="flex items-center gap-2 px-6 py-2.5 bg-surface-container border border-outline-variant/20 text-on-surface rounded-full text-sm font-bold hover:bg-surface-container-high transition-all"
        >
          <span className="material-symbols-outlined text-base">logout</span>
          Sign out
        </button>
      </Card>

      {/* ── D6-10: Delete Account ─────────────────────────────────────────── */}
      <Card className="p-6 border border-red-100">
        <SectionHeader icon="delete_forever" title="Delete Account" subtitle="Permanently removes all your data" />
        <p className="text-sm text-on-surface-variant mb-4 leading-relaxed">
          This will permanently delete your account, all notes, timetables, progress records, and MCQs.
          <strong className="text-red-600"> This action cannot be undone.</strong>
        </p>
        {deleteConfirm && (
          <div className="mb-4 p-3 bg-red-50 rounded-xl border border-red-200">
            <p className="text-sm text-red-700 font-semibold">
              ⚠️ Click "Delete my account" again to confirm permanent deletion.
            </p>
          </div>
        )}
        <button
          onClick={handleDeleteAccount} disabled={deleting}
          className="flex items-center gap-2 px-4 py-2.5 bg-red-600 text-white rounded-full text-sm font-bold hover:bg-red-700 disabled:opacity-50 transition-all w-full sm:w-auto justify-center"
        >
          {deleting ? <Spinner size={16} /> : <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>delete_forever</span>}
          {deleteConfirm ? "Confirm — delete my account" : "Delete my account"}
        </button>
      </Card>
    </div>
  );
}
