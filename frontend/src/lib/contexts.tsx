import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
} from "react";
import type { User, Toast } from "../types";
import { authApi } from "./api";

// ── Auth Context ──────────────────────────────────────────────────────────────

interface AuthContextValue {
  user: User | null;
  setUser: (u: User | null) => void;
  logout: () => Promise<void>;
}

export const AuthCtx = createContext<AuthContextValue>({
  user: null,
  setUser: () => {},
  logout: async () => {},
});

export const useAuth = () => useContext(AuthCtx);

interface AuthProviderProps {
  children: React.ReactNode;
  onLogout: () => void;
}

export function AuthProvider({ children, onLogout }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);

  const logout = useCallback(async () => {
    await authApi.logout().catch(() => {});
    setUser(null);
    onLogout();
  }, [onLogout]);

  return (
    <AuthCtx.Provider value={{ user, setUser, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

// ── Toast Context ─────────────────────────────────────────────────────────────

type PushToast = (msg: string, type?: Toast["type"]) => void;

export const ToastCtx = createContext<PushToast>(() => {});

export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const push = useCallback((msg: string, type: Toast["type"] = "info") => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const iconMap: Record<Toast["type"], string> = {
    success: "check_circle",
    error: "error",
    info: "info",
  };

  const colorMap: Record<Toast["type"], { bg: string; text: string; icon: string }> = {
    success: {
      bg: "bg-emerald-50 border-emerald-200",
      text: "text-emerald-800",
      icon: "text-emerald-500",
    },
    error: {
      bg: "bg-red-50 border-red-200",
      text: "text-red-800",
      icon: "text-red-500",
    },
    info: {
      bg: "bg-blue-50 border-blue-200",
      text: "text-blue-800",
      icon: "text-blue-500",
    },
  };

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-3 pointer-events-none">
        {toasts.map((t) => {
          const c = colorMap[t.type];
          return (
            <div
              key={t.id}
              className={`
                pointer-events-auto flex items-center gap-3 px-4 py-3
                rounded-2xl border shadow-lg shadow-black/5
                backdrop-blur-sm max-w-sm
                animate-in slide-in-from-right-4 fade-in duration-300
                ${c.bg}
              `}
            >
              <span
                className={`material-symbols-outlined text-xl ${c.icon}`}
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                {iconMap[t.type]}
              </span>
              <p className={`text-sm font-semibold ${c.text}`}>{t.msg}</p>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
