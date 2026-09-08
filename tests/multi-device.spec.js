const { test, expect } = require("@playwright/test");
const {
  USER_ID, POLL, makeCloud, stubFor, prepareContext, waitForApp, openDevice,
  addEntry, liveNotes, shownNotes
} = require("./support/fake-supabase");

test.setTimeout(180000);

test("two devices that each recorded work keep both records", async ({ browser }) => {
  const cloud = makeCloud();

  // Phone records a shift and syncs it up.
  const phone = await openDevice(browser, cloud);
  await addEntry(phone.page, "08:00", "18:00", "กะมือถือ");
  await expect.poll(() => liveNotes(cloud), POLL).toEqual(["กะมือถือ"]);
  await phone.context.close();

  // Laptop was signed in but offline when it recorded its own shift, so the
  // cloud has never seen it. Signing in used to overwrite exactly this.
  const laptop = await browser.newContext();
  const lp = await laptop.newPage();
  await prepareContext(laptop, cloud, lp, USER_ID);
  await lp.goto("/");
  await waitForApp(lp);
  await lp.evaluate(() => {
    localStorage.setItem("ot-tracker-data-v1", JSON.stringify({
      settings: {}, workNotes: [], deletedEntries: [], deletedNotes: [],
      ownerId: "00000000-0000-4000-8000-000000000001",
      entries: [{
        id: "b2c3d4e5-f6a7-4890-b123-456789abcdef", date: "2026-09-03",
        timeIn: "10:00", timeOut: "21:00", otMultiplier: null,
        note: "กะโน้ตบุ๊ก", updatedAt: new Date().toISOString()
      }]
    }));
  });
  await lp.reload();
  await waitForApp(lp);

  // Neither record may be lost: the cloud ends up with both, and so does
  // the device that only ever knew about one of them.
  await expect.poll(() => liveNotes(cloud), POLL).toEqual(["กะมือถือ", "กะโน้ตบุ๊ก"]);
  await expect.poll(() => shownNotes(lp), POLL).toEqual(["กะมือถือ", "กะโน้ตบุ๊ก"]);
  await laptop.close();

  // And a brand new device that has never held any data gets everything.
  const fresh = await openDevice(browser, cloud);
  await expect.poll(() => shownNotes(fresh.page), POLL).toEqual(["กะมือถือ", "กะโน้ตบุ๊ก"]);
  await fresh.context.close();
});

test("deleting on one device removes it everywhere instead of coming back", async ({ browser }) => {
  const cloud = makeCloud();

  const phone = await openDevice(browser, cloud);
  await addEntry(phone.page, "08:00", "18:00", "รายการที่จะลบ");
  await addEntry(phone.page, "09:00", "19:00", "รายการที่เก็บไว้");
  await expect.poll(() => liveNotes(cloud), POLL).toEqual(["รายการที่จะลบ", "รายการที่เก็บไว้"]);

  // Second device syncs down both records, so it is holding the record that
  // is about to be deleted elsewhere.
  const laptop = await openDevice(browser, cloud);
  await expect.poll(() => shownNotes(laptop.page), POLL).toEqual(["รายการที่จะลบ", "รายการที่เก็บไว้"]);

  // Delete on the phone.
  await phone.page.locator(".entry-item", { hasText: "รายการที่จะลบ" })
    .locator('[data-action="delete"]').click();
  await phone.page.locator("#confirmOk").click();
  await expect.poll(() => liveNotes(cloud), POLL).toEqual(["รายการที่เก็บไว้"]);

  // The laptop still has it locally; coming back to the app must apply the
  // delete, not re-upload the record and undo it.
  await laptop.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => shownNotes(laptop.page), POLL).toEqual(["รายการที่เก็บไว้"]);
  await expect.poll(() => liveNotes(cloud), POLL).toEqual(["รายการที่เก็บไว้"]);

  await phone.context.close();
  await laptop.context.close();
});

test("someone else signing in on the same browser gets none of your data", async ({ browser }) => {
  const cloud = makeCloud();
  const OTHER_USER = "00000000-0000-4000-8000-0000000000ff";

  // You record OT on this browser and it syncs to your account.
  const mine = await openDevice(browser, cloud, USER_ID);
  await addEntry(mine.page, "08:00", "18:00", "โอทีของผม");
  await expect.poll(() => liveNotes(cloud, USER_ID), POLL).toEqual(["โอทีของผม"]);
  const context = mine.context;
  await mine.page.close();

  // A colleague now signs in with their own Google account in the same
  // browser, where your records are still sitting in localStorage.
  const theirPage = await context.newPage();
  await theirPage.exposeFunction("__cloudOp", (table, op, arg, uid) => cloud.op(table, op, arg, uid));
  await theirPage.addInitScript(stubFor(OTHER_USER));
  await theirPage.goto("/");
  await waitForApp(theirPage);
  await theirPage.waitForTimeout(2000);

  // They must not see your OT, and none of it may end up in their account.
  expect(await shownNotes(theirPage)).toEqual([]);
  expect(liveNotes(cloud, OTHER_USER)).toEqual([]);

  // And your own records are untouched in your own account.
  expect(liveNotes(cloud, USER_ID)).toEqual(["โอทีของผม"]);
  await context.close();
});

test("signed out, the app holds nothing and records nothing", async ({ browser }) => {
  const cloud = makeCloud();

  // Record some OT while signed in, then sign out for real.
  const device = await openDevice(browser, cloud, USER_ID);
  await addEntry(device.page, "08:00", "18:00", "โอทีของผม");
  await expect.poll(() => liveNotes(cloud, USER_ID), POLL).toEqual(["โอทีของผม"]);
  await device.page.evaluate(() => document.getElementById("logoutBtn").click());

  // The view empties and the device keeps no copy of it.
  await expect.poll(() => shownNotes(device.page), POLL).toEqual([]);
  expect(await device.page.evaluate(() => localStorage.getItem("ot-tracker-data-v1"))).toBeNull();

  // Trying to record while signed out saves nothing, anywhere.
  await device.page.locator("#dateTrigger").click();
  await device.page.locator("#calToday").click();
  await device.page.locator("#f-timein").fill("07:00");
  await device.page.locator("#f-timeout").fill("16:00");
  await device.page.locator("#f-note").fill("ไม่ควรถูกบันทึก");
  await device.page.locator("#saveEntryBtn").click();
  await device.page.waitForTimeout(1500);

  expect(await shownNotes(device.page)).toEqual([]);
  expect(await device.page.evaluate(() => localStorage.getItem("ot-tracker-data-v1"))).toBeNull();
  expect(liveNotes(cloud, USER_ID)).toEqual(["โอทีของผม"]);

  await device.context.close();
});

test("a change made elsewhere appears live, without touching the app", async ({ browser }) => {
  const cloud = makeCloud();
  const device = await openDevice(browser, cloud, USER_ID);
  await addEntry(device.page, "08:00", "18:00", "รายการเดิม");
  await expect.poll(() => liveNotes(cloud, USER_ID), POLL).toEqual(["รายการเดิม"]);

  // Another device records a shift; the database streams the row here. No
  // click, no refocus, no reload.
  await device.page.evaluate((userId) => {
    window.__pushLiveRow("ot_entries", {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", user_id: userId,
      date: "2026-09-07", time_in: "10:00", time_out: "20:00", ot_multiplier: null,
      note: "จากอีกเครื่อง", updated_at: new Date().toISOString(), deleted_at: null
    });
  }, USER_ID);
  await expect.poll(() => shownNotes(device.page), POLL).toEqual(["จากอีกเครื่อง", "รายการเดิม"]);

  // A delete made elsewhere arrives the same way.
  await device.page.evaluate((userId) => {
    window.__pushLiveRow("ot_entries", {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", user_id: userId,
      date: "2026-09-07", time_in: "10:00", time_out: "20:00", ot_multiplier: null,
      note: "จากอีกเครื่อง", updated_at: new Date().toISOString(),
      deleted_at: new Date().toISOString()
    });
  }, USER_ID);
  await expect.poll(() => shownNotes(device.page), POLL).toEqual(["รายการเดิม"]);

  await device.context.close();
});
