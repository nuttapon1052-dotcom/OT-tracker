const { test, expect } = require("@playwright/test");
const { USER_ID, POLL, makeCloud, openDevice } = require("./support/fake-supabase");
test.setTimeout(90000);
const codes=["th","en","ko","ja","zh-CN","zh-TW","vi","my","id","fil","ne"];
const iso=date=>date.getFullYear()+"-"+String(date.getMonth()+1).padStart(2,"0")+"-"+String(date.getDate()).padStart(2,"0");
const month=date=>iso(date).slice(0,7);
const now=new Date(), current=new Date(now.getFullYear(),now.getMonth(),1), previous=new Date(now.getFullYear(),now.getMonth()-1,1);
function weekdays(date,count){
 const dates=[];for(let day=1;dates.length<count;day++){
  const d=new Date(date.getFullYear(),date.getMonth(),day);
  if(d.getDay()!==0&&d.getDay()!==6)dates.push(iso(d));
 }return dates;
}
function fixture(){
 const cloud=makeCloud();
 cloud.rows.ot_settings.push({user_id:USER_ID,data:{monthlySalary:2000,hourlyRate:100,otGoal:5000,currency:"KRW"},updated_at:"2026-01-01T00:00:00Z"});
 let serial=0;
 for(const [date,out] of [[previous,"20:00"],[current,"22:30"]]){
  for(const day of weekdays(date,6))cloud.rows.ot_entries.push({
   id:"00000000-0000-4000-8000-"+String(++serial).padStart(12,"0"),user_id:USER_ID,date:day,
   time_in:"08:00",time_out:out,ot_multiplier:null,note:serial===1?'<img src=x onerror="window.__unsafe=1"> งานเดิม':"งาน "+serial,
   updated_at:"2026-01-01T00:00:00Z",deleted_at:null
  });
 }return cloud;
}
async function summary(page){
 await page.locator('.tabbar__btn[data-view="settings"]').click();
 await expect(page.locator("#syncStatusText")).toContainText("ซิงก์ล่าสุดเมื่อ",POLL);
 await page.locator('.tabbar__btn[data-view="summary"]').click();
}
test("selecting the 15-hour chart month updates income, comparison, goal, daily detail and Excel period without writing records",async({browser})=>{
 const cloud=fixture(),d=await openDevice(browser,cloud);
 try{
  await summary(d.page);
  await expect(d.page.locator("#statOtHours")).toHaveText("30.0");
  await expect(d.page.locator("#statTotalPay")).toHaveText("₩6,500");
  await expect(d.page.locator("#summarySalary")).toHaveText("₩2,000");
  const comparison=d.page.locator("#monthComparisonBody tr");
  await expect(comparison.nth(0).locator("td").nth(0)).toHaveText("15.0");
  await expect(comparison.nth(0).locator("td").nth(1)).toHaveText("30.0");
  await expect(comparison.nth(0).locator("td").nth(2)).toHaveText("+15.0");
  await expect(comparison.nth(2).locator("td").nth(0)).toHaveText("₩4,250");
  await expect(comparison.nth(2).locator("td").nth(2)).toHaveText("+₩2,250");
  const before=await d.page.evaluate(()=>localStorage.getItem("ot-tracker-data-v1"));
  const originalCloud=JSON.stringify(cloud.rows.ot_entries);
  const bar=d.page.locator('#trendChart [data-month="'+month(previous)+'"]');
  await bar.locator(".trend-col__value").click();
  await expect(d.page.locator("#summaryMonthPicker")).toHaveValue(month(previous));
  await expect(d.page.locator("#statOtHours")).toHaveText("15.0");
  await expect(d.page.locator("#statOtPay")).toHaveText("₩2,250");
  await expect(d.page.locator("#statTotalPay")).toHaveText("₩4,250");
  await expect(d.page.locator("#sbSalary")).toHaveText("₩2,000");
  await expect(d.page.locator("#sbOtPay")).toHaveText("₩2,250");
  await expect(d.page.locator("#sbTotal")).toHaveText("₩4,250");
  await expect(d.page.locator("#statNormalHours")).toHaveText("48.0");
  await expect(d.page.locator("#goalProgressPct")).toHaveText("45%");
  await expect(d.page.locator("#trendChart [aria-pressed=true]")).toHaveAttribute("data-month",month(previous));
  await expect(d.page.locator("#summaryDays details")).toHaveCount(6);
  const first=d.page.locator("#summaryDays details").first();
  await expect(first.locator("summary")).toContainText("OT 2.5 ชม.");
  await expect(first.locator("summary")).toContainText("₩375");
  await first.locator("summary").click();
  await expect(first.locator(".summary-entry-heading")).toContainText("08:00 – 20:00");
  await expect(first.locator(".summary-ot-formula")).toHaveText("2.5 ชม. × ₩100 × 1.5 = ₩375");
  await expect(first.locator(".summary-entry-breaks")).toContainText("มีพักเที่ยง 1.0 ชม.");
  await expect(first.locator(".summary-entry-breaks")).toContainText("มีพักเย็น 0.5 ชม.");
  await expect(first.locator(".summary-entry-schedule")).toContainText("17:00");
  await expect(first.locator(".summary-entry-note")).toContainText("<img src=x");
  expect(await d.page.evaluate(()=>window.__unsafe)).toBeUndefined();
  await d.page.evaluate(()=>{
   window.XLSX={utils:{json_to_sheet:rows=>({rows}),book_new:()=>({Sheets:{},SheetNames:[]}),
    book_append_sheet:(book,sheet,name)=>{book.Sheets[name]=sheet;book.SheetNames.push(name);}
   },writeFile:book=>{window.__summaryExport=book;}};
  });
  await d.page.locator("#exportExcelBtn").click();
  await expect(d.page.locator("#exportRangeStart")).toHaveValue(month(previous)+"-01");
  const last=new Date(previous.getFullYear(),previous.getMonth()+1,0);
  await expect(d.page.locator("#exportRangeEnd")).toHaveValue(iso(last));
  await d.page.locator("#exportConfirmBtn").click();
  const exported=await d.page.evaluate(()=>{
   const book=window.__summaryExport;
   return {summary:book.Sheets[book.SheetNames[0]].rows,months:book.Sheets[book.SheetNames[1]].rows,
    detail:book.Sheets[book.SheetNames[2]].rows};
  });
  expect(exported.summary.find(row=>row["รายการ"]==="ยอดคาดว่าจะได้รับ")["ค่า"]).toBe(4250);
  expect(exported.months[11]["ยอดคาดว่าจะได้รับ"]).toBe(4250);
  expect(exported.detail).toHaveLength(6);
  expect(exported.detail.every(row=>row["วันที่"].startsWith(month(previous)))).toBe(true);
  expect(await d.page.evaluate(()=>localStorage.getItem("ot-tracker-data-v1"))).toBe(before);
  expect(JSON.stringify(cloud.rows.ot_entries)).toBe(originalCloud);
  await d.page.locator('#trendChart [data-month="'+month(current)+'"]').focus();
  await d.page.keyboard.press("Enter");
  await expect(d.page.locator("#statOtHours")).toHaveText("30.0");
  await expect(d.page.locator("#statTotalPay")).toHaveText("₩6,500");
  await d.page.locator('#trendChart [data-month="'+month(previous)+'"]').focus();
  await d.page.keyboard.press("Space");
  await expect(d.page.locator("#statOtHours")).toHaveText("15.0");
 }finally{await d.context.close();}
});
test("month picker, empty months, annual drill-down and return to current month keep all totals consistent",async({browser})=>{
 const d=await openDevice(browser,fixture());
 try{
  await summary(d.page);
  await d.page.locator("#summaryMonthPicker").fill("2020-01");
  await d.page.locator("#summaryMonthPicker").dispatchEvent("change");
  await expect(d.page.locator("#statOtHours")).toHaveText("0.0");
  await expect(d.page.locator("#statTotalPay")).toHaveText("₩2,000");
  await expect(d.page.locator("#summaryDataStatus")).toBeVisible();
  await expect(d.page.locator("#compareTotalPay")).not.toContainText("%");
  await expect(d.page.locator("#summaryDays .empty-state")).toBeVisible();
  await expect(d.page.locator("#comparisonNoData")).toBeVisible();
  await expect(d.page.locator("#monthComparisonBody")).not.toContainText("Infinity");
  await d.page.locator("#summaryToday").click();
  await expect(d.page.locator("#summaryMonthPicker")).toHaveValue(month(current));
  await d.page.locator('#summaryModeTabs [data-mode="year"]').click();
  await expect(d.page.locator("#monthComparisonCard")).toBeHidden();
  const annualOt=previous.getFullYear()===current.getFullYear()?6750:4500;
  await expect(d.page.locator("#statTotalPay")).toHaveText("₩"+(24000+annualOt).toLocaleString("en-US"));
  await d.page.locator('#summaryDays [data-summary-month="'+month(current)+'"]').click();
  await expect(d.page.locator('#summaryModeTabs [data-mode="month"]')).toHaveClass(/is-active/);
  await expect(d.page.locator("#statTotalPay")).toHaveText("₩6,500");
  await expect(d.page.locator("#summaryDays details")).toHaveCount(6);
  await d.page.locator("#periodPrev").click();
  await expect(d.page.locator("#statOtHours")).toHaveText("15.0");
  await d.page.locator("#summaryToday").click();
  await expect(d.page.locator("#statOtHours")).toHaveText("30.0");
 }finally{await d.context.close();}
});
test("selected-month details remain open and mobile controls fit in every display language",async({browser})=>{
 const d=await openDevice(browser,fixture());
 try{
  await summary(d.page);await d.page.setViewportSize({width:375,height:812});
  await d.page.locator('#trendChart [data-month="'+month(previous)+'"]').click();
  await d.page.locator("#summaryDays details").first().locator("summary").click();
  for(const code of codes){
   await d.page.locator("#languageSelect").selectOption(code);
   await expect(d.page.locator("#statTotalPay")).toHaveText("₩4,250");
   await expect(d.page.locator("#summaryMonthPicker")).toHaveValue(month(previous));
   await expect(d.page.locator("#summaryDays details").first()).toHaveAttribute("open","");
   const leaked=await d.page.locator("#view-summary").evaluate(root=>{
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),found=[];let node;
    while((node=walker.nextNode())){
     const parent=node.parentElement;
     if(!parent||!parent.getClientRects().length||parent.closest(".summary-entry-note"))continue;
     if(/[\u0e01-\u0e3a\u0e40-\u0e4e]/.test(node.nodeValue))found.push(node.nodeValue.trim());
    }return found;
   });
   if(code!=="th")expect(leaked).toEqual([]);
   for(const id of ["summaryMonthPicker","summaryToday","trendChart"]){
    const box=await d.page.locator("#"+id).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(376);
   }
   expect(await d.page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(376);
  }
 }finally{await d.context.close();}
});
test("daily detail groups multiple shifts, weekend multipliers, zero OT and incomplete times accurately",async({browser})=>{
 const cloud=makeCloud(),date=weekdays(current,1)[0];
 let weekend;for(let day=1;day<8;day++){const d=new Date(current.getFullYear(),current.getMonth(),day);if(d.getDay()===6){weekend=iso(d);break;}}
 cloud.rows.ot_settings.push({user_id:USER_ID,data:{monthlySalary:2000,hourlyRate:100,currency:"KRW"},updated_at:"2026-01-01T00:00:00Z"});
 const shifts=[[weekend,"08:00","11:00",2],[weekend,"13:00","14:00",1.5],[date,"08:00","17:00",null],[date,"","",null]];
 shifts.forEach(([day,start,end,mult],i)=>cloud.rows.ot_entries.push({id:"00000000-0000-4000-8000-"+String(i+101).padStart(12,"0"),user_id:USER_ID,date:day,time_in:start,time_out:end,ot_multiplier:mult,note:"",updated_at:"2026-01-01T00:00:00Z",deleted_at:null}));
 const d=await openDevice(browser,cloud);
 try{
  await summary(d.page);
  await expect(d.page.locator("#statOtHours")).toHaveText("4.0");
  await expect(d.page.locator("#statOtPay")).toHaveText("₩750");
  const weekendRow=d.page.locator('#summaryDays details[data-date="'+weekend+'"]');
  await expect(weekendRow.locator("summary")).toContainText("₩750");
  await weekendRow.locator("summary").click();
  await expect(weekendRow.locator(".summary-ot-formula").nth(0)).toHaveText("3.0 ชม. × ₩100 × 2 = ₩600");
  await expect(weekendRow.locator(".summary-ot-formula").nth(1)).toHaveText("1.0 ชม. × ₩100 × 1.5 = ₩150");
  await expect(weekendRow.locator(".summary-entry-breaks")).toHaveCount(0);
  const normal=d.page.locator('#summaryDays details[data-date="'+date+'"]');
  await expect(normal.locator("summary")).toContainText("OT 0.0 ชม.");
  await normal.locator("summary").click();
  await expect(normal).toContainText("ข้อมูลเวลาไม่ครบ");
 }finally{await d.context.close();}
});

test("a recorded zero OT month remains distinct from a month without records and has no percentage against a zero base",async({browser})=>{
 const cloud=makeCloud();
 cloud.rows.ot_settings.push({user_id:USER_ID,data:{monthlySalary:0,hourlyRate:100,currency:"KRW"},updated_at:"2026-01-01T00:00:00Z"});
 for(const [n,date] of [[1,previous],[2,current]])cloud.rows.ot_entries.push({id:"00000000-0000-4000-8000-"+String(500+n).padStart(12,"0"),user_id:USER_ID,date:weekdays(date,1)[0],time_in:"08:00",time_out:"17:00",ot_multiplier:null,note:"",updated_at:"2026-01-01T00:00:00Z",deleted_at:null});
 const d=await openDevice(browser,cloud);
 try{
  await summary(d.page);
  await expect(d.page.locator("#statOtHours")).toHaveText("0.0");
  await expect(d.page.locator("#statTotalPay")).toHaveText("₩0");
  await expect(d.page.locator("#summaryDataStatus")).toBeHidden();
  await expect(d.page.locator("#compareTotalPay")).not.toContainText("%");
  await expect(d.page.locator('#trendChart [data-month="'+month(previous)+'"] .trend-col__value')).toHaveText("0.0");
  await d.page.locator("#summaryMonthPicker").fill("2020-01");
  await d.page.locator("#summaryMonthPicker").dispatchEvent("change");
  await expect(d.page.locator("#summaryDataStatus")).toBeVisible();
  await expect(d.page.locator("#trendChart .trend-col__value",{hasText:"—"})).toHaveCount(6);
 }finally{await d.context.close();}
});
