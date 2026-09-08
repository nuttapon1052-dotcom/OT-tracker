const { test, expect } = require("@playwright/test");
const { makeCloud, prepareContext, waitForApp } = require("./support/fake-supabase");

// Recording requires an account (a signed-out app stores nothing on the
// device on purpose), so every test here signs in against a fake cloud.
test.beforeEach(async ({ context, page }) => {
  await prepareContext(context, makeCloud(), page);
  await page.goto("/");
  await waitForApp(page);
});

test("app loads with entry view active", async ({ page }) => {
  await expect(page.locator("#view-entry")).toBeVisible();
  await expect(page.locator("#entryForm")).toBeVisible();
});

test("save a time entry and see it in the history list", async ({ page }) => {
  await page.locator("#dateTrigger").click();
  await page.locator("#calToday").click();

  await page.locator("#f-timein").fill("08:00");
  await page.locator("#f-timeout").fill("18:00");
  await page.locator("#f-note").fill("Playwright test entry");

  await page.locator("#saveEntryBtn").click();

  const entryItem = page.locator(".entry-item").first();
  await expect(entryItem).toBeVisible();
  await expect(entryItem).toContainText("08:00 - 18:00");
  await expect(entryItem).toContainText("Playwright test entry");
});

test("switch between entry, summary, and settings tabs", async ({ page }) => {
  await page.locator('.tabbar__btn[data-view="summary"]').click();
  await expect(page.locator("#view-summary")).toBeVisible();
  await expect(page.locator("#view-entry")).toBeHidden();

  await page.locator('.tabbar__btn[data-view="settings"]').click();
  await expect(page.locator("#view-settings")).toBeVisible();
  await expect(page.locator("#view-summary")).toBeHidden();

  await page.locator('.tabbar__btn[data-view="entry"]').click();
  await expect(page.locator("#view-entry")).toBeVisible();
});
