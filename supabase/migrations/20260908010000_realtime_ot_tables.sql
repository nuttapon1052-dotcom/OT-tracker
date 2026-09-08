-- เปิด Realtime ให้ตาราง ot_entries และ work_notes
--
-- ทำให้เครื่องที่ล็อกอินอยู่ได้รับการเปลี่ยนแปลงแบบสดๆ (บันทึก/แก้ไข/ลบ จาก
-- อีกเครื่อง) โดยไม่ต้องสลับแท็บกลับมาหรือเปิดแอปใหม่
--
-- ความปลอดภัย: Row Level Security ที่ตั้งไว้เดิม (auth.uid() = user_id) มีผล
-- กับ Realtime ด้วย แต่ละบัญชีจึงได้รับเฉพาะแถวของตัวเองเท่านั้น
--
-- replica identity full: ทำให้ event ของ UPDATE ส่งค่าคอลัมน์มาครบ (รวม
-- user_id) ซึ่ง filter ฝั่ง client ใช้ตรวจว่าแถวนั้นเป็นของบัญชีที่ล็อกอินอยู่

alter table ot_entries replica identity full;
alter table work_notes replica identity full;

-- เพิ่มเข้า publication แบบไม่พังถ้าเคยเพิ่มไปแล้ว
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ot_entries'
  ) then
    alter publication supabase_realtime add table ot_entries;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'work_notes'
  ) then
    alter publication supabase_realtime add table work_notes;
  end if;
end $$;
