-- ตารางเก็บการตั้งค่า (1 แถวต่อ 1 user)
create table ot_settings (
  user_id uuid references auth.users(id) primary key,
  data jsonb not null default '{}',
  updated_at timestamptz default now(),
  -- คอลัมน์สองตัวด้านล่างนี้ใช้เฉพาะฝั่ง server (Edge Function
  -- send-push-reminders) เท่านั้น แยกออกมาจาก data โดยตั้งใจ เพราะแอปฝั่ง
  -- client จะ upsert ทับคอลัมน์ data ทั้งก้อนทุกครั้งที่ผู้ใช้แก้ settings
  -- ถ้าเก็บไว้ใน data ค่าที่ server เขียนจะหายไปตอน sync รอบถัดไป
  timezone text not null default 'Asia/Bangkok',
  -- (เลิกใช้แล้ว) เดิมเก็บแค่ "วันที่เตือนไปแล้ว" -> เตือนได้วันละครั้ง
  last_reminder_sent_date date,
  -- สลอตล่าสุดที่เตือนไปแล้ว = "<วันที่ท้องถิ่น>T<notifyTime>" เช่น
  -- "2026-07-16T18:15" ทำให้ผู้ใช้เลื่อนเวลาเตือนในวันเดียวกัน (เช่นทำ OT ต่อ)
  -- แล้วได้รับเตือนซ้ำที่เวลาใหม่ได้ ดู supabase/functions/send-push-reminders
  last_reminder_slot text
);

-- ตารางเก็บรายการบันทึกเวลา (หลายแถวต่อ 1 user)
create table ot_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  date date not null,
  time_in text,
  time_out text,
  ot_multiplier numeric,
  note text,
  created_at timestamptz default now(),
  -- updated_at/deleted_at เพิ่มโดย migration
  -- 20260908000000_sync_merge_tombstones.sql - ใช้ให้ sync แบบรวมข้อมูล
  -- (merge) แทนการทับ deleted_at ไม่ null = ถูกลบแล้ว (soft delete)
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ตารางเก็บบันทึกเหตุการณ์ล่วงหน้า (หลายแถวต่อ 1 user)
create table work_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  title text not null,
  description text,
  start_date date not null,
  end_date date not null,
  -- reminder_sent เพิ่มโดย migration 20260713000000_event_reminders.sql
  reminder_sent boolean not null default false,
  -- แจ้งเตือนตามวัน/เวลาที่ผู้ใช้เลือกเอง เพิ่มโดย migration
  -- 20260715010000_note_custom_reminder.sql (reminder_time = "HH:MM" ตาม tz ผู้ใช้)
  reminder_enabled boolean not null default false,
  reminder_date date,
  reminder_time text,
  created_at timestamptz default now(),
  -- ดูหมายเหตุ updated_at/deleted_at ที่ ot_entries ด้านบน
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ตารางเก็บ Web Push subscription (หลายแถวต่อ 1 user - 1 แถวต่อ 1 อุปกรณ์/เบราว์เซอร์)
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz default now(),
  unique(user_id, endpoint)
);

-- เปิด Row Level Security ป้องกันไม่ให้เห็นข้อมูลคนอื่น
alter table ot_settings enable row level security;
alter table ot_entries enable row level security;
alter table work_notes enable row level security;
alter table push_subscriptions enable row level security;

-- Policy: เห็น/แก้ได้แค่ข้อมูลของตัวเอง
create policy "Users manage own settings" on ot_settings
  for all using (auth.uid() = user_id);

create policy "Users manage own entries" on ot_entries
  for all using (auth.uid() = user_id);

create policy "Users manage own work notes" on work_notes
  for all using (auth.uid() = user_id);

create policy "Users manage own push subscriptions" on push_subscriptions
  for all using (auth.uid() = user_id);
