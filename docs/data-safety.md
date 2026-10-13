# ความปลอดภัยข้อมูล OT และสำรองอัตโนมัติ

## สิ่งที่เว็บทำให้แล้ว
- ซิงก์ข้อมูลโดยใช้ Supabase user ID ของบัญชี Google ไม่ใช้ชื่อที่แสดงหรืออีเมลเป็นเจ้าของข้อมูล
- ถ้าซิงก์ยังไม่สำเร็จ ปุ่มออกจากระบบจะไม่ลบข้อมูลที่ค้าง
- เก็บสำเนากู้คืนแยกตามบัญชีในเบราว์เซอร์ หลังออกจากระบบและสลับบัญชี
- เมื่อ Gmail เดิมกลับเข้าเว็บ โหลดสำเนาบัญชีนั้นก่อนเรียกคลาวด์ และรวมข้อมูลที่ยังไม่ได้ส่งกับข้อมูลเซิร์ฟเวอร์
- สำเนาในเบราว์เซอร์ใช้พื้นที่ localStorage และไม่ได้เข้ารหัส การแยกบัญชีป้องกันการแสดง/ส่งผิดบัญชีในแอป ไม่ป้องกันผู้ที่เข้าถึงไฟล์เบราว์เซอร์หรือเครื่องโดยตรง
- ข้อมูลที่ยังไม่ได้รับการยืนยันจากคลาวด์ยังอาจสูญหายถ้าล้างข้อมูลเบราว์เซอร์ เครื่องเสีย หรือเครื่องหาย การล็อกอินจากเครื่องใหม่กู้ได้เฉพาะข้อมูลที่ส่งถึงเซิร์ฟเวอร์แล้ว

## เปิดสำรองอัตโนมัติ (เจ้าของทำครั้งเดียว)
**โค้ดสำรองพร้อมแล้ว แต่ยังไม่ถือว่าเปิดใช้งานจนกว่าคุณตั้งค่าและรันสำเร็จจริง**

1. เข้า [Supabase โปรเจกต์ OT](https://supabase.com/dashboard/project/tnbxahwxiocgmabrajpz) กด **Connect** ด้านบน เลือก **Session pooler** (พอร์ต 5432 ไม่ใช้ Transaction pooler 6543) คัดลอก PostgreSQL connection string
2. แทนที่ช่องรหัสผ่านด้วยรหัสผ่านฐานข้อมูลเดิม รหัสที่มีอักขระพิเศษต้อง URL encode สคริปต์จะตัดช่องว่างหัว–ท้ายที่ติดมาจากการคัดลอก และเติม `sslmode=require` เองหากยังไม่ได้ระบุ SSL; ช่องว่างภายในรหัสผ่านต้อง URL encode เอง ไม่ควรรีเซ็ตรหัสฐานข้อมูลถ้ายังมีบริการอื่นใช้อยู่
3. เข้า [GitHub → Settings → Secrets and variables → Actions](https://github.com/nuttapon1052-dotcom/OT-tracker/settings/secrets/actions) → **New repository secret** สร้าง:
   - `OT_BACKUP_DATABASE_URL`: connection string จากข้อ 2 ซึ่งมีรหัสผ่านฐานข้อมูล
   - `OT_BACKUP_ENCRYPTION_KEY`: รหัสสุ่มจาก password manager อย่างน้อย 32 ตัวอักษร เก็บสำเนากุญแจนี้ไว้ในที่ปลอดภัยนอก GitHub ถ้ากุญแจหายจะเปิดไฟล์สำรองไม่ได้
   **ไม่ต้องส่งสองค่านี้ในแชต ไม่ใช้ publishable key หรือ service_role key แทนรหัสฐานข้อมูล**
4. เปิด [Actions → Encrypted OT database backup](https://github.com/nuttapon1052-dotcom/OT-tracker/actions/workflows/backup-ot-database.yml) → **Run workflow** เลือก main
5. ตรวจว่าทุกขั้นตอนเป็นสีเขียว และมี artifact ชื่อ `encrypted-ot-backup-...` ดาวน์โหลดเก็บแยกไว้หนึ่งชุด
6. ก่อนเชิญผู้ใช้จริง ให้ทดลองกู้ในฐานข้อมูลทดสอบที่มี schema ตรงกันและตรวจข้อมูล OT พร้อมการเชื่อมบัญชี Google การทดสอบ CI ใช้ข้อมูลจำลอง ไม่ยืนยันสิทธิ์/การตั้งค่าฐานข้อมูลจริงแทนคุณ

หลังตั้งค่า workflow จะสำรองเมื่อโค้ดสำรองเปลี่ยนบน main และวันละครั้งเวลา **18:17 UTC** เพื่อนไม่ต้องกดส่งออกเอง ถ้าขาด secret หรือสำรองไม่สำเร็จ งานจะขึ้นล้มเหลว ไม่รายงานว่ามีสำรองแล้ว ควรเปิดการแจ้งเตือน GitHub Actions เมื่อ workflow ล้มเหลว และเจ้าของตรวจวันสำรองล่าสุดเป็นประจำ

## สำรองอะไรและเก็บนานเท่าไร
- Snapshot ในธุรกรรมเดียว: `public.ot_entries`, `public.ot_settings`, `public.work_notes`, `public.push_subscriptions`, `auth.users`, `auth.identities`
- รวมประวัติสะสมทั้งหมดและข้อมูลลบแบบ tombstone ไม่ได้จำกัดประวัติ OT เหลือ 90 วัน
- เข้ารหัส AES-256 และทดสอบถอดรหัสเปรียบเทียบไฟล์ก่อนอัปโหลด เผยแพร่เฉพาะไฟล์ `.dump.gpg` และ SHA-256 ไม่อัปโหลดข้อมูลดิบหรือบันทึกข้อมูลผู้ใช้ลง log
- Artifact อยู่บน GitHub สูงสุด 90 วัน จากนั้นไฟล์ snapshot นั้นหมดอายุ ข้อมูล OT ใน Supabase ยังคงอยู่
- repository นี้เป็น public: ต้องรักษากุญแจเข้ารหัสให้ดี เพราะ artifact เป็น ciphertext ที่บุคคลอื่นอาจดาวน์โหลดได้
- เป็น **สำรองข้อมูล OT และบัญชี** ไม่ใช่สำรองทั้งโปรเจกต์: ไม่รวมตาราง todos, schema/roles, Supabase OAuth configuration, Edge Function secrets, Vault keys หรือไฟล์ Storage ต้องเก็บโค้ด schema/migrations และค่าตั้งโปรเจกต์แยกไว้
- ใช้ quota ฟรีของ GitHub Actions/Artifacts ได้ตราบเท่าที่อยู่ในโควตาบัญชี ไม่รับประกันว่าฟรีไม่จำกัดขนาด
- GitHub อาจปิด scheduled workflows ของ public repo เมื่อไม่มีความเคลื่อนไหว 60 วัน และงานตามเวลาอาจล่าช้า ต้องตรวจสถานะเป็นระยะ ระบบนี้ยังไม่ใช่การเฝ้าระวังอัตโนมัติตลอดเวลา

## เมื่อต้องกู้จริง
1. หยุดการเขียนข้อมูลชั่วคราวและเก็บ snapshot ของสถานะปัจจุบันก่อน
2. ดาวน์โหลด artifact ที่ต้องการ พร้อมกุญแจเข้ารหัสของ snapshot นั้น ตรวจ checksum และถอดรหัสในเครื่องที่เชื่อถือได้
3. กู้ในฐานข้อมูลทดสอบที่มี schema เดียวกันก่อน ตรวจจำนวนรายการ OT, settings, notes, tombstones และ UUID ของ `auth.users`/`auth.identities`
4. ให้ผู้ดูแลจัดการข้อจำกัด foreign keys/triggers ตามคู่มือ Supabase แล้ววางแผนย้ายกลับ production ห้ามนำคำสั่ง restore ของ CI ไปรันในฐานข้อมูลจริงโดยตรง
5. ต้องรักษา UUID ของบัญชีเดิมและการเชื่อม Google identity หากสร้างบัญชี Google ใหม่แล้วได้ UUID ใหม่ ข้อมูล OT เดิมจะไม่เชื่อมเอง ห้ามแก้ด้วยการปิด RLS
6. เข้าสู่ระบบ Google ใหม่หลัง restore; snapshot ไม่รวม refresh sessions เดิม

สำรองรายวันกู้ได้ถึง snapshot ล่าสุดที่สำเร็จ การเสียหายก่อนสำรองรอบถัดไปอาจทำให้ข้อมูลหลัง snapshot หายได้ สำเนาในเครื่องช่วยกู้ข้อมูลช่วงนั้นได้หากยังอยู่ แต่ไม่มีระบบใดรับประกันข้อมูลไม่หายทุกกรณี

อ้างอิง: [Supabase backups](https://supabase.com/docs/guides/platform/backups), [Supabase backup and restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore), [GitHub scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
