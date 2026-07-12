import { createRoot } from "react-dom/client";
import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";
import { installStoragePolyfill } from "./storagePolyfill";
import App from "./App.jsx";

function LoginScreen({ onSent }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async () => {
    if (!email.trim()) return;
    setBusy(true);
    setErr("");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (error) setErr(error.message);
    else { setSent(true); onSent && onSent(); }
  };

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <div style={styles.title}>句型道場</div>
        <div style={styles.sub}>大家的日语 I・II × 遗忘曲线</div>
        {sent ? (
          <div style={styles.text}>
            登录链接已经发到 <b>{email}</b>，去邮箱里点一下链接就能登录（第一次收不到的话看看垃圾邮件文件夹）。
            <br /><br />
            登录后这台设备会记住登录状态，不用每次都重新登录；换新设备时用同一个邮箱重复这个流程即可，数据会自动同步。
          </div>
        ) : (
          <>
            <input
              style={styles.input}
              type="email"
              placeholder="你的邮箱"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
            />
            <button style={styles.btn} onClick={send} disabled={busy}>
              {busy ? "发送中…" : "发送登录链接"}
            </button>
            {err && <div style={styles.err}>{err}</div>}
            <div style={styles.hint}>
              不需要注册、不需要设密码，用邮箱收一条登录链接就行。同一个邮箱在电脑和手机上分别登录一次，进度就会自动同步。
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const styles = {
  wrap: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F5F3EC", fontFamily: "-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif", padding: 20 },
  card: { width: "100%", maxWidth: 360, background: "#fff", borderRadius: 16, padding: 28, boxShadow: "0 2px 16px rgba(34,58,94,.08)" },
  title: { fontSize: 22, fontWeight: 700, color: "#223A5E", marginBottom: 4 },
  sub: { fontSize: 12, color: "#6B6D76", marginBottom: 22 },
  input: { width: "100%", padding: "12px 14px", fontSize: 15, border: "1.5px solid #E4E0D4", borderRadius: 10, marginBottom: 12, boxSizing: "border-box" },
  btn: { width: "100%", padding: "13px", fontSize: 15, fontWeight: 600, color: "#fff", background: "#2E4A7D", border: "none", borderRadius: 10, cursor: "pointer" },
  err: { color: "#C0392F", fontSize: 13, marginTop: 10 },
  text: { fontSize: 14, color: "#2A2B30", lineHeight: 1.8 },
  hint: { fontSize: 12, color: "#6B6D76", marginTop: 14, lineHeight: 1.7 },
  loading: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#6B6D76", fontFamily: "sans-serif" },
};

function Root() {
  const [session, setSession] = useState(undefined); // undefined=还没查完, null=未登录, object=已登录

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session || null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <div style={styles.loading}>読み込み中…</div>;
  if (!session) return <LoginScreen />;

  installStoragePolyfill(session.user.id);
  return <App />;
}

createRoot(document.getElementById("root")).render(<Root />);
