const {test,expect}=require("@playwright/test");
const {USER_ID,POLL,makeCloud,prepareContext,waitForApp,openDevice,addEntry,liveNotes}=require("./support/fake-supabase");
test.setTimeout(90000);
const codes=["th","en","ko","ja","zh-CN","zh-TW","vi","my","id","fil","ne"];
const OTHER="00000000-0000-4000-8000-0000000000ff";
const WORKING="ot-tracker-data-v1";
const tab=(page,view)=>page.locator('.tabbar__btn[data-view="'+view+'"]').click();
async function ready(page){
 await tab(page,"settings");
 await expect(page.locator("#syncStatusRow")).toBeVisible();
 await expect(page.locator("#syncStatusRow")).not.toHaveClass(/sync-status--syncing/,POLL);
 await expect(page.locator("#syncErrorBanner")).toBeHidden();
 await expect(page.locator("#syncRetryBtn")).toBeHidden();
}
async function choose(page,code){
 await page.locator("#languageSelect").selectOption(code);
 await expect(page.locator("html")).toHaveAttribute("lang",code);
 await expect(page.locator("#settingsLanguageSelect")).toHaveValue(code);
}
async function sameBrowser(context,cloud,userId){
 const page=await context.newPage();await prepareContext(context,cloud,page,userId);
 await page.goto("/");await waitForApp(page);return page;
}
async function logout(page){
 await tab(page,"settings");await page.locator("#logoutBtn").click();
 await expect(page.locator("#authSignedOut")).toBeVisible();
}
async function visibleThaiUI(page){
 return page.evaluate(()=>{
  const roots=[document.querySelector("main"),document.getElementById("tabbar")],found=[];
  for(const root of roots){
   const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
   while((node=walker.nextNode())){
    const el=node.parentElement;
    if(!el||el.closest("option,script,style,textarea,input")||!el.getClientRects().length)continue;
    if(/[\u0e01-\u0e3a\u0e40-\u0e4e]/.test(node.nodeValue))found.push(node.nodeValue.trim());
   }
  }return found;
 });
}

for(const code of codes)test("interface, calendar and mobile controls work in "+code,async({browser})=>{
 const d=await openDevice(browser,makeCloud());
 try{
  await ready(d.page);await d.page.setViewportSize({width:375,height:812});
  await expect(d.page.locator("#languageSelect option")).toHaveCount(11);
  await choose(d.page,code);
  const label=await d.page.evaluate(()=>window.OTI18N.t("บันทึกเวลา"));
  await expect(d.page.locator('.tabbar__btn[data-view="entry"]')).toContainText(label);
  for(const view of ["entry","summary","settings"]){
   await tab(d.page,view);
   if(code!=="th")expect(await visibleThaiUI(d.page)).toEqual([]);
  }
  const box=await d.page.locator("#languageSelect").boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(376);
  await tab(d.page,"entry");await d.page.locator("#dateTrigger").click();
  await expect(d.page.locator("#calMonthLabel")).not.toHaveText("-");
  await d.page.locator("#calToday").click();
  const year=new Date().getFullYear();
  await expect(d.page.locator("#dateTriggerText")).toContainText(String(code==="th"?year+543:year));
  expect(await d.page.evaluate(()=>JSON.parse(localStorage.getItem("ot-tracker-data-v1")).settings.currency)).toBe("KRW");
 }finally{await d.context.close();}
});

test("signed-out users can choose and remember a language without creating OT data",async({browser})=>{
 const context=await browser.newContext(),page=await context.newPage(),cloud=makeCloud();
 try{
  await prepareContext(context,cloud,page);
  await page.addInitScript(()=>{
   const create=window.supabase.createClient;
   window.supabase.createClient=function(){const client=create();client.auth.getSession=()=>Promise.resolve({data:{session:null}});return client;};
  });
  await page.goto("/");await waitForApp(page);await choose(page,"fil");
  await tab(page,"settings");await expect(page.locator("#googleLoginBtn")).toContainText("Mag-sign in");
  expect(await page.evaluate(()=>localStorage.getItem("ot-tracker-data-v1"))).toBeNull();
  await page.reload();await waitForApp(page);await expect(page.locator("html")).toHaveAttribute("lang","fil");
  expect(cloud.rows.ot_settings).toEqual([]);expect(cloud.rows.ot_entries).toEqual([]);
 }finally{await context.close();}
});

test("account language syncs to a second device while user names, notes and values stay intact",async({browser})=>{
 const cloud=makeCloud(),a=await openDevice(browser,cloud);let b;
 try{
  await ready(a.page);await a.page.locator("#s-recordername").fill("บันทึก");
  await tab(a.page,"entry");await addEntry(a.page,"08:00","19:00","บันทึก โน้ต ภาษา <keep>");
  await expect.poll(()=>liveNotes(cloud,USER_ID),POLL).toEqual(["บันทึก โน้ต ภาษา <keep>"]);
  const before=JSON.parse(JSON.stringify(cloud.rows.ot_entries));
  await choose(a.page,"ne");
  await expect.poll(()=>cloud.rows.ot_settings.find(r=>r.user_id===USER_ID)?.data.language,POLL).toBe("ne");
  b=await openDevice(browser,cloud);await ready(b.page);
  await expect(b.page.locator("html")).toHaveAttribute("lang","ne");
  await expect(b.page.locator("#headerTitle")).toContainText("บันทึก");
  await tab(b.page,"entry");await expect(b.page.locator(".entry-item__note")).toHaveText("บันทึก โน้ต ภาษา <keep>");
  expect(cloud.rows.ot_entries).toEqual(before);
  expect(cloud.rows.ot_settings[0].data.currency).toBe("KRW");
  expect(cloud.rows.ot_settings[0].data.hourlyRate).toBe(10000);
 }finally{await a.context.close();if(b)await b.context.close();}
});

test("switching languages preserves unsaved and edited form content",async({browser})=>{
 const d=await openDevice(browser,makeCloud());
 try{
  await ready(d.page);await tab(d.page,"entry");await d.page.locator("#dateTrigger").click();await d.page.locator("#calToday").click();
  await d.page.locator("#f-timein").fill("08:00");await d.page.locator("#f-timeout").fill("19:00");
  const note='บันทึก ภาษา <img src=x onerror="window.__unsafe=1"> नेपाली';
  await d.page.locator("#f-note").fill(note);
  const date=await d.page.locator("#f-date").inputValue();
  for(const code of ["en","my","ne","fil","ja"]){
   await choose(d.page,code);
   await expect(d.page.locator("#f-timein")).toHaveValue("08:00");await expect(d.page.locator("#f-timeout")).toHaveValue("19:00");
   await expect(d.page.locator("#f-note")).toHaveValue(note);await expect(d.page.locator("#f-date")).toHaveValue(date);
  }
  await d.page.locator("#saveEntryBtn").click();await expect(d.page.locator(".entry-item__note")).toHaveText(note);
  expect(await d.page.evaluate(()=>window.__unsafe)).toBeUndefined();
  await d.page.locator(".entry-item [data-action=edit]").click();await choose(d.page,"fil");
  await expect(d.page.locator("#entryFormTitle")).toHaveText("I-edit ang tala");
  await expect(d.page.locator("#saveEntryBtn")).toHaveText("I-save ang mga pagbabago");
  await expect(d.page.locator("#f-note")).toHaveValue(note);
 }finally{await d.context.close();}
});

test("Excel headers and sheet names follow each locale without changing numeric data",async({browser})=>{
 const cloud=makeCloud(),d=await openDevice(browser,cloud);
 try{
  await ready(d.page);await tab(d.page,"entry");await addEntry(d.page,"08:00","19:00","Unicode test မြန်မာ नेपाली");
  await d.page.evaluate(()=>{
   window.XLSX={utils:{
    json_to_sheet:rows=>({rows}),book_new:()=>({Sheets:{},SheetNames:[]}),
    book_append_sheet:(book,sheet,name)=>{if(name.length>31||/[\\/?*\[\]:]/.test(name))throw Error("Invalid sheet name");book.Sheets[name]=sheet;book.SheetNames.push(name);}
   },writeFile:(book,name)=>{window.__exportedBook=book;window.__exportedName=name;}};
  });
  let baseline;
  for(const code of codes){
   await choose(d.page,code);await tab(d.page,"summary");await d.page.locator("#exportExcelBtn").click();await d.page.locator("#exportConfirmBtn").click();
   const result=await d.page.evaluate(()=>{
    const book=window.__exportedBook,detail=book.Sheets[book.SheetNames[2]].rows;
    return {names:book.SheetNames,keys:Object.keys(detail[0]),values:Object.values(detail[0]),expectedDate:window.OTI18N.t("วันที่")};
   });
   expect(result.names).toHaveLength(3);expect(new Set(result.names).size).toBe(3);
   expect(result.keys[0]).toBe(result.expectedDate);
   expect(result.values.slice(3).every(v=>typeof v==="number")).toBe(true);
   if(!baseline)baseline=result.values;else expect(result.values).toEqual(baseline);
  }
 }finally{await d.context.close();}
});

test("each Google account restores its own language when sharing the same browser",async({browser})=>{
 const cloud=makeCloud(),d=await openDevice(browser,cloud);
 cloud.rows.ot_settings.push({user_id:OTHER,data:{language:"ne",currency:"THB"},updated_at:"2026-01-01T00:00:00Z"});
 try{
  await ready(d.page);await choose(d.page,"ja");await tab(d.page,"entry");await addEntry(d.page,"08:00","19:00","A only");
  await expect.poll(()=>cloud.rows.ot_settings.find(r=>r.user_id===USER_ID)?.data.language,POLL).toBe("ja");
  await logout(d.page);await d.page.close();
  const other=await sameBrowser(d.context,cloud,OTHER);await ready(other);await expect(other.locator("html")).toHaveAttribute("lang","ne");
  await choose(other,"en");await expect.poll(()=>cloud.rows.ot_settings.find(r=>r.user_id===OTHER)?.data.language,POLL).toBe("en");
  await logout(other);await other.close();
  cloud.failures["ot_entries:selectAll"]={message:"Failed to fetch"};
  const returned=await sameBrowser(d.context,cloud,USER_ID);
  await expect(returned.locator("html")).toHaveAttribute("lang","ja");
  await tab(returned,"entry");await expect(returned.locator(".entry-item__note")).toHaveText("A only");
  expect(cloud.rows.ot_settings.find(r=>r.user_id===OTHER).data.language).toBe("en");
 }finally{await d.context.close();}
});

test("offline language changes remain usable and localize sync failures",async({browser})=>{
 const cloud=makeCloud(),d=await openDevice(browser,cloud);
 try{
  await ready(d.page);cloud.failures["ot_settings:upsert"]={message:"Failed to fetch"};
  await d.context.setOffline(true);await choose(d.page,"my");await tab(d.page,"settings");
  await expect(d.page.locator("#syncErrorBanner")).toBeVisible(POLL);
  await expect(d.page.locator("#syncStatusText")).toContainText("ချိန်ကိုက်မအောင်မြင်ပါ");
  await choose(d.page,"ne");await expect(d.page.locator("#syncStatusText")).toContainText("सिंक असफल");
  expect(await d.page.evaluate(()=>JSON.parse(localStorage.getItem("ot-tracker-data-v1")).settings.language)).toBe("ne");
 }finally{await d.context.close();}
});

test("money display uses the currency separators consistently with editable money inputs",async({browser})=>{
 const cloud=makeCloud(),d=await openDevice(browser,cloud);
 try{
  await ready(d.page);await d.page.locator("#s-hourlyrate").fill("25000");
  await d.page.locator("#s-monthlysalary").fill("2345678");
  await tab(d.page,"summary");
  const expected=await d.page.locator("#sbSalary").textContent();
  expect(expected).toBe("₩2,345,678");
  for(const code of codes){
   await choose(d.page,code);await tab(d.page,"summary");
   await expect(d.page.locator("#sbSalary")).toHaveText(expected);
   await tab(d.page,"settings");await expect(d.page.locator("#s-hourlyrate")).toHaveValue("25,000");
  }
 }finally{await d.context.close();}
});
test("a cached shell or unavailable locale assets never prevent recording OT",async({browser})=>{
 const cloud=makeCloud(),context=await browser.newContext(),page=await context.newPage();
 try{
  await prepareContext(context,cloud,page);
  await context.route(/\/js\/i18n(?:-catalog)?\.js(?:\?|$)/,route=>route.abort());
  const errors=[];page.on("pageerror",error=>errors.push(error.message));
  await page.goto("/");await waitForApp(page);await ready(page);
  await tab(page,"entry");await addEntry(page,"08:00","19:00","recorded during shell refresh");
  await expect.poll(()=>liveNotes(cloud,USER_ID),POLL).toEqual(["recorded during shell refresh"]);
  expect(errors).toEqual([]);
 }finally{await context.close();}
});
