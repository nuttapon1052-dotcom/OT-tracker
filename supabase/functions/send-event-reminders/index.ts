// supabase/functions/send-event-reminders/index.ts
//
// Edge Function นี้ถูกเรียกโดย pg_cron ทุก 1 นาที (ดู migration
// 20260715010000_event_reminders_every_minute.sql)
// หน้าที่: หา work_notes ที่ผู้ใช้ตั้งเวลาแจ้งเตือนไว้ (reminder_enabled) และถึง
// เวลาที่เลือก (reminder_date + reminder_time ตาม timezone ของผู้ใช้) แล้วยัง
// ไม่เคยส่ง (reminder_sent = false) -> ส่ง push แจ้งเตือนเจ้าของ note นั้น
//
// เดิมฟังก์ชันนี้เตือน "ล่วงหน้า 1 วันตอน 07:00" แบบตายตัว เปลี่ยนมาให้ผู้ใช้
// เลือกวัน/เวลาแจ้งเตือนเองต่อ note (ฝั่ง client หน้า "บันทึกเหตุการณ์")
//
// ต้องมี secrets ตั้งไว้แล้ว: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, REMINDER_AUTH_KEY
// (Supabase Edge Functions มี SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ให้อัตโนมัติ)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;

// key แยกต่างหากสำหรับตรวจสอบสิทธิ์เรียก endpoint นี้ (pg_cron ใช้ค่านี้)
const REMINDER_AUTH_KEY = Deno.env.get("REMINDER_AUTH_KEY")!;

const VAPID_SUBJECT = "mailto:test@example.com";
const DEFAULT_TIMEZONE = "Asia/Bangkok";

// ยอมให้ "เลยเวลาแจ้งเตือนที่เลือก" มาได้กี่นาทีแล้วยังส่งอยู่ - เผื่อ cron ตกหล่น
// ไป 2-3 นาที (cron รันทุก 1 นาที) จะได้ยังส่งถึง ปกติจะยิงตรงนาทีที่เลือกพอดี
const EVENT_WINDOW_MINUTES = Number(Deno.env.get("EVENT_REMINDER_WINDOW_MINUTES")) || 15;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

interface NoteRow {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  reminder_date: string | null;
  reminder_time: string | null;
}

interface SubRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

// แปลงเวลาปัจจุบันเป็นวันที่/นาทีของวันตาม timezone ของผู้ใช้ (ใช้ Intl ที่ Deno
// มีให้ในตัว ไม่ต้องพึ่ง library)
function getZonedDateAndMinutes(now: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const dateISO = `${get("year")}-${get("month")}-${get("day")}`;
  const minutesOfDay = Number(get("hour")) * 60 + Number(get("minute"));
  return { dateISO, minutesOfDay };
}

function parseTimeToMinutes(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

// ระยะห่าง (นาที) จาก targetMinutes ถึง nowMinutes แบบวนข้ามเที่ยงคืนได้
function minutesSince(targetMinutes: number, nowMinutes: number): number {
  return ((nowMinutes - targetMinutes) % 1440 + 1440) % 1440;
}

Deno.serve(async (req) => {
  try {
    // Auth check: ต้องมี REMINDER_AUTH_KEY ใน header ชื่อ X-Reminder-Auth
    // (ดูเหตุผลที่ไม่ใช้ Authorization header ใน send-push-reminders/index.ts)
    const reminderAuthHeader = req.headers.get("X-Reminder-Auth") ?? "";
    if (reminderAuthHeader !== REMINDER_AUTH_KEY) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const now = new Date();

    // 1) ดึง note ที่เปิดแจ้งเตือน ตั้งวัน/เวลาไว้ครบ และยังไม่เคยส่ง
    const { data: notes, error: notesError } = await supabaseAdmin
      .from("work_notes")
      .select("id, user_id, title, description, reminder_date, reminder_time")
      .eq("reminder_enabled", true)
      .eq("reminder_sent", false)
      // ข้ามบันทึกที่ถูกลบไปแล้ว (soft delete - ดู migration
      // 20260908000000_sync_merge_tombstones.sql) ไม่งั้นจะเตือนเหตุการณ์ที่
      // ผู้ใช้ลบทิ้งไปแล้ว
      .is("deleted_at", null)
      .not("reminder_date", "is", null)
      .not("reminder_time", "is", null);

    if (notesError) throw notesError;
    if (!notes || notes.length === 0) {
      return jsonResponse({ message: "No reminders pending", sent: 0 });
    }

    const userIds = [...new Set(notes.map((n) => n.user_id))];

    // 2) timezone ต่อผู้ใช้ (จาก ot_settings) เพื่อเทียบเวลาให้ตรงเขตเวลาของเขา
    const { data: settingsRows, error: settingsError } = await supabaseAdmin
      .from("ot_settings")
      .select("user_id, timezone")
      .in("user_id", userIds);
    if (settingsError) throw settingsError;
    const tzByUser = new Map<string, string>();
    for (const s of settingsRows ?? []) tzByUser.set(s.user_id, s.timezone || DEFAULT_TIMEZONE);

    // 3) push subscriptions ต่อผู้ใช้ (มี subscription = เปิด Push ไว้แล้ว)
    const { data: subscriptions, error: subError } = await supabaseAdmin
      .from("push_subscriptions")
      .select("id, user_id, endpoint, p256dh, auth")
      .in("user_id", userIds);
    if (subError) throw subError;
    const subsByUser = new Map<string, SubRow[]>();
    for (const sub of (subscriptions ?? []) as SubRow[]) {
      const list = subsByUser.get(sub.user_id) ?? [];
      list.push(sub);
      subsByUser.set(sub.user_id, list);
    }

    const summary = {
      pending: notes.length,
      due: 0,
      sent: 0,
      noSubscription: 0,
      errors: [] as string[],
    };
    const sentNoteIds: string[] = [];
    const staleSubIds: string[] = [];

    for (const note of notes as NoteRow[]) {
      const reminderMinutes = note.reminder_time ? parseTimeToMinutes(note.reminder_time) : null;
      if (reminderMinutes === null || !note.reminder_date) continue;

      const tz = tzByUser.get(note.user_id) || DEFAULT_TIMEZONE;
      let dateISO: string;
      let minutesOfDay: number;
      try {
        ({ dateISO, minutesOfDay } = getZonedDateAndMinutes(now, tz));
      } catch {
        ({ dateISO, minutesOfDay } = getZonedDateAndMinutes(now, DEFAULT_TIMEZONE));
      }

      // เตือนเฉพาะ "วันที่เลือก" และเมื่อถึงเวลาที่เลือกแล้ว (ภายใน window)
      if (note.reminder_date !== dateISO) continue;
      const elapsed = minutesSince(reminderMinutes, minutesOfDay);
      if (elapsed > EVENT_WINDOW_MINUTES) continue;

      summary.due++;

      const userSubs = subsByUser.get(note.user_id) ?? [];
      if (userSubs.length === 0) {
        summary.noSubscription++;
        continue; // ยังไม่เปิด Push เลย ข้าม (ยังไม่มาร์ค sent จะได้ส่งได้เมื่อสมัคร)
      }

      // tag ต่อ note - กัน device เดียวกันที่มี subscription ค้างหลาย endpoint
      // โดนส่งซ้ำเข้าเครื่องเดียวกัน (ดูเหตุผลเดียวกันใน send-push-reminders)
      const payload = JSON.stringify({
        title: `🔔 ${note.title}`,
        body: note.description || "ถึงเวลาสำหรับเหตุการณ์ที่คุณบันทึกไว้",
        tag: `event-${note.id}`,
      });

      let anySuccess = false;
      const results = await Promise.allSettled(
        userSubs.map((sub) =>
          webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
          )
        ),
      );
      results.forEach((r, i) => {
        const sub = userSubs[i];
        if (r.status === "fulfilled") {
          summary.sent++;
          anySuccess = true;
          return;
        }
        const reason = r.reason as { statusCode?: number; message?: string };
        if (reason?.statusCode === 404 || reason?.statusCode === 410) staleSubIds.push(sub.id);
        summary.errors.push(`${sub.id}: ${reason?.message ?? String(reason)}`);
      });

      // มาร์ค sent เฉพาะเมื่อส่งสำเร็จอย่างน้อย 1 เครื่อง - ถ้าล้มเหลวหมดปล่อยให้
      // cron รอบถัดไปในช่วง window ลองใหม่ได้ (เผื่ออุปกรณ์ self-heal subscription)
      if (anySuccess) sentNoteIds.push(note.id);
    }

    if (staleSubIds.length > 0) {
      await supabaseAdmin.from("push_subscriptions").delete().in("id", staleSubIds);
    }
    if (sentNoteIds.length > 0) {
      await supabaseAdmin.from("work_notes").update({ reminder_sent: true }).in("id", sentNoteIds);
    }

    return jsonResponse({ message: "Event reminder check complete", ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: message }, 500);
  }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
