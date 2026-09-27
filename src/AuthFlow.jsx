import React, { useState, useEffect, useRef } from "react";
import {
  User, LogOut, ChevronRight, ChevronLeft, ShieldCheck, Plus,
  Mail, Lock, Eye, EyeOff, Check, ArrowRight, Phone, Camera,
  MapPin, KeyRound, Trash2, Pencil, X, Crown, PackageCheck, Ruler,
} from "lucide-react";
import { supabase } from "./supabaseClient";

// Remembered accounts (one entry per account that has ever signed in on this
// device) are kept in localStorage as { id, name, email, refresh_token }.
// This is what powers the "Continue as X" quick option: Supabase itself only
// holds one live session, so switching accounts means calling
// supabase.auth.setSession() with a different stored refresh token.
const REMEMBERED_KEY = "razariser_remembered_accounts";
// Set for the current browser tab once someone picks "Continue as Guest" or
// closes the popup, so it doesn't reappear on every click within the same
// session. Clears when the tab/browser closes.
const GUEST_KEY = "razariser_guest_dismissed";

function loadRemembered() {
  try {
    return JSON.parse(localStorage.getItem(REMEMBERED_KEY)) || [];
  } catch {
    return [];
  }
}

function saveRemembered(list) {
  localStorage.setItem(REMEMBERED_KEY, JSON.stringify(list));
}

function upsertRemembered(account) {
  const list = loadRemembered().filter((a) => a.id !== account.id);
  list.unshift(account);
  saveRemembered(list);
  return list;
}

function removeRemembered(id) {
  const list = loadRemembered().filter((a) => a.id !== id);
  saveRemembered(list);
  return list;
}

// Gold / bronze / bone family — every remembered account gets a shade from
// the same seal-wax palette instead of a random bright color.
const AVATAR_COLORS = ["#C9A227", "#8C6D1F", "#B08900", "#6E5B2A", "#D4AF37"];
const colorFor = (id) => {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
};
const initials = (name = "") =>
  name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();

const SERIF = { fontFamily: "'Playfair Display', serif" };

// Defensively turns ANY error shape Supabase (or a failed network request)
// might hand back into a safe, readable string. Without this, a malformed
// or empty error body (e.g. from a CORS failure or misconfigured project)
// can end up rendering literally as "{}" or "[object Object]" in the UI.
function getErrorMessage(err, fallback = "Something went wrong. Please try again.") {
  if (!err) return fallback;
  if (typeof err.message === "string" && err.message.trim() && err.message.trim() !== "{}") {
    return err.message;
  }
  return fallback;
}

export default function AuthFlow() {
  const [accounts, setAccounts] = useState([]);
  const [active, setActive] = useState(null); // {id, name, email}
  const [membership, setMembership] = useState(null); // {status, currentPeriodEnd} | null
  // Steps: loading | auth (unified sign in/up card — signup itself moves
  // through name/email/password -> OTP inline via signupPhase, rather than
  // separate top-level steps) | forgot-password | verify-reset-otp |
  // new-password | home | profile | membership | addresses |
  // change-password | hidden
  const [step, setStep] = useState("loading");
  const [signupPhase, setSignupPhase] = useState("details"); // "details" | "otp"
  const [pendingEmail, setPendingEmail] = useState("");
  const [pendingName, setPendingName] = useState("");
  const [pendingPhone, setPendingPhone] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  // On load: check for a live Supabase session. Never auto-open the auth
  // card for a signed-out visitor — it now only opens when they explicitly
  // click Sign In or trigger checkout (both fire razariser:open-auth).
  useEffect(() => {
    (async () => {
      const remembered = loadRemembered();
      setAccounts(remembered);
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        const profile = await fetchProfile(data.session.user.id);
        setActive(profile);
        fetchMembership(profile.id);
        setStep("home");
      } else {
        setStep("hidden");
      }
    })();
  }, []);

  // Fallback for if the "Reset Password" email template still contains
  // {{ .ConfirmationURL }} (link-based) rather than only {{ .Token }}:
  // Supabase fires this when someone lands back on the site from that
  // link. The primary path now is entering the 6-digit code on the
  // verify-reset-otp screen, but this keeps old/cached emails working too.
  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setError("");
        setStep("new-password");
      }
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  // The vanilla storefront JS (index.html) dispatches this when someone who
  // isn't signed in tries to check out — e.g.
  //   window.dispatchEvent(new CustomEvent('razariser:open-auth'))
  // Without this listener the popup has no way to reopen once someone has
  // dismissed it as a guest this tab (step === "hidden"), so checkout would
  // silently do nothing. This clears that dismissal and forces the card back
  // open, unless someone is already signed in and on the home screen.
  useEffect(() => {
    function handleOpenRequest() {
      sessionStorage.removeItem(GUEST_KEY);
      setStep((prev) => (prev === "home" ? prev : "auth"));
    }
    window.addEventListener("razariser:open-auth", handleOpenRequest);
    return () => window.removeEventListener("razariser:open-auth", handleOpenRequest);
  }, []);

  async function fetchProfile(userId) {
    const { data } = await supabase
      .from("profiles")
      .select("id, full_name, email, phone, avatar_url, created_at")
      .eq("id", userId)
      .single();
    return {
      id: data.id,
      name: data.full_name,
      email: data.email,
      phone: data.phone || "",
      avatarUrl: data.avatar_url || null,
      createdAt: data.created_at,
    };
  }

  async function fetchMembership(userId) {
    const { data } = await supabase
      .from("memberships")
      .select("status, current_period_end")
      .eq("user_id", userId)
      .maybeSingle();
    setMembership(data ? { status: data.status, currentPeriodEnd: data.current_period_end } : { status: "none" });
  }

  async function handleContinueAs(account) {
    setError("");
    setBusy(true);
    const { error: sessErr } = await supabase.auth.setSession({
      refresh_token: account.refresh_token,
      access_token: account.access_token,
    });
    setBusy(false);
    if (sessErr) {
      setError("This session has expired. Please sign in again.");
      setAccounts(removeRemembered(account.id));
      return;
    }
    setActive(account);
    fetchMembership(account.id);
    setStep("home");
    setToast(`Signed in as ${account.name}`);
  }

  function handleDismiss() {
    sessionStorage.setItem(GUEST_KEY, "1");
    setStep("hidden");
  }

  async function handleForgotPassword(email) {
    setError("");
    const clean = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true);
    const { error: resetErr } = await supabase.auth.resetPasswordForEmail(clean, {
      redirectTo: window.location.origin + window.location.pathname,
    });
    setBusy(false);
    // Supabase doesn't reveal whether the email exists, by design — always
    // show the same confirmation either way so this can't be used to probe
    // for registered accounts.
    if (resetErr) {
      setError("Couldn't send reset code. Try again in a moment.");
      return;
    }
    setPendingEmail(clean);
    setStep("verify-reset-otp");
  }

  // NOTE: for this to show a 6-digit code, the "Reset Password" email
  // template in the Supabase dashboard needs to include {{ .Token }}
  // (not just {{ .ConfirmationURL }}) — otherwise the email only has a
  // link and there's no code for the user to enter here.
  async function handleVerifyResetOtp(token) {
    setError("");
    setBusy(true);
    const { error: verifyErr } = await supabase.auth.verifyOtp({
      email: pendingEmail,
      token,
      type: "recovery",
    });
    setBusy(false);
    if (verifyErr) {
      setError(getErrorMessage(verifyErr, "Invalid or expired code. Please try again."));
      return;
    }
    // verifyOtp establishes a live session on success, so the existing
    // new-password screen (which calls supabase.auth.updateUser) works
    // unchanged from here.
    setError("");
    setStep("new-password");
  }

  async function handleResendResetOtp() {
    setError("");
    setBusy(true);
    const { error: resendErr } = await supabase.auth.resetPasswordForEmail(pendingEmail, {
      redirectTo: window.location.origin + window.location.pathname,
    });
    setBusy(false);
    if (resendErr) {
      setError("Couldn't resend code. Try again in a moment.");
      return;
    }
    setToast("New code sent");
  }

  async function handleSetNewPassword(pw) {
    setError("");
    if (pw.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    setBusy(true);
    const { error: updateErr } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (updateErr) {
      setError(getErrorMessage(updateErr, "Couldn't update password. Please try again."));
      return;
    }
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      const profile = await fetchProfile(data.session.user.id);
      const remembered = {
        ...profile,
        refresh_token: data.session.refresh_token,
        access_token: data.session.access_token,
      };
      setAccounts(upsertRemembered(remembered));
      setActive(profile);
      fetchMembership(profile.id);
      setStep("home");
    } else {
      setStep("auth");
    }
    setToast("Password updated");

    // Notify the account owner by email that their password changed —
    // fire-and-forget, since the reset itself already succeeded above.
    fetch("/api/customers?action=password-changed-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: pendingEmail || (data.session && data.session.user.email) }),
    }).catch(() => {});
  }

  // Handles sign in, called from the unified card. Sign up is handled by
  // handleStartSignup/handleVerifySignupOtp below, since it's a 2-stage
  // flow (details -> email OTP) rather than one submit.
  async function handleAuthSubmit({ mode, email, password }) {
    setError("");
    const clean = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      return setError("Enter a valid email address.");
    }
    if (password.length < 6) {
      return setError("Password must be at least 6 characters.");
    }

    setBusy(true);
    const { data, error: signErr } = await supabase.auth.signInWithPassword({
      email: clean,
      password,
    });
    setBusy(false);
    if (signErr) {
      setError("No account found or incorrect password.");
      return;
    }
    const profile = await fetchProfile(data.user.id);
    const { data: sessionData } = await supabase.auth.getSession();
    const remembered = {
      ...profile,
      refresh_token: sessionData.session.refresh_token,
      access_token: sessionData.session.access_token,
    };
    setAccounts(upsertRemembered(remembered));
    setActive(profile);
    fetchMembership(profile.id);
    setStep("home");
    setToast(`Signed in as ${profile.name}`);
  }

  // Stage 1 of signup: collect name/email/password (+ optional phone, not
  // verified — just stored as contact info), create the account, and email
  // a 6-digit confirmation code. No SMS/phone provider required.
  async function handleStartSignup({ name, email, phone, password }) {
    setError("");
    const clean = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      return setError("Enter a valid email address.");
    }
    if (name.trim().length < 2) {
      return setError("Enter your full name.");
    }
    if (password.length < 6) {
      return setError("Password must be at least 6 characters.");
    }

    setBusy(true);
    const { error: signUpErr } = await supabase.auth.signUp({
      email: clean,
      password,
      options: { data: { full_name: name.trim(), phone: phone.trim() || null } },
    });
    setBusy(false);
    if (signUpErr) {
      setError(getErrorMessage(signUpErr, "Couldn't create your account. Please try again."));
      return;
    }
    setPendingName(name.trim());
    setPendingEmail(clean);
    setPendingPhone(phone.trim());
    setSignupPhase("otp");
  }

  // "Change email" link on the OTP row — back to editable details, no API call.
  function handleChangeNumber() {
    setError("");
    setSignupPhase("details");
  }

  // Stage 2: verify the emailed code. Success confirms the account and signs
  // them in (password was already set in stage 1, so there's nothing left
  // to collect — this directly finishes signup).
  async function handleVerifySignupOtp(token) {
    setError("");
    setBusy(true);
    const { data, error: verifyErr } = await supabase.auth.verifyOtp({
      email: pendingEmail,
      token,
      type: "signup",
    });
    if (verifyErr) {
      setBusy(false);
      setError(getErrorMessage(verifyErr, "Invalid or expired code. Please try again."));
      return;
    }
    const { error: profileErr } = await supabase.from("profiles").upsert({
      id: data.user.id,
      full_name: pendingName,
      email: pendingEmail,
      phone: pendingPhone || null,
    });
    setBusy(false);
    if (profileErr) {
      setError(getErrorMessage(profileErr, "Account created, but couldn't save your profile details."));
      return;
    }
    const profile = { id: data.user.id, name: pendingName, email: pendingEmail, phone: pendingPhone };
    const { data: sessionData } = await supabase.auth.getSession();
    const remembered = {
      ...profile,
      refresh_token: sessionData.session.refresh_token,
      access_token: sessionData.session.access_token,
    };
    setAccounts(upsertRemembered(remembered));
    setActive(profile);
    fetchMembership(profile.id);
    setSignupPhase("details");
    setStep("home");
    setToast(`Welcome, ${profile.name}`);
  }

  async function handleResendSignupOtp() {
    setError("");
    setBusy(true);
    const { error: resendErr } = await supabase.auth.resend({ type: "signup", email: pendingEmail });
    setBusy(false);
    if (resendErr) {
      setError(getErrorMessage(resendErr, "Couldn't resend code. Try again in a moment."));
      return;
    }
    setToast("New code sent");
  }

  async function handleSignOut({ forgetDevice } = {}) {
    await supabase.auth.signOut();
    if (forgetDevice) setAccounts(removeRemembered(active.id));
    setActive(null);
    setMembership(null);
    setStep("auth");
    setToast("Signed out");
  }

  async function handleDeleteAccount() {
    setBusy(true);
    const { error: fnErr } = await supabase.functions.invoke("delete-account");
    setBusy(false);
    if (fnErr) {
      setToast("Couldn't delete account. Try again.");
      return;
    }
    setAccounts(removeRemembered(active.id));
    setActive(null);
    setStep("auth");
    setToast("Account deleted");
  }

  if (step === "loading" || step === "hidden") return null;

  return (
    <div
      id="razariserAuthOverlay"
      onClick={handleDismiss}
      style={{ fontFamily: "'Montserrat', ui-sans-serif, system-ui" }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md bg-[#111111] border border-[#C9A227]/15 rounded-2xl shadow-2xl shadow-black/60 p-8 max-h-[92vh] overflow-y-auto flex flex-col"
      >
        <button
          onClick={handleDismiss}
          aria-label="Close"
          className="absolute top-4 right-4 text-[#6B675E] hover:text-[#F3EFE4] transition-colors"
        >
          <X size={18} />
        </button>
        <div className="flex flex-col flex-1 min-h-[520px]">
        {step === "auth" && (
          <AuthCard
            accounts={accounts}
            onContinueAs={handleContinueAs}
            onGuest={handleDismiss}
            onSubmit={handleAuthSubmit}
            signupPhase={signupPhase}
            onStartSignup={handleStartSignup}
            onVerifySignupOtp={handleVerifySignupOtp}
            onResendSignupOtp={handleResendSignupOtp}
            onChangeNumber={handleChangeNumber}
            onForgotPassword={() => { setError(""); setStep("forgot-password"); }}
            error={error}
            busy={busy}
            showPw={showPw}
            setShowPw={setShowPw}
          />
        )}
        {step === "forgot-password" && (
          <ForgotPasswordScreen
            defaultEmail={pendingEmail} busy={busy}
            onBack={() => setStep("auth")}
            onSubmit={handleForgotPassword}
            error={error}
          />
        )}
        {step === "verify-reset-otp" && (
          <OtpScreen
            identifier={pendingEmail}
            title="Check your email"
            subtitle="Enter the 6-digit code we sent to"
            onBack={() => setStep("forgot-password")}
            onSubmit={handleVerifyResetOtp}
            onResend={handleResendResetOtp}
            error={error}
            busy={busy}
          />
        )}
        {step === "new-password" && (
          <NewPasswordScreen
            busy={busy} showPw={showPw} setShowPw={setShowPw}
            onSubmit={handleSetNewPassword}
            error={error}
          />
        )}
        {step === "home" && active && (
          <HomeScreen account={active} accounts={accounts} membership={membership} onSwitch={() => setStep("auth")} onSignOut={handleSignOut} onOpenProfile={() => setStep("profile")} onOpenMembership={() => setStep("membership")} />
        )}
        {step === "profile" && active && (
          <ProfileScreen
            account={active}
            busy={busy}
            onBack={() => setStep("home")}
            onSaved={(updated) => {
              setActive(updated);
              setAccounts(upsertRemembered({ ...accounts.find((a) => a.id === updated.id), ...updated }));
              setToast("Profile updated");
            }}
            onOpenAddresses={() => setStep("addresses")}
            onOpenChangePassword={() => setStep("change-password")}
            onOpenMembership={() => setStep("membership")}
            membership={membership}
            onDeleteAccount={handleDeleteAccount}
          />
        )}
        {step === "membership" && active && (
          <MembershipScreen
            account={active}
            membership={membership}
            onBack={() => setStep("profile")}
            onRefresh={() => fetchMembership(active.id)}
            onCancelled={() => setToast("Membership will end after this billing period")}
          />
        )}
        {step === "addresses" && active && (
          <AddressesScreen userId={active.id} onBack={() => setStep("profile")} />
        )}
        {step === "change-password" && active && (
          <ChangePasswordScreen
            onBack={() => setStep("profile")}
            onDone={() => { setToast("Password updated"); setStep("profile"); }}
          />
        )}
        </div>
      </div>
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-[#111111] border border-[#C9A227]/20 text-[#F3EFE4] text-sm px-4 py-2.5 rounded-lg shadow-lg flex items-center gap-2">
          <Check size={15} className="text-[#C9A227]" /> {toast}
        </div>
      )}
    </div>
  );
}

// ---------- unified auth card (new) ----------

function AuthCard({ accounts, onContinueAs, onGuest, onSubmit, signupPhase, onStartSignup, onVerifySignupOtp, onResendSignupOtp, onChangeNumber, onForgotPassword, error, busy, showPw, setShowPw }) {
  const [mode, setMode] = useState("signin"); // "signin" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showAccounts, setShowAccounts] = useState(accounts.length > 0);

  function handleSignInSubmit(e) {
    e.preventDefault();
    onSubmit({ mode: "signin", email, password });
  }

  return (
    <div className="flex flex-col h-full">
      <div className="text-center mb-6">
        <h2 style={SERIF} className="text-2xl font-semibold text-[#C9A227] tracking-wide">RAZARISER</h2>
        <p className="text-sm text-[#9C9585] mt-1">Style for the riser.</p>
      </div>

      {showAccounts && accounts.length > 0 && (
        <div className="flex flex-col gap-2 mb-5">
          {accounts.map((a) => (
            <button key={a.id} onClick={() => onContinueAs(a)}
              className="group flex items-center gap-3 border border-white/10 hover:border-[#C9A227] hover:bg-white/5 rounded-xl px-4 py-3 transition-colors">
              <div className="w-9 h-9 rounded-full flex items-center justify-center text-black text-sm font-semibold shrink-0" style={{ background: colorFor(a.id) }}>
                {initials(a.name)}
              </div>
              <div className="min-w-0 flex-1 text-left">
                <div className="text-sm font-medium text-[#F3EFE4] truncate">Continue as {a.name}</div>
                <div className="text-xs text-[#9C9585] truncate">{a.email}</div>
              </div>
              <ChevronRight size={16} className="text-[#6B675E] group-hover:text-[#C9A227]" />
            </button>
          ))}
          <button onClick={() => setShowAccounts(false)} className="text-xs text-[#9C9585] hover:text-[#F3EFE4] self-center mt-1">
            Use a different account
          </button>
          <div className="h-px bg-white/10 my-2" />
        </div>
      )}

      {(!showAccounts || accounts.length === 0) && (
        <>
          <div className="flex border border-white/10 rounded-xl p-1 mb-5">
            <button
              type="button"
              onClick={() => setMode("signin")}
              className={`flex-1 text-sm font-medium py-2 rounded-lg transition-colors ${
                mode === "signin" ? "bg-[#C9A227] text-black" : "text-[#9C9585] hover:text-[#F3EFE4]"
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => setMode("signup")}
              className={`flex-1 text-sm font-medium py-2 rounded-lg transition-colors ${
                mode === "signup" ? "bg-[#C9A227] text-black" : "text-[#9C9585] hover:text-[#F3EFE4]"
              }`}
            >
              Create Account
            </button>
          </div>

          {mode === "signin" ? (
            <form onSubmit={handleSignInSubmit} className="flex flex-col gap-4">
              <Field icon={<Mail size={16} />} label="Email address" type="email" value={email} onChange={setEmail} placeholder="you@example.com" autoFocus />
              <Field icon={<Lock size={16} />} label="Password" type={showPw ? "text" : "password"} value={password} onChange={setPassword}
                placeholder="Enter your password"
                endAdornment={<button type="button" tabIndex={-1} onClick={() => setShowPw((v) => !v)} className="text-[#9C9585]">{showPw ? <EyeOff size={16} /> : <Eye size={16} />}</button>} />
              <button type="button" onClick={onForgotPassword} className="text-xs text-[#C9A227] hover:underline self-end -mt-2">
                Forgot password?
              </button>
              {error && <p className="text-xs text-[#E5534B]">{error}</p>}
              <PrimaryButton type="submit" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </PrimaryButton>
            </form>
          ) : (
            <SignupForm
              phase={signupPhase}
              onSendCode={onStartSignup}
              onVerifyCode={onVerifySignupOtp}
              onResendCode={onResendSignupOtp}
              onChangeNumber={onChangeNumber}
              error={error}
              busy={busy}
              showPw={showPw}
              setShowPw={setShowPw}
            />
          )}

          {accounts.length > 0 && (
            <button onClick={() => setShowAccounts(true)} className="text-xs text-[#9C9585] hover:text-[#F3EFE4] self-center mt-4">
              Back to saved accounts
            </button>
          )}
        </>
      )}

      <button onClick={onGuest} className="text-sm text-[#9C9585] hover:text-[#F3EFE4] py-2 mt-4 self-center transition-colors">
        Continue as Guest
      </button>
    </div>
  );
}

// One continuous form for signup: name/email/password(/phone), then (once
// the account is created and a code is emailed) OTP boxes appear below.
// Nothing here navigates to a different screen — `phase` (from AuthFlow's
// signupPhase state) just reveals more of the same form. No SMS/phone
// verification is used — the code is emailed via Supabase's signup OTP.
function SignupForm({ phase, onSendCode, onVerifyCode, onResendCode, onChangeNumber, error, busy, showPw, setShowPw }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  function handleOtpChange(code) {
    setOtp(code);
    if (code.length === 6 && phase === "otp" && !busy) onVerifyCode(code);
  }

  function handleResend() {
    if (cooldown > 0 || busy) return;
    onResendCode();
    setCooldown(60);
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (phase === "details") {
      onSendCode({ name, email, phone, password });
    } else if (phase === "otp") {
      if (otp.length === 6) onVerifyCode(otp);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Field icon={<User size={16} />} label="Full name" value={name} onChange={setName} placeholder="Your name" autoFocus disabled={phase !== "details"} />
      <Field icon={<Mail size={16} />} label="Email address" type="email" value={email} onChange={setEmail} placeholder="you@example.com" disabled={phase !== "details"} />
      <Field icon={<Lock size={16} />} label="Password" type={showPw ? "text" : "password"} value={password} onChange={setPassword}
        placeholder="At least 6 characters" disabled={phase !== "details"}
        endAdornment={<button type="button" tabIndex={-1} onClick={() => setShowPw((v) => !v)} className="text-[#9C9585]">{showPw ? <EyeOff size={16} /> : <Eye size={16} />}</button>} />
      <Field icon={<Phone size={16} />} label="Mobile number (optional)" type="tel" value={phone} onChange={setPhone} placeholder="For order updates" disabled={phase !== "details"} />

      {phase === "otp" && (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-[#D8D2C2]">Check your email for a verification code</span>
          <OtpDigitBoxes onChange={handleOtpChange} disabled={busy} />
          <div className="flex items-center justify-between mt-1">
            <button type="button" onClick={onChangeNumber} className="text-xs text-[#9C9585] hover:text-[#F3EFE4]">
              Change email
            </button>
            <button
              type="button"
              onClick={handleResend}
              disabled={cooldown > 0 || busy}
              className="text-xs text-[#C9A227] hover:underline disabled:text-[#6B675E] disabled:no-underline disabled:cursor-not-allowed"
            >
              {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-[#E5534B]">{error}</p>}

      {phase === "details" && (
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? "Creating account…" : "Create account"}
        </PrimaryButton>
      )}
      {phase === "otp" && (
        <PrimaryButton type="submit" disabled={busy || otp.length < 6}>
          {busy ? "Verifying…" : "Verify code"}
        </PrimaryButton>
      )}
    </form>
  );
}

// Six separate digit boxes (auto-advance, backspace, paste support). Calls
// onChange with the current joined code on every keystroke — the parent
// decides what "complete" (length 6) means for it (auto-verify, enabling a
// button, etc.) rather than this component deciding that itself.
function OtpDigitBoxes({ onChange, disabled, autoFocus = true }) {
  const [digits, setDigits] = useState(Array(6).fill(""));
  const inputsRef = useRef([]);

  function update(next) {
    setDigits(next);
    onChange(next.join(""));
  }

  function handleChange(index, raw) {
    const val = raw.replace(/[^0-9]/g, "").slice(-1);
    const next = [...digits];
    next[index] = val;
    update(next);
    if (val && index < 5) inputsRef.current[index + 1]?.focus();
  }

  function handleKeyDown(index, e) {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      inputsRef.current[index - 1]?.focus();
      const next = [...digits];
      next[index - 1] = "";
      update(next);
    }
  }

  function handlePaste(e) {
    const text = e.clipboardData.getData("text").replace(/[^0-9]/g, "").slice(0, 6);
    if (!text) return;
    e.preventDefault();
    const next = Array(6).fill("");
    for (let i = 0; i < text.length; i++) next[i] = text[i];
    update(next);
    inputsRef.current[Math.min(text.length, 5)]?.focus();
  }

  return (
    <div className="flex justify-between gap-2" onPaste={handlePaste}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => (inputsRef.current[i] = el)}
          type="text"
          inputMode="numeric"
          maxLength={1}
          autoFocus={autoFocus && i === 0}
          disabled={disabled}
          value={d}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          className="w-11 aspect-square text-center text-lg font-semibold text-[#F3EFE4] bg-black/40 border border-white/15 focus:border-[#C9A227] disabled:opacity-50 rounded-lg outline-none"
        />
      ))}
    </div>
  );
}

function ForgotPasswordScreen({ defaultEmail, onBack, onSubmit, error, busy }) {
  const [email, setEmail] = useState(defaultEmail || "");
  return (
    <div className="flex flex-col h-full">
      <TopNav onBack={onBack} />
      <h2 style={SERIF} className="text-xl font-semibold text-[#F3EFE4]">Reset your password</h2>
      <p className="text-sm text-[#9C9585] mt-1 mb-6">Enter your email and we'll send you a verification code.</p>
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(email); }} className="flex flex-col gap-4">
        <Field icon={<Mail size={16} />} label="Email address" type="email" value={email} onChange={setEmail} placeholder="you@example.com" autoFocus />
        {error && <p className="text-xs text-[#E5534B]">{error}</p>}
        <PrimaryButton type="submit" disabled={busy}>{busy ? "Sending…" : "Send code"}</PrimaryButton>
      </form>
    </div>
  );
}

function OtpScreen({ identifier, title, subtitle, onBack, onSubmit, onResend, error, busy }) {
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  function handleChange(next) {
    setCode(next);
    if (next.length === 6 && !busy) onSubmit(next);
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (code.length === 6) onSubmit(code);
  }

  function handleResend() {
    if (cooldown > 0 || busy) return;
    onResend();
    setCooldown(60);
  }

  return (
    <div className="flex flex-col h-full">
      <TopNav onBack={onBack} />
      <div className="w-12 h-12 rounded-full bg-[#C9A227]/10 flex items-center justify-center mb-4">
        <ShieldCheck size={20} className="text-[#C9A227]" />
      </div>
      <h2 style={SERIF} className="text-xl font-semibold text-[#F3EFE4] mb-2">{title}</h2>
      <p className="text-sm text-[#9C9585] mb-1">{subtitle}</p>
      <p className="text-sm text-[#F3EFE4] font-medium mb-6 truncate max-w-full">{identifier}</p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <OtpDigitBoxes onChange={handleChange} disabled={busy} />
        {error && <p className="text-xs text-[#E5534B]">{error}</p>}
        <PrimaryButton type="submit" disabled={busy || code.length < 6}>
          {busy ? "Verifying…" : "Verify code"}
        </PrimaryButton>
      </form>
      <button
        type="button"
        onClick={handleResend}
        disabled={cooldown > 0 || busy}
        className="text-xs text-[#C9A227] hover:underline self-center mt-5 disabled:text-[#6B675E] disabled:no-underline disabled:cursor-not-allowed"
      >
        {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
      </button>
      <p className="text-xs text-[#6B675E] text-center mt-6">Didn't get it? Check your spam folder.</p>
    </div>
  );
}

function NewPasswordScreen({ onSubmit, error, busy, showPw, setShowPw }) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState("");

  function handleSubmit(e) {
    e.preventDefault();
    setLocalError("");
    if (pw !== confirm) {
      setLocalError("Passwords don't match.");
      return;
    }
    onSubmit(pw);
  }

  return (
    <div className="flex flex-col h-full">
      <h2 style={SERIF} className="text-xl font-semibold text-[#F3EFE4]">Set a new password</h2>
      <p className="text-sm text-[#9C9585] mt-1 mb-6">Choose a new password for your account.</p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field icon={<Lock size={16} />} label="New password" type={showPw ? "text" : "password"} value={pw} onChange={setPw}
          placeholder="At least 6 characters" autoFocus
          endAdornment={<button type="button" tabIndex={-1} onClick={() => setShowPw((v) => !v)} className="text-[#9C9585]">{showPw ? <EyeOff size={16} /> : <Eye size={16} />}</button>} />
        <Field icon={<Lock size={16} />} label="Confirm new password" type={showPw ? "text" : "password"} value={confirm} onChange={setConfirm} placeholder="Re-enter password" />
        {(localError || error) && <p className="text-xs text-[#E5534B]">{localError || error}</p>}
        <PrimaryButton type="submit" disabled={busy}>{busy ? "Updating…" : "Update password"}</PrimaryButton>
      </form>
    </div>
  );
}

function HomeScreen({ account, accounts, membership, onSwitch, onSignOut, onOpenProfile, onOpenMembership }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const others = accounts.filter((a) => a.id !== account.id);
  const isMember = membership?.status === "active";
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-2">
        <span className="inline-flex items-center gap-1 text-xs text-[#C9A227] bg-[#C9A227]/10 px-2.5 py-1 rounded-full font-medium">
          <Check size={13} /> Active
        </span>
        <button
          onClick={onOpenProfile}
          aria-label="Profile"
          title="Profile"
          className="w-9 h-9 rounded-full flex items-center justify-center border border-white/10 text-[#F3EFE4] hover:border-[#C9A227] hover:text-[#C9A227] transition-colors"
        >
          <User size={17} />
        </button>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <div className="w-12 h-12 rounded-full flex items-center justify-center text-black font-semibold" style={{ background: colorFor(account.id) }}>
          {initials(account.name)}
        </div>
        <div>
          <div className="text-xs text-[#9C9585]">Signed in as</div>
          <div style={SERIF} className="font-semibold text-[#F3EFE4]">{account.name}</div>
        </div>
      </div>

      <button
        onClick={onOpenMembership}
        className={`flex items-center justify-between rounded-xl px-4 py-3 mb-4 transition-colors ${
          isMember
            ? "bg-[#C9A227] text-black"
            : "border border-dashed border-[#C9A227]/50 text-[#F3EFE4] hover:bg-[#C9A227]/5"
        }`}
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          <Crown size={16} className={isMember ? "text-black" : "text-[#C9A227]"} />
          {isMember ? "Razariser Membership — Active" : "Become a member — ₹150/mo"}
        </span>
        <ChevronRight size={16} className={isMember ? "text-black/60" : "text-[#9C9585]"} />
      </button>

      {others.length > 0 && (
        <button onClick={onSwitch} className="flex items-center justify-between text-sm text-[#F3EFE4] border border-white/10 rounded-xl px-4 py-3 mb-3 hover:border-[#C9A227]">
          <span>Switch account ({others.length} other{others.length > 1 ? "s" : ""})</span>
          <ArrowRight size={15} className="text-[#9C9585]" />
        </button>
      )}

      <div className="mt-auto pt-4 border-t border-white/10">
        {!confirmOpen ? (
          <button onClick={() => setConfirmOpen(true)} className="flex items-center gap-2 text-sm font-medium text-[#E5534B] hover:underline">
            <LogOut size={15} /> Sign out
          </button>
        ) : (
          <div className="border border-white/10 rounded-xl p-4">
            <p className="text-sm text-[#F3EFE4] mb-3">Sign out of Razariser on this device?</p>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => onSignOut({ forgetDevice: false })} className="text-sm font-medium px-3.5 py-2 rounded-lg bg-[#C9A227] text-black hover:bg-[#B8911F]">Sign out</button>
              <button onClick={() => onSignOut({ forgetDevice: true })} className="text-sm font-medium px-3.5 py-2 rounded-lg border border-white/10 text-[#F3EFE4] hover:border-[#E5534B] hover:text-[#E5534B]">Sign out &amp; forget this account</button>
              <button onClick={() => setConfirmOpen(false)} className="text-sm px-3.5 py-2 text-[#9C9585]">Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ProfileScreen({ account, membership, busy, onBack, onSaved, onOpenAddresses, onOpenChangePassword, onOpenMembership, onDeleteAccount }) {
  const [name, setName] = useState(account.name);
  const [phone, setPhone] = useState(account.phone || "");
  const [avatarUrl, setAvatarUrl] = useState(account.avatarUrl);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const dirty = name.trim() !== account.name || phone.trim() !== (account.phone || "");

  const memberSince = account.createdAt
    ? new Date(account.createdAt).toLocaleDateString(undefined, { month: "long", year: "numeric" })
    : null;

  async function handleAvatarChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    setUploading(true);
    const ext = file.name.split(".").pop();
    const path = `${account.id}/avatar.${ext}`;
    const { error: uploadErr } = await supabase.storage
      .from("avatars")
      .upload(path, file, { upsert: true });
    if (uploadErr) {
      setUploading(false);
      return setError("Couldn't upload image. Try a smaller file.");
    }
    const { data } = supabase.storage.from("avatars").getPublicUrl(path);
    const publicUrl = `${data.publicUrl}?t=${Date.now()}`; // bust cache
    await supabase.from("profiles").update({ avatar_url: publicUrl }).eq("id", account.id);
    setAvatarUrl(publicUrl);
    setUploading(false);
    onSaved({ ...account, avatarUrl: publicUrl });
  }

  async function handleSave() {
    setError("");
    if (name.trim().length < 2) return setError("Enter your full name.");
    setSaving(true);
    const { error: updateErr } = await supabase
      .from("profiles")
      .update({ full_name: name.trim(), phone: phone.trim() || null })
      .eq("id", account.id);
    setSaving(false);
    if (updateErr) return setError(getErrorMessage(updateErr, "Couldn't save your profile. Please try again."));
    onSaved({ ...account, name: name.trim(), phone: phone.trim() });
  }

  return (
    <div className="flex flex-col h-full">
      <TopNav onBack={onBack} />
      <div className="flex flex-col items-center mb-8">
        <div className="relative mb-3">
          <div
            className="w-20 h-20 rounded-full flex items-center justify-center text-black text-2xl font-semibold overflow-hidden"
            style={{ background: colorFor(account.id) }}
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              initials(name || account.name)
            )}
          </div>
          <label className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-[#111111] border border-white/15 flex items-center justify-center cursor-pointer hover:border-[#C9A227]">
            <Camera size={13} className="text-[#F3EFE4]" />
            <input type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} disabled={uploading} />
          </label>
        </div>
        <h2 style={SERIF} className="text-xl font-semibold text-[#F3EFE4]">Your profile</h2>
        {memberSince && <p className="text-xs text-[#9C9585] mt-1">Member since {memberSince}</p>}
        {uploading && <p className="text-xs text-[#C9A227] mt-1">Uploading photo…</p>}
      </div>

      <div className="flex flex-col gap-4">
        <Field icon={<User size={16} />} label="Full name" value={name} onChange={setName} placeholder="Your name" />
        <Field icon={<Phone size={16} />} label="Phone number" type="tel" value={phone} onChange={setPhone} placeholder="Add a phone number" />
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-[#D8D2C2]">Email address</span>
          <div className="flex items-center gap-2 border border-white/10 rounded-lg px-3 py-2.5 bg-black/30">
            <Mail size={16} className="text-[#9C9585]" />
            <span className="text-sm text-[#9C9585]">{account.email}</span>
          </div>
        </label>
        {error && <p className="text-xs text-[#E5534B]">{error}</p>}
        <PrimaryButton onClick={handleSave} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save changes"}
        </PrimaryButton>
      </div>

      <div className="flex flex-col gap-2 mt-6 pt-6 border-t border-white/10">
        <button onClick={onOpenMembership} className="flex items-center justify-between text-sm text-[#F3EFE4] border border-white/10 rounded-xl px-4 py-3 hover:border-[#C9A227]">
          <span className="flex items-center gap-2"><Crown size={16} className="text-[#9C9585]" /> Membership</span>
          <span className="flex items-center gap-2 text-xs text-[#9C9585]">
            {membership?.status === "active" ? "Active" : "Not a member"}
            <ChevronRight size={16} />
          </span>
        </button>
        <button onClick={onOpenAddresses} className="flex items-center justify-between text-sm text-[#F3EFE4] border border-white/10 rounded-xl px-4 py-3 hover:border-[#C9A227]">
          <span className="flex items-center gap-2"><MapPin size={16} className="text-[#9C9585]" /> Manage addresses</span>
          <ChevronRight size={16} className="text-[#9C9585]" />
        </button>
        <button onClick={onOpenChangePassword} className="flex items-center justify-between text-sm text-[#F3EFE4] border border-white/10 rounded-xl px-4 py-3 hover:border-[#C9A227]">
          <span className="flex items-center gap-2"><KeyRound size={16} className="text-[#9C9585]" /> Change password</span>
          <ChevronRight size={16} className="text-[#9C9585]" />
        </button>
      </div>

      <div className="mt-6 pt-6 border-t border-white/10">
        {!confirmDelete ? (
          <button onClick={() => setConfirmDelete(true)} className="flex items-center gap-2 text-sm font-medium text-[#E5534B] hover:underline">
            <Trash2 size={15} /> Delete account
          </button>
        ) : (
          <div className="border border-[#E5534B]/30 bg-[#E5534B]/10 rounded-xl p-4">
            <p className="text-sm text-[#F3EFE4] mb-1 font-medium">Delete your account permanently?</p>
            <p className="text-xs text-[#9C9585] mb-3">This removes your profile, addresses, and login. This can't be undone.</p>
            <div className="flex flex-wrap gap-2">
              <button onClick={onDeleteAccount} disabled={busy} className="text-sm font-medium px-3.5 py-2 rounded-lg bg-[#E5534B] text-white hover:bg-[#C7362D] disabled:opacity-60">
                {busy ? "Deleting…" : "Yes, delete my account"}
              </button>
              <button onClick={() => setConfirmDelete(false)} className="text-sm px-3.5 py-2 text-[#9C9585]">Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function loadRazorpayScript() {
  return new Promise((resolve) => {
    if (window.Razorpay) return resolve(true);
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

const BENEFITS = [
  { icon: PackageCheck, title: "7-day early pre-orders", desc: "Reserve new drops a full week before everyone else." },
  { icon: Ruler, title: "14-day tailor fit", desc: "Custom-fit alterations turned around in two weeks, not the usual wait." },
];

function MembershipScreen({ account, membership, onBack, onRefresh, onCancelled }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);

  const status = membership?.status || "none";
  const isActive = status === "active";
  const isPending = status === "created";
  const isEndingSoon = status === "cancelled" && membership?.currentPeriodEnd;

  const renewalDate = membership?.currentPeriodEnd
    ? new Date(membership.currentPeriodEnd).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })
    : null;

  async function handleJoin() {
    setError("");
    setLoading(true);
    const { data, error: fnErr } = await supabase.functions.invoke("create-membership-subscription");
    if (fnErr || data?.error) {
      setLoading(false);
      return setError(getErrorMessage(fnErr, data?.error || "Couldn't start checkout. Try again."));
    }
    const ready = await loadRazorpayScript();
    setLoading(false);
    if (!ready) return setError("Couldn't load payment window. Check your connection.");

    const rzp = new window.Razorpay({
      key: data.key_id,
      subscription_id: data.subscription_id,
      name: "Razariser Membership",
      description: "₹150 / month",
      theme: { color: "#C9A227" },
      prefill: { name: account.name, email: account.email },
      handler: () => {
        onRefresh();
      },
      modal: {
        ondismiss: () => onRefresh(),
      },
    });
    rzp.open();
  }

  async function handleCancel() {
    setLoading(true);
    const { error: fnErr } = await supabase.functions.invoke("cancel-membership");
    setLoading(false);
    setConfirmCancel(false);
    if (fnErr) return setError("Couldn't cancel right now. Try again.");
    onCancelled();
    onRefresh();
  }

  return (
    <div className="flex flex-col h-full">
      <TopNav onBack={onBack} />
      <div className="flex items-center gap-2 mb-1">
        <Crown size={20} className="text-[#C9A227]" />
        <h2 style={SERIF} className="text-xl font-semibold text-[#F3EFE4]">Razariser Membership</h2>
      </div>
      <p className="text-sm text-[#9C9585] mb-6">₹150/month, billed automatically. Cancel anytime.</p>

      <div className="flex flex-col gap-3 mb-6">
        {BENEFITS.map(({ icon: Icon, title, desc }) => (
          <div key={title} className="flex items-start gap-3 border border-white/10 rounded-xl px-4 py-3">
            <div className="w-9 h-9 rounded-full bg-[#C9A227]/10 flex items-center justify-center shrink-0">
              <Icon size={16} className="text-[#C9A227]" />
            </div>
            <div>
              <div className="text-sm font-medium text-[#F3EFE4]">{title}</div>
              <div className="text-xs text-[#9C9585] mt-0.5">{desc}</div>
            </div>
          </div>
        ))}
      </div>

      {error && <p className="text-xs text-[#E5534B] mb-4">{error}</p>}

      {isActive && (
        <div className="border border-[#C9A227]/30 bg-[#C9A227]/5 rounded-xl p-4 mb-4">
          <div className="flex items-center gap-2 text-sm font-medium text-[#C9A227]">
            <Check size={15} /> You're a member
          </div>
          {renewalDate && <p className="text-xs text-[#9C9585] mt-1">Renews on {renewalDate}</p>}
        </div>
      )}

      {isEndingSoon && (
        <div className="border border-[#B08900]/30 bg-[#B08900]/5 rounded-xl p-4 mb-4">
          <p className="text-sm text-[#F3EFE4]">Membership ending{renewalDate ? ` on ${renewalDate}` : ""}.</p>
          <p className="text-xs text-[#9C9585] mt-1">Benefits stay active until then.</p>
        </div>
      )}

      {isPending && (
        <div className="border border-white/10 rounded-xl p-4 mb-4">
          <p className="text-sm text-[#F3EFE4]">Payment in progress…</p>
          <button onClick={onRefresh} className="text-xs text-[#C9A227] font-medium hover:underline mt-1">Refresh status</button>
        </div>
      )}

      {!isActive && !isPending && (
        <PrimaryButton onClick={handleJoin} disabled={loading}>
          {loading ? "Starting checkout…" : "Join for ₹150/month"}
        </PrimaryButton>
      )}

      {isActive && !confirmCancel && (
        <button onClick={() => setConfirmCancel(true)} className="text-sm text-[#E5534B] hover:underline self-start mt-2">
          Cancel membership
        </button>
      )}
      {confirmCancel && (
        <div className="border border-[#E5534B]/30 bg-[#E5534B]/10 rounded-xl p-4 mt-2">
          <p className="text-sm text-[#F3EFE4] mb-3">Cancel your membership? You'll keep benefits until the current period ends.</p>
          <div className="flex gap-2">
            <button onClick={handleCancel} disabled={loading} className="text-sm font-medium px-3.5 py-2 rounded-lg bg-[#E5534B] text-white hover:bg-[#C7362D]">
              {loading ? "Cancelling…" : "Yes, cancel"}
            </button>
            <button onClick={() => setConfirmCancel(false)} className="text-sm px-3.5 py-2 text-[#9C9585]">Keep membership</button>
          </div>
        </div>
      )}
    </div>
  );
}

function AddressesScreen({ userId, onBack }) {
  const [addresses, setAddresses] = useState(null); // null = loading
  const [editing, setEditing] = useState(null); // null | {} for new | address object

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const { data } = await supabase
      .from("addresses")
      .select("*")
      .eq("user_id", userId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false });
    setAddresses(data || []);
  }

  async function handleDelete(id) {
    await supabase.from("addresses").delete().eq("id", id);
    load();
  }

  async function handleMakeDefault(id) {
    await supabase.from("addresses").update({ is_default: false }).eq("user_id", userId);
    await supabase.from("addresses").update({ is_default: true }).eq("id", id);
    load();
  }

  if (editing !== null) {
    return (
      <AddressForm
        userId={userId}
        address={editing.id ? editing : null}
        onCancel={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); }}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <TopNav onBack={onBack} />
      <h2 style={SERIF} className="text-xl font-semibold text-[#F3EFE4] mb-1">Your addresses</h2>
      <p className="text-sm text-[#9C9585] mb-6">Manage the addresses saved to your account.</p>

      {addresses === null && <p className="text-sm text-[#9C9585]">Loading…</p>}

      <div className="flex flex-col gap-3">
        {addresses?.map((a) => (
          <div key={a.id} className="border border-white/10 rounded-xl p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[#F3EFE4]">{a.label}</span>
                  {a.is_default && <span className="text-[10px] uppercase tracking-wide text-[#C9A227] bg-[#C9A227]/10 px-1.5 py-0.5 rounded">Default</span>}
                </div>
                <p className="text-sm text-[#9C9585] mt-1 leading-relaxed">
                  {a.line1}{a.line2 ? `, ${a.line2}` : ""}<br />
                  {a.city}{a.state ? `, ${a.state}` : ""} {a.postal_code}<br />
                  {a.country}
                </p>
              </div>
              <div className="flex gap-1 shrink-0">
                <button onClick={() => setEditing(a)} className="p-1.5 text-[#9C9585] hover:text-[#C9A227]"><Pencil size={15} /></button>
                <button onClick={() => handleDelete(a.id)} className="p-1.5 text-[#9C9585] hover:text-[#E5534B]"><Trash2 size={15} /></button>
              </div>
            </div>
            {!a.is_default && (
              <button onClick={() => handleMakeDefault(a.id)} className="text-xs text-[#C9A227] font-medium hover:underline mt-2">
                Set as default
              </button>
            )}
          </div>
        ))}
      </div>

      <button onClick={() => setEditing({})} className="flex items-center gap-3 border border-dashed border-white/15 hover:border-[#C9A227] rounded-xl px-4 py-3 mt-3">
        <div className="w-8 h-8 rounded-full flex items-center justify-center bg-white/5 text-[#F3EFE4]"><Plus size={16} /></div>
        <span className="text-sm font-medium text-[#F3EFE4]">Add a new address</span>
      </button>
    </div>
  );
}

function AddressForm({ userId, address, onCancel, onSaved }) {
  const [form, setForm] = useState({
    label: address?.label || "Home",
    line1: address?.line1 || "",
    line2: address?.line2 || "",
    city: address?.city || "",
    state: address?.state || "",
    postal_code: address?.postal_code || "",
    country: address?.country || "India",
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (!form.line1 || !form.city || !form.postal_code) {
      return setError("Fill in address line, city, and postal code.");
    }
    setSaving(true);
    const payload = { ...form, user_id: userId };
    const { error: saveErr } = address
      ? await supabase.from("addresses").update(payload).eq("id", address.id)
      : await supabase.from("addresses").insert(payload);
    setSaving(false);
    if (saveErr) return setError(getErrorMessage(saveErr, "Couldn't save this address. Please try again."));
    onSaved();
  }

  return (
    <div className="flex flex-col h-full">
      <TopNav onBack={onCancel} />
      <h2 style={SERIF} className="text-xl font-semibold text-[#F3EFE4] mb-6">{address ? "Edit address" : "Add address"}</h2>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Label" value={form.label} onChange={(v) => set("label", v)} placeholder="Home, Work…" />
        <Field label="Address line 1" value={form.line1} onChange={(v) => set("line1", v)} placeholder="Street address" autoFocus />
        <Field label="Address line 2 (optional)" value={form.line2} onChange={(v) => set("line2", v)} placeholder="Apartment, suite, etc." />
        <div className="grid grid-cols-2 gap-3">
          <Field label="City" value={form.city} onChange={(v) => set("city", v)} placeholder="City" />
          <Field label="State" value={form.state} onChange={(v) => set("state", v)} placeholder="State" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Postal code" value={form.postal_code} onChange={(v) => set("postal_code", v)} placeholder="000000" />
          <Field label="Country" value={form.country} onChange={(v) => set("country", v)} placeholder="Country" />
        </div>
        {error && <p className="text-xs text-[#E5534B]">{error}</p>}
        <PrimaryButton type="submit" disabled={saving}>{saving ? "Saving…" : "Save address"}</PrimaryButton>
      </form>
    </div>
  );
}

function ChangePasswordScreen({ onBack, onDone }) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (pw.length < 6) return setError("Password must be at least 6 characters.");
    if (pw !== confirm) return setError("Passwords don't match.");
    setSaving(true);
    const { error: updateErr } = await supabase.auth.updateUser({ password: pw });
    setSaving(false);
    if (updateErr) return setError(getErrorMessage(updateErr, "Couldn't update password. Please try again."));
    onDone();
  }

  return (
    <div className="flex flex-col h-full">
      <TopNav onBack={onBack} />
      <h2 style={SERIF} className="text-xl font-semibold text-[#F3EFE4]">Change password</h2>
      <p className="text-sm text-[#9C9585] mt-1 mb-6">Choose a new password for your account.</p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field icon={<Lock size={16} />} label="New password" type={showPw ? "text" : "password"} value={pw} onChange={setPw}
          placeholder="At least 6 characters" autoFocus
          endAdornment={<button type="button" tabIndex={-1} onClick={() => setShowPw((v) => !v)} className="text-[#9C9585]">{showPw ? <EyeOff size={16} /> : <Eye size={16} />}</button>} />
        <Field icon={<Lock size={16} />} label="Confirm new password" type={showPw ? "text" : "password"} value={confirm} onChange={setConfirm} placeholder="Re-enter password" />
        {error && <p className="text-xs text-[#E5534B]">{error}</p>}
        <PrimaryButton type="submit" disabled={saving}>{saving ? "Updating…" : "Update password"}</PrimaryButton>
      </form>
    </div>
  );
}

// ---------- shared bits ----------

function TopNav({ onBack }) {
  if (!onBack) return <div className="h-6 mb-2" />;
  return (
    <button onClick={onBack} className="flex items-center gap-1 text-sm text-[#9C9585] hover:text-[#F3EFE4] mb-4 -ml-1">
      <ChevronLeft size={16} /> Back
    </button>
  );
}

function Field({ icon, label, value, onChange, type = "text", placeholder, autoFocus, endAdornment, disabled }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-[#D8D2C2]">{label}</span>
      <div className={`flex items-center gap-2 border border-white/15 focus-within:border-[#C9A227] rounded-lg px-3 py-2.5 bg-black/40 ${disabled ? "opacity-50" : ""}`}>
        <span className="text-[#9C9585]">{icon}</span>
        <input autoFocus={autoFocus} type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled}
          className="flex-1 outline-none text-sm text-[#F3EFE4] placeholder:text-[#6B675E] bg-transparent disabled:cursor-not-allowed" />
        {endAdornment}
      </div>
    </label>
  );
}

function PrimaryButton({ children, ...props }) {
  return (
    <button {...props} className="w-full bg-[#C9A227] hover:bg-[#B8911F] disabled:opacity-60 text-black text-sm font-semibold rounded-lg py-2.5 transition-colors">
      {children}
    </button>
  );
}

function SecondaryButton({ children, ...props }) {
  return (
    <button {...props} className="w-full border border-[#C9A227] text-[#C9A227] hover:bg-[#C9A227]/10 disabled:opacity-60 text-sm font-semibold rounded-lg py-2.5 transition-colors">
      {children}
    </button>
  );
}
