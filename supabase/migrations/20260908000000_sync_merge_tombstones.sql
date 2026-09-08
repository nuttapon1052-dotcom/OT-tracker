-- Sync ที่ "รวมข้อมูล" แทน "ทับข้อมูล"
--
-- เดิมการ sync คือเอาข้อมูลฝั่งหนึ่งไปทับอีกฝั่ง ทำให้เครื่องที่มีรายการซึ่ง
-- cloud ยังไม่เคยเห็น เสียข้อมูลทันทีแค่เพราะ login และเวลา cloud พังก็ลาม
-- มาลบข้อมูลในเครื่องต่อ 2 คอลัมน์นี้ทำให้เลิกใช้วิธีทับได้:
--
--   updated_at - ใช้ตัดสินว่าเวอร์ชันไหนใหม่กว่าเมื่อแก้รายการเดียวกันจาก 2
--                เครื่อง (ใหม่กว่าชนะ)
--   deleted_at - ลบแบบ soft delete แถวไม่ได้หายไปจากตาราง แต่ถูกทำเครื่องหมาย
--                ไว้ เพื่อให้การลบจากเครื่องหนึ่งเดินทางไปถึงอีกเครื่องได้
--                (ถ้าลบแถวทิ้งจริง เครื่องอื่นที่ยังมีข้อมูลจะอัปโหลดกลับขึ้นมาใหม่)
--
-- ผลพลอยได้ที่สำคัญ: ฝั่งแอปไม่ต้องมีคำสั่ง delete ในเส้นทาง sync อีกเลย

alter table ot_entries add column if not exists updated_at timestamptz not null default now();
alter table ot_entries add column if not exists deleted_at timestamptz;

alter table work_notes add column if not exists updated_at timestamptz not null default now();
alter table work_notes add column if not exists deleted_at timestamptz;

-- ดัชนีสำหรับ query ที่อ่านเฉพาะแถวที่ยังไม่ถูกลบ (ทั้งฝั่งแอปและ Edge Function)
create index if not exists ot_entries_user_alive_idx on ot_entries (user_id) where deleted_at is null;
create index if not exists work_notes_user_alive_idx on work_notes (user_id) where deleted_at is null;
