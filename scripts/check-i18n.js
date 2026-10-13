const fs = require("node:fs");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const env = { window: {} };
vm.runInNewContext(fs.readFileSync("js/i18n-catalog.js", "utf8"), env);
const {locales,messages} = env.window.OT_I18N_CATALOG;
assert.equal(locales.length, 11);
assert.equal(new Set(locales.map(x=>x.code)).size, 11);
for (const [key, row] of Object.entries(messages)) {
  assert.equal(row.length, locales.length, "missing translation for " + key);
  row.forEach((value, i) => {
    assert.equal(typeof value, "string");
    if (i > 0) assert.ok(!/[\u0e01-\u0e3a\u0e40-\u0e4e]/.test(value), "Thai UI leaked into " + locales[i].code + ": " + key);
  });
}
["js/app.js","js/i18n.js","service-worker.js"].forEach(file => new vm.Script(fs.readFileSync(file, "utf8"), {filename:file}));
const sw = fs.readFileSync("service-worker.js", "utf8");
["./js/i18n.js","./js/i18n-catalog.js","./css/i18n.css"].forEach(asset=>assert.ok(sw.includes(JSON.stringify(asset)), "offline asset missing: "+asset));
(async()=>{
  const notifications = await import(pathToFileURL(path.resolve("supabase/functions/_shared/i18n.mjs")).href);
  for (const {code} of locales) {
    assert.ok(notifications.leaveReminderText[code]);
    assert.ok(notifications.eventReminderText[code]);
    assert.equal(notifications.leaveReminder(code),notifications.leaveReminderText[code]);
    assert.equal(notifications.eventReminder(code),notifications.eventReminderText[code]);
  }
  assert.equal(notifications.leaveReminder("unknown"),notifications.leaveReminderText.th);
  assert.equal(notifications.eventReminder(null),notifications.eventReminderText.th);
  console.log("PASS: "+Object.keys(messages).length+" messages, 11 locales, offline assets and account-language reminder text");
})().catch(error=>{ console.error(error);process.exitCode=1; });
