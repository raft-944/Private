/* 批量给句型库里的日语例句生成配音(Azure AI Speech,ja-JP-NanamiNeural)。
   这个脚本需要在能访问 Azure 的机器上跑(这个仓库的自动化会话所在的沙盒环境网络策略
   不允许访问 *.tts.speech.microsoft.com,连不上,所以这一步必须手动在本地跑一次)。

   用法(在 jp-trainer-webapp/ 目录下):
     AZURE_TTS_KEY=你的密钥 AZURE_TTS_REGION=eastus node scripts/generate_audio.mjs

   需要 Node.js 18 及以上(自带 fetch,不用额外装依赖)。
   跑完之后 public/audio/ 目录下会多出一堆 .mp3 文件,提交进 git 就行——
   前端播放按钮引用的文件名和这里生成的文件名用的是同一个哈希算法(见 hashStr),
   两边只要文本一字不差就能对上,不需要额外维护一份"句子→文件名"的映射表。

   之后如果又新增/修改了句型库的例句,重新跑一次这个脚本就行——已经存在的文件会跳过
   (不会重复花钱),只有新增或改过文本的句子才会真正调用 Azure。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PATTERNS } from "../src/patternsData.js";

const KEY = process.env.AZURE_TTS_KEY;
const REGION = process.env.AZURE_TTS_REGION || "eastus";
if (!KEY) {
  console.error("请设置环境变量 AZURE_TTS_KEY(还可以设 AZURE_TTS_REGION,默认 eastus)");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "public", "audio");
fs.mkdirSync(OUT_DIR, { recursive: true });

/* 和前端 App.jsx 里的 audioKeyFor 必须是同一个哈希算法,否则前端算出来的文件名
   和这里生成的对不上。故意不用句型 id+下标这种位置编号——extras 在 PatternLecture
   里会按"是否和 study 例句重复"被过滤掉一部分,过滤后的下标和原始数组下标对不上,
   直接按句子文本内容哈希就没有这个问题,不管句子在数组里第几个都能找到同一份音频。 */
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function synth(text) {
  const ssml = `<speak version='1.0' xml:lang='ja-JP'><voice xml:lang='ja-JP' xml:gender='Female' name='ja-JP-NanamiNeural'>${escapeXml(text)}</voice></speak>`;
  const res = await fetch(`https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": KEY,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "jp-pattern-trainer-batch-tts",
    },
    body: ssml,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// 收集句型库里所有需要配音的日语例句,按文本去重(同一句话在不同地方出现只生成一次)
function collectSentences() {
  const set = new Set();
  for (const p of PATTERNS) {
    if (p.exJP) set.add(p.exJP);
    (p.extras || []).forEach(([jp]) => jp && set.add(jp));
    if (p.study && p.study.usages) {
      p.study.usages.forEach((u) => (u.ex || []).forEach(([jp]) => jp && set.add(jp)));
    }
  }
  return [...set];
}

async function main() {
  const sentences = collectSentences();
  console.log(`共 ${sentences.length} 条不重复例句需要配音`);
  let done = 0, skipped = 0, failed = 0;
  const CONCURRENCY = 4;
  let idx = 0;
  async function worker() {
    while (idx < sentences.length) {
      const i = idx++;
      const text = sentences[i];
      const file = path.join(OUT_DIR, `${hashStr(text)}.mp3`);
      if (fs.existsSync(file)) { skipped++; continue; }
      try {
        const buf = await synth(text);
        fs.writeFileSync(file, buf);
        done++;
      } catch (e) {
        failed++;
        console.error(`失败: "${text}" — ${e.message}`);
      }
      const total = done + skipped + failed;
      if (total % 50 === 0) console.log(`进度: ${total}/${sentences.length}(已生成${done} 跳过${skipped} 失败${failed})`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`\n完成。已生成 ${done} 条,跳过(已存在) ${skipped} 条,失败 ${failed} 条。`);
  console.log(`音频文件在: ${OUT_DIR}`);
  if (failed > 0) console.log(`有失败的,重新跑一次这个脚本就会只重试失败的那些(已成功的会被跳过)。`);
}

main();
