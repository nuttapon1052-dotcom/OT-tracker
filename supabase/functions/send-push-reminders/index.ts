// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";

// VAPID keys ตั้งค่าผ่าน `supabase secrets set` (เหมือนกับ send-push-test)
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY");
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY");

// SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY เป็น secret ที่ Supabase
// ตั้งให้อัตโนมัติในทุก Edge Function อยู่แล้ว ไม่ต้องตั้งเอง
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// key แยกต่างหากสำหรับตรวจสอบสิทธิ์เรียก endpoint นี้ (pg_cron ใช้ค่านี้)
// ไม่ใช้ SUPABASE_SERVICE_ROLE_KEY ตรงนี้อีกต่อไป เพื่อไม่ให้ service role key
// หลุดไปอยู่ในที่ที่ไม่จำเป็น
const REMINDER_AUTH_KEY = Deno.env.get("REMINDER_AUTH_KEY");

// ค่าเริ่มต้น timezone เมื่อ user ยังไม่เคยตั้งไว้ใน ot_settings.timezone
const DEFAULT_TIMEZONE = "Asia/Bangkok";

// ยอมให้ "เลยเวลาเป้าหมาย (notifyTime ที่ผู้ใช้ตั้งเอง)" มาได้กี่นาทีแล้วยังนับ
// ว่าต้องเตือน pg_cron รันทุก 1 นาที (ดู migration 20260715000000) เป้าหมายคือยิง
// ตรงนาที notifyTime พอดี แต่เผื่อ window ไว้กว้างพอควรกัน cron ยิงช้า/ตกหล่นหลาย
// tick แล้วไม่หลุดทั้งวัน (กันซ้ำด้วย last_reminder_sent_date อยู่แล้ว) - ตั้ง
// default 120 นาที เพื่อทนต่อ cron สะดุด แต่ยังไม่เตือนดึกเกินจริง
// ⚠️ window ต้อง >= ความถี่ cron (1 นาที) เสมอ ปรับได้ผ่าน secret REMINDER_WINDOW_MINUTES
const REMINDER_WINDOW_MINUTES = Number(Deno.env.get("REMINDER_WINDOW_MINUTES")) || 120;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    "mailto:test@example.com",
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY,
  );
}

interface OtSettingsRow {
  user_id: string;
  data: {
    notifyEnabled?: boolean;
    // เวลาที่ผู้ใช้ตั้งเองว่าจะให้เตือนกี่โมง (HH:MM ตาม timezone ของ user)
    notifyTime?: string;
  } | null;
  timezone: string | null;
  // "สลอต" ล่าสุดที่เตือนไปแล้ว = "<วันที่ท้องถิ่น>T<notifyTime>" เช่น
  // "2026-07-16T18:15" ใช้กันเตือนซ้ำแบบอิงทั้งวันที่และเวลาที่ตั้ง เพื่อให้
  // ผู้ใช้เลื่อนเวลาเตือนในวันเดียวกัน (เช่นทำ OT ต่อ) แล้วได้รับเตือนซ้ำที่
  // เวลาใหม่ได้ - แต่ยังกันสแปมภายในเวลาเดิม (สลอตเดิม) อยู่
  last_reminder_slot: string | null;
}

interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

// แปลงเวลาปัจจุบันเป็นวันที่/เวลาตาม timezone ของ user นั้นๆ โดยไม่พึ่ง
// library เสริม - ใช้ Intl ที่ Deno runtime มีให้ในตัวอยู่แล้ว
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

// ระยะห่าง (นาที) นับจาก targetMinutes มาถึง nowMinutes แบบวนข้ามเที่ยงคืนได้
// เช่น target 23:55, now 00:05 -> ห่างกัน 10 นาที ไม่ใช่ -1430 นาที
function minutesSince(targetMinutes: number, nowMinutes: number): number {
  return ((nowMinutes - targetMinutes) % 1440 + 1440) % 1440;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // ป้องกันไม่ให้ใครก็ได้ (เช่น ผู้ถือ anon key ฝั่งหน้าเว็บ) มายิง endpoint
  // นี้เพื่อสั่งส่ง push ให้ user ทุกคนได้ตามใจชอบ (pg_cron เรียกด้วย
  // REMINDER_AUTH_KEY ตามคำแนะนำท้ายไฟล์)
  //
  // ใช้ header ชื่อเอง "X-Reminder-Auth" แทน "Authorization" เพราะ Supabase
  // gateway จะตรวจสอบค่าใน Authorization header เองก่อนโค้ดเราจะได้ทำงานเสมอ
  // (ไม่ว่า verify_jwt จะปิดไว้หรือไม่) แล้ว reject ค่าที่ไม่ใช่ JWT/apikey ที่
  // ถูกต้อง ทำให้ REMINDER_AUTH_KEY (เป็น plain string ไม่ใช่ JWT) ผ่านไม่ถึง
  // โค้ดเราเลย ตาม Supabase docs endpoint ที่ทำ custom auth เองไม่ควรใช้
  // Authorization header เลย
  const reminderAuthHeader = req.headers.get("X-Reminder-Auth") ?? "";
  if (!REMINDER_AUTH_KEY || reminderAuthHeader !== REMINDER_AUTH_KEY) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return Response.json(
      { error: "ยังไม่ได้ตั้งค่า VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY ใน secrets" },
      { status: 500 },
    );
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const now = new Date();

  // ขั้น 1: ดึงเฉพาะ user ที่เปิด notifyEnabled ไว้ใน ot_settings.data
  const { data: settingsRows, error: settingsError } = await supabaseAdmin
    .from("ot_settings")
    .select("user_id, data, timezone, last_reminder_slot")
    .eq("data->>notifyEnabled", "true");

  if (settingsError) {
    return Response.json({ error: settingsError.message }, { status: 500 });
  }

  const summary = {
    checked: 0,
    dueForReminder: 0,
    alreadyHasEntryToday: 0,
    alreadySentToday: 0,
    noSubscription: 0,
    sent: 0,
    failedPushes: [] as { user_id: string; endpoint: string; error: string }[],
    errors: [] as { user_id: string; error: string }[],
  };

  const rows = (settingsRows ?? []) as OtSettingsRow[];

  await Promise.allSettled(rows.map(async (row) => {
    summary.checked++;

    // เวลาที่ผู้ใช้ตั้งเองว่าจะให้เตือนกี่โมง - เป็นตัวเดียวที่ใช้กำหนดเวลาเตือน
    // แล้ว (ไม่เกี่ยวกับตารางคำนวณ OT / OT บังคับ / +15 นาที อีกต่อไป)
    const notifyTime = row.data?.notifyTime;
    if (!notifyTime) return; // ยังไม่ได้ตั้งเวลาแจ้งเตือน

    const targetMinutes = parseTimeToMinutes(notifyTime);
    if (targetMinutes === null) return;

    const timeZone = row.timezone || DEFAULT_TIMEZONE;
    let dateISO: string;
    let minutesOfDay: number;
    try {
      ({ dateISO, minutesOfDay } = getZonedDateAndMinutes(now, timeZone));
    } catch {
      ({ dateISO, minutesOfDay } = getZonedDateAndMinutes(now, DEFAULT_TIMEZONE));
    }

    // ยังไม่ถึงเวลาเตือน (notifyTime) หรือเลยมาเกิน window ที่ยอมรับแล้ว
    const elapsed = minutesSince(targetMinutes, minutesOfDay);
    if (elapsed > REMINDER_WINDOW_MINUTES) return;

    // สลอตของการเตือนรอบนี้ = วันที่ท้องถิ่น + เวลาที่ผู้ใช้ตั้ง ถ้าผู้ใช้เลื่อน
    // notifyTime เป็นเวลาใหม่ในวันเดียวกัน สลอตจะเปลี่ยน -> ได้เตือนซ้ำที่เวลาใหม่
    // ถ้าสลอตเดิม (เวลาเดิม วันเดิม) แปลว่าเตือนไปแล้ว -> กันส่งซ้ำ (กันสแปมทั้ง
    // window ของเวลานั้น)
    const slot = `${dateISO}T${notifyTime}`;
    if (row.last_reminder_slot === slot) {
      summary.alreadySentToday++;
      return;
    }

    summary.dueForReminder++;

    // บันทึกเวลาออกงาน (time_out) ของวันนี้แล้ว - ไม่ต้องเตือน
    // หมายเหตุ: อาจมี row ของวันนี้อยู่แล้วแต่ time_out ยังเป็น null (clock in
    // แล้วแต่ยังไม่ clock out) กรณีนี้ต้องยังเตือนอยู่ จึงเช็คที่ time_out
    // โดยตรงแทนที่จะเช็คแค่ว่ามี row หรือไม่
    const { count: entryCount, error: entryError } = await supabaseAdmin
      .from("ot_entries")
      .select("id", { count: "exact", head: true })
      .eq("user_id", row.user_id)
      .eq("date", dateISO)
      .not("time_out", "is", null)
      // แถวที่ถูกลบไปแล้วต้องไม่นับว่า "บันทึกเวลาออกงานแล้ว" ไม่งั้นผู้ใช้ที่ลบ
      // รายการของวันนี้ทิ้งจะไม่ได้รับการเตือนให้จดบันทึก
      .is("deleted_at", null);

    if (entryError) {
      summary.errors.push({ user_id: row.user_id, error: entryError.message });
      return;
    }
    if (entryCount && entryCount > 0) {
      summary.alreadyHasEntryToday++;
      return;
    }

    // หา subscription ของ user คนนี้ (อาจมีหลายอุปกรณ์)
    const { data: subs, error: subsError } = await supabaseAdmin
      .from("push_subscriptions")
      .select("id, user_id, endpoint, p256dh, auth")
      .eq("user_id", row.user_id);

    if (subsError) {
      summary.errors.push({ user_id: row.user_id, error: subsError.message });
      return;
    }
    if (!subs || subs.length === 0) {
      summary.noSubscription++;
      return;
    }

    // จอง (claim) สลอตนี้แบบ atomic ก่อนส่งจริง กันเคส cron ยิงทับกัน (เช่น
    // invocation ก่อนหน้ายังไม่ทันเขียน last_reminder_slot กลับเพราะ webpush
    // ช้า/cold start นานเกิน 1 นาที แล้ว cron รอบถัดไปมาอ่านค่าที่ยังไม่อัปเดต
    // เจอ -> ส่งซ้ำ) เดิมโค้ดเขียน last_reminder_slot "หลัง" ส่งสำเร็จเท่านั้น
    // ทำให้มีช่วง race ระหว่างอ่าน (เช็ค row.last_reminder_slot ด้านบน) กับเขียน
    // ยาวเท่าเวลาที่ใช้ส่ง push ทั้งหมด - ย้ายมาจองก่อนส่งแทน โดยใช้เงื่อนไข
    // WHERE ที่ยึด row เดียวกัน (Postgres lock แถวระหว่าง UPDATE ให้เอง) ทำให้มี
    // แค่ invocation เดียวที่จองสำเร็จ (ได้ row กลับมา) ส่วนอีก invocation ที่มาซ้ำ
    // จะ update ไม่โดนแถวไหนเลย (0 rows) เพราะค่าที่ WHERE เช็คถูกเปลี่ยนไปแล้ว
    const { data: claimedRows, error: claimError } = await supabaseAdmin
      .from("ot_settings")
      .update({ last_reminder_slot: slot })
      .eq("user_id", row.user_id)
      .or(`last_reminder_slot.is.null,last_reminder_slot.neq.${slot}`)
      .select("user_id");

    if (claimError) {
      summary.errors.push({ user_id: row.user_id, error: claimError.message });
      return;
    }
    if (!claimedRows || claimedRows.length === 0) {
      // มี invocation อื่นจอง/ส่งสลอตนี้ไปแล้ว (ชนกันตอน cron ยิงทับ) - ข้าม
      summary.alreadySentToday++;
      return;
    }

    // tag คงที่ต่อวัน+user - กันเคส device เดียวกันมี subscription ค้างอยู่หลาย
    // endpoint (เช่น subscribe ใหม่ทุกครั้งที่ service worker อัปเดต/ล้าง cache
    // โดยของเก่าไม่เคยโดน 404 เลยไม่ถูกลบ) แล้วโดนส่งซ้ำเข้าเครื่องเดียวกัน 2
    // endpoint - ใส่ tag ให้ service worker ยุบ notification ที่ซ้ำเป็นอันเดียว
    const payload = JSON.stringify({
      title: "OT Fast",
      body: "⏰ อย่าลืมจดบันทึก OT ของวันนี้",
      tag: `leave-work-${slot}`,
    });

    const staleSubIds: string[] = [];
    let anySuccess = false;
    const results = await Promise.allSettled(
      (subs as PushSubscriptionRow[]).map((sub) =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        )
      ),
    );

    results.forEach((r, i) => {
      const sub = (subs as PushSubscriptionRow[])[i];
      if (r.status === "fulfilled") {
        summary.sent++;
        anySuccess = true;
        return;
      }
      const reason = r.reason as { statusCode?: number; message?: string };
      // subscription หมดอายุ/ถูกยกเลิกฝั่ง browser แล้ว - ลบทิ้งกันค้างไว้ยิงซ้ำทุกรอบ
      if (reason?.statusCode === 404 || reason?.statusCode === 410) {
        staleSubIds.push(sub.id);
      }
      summary.failedPushes.push({
        user_id: row.user_id,
        endpoint: sub.endpoint,
        error: reason?.message ?? String(reason),
      });
    });

    if (staleSubIds.length > 0) {
      await supabaseAdmin.from("push_subscriptions").delete().in("id", staleSubIds);
    }

    // จองสลอตไปแล้วก่อนส่ง (ดูด้านบน) ถ้าส่งสำเร็จอย่างน้อย 1 เครื่องก็จบ ปล่อย
    // ค่าที่จองไว้อยู่แบบนั้น แต่ถ้าทุกเครื่องล้มเหลวหมด (เช่น subscription เดียว
    // ที่มีหมดอายุไปแล้ว) ให้คืนสลอตกลับเป็นค่าเดิม เพื่อให้ cron รอบถัดไปใน
    // window เดิมยังลองจองใหม่ได้ - เผื่ออุปกรณ์เพิ่ง self-heal สมัคร subscription
    // ใหม่เข้ามา (ดู ensurePushSubscription ฝั่ง client) ก็จะยิงถึงในรอบถัดไปได้
    // ไม่ตกหล่นทั้งวัน (เช็ค .eq last_reminder_slot เดิมด้วย กันเผลอทับค่าที่
    // invocation อื่นเพิ่งจองสลอตใหม่ทับไปแล้ว)
    if (!anySuccess) {
      await supabaseAdmin
        .from("ot_settings")
        .update({ last_reminder_slot: row.last_reminder_slot })
        .eq("user_id", row.user_id)
        .eq("last_reminder_slot", slot);
    }
  }));

  return Response.json({ message: "ตรวจสอบและส่งแจ้งเตือนเสร็จสิ้น", ...summary });
});

/* วิธีทดสอบ (local):

  1. รัน `supabase start`
  2. เรียกด้วย curl พร้อมแนบ REMINDER_AUTH_KEY ใน header ชื่อ X-Reminder-Auth:

  curl -i --location --request POST \
    'http://127.0.0.1:54321/functions/v1/send-push-reminders' \
    --header 'X-Reminder-Auth: <REMINDER_AUTH_KEY>'

  ต้องแนบ REMINDER_AUTH_KEY ผ่าน X-Reminder-Auth เท่านั้น เพราะฟังก์ชันนี้เช็ค
  header นี้เองภายใน (ดูโค้ดด้านบน) โดยไม่สนใจว่า verify_jwt จะผ่านหรือไม่ -
  ป้องกันไม่ให้ใครก็ได้ที่ถือ anon key มายิงส่ง push แทน user อื่นได้ (ไม่ใช้
  Authorization header เพราะ Supabase gateway จะดักตรวจค่านั้นเองก่อนถึงโค้ดเรา)

  ดูวิธีตั้งค่า pg_cron ให้เรียกฟังก์ชันนี้อัตโนมัติทุก 1 นาทีได้ที่
  supabase/migrations/20260715000000_push_reminders_every_minute.sql
  (ของเดิมรันทุก 15 นาที ดู 20260712000000_push_reminders.sql)

*/
