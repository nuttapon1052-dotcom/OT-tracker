const { test, expect } = require("@playwright/test");

const KEY = "ot-tracker-data-v1";

function seedWith(entries) {
  return { settings: {}, workNotes: [], entries: entries };
}

test("existing records survive a reload", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(([k, s]) => localStorage.setItem(k, JSON.stringify(s)), [KEY, seedWith([
    { id: "a1b2c3d4-e5f6-4789-a012-3456789abcde", date: "2026-09-01", timeIn: "08:00", timeOut: "18:00", otMultiplier: null, note: "งานจริง" }
  ])]);
  await page.reload();

  await expect(page.locator(".entry-item").first()).toContainText("08:00 - 18:00");
  expect(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).entries.length, KEY)).toBe(1);
});

test("records saved with the old non-uuid id survive and get repaired", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(([k, s]) => localStorage.setItem(k, JSON.stringify(s)), [KEY, seedWith([
    { id: "id-1699999999-9f3a2b", date: "2026-09-02", timeIn: "09:00", timeOut: "20:00", otMultiplier: null, note: "งานเก่า" }
  ])]);
  await page.reload();

  await expect(page.locator(".entry-item").first()).toContainText("09:00 - 20:00");
  const entries = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).entries, KEY);
  expect(entries.length).toBe(1);
  expect(entries[0].note).toBe("งานเก่า");
  expect(entries[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});
