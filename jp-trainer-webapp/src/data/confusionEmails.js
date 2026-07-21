/* 練習帳・書面メール 情境类型清单(v1,手写)
 * 每个小项对应一类高频商务邮件情境,不支持编辑/删除,后续按需继续追加。
 * 具体的收件人信息/写信原因/信息点由 AI 现场生成(见 genEmailScenario),
 * 这里只存"练什么类型"这一层。
 */
export const CONFUSION_EMAIL_TOPICS = [
  { id: "cf_email_leave_request", name: "请假/调休申请" },
  { id: "cf_email_apology_delay", name: "道歉说明延迟/失误" },
  { id: "cf_email_confirm_request", name: "请求确认/答复" },
  { id: "cf_email_meeting_invite", name: "会议邀约/改期通知" },
  { id: "cf_email_thanks", name: "感谢邮件(结束合作/收到帮助后)" },
  { id: "cf_email_intro", name: "初次联系自我介绍(对外部客户)" },
];
