// Vercel Serverless Function
// 部署到 Vercel 后,这个文件会自动变成 POST /api/generate 这个接口
// GEMINI_API_KEY 是服务端环境变量,浏览器永远看不到,安全

const MODEL = "gemini-3.5-flash"; // 2026年5月发布的最新版,依然在免费额度内(15次/分钟、1500次/天),指令遵循更可靠

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: { message: "Method not allowed" } });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: "服务端没有配置 GEMINI_API_KEY,请检查 Vercel 项目的环境变量设置" } });
    return;
  }

  const { system, user, max_tokens } = req.body || {};
  if (!user) {
    res.status(400).json({ error: { message: "缺少 user 字段" } });
    return;
  }

  // Gemini 有时候比 Claude 更啰嗦,1200 tokens 容易在写判卷讲解时被截断导致JSON不完整
  // 这里不管前端传多少,都保底给够 2048,避免"判卷失败:返回内容不含完整JSON"这类问题
  const outputTokens = Math.max(max_tokens || 0, 2048);

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            maxOutputTokens: outputTokens,
            temperature: 0.9,
          },
        }),
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      const msg = (data && data.error && data.error.message) || `Gemini HTTP ${geminiRes.status}`;
      res.status(geminiRes.status).json({ error: { message: msg } });
      return;
    }

    const candidate = data.candidates && data.candidates[0];
    const text =
      candidate && candidate.content && candidate.content.parts
        ? candidate.content.parts.map((p) => p.text || "").join("")
        : "";
    const finishReason = candidate && candidate.finishReason;

    if (finishReason === "MAX_TOKENS") {
      // 即使有部分文字,也大概率是被截断的不完整JSON,记录下来方便在 Vercel 的 Functions 日志里排查
      // eslint-disable-next-line no-console
      console.warn("Gemini 输出被 maxOutputTokens 截断,考虑进一步调大 outputTokens");
    }

    if (!text) {
      // 常见原因:被安全过滤器拦截(finishReason: SAFETY)等
      res.status(502).json({ error: { message: "Gemini 没有返回内容" + (finishReason ? `(finishReason: ${finishReason})` : "") } });
      return;
    }

    // 包装成前端原本认识的 Anthropic Messages API 返回形状,App.jsx 里的解析逻辑不用改
    res.status(200).json({ content: [{ type: "text", text }] });
  } catch (e) {
    res.status(500).json({ error: { message: e.message || String(e) } });
  }
}
