/* 情景对话·场景库(v1,手写)
 * targetPatterns 存的是句型的原文字符串(必须和 patternsData.js 里 pattern 字段完全一致),
 * 运行时靠 resolveScenePatterns() 精确匹配出对应的 PATTERNS 条目(带真实 id),
 * 复盘判卷时只从这份"解析成功的候选列表"里挑句型,不做任何模糊文本匹配——
 * 这样错题本落库时才能稳定拿到一个真实存在的 pid,不会挂空。
 */
import { PATTERNS } from "../patternsData.js";

export const SCENES = [
  {
    id: "station_ask_platform",
    background: "在JR新宿站，你想去涩谷但不知道该在哪个站台坐车",
    userRole: "乘客",
    aiRole: "站务员",
    initiator: "user",
    targetPatterns: ["Vたいです", "Nはどこ／いくらですか"],
    goal: "问到正确站台并道谢结束对话",
  },
  {
    id: "restaurant_order",
    background: "在一家日式定食屋，服务员过来准备帮你点餐",
    userRole: "顾客",
    aiRole: "服务员",
    initiator: "ai",
    targetPatterns: ["Nをください", "Nにします(選択)"],
    goal: "点好餐并确认餐点内容",
  },
  {
    id: "hospital_registration",
    background: "你身体不舒服，去附近的诊所挂号看病",
    userRole: "患者",
    aiRole: "护士",
    initiator: "user",
    targetPatterns: ["Vてください", "い形／な形容詞です"],
    goal: "说明症状并完成挂号",
  },
  {
    id: "call_in_sick",
    background: "你今天身体不舒服，打电话给公司上司请假",
    userRole: "员工",
    aiRole: "上司",
    initiator: "ai",
    targetPatterns: ["Vなければなりません", "〜んですが、〜"],
    goal: "说明理由并请到假",
  },
  {
    id: "shopping_clothes",
    background: "在服装店，你在看一件外套，想了解价格和尺码",
    userRole: "顾客",
    aiRole: "店员",
    initiator: "ai",
    targetPatterns: ["Nがほしいです", "Nはどこ／いくらですか"],
    goal: "问清楚价格并决定是否购买",
  },
  {
    id: "ask_directions",
    background: "你在街上迷路了，想找最近的邮局",
    userRole: "路人",
    aiRole: "当地人",
    initiator: "user",
    targetPatterns: ["どうやって", "疑問詞+Vたらいいですか"],
    goal: "问到去邮局的路线",
  },
  {
    id: "small_talk_weather",
    background: "在公司茶水间遇到同事，简单寒暄几句",
    userRole: "同事",
    aiRole: "同事",
    initiator: "ai",
    targetPatterns: ["い形／な形容詞です", "あまり〜ません"],
    goal: "完成一段自然的寒暄闲聊",
  },
  {
    id: "reschedule_apology",
    background: "你和朋友约好了今天见面，但临时有事需要改约",
    userRole: "你",
    aiRole: "朋友",
    initiator: "user",
    targetPatterns: ["〜て、すみません", "〜たらどうですか"],
    goal: "道歉说明情况并商定新的时间",
  },
  {
    id: "borrow_something",
    background: "你忘带笔了，想向旁边的同学借一支",
    userRole: "学生",
    aiRole: "同学",
    initiator: "user",
    targetPatterns: ["Vていただけませんか", "Vてもいいです"],
    goal: "借到需要的东西并道谢",
  },
  {
    id: "return_item",
    background: "你昨天买的商品有点问题，去店里申请退换货",
    userRole: "顾客",
    aiRole: "店员",
    initiator: "user",
    targetPatterns: ["Nをお願いします", "〜んですが、〜"],
    goal: "说明问题并完成退换",
  },
  {
    id: "invite_friend",
    background: "周末你想约朋友一起去看电影",
    userRole: "你",
    aiRole: "朋友",
    initiator: "user",
    targetPatterns: ["一緒にVませんか", "Vましょう"],
    goal: "成功约到朋友并定好时间地点",
  },
  {
    id: "phone_appointment",
    background: "你想打电话给一家餐厅预约今晚的位子",
    userRole: "顾客",
    aiRole: "餐厅店员",
    initiator: "ai",
    targetPatterns: ["Nをお願いします", "いつ〜ますか"],
    goal: "成功预约到今晚的位子",
  },
];

/* 把场景里的句型原文字符串解析成真实的 PATTERNS 条目(带 id)。
   解析不到的字符串直接跳过、不抛错——这只是候选列表,少一条不影响功能,
   但绝不能让一条写错的场景数据搞挂整个功能。 */
export function resolveScenePatterns(scene) {
  return scene.targetPatterns
    .map((text) => PATTERNS.find((p) => p.pattern === text))
    .filter(Boolean);
}
