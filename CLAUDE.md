# OT Fast — บริบทโปรเจกต์

## ภาพรวม
เว็บแอปบันทึกเวลาทำงาน/OT เขียนด้วย vanilla JS (ไม่มี build step, ไม่มี bundler) เป็น PWA มี service worker

## Deployment & Repo
- **Repo ทดสอบ (ใช้ตัวนี้เสมอ)**: nuttapon1052-dotcom/ot-tracker-dev
- **URL ทดสอบ**: https://nuttapon1052-dotcom.github.io/ot-tracker-dev/
- **Repo หลักที่ผู้ใช้จริงใช้อยู่**: nuttapon1052-dotcom/OT-tracker (ห้ามแตะจนกว่าเจ้าของจะสั่ง)
- ผู้ใช้ทดสอบผ่าน GitHub Pages เท่านั้น ไม่ใช่ localhost — แก้ไฟล์ในเครื่องอย่างเดียวไม่มีผลจนกว่าจะ push ขึ้น repo

## Backend: Supabase
- Project ref: tnbxahwxiocgmabrajpz
- URL: https://tnbxahwxiocgmabrajpz.supabase.co
- ใช้ Auth (Google OAuth), Database (PostgreSQL), Edge Functions
- ตารางที่มี: ot_entries, ot_settings, work_notes (มีคอลัมน์ reminder_sent สำหรับแจ้งเตือนเหตุการณ์), push_subscriptions, todos
- ผู้ใช้ **ไม่ได้ใช้ supabase db push** — ต้อง copy โค้ด SQL ไปรันเองใน Supabase SQL Editor เสมอ
- Edge Functions ที่มี: `send-push-reminders`, `send-event-reminders`, `send-push-test` (ไว้ทดสอบ push)
- **Auth ของ pg_cron → Edge Function**: ใช้ custom header `X-Reminder-Auth` กับ secret `REMINDER_AUTH_KEY` (ไม่ใช่ service_role key ผ่าน Authorization header อีกต่อไป เพราะ Supabase gateway จะดัก Authorization header และปฏิเสธค่าที่ไม่ใช่ JWT ก่อนโค้ดจะรันด้วยซ้ำ) — `verify_jwt = false` ถูกตั้งไว้ในทั้งสอง function นี้ใน `supabase/config.toml` เพราะ auth เช็คเองในโค้ดแล้ว
- **กุญแจ REMINDER_AUTH_KEY ต้องตรงกันสองที่** ไม่งั้นแจ้งเตือนตายเงียบๆ (ฟังก์ชันตอบ 401 ทุกนาที):
  1. **Vault ในฐานข้อมูล** ชื่อ `reminder_auth_key` — pg_cron อ่านค่านี้ส่งเป็น header (ดู migration `20260713020000`)
  2. **Edge Function secret** ชื่อ `REMINDER_AUTH_KEY` — ตั้งผ่าน workflow "Set Reminder Auth Key"
- **ตอน deploy ต้องใส่ `--no-verify-jwt` เสมอ** ถ้าลืม gateway จะเปิดตรวจ JWT กลับมา แล้วปฏิเสธ pg_cron ตั้งแต่ก่อนโค้ดได้รัน (การ deploy แบบ `--project-ref` ไม่รับประกันว่าค่าใน `config.toml` จะถูกใช้) — workflow ใส่ flag นี้ไว้ให้แล้ว
- **วิธีตรวจว่าแจ้งเตือนยังทำงานอยู่**: Supabase → Edge Functions → เลือกฟังก์ชัน → แท็บ **Invocations** ต้องเห็น **200** ทุกนาที ถ้าเป็น **401** = กุญแจสองที่ไม่ตรงกัน (ดูข้างบน) ส่วนแท็บ Logs จะเห็นแค่ booted/shutdown ไม่บอก status code

## ฟีเจอร์ที่ทำเสร็จแล้ว
- Google Login ผ่าน Supabase Auth
- Sync ข้อมูล OT ขึ้น cloud (pushStateToCloud/pullStateFromCloud)
- Export Excel เลือกช่วงวันที่ได้ (SheetJS ผ่าน CDN)
- เป้าหมาย OT รายเดือน + progress bar
- เปรียบเทียบ OT เดือนต่อเดือน
- วันหยุดราชการ 8 ประเทศ (Nager.Date API + static bundle สำหรับ TH/TW/IL/MY) แปลชื่อเป็นไทยครบ
- บันทึกเหตุการณ์ล่วงหน้า (work_notes) + แจ้งเตือนล่วงหน้า 1 วัน
- แจ้งเตือนเมื่อถึงเวลาเลิกงาน (ทำงานเฉพาะตอนเปิดแท็บ)
- Web Push Notification (ทำงานแม้ปิดแอป) — Stage 1, 2 เสร็จแล้ว

## กฎสำคัญที่ต้องทำทุกครั้งที่ทำงานเสร็จ
สรุป "ขั้นตอนที่ผู้ใช้ต้องทำเองต่อ" เป็นข้อๆ ให้ชัดเจนเสมอ:
1. **ถ้าแก้ database schema** → แสดงโค้ด SQL เต็มๆ ที่ต้อง copy ไปรันใน Supabase SQL Editor (ห้ามบอกแค่ "รัน migration" เพราะผู้ใช้หาไฟล์ไม่เจอ)
2. **ถ้าแก้ไฟล์ frontend** → บอกว่าต้อง push ขึ้น repo ot-tracker-dev (ถ้าผู้ใช้อนุญาตให้ push เอง ให้รัน git add/commit/push ให้เลย)
3. **ถ้าต้องตั้งค่าใน Supabase Dashboard** → บอกเมนูที่ต้องเข้าให้ชัดเจน (เช่น Authentication → URL Configuration)
4. **ถ้าต้องรันคำสั่ง terminal** → เขียนคำสั่งเต็มๆ พร้อม ! นำหน้า
5. **บอกวิธีทดสอบว่าสำเร็จ** — เช็คที่ไหน ดูอะไร

## ข้อควรระวังที่เจอบ่อย
- **Service Worker cache**: ทุกครั้งที่ push โค้ดใหม่ ต้องเตือนผู้ใช้ให้ hard refresh (Ctrl+Shift+R) หรือใช้ incognito ไม่งั้นจะเห็นโค้ดเก่า
- **ห้ามขอ secret key**: Service Role Key, VAPID Private Key, Access Token — ห้ามขอให้ผู้ใช้ส่งมาให้ดู ให้ผู้ใช้รันเองในเทอร์มินัลเท่านั้น
- **Brave browser บล็อก Push API** — ถ้าทดสอบ push ให้ใช้ Chrome/Edge/Safari แทน
- **`.local-only/`**: ใช้เก็บ SQL แบบ one-off ที่ต้องรันครั้งเดียวเอง (เช่น ตั้งค่า secret ใน Vault) อยู่ใน `.gitignore` แล้ว ห้าม commit ไฟล์ในโฟลเดอร์นี้

## คำสั่งที่ใช้บ่อย
- **Deploy Edge Function**: ไม่ต้องใช้ CLI แล้ว — push โค้ดใน `supabase/functions/`
  ขึ้น main แล้ว GitHub Actions deploy ให้เอง (`.github/workflows/deploy-edge-functions.yml`)
  หรือสั่งเองได้จากแท็บ Actions → "Deploy Edge Functions" → Run workflow
- **ตั้งค่า REMINDER_AUTH_KEY**: แท็บ Actions → "Set Reminder Auth Key" → Run workflow
  (อ่านค่าจาก repository secret ชื่อ `REMINDER_AUTH_KEY`)
- ถ้าจะใช้ CLI เองจริงๆ: `! supabase functions deploy <name> --no-verify-jwt` /
  `! supabase secrets set KEY=value`
- Push ขึ้น GitHub: `! git add . && git commit -m "message" && git push`
- รัน Playwright tests: `! npx playwright test` (มี test อยู่ใน `tests/entry.spec.js`)
