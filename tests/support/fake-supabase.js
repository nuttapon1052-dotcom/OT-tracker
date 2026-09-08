const { expect } = require("@playwright/test");

// A fake Supabase for the browser: an in-memory cloud living in the test
// process, plus a client stub injected into the page. Shared by every spec,
// because recording OT now requires being signed in - a signed-out app
// deliberately stores nothing, so any test that saves has to sign in first.

const USER_ID = "00000000-0000-4000-8000-000000000001";
const POLL = { timeout: 30000 };

// One in-memory Supabase shared by every simulated device, living in the test
// process so two independent browser contexts (= two devices, two separate
// localStorages) talk to the same cloud.
function makeCloud() {
  const rows = { ot_settings: [], ot_entries: [], work_notes: [] };
  return {
    rows,
    // Scoped by user the way the database's row level security policies
    // ("using (auth.uid() = user_id)") scope it for real, so a test can tell
    // whether one account can ever observe another's rows.
    op(table, op, arg, userId) {
      const list = rows[table];
      const mine = list.filter((r) => r.user_id === userId);
      if (op === "selectOne") return mine[0] || null;
      if (op === "selectAll") return mine.slice();
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
          if (r.user_id === userId && arg.ids.indexOf(r.id) !== -1) list[i] = Object.assign({}, r, arg.patch);
        });
        return null;
      }
      return null;
    }
  };
}

const stubFor = (userId) => `
const USER = "${userId}";
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
          if (q._single) return { data: await window.__cloudOp(table, "selectOne", null, USER), error: null };
          const all = await window.__cloudOp(table, "selectAll", null, USER);
          if (q._count) return { count: all.length, data: null, error: null };
          return { data: all, error: null };
        }
        if (q._op === "upsert") { await window.__cloudOp(table, "upsert", q._rows, USER); return { data: null, error: null }; }
        if (q._op === "update") { await window.__cloudOp(table, "update", { patch: q._patch, ids: q._ids || [] }, USER); return { data: null, error: null }; }
        if (q._op === "delete") { throw new Error("การ sync ต้องไม่ลบแถวใดๆ"); }
        return { data: null, error: null };
      }).then(onOk, onErr);
    }
  };
  return q;
}
// Stands in for Supabase Realtime: the test pushes a row through
// window.__pushLiveRow(table, row) and the app's handlers see it exactly as
// they would see a change streamed from the database.
window.__liveHandlers = [];
window.__pushLiveRow = (table, row) => {
  window.__liveHandlers
    .filter((h) => h.table === table)
    .forEach((h) => h.cb({ new: row }));
};
window.supabase = {
  createClient() {
    return {
      auth: {
        getSession: () => Promise.resolve({ data: { session: USER ? { user: { id: USER } } : null } }),
        onAuthStateChange(cb) {
          window.__authCb = cb;
          return { data: { subscription: { unsubscribe() {} } } };
        },
        signInWithOAuth() {},
        // Real signOut ends the session and notifies listeners; the app
        // reacts to that notification, so the stub has to send it too.
        signOut() {
          if (window.__authCb) window.__authCb("SIGNED_OUT", null);
          return Promise.resolve({ error: null });
        }
      },
      channel() {
        const ch = {
          on(_evt, opts, cb) { window.__liveHandlers.push({ table: opts.table, cb: cb }); return ch; },
          subscribe() { return ch; }
        };
        return ch;
      },
      removeChannel() { window.__liveHandlers = []; },
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
async function prepareContext(context, cloud, page, userId) {
  await context.route(/cdn\.jsdelivr\.net/, (route) => route.abort());
  await context.route(/service-worker\.js/, (route) => route.abort());
  await page.exposeFunction("__cloudOp", (table, op, arg, uid) => cloud.op(table, op, arg, uid));
  await page.addInitScript(stubFor(userId || USER_ID));
}

// The app has booted once it has rendered the history list (an empty list
// still renders its "nothing here yet" state, so any content means ready).
async function waitForApp(page) {
  await expect
    .poll(() => page.evaluate(() => document.getElementById("entryList").innerHTML.length), { timeout: 30000 })
    .toBeGreaterThan(0);
}

// A device is a browser context of its own, so its localStorage is its own.
async function openDevice(browser, cloud, userId) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await prepareContext(context, cloud, page, userId);
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

function liveNotes(cloud, userId) {
  return cloud.rows.ot_entries
    .filter((r) => !r.deleted_at && (!userId || r.user_id === userId))
    .map((r) => r.note)
    .sort();
}

async function shownNotes(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".entry-item__note")).map((el) => el.textContent.trim()).sort()
  );
}


module.exports = { USER_ID, POLL, makeCloud, stubFor, prepareContext, waitForApp, openDevice, addEntry, liveNotes, shownNotes };
