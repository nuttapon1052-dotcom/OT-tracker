const { test, expect } = require("@playwright/test");
const { USER_ID, POLL, makeCloud, openDevice, addEntry, liveNotes } = require("./support/fake-supabase");
test.setTimeout(60000);
const settings = page => page.locator('.tabbar__btn[data-view="settings"]').click();
const entries = page => page.locator('.tabbar__btn[data-view="entry"]').click();

test("a settings schema error cannot block OT and events, and retry preserves edited settings", async ({ browser }) => {
 const cloud = makeCloud();
 cloud.rows.ot_settings.push({user_id: USER_ID, data: {recorderName:"ชื่อบนคลาวด์"}, updated_at:"2026-01-01T00:00:00Z"});
 cloud.failures["ot_settings:upsert"] = {code:"PGRST204",message:"Could not find the timezone column of ot_settings in the schema cache"};
 const device = await openDevice(browser, cloud);
 try {
  await settings(device.page);
  await expect(device.page.locator("#syncErrorBanner")).toContainText("timezone");
  await device.page.locator("#s-recordername").fill("ชื่อที่แก้ในเครื่อง");
  await entries(device.page);
  await addEntry(device.page,"08:00","19:00","โอทีระหว่างคลาวด์ผิดพลาด");
  await device.page.locator('.segmented__btn[data-subview="notes"]').click();
  await device.page.locator("#n-title").fill("เหตุการณ์ระหว่างคลาวด์ผิดพลาด");
  await device.page.locator("#noteStartTrigger").click();await device.page.locator("#calToday").click();
  await device.page.locator("#saveNoteBtn").click();
  await expect.poll(()=>liveNotes(cloud),POLL).toEqual(["โอทีระหว่างคลาวด์ผิดพลาด"]);
  await expect.poll(()=>cloud.rows.work_notes.map(row=>row.title),POLL).toEqual(["เหตุการณ์ระหว่างคลาวด์ผิดพลาด"]);
  await settings(device.page);
  await expect(device.page.locator("#syncErrorBanner")).toContainText("PGRST204");
  await device.page.reload();await settings(device.page);
  await expect(device.page.locator("#s-recordername")).toHaveValue("ชื่อที่แก้ในเครื่อง");
  await expect(device.page.locator("#syncRetryBtn")).toBeVisible();
  delete cloud.failures["ot_settings:upsert"];
  await device.page.locator("#syncRetryBtn").click();
  await expect.poll(()=>cloud.rows.ot_settings[0].data.recorderName,POLL).toBe("ชื่อที่แก้ในเครื่อง");
  await expect(device.page.locator("#syncErrorBanner")).toBeHidden();
  const fresh = await openDevice(browser,cloud);
  try {
   await settings(fresh.page);
   await expect(fresh.page.locator("#s-recordername")).toHaveValue("ชื่อที่แก้ในเครื่อง");
   await entries(fresh.page);await expect(fresh.page.locator(".entry-item__note")).toContainText("โอทีระหว่างคลาวด์ผิดพลาด");
  } finally { await fresh.context.close(); }
 } finally { await device.context.close(); }
});

test("logout cannot erase an OT record that the cloud rejected", async ({ browser }) => {
 const cloud=makeCloud(),device=await openDevice(browser,cloud);
 try {
  cloud.failures["ot_entries:upsert"]={code:"42501",message:"row level security rejected write"};
  await addEntry(device.page,"08:00","18:00","ยังไม่ขึ้นคลาวด์");
  await settings(device.page);await expect(device.page.locator("#syncRetryBtn")).toBeVisible();
  await device.page.locator("#logoutBtn").click();
  await expect(device.page.locator("#toast")).toContainText("ยังออกจากระบบไม่ได้");
  await expect(device.page.locator("#authSignedIn")).toBeVisible();
  expect(await device.page.evaluate(()=>JSON.parse(localStorage.getItem("ot-tracker-data-v1")).entries[0].note)).toBe("ยังไม่ขึ้นคลาวด์");
  expect(liveNotes(cloud)).toEqual([]);
  delete cloud.failures["ot_entries:upsert"];
  await device.page.locator("#syncRetryBtn").click();
  await expect.poll(()=>liveNotes(cloud),POLL).toEqual(["ยังไม่ขึ้นคลาวด์"]);
  await expect(device.page.locator("#syncErrorBanner")).toBeHidden();
  await device.page.locator("#logoutBtn").click();
  await expect(device.page.locator("#authSignedOut")).toBeVisible();
  expect(await device.page.evaluate(()=>localStorage.getItem("ot-tracker-data-v1"))).toBeNull();
 } finally { await device.context.close(); }
});

test("late old writes finish before the newest settings and OT are acknowledged", async ({ browser }) => {
 const cloud=makeCloud();cloud.delays["ot_settings:upsert"]=700;
 const device=await openDevice(browser,cloud);
 try {
  await addEntry(device.page,"08:00","18:00","รายการแรก");
  await addEntry(device.page,"09:00","20:00","รายการล่าสุด");
  await settings(device.page);
  await device.page.locator("#s-recordername").fill("ชื่อแรก");
  await device.page.locator("#s-recordername").fill("ชื่อล่าสุด");
  await expect.poll(()=>cloud.rows.ot_settings[0]?.data.recorderName,POLL).toBe("ชื่อล่าสุด");
  await expect.poll(()=>liveNotes(cloud),POLL).toEqual(["รายการล่าสุด","รายการแรก"]);
  await expect(device.page.locator("#syncStatusText")).toContainText("ซิงก์ล่าสุดเมื่อ");
 } finally { await device.context.close(); }
});

async function seedLegacySettings(page,name,lastSync) {
 await page.evaluate(({name,lastSync})=>{
  const saved=JSON.parse(localStorage.getItem("ot-tracker-data-v1"));
  saved.settings.recorderName=name;
  delete saved.settingsDirty;delete saved.settingsUpdatedAt;
  localStorage.setItem("ot-tracker-data-v1",JSON.stringify(saved));
  localStorage.setItem("ot-tracker-last-sync-v1",lastSync);
 },{name,lastSync});
}
test("an upgrade keeps pending legacy settings when cloud has not changed since last confirmed sync",async({browser})=>{
 const cloud=makeCloud();
 cloud.rows.ot_settings.push({user_id:USER_ID,data:{recorderName:"ค่าคลาวด์เก่า"},updated_at:"2026-10-04T11:09:50Z"});
 const device=await openDevice(browser,cloud);
 try{
  await settings(device.page);await expect(device.page.locator("#syncStatusText")).toContainText("ซิงก์ล่าสุดเมื่อ");
  await seedLegacySettings(device.page,"ค่าที่บันทึกในเครื่อง","2026-10-04T11:10:00Z");
  await device.page.reload();await settings(device.page);
  await expect(device.page.locator("#s-recordername")).toHaveValue("ค่าที่บันทึกในเครื่อง");
  await expect.poll(()=>cloud.rows.ot_settings[0].data.recorderName,POLL).toBe("ค่าที่บันทึกในเครื่อง");
 }finally{await device.context.close();}
});
test("an upgrade still accepts newer settings saved by another device",async({browser})=>{
 const cloud=makeCloud(),device=await openDevice(browser,cloud);
 try{
  await settings(device.page);await expect(device.page.locator("#syncStatusText")).toContainText("ซิงก์ล่าสุดเมื่อ");
  await seedLegacySettings(device.page,"ค่าเครื่องเก่า","2026-10-04T11:10:00Z");
  cloud.rows.ot_settings[0].data.recorderName="ค่าล่าสุดจากอีกเครื่อง";
  cloud.rows.ot_settings[0].updated_at="2026-10-08T11:10:00Z";
  await device.page.reload();await settings(device.page);
  await expect(device.page.locator("#s-recordername")).toHaveValue("ค่าล่าสุดจากอีกเครื่อง");
  await expect.poll(()=>cloud.rows.ot_settings[0].data.recorderName,POLL).toBe("ค่าล่าสุดจากอีกเครื่อง");
 }finally{await device.context.close();}
});
