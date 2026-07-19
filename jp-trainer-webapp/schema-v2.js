/* ================= 句型库数据结构 v2（对象格式）=================
 *
 * 迁移背景：
 *   v1 是位置数组 [课, 句型, 接续, 意思, 例句日, 例句中, 扩展例句, 辨析]
 *   随着 N3→N2→N1 扩充，字段只会继续增加（解释、文体标注、读解素材…），
 *   位置数组到第 9 位以后已无法维护，故改为具名对象。
 *
 * 迁移原则：
 *   ① 顺序绝对不变 —— 若进度数据按数组下标存储，转换后仍能对上
 *   ② 字段可选 —— 老数据没有的字段留空，不影响读取
 *   ③ 一次性转换 —— 转换后 v1 数组即废弃，不再维护两套
 */

/* ---------- 字段定义 ----------
 * lesson    Number  课号。初级 1-50，中级 51-62（= 50 + 中级课号）
 * level     String  "初級" | "中級"，用于出题难度基准，避免 AI 停留在 N5-N4
 * pattern   String  句型本身
 * conn      String  接续方式
 * meaning   String  中文简释（一句话，列表页显示用）
 * exJP      String  主例句（日）
 * exCN      String  主例句（中）
 * extras    Array   扩展例句 [[日, 中], ...]，无则 []
 * contrasts Array   易混淆辨析 [[对比句型(所属课), 辨析说明], ...]，无则 []
 * explain   String  教材语法解释，供判卷/出题提示词使用，无则 ""
 * ext       Boolean 是否为教材外的补充句型，UI 显示「補充」徽章，无则 false
 */

// ---------- 转换脚本：v1 数组 → v2 对象 ----------
// 用法：node migrate.js  （或让 Claude Code 直接跑这段）
function migrate(RAW, level, ext) {
  return RAW.map(function (r) {
    return {
      lesson: r[0],
      level: level || (r[0] <= 50 ? "初級" : "中級"),
      pattern: r[1],
      conn: r[2],
      meaning: r[3],
      exJP: r[4],
      exCN: r[5],
      extras: Array.isArray(r[6]) ? r[6] : [],
      contrasts: Array.isArray(r[7]) ? r[7] : [],
      explain: typeof r[8] === "string" ? r[8] : "",
      ext: !!ext,
    };
  });
}

// ---------- 校验脚本：转换后自检 ----------
function validate(list) {
  var errors = [];
  list.forEach(function (p, i) {
    if (typeof p.lesson !== "number") errors.push(i + ": lesson 非数字");
    ["pattern", "conn", "meaning", "exJP", "exCN"].forEach(function (k) {
      if (!p[k] || typeof p[k] !== "string") errors.push(i + ": " + k + " 缺失");
    });
    if (!Array.isArray(p.extras)) errors.push(i + ": extras 非数组");
    if (!Array.isArray(p.contrasts)) errors.push(i + ": contrasts 非数组");
    p.extras.forEach(function (e, j) {
      if (!Array.isArray(e) || e.length !== 2) errors.push(i + ": extras[" + j + "] 格式错");
    });
    p.contrasts.forEach(function (c, j) {
      if (!Array.isArray(c) || c.length !== 2) errors.push(i + ": contrasts[" + j + "] 格式错");
    });
  });
  return errors;
}

/* ---------- 提示词里怎么用 explain ----------
 * 判卷时把该句型的 explain 与 contrasts 一并塞进提示词，
 * AI 的判卷标准就会跟《大家的日语》对齐，而不是凭它自己的通用语法认知。
 *
 * 示例（判卷提示词片段）：
 *
 *   【本次考查句型】${p.pattern}
 *   【接续】${p.conn}
 *   【教材解释】${p.explain}
 *   【易混淆点】${p.contrasts.map(c => c[0] + "：" + c[1]).join("\n")}
 *
 *   请依据上述教材解释判卷。若学习者的句子语法无误但违反了「教材解释」
 *   中说明的使用场景、文体或语气限制，须明确指出，不可判为完全正确。
 *   若踩中「易混淆点」，请说明与哪个句型混淆了、区别在哪。
 *
 * 这条规则解决的问题：现在 AI 只查语法对错，
 * 加上之后能查「语法对但用得不地道 / 文体不搭 / 混淆近义句型」。
 */

export { migrate, validate };
