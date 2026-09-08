const { test, expect } = require("@playwright/test");

// Stands in for the Supabase CDN client (blocked/absent in tests), backed by
// an in-memory "cloud" so the real pushStateToCloud() chain can be driven and
// inspected. Every operation is deliberately slow so two pushes overlap the
// way rapid edits make them overlap in the app.
const STUB = `
window.__cloud = { ot_settings: [], ot_entries: [], work_notes: [] };
const LATENCY = 300;
function makeQuery(table) {
  const cloud = window.__cloud;
  const q = {
    _op: null, _rows: null, _keep: null, _count: false, _single: false,
    upsert(rows) { q._op = "upsert"; q._rows = [].concat(rows); return q; },
    insert(rows) { q._op = "insert"; q._rows = [].concat(rows); return q; },
    delete() { q._op = "delete"; return q; },
    select(_cols, opts) { q._op = "select"; if (opts && opts.count) q._count = true; return q; },
    eq() { return q; },
    not(_col, _op, val) { q._keep = String(val).slice(1, -1).split(",").filter(Boolean); return q; },
    maybeSingle() { q._single = true; return q; },
    then(onOk, onErr) {
      return new Promise((r) => setTimeout(r, LATENCY)).then(() => {
        if (q._op === "select") {
          if (q._single) return { data: cloud[table][0] || null, error: null };
          if (q._count) return { count: cloud[table].length, data: null, error: null };
          return { data: cloud[table].slice(), error: null };
        }
        if (q._op === "upsert" || q._op === "insert") {
          q._rows.forEach((row) => {
            const key = table === "ot_settings" ? "user_id" : "id";
            const at = cloud[table].findIndex((r) => r[key] === row[key]);
            if (at === -1) cloud[table].push(row); else cloud[table][at] = row;
          });
          return { data: null, error: null };
        }
        if (q._op === "delete") {
          cloud[table] = q._keep ? cloud[table].filter((r) => q._keep.indexOf(r.id) !== -1) : [];
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }).then(onOk, onErr);
    }
  };
  return q;
}
window.supabase = {
  createClient() {
    return {
      auth: {
        getSession: () => Promise.resolve({ data: { session: { user: { id: "00000000-0000-4000-8000-000000000001" } } } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        signInWithOAuth() {}, signOut() {}
      },
      from: (table) => makeQuery(table)
    };
  }
};
`;

async function addEntry(page, timeIn, timeOut, note) {
  await page.locator("#dateTrigger").click();
  await page.locator("#calToday").click();
  await page.locator("#f-timein").fill(timeIn);
  await page.locator("#f-timeout").fill(timeOut);
  await page.locator("#f-note").fill(note);
  await page.locator("#saveEntryBtn").click();
}

test.setTimeout(120000);

test("a second save mid-sync must not delete the first from the cloud", async ({ page }) => {
  await page.addInitScript(STUB);
  await page.goto("/");
  await expect(page.locator("#entryForm")).toBeVisible();

  // Two saves in quick succession: the second lands while the first push is
  // still in flight, so the first push's cleanup delete is working off an id
  // list that predates the second entry.
  await addEntry(page, "08:00", "18:00", "รายการที่หนึ่ง");
  await addEntry(page, "09:00", "20:00", "รายการที่สอง");

  // Let every overlapping push chain finish.
  await page.waitForTimeout(4000);

  const cloudNotes = await page.evaluate(() => window.__cloud.ot_entries.map((r) => r.note).sort());
  expect(cloudNotes).toEqual(["รายการที่สอง", "รายการที่หนึ่ง"]);

  const localCount = await page.evaluate(() => JSON.parse(localStorage.getItem("ot-tracker-data-v1")).entries.length);
  expect(localCount).toBe(2);
});
