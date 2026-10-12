const { test, expect } = require("@playwright/test");
const { makeCloud, openDevice, addEntry, liveNotes, POLL } = require("./support/fake-supabase");
test.setTimeout(60000);
test("a second save mid-sync must not delete the first from the cloud", async ({ browser }) => {
 const cloud=makeCloud();cloud.delays["ot_settings:upsert"]=500;
 const device=await openDevice(browser,cloud);
 try {
  await addEntry(device.page,"08:00","18:00","รายการที่หนึ่ง");
  await addEntry(device.page,"09:00","20:00","รายการที่สอง");
  await expect.poll(()=>liveNotes(cloud),POLL).toEqual(["รายการที่สอง","รายการที่หนึ่ง"]);
  expect(await device.page.evaluate(()=>JSON.parse(localStorage.getItem("ot-tracker-data-v1")).entries.length)).toBe(2);
 } finally { await device.context.close(); }
});
