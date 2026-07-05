import React from "react";
import type { Page } from "../types";
import { useAuth } from "../lib/contexts";

// ── Spinner ───────────────────────────────────────────────────────────────────
export function Spinner({ size = 20 }: { size?: number }) {
  return (
    <div
      className="rounded-full border-2 border-surface-container-high border-t-primary animate-spin"
      style={{ width: size, height: size, flexShrink: 0 }}
    />
  );
}

// ── Badge ─────────────────────────────────────────────────────────────────────
interface BadgeProps {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "tertiary" | "success" | "error" | "neutral";
  className?: string;
}

export function Badge({ children, variant = "neutral", className = "" }: BadgeProps) {
  const variants: Record<string, string> = {
    primary: "bg-primary-container text-on-primary-container",
    secondary: "bg-secondary-container text-on-secondary-container",
    tertiary: "bg-tertiary-container text-on-tertiary-container",
    success: "bg-emerald-100 text-emerald-800",
    error: "bg-red-100 text-red-800",
    neutral: "bg-surface-container-high text-on-surface-variant",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${variants[variant]} ${className}`}
    >
      {children}
    </span>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────
interface CardProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  hoverable?: boolean;
}

export function Card({ children, className = "", onClick, hoverable = false }: CardProps) {
  return (
    <div
      onClick={onClick}
      className={`
        bg-surface-container-lowest rounded-2xl border border-outline-variant/20
        shadow-sm
        ${hoverable ? "cursor-pointer hover:-translate-y-1 hover:shadow-md transition-all duration-200" : ""}
        ${className}
      `}
    >
      {children}
    </div>
  );
}


// ── Toggle (Switch) ───────────────────────────────────────────────────────────
// Follows the exact same styling conventions as Spinner, Badge, and Card.
interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
}

export function Toggle({ checked, onChange, disabled = false, label }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`
        relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent
        transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary/30
        ${checked ? "bg-primary" : "bg-surface-container-high"}
        ${disabled ? "opacity-40 cursor-not-allowed" : ""}
      `}
    >
      <span
        className={`
          pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md
          transition duration-200 ease-in-out
          ${checked ? "translate-x-5" : "translate-x-0"}
        `}
      />
    </button>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
interface NavItem {
  page: Page;
  label: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { page: "dashboard",    label: "Dashboard",    icon: "home" },
  { page: "upload",       label: "Notes",        icon: "description" },
  { page: "analysis",     label: "Analysis",     icon: "analytics" },
  { page: "timetable",    label: "Timetable",    icon: "calendar_month" },
  { page: "report",       label: "Progress",     icon: "bar_chart" },
  { page: "ai-assistant", label: "AI Assistant", icon: "psychology" },
  { page: "schedule",     label: "My Schedule",  icon: "edit_calendar" },
];

interface SidebarProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
}

export function Sidebar({ currentPage, onNavigate }: SidebarProps) {
  const { user } = useAuth();

  return (
    <aside className="hidden lg:flex flex-col w-64 min-h-screen bg-surface-container-lowest border-r border-outline-variant/20 px-4 py-6 gap-2 fixed left-0 top-0 bottom-0 z-10">
      {/* Logo */}
      <div className="flex items-center gap-3 px-3 mb-8">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-indigo-700 flex items-center justify-center shadow-lg shadow-primary/20 flex-shrink-0">
          <span
            className="material-symbols-outlined text-white text-lg"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            psychology
          </span>
        </div>
        <div>
          <p className="font-headline text-sm font-black tracking-tight text-on-background leading-none">
            Cognitive
          </p>
          <p className="font-headline text-sm font-black tracking-tight text-primary leading-none">
            Sanctuary
          </p>
        </div>
      </div>

      {/* Nav items */}
      <nav className="flex-1 flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const active = currentPage === item.page;
          return (
            <button
              key={item.page}
              onClick={() => onNavigate(item.page)}
              className={`
                flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all duration-150 text-left
                ${active
                  ? "bg-primary-container text-on-primary-container"
                  : "text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
                }
              `}
            >
              <span
                className={`material-symbols-outlined text-xl ${active ? "text-primary" : ""}`}
                style={{ fontVariationSettings: active ? "'FILL' 1" : "'FILL' 0" }}
              >
                {item.icon}
              </span>
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* User footer */}
      <div className="mt-4 pt-4 border-t border-outline-variant/20">
        <div className="flex items-center gap-3 px-3 mb-3">
          <div className="w-9 h-9 rounded-full bg-primary-container flex items-center justify-center flex-shrink-0 overflow-hidden">
            {user?.avatar_b64 ? (
              <img src={user.avatar_b64} alt="Avatar" className="w-full h-full object-cover" />
            ) : (
              <span className="text-sm font-black text-primary">
                {user?.name?.charAt(0).toUpperCase() ?? "U"}
              </span>
            )}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-on-surface truncate">{user?.name ?? "User"}</p>
            <p className="text-xs text-on-surface-variant truncate">{user?.level ?? ""}</p>
          </div>
        </div>
        <button
          onClick={() => onNavigate("settings")}
          className={`
            w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all duration-150 text-left
            ${currentPage === "settings"
              ? "bg-primary-container text-on-primary-container"
              : "text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
            }
          `}
        >
          <span
            className={`material-symbols-outlined text-xl ${currentPage === "settings" ? "text-primary" : ""}`}
            style={{ fontVariationSettings: currentPage === "settings" ? "'FILL' 1" : "'FILL' 0" }}
          >
            settings
          </span>
          Settings
        </button>
      </div>
    </aside>
  );
}

// ── Mobile top bar ────────────────────────────────────────────────────────────
interface TopBarProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
}

const PAGE_TITLES: Record<Page, string> = {
  login: "Login",
  signup: "Sign Up",
  dashboard: "Dashboard",
  upload: "Study Notes",
  analysis: "AI Analysis",
  timetable: "Timetable",
  report: "Progress Report",
  quiz: "Quiz",
  "ai-assistant": "AI Assistant",
  "schedule":     "My Schedule",
  "settings":     "Settings",
};

export function TopBar({ currentPage, onNavigate }: TopBarProps) {
  const [open, setOpen] = React.useState(false);
  const { user } = useAuth();

  return (
    <>
      <header className="lg:hidden sticky top-0 z-20 flex items-center justify-between px-4 py-3 bg-surface-container-lowest border-b border-outline-variant/20 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-indigo-700 flex items-center justify-center">
            <span className="material-symbols-outlined text-white text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>psychology</span>
          </div>
          <span className="font-headline text-sm font-black text-on-background">{PAGE_TITLES[currentPage]}</span>
        </div>
        <button onClick={() => setOpen(true)} className="p-2 rounded-xl hover:bg-surface-container transition-colors">
          <span className="material-symbols-outlined text-on-surface-variant">menu</span>
        </button>
      </header>

      {/* Mobile drawer */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-50" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <aside
            className="absolute left-0 top-0 bottom-0 w-72 bg-surface-container-lowest flex flex-col px-4 py-6 gap-2 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 mb-6">
              <span className="font-headline text-base font-black text-primary">Cognitive Sanctuary</span>
              <button onClick={() => setOpen(false)} className="p-1 rounded-lg hover:bg-surface-container">
                <span className="material-symbols-outlined text-on-surface-variant">close</span>
              </button>
            </div>
            <nav className="flex-1 flex flex-col gap-1">
              {NAV_ITEMS.map((item) => {
                const active = currentPage === item.page;
                return (
                  <button
                    key={item.page}
                    onClick={() => { onNavigate(item.page); setOpen(false); }}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all text-left ${active ? "bg-primary-container text-on-primary-container" : "text-on-surface-variant hover:bg-surface-container"}`}
                  >
                    <span className="material-symbols-outlined text-xl" style={{ fontVariationSettings: active ? "'FILL' 1" : "'FILL' 0" }}>{item.icon}</span>
                    {item.label}
                  </button>
                );
              })}
            </nav>
            <div className="border-t border-outline-variant/20 pt-4 mt-4">
              <div className="flex items-center gap-3 px-3 mb-3">
                <div className="w-9 h-9 rounded-full bg-primary-container flex items-center justify-center flex-shrink-0 overflow-hidden">
                  {user?.avatar_b64 ? (
                    <img src={user.avatar_b64} alt="Avatar" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-sm font-black text-primary">
                      {user?.name?.charAt(0).toUpperCase() ?? "U"}
                    </span>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-on-surface truncate">{user?.name ?? "User"}</p>
                  <p className="text-xs text-on-surface-variant truncate">{user?.level ?? ""}</p>
                </div>
              </div>
              <button
                onClick={() => { onNavigate("settings"); setOpen(false); }}
                className={`
                  w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all text-left
                  ${currentPage === "settings"
                    ? "bg-primary-container text-on-primary-container"
                    : "text-on-surface-variant hover:bg-surface-container"
                  }
                `}
              >
                <span
                  className={`material-symbols-outlined text-xl ${currentPage === "settings" ? "text-primary" : ""}`}
                  style={{ fontVariationSettings: currentPage === "settings" ? "'FILL' 1" : "'FILL' 0" }}
                >
                  settings
                </span>
                Settings
              </button>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
