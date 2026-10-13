const {test,expect}=require("@playwright/test");
const {USER_ID,POLL,makeCloud,prepareContext,waitForApp,openDevice,addEntry,liveNotes,shownNotes}=require("./support/fake-supabase");
test.setTimeout(90000);
const OTHER="00000000-0000-4000-8000-0000000000ff";
const WORKING="ot-tracker-data-v1";
const CACHE=WORKING+":account:";
const settings=page=>page.locator('.tabbar__btn[data-view="settings"]').click();
async function ready(page){await settings(page);await expect(page.locator("#syncStatusText")).toContainText("ซิงก์ล่าสุดเมื่อ",POLL);}
async function openSameBrowser(context,cloud,userId){
 const page=await context.newPage();await prepareContext(context,cloud,page,userId);
 await page.goto("/");await waitForApp(page);return page;
}
async function logout(page){
 await settings(page);await page.locator("#logoutBtn").click();
 await expect(page.locator("#authSignedOut")).toBeVisible();
}

test("1000 historical OT records survive logout and same-account return during a cloud outage",async({browser})=>{
 const cloud=makeCloud(),today=new Date();today.setUTCHours(0,0,0,0);
 for(let i=0;i<1000;i++){
  const day=new Date(today);day.setUTCDate(today.getUTCDate()-i);
  cloud.rows.ot_entries.push({id:"00000000-0000-4000-8000-"+String(i+2).padStart(12,"0"),user_id:USER_ID,date:day.toISOString().slice(0,10),time_in:"08:00",time_out:"18:00",note:"ประวัติ "+i,updated_at:"2026-01-01T00:00:00Z",deleted_at:null});
 }
 const d=await openDevice(browser,cloud);
 try{
  await ready(d.page);
  await logout(d.page);
  expect(await d.page.evaluate(key=>localStorage.getItem(key),WORKING)).toBeNull();
  expect(await d.page.evaluate(key=>JSON.parse(localStorage.getItem(key)).entries.length,CACHE+USER_ID)).toBe(1000);
  await d.page.close();
  cloud.failures["ot_entries:selectAll"]={message:"Failed to fetch"};
  const returned=await openSameBrowser(d.context,cloud,USER_ID);
  await settings(returned);await expect(returned.locator("#syncErrorBanner")).toBeVisible();
  expect(await returned.evaluate(key=>JSON.parse(localStorage.getItem(key)).entries.length,WORKING)).toBe(1000);
  await returned.locator('.tabbar__btn[data-view="entry"]').click();
  await expect(returned.locator(".entry-item__note",{hasText:"ประวัติ 0"})).toBeVisible();
  delete cloud.failures["ot_entries:selectAll"];
  await settings(returned);await returned.locator("#syncRetryBtn").click();
  await expect(returned.locator("#syncErrorBanner")).toBeHidden();
  expect(liveNotes(cloud,USER_ID).length).toBe(1000);
 }finally{await d.context.close();}
});

test("a different Google account cannot replace or upload the original account's unsynced OT",async({browser})=>{
 const cloud=makeCloud(),d=await openDevice(browser,cloud);
 try{
  await ready(d.page);
  cloud.failures["ot_entries:upsert"]={message:"Failed to fetch"};
  await d.page.locator('.tabbar__btn[data-view="entry"]').click();
  await addEntry(d.page,"08:00","19:00","โอทีที่ยังไม่ขึ้นคลาวด์ของ A");
  await settings(d.page);await expect(d.page.locator("#syncRetryBtn")).toBeVisible();
  await d.page.evaluate(()=>window.__authCb("SIGNED_OUT",null));
  await expect(d.page.locator("#authSignedOut")).toBeVisible();await d.page.close();
  delete cloud.failures["ot_entries:upsert"];
  const other=await openSameBrowser(d.context,cloud,OTHER);await ready(other);
  expect(await shownNotes(other)).toEqual([]);
  expect(liveNotes(cloud,OTHER)).toEqual([]);
  expect(await other.evaluate(key=>JSON.parse(localStorage.getItem(key)).entries[0].note,CACHE+USER_ID)).toBe("โอทีที่ยังไม่ขึ้นคลาวด์ของ A");
  await other.locator('.tabbar__btn[data-view="entry"]').click();
  await addEntry(other,"09:00","20:00","โอทีของ B");
  await expect.poll(()=>liveNotes(cloud,OTHER),POLL).toEqual(["โอทีของ B"]);
  await logout(other);await other.close();
  cloud.failures["ot_entries:selectAll"]={message:"Failed to fetch"};
  const mine=await openSameBrowser(d.context,cloud,USER_ID);
  await settings(mine);await expect(mine.locator("#syncRetryBtn")).toBeVisible();
  expect(await shownNotes(mine)).toEqual(["โอทีที่ยังไม่ขึ้นคลาวด์ของ A"]);
  delete cloud.failures["ot_entries:selectAll"];
  await mine.locator("#syncRetryBtn").click();
  await expect.poll(()=>liveNotes(cloud,USER_ID),POLL).toEqual(["โอทีที่ยังไม่ขึ้นคลาวด์ของ A"]);
  expect(liveNotes(cloud,OTHER)).toEqual(["โอทีของ B"]);
 }finally{await d.context.close();}
});

test("a local recovery-copy failure blocks logout rather than discarding the working data",async({browser})=>{
 const cloud=makeCloud(),d=await openDevice(browser,cloud);
 try{
  await ready(d.page);
  await d.page.locator('.tabbar__btn[data-view="entry"]').click();
  await addEntry(d.page,"08:00","19:00","รายการก่อนพื้นที่เต็ม");
  await settings(d.page);await expect(d.page.locator("#syncStatusText")).toContainText("ซิงก์ล่าสุดเมื่อ",POLL);
  await d.page.evaluate(()=>{
   const original=Storage.prototype.setItem;
   Storage.prototype.setItem=function(key,value){
    if(String(key).startsWith("ot-tracker-data-v1:account:"))throw new DOMException("quota full","QuotaExceededError");
    return original.call(this,key,value);
   };
  });
  await d.page.locator("#logoutBtn").click();
  await expect(d.page.locator("#toast")).toContainText("เก็บสำเนาข้อมูลในเครื่องไม่สำเร็จ");
  await expect(d.page.locator("#authSignedIn")).toBeVisible();
  expect(await d.page.evaluate(key=>JSON.parse(localStorage.getItem(key)).entries[0].note,WORKING)).toBe("รายการก่อนพื้นที่เต็ม");
 }finally{await d.context.close();}
});

test("partial working-storage failure preserves the newest owned copy through account switching",async({browser})=>{
 const cloud=makeCloud(),d=await openDevice(browser,cloud);
 try{
  await ready(d.page);
  cloud.failures["ot_entries:upsert"]={message:"Failed to fetch"};
  await d.page.evaluate(()=>{
   const original=Storage.prototype.setItem;
   Storage.prototype.setItem=function(key,value){
    if(key==="ot-tracker-data-v1")throw new DOMException("working storage failed","QuotaExceededError");
    return original.call(this,key,value);
   };
  });
  await d.page.locator('.tabbar__btn[data-view="entry"]').click();
  await addEntry(d.page,"08:00","19:00","รายการล่าสุดในสำเนาบัญชี");
  await settings(d.page);await expect(d.page.locator("#syncRetryBtn")).toBeVisible();
  await d.page.close();delete cloud.failures["ot_entries:upsert"];
  const other=await openSameBrowser(d.context,cloud,OTHER);await ready(other);
  expect(liveNotes(cloud,USER_ID)).toEqual([]);
  expect(await other.evaluate(key=>JSON.parse(localStorage.getItem(key)).entries[0].note,CACHE+USER_ID)).toBe("รายการล่าสุดในสำเนาบัญชี");
  await logout(other);await other.close();
  const mine=await openSameBrowser(d.context,cloud,USER_ID);await ready(mine);
  await expect.poll(()=>liveNotes(cloud,USER_ID),POLL).toEqual(["รายการล่าสุดในสำเนาบัญชี"]);
 }finally{await d.context.close();}
});

test("owned recovery copies retain tombstones so logout does not resurrect a deleted entry",async({browser})=>{
 const cloud=makeCloud(),d=await openDevice(browser,cloud);
 try{
  await ready(d.page);await d.page.locator('.tabbar__btn[data-view="entry"]').click();
  await addEntry(d.page,"08:00","18:00","รายการที่จะลบหลังซิงก์");
  await expect.poll(()=>liveNotes(cloud,USER_ID),POLL).toEqual(["รายการที่จะลบหลังซิงก์"]);
  await d.page.locator(".entry-item").locator('[data-action="delete"]').click();await d.page.locator("#confirmOk").click();
  await expect.poll(()=>liveNotes(cloud,USER_ID),POLL).toEqual([]);
  await logout(d.page);await d.page.close();
  const returned=await openSameBrowser(d.context,cloud,USER_ID);await ready(returned);
  expect(await shownNotes(returned)).toEqual([]);
  expect(liveNotes(cloud,USER_ID)).toEqual([]);
  expect(await returned.evaluate(key=>JSON.parse(localStorage.getItem(key)).deletedEntries.length,WORKING)).toBe(1);
 }finally{await d.context.close();}
});
