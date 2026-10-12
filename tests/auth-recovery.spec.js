const { test, expect } = require("@playwright/test");
const { USER_ID, POLL, makeCloud, prepareContext, waitForApp, openDevice, addEntry, liveNotes } = require("./support/fake-supabase");
test.setTimeout(60000);
const settings=page=>page.locator('.tabbar__btn[data-view="settings"]').click();

async function rejectedDevice(browser,cloud,options) {
 const context=await browser.newContext(),page=await context.newPage();
 await prepareContext(context,cloud,page);
 await page.addInitScript(options=>{
  window.__jwtRejected=true;
  Object.assign(window,options);
 },options||{});
 await page.goto("/");await waitForApp(page);
 return {context,page};
}
test("expired JWT during all initial reads refreshes once and preserves remote OT",async({browser})=>{
 const cloud=makeCloud();
 cloud.rows.ot_entries.push({id:"00000000-0000-4000-8000-000000000002",user_id:USER_ID,date:"2026-10-12",time_in:"08:00",time_out:"18:00",note:"ข้อมูลเดิมบนคลาวด์",updated_at:"2026-10-12T00:00:00Z",deleted_at:null});
 const d=await rejectedDevice(browser,cloud);
 try{
  await expect(d.page.locator(".entry-item__note")).toContainText("ข้อมูลเดิมบนคลาวด์");
  await settings(d.page);await expect(d.page.locator("#syncStatusText")).toContainText("ซิงก์ล่าสุดเมื่อ");
  expect(await d.page.evaluate(()=>window.__refreshCount)).toBe(1);
  expect(liveNotes(cloud)).toEqual(["ข้อมูลเดิมบนคลาวด์"]);
 }finally{await d.context.close();}
});
test("simultaneous rejected writes share a refresh and upload pending OT",async({browser})=>{
 const cloud=makeCloud(),d=await openDevice(browser,cloud);
 try{
  await settings(d.page);await expect(d.page.locator("#syncStatusText")).toContainText("ซิงก์ล่าสุดเมื่อ");
  await d.page.evaluate(()=>{window.__jwtRejected=true;});
  await d.page.locator('.tabbar__btn[data-view="entry"]').click();
  await addEntry(d.page,"08:00","19:00","รอต่ออายุเซสชัน");
  await expect.poll(()=>liveNotes(cloud),POLL).toEqual(["รอต่ออายุเซสชัน"]);
  await settings(d.page);await expect(d.page.locator("#syncErrorBanner")).toBeHidden();
  expect(await d.page.evaluate(()=>window.__refreshCount)).toBe(1);
 }finally{await d.context.close();}
});
test("revoked refresh token retains local OT across reload and offers OAuth without signout",async({browser})=>{
 const cloud=makeCloud(),d=await openDevice(browser,cloud);
 try{
  await settings(d.page);await expect(d.page.locator("#syncStatusText")).toContainText("ซิงก์ล่าสุดเมื่อ");
  // Establish an unsynced record, then let auth revoke the refresh token.
  cloud.failures["ot_entries:upsert"]={code:"42501",message:"write rejected"};
  await d.page.locator('.tabbar__btn[data-view="entry"]').click();
  await addEntry(d.page,"08:00","19:00","ข้อมูลยังไม่ซิงก์");
  await settings(d.page);await expect(d.page.locator("#syncRetryBtn")).toBeVisible();
  delete cloud.failures["ot_entries:upsert"];
  await d.page.addInitScript(()=>{window.__jwtRejected=true;window.__refreshFailure=true;window.__refreshSignsOut=true;});
  await d.page.reload();await settings(d.page);
  await expect(d.page.locator("#authSignedOut")).toBeVisible();
  await expect(d.page.locator("#reconnectBtn")).toBeVisible();
  expect(await d.page.evaluate(()=>JSON.parse(localStorage.getItem("ot-tracker-data-v1")).entries[0].note)).toBe("ข้อมูลยังไม่ซิงก์");
  await d.page.locator("#reconnectBtn").click();
  expect(await d.page.evaluate(()=>window.__oauthCount)).toBe(1);
  expect(await d.page.evaluate(()=>JSON.parse(localStorage.getItem("ot-tracker-data-v1")).entries[0].note)).toBe("ข้อมูลยังไม่ซิงก์");
  // Signing back into the same account merges the retained local record.
  await d.page.evaluate(()=>{window.__jwtRejected=false;window.__refreshFailure=false;window.__authCb("SIGNED_IN",{user:{id:"00000000-0000-4000-8000-000000000001"}});});
  await expect.poll(()=>liveNotes(cloud),POLL).toEqual(["ข้อมูลยังไม่ซิงก์"]);
 }finally{await d.context.close();}
});
test("a fresh but still rejected JWT has a bounded retry and shows the actual claims reason",async({browser})=>{
 const cloud=makeCloud(),d=await rejectedDevice(browser,cloud,{__rejectAfterRefresh:true,__jwtMessage:"JWT audience invalid"});
 try{
  await settings(d.page);await expect(d.page.locator("#syncErrorBanner")).toContainText("JWT audience invalid");
  await expect(d.page.locator("#reconnectBtn")).toBeVisible();
  expect(await d.page.evaluate(()=>window.__refreshCount)).toBe(1);
  expect(cloud.rows.ot_settings).toEqual([]);
 }finally{await d.context.close();}
});

test("future-issued JWT reads recover with the same session after server time recovers",async({browser})=>{
 const cloud=makeCloud();
 cloud.rows.ot_entries.push({id:"00000000-0000-4000-8000-000000000003",user_id:USER_ID,date:"2026-10-12",time_in:"08:00",time_out:"18:00",note:"ข้อมูลเดิมก่อนเวลาคลาวด์ค้าง",updated_at:"2026-10-12T00:00:00Z",deleted_at:null});
 const d=await rejectedDevice(browser,cloud,{__jwtMessage:"JWT issued at future"});
 try{
  await settings(d.page);
  await expect(d.page.locator("#syncStatusText")).toContainText("กำลังรอเวลาฝั่งคลาวด์");
  expect(await d.page.evaluate(()=>window.__refreshCount||0)).toBe(0);
  await expect(d.page.locator("#reconnectBtn")).toBeHidden();
  await d.page.evaluate(()=>{window.__jwtRejected=false;});
  await expect(d.page.locator("#syncStatusText")).toContainText("ซิงก์ล่าสุดเมื่อ",POLL);
  expect(liveNotes(cloud)).toEqual(["ข้อมูลเดิมก่อนเวลาคลาวด์ค้าง"]);
  expect(await d.page.evaluate(()=>window.__refreshCount||0)).toBe(0);
 }finally{await d.context.close();}
});

test("future-issued JWT writes retain pending local OT and upload once the server recovers",async({browser})=>{
 const cloud=makeCloud(),d=await openDevice(browser,cloud);
 try{
  await settings(d.page);await expect(d.page.locator("#syncStatusText")).toContainText("ซิงก์ล่าสุดเมื่อ");
  await d.page.evaluate(()=>{window.__jwtRejected=true;window.__jwtMessage="JWT issued at future";});
  await d.page.locator('.tabbar__btn[data-view="entry"]').click();
  await addEntry(d.page,"08:00","19:00","บันทึกระหว่างเวลาคลาวด์ผิดพลาด");
  await settings(d.page);await expect(d.page.locator("#syncStatusText")).toContainText("กำลังรอเวลาฝั่งคลาวด์");
  expect(liveNotes(cloud)).toEqual([]);
  expect(await d.page.evaluate(()=>JSON.parse(localStorage.getItem("ot-tracker-data-v1")).entries[0].note)).toBe("บันทึกระหว่างเวลาคลาวด์ผิดพลาด");
  await d.page.evaluate(()=>{window.__jwtRejected=false;});
  await expect.poll(()=>liveNotes(cloud),POLL).toEqual(["บันทึกระหว่างเวลาคลาวด์ผิดพลาด"]);
  await expect(d.page.locator("#syncStatusText")).toContainText("ซิงก์ล่าสุดเมื่อ",POLL);
  expect(await d.page.evaluate(()=>window.__refreshCount||0)).toBe(0);
 }finally{await d.context.close();}
});

test("persistent future-issued JWT stops after bounded retries without forcing another login",async({browser})=>{
 const cloud=makeCloud(),d=await rejectedDevice(browser,cloud,{__jwtMessage:"JWT issued at future"});
 try{
  await settings(d.page);
  await expect(d.page.locator("#syncErrorBanner")).toContainText("ตรวจอัปเดตโปรเจกต์ Supabase",POLL);
  await expect(d.page.locator("#syncErrorBanner")).toContainText("JWT issued at future");
  await expect(d.page.locator("#reconnectBtn")).toBeHidden();
  await expect(d.page.locator("#authSignedIn")).toBeVisible();
  expect(await d.page.evaluate(()=>window.__refreshCount||0)).toBe(0);
  expect(await d.page.evaluate(()=>window.__queryAttempts["ot_settings:select"])).toBe(5);
  expect(cloud.rows.ot_settings).toEqual([]);
 }finally{await d.context.close();}
});
