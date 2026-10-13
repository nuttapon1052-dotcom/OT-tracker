const {test,expect}=require("@playwright/test");
const {POLL,makeCloud,openDevice,addEntry,liveNotes}=require("./support/fake-supabase");
test.setTimeout(60000);
const settings=page=>page.locator('.tabbar__btn[data-view="settings"]').click();
async function ready(page){await settings(page);await expect(page.locator("#syncStatusText")).toContainText("ซิงก์ล่าสุดเมื่อ",POLL);}
async function record(page,note){await page.locator('.tabbar__btn[data-view="entry"]').click();await addEntry(page,"08:00","19:00",note);await settings(page);}

test("temporary cloud outage retries pending OT automatically without a connectivity event",async({browser})=>{
 const cloud=makeCloud(),d=await openDevice(browser,cloud);
 try{
  await ready(d.page);
  cloud.failures["ot_entries:upsert"]={message:"Failed to fetch"};
  await record(d.page,"โอทีรอคลาวด์กลับมา");
  await expect(d.page.locator("#syncErrorBanner")).toContainText("จะลองซิงก์ใหม่อัตโนมัติ");
  expect(liveNotes(cloud)).toEqual([]);
  expect(await d.page.evaluate(()=>JSON.parse(localStorage.getItem("ot-tracker-data-v1")).entries[0].note)).toBe("โอทีรอคลาวด์กลับมา");
  delete cloud.failures["ot_entries:upsert"];
  await expect.poll(()=>liveNotes(cloud),POLL).toEqual(["โอทีรอคลาวด์กลับมา"]);
  await expect(d.page.locator("#syncErrorBanner")).toBeHidden();
  expect(await d.page.evaluate(()=>window.__oauthCount||0)).toBe(0);
 }finally{await d.context.close();}
});

test("network failure renewing an expired JWT recovers automatically without asking for Google login",async({browser})=>{
 const cloud=makeCloud(),d=await openDevice(browser,cloud);
 try{
  await ready(d.page);
  await d.page.evaluate(()=>{window.__jwtRejected=true;window.__refreshFailure={message:"Failed to fetch",status:503};});
  await record(d.page,"โอทีระหว่างต่ออายุสะดุด");
  await expect(d.page.locator("#syncErrorBanner")).toContainText("จะลองซิงก์ใหม่อัตโนมัติ");
  await expect(d.page.locator("#reconnectBtn")).toBeHidden();
  expect(await d.page.evaluate(()=>window.__refreshCount)).toBe(1);
  await d.page.evaluate(()=>{window.__refreshFailure=false;});
  await expect.poll(()=>liveNotes(cloud),POLL).toEqual(["โอทีระหว่างต่ออายุสะดุด"]);
  await expect(d.page.locator("#syncErrorBanner")).toBeHidden();
  expect(await d.page.evaluate(()=>window.__refreshCount)).toBe(2);
  expect(await d.page.evaluate(()=>window.__oauthCount||0)).toBe(0);
 }finally{await d.context.close();}
});

test("multiple online events share one merge and retry the latest local settings and OT",async({browser})=>{
 const cloud=makeCloud(),d=await openDevice(browser,cloud);
 try{
  await ready(d.page);
  cloud.failures["ot_settings:upsert"]={message:"network unavailable"};
  cloud.failures["ot_entries:upsert"]={message:"network unavailable"};
  await d.page.locator("#s-recordername").fill("ค่าล่าสุดในเครื่อง");
  await record(d.page,"รายการรอเชื่อมต่อ");
  await expect(d.page.locator("#syncErrorBanner")).toContainText("จะลองซิงก์ใหม่อัตโนมัติ");
  const reads=cloud.calls["ot_settings:selectOne"];
  delete cloud.failures["ot_settings:upsert"];delete cloud.failures["ot_entries:upsert"];
  await d.page.evaluate(()=>{for(let i=0;i<4;i++)window.dispatchEvent(new Event("online"));});
  await expect.poll(()=>liveNotes(cloud),POLL).toEqual(["รายการรอเชื่อมต่อ"]);
  await expect.poll(()=>cloud.rows.ot_settings[0]?.data.recorderName,POLL).toBe("ค่าล่าสุดในเครื่อง");
  await expect(d.page.locator("#syncErrorBanner")).toBeHidden();
  expect(cloud.calls["ot_settings:selectOne"]).toBe(reads+1);
 }finally{await d.context.close();}
});

test("a queued transient retry is cancelled when its account session ends",async({browser})=>{
 const cloud=makeCloud(),d=await openDevice(browser,cloud);
 try{
  await ready(d.page);
  await d.page.clock.install();
  cloud.failures["ot_entries:upsert"]={message:"Failed to fetch"};
  await record(d.page,"รายการของบัญชีเดิม");
  await expect(d.page.locator("#syncErrorBanner")).toContainText("จะลองซิงก์ใหม่อัตโนมัติ");
  const writes=cloud.calls["ot_entries:upsert"];
  await d.page.evaluate(()=>window.__authCb("SIGNED_OUT",null));
  await expect(d.page.locator("#authSignedOut")).toBeVisible();
  delete cloud.failures["ot_entries:upsert"];
  // Advance browser timers past the retry without waiting in real time.
  await d.page.clock.runFor(6000);
  expect(cloud.calls["ot_entries:upsert"]).toBe(writes);
  expect(liveNotes(cloud)).toEqual([]);
  expect(await d.page.evaluate(()=>JSON.parse(localStorage.getItem("ot-tracker-data-v1")).entries[0].note)).toBe("รายการของบัญชีเดิม");
 }finally{await d.context.close();}
});

test("permission failures remain actionable rather than triggering automatic retry loops",async({browser})=>{
 const cloud=makeCloud(),d=await openDevice(browser,cloud);
 try{
  await ready(d.page);
  await d.page.clock.install();
  cloud.failures["ot_entries:upsert"]={code:"42501",message:"row level security rejected write"};
  await record(d.page,"รายการรอแก้สิทธิ์");
  await expect(d.page.locator("#syncErrorBanner")).toContainText("42501");
  await expect(d.page.locator("#syncErrorBanner")).not.toContainText("จะลองซิงก์ใหม่อัตโนมัติ");
  const writes=cloud.calls["ot_entries:upsert"];
  await d.page.clock.runFor(180000);
  expect(cloud.calls["ot_entries:upsert"]).toBe(writes);
  expect(liveNotes(cloud)).toEqual([]);
 }finally{await d.context.close();}
});
