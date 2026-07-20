import { createRoot } from "react-dom/client";
import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";
import { installStoragePolyfill } from "./storagePolyfill";
import App from "./App.jsx";

/* ============ 登录 / 注册 / 找回密码 ============ */
function AuthScreen() {
  const [mode, setMode] = useState("login"); // login | signup | forgot
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = (m) => { setMode(m); setErr(""); setMsg(""); setPw(""); setPw2(""); };

  const submit = async () => {
    setErr(""); setMsg("");
    if (!email.trim()) { setErr("请填写邮箱"); return; }

    if (mode === "forgot") {
      setBusy(true);
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: window.location.origin,
      });
      setBusy(false);
      if (error) setErr(translateErr(error.message));
      else setMsg("重设密码的链接已发到你的邮箱，点开链接后就能设置新密码（收不到的话看看垃圾邮件）。");
      return;
    }

    if (!pw) { setErr("请填写密码"); return; }
    if (pw.length < 6) { setErr("密码至少 6 位"); return; }

    if (mode === "signup") {
      if (pw !== pw2) { setErr("两次输入的密码不一致"); return; }
      setBusy(true);
      const { error } = await supabase.auth.signUp({
        email: email.trim(),
        password: pw,
        options: { emailRedirectTo: window.location.origin },
      });
      setBusy(false);
      if (error) { setErr(translateErr(error.message)); return; }
      setMsg("注册成功！验证邮件已发到你的邮箱，去点一下里面的链接完成验证（只需这一次）。验证之后，以后在任何设备上都可以直接用邮箱+密码登录。");
      return;
    }

    // login
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password: pw,
    });
    setBusy(false);
    if (error) setErr(translateErr(error.message));
  };

  const title = mode === "signup" ? "注册新账号" : mode === "forgot" ? "找回密码" : "登录";

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.title}>句型道場</div>
        <div style={S.sub}>大家的日语 I・II × 遗忘曲线</div>

        <div style={S.modeTitle}>{title}</div>

        <input
          style={S.input}
          type="email"
          placeholder="邮箱"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />

        {mode !== "forgot" && (
          <input
            style={S.input}
            type="password"
            placeholder="密码（至少 6 位）"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        )}

        {mode === "signup" && (
          <input
            style={S.input}
            type="password"
            placeholder="再输一次密码"
            autoComplete="new-password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        )}

        <button style={{ ...S.btn, opacity: busy ? 0.6 : 1 }} onClick={submit} disabled={busy}>
          {busy ? "处理中…" : mode === "signup" ? "注册" : mode === "forgot" ? "发送重设链接" : "登录"}
        </button>

        {err && <div style={S.err}>{err}</div>}
        {msg && <div style={S.msg}>{msg}</div>}

        <div style={S.links}>
          {mode === "login" && (
            <>
              <span style={S.link} onClick={() => reset("signup")}>还没有账号？去注册</span>
              <span style={S.link} onClick={() => reset("forgot")}>忘记密码</span>
            </>
          )}
          {mode !== "login" && <span style={S.link} onClick={() => reset("login")}>← 返回登录</span>}
        </div>

        {mode === "login" && (
          <div style={S.hint}>
            注册时验证一次邮箱，之后在电脑、手机、平板上都可以直接用邮箱+密码登录，学习进度自动同步。
          </div>
        )}
      </div>
    </div>
  );
}

/* ============ 点了邮件里的重设链接后,回到站内设置新密码 ============ */
function ResetPasswordScreen({ onDone }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setErr("");
    if (pw.length < 6) { setErr("密码至少 6 位"); return; }
    if (pw !== pw2) { setErr("两次输入的密码不一致"); return; }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) setErr(translateErr(error.message));
    else onDone();
  };

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.title}>句型道場</div>
        <div style={S.modeTitle}>设置新密码</div>
        <input
          style={S.input}
          type="password"
          placeholder="新密码（至少 6 位）"
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <input
          style={S.input}
          type="password"
          placeholder="再输一次新密码"
          autoComplete="new-password"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <button style={{ ...S.btn, opacity: busy ? 0.6 : 1 }} onClick={save} disabled={busy}>
          {busy ? "保存中…" : "保存新密码并进入"}
        </button>
        {err && <div style={S.err}>{err}</div>}
      </div>
    </div>
  );
}

/* 把 Supabase 的英文报错换成看得懂的中文 */
function translateErr(m) {
  const s = String(m || "");
  if (/Invalid login credentials/i.test(s)) return "邮箱或密码不对。如果还没注册过，先去注册。";
  if (/Email not confirmed/i.test(s)) return "邮箱还没验证。去邮箱点一下注册时收到的验证链接，然后再登录。";
  if (/User already registered|already been registered/i.test(s)) return "这个邮箱已经注册过了，直接登录即可（忘了密码就点「忘记密码」）。";
  if (/rate limit|too many/i.test(s)) return "邮件发送太频繁，被暂时限流了。等一会儿再试（或按 SMTP-SETUP.md 配置 Resend 彻底解决）。";
  if (/should be at least|at least 6/i.test(s)) return "密码太短，至少要 6 位。";
  if (/New password should be different/i.test(s)) return "新密码不能和旧密码一样。";
  return s;
}

function Root() {
  const [session, setSession] = useState(undefined); // undefined=还没查完, null=未登录
  const [recovering, setRecovering] = useState(false); // 是否处于"点了重设密码链接"的状态

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session || null));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      // 点了邮件里的重设链接回来时,Supabase 会给一个 PASSWORD_RECOVERY 事件,
      // 这时虽然已经"登录"了,但要先让用户设置新密码,而不是直接进主界面
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <div style={S.loading}>読み込み中…</div>;
  if (recovering && session) return <ResetPasswordScreen onDone={() => setRecovering(false)} />;
  if (!session) return <AuthScreen />;

  installStoragePolyfill(session.user.id);
  return <App />;
}

const S = {
  wrap: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F5F3EC", fontFamily: "'Noto Sans SC',-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif", padding: 20 },
  card: { width: "100%", maxWidth: 360, background: "#fff", borderRadius: 16, padding: 28, boxShadow: "0 2px 16px rgba(34,58,94,.08)" },
  title: { fontSize: 22, fontWeight: 700, color: "#223A5E", marginBottom: 4 },
  sub: { fontSize: 12, color: "#6B6D76", marginBottom: 20 },
  modeTitle: { fontSize: 15, fontWeight: 600, color: "#2A2B30", marginBottom: 14, paddingBottom: 10, borderBottom: "1px solid #E4E0D4" },
  input: { width: "100%", padding: "12px 14px", fontSize: 16, border: "1.5px solid #E4E0D4", borderRadius: 10, marginBottom: 10, boxSizing: "border-box", background: "#FDFCF9", color: "#2A2B30" },
  btn: { width: "100%", padding: "13px", fontSize: 15, fontWeight: 600, color: "#fff", background: "#2E4A7D", border: "none", borderRadius: 10, cursor: "pointer", marginTop: 4 },
  err: { color: "#C0392F", fontSize: 13, marginTop: 12, lineHeight: 1.6, background: "#FCEBE9", padding: "10px 12px", borderRadius: 8 },
  msg: { color: "#2E7D5B", fontSize: 13, marginTop: 12, lineHeight: 1.7, background: "#E4F0EC", padding: "10px 12px", borderRadius: 8 },
  links: { display: "flex", justifyContent: "space-between", marginTop: 16, gap: 10 },
  link: { fontSize: 13, color: "#2E4A7D", cursor: "pointer", textDecoration: "underline" },
  hint: { fontSize: 12, color: "#6B6D76", marginTop: 16, lineHeight: 1.7, paddingTop: 14, borderTop: "1px dashed #E4E0D4" },
  loading: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#6B6D76", fontFamily: "sans-serif", background: "#F5F3EC" },
};

createRoot(document.getElementById("root")).render(<Root />);
