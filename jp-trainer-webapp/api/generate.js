// Vercel Serverless Function
// 部署到 Vercel 后,这个文件会自动变成 POST /api/generate 这个接口
// DEEPSEEK_API_KEY 是服务端环境变量,浏览器永远看不到,安全

const MODEL = "deepseek-v4-flash";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: { message: "Method not allowed" } });
    return;
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: "服务端没有配置 DEEPSEEK_API_KEY,请检查 Vercel 项目的环境变量设置" } });
    return;
  }

  const { system, user, max_tokens } = req.body || {};
  if (!user) {
    res.status(400).json({ error: { message: "缺少 user 字段" } });
    return;
  }

  // DeepSeek 有时候比 Claude 更啰嗦,1200 tokens 容易在写判卷讲解时被截断导致JSON不完整
  // 这里不管前端传多少,都保底给够 2048,避免"判卷失败:返回内容不含完整JSON"这类问题
  const outputTokens = Math.max(max_tokens || 0, 2048);

  try {
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: user });

    const deepseekRes = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: outputTokens,
        temperature: 0.9,
      }),
    });

    const data = await deepseekRes.json();

    if (!deepseekRes.ok) {
      const msg = (data && data.error && data.error.message) || `DeepSeek HTTP ${deepseekRes.status}`;
      // DeepSeek(OpenAI 兼容接口)的 429 通常把等待秒数放在 Retry-After 响应头里,不在 JSON body 里
      const retryAfterHeader = deepseekRes.headers.get("retry-after");
      const retryAfter = retryAfterHeader ? parseFloat(retryAfterHeader) : null;
      res.status(deepseekRes.status).json({ error: { message: msg, retryAfter: isNaN(retryAfter) ? null : retryAfter } });
      return;
    }

    const choice = data.choices && data.choices[0];
    const text = (choice && choice.message && choice.message.content) || "";
    const finishReason = choice && choice.finish_reason;

    if (finishReason === "length") {
      // 即使有部分文字,也大概率是被截断的不完整JSON,记录下来方便在 Vercel 的 Functions 日志里排查
      // eslint-disable-next-line no-console
      console.warn("DeepSeek 输出被 max_tokens 截断,考虑进一步调大 outputTokens");
    }

    if (!text) {
      // 常见原因:被内容审核拦截、或触发了其他终止条件
      res.status(502).json({ error: { message: "DeepSeek 没有返回内容" + (finishReason ? `(finish_reason: ${finishReason})` : "") } });
      return;
    }

    // 包装成前端原本认识的 Anthropic Messages API 返回形状,App.jsx 里的解析逻辑不用改
    res.status(200).json({ content: [{ type: "text", text }] });
  } catch (e) {
    res.status(500).json({ error: { message: e.message || String(e) } });
  }
}
