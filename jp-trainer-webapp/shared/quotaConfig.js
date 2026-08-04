// 免费额度 / DeepSeek 计费单价:api/generate.js(算钱、超额拦截)和 src/App.jsx
// ("我的"页面展示剩余额度)两边都要用同一份数字,抽成这一份共享文件,避免两边
// 各写一份、改一边忘了改另一边,导致前端显示的额度和后端实际拦截的额度对不上。

// 每个账号的免费体验额度(人民币元),累计花费达到或超过这个数字,
// /api/generate 就直接拒绝调用(unlimited 账号不受这个限制)。
export const FREE_QUOTA_RMB = 2;

// DeepSeek 官方价目表(元/百万token),2026-08 按用户提供的官方定价页截图核对。
// inHit = 输入缓存命中,inMiss = 输入缓存未命中,out = 输出。
export const DEEPSEEK_PRICES = {
  "deepseek-v4-flash": { inHit: 0.02, inMiss: 1, out: 2 },
  "deepseek-v4-pro": { inHit: 0.025, inMiss: 3, out: 6 },
};
