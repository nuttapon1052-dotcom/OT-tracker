const { test, expect } = require("@playwright/test");
const { makeCloud, prepareContext, waitForApp } = require("./support/fake-supabase");

// Recording requires an account (a signed-out app stores nothing on the
// device on purpose), so every test here signs in against a fake cloud.
test.beforeEach(async ({ context, page }) => {
  await prepareContext(context, makeCloud(), page);
  await page.goto("/");
  await waitForApp(page);
});

test("add an event note with a custom reminder date/time", async ({ page }) => {
  // go to the "บันทึกเหตุการณ์" sub-tab
  await page.locator('.segmented__btn[data-subview="notes"]').click();
  await expect(page.locator("#noteForm")).toBeVisible();

  await page.locator("#n-title").fill("ไปทำงานนอกสถานที่");

  // pick a start date via the shared calendar modal
  await page.locator("#noteStartTrigger").click();
  await page.locator("#calToday").click();

  // reminder fields hidden until the toggle is on
  await expect(page.locator("#noteRemindFields")).toBeHidden();
  await page.locator('label[for="n-remind-enabled"]').click();
  await expect(page.locator("#n-remind-enabled")).toBeChecked();
  await expect(page.locator("#noteRemindFields")).toBeVisible();

  // enabling pre-fills date (from start date) + 08:00; tweak the time
  await expect(page.locator("#n-remindtime")).toHaveValue("08:00");
  await page.locator("#n-remindtime").fill("09:30");

  await page.locator("#saveNoteBtn").click();

  const item = page.locator("#noteList .entry-item").first();
  await expect(item).toBeVisible();
  await expect(item).toContainText("ไปทำงานนอกสถานที่");
  await expect(item).toContainText("แจ้งเตือน");
  await expect(item).toContainText("09:30");

  // editing it back shows the reminder fields populated
  await item.locator('[data-action="edit"]').click();
  await expect(page.locator("#n-remind-enabled")).toBeChecked();
  await expect(page.locator("#n-remindtime")).toHaveValue("09:30");
});

test("reminder validation blocks save when date/time missing", async ({ page }) => {
  await page.locator('.segmented__btn[data-subview="notes"]').click();
  await page.locator("#n-title").fill("ประชุม");
  await page.locator("#noteStartTrigger").click();
  await page.locator("#calToday").click();

  await page.locator('label[for="n-remind-enabled"]').click();
  await expect(page.locator("#n-remind-enabled")).toBeChecked();
  // clear the auto-filled time so it's incomplete
  await page.locator("#n-remindtime").fill("");
  await page.locator("#saveNoteBtn").click();

  // toast warns and nothing is added
  await expect(page.locator("#toast")).toContainText("เลือกวันและเวลาแจ้งเตือน");
});
