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
  const [inviteCode, setInviteCode] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = (m) => { setMode(m); setErr(""); setMsg(""); setPw(""); setPw2(""); setInviteCode(""); };

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
      if (!inviteCode.trim()) { setErr("请填写邀请码"); return; }
      if (pw !== pw2) { setErr("两次输入的密码不一致"); return; }
      setBusy(true);
      const { data: redeemed, error: redeemErr } = await supabase.rpc("redeem_invite_code", {
        p_code: inviteCode.trim(),
      });
      if (redeemErr || !redeemed) {
        setBusy(false);
        setErr("邀请码无效或名额已用完，请联系邀请人确认");
        return;
      }
      const { error } = await supabase.auth.signUp({
        email: email.trim(),
        password: pw,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) {
        // 邀请码已校验通过但注册没成功(比如邮箱已被注册过),把占用的名额还回去
        await supabase.rpc("release_invite_code", { p_code: inviteCode.trim() });
        setBusy(false);
        setErr(translateErr(error.message));
        return;
      }
      setBusy(false);
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
        <div style={S.sub}>JLPT N5〜N1 · 遗忘曲线</div>

        <div style={S.modeTitle}>{title}</div>

        {mode === "signup" && (
          <input
            style={S.input}
            type="text"
            placeholder="邀请码"
            autoComplete="off"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        )}

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

  // 登录之前的这几屏各自带上 AuthStyle(配色变量);登录之后 App.jsx 自己的 Style()
  // 会定义同一套变量,所以这里不需要、也不该再重复挂一份
  if (session === undefined) return <><AuthStyle /><div style={S.loading}>読み込み中…</div></>;
  if (recovering && session) return <><AuthStyle /><ResetPasswordScreen onDone={() => setRecovering(false)} /></>;
  if (!session) return <><AuthStyle /><AuthScreen /></>;

  installStoragePolyfill(session.user.id);
  return <App />;
}

/* 登录/注册界面的配色变量。取值和 App.jsx 里 Style() 定义的那套完全一致(浅色/深色两套),
   这样"登录页 → 登录进去之后的正式界面"不会在深色模式下突然从浅色跳成深色。
   两个文件各写一份而不是共用:App.jsx 那份是几千行样式里的一小段,单独抽文件反而更绕,
   而这里只需要其中十来个变量。改配色时记得两边一起改。
   color-scheme 必须跟着设:不设的话浏览器仍按浅色渲染 <input> 的原生部分(光标、
   自动填充的黄色背景、密码框的小眼睛图标),深色背景配浅色控件会很突兀。 */
function AuthStyle() {
  return (
    <style>{`
:root{
  color-scheme:light;
  --paper:#F5F3EC; --card:#FFFFFF; --ink:#2A2B30; --ink-soft:#6B6D76;
  --ai:#2E4A7D; --ai-deep:#223A5E; --shu:#C0392F; --line:#E4E0D4;
  --tint-red-bg:#FCEBE9; --tint-green-bg:#E4F0EC; --tint-green-fg:#2E7D5B;
  --tint-input-bg:#FDFCF9; --auth-shadow:rgba(34,58,94,.08);
}
@media (prefers-color-scheme:dark){
  :root{
    color-scheme:dark;
    --paper:#18181A; --card:#232326; --ink:#EDEAE2; --ink-soft:#A6A296;
    --ai:#7FA3D9; --ai-deep:#A9C3E8; --shu:#E2685C; --line:#38383C;
    --tint-red-bg:#3A2323; --tint-green-bg:#1F332B; --tint-green-fg:#6FBE97;
    --tint-input-bg:#1F1F21; --auth-shadow:rgba(0,0,0,.4);
  }
}
body{background:var(--paper)}
    `}</style>
  );
}

/* 颜色一律走上面那套 CSS 变量(内联 style 里可以直接写 var(...)),不要写死十六进制,
   否则深色模式下这个界面又会变回刺眼的浅色。 */
const S = {
  wrap: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--paper)", fontFamily: "'Noto Sans SC',-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif", padding: 20 },
  card: { width: "100%", maxWidth: 360, background: "var(--card)", borderRadius: 16, padding: 28, boxShadow: "0 2px 16px var(--auth-shadow)" },
  title: { fontSize: 22, fontWeight: 700, color: "var(--ai-deep)", marginBottom: 4 },
  sub: { fontSize: 12, color: "var(--ink-soft)", marginBottom: 20 },
  modeTitle: { fontSize: 15, fontWeight: 600, color: "var(--ink)", marginBottom: 14, paddingBottom: 10, borderBottom: "1px solid var(--line)" },
  input: { width: "100%", padding: "12px 14px", fontSize: 16, border: "1.5px solid var(--line)", borderRadius: 10, marginBottom: 10, boxSizing: "border-box", background: "var(--tint-input-bg)", color: "var(--ink)" },
  btn: { width: "100%", padding: "13px", fontSize: 15, fontWeight: 600, color: "#fff", background: "var(--ai)", border: "none", borderRadius: 10, cursor: "pointer", marginTop: 4 },
  err: { color: "var(--shu)", fontSize: 13, marginTop: 12, lineHeight: 1.6, background: "var(--tint-red-bg)", padding: "10px 12px", borderRadius: 8 },
  msg: { color: "var(--tint-green-fg)", fontSize: 13, marginTop: 12, lineHeight: 1.7, background: "var(--tint-green-bg)", padding: "10px 12px", borderRadius: 8 },
  links: { display: "flex", justifyContent: "space-between", marginTop: 16, gap: 10 },
  link: { fontSize: 13, color: "var(--ai)", cursor: "pointer", textDecoration: "underline" },
  hint: { fontSize: 12, color: "var(--ink-soft)", marginTop: 16, lineHeight: 1.7, paddingTop: 14, borderTop: "1px dashed var(--line)" },
  loading: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-soft)", fontFamily: "sans-serif", background: "var(--paper)" },
};

createRoot(document.getElementById("root")).render(<Root />);
