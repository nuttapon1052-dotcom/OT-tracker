// Account-language notification text. User-entered event text stays unchanged.
export const leaveReminderText = {
  "th": "⏰ อย่าลืมจดบันทึก OT ของวันนี้",
  "en": "⏰ Remember to record today's OT",
  "ko": "⏰ 오늘의 OT를 기록하세요",
  "ja": "⏰ 今日の残業を記録しましょう",
  "zh-CN": "⏰ 别忘了记录今天的加班",
  "zh-TW": "⏰ 別忘了記錄今天的加班",
  "vi": "⏰ Đừng quên ghi OT hôm nay",
  "my": "⏰ ယနေ့ OT မှတ်ရန်မမေ့ပါနှင့်",
  "id": "⏰ Jangan lupa mencatat OT hari ini",
  "fil": "⏰ Huwag kalimutang itala ang OT ngayon",
  "ne": "⏰ आजको OT लेख्न नबिर्सनुहोस्"
};
export const eventReminderText = {
  "th": "ถึงเวลาสำหรับเหตุการณ์ที่คุณบันทึกไว้",
  "en": "It is time for your saved event",
  "ko": "기록한 일정의 시간입니다",
  "ja": "登録した予定の時刻です",
  "zh-CN": "您记录的事件时间到了",
  "zh-TW": "您記錄的事項時間到了",
  "vi": "Đã đến giờ sự kiện bạn đã ghi",
  "my": "မှတ်ထားသောအစီအစဉ်အချိန် ရောက်ပါပြီ",
  "id": "Sudah waktunya untuk acara yang Anda catat",
  "fil": "Oras na para sa event na itinala mo",
  "ne": "तपाईंले लेखेको कार्यक्रमको समय भयो"
};
export function leaveReminder(language) {
  return Object.prototype.hasOwnProperty.call(leaveReminderText, language) ? leaveReminderText[language] : leaveReminderText.th;
}
export function eventReminder(language) {
  return Object.prototype.hasOwnProperty.call(eventReminderText, language) ? eventReminderText[language] : eventReminderText.th;
}
