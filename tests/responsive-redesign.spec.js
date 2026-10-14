const {test,expect}=require("@playwright/test");
const {USER_ID,POLL,makeCloud,prepareContext,waitForApp,addEntry}=require("./support/fake-supabase");
test.setTimeout(180000);
function demo(){
 const cloud=makeCloud(),now=new Date(),ym=now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0");
 cloud.rows.ot_settings.push({user_id:USER_ID,data:{monthlySalary:2345678,hourlyRate:10000,otGoal:300000,currency:"KRW"},updated_at:"2026-01-01T00:00:00Z"});
 for(let i=1;i<=6;i++)cloud.rows.ot_entries.push({id:"00000000-0000-4000-8000-"+String(900+i).padStart(12,"0"),
  user_id:USER_ID,date:ym+"-"+String(i).padStart(2,"0"),time_in:"08:00",time_out:i%2?"19:00":"20:00",
  ot_multiplier:null,note:i===2?"ทดสอบข้อความยาวสำหรับหน้าจอมือถือและการแสดงผลข้อมูล":"",updated_at:"2026-01-01T00:00:00Z",deleted_at:null});
 return cloud;
}
async function device(browser,viewport={width:390,height:844},mobile=true,appearance={}){
 const context=await browser.newContext({viewport,isMobile:mobile,hasTouch:mobile,deviceScaleFactor:1,colorScheme:appearance.colorScheme||"light"});
 const page=await context.newPage(),cloud=demo();
 await prepareContext(context,cloud,page);
 if(appearance.theme)await context.addInitScript(({theme,palette})=>{
  localStorage.setItem("ot-tracker-theme",theme);
  localStorage.setItem("ot-tracker-color-theme",palette);
 },appearance);
 await page.goto("/");await waitForApp(page);
 await page.locator('.tabbar__btn[data-view="settings"]').click();
 await expect(page.locator("#syncStatusText")).toContainText("ซิงก์ล่าสุดเมื่อ",POLL);
 return {page,context,cloud};
}
const tab=(page,view)=>page.locator('.tabbar__btn[data-view="'+view+'"]').click();
async function noPageOverflow(page,width){
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);
}
async function dialogFits(page,selector,width,height){
 const box=await page.locator(selector).boundingBox();
 expect(box.x).toBeGreaterThanOrEqual(0);expect(box.y).toBeGreaterThanOrEqual(0);
 expect(box.x+box.width).toBeLessThanOrEqual(width+1);expect(box.y+box.height).toBeLessThanOrEqual(height+1);
}
test("all views and dialogs fit phones, tablets, landscape and desktop without horizontal page scrolling",async({browser})=>{
 const d=await device(browser);
 try{
  for(const [width,height] of [[320,640],[360,740],[375,812],[390,844],[430,932],[768,1024],[1024,768],[1440,900],[844,390]]){
   await d.page.setViewportSize({width,height});
   for(const view of ["entry","summary","settings"]){
    await tab(d.page,view);await noPageOverflow(d.page,width);
   }
   await tab(d.page,"entry");
   await d.page.locator("#dateTrigger").click();
   await dialogFits(d.page,"#calendarOverlay .calendar-box",width,height);
   await d.page.locator("#calClose").click();
   await tab(d.page,"settings");await d.page.locator("#currencyTrigger").click();
   await dialogFits(d.page,"#currencyOverlay .currency-box",width,height);
   await d.page.locator("#currencyClose").click();
  }
  await d.page.setViewportSize({width:375,height:812});
  for(const code of ["ne","my","ja","en"]){
   await d.page.locator("#languageSelect").selectOption(code);
   for(const view of ["entry","summary","settings"]){await tab(d.page,view);await noPageOverflow(d.page,375);}
  }
  await tab(d.page,"entry");
  for(const selector of ["#dateTrigger","#f-timein","#f-timeout","#saveEntryBtn","#languageSelect"]){
   const box=await d.page.locator(selector).boundingBox();
   expect(box.width).toBeGreaterThanOrEqual(44);expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(await d.page.locator("#f-timein").evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  expect(await d.page.locator("#languageSelect").evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  const viewport=await d.page.locator('meta[name="viewport"]').getAttribute("content");
  expect(viewport).not.toContain("maximum-scale");expect(viewport).not.toContain("user-scalable=no");
 }finally{await d.context.close();}
});
test("mobile time entry, saved history and expandable income details work after the redesign",async({browser})=>{
 const d=await device(browser,{width:375,height:812});
 try{
  await tab(d.page,"entry");await addEntry(d.page,"08:00","20:00","mobile redesign check");
  await expect.poll(()=>d.cloud.rows.ot_entries.some(r=>r.note==="mobile redesign check"),POLL).toBe(true);
  await tab(d.page,"summary");await expect(d.page.locator("#statTotalPay")).not.toHaveText("₩0");
  await d.page.locator("#summaryDays details").first().locator("summary").click();
  await expect(d.page.locator("#summaryDays details").first().locator(".summary-ot-formula").first()).toBeVisible();
  await d.page.locator("#exportExcelBtn").click();
  await expect(d.page.locator("#exportConfirmBtn")).toBeVisible();
  await d.page.locator("#exportCancelBtn").click();
  await tab(d.page,"entry");
  await expect(d.page.locator(".entry-item",{hasText:"mobile redesign check"})).toBeVisible();
 }finally{await d.context.close();}
});
test("one orange charcoal appearance stays readable despite old preferences and system appearance",async({browser})=>{
 function contrast(a,b){
  const luminance=color=>{const rgb=color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
  const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
 }
 let firstBackground;
 for(const appearance of [
  {theme:"light",palette:"ocean",colorScheme:"light"},
  {theme:"dark",palette:"midnight",colorScheme:"dark"},
  {theme:"light",palette:"sunset",colorScheme:"dark"}
 ]){
  const d=await device(browser,{width:390,height:844},true,appearance);
  try{
   await expect(d.page.locator("#themeToggleBtn,#colorThemeToggleBtn,.theme-swatch")).toHaveCount(0);
   const background=await d.page.locator("body").evaluate(el=>getComputedStyle(el).backgroundColor);
   if(!firstBackground)firstBackground=background;
   expect(background).toBe(firstBackground);
   expect(background).not.toBe("rgb(0, 0, 0)");
   await tab(d.page,"entry");
   const button=await d.page.locator("#saveEntryBtn").evaluate(el=>({fg:getComputedStyle(el).color,bg:getComputedStyle(el).backgroundColor}));
   expect(contrast(button.fg,button.bg)).toBeGreaterThanOrEqual(4.5);
   await tab(d.page,"summary");
   for(const selector of [".hero-stat--pay .hero-stat__value",".hero-stat--pay .hero-stat__label",".hero-stat--ot .hero-stat__value",".stat-tile__label"]){
    const colors=await d.page.locator(selector).first().evaluate(el=>{
     let parent=el;
     while(parent&&getComputedStyle(parent).backgroundColor==="rgba(0, 0, 0, 0)")parent=parent.parentElement;
     return {fg:getComputedStyle(el).color,bg:getComputedStyle(parent).backgroundColor};
    });
    expect(contrast(colors.fg,colors.bg)).toBeGreaterThanOrEqual(4.5);
   }
   await expect(d.page.locator("#statTotalPay")).not.toHaveText("₩0");
   await d.page.reload();await waitForApp(d.page);
   expect(await d.page.locator("body").evaluate(el=>getComputedStyle(el).backgroundColor)).toBe(firstBackground);
  }finally{await d.context.close();}
 }
});
test("capture synthetic design previews for review",async({browser},info)=>{
 const d=await device(browser);
 async function capture(name){
  const body=await d.page.screenshot({animations:"disabled",style:".toast {visibility:hidden!important;} "});
  await info.attach(name,{body,contentType:"image/png"});
  // Only seeded demonstration data is rendered here, never production data.
  // Chunked previews allow review through the read-only Actions log connector.
  if(info.project.name==="chromium"){
   const data=body.toString("base64");
   for(let i=0;i<data.length;i+=12000)console.log("DESIGN_PREVIEW|"+name+"|"+(i/12000)+"|"+data.slice(i,i+12000));
  }
 }
 try{
  await d.page.setViewportSize({width:390,height:844});await tab(d.page,"entry");await d.page.locator("#f-timein").fill("08:00");await d.page.locator("#f-timeout").fill("19:00");await d.page.evaluate(()=>window.scrollTo(0,0));await capture("mobile-entry");
  await tab(d.page,"summary");await d.page.evaluate(()=>window.scrollTo(0,0));await capture("mobile-summary");
  await d.page.setViewportSize({width:1440,height:1000});await d.page.evaluate(()=>window.scrollTo(0,0));await capture("desktop-summary");
  await d.page.setViewportSize({width:390,height:844});await tab(d.page,"settings");await d.page.evaluate(()=>window.scrollTo(0,0));await capture("mobile-settings");
  await tab(d.page,"entry");await d.page.locator("#dateTrigger").click();await capture("mobile-calendar");await d.page.locator("#calClose").click();
  await tab(d.page,"summary");await d.page.locator("#summaryDays details").first().locator("summary").click();await d.page.locator("#summaryDays").scrollIntoViewIfNeeded();await capture("mobile-details");
 }finally{await d.context.close();}
});
