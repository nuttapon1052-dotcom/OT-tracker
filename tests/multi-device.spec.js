const { test, expect } = require("@playwright/test");

test.setTimeout(180000);

const USER_ID = "00000000-0000-4000-8000-000000000001";
const POLL = { timeout: 30000 };

// One in-memory Supabase shared by every simulated device, living in the test
// process so two independent browser contexts (= two devices, two separate
// localStorages) talk to the same cloud.
function makeCloud() {
  const rows = { ot_settings: [], ot_entries: [], work_notes: [] };
  return {
    rows,
    op(table, op, arg) {
      const list = rows[table];
      if (op === "selectOne") return list[0] || null;
      if (op === "selectAll") return list.slice();
      if (op === "upsert") {
        arg.forEach((row) => {
          const key = table === "ot_settings" ? "user_id" : "id";
          const at = list.findIndex((r) => r[key] === row[key]);
          if (at === -1) list.push(Object.assign({}, row));
          else list[at] = Object.assign({}, list[at], row);
        });
        return null;
      }
      if (op === "update") {
        list.forEach((r, i) => {
          if (arg.ids.indexOf(r.id) !== -1) list[i] = Object.assign({}, r, arg.patch);
        });
        return null;
      }
      return null;
    }
  };
}

const STUB = `
function makeQuery(table) {
  const q = {
    _op: null, _rows: null, _patch: null, _ids: null, _single: false, _count: false,
    upsert(rows) { q._op = "upsert"; q._rows = [].concat(rows); return q; },
    insert(rows) { q._op = "upsert"; q._rows = [].concat(rows); return q; },
    update(patch) { q._op = "update"; q._patch = patch; return q; },
    delete() { q._op = "delete"; return q; },
    select(_c, opts) { q._op = "select"; if (opts && opts.count) q._count = true; return q; },
    eq() { return q; },
    in(_col, ids) { q._ids = ids; return q; },
    is() { return q; },
    not() { return q; },
    maybeSingle() { q._single = true; return q; },
    then(onOk, onErr) {
      return new Promise((r) => setTimeout(r, 10)).then(async () => {
        if (q._op === "select") {
          if (q._single) return { data: await window.__cloudOp(table, "selectOne", null), error: null };
          const all = await window.__cloudOp(table, "selectAll", null);
          if (q._count) return { count: all.length, data: null, error: null };
          return { data: all, error: null };
        }
        if (q._op === "upsert") { await window.__cloudOp(table, "upsert", q._rows); return { data: null, error: null }; }
        if (q._op === "update") { await window.__cloudOp(table, "update", { patch: q._patch, ids: q._ids || [] }); return { data: null, error: null }; }
        if (q._op === "delete") { throw new Error("การ sync ต้องไม่ลบแถวใดๆ"); }
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
        getSession: () => Promise.resolve({ data: { session: { user: { id: "${USER_ID}" } } } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        signInWithOAuth() {}, signOut() {}
      },
      from: (table) => makeQuery(table)
    };
  }
};
`;

// The app deliberately reloads once when its service worker takes control
// (so a tab open across a deploy can't keep running stale JS), and the CDN
// scripts it loads are unreachable from the test sandbox and only fail after
// a long timeout. Neither has anything to do with syncing, and together they
// leave the page blank for seconds at unpredictable moments - so tests block
// both and drive the app directly.
async function prepareContext(context, cloud, page) {
  await context.route(/cdn\.jsdelivr\.net/, (route) => route.abort());
  await context.route(/service-worker\.js/, (route) => route.abort());
  await page.exposeFunction("__cloudOp", (table, op, arg) => cloud.op(table, op, arg));
  await page.addInitScript(STUB);
}

// The app has booted once it has rendered the history list (an empty list
// still renders its "nothing here yet" state, so any content means ready).
async function waitForApp(page) {
  await expect
    .poll(() => page.evaluate(() => document.getElementById("entryList").innerHTML.length), { timeout: 30000 })
    .toBeGreaterThan(0);
}

// A device is a browser context of its own, so its localStorage is its own.
async function openDevice(browser, cloud) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await prepareContext(context, cloud, page);
  await page.goto("/");
  await waitForApp(page);
  return { context, page };
}

async function addEntry(page, timeIn, timeOut, note) {
  await page.locator("#dateTrigger").click();
  await page.locator("#calToday").click();
  await page.locator("#f-timein").fill(timeIn);
  await page.locator("#f-timeout").fill(timeOut);
  await page.locator("#f-note").fill(note);
  await page.locator("#saveEntryBtn").click();
  await expect(page.locator(".entry-item", { hasText: note })).toBeVisible();
}

function liveNotes(cloud) {
  return cloud.rows.ot_entries.filter((r) => !r.deleted_at).map((r) => r.note).sort();
}

async function shownNotes(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".entry-item__note")).map((el) => el.textContent.trim()).sort()
  );
}

test("two devices that each recorded work keep both records", async ({ browser }) => {
  const cloud = makeCloud();

  // Phone records a shift and syncs it up.
  const phone = await openDevice(browser, cloud);
  await addEntry(phone.page, "08:00", "18:00", "กะมือถือ");
  await expect.poll(() => liveNotes(cloud), POLL).toEqual(["กะมือถือ"]);
  await phone.context.close();

  // Laptop was offline when it recorded its own shift, so the cloud has
  // never seen it. Signing in used to overwrite exactly this.
  const laptop = await browser.newContext();
  const lp = await laptop.newPage();
  await prepareContext(laptop, cloud, lp);
  await lp.goto("/");
  await waitForApp(lp);
  await lp.evaluate(() => {
    localStorage.setItem("ot-tracker-data-v1", JSON.stringify({
      settings: {}, workNotes: [], deletedEntries: [], deletedNotes: [],
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
