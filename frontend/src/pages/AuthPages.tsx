import React, { useState, useMemo } from "react";
import { Spinner } from "../components/UI";
import { useToast, useAuth } from "../lib/contexts";
import { authApi, twofaApi } from "../lib/api";
import type { Page } from "../types";

// ── Password validation (mirrors backend app/core/validators.py) ──────────────
interface PwStrength {
  score: number;   // 0–4
  label: string;
  color: string;   // Tailwind text color
  errors: string[];
}

function checkPassword(pw: string): PwStrength {
  const errors: string[] = [];
  if (pw.length < 8)  errors.push("At least 8 characters");
  if (pw.length > 12) errors.push("At most 12 characters");
  if (!/[a-z]/.test(pw)) errors.push("One lowercase letter");
  if (!/[A-Z]/.test(pw)) errors.push("One uppercase letter");
  if (!/\d/.test(pw))    errors.push("One digit");
  if (!/[!@#$%^&*()\-_=+\[\]{};':"\\|,.<>/?`~]/.test(pw)) errors.push("One special character");

  const score = Math.max(0, 4 - errors.length);
  const labels = ["Too weak", "Weak", "Fair", "Good", "Strong"];
  const colors = ["text-red-500", "text-red-400", "text-yellow-500", "text-tertiary", "text-emerald-600"];
  return { score, label: pw.length === 0 ? "" : labels[score], color: colors[score], errors };
}

// ── Password Strength Bar ─────────────────────────────────────────────────────
function PasswordStrengthBar({ password }: { password: string }) {
  const { score, label, color, errors } = useMemo(() => checkPassword(password), [password]);
  if (!password) return null;

  const segColors = [
    "bg-red-500", "bg-red-400", "bg-yellow-500", "bg-tertiary", "bg-emerald-500",
  ];

  return (
    <div className="mt-2 space-y-1.5">
      {/* Segmented bar */}
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full transition-all duration-300 ${
              i < score ? segColors[score] : "bg-surface-container-high"
            }`}
          />
        ))}
      </div>
      {/* Strength label */}
      {label && (
        <p className={`text-xs font-semibold ${color}`}>{label}</p>
      )}
      {/* Remaining requirements */}
      {errors.length > 0 && (
        <ul className="text-xs text-on-surface-variant space-y-0.5">
          {errors.map((e) => (
            <li key={e} className="flex items-center gap-1">
              <span className="material-symbols-outlined text-xs text-outline">circle</span>
              {e}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Shared Brand Panel ────────────────────────────────────────────────────────
function BrandPanel() {
  return (
    <section className="hidden lg:flex flex-col relative overflow-hidden bg-surface-container-low p-14 justify-center items-center">
      <div className="absolute top-[-10%] left-[-10%] w-[500px] h-[500px] bg-primary/10 rounded-full blur-[100px]" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[600px] h-[600px] bg-tertiary/10 rounded-full blur-[120px]" />
      <div className="relative z-10 max-w-lg text-center">
        <div className="flex items-center justify-center gap-4 mb-10">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-indigo-700 flex items-center justify-center shadow-xl shadow-primary/20">
            <span className="material-symbols-outlined text-white text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>
              psychology
            </span>
          </div>
          <div className="text-left">
            <h1 className="font-headline text-3xl font-black tracking-tighter text-indigo-700">
              Cognitive Sanctuary
            </h1>
            <p className="text-xs text-on-surface-variant uppercase tracking-widest font-bold">
              AI-Powered Learning
            </p>
          </div>
        </div>
        <div className="mb-10 rounded-2xl overflow-hidden shadow-2xl transform rotate-1 hover:rotate-0 transition-transform duration-700 bg-surface-container-lowest p-4">
          <div className="rounded-xl w-full h-64 bg-gradient-to-br from-indigo-100 via-purple-50 to-indigo-50 flex items-center justify-center">
            <div className="text-center">
              <div className="flex justify-center gap-4 mb-6">
                {["auto_stories", "neurology", "school"].map((icon) => (
                  <div key={icon} className="w-14 h-14 rounded-2xl bg-white shadow-lg flex items-center justify-center">
                    <span className="material-symbols-outlined text-2xl text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>
                      {icon}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-sm font-semibold text-on-surface-variant">
                Adaptive Intelligence for Every Learner
              </p>
            </div>
          </div>
        </div>
        <h2 className="font-headline text-3xl font-extrabold tracking-tighter text-on-background mb-4">
          The Cognitive Sanctuary
        </h2>
        <p className="text-on-surface-variant text-base leading-relaxed px-6 mb-8">
          An AI-powered sanctuary where focus meets intelligence. Elevate your study sessions with adaptive planning and calm clarity.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          {[
            { label: "Adaptive Logic", icon: "auto_fix_high" },
            { label: "Neural Recall", icon: "neurology" },
            { label: "Focus Flow",    icon: "self_improvement" },
            { label: "Smart Quizzes", icon: "quiz" },
          ].map(({ label, icon }) => (
            <span key={label} className="px-4 py-2 bg-white/70 backdrop-blur-sm border border-white/50 rounded-full text-xs font-bold text-on-surface flex items-center gap-2 shadow-sm">
              <span className="material-symbols-outlined text-sm text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>{icon}</span>
              {label}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Login Page ────────────────────────────────────────────────────────────────
export function LoginPage({ setPage }: { setPage: (p: Page) => void }) {
  const { setUser } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);

  // D7: 2FA second-step state
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [totpCode,     setTotpCode]     = useState("");

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();

    // ── Step 2: TOTP verification ──────────────────────────────────────────
    if (pendingToken !== null) {
      if (totpCode.length !== 6) { toast("Enter the 6-digit code from your authenticator app", "error"); return; }
      setLoading(true);
      try {
        const data = await twofaApi.verifyLogin(pendingToken, totpCode);
        setUser(data);
        setPage("dashboard");
        toast(`Welcome back, ${data.name}!`, "success");
      } catch (err: any) {
        toast(err.message ?? "Invalid code", "error");
      } finally {
        setLoading(false);
      }
      return;
    }

    // ── Step 1: Password check ─────────────────────────────────────────────
    if (!email || !password) { toast("Please fill in all fields", "error"); return; }
    setLoading(true);
    try {
      const data = await authApi.login(email, password);
      if (data.requires_2fa) {
        // D7: Server returned 202 — show TOTP step
        setPendingToken(data.pending_token);
        toast("Enter the 6-digit code from your authenticator app", "success");
        return;
      }
      setUser(data);
      setPage("dashboard");
      toast(`Welcome back, ${data.name}!`, "success");
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="w-full min-h-screen grid lg:grid-cols-2">
      <BrandPanel />
      <section className="flex flex-col justify-center items-center p-8 lg:p-16 bg-background relative overflow-hidden">
        <div className="absolute inset-0 opacity-60" style={{ backgroundImage: "radial-gradient(at 0% 0%, hsla(231,46%,50%,0.12) 0px, transparent 50%), radial-gradient(at 100% 100%, hsla(289,74%,57%,0.08) 0px, transparent 50%)" }} />
        <div className="relative w-full max-w-md space-y-8">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 mb-4 px-3 py-1.5 bg-primary-container/50 rounded-full">
              <span className="material-symbols-outlined text-sm text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>lock_open</span>
              <span className="text-xs font-bold text-on-primary-container uppercase tracking-widest">Secure Login</span>
            </div>
            <h2 className="font-headline text-3xl font-bold text-on-background">Welcome back</h2>
            <p className="text-on-surface-variant">Enter your details to access your study portal.</p>
          </div>
          <div className="bg-surface-container-lowest rounded-2xl p-8 shadow-[0_20px_50px_rgba(68,86,186,0.05)] border border-white/60">
            <form onSubmit={handle} className="space-y-5">
              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-on-surface-variant ml-1">Email Address</label>
                <div className="relative">
                  <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline text-xl">mail</span>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@university.edu" required className="w-full pl-12 pr-4 py-4 bg-surface-container-low border-none rounded-xl focus:ring-2 focus:ring-primary/30 focus:bg-white transition-all text-on-surface placeholder:text-outline-variant text-sm" />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-on-surface-variant ml-1">Password</label>
                <div className="relative">
                  <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline text-xl">lock</span>
                  <input type={showPw ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required className="w-full pl-12 pr-12 py-4 bg-surface-container-low border-none rounded-xl focus:ring-2 focus:ring-primary/30 focus:bg-white transition-all text-on-surface placeholder:text-outline-variant text-sm" />
                  <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute right-4 top-1/2 -translate-y-1/2 text-outline hover:text-on-surface transition-colors">
                    <span className="material-symbols-outlined text-xl">{showPw ? "visibility_off" : "visibility"}</span>
                  </button>
                </div>
              </div>
              {/* D7: TOTP second step — appears only when pendingToken is set */}
              {pendingToken !== null && (
                <div className="space-y-1.5 animate-in fade-in duration-300">
                  <div className="flex items-center gap-2 p-3 bg-primary-container/40 rounded-xl mb-1">
                    <span className="material-symbols-outlined text-primary text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>security</span>
                    <p className="text-xs text-on-surface-variant font-medium">
                      Open your authenticator app and enter the 6-digit code.
                    </p>
                  </div>
                  <label className="text-sm font-semibold text-on-surface-variant ml-1">Authenticator Code</label>
                  <div className="relative">
                    <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline text-xl">pin</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      value={totpCode}
                      onChange={e => setTotpCode(e.target.value.replace(/\D/g, ""))}
                      placeholder="123456"
                      autoFocus
                      className="w-full pl-12 pr-4 py-4 bg-surface-container-low border-none rounded-xl focus:ring-2 focus:ring-primary/30 focus:bg-white transition-all text-on-surface placeholder:text-outline-variant text-sm tracking-[0.3em] font-mono"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => { setPendingToken(null); setTotpCode(""); }}
                    className="text-xs text-on-surface-variant hover:text-primary transition-colors mt-1"
                  >
                    ← Back to password
                  </button>
                </div>
              )}
              <button type="submit" disabled={loading} className="w-full py-4 bg-primary text-on-primary rounded-full font-bold text-base shadow-lg shadow-primary/20 hover:scale-[1.02] hover:bg-primary-dim active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 flex items-center justify-center gap-2 mt-2">
                {loading ? <Spinner size={20} /> : pendingToken !== null
                  ? (<><span>Verify code</span><span className="material-symbols-outlined text-xl">verified_user</span></>)
                  : (<><span>Sign in to Sanctuary</span><span className="material-symbols-outlined text-xl">arrow_forward</span></>)
                }
              </button>
            </form>
          </div>
          <p className="text-center text-on-surface-variant font-medium">
            Don't have an account?{" "}
            <button onClick={() => setPage("signup")} className="font-bold text-primary hover:text-primary-dim transition-colors">Create account</button>
          </p>
        </div>
      </section>
    </main>
  );
}

// ── Registration Page ─────────────────────────────────────────────────────────
export function SignupPage({ setPage }: { setPage: (p: Page) => void }) {
  const { setUser } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({ name: "", email: "", password: "", confirm: "", level: "Undergraduate" });
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);

  const pwStrength = useMemo(() => checkPassword(form.password), [form.password]);

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirm) { toast("Passwords don't match", "error"); return; }
    // D1-1: Mirror backend 8–12 + complexity policy client-side for immediate feedback
    if (pwStrength.errors.length > 0) {
      toast(`Password requirements not met: ${pwStrength.errors[0]}`, "error");
      return;
    }
    setLoading(true);
    try {
      const data = await authApi.signup(form.name, form.email, form.password, form.level);
      setUser(data);
      setPage("dashboard");
      toast(`Welcome, ${data.name}! Your sanctuary awaits — check your email for a confirmation.`, "success");
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const update = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <main className="w-full min-h-screen grid lg:grid-cols-2">
      <BrandPanel />
      <section className="flex flex-col justify-center items-center p-8 lg:p-16 bg-background relative overflow-hidden overflow-y-auto">
        <div className="absolute inset-0 opacity-60" style={{ backgroundImage: "radial-gradient(at 0% 0%, hsla(231,46%,50%,0.12) 0px, transparent 50%), radial-gradient(at 100% 100%, hsla(289,74%,57%,0.08) 0px, transparent 50%)" }} />
        <div className="relative w-full max-w-md space-y-8 py-8">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 mb-4 px-3 py-1.5 bg-tertiary-container/40 rounded-full">
              <span className="material-symbols-outlined text-sm text-tertiary" style={{ fontVariationSettings: "'FILL' 1" }}>person_add</span>
              <span className="text-xs font-bold text-on-tertiary-container uppercase tracking-widest">New Member</span>
            </div>
            <h2 className="font-headline text-3xl font-bold text-on-background">Create account</h2>
            <p className="text-on-surface-variant">Begin your personalised learning journey today.</p>
          </div>
          <div className="bg-surface-container-lowest rounded-2xl p-8 shadow-[0_20px_50px_rgba(68,86,186,0.05)] border border-white/60">
            <form onSubmit={handle} className="space-y-4">
              {[
                { key: "name" as const, label: "Full name", icon: "person", type: "text", placeholder: "Your full name" },
                { key: "email" as const, label: "Email address", icon: "mail", type: "email", placeholder: "name@university.edu" },
              ].map(({ key, label, icon, type, placeholder }) => (
                <div key={key} className="space-y-1.5">
                  <label className="text-sm font-semibold text-on-surface-variant ml-1">{label}</label>
                  <div className="relative">
                    <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline text-xl">{icon}</span>
                    <input type={type} value={form[key]} onChange={update(key)} placeholder={placeholder} required className="w-full pl-12 pr-4 py-3.5 bg-surface-container-low border-none rounded-xl focus:ring-2 focus:ring-primary/30 transition-all text-sm" />
                  </div>
                </div>
              ))}
              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-on-surface-variant ml-1">Student level</label>
                <div className="relative">
                  <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline text-xl">school</span>
                  <select value={form.level} onChange={update("level")} className="w-full pl-12 pr-4 py-3.5 bg-surface-container-low border-none rounded-xl focus:ring-2 focus:ring-primary/30 transition-all text-sm appearance-none cursor-pointer">
                    <option value="High School">High School</option>
                    <option value="Undergraduate">Undergraduate</option>
                    <option value="Postgraduate">Postgraduate</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-on-surface-variant ml-1">
                  Password{" "}
                  <span className="text-outline text-xs font-normal">(8–12 chars, upper, lower, digit, special)</span>
                </label>
                <div className="relative">
                  <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline text-xl">lock</span>
                  <input
                    type={showPw ? "text" : "password"}
                    value={form.password}
                    onChange={update("password")}
                    placeholder="e.g. Secure@1"
                    required
                    className="w-full pl-12 pr-12 py-3.5 bg-surface-container-low border-none rounded-xl focus:ring-2 focus:ring-primary/30 transition-all text-sm"
                  />
                  <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute right-4 top-1/2 -translate-y-1/2 text-outline hover:text-on-surface transition-colors">
                    <span className="material-symbols-outlined text-xl">{showPw ? "visibility_off" : "visibility"}</span>
                  </button>
                </div>
                {/* Live strength indicator — D1-1 */}
                <PasswordStrengthBar password={form.password} />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-semibold text-on-surface-variant ml-1">Confirm password</label>
                <div className="relative">
                  <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline text-xl">lock_reset</span>
                  <input type={showPw ? "text" : "password"} value={form.confirm} onChange={update("confirm")} placeholder="Repeat password" required className="w-full pl-12 pr-4 py-3.5 bg-surface-container-low border-none rounded-xl focus:ring-2 focus:ring-primary/30 transition-all text-sm" />
                </div>
                {form.confirm && form.password !== form.confirm && (
                  <p className="text-xs text-red-500 font-semibold mt-1">Passwords don't match</p>
                )}
              </div>
              <button
                type="submit"
                disabled={loading || pwStrength.errors.length > 0}
                className="w-full py-4 bg-primary text-on-primary rounded-full font-bold text-base shadow-lg shadow-primary/20 hover:scale-[1.02] hover:bg-primary-dim active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 flex items-center justify-center gap-2 mt-2"
              >
                {loading ? <Spinner size={20} /> : (<><span>Create my sanctuary</span><span className="material-symbols-outlined text-xl">arrow_forward</span></>)}
              </button>
            </form>
          </div>
          <p className="text-center text-on-surface-variant font-medium">
            Already have an account?{" "}
            <button onClick={() => setPage("login")} className="font-bold text-primary hover:text-primary-dim transition-colors">Sign in</button>
          </p>
        </div>
      </section>
    </main>
  );
}
