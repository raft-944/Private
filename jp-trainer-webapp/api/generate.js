// Vercel Serverless Function
// 部署到 Vercel 后,这个文件会自动变成 POST /api/generate 这个接口
// DEEPSEEK_API_KEY 是服务端环境变量,浏览器永远看不到,安全

const MODEL = "deepseek-v4-flash";
// 大部分场景用 flash 就够(出题/判卷这类单步任务),但像"読解"这种要一次性攒出一段
// 连贯长文、还要保证每道理解题有且只有一个选项站得住脚的多步推理任务,flash 更容易
// 出现看似都对的模糊选项。允许前端按请求显式指定 pro,白名单校验,不认识的值一律
// 忽略、退回默认的 flash,不能让前端随便指定任意字符串当模型名传给上游。
const ALLOWED_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"];

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

  const { system, user, max_tokens, model } = req.body || {};
  if (!user) {
    res.status(400).json({ error: { message: "缺少 user 字段" } });
    return;
  }
  const useModel = ALLOWED_MODELS.includes(model) ? model : MODEL;

  // DeepSeek 有时候比 Claude 更啰嗦,1200 tokens 容易在写判卷讲解时被截断导致JSON不完整
  // 这里不管前端传多少,都保底给够 2048,避免"判卷失败:返回内容不含完整JSON"这类问题。
  // 上限 16000:这个接口没有登录校验(谁知道地址都能调),不封顶的话一个请求就能点名
  // 要几十万 token、直接烧掉账号额度。本站自己用到的最大值是 8000 再翻倍重试 = 16000
  // (见 callAI 的两档预算和 callAIArray 的 Math.min(8000,...)),取这个数不影响正常功能。
  const outputTokens = Math.min(Math.max(max_tokens || 0, 2048), 16000);

  // DeepSeek V4 系列(flash/pro)现在默认开启"思考模式":思考过程(reasoning_content)
  // 和最终答案(content)共用同一份 max_tokens 预算,思考本身就可能把预算耗尽,
  // 导致 content 是空的、finish_reason 变成 "length"(2026年8月起大量"出题失败:
  // DeepSeek 没有返回内容(finish_reason: length)"报错的根因,不是本项目代码引入的)。
  // flash 场景选它就是图"快、不用思考链"(出题/判卷这类单步任务),所以显式关闭;
  // pro 场景(読解生成、文法选择题自我核验)本来就是要用它的思考链,保留默认的开启。
  const thinking = useModel === "deepseek-v4-flash" ? { type: "disabled" } : { type: "enabled" };

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
        model: useModel,
        messages,
        max_tokens: outputTokens,
        temperature: 0.9,
        thinking,
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
