(function () {
  "use strict";
  var I18N = window.OTI18N;
  var tr = I18N.t;

  /* ============================================================
   * Storage
   * ========================================================== */
  var STORAGE_KEY = "ot-tracker-data-v1";
  var ACCOUNT_CACHE_PREFIX = STORAGE_KEY + ":account:";
  var accountStorageReady = true;

  var DEFAULT_STATE = {
    version: 1,
    localRevision: 0,
    settings: {
      language: null, // selected UI language; synced in the existing settings JSON
      recorderName: "", // shown in the header and summary page
      currency: "KRW", // 'KRW' | 'THB' | 'JPY' | 'TWD' | 'USD' | 'MYR' | 'ILS' | 'SGD'
      hourlyRate: 10000, // used to calculate OT pay only
      monthlySalary: 2000000, // fixed figure shown in the monthly summary, not used in any calculation
      otMultiplier: 1.5,
      weekendOtMultiplier: 1.5,
      otGoal: 0, // เป้าหมายเงิน OT ต่อเดือน, 0 = ยังไม่ได้ตั้งเป้าหมาย
      // standard daily schedule - drives normal-hours / OT calculation
      workStart: "08:00",
      lunchStart: "12:00",
      lunchEnd: "13:00",
      normalEnd: "17:00",
      mandatoryOtEnd: "18:00",
      eveningBreakStart: "18:00",
      eveningBreakEnd: "18:30",
      // on by default so existing users see no change in behavior; turning
      // one off removes that whole window from the calculation (see
      // effectiveSchedule)
      hasLunchBreak: true,
      hasMandatoryOt: true,
      hasEveningBreak: true,
      // entry-form autofill only - unrelated to the OT calculation above.
      // Blank/off until the user opts in, on purpose: no baked-in default.
      defaultTimeIn: "",
      defaultTimeOut: "",
      lockTimeIn: false,
      lockTimeOut: false,
      // when on, the locked clock-out time is also filled on Sat/Sun instead
      // of being left blank (see applyWeekendTimeDefault). Only meaningful
      // while lockTimeOut is on.
      lockTimeOutWeekend: false,
      // "จดบันทึก OT" reminder toggle (server-side Web Push). Pure account-level
      // user intent: changed ONLY when the user flips the sNotifyLateOut switch,
      // and NEVER cleared by device/subscription state (doing so was the bug
      // that silently disabled reminders). The send-push-reminders Edge Function
      // reads ot_settings.data.notifyEnabled + notifyTime directly and fires a
      // single push at exactly notifyTime each day (if today has no clock-out
      // yet) via pg_cron - no more "N minutes after the schedule end" math (see
      // supabase/functions/send-push-reminders). Delivery to a given device
      // still needs that device to hold a push subscription, which the app
      // self-heals on load (see ensurePushSubscription).
      notifyEnabled: false,
      // exact wall-clock time (HH:MM, user's local tz) the reminder above fires
      notifyTime: "17:15"
    },
    entries: [], // { id, date, timeIn, timeOut, otMultiplier(number|null), note, updatedAt }
    workNotes: [], // { id, title, description, startDate, endDate, reminderEnabled, reminderDate, reminderTime, reminderSent, updatedAt }
    // Which signed-in account the records below belong to, so this device
    // can tell "my own data from before I signed in" apart from "the
    // previous person's data". Merging without this would fold whatever the
    // last user left in this browser into the next user's account.
    ownerId: null,
    settingsDirty: false,
    settingsUpdatedAt: null,
    // Tombstones - { id, deletedAt } - kept so a delete made on one device
    // can travel to the others. Without them a merging sync could only ever
    // add records back: every other device would still hold the deleted row
    // and would keep re-uploading it. Deliberately kept out of entries/
    // workNotes so nothing that renders or calculates has to know they exist.
    deletedEntries: [],
    deletedNotes: []
  };

  var CURRENCIES = {
    KRW: { symbol: "₩", decimals: 0, locale: "ko-KR", label: tr("วอนเกาหลี") },
    THB: { symbol: "฿", decimals: 2, locale: "th-TH", label: tr("บาทไทย") },
    JPY: { symbol: "¥", decimals: 0, locale: "ja-JP", label: tr("เยนญี่ปุ่น") },
    TWD: { symbol: "NT$", decimals: 0, locale: "zh-TW", label: tr("ดอลลาร์ไต้หวัน") },
    USD: { symbol: "$", decimals: 2, locale: "en-US", label: tr("ดอลลาร์สหรัฐ") },
    MYR: { symbol: "RM", decimals: 2, locale: "ms-MY", label: tr("มาเลเซียริงกิต") },
    ILS: { symbol: "₪", decimals: 2, locale: "he-IL", label: tr("อิสราเอลเชคเกล") },
    SGD: { symbol: "S$", decimals: 2, locale: "en-SG", label: tr("ดอลลาร์สิงคโปร์") }
  };

  function currentCurrency() {
    return CURRENCIES[state.settings.currency] || CURRENCIES.KRW;
  }

  // Public-holiday lookup only - purely a calendar display concern, never
  // consulted by the OT calculation.
  var COUNTRY_CODE_BY_CURRENCY = {
    THB: "TH", JPY: "JP", KRW: "KR", TWD: "TW",
    USD: "US", MYR: "MY", ILS: "IL", SGD: "SG"
  };

  var HOLIDAYS_STORAGE_KEY = "ot-tracker-holidays-v1";

  function loadHolidaysCache() {
    try {
      var raw = localStorage.getItem(HOLIDAYS_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveHolidaysCache() {
    try { localStorage.setItem(HOLIDAYS_STORAGE_KEY, JSON.stringify(holidaysCache)); } catch (e) {}
  }

  // { "TH-2026": { "2026-01-01": "วันขึ้นปีใหม่", ... } }
  var holidaysCache = loadHolidaysCache();
  var holidaysFetchInFlight = {};
  // Marks a country+year that already failed once this session so a flaky
  // or offline API doesn't get hammered on every re-render (e.g. flipping
  // between months) - see fetchHolidays().
  var holidaysFetchFailed = {};

  function holidayCacheKey(countryCode, year) {
    return countryCode + "-" + year;
  }

  function holidaysForYear(year) {
    var countryCode = COUNTRY_CODE_BY_CURRENCY[state.settings.currency];
    if (!countryCode) return null;
    return holidaysCache[holidayCacheKey(countryCode, year)] || null;
  }

  // TH/TW/IL/MY: Nager.Date (date.nager.at, used below for every other
  // country) has no data for these four - confirmed directly against the API
  // (HTTP 204 for all four, every year 2025-2029). Google Calendar's public
  // holiday ICS feeds cover them, but can't be fetched live from the browser
  // (Google's calendar server sends no Access-Control-Allow-Origin header,
  // so the request is blocked by CORS - confirmed with a live fetch() call).
  // So for just these four, a bundled snapshot is used instead:
  // js/static-holidays.js, generated by scripts/refresh-static-holidays.js
  // (fetches + parses the ICS server-side, where CORS doesn't apply) -
  // re-run that script periodically to extend the covered year range.
  var STATIC_HOLIDAY_COUNTRIES = { TH: true, TW: true, IL: true, MY: true };

  function fetchHolidays(countryCode, year) {
    if (STATIC_HOLIDAY_COUNTRIES[countryCode]) {
      var byCountry = (window.STATIC_HOLIDAYS || {})[countryCode] || {};
      var staticList = byCountry[String(year)] || [];
      var staticMap = {};
      staticList.forEach(function (h) { staticMap[h.date] = h.name; });
      holidaysCache[holidayCacheKey(countryCode, year)] = staticMap;
      saveHolidaysCache();
      return Promise.resolve(staticMap);
    }

    return fetch("https://date.nager.at/api/v3/PublicHolidays/" + year + "/" + countryCode)
      .then(function (res) {
        // Nager.Date returns 204 with an empty body for countries it has no
        // holiday data for - a normal "nothing to show" case, not an error.
        if (res.status === 204) return [];
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (list) {
        var map = {};
        (Array.isArray(list) ? list : []).forEach(function (h) {
          if (h && h.date) map[h.date] = h.localName || h.name || "";
        });
        holidaysCache[holidayCacheKey(countryCode, year)] = map;
        saveHolidaysCache();
        return map;
      })
      .catch(function (err) {
        // Silent by design: no network, or the country isn't in Nager.Date's
        // database - the calendar just renders without holiday highlights.
        console.error(tr("ดึงข้อมูลวันหยุดราชการไม่สำเร็จ"), err);
        return null;
      });
  }

  // Translates a holiday's source name (Nager.Date localName/name, or the
  // bundled static-holidays.js name) to Thai for display, via
  // js/holiday-names-th.js. Cached/stored holiday data always stays in its
  // original source language - translation happens only here, at display
  // time, so adding more dictionary entries later doesn't require
  // re-fetching or invalidating holidaysCache. Falls back to the original
  // name when there's no dictionary entry (e.g. Thailand, whose bundled data
  // is already Thai-language at the source, or any newly introduced holiday
  // name not yet added to the dictionary).
  function holidayDisplayName(name) {
    var dict = window.HOLIDAY_NAMES_TH || {};
    if (I18N.current() === "th") return dict[name] || name;
    // Holiday names remain names of the selected country's holidays, rather
    // than changing the holiday country when the UI language changes.
    if (!/[\u0e01-\u0e3a\u0e40-\u0e4e]/.test(name)) return name;
    var englishName = Object.keys(dict).find(function (key) {
      return /^[A-Za-z]/.test(key) && dict[key] === name;
    });
    return englishName || name;
  }

  // Kicks off a background fetch (if needed) and re-renders the calendar
  // once it lands, so opening the calendar shows holidays as soon as
  // they're available without blocking the initial render.
  function ensureHolidaysForYear(year) {
    var countryCode = COUNTRY_CODE_BY_CURRENCY[state.settings.currency];
    if (!countryCode) return;
    var key = holidayCacheKey(countryCode, year);
    if (holidaysCache[key] || holidaysFetchInFlight[key] || holidaysFetchFailed[key]) return;

    holidaysFetchInFlight[key] = fetchHolidays(countryCode, year).then(function (map) {
      delete holidaysFetchInFlight[key];
      if (!map) {
        holidaysFetchFailed[key] = true;
        return;
      }
      var stillOpen = !els.calendarOverlay.classList.contains("hidden");
      if (stillOpen && calendarViewDate.getFullYear() === year) renderCalendar();
      updateHolidayNotice();
    });
  }

  function loadState(storageKey) {
    storageKey = storageKey || STORAGE_KEY;
    try {
      var raw = localStorage.getItem(storageKey);
      if (!raw) return clone(DEFAULT_STATE);
      var parsed = JSON.parse(raw);
      var state = clone(DEFAULT_STATE);
      state.localRevision = Math.max(0, Number(parsed.localRevision) || 0);
      state.settings = Object.assign({}, state.settings, parsed.settings || {});
      state.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      state.workNotes = Array.isArray(parsed.workNotes) ? parsed.workNotes : [];
      state.deletedEntries = Array.isArray(parsed.deletedEntries) ? parsed.deletedEntries : [];
      state.deletedNotes = Array.isArray(parsed.deletedNotes) ? parsed.deletedNotes : [];
      state.ownerId = parsed.ownerId || null;
      state.settingsDirty = parsed.settingsDirty === true;
      state.settingsUpdatedAt = parsed.settingsUpdatedAt || null;
      // Older versions stored a confirmed sync time but no settings version.
      // Keep local settings when the cloud has not changed since that sync;
      // a genuinely newer cloud version must still win on another device.
      if (state.ownerId && !Object.prototype.hasOwnProperty.call(parsed, "settingsDirty") && !state.settingsUpdatedAt) {
        try {
          var lastConfirmed = localStorage.getItem("ot-tracker-last-sync-v1");
          if (tsOf(lastConfirmed)) state.settingsUpdatedAt = lastConfirmed;
        } catch (e) {}
      }
      // Own try/catch: the outer one falls back to an empty DEFAULT_STATE,
      // so a throw in here would hide every record the user has. Repairing
      // ids is a nice-to-have; never let it cost data.
      try {
        var entriesRepaired = repairInvalidIds(state.entries);
        var notesRepaired = repairInvalidIds(state.workNotes);
        if (entriesRepaired || notesRepaired) {
          localStorage.setItem(storageKey, JSON.stringify(state));
        }
      } catch (e) {
        console.error(tr("ซ่อม id ของรายการไม่สำเร็จ"), e);
      }
      return state;
    } catch (e) {
      console.error(tr("โหลดข้อมูลผิดพลาด"), e);
      return clone(DEFAULT_STATE);
    }
  }


  function accountCacheKey(userId) { return ACCOUNT_CACHE_PREFIX + userId; }

  function archiveAccountState(snapshot) {
    if (!snapshot.ownerId) return;
    var key = accountCacheKey(snapshot.ownerId);
    var existing = loadState(key);
    // A partial working-key failure can leave the account copy newer. Never
    // replace it with an older working snapshot during account switching.
    if (existing.ownerId === snapshot.ownerId && existing.localRevision > (snapshot.localRevision || 0)) {
      var recovered = clone(existing);
      var entries = mergeRecords([{live:existing.entries,dead:existing.deletedEntries},
        {live:snapshot.entries,dead:snapshot.deletedEntries}]);
      var notes = mergeRecords([{live:existing.workNotes,dead:existing.deletedNotes},
        {live:snapshot.workNotes,dead:snapshot.deletedNotes}]);
      recovered.entries = entries.live; recovered.deletedEntries = entries.dead;
      recovered.workNotes = notes.live; recovered.deletedNotes = notes.dead;
      localStorage.setItem(key, JSON.stringify(recovered));
    } else localStorage.setItem(key, JSON.stringify(snapshot));
  }

  function persistWorkingState(snapshot) {
    // Keep an account-owned recovery copy and the legacy working key. Either
    // copy can recover a partial storage failure; localRevision resolves ties.
    var cached = loadState(accountCacheKey(snapshot.ownerId));
    snapshot.localRevision = Math.max(snapshot.localRevision || 0,
      cached.ownerId === snapshot.ownerId ? cached.localRevision || 0 : 0) + 1;
    var raw = JSON.stringify(snapshot), workingSaved = false, accountSaved = false, failure;
    try { localStorage.setItem(STORAGE_KEY, raw); workingSaved = true; } catch (err) { failure = err; }
    try { archiveAccountState(snapshot); accountSaved = !!snapshot.ownerId; } catch (err) { failure = err; }
    if (!workingSaved && !accountSaved) throw failure || new Error(tr("บันทึกข้อมูลในเครื่องไม่ได้"));
  }

  // Which account this device may record for right now.
  //
  // Normally that is whoever is signed in. The second case matters just as
  // much though: the auth library is loaded from a CDN, so with no
  // connection there is no client at all and no way to ask who is signed
  // in - and a phone in a basement or a factory still has to be able to
  // record OT. When that happens the device falls back to the account its
  // stored records already belong to, and everything syncs once it is back
  // online.
  //
  // A browser with no session and nothing stored - a fresh one, or one
  // somebody deliberately signed out of - belongs to no account and stays
  // blank, which is the whole point.
  function activeOwnerId() {
    if (explicitLogout || !accountStorageReady) return null;
    if (currentUserId) return currentUserId;
    if (!supabaseClient && state.ownerId) return state.ownerId;
    return null;
  }

  function saveState() {
    // Records belong to an account, not to a browser. With no account to
    // file them under nothing is written to this device at all - that is
    // what keeps a shared or borrowed browser from quietly accumulating
    // somebody's OT. Callers the user drives directly say so out loud via
    // requireSignIn() rather than failing silently.
    var owner = activeOwnerId();
    if (!owner) return;
    state.ownerId = owner;
    var settingsJSON = JSON.stringify(state.settings);
    if (settingsJSON !== lastSavedSettings) {
      state.settingsDirty = true;
      state.settingsUpdatedAt = nowISO();
      lastSavedSettings = settingsJSON;
    }
    persistWorkingState(state);
    pushStateToCloud();
  }

  // Signed out, the app is a blank slate: it shows nothing and saves
  // nothing. Returns true when it is safe to go ahead.
  function requireSignIn() {
    if (activeOwnerId()) return true;
    if (explicitLogout) { showToast(tr("กำลังออกจากระบบ รอสักครู่")); return false; }
    if (!accountStorageReady) { showToast(tr("เก็บข้อมูลบัญชีก่อนหน้าไม่สำเร็จ ข้อมูลเดิมยังอยู่ กรุณาตรวจพื้นที่ในเครื่อง")); return false; }
    showToast(tr("เข้าสู่ระบบด้วย Google ก่อน แล้วข้อมูลจะถูกบันทึกและซิงก์ให้อัตโนมัติ"));
    return false;
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // With an auth client, wait for the verified account before showing local
  // records. Offline startup retains the previously owned working copy.
  var initialLocalState = loadState();
  var state = (window.supabase && window.supabase.createClient) ? clone(DEFAULT_STATE) : initialLocalState;
  var lastSavedSettings = JSON.stringify(state.settings);

  /* ============================================================
   * Helpers
   * ========================================================== */
  // ต้องคืนค่าเป็น UUID ที่ถูกต้องเสมอ เพราะ id นี้ถูกใช้เป็น primary key
  // ชนิด uuid ใน ot_entries/work_notes บน Supabase - ถ้าฟอร์แมตผิด (เช่น เดิม
  // fallback คืนค่า "id-<timestamp>-<random>") การ insert ทั้งก้อนจะ fail
  // และเพราะ pushStateToCloud() ลบแถวเดิมทิ้งก่อน insert ใหม่ ความล้มเหลวนี้
  // จะทำให้ข้อมูลบน cloud หายจริง (ไม่ใช่แค่ sync ไม่สำเร็จ)
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    if (window.crypto && crypto.getRandomValues) {
      var bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      var hex = Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
      return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // ประกาศเป็น function (ไม่ใช่ var) เพราะ loadState() ถูกเรียกก่อนบรรทัดนี้ -
  // function declaration ถูก hoist ขึ้นไปทั้งก้อน แต่ค่าใน var จะยังเป็น
  // undefined อยู่ตอนนั้น
  function isValidUuid(id) {
    return typeof id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  }

  // เครื่องที่เคยสร้างรายการตอน crypto.randomUUID ใช้ไม่ได้ (เช่น in-app
  // browser เก่าบางตัว) จะมี id ค้างอยู่ในฟอร์แมตเก่าที่ไม่ใช่ uuid - ซ่อมให้
  // ตอนโหลด state เพื่อให้ sync ขึ้น cloud รอบถัดไปสำเร็จ แทนที่จะ fail ซ้ำๆ
  function repairInvalidIds(list) {
    var changed = false;
    (list || []).forEach(function (item) {
      if (!isValidUuid(item.id)) {
        item.id = uid();
        changed = true;
      }
    });
    return changed;
  }

  function nowISO() { return new Date().toISOString(); }

  // Postgres hands timestamps back as "...+00:00" while the app writes
  // "...Z", so these are compared as numbers, never as strings. An older
  // record with no stamp at all (saved before this field existed) counts as
  // the oldest possible, so anything with a real stamp beats it.
  function tsOf(value) {
    var t = value ? Date.parse(value) : NaN;
    return isNaN(t) ? 0 : t;
  }

  /**
   * Merges record sets from any number of sources (this device, the cloud)
   * into one, per id. Records only ever get added or updated here, never
   * dropped: an id that exists on one side and not the other is kept. The
   * only way for a record to disappear is an explicit tombstone, which is
   * itself just another version of that id.
   *
   * For each id the version with the newest timestamp wins; a tie goes to
   * the deletion, so a delete can't lose to the very record it removed.
   *
   * @param sources array of { live: [records], dead: [{id, deletedAt}] }
   * @returns { live: [records], dead: [{id, deletedAt}] }
   */
  function mergeRecords(sources) {
    var best = Object.create(null);
    function consider(id, ts, deleted, payload) {
      if (!id) return;
      var cur = best[id];
      if (!cur || ts > cur.ts || (ts === cur.ts && deleted && !cur.deleted)) {
        best[id] = { ts: ts, deleted: deleted, payload: payload };
      }
    }
    sources.forEach(function (src) {
      (src.live || []).forEach(function (rec) {
        consider(rec.id, tsOf(rec.updatedAt), false, rec);
      });
      (src.dead || []).forEach(function (t) {
        consider(t.id, tsOf(t.deletedAt), true, t);
      });
    });
    var live = [], dead = [];
    Object.keys(best).forEach(function (id) {
      var win = best[id];
      if (win.deleted) dead.push({ id: id, deletedAt: win.payload.deletedAt || nowISO() });
      else live.push(win.payload);
    });
    return { live: live, dead: dead };
  }

  // Records a delete as a tombstone instead of just dropping the record, so
  // the removal reaches the user's other devices on the next sync.
  function tombstone(list, id) {
    var at = -1;
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) { at = i; break; } }
    if (at === -1) list.push({ id: id, deletedAt: nowISO() });
    else list[at].deletedAt = nowISO();
  }

  function pad2(n) { return String(n).padStart(2, "0"); }

  function toISODate(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function fromISODate(s) {
    var parts = s.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function addDays(d, n) {
    var r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  }

  function addMonths(d, n) {
    var r = new Date(d.getFullYear(), d.getMonth() + n, 1);
    return r;
  }

  function timeToMinutes(t) {
    var parts = t.split(":").map(Number);
    return parts[0] * 60 + parts[1];
  }

  function fmtHours(h) {
    return (Math.round(h * 100) / 100).toLocaleString(I18N.locale(), { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  }

  function fmtMoney(v) {
    var cur = currentCurrency();
    var factor = Math.pow(10, cur.decimals);
    var rounded = Math.round(v * factor) / factor;
    return cur.symbol + rounded.toLocaleString(I18N.locale(), { minimumFractionDigits: cur.decimals, maximumFractionDigits: cur.decimals });
  }

  /* ============================================================
   * Comma-formatted money inputs
   *
   * Any <input class="money-input"> gets live thousands-separator
   * formatting while typing, with the cursor kept in place by counting
   * digits (not punctuation) to its left and re-finding that same digit
   * offset in the reformatted string. The underlying numeric value is
   * always recovered with parseMoneyInput() by stripping the commas.
   * ========================================================== */
  function formatMoneyDisplay(raw) {
    var cleaned = String(raw).replace(/[^\d.]/g, "");
    var firstDot = cleaned.indexOf(".");
    if (firstDot !== -1) {
      cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
    }
    var parts = cleaned.split(".");
    var intPart = parts[0].replace(/^0+(?=\d)/, "");
    var intFormatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return parts.length > 1 ? intFormatted + "." + parts[1] : intFormatted;
  }

  function countDigitsBefore(str, pos) {
    var count = 0;
    for (var i = 0; i < pos && i < str.length; i++) {
      if (/\d/.test(str[i])) count++;
    }
    return count;
  }

  function positionAfterNDigits(str, n) {
    if (n <= 0) return 0;
    var count = 0;
    for (var i = 0; i < str.length; i++) {
      if (/\d/.test(str[i])) {
        count++;
        if (count === n) return i + 1;
      }
    }
    return str.length;
  }

  function setMoneyInputValue(el, num) {
    el.value = formatMoneyDisplay(String(num || 0));
  }

  function parseMoneyInput(el) {
    return Number(el.value.replace(/,/g, "")) || 0;
  }

  function initMoneyInputs(root) {
    Array.prototype.forEach.call(root.querySelectorAll(".money-input"), function (el) {
      el.addEventListener("input", function () {
        var oldValue = el.value;
        var oldPos = el.selectionStart == null ? oldValue.length : el.selectionStart;
        var digitsBefore = countDigitsBefore(oldValue, oldPos);
        var newValue = formatMoneyDisplay(oldValue);
        if (newValue !== oldValue) el.value = newValue;
        var newPos = positionAfterNDigits(newValue, digitsBefore);
        el.setSelectionRange(newPos, newPos);
      });
    });
  }

  var dfFull, dfShort, dfMonthYear, dfYear, dfMonthShort, dfDateTime;
  function refreshDateFormats() {
    dfFull = new Intl.DateTimeFormat(I18N.locale(), { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    dfShort = new Intl.DateTimeFormat(I18N.locale(), { weekday: "short", day: "numeric", month: "short" });
    dfMonthYear = new Intl.DateTimeFormat(I18N.locale(), { month: "long", year: "numeric" });
    dfYear = new Intl.DateTimeFormat(I18N.locale(), { year: "numeric" });
    dfMonthShort = new Intl.DateTimeFormat(I18N.locale(), { month: "short" });
    dfDateTime = new Intl.DateTimeFormat(I18N.locale(), { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  refreshDateFormats();

  /* ============================================================
   * Calculation core
   *
   * The work day is a fixed schedule (all configurable in Settings):
   *   [workStart      -> lunchStart]        normal work
   *   [lunchStart      -> lunchEnd]          lunch break (never counted)
   *   [lunchEnd        -> normalEnd]         normal work
   *   [normalEnd       -> mandatoryOtEnd]    OT (mandatory block, prorated
   *                                          if the actual clock-out falls
   *                                          inside this window)
   *   [mandatoryOtEnd  -> eveningBreakStart] OT (only non-zero if the two
   *                                          settings are configured apart)
   *   [eveningBreakStart -> eveningBreakEnd] evening break (never counted)
   *   [eveningBreakEnd  -> actual clock-out] OT, open-ended
   *
   * Normal hours = overlap of the actual clocked interval with the two
   * "normal work" segments. OT hours = overlap with the OT segments. Breaks
   * are simply never summed into either, regardless of whether the
   * employee was still clocked in during them.
   * ========================================================== */
  var OPEN_ENDED = 100000; // minutes; stands in for "no upper bound"

  function overlapMinutes(aStart, aEnd, bStart, bEnd) {
    return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  }

  // Resolves the schedule to actual clock-time boundaries, collapsing any
  // window whose toggle is off to zero width so it drops out of every
  // overlap calculation below without needing separate on/off branches.
  function effectiveSchedule(settings) {
    var ws = timeToMinutes(settings.workStart);
    var ne = timeToMinutes(settings.normalEnd);
    return {
      ws: ws,
      ne: ne,
      ls: settings.hasLunchBreak ? timeToMinutes(settings.lunchStart) : ne,
      le: settings.hasLunchBreak ? timeToMinutes(settings.lunchEnd) : ne,
      moe: settings.hasMandatoryOt ? timeToMinutes(settings.mandatoryOtEnd) : ne,
      ebs: settings.hasEveningBreak ? timeToMinutes(settings.eveningBreakStart) : OPEN_ENDED,
      ebe: settings.hasEveningBreak ? timeToMinutes(settings.eveningBreakEnd) : OPEN_ENDED
    };
  }

  function scheduleNormalHoursPerDay(settings) {
    var sch = effectiveSchedule(settings);
    var minutes =
      overlapMinutes(0, OPEN_ENDED, sch.ws, sch.ls) +
      overlapMinutes(0, OPEN_ENDED, sch.le, sch.ne);
    return minutes / 60;
  }

  function effectiveHourlyRate(settings) {
    return settings.hourlyRate || 0;
  }

  function isWeekendDate(dateStr) {
    if (!dateStr) return false;
    var day = fromISODate(dateStr).getDay(); // 0 Sun .. 6 Sat
    return day === 0 || day === 6;
  }

  // returns null if inputs invalid
  function computeEntry(entry, settings) {
    if (!entry.timeIn || !entry.timeOut) return null;
    var inMin = timeToMinutes(entry.timeIn);
    var outMin = timeToMinutes(entry.timeOut);
    var overnight = outMin <= inMin;
    if (overnight) outMin += 24 * 60; // overnight shift

    var weekend = isWeekendDate(entry.date);
    var sch = effectiveSchedule(settings);

    var normalMin, otMin;

    if (weekend) {
      // Weekends have no normal-hours threshold, no mandatory-OT block, and
      // no evening-break buffer: every worked minute is OT, lunch excluded.
      normalMin = 0;
      otMin = Math.max(0, (outMin - inMin) - overlapMinutes(inMin, outMin, sch.ls, sch.le));
    } else {
      normalMin =
        overlapMinutes(inMin, outMin, sch.ws, sch.ls) +
        overlapMinutes(inMin, outMin, sch.le, sch.ne);

      otMin =
        overlapMinutes(inMin, outMin, sch.ne, sch.moe) +
        overlapMinutes(inMin, outMin, sch.moe, sch.ebs) +
        overlapMinutes(inMin, outMin, sch.ebe, OPEN_ENDED);
    }

    var normalHours = normalMin / 60;
    var otHours = otMin / 60;
    var workHours = normalHours + otHours;

    var rate = effectiveHourlyRate(settings);
    var defaultMultiplier = weekend ? (settings.weekendOtMultiplier || 1.5) : (settings.otMultiplier || 1);
    var multiplier = (entry.otMultiplier === null || entry.otMultiplier === undefined)
      ? defaultMultiplier
      : entry.otMultiplier;

    var normalPay = normalHours * rate;
    var otPay = otHours * rate * multiplier;

    return {
      workHours: workHours,
      normalHours: normalHours,
      otHours: otHours,
      rate: rate,
      multiplier: multiplier,
      normalPay: normalPay,
      otPay: otPay,
      totalPay: normalPay + otPay,
      overnight: overnight,
      weekend: weekend
    };
  }

  function aggregate(entries, settings) {
    var agg = {
      normalHours: 0, otHours: 0, normalPay: 0, otPay: 0, totalPay: 0, totalHours: 0, count: 0,
      otHoursWeekday: 0, otPayWeekday: 0, otHoursWeekend: 0, otPayWeekend: 0
    };
    entries.forEach(function (e) {
      var c = computeEntry(e, settings);
      if (!c) return;
      agg.normalHours += c.normalHours;
      agg.otHours += c.otHours;
      agg.normalPay += c.normalPay;
      agg.otPay += c.otPay;
      agg.totalPay += c.totalPay;
      agg.totalHours += c.workHours;
      agg.count++;
      if (c.weekend) {
        agg.otHoursWeekend += c.otHours;
        agg.otPayWeekend += c.otPay;
      } else {
        agg.otHoursWeekday += c.otHours;
        agg.otPayWeekday += c.otPay;
      }
    });
    return agg;
  }

  /* ============================================================
   * DOM refs
   * ========================================================== */
  var $ = function (id) { return document.getElementById(id); };

  var els = {
    headerTitle: $("headerTitle"),
    themeToggleBtn: $("themeToggleBtn"),
    colorThemeToggleBtn: $("colorThemeToggleBtn"),
    colorThemePopover: $("colorThemePopover"),
    tabbar: $("tabbar"),
    views: {
      entry: $("view-entry"),
      summary: $("view-summary"),
      settings: $("view-settings")
    },
    entryForm: $("entryForm"),
    entryFormTitle: $("entryFormTitle"),
    fDate: $("f-date"),
    dateTrigger: $("dateTrigger"),
    dateTriggerText: $("dateTriggerText"),
    weekendNotice: $("weekendNotice"),
    holidayNotice: $("holidayNotice"),
    fTimeIn: $("f-timein"),
    fTimeOut: $("f-timeout"),
    fOtRate: $("f-otrate"),
    fOtCustomWrap: $("f-otcustom-wrap"),
    fOtCustom: $("f-otcustom"),
    fNote: $("f-note"),
    entryPreview: $("entryPreview"),
    cancelEditBtn: $("cancelEditBtn"),
    saveEntryBtn: $("saveEntryBtn"),
    entryList: $("entryList"),
    entryCount: $("entryCount"),

    entrySubTabs: $("entrySubTabs"),
    entrySubviewLog: $("entrySubviewLog"),
    entrySubviewNotes: $("entrySubviewNotes"),
    noteForm: $("noteForm"),
    noteFormTitle: $("noteFormTitle"),
    nTitle: $("n-title"),
    nDescription: $("n-description"),
    noteStartTrigger: $("noteStartTrigger"),
    noteStartTriggerText: $("noteStartTriggerText"),
    nStartDate: $("n-startdate"),
    noteEndTrigger: $("noteEndTrigger"),
    noteEndTriggerText: $("noteEndTriggerText"),
    nEndDate: $("n-enddate"),
    nRemindEnabled: $("n-remind-enabled"),
    noteRemindFields: $("noteRemindFields"),
    noteRemindTrigger: $("noteRemindTrigger"),
    noteRemindTriggerText: $("noteRemindTriggerText"),
    nRemindDate: $("n-reminddate"),
    nRemindTime: $("n-remindtime"),
    cancelEditNoteBtn: $("cancelEditNoteBtn"),
    saveNoteBtn: $("saveNoteBtn"),
    noteList: $("noteList"),
    noteCount: $("noteCount"),

    summaryModeTabs: $("summaryModeTabs"),
    periodPrev: $("periodPrev"),
    periodNext: $("periodNext"),
    periodLabel: $("periodLabel"),
    exportExcelBtn: $("exportExcelBtn"),
    exportOverlay: $("exportOverlay"),
    exportRangeTabs: $("exportRangeTabs"),
    exportCustomRange: $("exportCustomRange"),
    exportRangeStart: $("exportRangeStart"),
    exportRangeEnd: $("exportRangeEnd"),
    exportRangeError: $("exportRangeError"),
    exportCancelBtn: $("exportCancelBtn"),
    exportConfirmBtn: $("exportConfirmBtn"),
    exportHint: $("exportHint"),
    summaryRecorderLine: $("summaryRecorderLine"),
    statNormalHours: $("statNormalHours"),
    statNormalPay: $("statNormalPay"),
    statOtHours: $("statOtHours"),
    statOtPay: $("statOtPay"),
    statTotalPay: $("statTotalPay"),
    statTotalHours: $("statTotalHours"),
    compareTotalPay: $("compareTotalPay"),
    compareOtHours: $("compareOtHours"),
    compareOtPay: $("compareOtPay"),
    dayListTitle: $("dayListTitle"),
    summaryDays: $("summaryDays"),
    chartTitle: $("chartTitle"),
    trendChart: $("trendChart"),
    trendTooltip: $("trendTooltip"),
    otWeekdayVal: $("otWeekdayVal"),
    otWeekendVal: $("otWeekendVal"),
    salaryBreakdownCard: $("salaryBreakdownCard"),
    sbSalary: $("sbSalary"),
    sbOtPay: $("sbOtPay"),
    sbTotal: $("sbTotal"),

    goalProgressCard: $("goalProgressCard"),
    goalProgressValue: $("goalProgressValue"),
    goalProgressPct: $("goalProgressPct"),
    goalProgressFill: $("goalProgressFill"),

    sRecorderName: $("s-recordername"),
    sDefaultTimeIn: $("s-defaulttimein"),
    sDefaultTimeOut: $("s-defaulttimeout"),
    sLockTimeIn: $("s-locktimein"),
    sLockTimeOut: $("s-locktimeout"),
    sLockTimeOutWeekend: $("s-locktimeoutweekend"),
    lockTimeInRow: $("lockTimeInRow"),
    lockTimeOutRow: $("lockTimeOutRow"),
    lockTimeOutWeekendRow: $("lockTimeOutWeekendRow"),
    sPushEnabled: $("s-pushenabled"),
    pushRow: $("pushRow"),
    pushHint: $("pushHint"),
    sNotifyLateOut: $("s-notifylateout"),
    sNotifyTime: $("s-notifytime"),
    notifyTimeRow: $("notifyTimeRow"),
    currencyTrigger: $("currencyTrigger"),
    currencyTriggerFlag: $("currencyTriggerFlag"),
    currencyTriggerLabel: $("currencyTriggerLabel"),
    currencyOverlay: $("currencyOverlay"),
    currencyList: $("currencyList"),
    currencyClose: $("currencyClose"),
    hourlyRateLabel: $("hourlyRateLabel"),
    monthlySalaryLabel: $("monthlySalaryLabel"),
    otGoalLabel: $("otGoalLabel"),
    sHourlyRate: $("s-hourlyrate"),
    sMonthlySalary: $("s-monthlysalary"),
    sOtGoal: $("s-otgoal"),
    sWorkStart: $("s-workstart"),
    sHasLunchBreak: $("s-haslunchbreak"),
    sLunchStart: $("s-lunchstart"),
    sLunchEnd: $("s-lunchend"),
    sNormalEnd: $("s-normalend"),
    sHasMandatoryOt: $("s-hasmandatoryot"),
    sMandatoryOtEnd: $("s-mandatoryotend"),
    sHasEveningBreak: $("s-haseveningbreak"),
    sEveningBreakStart: $("s-eveningbreakstart"),
    sEveningBreakEnd: $("s-eveningbreakend"),
    sOtMultiplier: $("s-otmultiplier"),
    sWeekendOtMultiplier: $("s-weekendotmultiplier"),
    saveIndicator: $("saveIndicator"),

    exportBtn: $("exportBtn"),
    importInput: $("importInput"),
    clearBtn: $("clearBtn"),

    authSignedOut: $("authSignedOut"),
    authSignedIn: $("authSignedIn"),
    googleLoginBtn: $("googleLoginBtn"),
    logoutBtn: $("logoutBtn"),
    userEmailDisplay: $("userEmailDisplay"),
    syncStatusRow: $("syncStatusRow"),
    syncStatusIcon: $("syncStatusIcon"),
    syncStatusText: $("syncStatusText"),
    syncRetryBtn: $("syncRetryBtn"),
    reconnectBtn: $("reconnectBtn"),
    syncErrorBanner: $("syncErrorBanner"),

    toast: $("toast"),
    confirmOverlay: $("confirmDialog"),
    confirmMessage: $("confirmMessage"),
    confirmOk: $("confirmOk"),
    confirmCancel: $("confirmCancel"),
    installBtn: $("installBtn"),

    calendarOverlay: $("calendarOverlay"),
    calMonthLabel: $("calMonthLabel"),
    calPrev: $("calPrev"),
    calNext: $("calNext"),
    calendarGrid: $("calendarGrid"),
    calToday: $("calToday"),
    calClear: $("calClear"),
    calClose: $("calClose")
  };

  /* ============================================================
   * Toast / Confirm
   * ========================================================== */
  var toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove("show"); }, 2200);
  }

  function showConfirm(message) {
    return new Promise(function (resolve) {
      els.confirmMessage.textContent = message;
      els.confirmOverlay.classList.remove("hidden");
      function cleanup(result) {
        els.confirmOverlay.classList.add("hidden");
        els.confirmOk.removeEventListener("click", onOk);
        els.confirmCancel.removeEventListener("click", onCancel);
        resolve(result);
      }
      function onOk() { cleanup(true); }
      function onCancel() { cleanup(false); }
      els.confirmOk.addEventListener("click", onOk);
      els.confirmCancel.addEventListener("click", onCancel);
    });
  }

  /* ============================================================
   * Theme (dark / light)
   * ========================================================== */
  var THEME_KEY = "ot-tracker-theme";

  function systemPrefersDark() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function currentTheme() {
    var attr = document.documentElement.getAttribute("data-theme");
    return attr === "dark" || attr === "light" ? attr : (systemPrefersDark() ? "dark" : "light");
  }

  var ICON_SUN = tr('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="โหมดสว่าง"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>');
  var ICON_MOON = tr('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="โหมดมืด"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/></svg>');
  var ICON_REFRESH = tr('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="กำลังซิงก์"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>');
  var ICON_WARNING = tr('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="คำเตือน"><path d="m12 2 10 18H2L12 2Z"/><line x1="12" y1="9" x2="12" y2="13"/><circle cx="12" cy="16.5" r="0.6" fill="currentColor" stroke="none"/></svg>');
  var ICON_CLOUD_CHECK = tr('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="ซิงก์แล้ว"><path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.5A4 4 0 0 0 6 19h11.5Z"/><path d="m9 15 2 2 4-4"/></svg>');
  var ICON_NOTE = tr('<svg class="note-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="โน้ต"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>');
  var ICON_BELL = tr('<svg class="note-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="แจ้งเตือน"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>');

  function updateThemeToggleIcon(theme) {
    els.themeToggleBtn.innerHTML = theme === "dark" ? ICON_SUN : ICON_MOON;
  }

  function updateMetaThemeColor(theme) {
    var metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (!metaThemeColor) return;
    var varName = theme === "dark" ? "--page" : "--series-normal";
    var color = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    metaThemeColor.setAttribute("content", color || (theme === "dark" ? "#0d0d0d" : "#2a78d6"));
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
    updateThemeToggleIcon(theme);
    updateMetaThemeColor(theme);
  }

  els.themeToggleBtn.addEventListener("click", function () {
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
  });

  updateThemeToggleIcon(currentTheme());
  updateMetaThemeColor(currentTheme());

  /* ============================================================
   * Color theme (sunset / ocean / midnight)
   * Separate from dark/light above — uses [data-color-theme] on
   * <html>, not [data-theme], to avoid clobbering dark mode.
   * Picked from the popover next to the dark/light toggle in the
   * header (#colorThemeToggleBtn / #colorThemePopover).
   * ========================================================== */
  var COLOR_THEME_KEY = "ot-tracker-color-theme";
  var COLOR_THEMES = ["sunset", "ocean", "midnight"];
  var themePicker = els.colorThemePopover;

  function applyColorTheme(theme) {
    if (COLOR_THEMES.indexOf(theme) === -1) theme = "sunset";
    document.documentElement.setAttribute("data-color-theme", theme);
    if (themePicker) {
      Array.prototype.forEach.call(themePicker.querySelectorAll(".theme-swatch"), function (btn) {
        btn.classList.toggle("is-active", btn.dataset.colorTheme === theme);
      });
    }
    updateMetaThemeColor(currentTheme());
  }

  applyColorTheme(localStorage.getItem(COLOR_THEME_KEY) || "sunset");

  /* ============================================================
   * Background style (flat / gradient / glass)
   * Independent of both dark/light and color theme — uses
   * [data-bg-style] on <html>. Picked from the same header popover,
   * second row of swatches.
   * ========================================================== */
  var BG_STYLE_KEY = "ot-tracker-bg-style";
  var BG_STYLES = ["flat", "gradient", "glass"];

  function applyBgStyle(style) {
    if (BG_STYLES.indexOf(style) === -1) style = "gradient";
    document.documentElement.setAttribute("data-bg-style", style);
    if (themePicker) {
      Array.prototype.forEach.call(themePicker.querySelectorAll(".bgstyle-swatch"), function (btn) {
        btn.classList.toggle("is-active", btn.dataset.bgStyleOption === style);
      });
    }
  }

  applyBgStyle(localStorage.getItem(BG_STYLE_KEY) || "gradient");

  if (themePicker) {
    themePicker.addEventListener("click", function (e) {
      var colorBtn = e.target.closest(".theme-swatch");
      if (colorBtn) {
        var theme = colorBtn.dataset.colorTheme;
        try { localStorage.setItem(COLOR_THEME_KEY, theme); } catch (err) {}
        applyColorTheme(theme);
        closeColorThemePopover();
        return;
      }
      var bgBtn = e.target.closest(".bgstyle-swatch");
      if (bgBtn) {
        var style = bgBtn.dataset.bgStyleOption;
        try { localStorage.setItem(BG_STYLE_KEY, style); } catch (err) {}
        applyBgStyle(style);
        closeColorThemePopover();
      }
    });
  }

  function openColorThemePopover() {
    if (!els.colorThemePopover) return;
    els.colorThemePopover.classList.remove("hidden");
    els.colorThemeToggleBtn.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onColorThemePopoverOutsideClick, true);
    document.addEventListener("keydown", onColorThemePopoverKeydown);
  }

  function closeColorThemePopover() {
    if (!els.colorThemePopover) return;
    els.colorThemePopover.classList.add("hidden");
    els.colorThemeToggleBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onColorThemePopoverOutsideClick, true);
    document.removeEventListener("keydown", onColorThemePopoverKeydown);
  }

  function onColorThemePopoverOutsideClick(e) {
    if (els.colorThemePopover.contains(e.target) || els.colorThemeToggleBtn.contains(e.target)) return;
    closeColorThemePopover();
  }

  function onColorThemePopoverKeydown(e) {
    if (e.key === "Escape") closeColorThemePopover();
  }

  if (els.colorThemeToggleBtn && els.colorThemePopover) {
    els.colorThemeToggleBtn.addEventListener("click", function () {
      if (els.colorThemePopover.classList.contains("hidden")) openColorThemePopover();
      else closeColorThemePopover();
    });
  }

  /* ============================================================
   * Header title / recorder name
   * ========================================================== */
  function updateHeaderTitle() {
    var name = (state.settings.recorderName || "").trim();
    els.headerTitle.textContent = name ? "OT Fast — " + name : "OT Fast";
  }

  /* ============================================================
   * Tab navigation
   * ========================================================== */
  els.tabbar.addEventListener("click", function (e) {
    var btn = e.target.closest(".tabbar__btn");
    if (!btn) return;
    var view = btn.dataset.view;
    Object.keys(els.views).forEach(function (k) {
      els.views[k].classList.toggle("hidden", k !== view);
    });
    Array.prototype.forEach.call(els.tabbar.children, function (b) {
      b.classList.toggle("is-active", b === btn);
    });
    window.scrollTo(0, 0);
    if (view === "summary") renderSummary();
  });

  /* ============================================================
   * Entry sub-tabs (บันทึกเวลา / บันทึกเหตุการณ์) - lives inside the
   * "entry" main tab only, no separate bottom-nav entry (see workNotes
   * section further below for the sub-tab's own content).
   * ========================================================== */
  els.entrySubTabs.addEventListener("click", function (e) {
    var btn = e.target.closest(".segmented__btn");
    if (!btn) return;
    var subview = btn.dataset.subview;
    els.entrySubviewLog.classList.toggle("hidden", subview !== "log");
    els.entrySubviewNotes.classList.toggle("hidden", subview !== "notes");
    Array.prototype.forEach.call(els.entrySubTabs.children, function (b) {
      b.classList.toggle("is-active", b === btn);
    });
  });

  /* ============================================================
   * Entry form
   * ========================================================== */
  var editingId = null;

  // Entry-form autofill values, sourced from the user's own "เวลาเข้า-ออกงานปกติ"
  // settings - blank/unlocked unless the user has both filled in a value AND
  // switched its lock on (see updateLockToggleAvailability).
  function lockedTimeIn() {
    var s = state.settings;
    return (s.lockTimeIn && s.defaultTimeIn) ? s.defaultTimeIn : "";
  }
  function lockedTimeOutWeekday() {
    var s = state.settings;
    return (s.lockTimeOut && s.defaultTimeOut) ? s.defaultTimeOut : "";
  }

  // By default weekend clock-out is left blank (it's rarely predictable), but
  // if the user turned on lockTimeOutWeekend the locked value is filled on
  // Sat/Sun too. Only touches the field when it still looks like an untouched
  // default (blank, or the locked value) so it never clobbers user input.
  function applyWeekendTimeDefault() {
    var lockedOut = lockedTimeOutWeekday();
    var blankWeekend = isWeekendDate(els.fDate.value) && !state.settings.lockTimeOutWeekend;
    if (blankWeekend && els.fTimeOut.value === lockedOut) {
      els.fTimeOut.value = "";
    } else if (!blankWeekend && els.fTimeOut.value === "") {
      els.fTimeOut.value = lockedOut;
    }
  }

  function resetForm() {
    editingId = null;
    entryFormTouched = false;
    els.entryForm.reset();
    els.fDate.value = toISODate(new Date());
    els.fTimeIn.value = lockedTimeIn();
    els.fTimeOut.value = lockedTimeOutWeekday();
    applyWeekendTimeDefault();
    els.fOtRate.value = "default";
    els.fOtCustomWrap.classList.add("hidden");
    els.entryFormTitle.textContent = tr("บันทึกเวลาทำงาน");
    els.saveEntryBtn.textContent = tr("บันทึก");
    els.cancelEditBtn.classList.add("hidden");
    updatePreview();
  }

  function fillFormFromEntry(entry) {
    editingId = entry.id;
    els.fDate.value = entry.date;
    els.fTimeIn.value = entry.timeIn;
    els.fTimeOut.value = entry.timeOut;
    els.fNote.value = entry.note || "";
    if (entry.otMultiplier === null || entry.otMultiplier === undefined) {
      els.fOtRate.value = "default";
      els.fOtCustomWrap.classList.add("hidden");
    } else if ([1.5, 2, 3].indexOf(entry.otMultiplier) !== -1) {
      els.fOtRate.value = String(entry.otMultiplier);
      els.fOtCustomWrap.classList.add("hidden");
    } else {
      els.fOtRate.value = "custom";
      els.fOtCustom.value = entry.otMultiplier;
      els.fOtCustomWrap.classList.remove("hidden");
    }
    els.entryFormTitle.textContent = tr("แก้ไขรายการ");
    els.saveEntryBtn.textContent = tr("บันทึกการแก้ไข");
    els.cancelEditBtn.classList.remove("hidden");
    updatePreview();
    els.entryForm.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function currentFormOtMultiplier() {
    var v = els.fOtRate.value;
    if (v === "default") return null;
    if (v === "custom") {
      var c = Number(els.fOtCustom.value);
      return isNaN(c) ? null : c;
    }
    return Number(v);
  }

  function draftEntryFromForm() {
    return {
      date: els.fDate.value,
      timeIn: els.fTimeIn.value,
      timeOut: els.fTimeOut.value,
      otMultiplier: currentFormOtMultiplier(),
      note: els.fNote.value.trim()
    };
  }

  function updateWeekendNotice() {
    els.weekendNotice.classList.toggle("hidden", !isWeekendDate(els.fDate.value));
  }

  function updateHolidayNotice() {
    var iso = els.fDate.value;
    var holidayName = null;
    if (iso) {
      var year = fromISODate(iso).getFullYear();
      var holidays = holidaysForYear(year);
      holidayName = holidays ? holidays[iso] : null;
      ensureHolidaysForYear(year);
    }
    if (holidayName) {
      els.holidayNotice.innerHTML = tr('<svg class="notice-icon" viewBox="0 0 24 24" fill="currentColor" role="img" aria-label="วันหยุดราชการ"><circle cx="12" cy="12" r="6"/></svg> ') + escapeHtml(holidayDisplayName(holidayName)) + tr(" — วันหยุดราชการ");
      els.holidayNotice.classList.remove("hidden");
    } else {
      els.holidayNotice.classList.add("hidden");
    }
  }

  // Shared by the entry-date trigger and the two work-note date triggers -
  // all three are "button styled as a date input" widgets backed by a
  // hidden <input type=hidden>, opened via the one shared calendar-box.
  function updateDateTriggerTextGeneric(inputEl, textEl, triggerEl) {
    var v = inputEl.value;
    textEl.textContent = v ? dfFull.format(fromISODate(v)) : tr("เลือกวันที่");
    triggerEl.classList.toggle("is-empty", !v);
  }

  function updateDateTriggerText() {
    updateDateTriggerTextGeneric(els.fDate, els.dateTriggerText, els.dateTrigger);
  }

  // Set as soon as the user types into a form, cleared when that form is
  // reset. Syncing must not clear a form somebody is in the middle of
  // filling in - that silently threw away what they had typed, and syncing
  // now happens whenever the app regains focus, not just at login.
  var entryFormTouched = false;
  var noteFormTouched = false;

  function resetFormsIfUntouched() {
    if (!entryFormTouched && !editingId) resetForm();
    if (!noteFormTouched && !editingNoteId) resetNoteForm();
  }

  function updatePreview() {
    updateWeekendNotice();
    updateHolidayNotice();
    updateDateTriggerText();
    var draft = draftEntryFromForm();
    if (!draft.timeIn || !draft.timeOut) {
      els.entryPreview.innerHTML = tr("กรอกเวลาเข้า-ออกงานเพื่อดูผลคำนวณ");
      return;
    }
    var c = computeEntry(draft, state.settings);
    if (!c) {
      els.entryPreview.innerHTML = tr('<span class="preview__error">ข้อมูลเวลาไม่ถูกต้อง</span>');
      return;
    }
    var html = "";
    if (c.overnight) html += tr("กะข้ามคืน (คำนวณเลยเที่ยงคืน)<br/>");
    html += tr("ชั่วโมงทำงานปกติ <strong>") + fmtHours(c.normalHours) + tr(" ชม.</strong> = ") + fmtMoney(c.normalPay) + "<br/>";
    html += tr("ชั่วโมง OT รวม <strong class=\"preview__ot\">") + fmtHours(c.otHours) + tr(" ชม.</strong>");
    if (c.otHours > 0) html += " (x" + c.multiplier + ")";
    html += " = <span class=\"preview__ot\">" + fmtMoney(c.otPay) + "</span><br/>";
    html += tr("ยอดรวมทั้งหมด <span class=\"preview__total\">") + fmtMoney(c.totalPay) + "</span>";
    els.entryPreview.innerHTML = html;
  }

  ["input", "change"].forEach(function (evt) {
    els.entryForm.addEventListener(evt, function (e) {
      entryFormTouched = true;
      if (e.target.id === "f-otrate") {
        els.fOtCustomWrap.classList.toggle("hidden", els.fOtRate.value !== "custom");
      }
      if (e.target.id === "f-date" && editingId === null) {
        applyWeekendTimeDefault();
      }
      updatePreview();
    });
  });

  els.entryForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!requireSignIn()) return;
    var draft = draftEntryFromForm();
    if (!draft.date || !draft.timeIn || !draft.timeOut) {
      showToast(tr("กรุณากรอกข้อมูลให้ครบ"));
      return;
    }
    if (!computeEntry(draft, state.settings)) {
      showToast(tr("เวลาไม่ถูกต้อง"));
      return;
    }
    if (editingId) {
      var idx = state.entries.findIndex(function (x) { return x.id === editingId; });
      if (idx !== -1) state.entries[idx] = Object.assign({ id: editingId, updatedAt: nowISO() }, draft);
      showToast(tr("แก้ไขรายการแล้ว ✓"));
    } else {
      draft.id = uid();
      draft.updatedAt = nowISO();
      state.entries.push(draft);
      showToast(tr("บันทึกแล้ว ✓"));
    }
    saveState();
    resetForm();
    renderEntryList();
  });

  els.cancelEditBtn.addEventListener("click", resetForm);

  /* ============================================================
   * Custom calendar (replaces the native date input)
   * ========================================================== */
  var calendarViewDate = new Date();

  function otHoursForDate(dateISO) {
    var total = 0;
    state.entries.forEach(function (e) {
      if (e.date === dateISO) {
        var c = computeEntry(e, state.settings);
        if (c) total += c.otHours;
      }
    });
    return total;
  }

  function fmtHoursShort(h) {
    return String(Math.round(h * 10) / 10);
  }

  // Whether any work note's [startDate, endDate] range covers this date -
  // drives the small "has a note" dot shown in the shared calendar-box
  // regardless of which field opened it (see calendarTarget below).
  function hasNoteForDate(iso) {
    return state.workNotes.some(function (n) { return iso >= n.startDate && iso <= n.endDate; });
  }

  // Which hidden date input the shared calendar-box is currently editing:
  // "entry" (f-date), "note-start" (n-startdate) or "note-end" (n-enddate).
  // Set by openCalendar(), read by renderCalendar()/selectCalendarDate() so
  // the same overlay/markup can drive all three date pickers.
  var calendarTarget = "entry";

  function calendarTargetFieldValue() {
    if (calendarTarget === "note-start") return els.nStartDate.value;
    if (calendarTarget === "note-end") return els.nEndDate.value;
    if (calendarTarget === "note-remind") return els.nRemindDate.value;
    return els.fDate.value;
  }

  function isNoteCalendarTarget() {
    return calendarTarget === "note-start" || calendarTarget === "note-end" || calendarTarget === "note-remind";
  }

  function renderCalendar() {
    var year = calendarViewDate.getFullYear();
    var month = calendarViewDate.getMonth();
    els.calMonthLabel.textContent = dfMonthYear.format(calendarViewDate);

    var firstOfMonth = new Date(year, month, 1);
    var startWeekday = firstOfMonth.getDay(); // 0 Sun .. 6 Sat
    var leadingBlanks = startWeekday === 0 ? 6 : startWeekday - 1; // Monday-first grid
    var daysInMonth = new Date(year, month + 1, 0).getDate();

    var todayISO = toISODate(new Date());
    var selectedISO = calendarTargetFieldValue();
    var holidays = holidaysForYear(year);

    var cells = "";
    for (var i = 0; i < leadingBlanks; i++) {
      cells += '<div class="calendar-day calendar-day--empty"></div>';
    }
    for (var day = 1; day <= daysInMonth; day++) {
      var cellDate = new Date(year, month, day);
      var iso = toISODate(cellDate);
      var dow = cellDate.getDay();
      var otHours = otHoursForDate(iso);
      var hasNote = hasNoteForDate(iso);
      var holidayName = holidays ? holidays[iso] : null;
      var holidayDisplay = holidayName ? holidayDisplayName(holidayName) : null;
      var classes = ["calendar-day"];
      if (iso === selectedISO) classes.push("is-selected");
      if (iso === todayISO) classes.push("is-today");
      if (dow === 0) classes.push("is-sunday");
      if (dow === 6) classes.push("is-saturday");
      if (holidayName) classes.push("is-holiday");
      cells +=
        '<button type="button" class="' + classes.join(" ") + '" data-date="' + iso + '"' +
          (holidayDisplay
            ? ' title="' + escapeAttr(holidayDisplay) + '" data-holiday="' + escapeAttr(holidayDisplay) + '"'
            : "") +
          ">" +
          '<span class="calendar-day__num">' + day + "</span>" +
          (otHours > 0 ? '<span class="calendar-day__ot">' + fmtHoursShort(otHours) + "</span>" : "") +
          (hasNote ? '<span class="calendar-day__note-dot"></span>' : "") +
        "</button>";
    }
    els.calendarGrid.innerHTML = cells;
    ensureHolidaysForYear(year);
  }

  function setFDateValue(iso) {
    els.fDate.value = iso;
    els.fDate.dispatchEvent(new Event("input", { bubbles: true }));
    els.fDate.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Shared setter for the two work-note date fields, which have no native
  // <input> event listeners of their own (unlike f-date) - just updates the
  // trigger button label directly. When setting the start date and the end
  // date is still blank or now precedes it, the end date is pulled along so
  // a single-day note (start === end, per the work-notes spec) is the
  // default without extra taps.
  function setNoteDateValue(target, iso) {
    if (target === "note-start") {
      els.nStartDate.value = iso;
      updateDateTriggerTextGeneric(els.nStartDate, els.noteStartTriggerText, els.noteStartTrigger);
      if (iso && (!els.nEndDate.value || els.nEndDate.value < iso)) {
        els.nEndDate.value = iso;
        updateDateTriggerTextGeneric(els.nEndDate, els.noteEndTriggerText, els.noteEndTrigger);
      }
    } else if (target === "note-remind") {
      els.nRemindDate.value = iso;
      updateDateTriggerTextGeneric(els.nRemindDate, els.noteRemindTriggerText, els.noteRemindTrigger);
    } else {
      els.nEndDate.value = iso;
      updateDateTriggerTextGeneric(els.nEndDate, els.noteEndTriggerText, els.noteEndTrigger);
    }
  }

  function openCalendar(target) {
    calendarTarget = target || "entry";
    var current = calendarTargetFieldValue();
    var base = current ? fromISODate(current) : new Date();
    calendarViewDate = new Date(base.getFullYear(), base.getMonth(), 1);
    renderCalendar();
    els.calendarOverlay.classList.remove("hidden");
  }

  function closeCalendar() {
    els.calendarOverlay.classList.add("hidden");
  }

  function selectCalendarDate(iso) {
    if (isNoteCalendarTarget()) {
      setNoteDateValue(calendarTarget, iso);
    } else {
      setFDateValue(iso);
    }
    closeCalendar();
  }

  els.dateTrigger.addEventListener("click", function () { openCalendar("entry"); });
  els.noteStartTrigger.addEventListener("click", function () { openCalendar("note-start"); });
  els.noteEndTrigger.addEventListener("click", function () { openCalendar("note-end"); });
  els.noteRemindTrigger.addEventListener("click", function () { openCalendar("note-remind"); });
  els.calClose.addEventListener("click", closeCalendar);

  els.calPrev.addEventListener("click", function () {
    calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() - 1, 1);
    renderCalendar();
  });
  els.calNext.addEventListener("click", function () {
    calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + 1, 1);
    renderCalendar();
  });
  els.calToday.addEventListener("click", function () {
    var t = new Date();
    calendarViewDate = new Date(t.getFullYear(), t.getMonth(), 1);
    selectCalendarDate(toISODate(t));
  });
  els.calClear.addEventListener("click", function () {
    if (isNoteCalendarTarget()) {
      setNoteDateValue(calendarTarget, "");
    } else {
      setFDateValue("");
    }
    closeCalendar();
  });
  els.calendarGrid.addEventListener("click", function (e) {
    var btn = e.target.closest(".calendar-day:not(.calendar-day--empty)");
    if (!btn) return;
    if (btn.dataset.holiday) showToast(btn.dataset.holiday);
    selectCalendarDate(btn.dataset.date);
  });

  /* ============================================================
   * Entry list
   * ========================================================== */
  function renderEntryList() {
    var sorted = state.entries.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.timeIn || "").localeCompare(a.timeIn || "");
    });

    els.entryCount.textContent = sorted.length ? sorted.length + tr(" รายการ") : "";

    if (!sorted.length) {
      els.entryList.innerHTML = tr('<div class="empty-state">ยังไม่มีข้อมูล เริ่มบันทึกเวลาทำงานวันแรกของคุณได้เลย ✨</div>');
      return;
    }

    els.entryList.innerHTML = sorted.map(function (entry) {
      var c = computeEntry(entry, state.settings);
      var dateLabel = dfFull.format(fromISODate(entry.date));
      var noteHtml = entry.note ? '<div class="entry-item__note">' + ICON_NOTE + escapeHtml(entry.note) + "</div>" : "";
      var payLine = c ? fmtMoney(c.totalPay) : "-";
      var hoursLine = c
        ? (tr("ปกติ ") + fmtHours(c.normalHours) + tr(" ชม. (") + fmtMoney(c.normalPay) + ")" +
           (c.otHours > 0 ? ' · <span class="ot-val">OT ' + fmtHours(c.otHours) + tr(" ชม. (") + fmtMoney(c.otPay) + ")</span>" : ""))
        : tr("ข้อมูลผิดพลาด");
      return (
        '<div class="entry-item" data-id="' + entry.id + '">' +
          '<div class="entry-item__main">' +
            '<div class="entry-item__date">' + dateLabel + "</div>" +
            '<div class="entry-item__time">' + entry.timeIn + " - " + entry.timeOut + "</div>" +
            noteHtml +
          "</div>" +
          '<div class="entry-item__hours"><b>' + payLine + "</b><br/>" + hoursLine + "</div>" +
          '<div class="entry-item__actions">' +
            tr('<button class="icon-btn icon-btn--tonal" data-action="edit" aria-label="แก้ไข"><span class="icon-tonal icon-tonal--sm icon-tonal--secondary"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="แก้ไข"><path d="M4 20l1-4L16 5l3 3L8 19l-4 1z"/><line x1="13.5" y1="6.5" x2="17.5" y2="10.5"/></svg></span></button>') +
            tr('<button class="icon-btn icon-btn--tonal" data-action="delete" aria-label="ลบ"><span class="icon-tonal icon-tonal--sm icon-tonal--danger"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="ลบ"><line x1="4" y1="7" x2="20" y2="7"/><path d="M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13"/><path d="M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></span></button>') +
          "</div>" +
        "</div>"
      );
    }).join("");
  }

  function escapeHtml(s) {
    var div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  // escapeHtml() alone doesn't escape quote characters, which matters when
  // the result is interpolated into an HTML attribute (e.g. title="...")
  // rather than element text content.
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  els.entryList.addEventListener("click", function (e) {
    var btn = e.target.closest(".icon-btn");
    if (!btn) return;
    var item = e.target.closest(".entry-item");
    var id = item.dataset.id;
    var entry = state.entries.find(function (x) { return x.id === id; });
    if (!entry) return;

    if (btn.dataset.action === "edit") {
      Array.prototype.forEach.call(els.tabbar.children, function (b) {
        if (b.dataset.view === "entry") b.click();
      });
      fillFormFromEntry(entry);
    } else if (btn.dataset.action === "delete") {
      showConfirm(tr("ลบรายการวันที่ ") + dfShort.format(fromISODate(entry.date)) + tr(" ใช่หรือไม่?")).then(function (ok) {
        if (!ok) return;
        state.entries = state.entries.filter(function (x) { return x.id !== id; });
        tombstone(state.deletedEntries, id);
        saveState();
        renderEntryList();
        showToast(tr("ลบรายการแล้ว"));
        if (editingId === id) resetForm();
      });
    }
  });

  /* ============================================================
   * Work notes (บันทึกเหตุการณ์ล่วงหน้า) — entirely separate from the OT
   * entries above: own state array, own form, own list, synced to its own
   * Supabase table (work_notes). Only touches the shared calendar-box (via
   * calendarTarget, above) and browser Notification permission (see
   * checkUpcomingNoteNotifications near the Push section below).
   * ========================================================== */
  var editingNoteId = null;

  // Shows/hides the reminder date+time row to match the toggle. Uses the
  // .hidden class (display:none !important) rather than the hidden attribute,
  // which .field-row's display:grid would otherwise override.
  function setNoteReminderVisible(show) {
    els.noteRemindFields.classList.toggle("hidden", !show);
  }

  function resetNoteForm() {
    editingNoteId = null;
    noteFormTouched = false;
    els.noteForm.reset();
    els.nStartDate.value = "";
    els.nEndDate.value = "";
    els.nRemindDate.value = "";
    els.nRemindTime.value = "";
    els.nRemindEnabled.checked = false;
    setNoteReminderVisible(false);
    updateDateTriggerTextGeneric(els.nStartDate, els.noteStartTriggerText, els.noteStartTrigger);
    updateDateTriggerTextGeneric(els.nEndDate, els.noteEndTriggerText, els.noteEndTrigger);
    updateDateTriggerTextGeneric(els.nRemindDate, els.noteRemindTriggerText, els.noteRemindTrigger);
    els.noteFormTitle.textContent = tr("บันทึกเหตุการณ์ล่วงหน้า");
    els.saveNoteBtn.textContent = tr("บันทึก");
    els.cancelEditNoteBtn.classList.add("hidden");
  }

  function fillNoteFormFromNote(note) {
    editingNoteId = note.id;
    els.nTitle.value = note.title;
    els.nDescription.value = note.description || "";
    els.nStartDate.value = note.startDate;
    els.nEndDate.value = note.endDate;
    els.nRemindEnabled.checked = !!note.reminderEnabled;
    els.nRemindDate.value = note.reminderDate || "";
    els.nRemindTime.value = note.reminderTime || "";
    setNoteReminderVisible(!!note.reminderEnabled);
    updateDateTriggerTextGeneric(els.nStartDate, els.noteStartTriggerText, els.noteStartTrigger);
    updateDateTriggerTextGeneric(els.nEndDate, els.noteEndTriggerText, els.noteEndTrigger);
    updateDateTriggerTextGeneric(els.nRemindDate, els.noteRemindTriggerText, els.noteRemindTrigger);
    els.noteFormTitle.textContent = tr("แก้ไขบันทึกเหตุการณ์");
    els.saveNoteBtn.textContent = tr("บันทึกการแก้ไข");
    els.cancelEditNoteBtn.classList.remove("hidden");
    els.noteForm.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Turning the reminder on pre-fills sensible defaults (the event's start
  // date, or today, at 08:00) so the user usually only has to tweak, not
  // enter from scratch.
  els.nRemindEnabled.addEventListener("change", function () {
    var show = els.nRemindEnabled.checked;
    setNoteReminderVisible(show);
    if (show) {
      if (!els.nRemindDate.value) {
        els.nRemindDate.value = els.nStartDate.value || toISODate(new Date());
        updateDateTriggerTextGeneric(els.nRemindDate, els.noteRemindTriggerText, els.noteRemindTrigger);
      }
      if (!els.nRemindTime.value) els.nRemindTime.value = "08:00";
    }
  });

  ["input", "change"].forEach(function (evt) {
    els.noteForm.addEventListener(evt, function () { noteFormTouched = true; });
  });

  els.noteForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!requireSignIn()) return;
    var title = els.nTitle.value.trim();
    var startDate = els.nStartDate.value;
    // Single-day note when no end date was picked: start === end, per spec.
    var endDate = els.nEndDate.value || startDate;
    if (!title || !startDate) {
      showToast(tr("กรุณากรอกหัวข้อและวันที่เริ่ม"));
      return;
    }
    if (endDate < startDate) {
      showToast(tr("วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่ม"));
      return;
    }

    var remindEnabled = els.nRemindEnabled.checked;
    var remindDate = remindEnabled ? els.nRemindDate.value : "";
    var remindTime = remindEnabled ? els.nRemindTime.value : "";
    if (remindEnabled && (!remindDate || !remindTime)) {
      showToast(tr("กรุณาเลือกวันและเวลาแจ้งเตือน"));
      return;
    }

    var draft = {
      title: title,
      description: els.nDescription.value.trim(),
      startDate: startDate,
      endDate: endDate,
      reminderEnabled: remindEnabled,
      reminderDate: remindDate,
      reminderTime: remindTime
    };
    if (editingNoteId) {
      var idx = state.workNotes.findIndex(function (x) { return x.id === editingNoteId; });
      if (idx !== -1) {
        var prev = state.workNotes[idx];
        // Only re-arm the (server-side) "sent" flag when the schedule actually
        // changed - editing just the title shouldn't make a past reminder fire
        // again, but rescheduling to a new day/time should.
        var rescheduled = !prev.reminderEnabled !== !remindEnabled ||
          prev.reminderDate !== remindDate || prev.reminderTime !== remindTime;
        draft.reminderSent = rescheduled ? false : !!prev.reminderSent;
        state.workNotes[idx] = Object.assign({ id: editingNoteId, updatedAt: nowISO() }, draft);
      }
      showToast(tr("แก้ไขบันทึกแล้ว ✓"));
    } else {
      draft.id = uid();
      draft.reminderSent = false;
      draft.updatedAt = nowISO();
      state.workNotes.push(draft);
      showToast(tr("บันทึกแล้ว ✓"));
    }
    saveState();
    resetNoteForm();
    renderNoteList();
  });

  els.cancelEditNoteBtn.addEventListener("click", resetNoteForm);

  function noteDateRangeLabel(note) {
    return note.startDate === note.endDate
      ? dfFull.format(fromISODate(note.startDate))
      : dfShort.format(fromISODate(note.startDate)) + " – " + dfFull.format(fromISODate(note.endDate));
  }

  function renderNoteList() {
    var sorted = state.workNotes.slice().sort(function (a, b) {
      return a.startDate < b.startDate ? -1 : (a.startDate > b.startDate ? 1 : 0);
    });

    els.noteCount.textContent = sorted.length ? sorted.length + tr(" รายการ") : "";

    if (!sorted.length) {
      els.noteList.innerHTML = tr('<div class="empty-state">ยังไม่มีบันทึกเหตุการณ์ เพิ่มรายการแรกได้เลย ✨</div>');
      return;
    }

    els.noteList.innerHTML = sorted.map(function (note) {
      var descHtml = note.description ? '<div class="entry-item__note">' + ICON_NOTE + escapeHtml(note.description) + "</div>" : "";
      var remindHtml = (note.reminderEnabled && note.reminderDate && note.reminderTime)
        ? '<div class="entry-item__note">' + ICON_BELL + tr("แจ้งเตือน ") +
            dfShort.format(fromISODate(note.reminderDate)) + " " + escapeHtml(note.reminderTime) + tr(" น.") + "</div>"
        : "";
      return (
        '<div class="entry-item" data-id="' + note.id + '">' +
          '<div class="entry-item__main">' +
            '<div class="entry-item__date">' + escapeHtml(note.title) + "</div>" +
            '<div class="entry-item__time">' + noteDateRangeLabel(note) + "</div>" +
            descHtml +
            remindHtml +
          "</div>" +
          '<div class="entry-item__actions">' +
            tr('<button class="icon-btn icon-btn--tonal" data-action="edit" aria-label="แก้ไข"><span class="icon-tonal icon-tonal--sm icon-tonal--secondary"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="แก้ไข"><path d="M4 20l1-4L16 5l3 3L8 19l-4 1z"/><line x1="13.5" y1="6.5" x2="17.5" y2="10.5"/></svg></span></button>') +
            tr('<button class="icon-btn icon-btn--tonal" data-action="delete" aria-label="ลบ"><span class="icon-tonal icon-tonal--sm icon-tonal--danger"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="ลบ"><line x1="4" y1="7" x2="20" y2="7"/><path d="M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13"/><path d="M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></span></button>') +
          "</div>" +
        "</div>"
      );
    }).join("");
  }

  els.noteList.addEventListener("click", function (e) {
    var btn = e.target.closest(".icon-btn");
    if (!btn) return;
    var item = e.target.closest(".entry-item");
    var id = item.dataset.id;
    var note = state.workNotes.find(function (x) { return x.id === id; });
    if (!note) return;

    if (btn.dataset.action === "edit") {
      fillNoteFormFromNote(note);
    } else if (btn.dataset.action === "delete") {
      showConfirm(tr('ลบบันทึก "') + note.title + tr('" ใช่หรือไม่?')).then(function (ok) {
        if (!ok) return;
        state.workNotes = state.workNotes.filter(function (x) { return x.id !== id; });
        tombstone(state.deletedNotes, id);
        saveState();
        renderNoteList();
        showToast(tr("ลบรายการแล้ว"));
        if (editingNoteId === id) resetNoteForm();
      });
    }
  });

  /* ============================================================
   * Summary
   * ========================================================== */
  var summaryState = { mode: "month", anchor: new Date() };
  var exportMonthRange = null; // { start, end } Date objects for the currently viewed period, set by renderMonthSummary/renderYearSummary
  var exportRangeMode = "month"; // "month" | "custom" - which option is selected inside the export modal

  els.summaryModeTabs.addEventListener("click", function (e) {
    var btn = e.target.closest(".segmented__btn");
    if (!btn) return;
    summaryState.mode = btn.dataset.mode;
    Array.prototype.forEach.call(els.summaryModeTabs.children, function (b) {
      b.classList.toggle("is-active", b === btn);
    });
    renderSummary();
  });

  els.periodPrev.addEventListener("click", function () { shiftPeriod(-1); });
  els.periodNext.addEventListener("click", function () { shiftPeriod(1); });

  // Export modal: choose the quick range (defaults to whatever period is
  // currently viewed in Summary, via exportMonthRange - a month or a full
  // year) or a custom date range, then build the .xlsx on confirm.
  function openExportModal() {
    if (!exportMonthRange) return;
    exportRangeMode = "month";
    var quickRangeBtn = els.exportRangeTabs.querySelector('[data-range="month"]');
    if (quickRangeBtn) quickRangeBtn.textContent = summaryState.mode === "year" ? tr("ปีนี้") : tr("เดือนนี้");
    Array.prototype.forEach.call(els.exportRangeTabs.children, function (b) {
      b.classList.toggle("is-active", b.dataset.range === "month");
    });
    els.exportCustomRange.classList.add("hidden");
    els.exportRangeError.classList.add("hidden");
    els.exportRangeStart.value = toISODate(exportMonthRange.start);
    els.exportRangeEnd.value = toISODate(exportMonthRange.end);
    els.exportOverlay.classList.remove("hidden");
  }

  function closeExportModal() {
    els.exportOverlay.classList.add("hidden");
  }

  els.exportExcelBtn.addEventListener("click", openExportModal);
  els.exportCancelBtn.addEventListener("click", closeExportModal);
  els.exportOverlay.addEventListener("click", function (e) {
    if (e.target === els.exportOverlay) closeExportModal();
  });

  els.exportRangeTabs.addEventListener("click", function (e) {
    var btn = e.target.closest(".segmented__btn");
    if (!btn) return;
    exportRangeMode = btn.dataset.range;
    Array.prototype.forEach.call(els.exportRangeTabs.children, function (b) {
      b.classList.toggle("is-active", b === btn);
    });
    els.exportCustomRange.classList.toggle("hidden", exportRangeMode !== "custom");
    els.exportRangeError.classList.add("hidden");
  });

  els.exportConfirmBtn.addEventListener("click", function () {
    if (typeof XLSX === "undefined") {
      showToast(tr("โหลดไลบรารี Excel ไม่สำเร็จ ลองเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่"));
      return;
    }

    var startISO, endISO, filenameStamp;

    if (exportRangeMode === "custom") {
      startISO = els.exportRangeStart.value;
      endISO = els.exportRangeEnd.value;
      if (!startISO || !endISO || startISO > endISO) {
        els.exportRangeError.classList.remove("hidden");
        return;
      }
    } else {
      if (!exportMonthRange) return;
      startISO = toISODate(exportMonthRange.start);
      endISO = toISODate(exportMonthRange.end);
    }
    var startStamp = startISO.slice(0, 7);
    var endStamp = endISO.slice(0, 7);
    filenameStamp = startStamp === endStamp ? startStamp : (startStamp + "-to-" + endStamp);
    els.exportRangeError.classList.add("hidden");

    var entries = entriesBetween(startISO, endISO)
      .slice()
      .sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });

    if (!entries.length) {
      showToast(tr("ไม่มีข้อมูลในช่วงวันที่ที่เลือก"));
      return;
    }

    var rows = entries.map(function (e) {
      var c = computeEntry(e, state.settings);
      return {
        [tr("วันที่")]: e.date,
        [tr("เวลาเข้า")]: e.timeIn || "",
        [tr("เวลาออก")]: e.timeOut || "",
        [tr("ชั่วโมงปกติ")]: c ? Math.round(c.normalHours * 100) / 100 : 0,
        [tr("ชั่วโมง OT")]: c ? Math.round(c.otHours * 100) / 100 : 0,
        [tr("เงิน OT")]: c ? Math.round(c.otPay * 100) / 100 : 0
      };
    });

    // Sheet 1: รายละเอียดรายวัน (ของเดิม)
    var wsDetail = XLSX.utils.json_to_sheet(rows);

    // Sheet 2: สรุปช่วงที่ export
    var rangeAgg = aggregate(entries, state.settings);
    var summaryRows = [
      { [tr("รายการ")]: tr("ช่วงที่ export"), [tr("ค่า")]: startISO + tr(" ถึง ") + endISO },
      { [tr("รายการ")]: tr("จำนวนวันที่บันทึก"), [tr("ค่า")]: rangeAgg.count },
      { [tr("รายการ")]: tr("ชั่วโมงทำงานปกติ"), [tr("ค่า")]: Math.round(rangeAgg.normalHours * 100) / 100 },
      { [tr("รายการ")]: tr("ชั่วโมง OT รวม"), [tr("ค่า")]: Math.round(rangeAgg.otHours * 100) / 100 },
      { [tr("รายการ")]: tr("  - OT วันธรรมดา"), [tr("ค่า")]: Math.round(rangeAgg.otHoursWeekday * 100) / 100 },
      { [tr("รายการ")]: tr("  - OT วันหยุด"), [tr("ค่า")]: Math.round(rangeAgg.otHoursWeekend * 100) / 100 },
      { [tr("รายการ")]: tr("เงิน OT รวม"), [tr("ค่า")]: Math.round(rangeAgg.otPay * 100) / 100 },
      { [tr("รายการ")]: tr("รายได้รวม (ปกติ+OT)"), [tr("ค่า")]: Math.round(rangeAgg.totalPay * 100) / 100 }
    ];
    var wsSummary = XLSX.utils.json_to_sheet(summaryRows);
    wsSummary["!cols"] = [{ wch: 24 }, { wch: 20 }];

    // Sheet 3: เปรียบเทียบ 12 เดือนล่าสุด (นับถอยจากเดือนสุดท้ายที่ export)
    var endDate = new Date(endISO);
    var trendMonths = [];
    for (var i = 11; i >= 0; i--) {
      var d = new Date(endDate.getFullYear(), endDate.getMonth() - i, 1);
      var agg = monthAgg(d.getFullYear(), d.getMonth());
      trendMonths.push({
        d: d,
        normalHours: Math.round(agg.normalHours * 100) / 100,
        otHours: Math.round(agg.otHours * 100) / 100,
        otPay: Math.round(agg.otPay * 100) / 100,
        totalPay: Math.round(agg.totalPay * 100) / 100
      });
    }
    var maxOt = Math.max.apply(null, trendMonths.map(function (m) { return m.otHours; }).concat([1]));
    var BAR_WIDTH = 20;
    var compareRows = trendMonths.map(function (m) {
      var barLen = Math.round((m.otHours / maxOt) * BAR_WIDTH);
      return {
        [tr("เดือน")]: dfMonthYear.format(m.d),
        [tr("ชั่วโมงปกติ")]: m.normalHours,
        [tr("ชั่วโมง OT")]: m.otHours,
        [tr("เงิน OT")]: m.otPay,
        [tr("รายได้รวม")]: m.totalPay,
        [tr("กราฟ OT")]: "█".repeat(barLen) + " " + m.otHours + tr(" ชม.")
      };
    });
    var totals = trendMonths.reduce(function (acc, m) {
      acc.normalHours += m.normalHours;
      acc.otHours += m.otHours;
      acc.otPay += m.otPay;
      acc.totalPay += m.totalPay;
      return acc;
    }, { normalHours: 0, otHours: 0, otPay: 0, totalPay: 0 });
    compareRows.push({
      [tr("เดือน")]: tr("รวม 12 เดือน"),
      [tr("ชั่วโมงปกติ")]: Math.round(totals.normalHours * 100) / 100,
      [tr("ชั่วโมง OT")]: Math.round(totals.otHours * 100) / 100,
      [tr("เงิน OT")]: Math.round(totals.otPay * 100) / 100,
      [tr("รายได้รวม")]: Math.round(totals.totalPay * 100) / 100,
      [tr("กราฟ OT")]: ""
    });
    var wsCompare = XLSX.utils.json_to_sheet(compareRows);
    wsCompare["!cols"] = [{ wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 28 }];

    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsSummary, I18N.sheetName("สรุป"));
    XLSX.utils.book_append_sheet(wb, wsCompare, I18N.sheetName("เปรียบเทียบ 12 เดือน"));
    XLSX.utils.book_append_sheet(wb, wsDetail, I18N.sheetName("รายละเอียด"));
    XLSX.writeFile(wb, "ot-tracker-" + filenameStamp + ".xlsx");
    showToast(tr("Export Excel แล้ว ✓"));
    closeExportModal();
  });

  function shiftPeriod(dir) {
    if (summaryState.mode === "year") {
      summaryState.anchor = new Date(summaryState.anchor.getFullYear() + dir, summaryState.anchor.getMonth(), 1);
    } else {
      summaryState.anchor = addMonths(summaryState.anchor, dir);
    }
    renderSummary();
  }

  function getPeriodRange() {
    var a = summaryState.anchor;
    if (summaryState.mode === "year") {
      return { start: new Date(a.getFullYear(), 0, 1), end: new Date(a.getFullYear(), 11, 31) };
    }
    var first = new Date(a.getFullYear(), a.getMonth(), 1);
    var last = new Date(a.getFullYear(), a.getMonth() + 1, 0);
    return { start: first, end: last };
  }

  function periodLabelText(range) {
    return summaryState.mode === "year" ? dfYear.format(range.start) : dfMonthYear.format(range.start);
  }

  function entriesBetween(startISO, endISO) {
    return state.entries.filter(function (e) { return e.date >= startISO && e.date <= endISO; });
  }

  function monthAgg(year, month) {
    var first = new Date(year, month, 1);
    var last = new Date(year, month + 1, 0);
    return aggregate(entriesBetween(toISODate(first), toISODate(last)), state.settings);
  }

  function yearAgg(year) {
    return aggregate(entriesBetween(toISODate(new Date(year, 0, 1)), toISODate(new Date(year, 11, 31))), state.settings);
  }

  // Renders a "↑ +25% จากเดือนก่อน" style comparison badge. Handles the
  // no-prior-data case explicitly so a 0 -> N jump doesn't show as "+Infinity%".
  function changeBadgeHtml(current, previous, suffixLabel) {
    if (!previous) {
      if (!current) return tr('<span class="badge-change badge-change--flat">— ไม่มีข้อมูล') + suffixLabel + "</span>";
      return tr('<span class="badge-change badge-change--new">✨ ใหม่</span> ไม่มีข้อมูล') + suffixLabel;
    }
    var pct = Math.round(((current - previous) / previous) * 100);
    var dir = pct > 0 ? "up" : (pct < 0 ? "down" : "flat");
    var arrow = dir === "up" ? "↑" : (dir === "down" ? "↓" : "→");
    var sign = pct > 0 ? "+" : "";
    return '<span class="badge-change badge-change--' + dir + '">' + arrow + " " + sign + pct + "%</span> " + suffixLabel;
  }

  function fillStatTiles(agg) {
    els.statNormalHours.textContent = fmtHours(agg.normalHours);
    els.statNormalPay.textContent = fmtMoney(agg.normalPay);
    els.statOtHours.textContent = fmtHours(agg.otHours);
    els.statOtPay.textContent = fmtMoney(agg.otPay);
    els.statTotalPay.textContent = fmtMoney(agg.totalPay);
    els.statTotalHours.textContent = fmtHours(agg.totalHours) + tr(" ชม.");
    els.otWeekdayVal.textContent = fmtHours(agg.otHoursWeekday) + tr(" ชม. · ") + fmtMoney(agg.otPayWeekday);
    els.otWeekendVal.textContent = fmtHours(agg.otHoursWeekend) + tr(" ชม. · ") + fmtMoney(agg.otPayWeekend);
  }

  function updateSummaryRecorderLine() {
    var name = (state.settings.recorderName || "").trim();
    els.summaryRecorderLine.textContent = name ? tr("บันทึกโดย ") + name : "";
  }

  function renderSummary() {
    if (summaryState.mode === "year") renderYearSummary();
    else renderMonthSummary();
  }

  function renderMonthSummary() {
    var a = summaryState.anchor;
    var range = getPeriodRange();
    els.periodLabel.textContent = periodLabelText(range);
    updateSummaryRecorderLine();
    els.exportExcelBtn.classList.remove("hidden");
    els.exportHint.textContent = tr("ดาวน์โหลดรายการบันทึกเวลาของเดือนนี้เป็นไฟล์ Excel");
    exportMonthRange = range;

    var agg = monthAgg(a.getFullYear(), a.getMonth());
    var prev = addMonths(a, -1);
    var prevAgg = monthAgg(prev.getFullYear(), prev.getMonth());

    fillStatTiles(agg);
    els.compareTotalPay.innerHTML = changeBadgeHtml(agg.totalPay, prevAgg.totalPay, tr("จากเดือนก่อน"));
    els.compareOtHours.innerHTML = changeBadgeHtml(agg.otHours, prevAgg.otHours, tr("จากเดือนก่อน"));
    els.compareOtPay.innerHTML = changeBadgeHtml(agg.otPay, prevAgg.otPay, tr("จากเดือนก่อน"));

    els.chartTitle.textContent = tr("แนวโน้ม OT ย้อนหลัง 6 เดือน");
    els.dayListTitle.textContent = tr("รายวันในเดือนนี้");

    renderSalaryBreakdown(agg, true);
    renderGoalProgress(agg, true);
    renderSummaryDays(entriesBetween(toISODate(range.start), toISODate(range.end)));
    renderTrendChart(computeMonthlyOtTrend(a));
  }

  function renderYearSummary() {
    var year = summaryState.anchor.getFullYear();
    var range = getPeriodRange();
    els.periodLabel.textContent = periodLabelText(range);
    updateSummaryRecorderLine();
    els.exportExcelBtn.classList.remove("hidden");
    els.exportHint.textContent = tr("ดาวน์โหลดรายการบันทึกเวลาของปีนี้เป็นไฟล์ Excel");
    exportMonthRange = range;

    var agg = yearAgg(year);
    var prevAgg = yearAgg(year - 1);

    fillStatTiles(agg);
    els.compareTotalPay.innerHTML = changeBadgeHtml(agg.totalPay, prevAgg.totalPay, tr("จากปีก่อน"));
    els.compareOtHours.innerHTML = changeBadgeHtml(agg.otHours, prevAgg.otHours, tr("จากปีก่อน"));
    els.compareOtPay.innerHTML = changeBadgeHtml(agg.otPay, prevAgg.otPay, tr("จากปีก่อน"));

    els.chartTitle.textContent = tr("OT รายเดือนของปีนี้");
    els.dayListTitle.textContent = tr("สรุปรายเดือนในปีนี้");

    renderSalaryBreakdown(agg, false);
    renderGoalProgress(agg, false);
    renderSummaryMonths(year);
    renderTrendChart(computeYearlyMonthlyBreakdown(year));
  }

  /* ============================================================
   * OT bar chart — shared by the month view's 6-month trend and the
   * year view's 12-month breakdown
   * ========================================================== */
  function otColorForHours(hours) {
    if (hours >= 30) return "var(--status-critical)";
    if (hours >= 10) return "var(--status-warning)";
    return "var(--status-good)";
  }

  function computeMonthlyOtTrend(anchorDate) {
    var months = [];
    for (var i = 5; i >= 0; i--) {
      var d = new Date(anchorDate.getFullYear(), anchorDate.getMonth() - i, 1);
      var agg = monthAgg(d.getFullYear(), d.getMonth());
      months.push({
        label: dfMonthShort.format(d),
        fullLabel: dfMonthYear.format(d),
        isCurrent: i === 0,
        otHours: agg.otHours,
        otPay: agg.otPay
      });
    }
    return months;
  }

  function computeYearlyMonthlyBreakdown(year) {
    var now = new Date();
    var months = [];
    for (var m = 0; m < 12; m++) {
      var d = new Date(year, m, 1);
      var agg = monthAgg(year, m);
      months.push({
        label: dfMonthShort.format(d),
        fullLabel: dfMonthYear.format(d),
        isCurrent: year === now.getFullYear() && m === now.getMonth(),
        otHours: agg.otHours,
        otPay: agg.otPay
      });
    }
    return months;
  }

  function renderTrendChart(months) {
    var scaleMax = Math.max.apply(null, months.map(function (m) { return m.otHours; }).concat([10]));

    els.trendChart.innerHTML = months.map(function (m, idx) {
      var pct = scaleMax ? Math.max((m.otHours / scaleMax) * 100, m.otHours > 0 ? 4 : 2) : 2;
      var color = otColorForHours(m.otHours);
      return (
        '<div class="trend-col' + (m.isCurrent ? " is-current" : "") + '">' +
          '<div class="trend-col__value">' + (m.otHours > 0 ? fmtHours(m.otHours) : "") + "</div>" +
          '<div class="trend-col__bar-wrap">' +
            '<div class="trend-col__bar" data-idx="' + idx + '" tabindex="0" role="button" ' +
              'aria-label="' + m.fullLabel + " OT " + fmtHours(m.otHours) + tr(' ชั่วโมง" ') +
              'style="height:' + pct.toFixed(1) + '%; --bar-color:' + color + '; animation-delay:' + (idx * 45) + 'ms;"></div>' +
          "</div>" +
          '<div class="trend-col__label' + (m.isCurrent ? " is-current" : "") + '">' + m.label + "</div>" +
        "</div>"
      );
    }).join("");

    function showDetail(idx) {
      var m = months[idx];
      Array.prototype.forEach.call(els.trendChart.querySelectorAll(".trend-col__bar"), function (b, i) {
        b.classList.toggle("is-active", i === idx);
      });
      els.trendTooltip.innerHTML = "<strong>" + m.fullLabel + "</strong> — OT " +
        fmtHours(m.otHours) + tr(" ชม. · ") + fmtMoney(m.otPay);
    }

    var bars = els.trendChart.querySelectorAll(".trend-col__bar");
    Array.prototype.forEach.call(bars, function (bar) {
      var idx = Number(bar.dataset.idx);
      bar.addEventListener("mouseenter", function () { showDetail(idx); });
      bar.addEventListener("focus", function () { showDetail(idx); });
      bar.addEventListener("click", function () { showDetail(idx); });
    });

    // default: show the current month's figures (falling back to the last bar
    // if none of them is "current", e.g. a past year with no matching month)
    var defaultIdx = months.length - 1;
    for (var di = 0; di < months.length; di++) {
      if (months[di].isCurrent) { defaultIdx = di; break; }
    }
    showDetail(defaultIdx);
  }

  function renderSalaryBreakdown(agg, showCard) {
    els.salaryBreakdownCard.classList.toggle("hidden", !showCard);
    if (!showCard) return;

    var salary = state.settings.monthlySalary || 0;
    var otPay = agg.otPay;
    var total = salary + otPay;

    els.sbSalary.textContent = fmtMoney(salary);
    els.sbOtPay.textContent = fmtMoney(otPay);
    els.sbTotal.textContent = fmtMoney(total);
  }

  // Progress bar for the "เป้าหมายเงิน OT ต่อเดือน" setting - only makes
  // sense against a single month's OT pay, so it's hidden entirely in year
  // mode (showCard=false) or whenever no goal has been set (otGoal <= 0).
  function renderGoalProgress(agg, showCard) {
    var goal = state.settings.otGoal || 0;
    var visible = showCard && goal > 0;
    els.goalProgressCard.classList.toggle("hidden", !visible);
    if (!visible) return;

    var pct = Math.min(100, Math.round((agg.otPay / goal) * 100));
    els.goalProgressValue.textContent = fmtMoney(agg.otPay) + " / " + fmtMoney(goal);
    els.goalProgressPct.textContent = pct + "%";
    els.goalProgressFill.style.width = pct + "%";
    els.goalProgressFill.classList.toggle("is-complete", agg.otPay >= goal);
  }

  function summaryRowHtml(label, agg, maxHours) {
    maxHours = maxHours || 1;
    return (
      '<div class="summary-day">' +
        '<div class="summary-day__top">' +
          '<span class="summary-day__date">' + label + "</span>" +
          '<span class="summary-day__pay">' + fmtMoney(agg.totalPay) + "</span>" +
        "</div>" +
        '<div class="summary-day__bar">' +
          '<div class="summary-day__bar-normal" style="width:' + ((agg.normalHours / maxHours) * 100).toFixed(1) + '%"></div>' +
          (agg.otHours > 0 ? '<div class="summary-day__bar-ot" style="width:' + ((agg.otHours / maxHours) * 100).toFixed(1) + '%"></div>' : "") +
        "</div>" +
        '<div class="summary-day__meta">' +
          tr("<span>ปกติ ") + fmtHours(agg.normalHours) + tr(" ชม.</span>") +
          "<span>" + (agg.otHours > 0 ? "OT " + fmtHours(agg.otHours) + tr(" ชม.") : "") + "</span>" +
        "</div>" +
      "</div>"
    );
  }

  function renderSummaryDays(entriesInRange) {
    if (!entriesInRange.length) {
      els.summaryDays.innerHTML = tr('<div class="empty-state">ไม่มีข้อมูลในช่วงนี้</div>');
      return;
    }

    var byDate = {};
    entriesInRange.forEach(function (e) {
      (byDate[e.date] = byDate[e.date] || []).push(e);
    });

    var dates = Object.keys(byDate).sort(); // ascending
    var dayAggs = dates.map(function (d) {
      return { date: d, agg: aggregate(byDate[d], state.settings) };
    });

    var maxHours = Math.max.apply(null, dayAggs.map(function (x) { return x.agg.totalHours; }).concat([scheduleNormalHoursPerDay(state.settings) || 8]));

    els.summaryDays.innerHTML = dayAggs.map(function (x) {
      return summaryRowHtml(dfFull.format(fromISODate(x.date)), x.agg, maxHours);
    }).join("");
  }

  function renderSummaryMonths(year) {
    var monthsWithData = [];
    for (var m = 0; m < 12; m++) {
      var agg = monthAgg(year, m);
      if (agg.count > 0) monthsWithData.push({ month: m, agg: agg });
    }
    if (!monthsWithData.length) {
      els.summaryDays.innerHTML = tr('<div class="empty-state">ไม่มีข้อมูลในปีนี้</div>');
      return;
    }

    var maxHours = Math.max.apply(null, monthsWithData.map(function (x) { return x.agg.totalHours; }).concat([1]));

    els.summaryDays.innerHTML = monthsWithData.map(function (x) {
      var label = dfMonthYear.format(new Date(year, x.month, 1));
      return summaryRowHtml(label, x.agg, maxHours);
    }).join("");
  }

  /* ============================================================
   * Settings
   * ========================================================== */
  function loadSettingsToForm() {
    var s = state.settings;
    if (I18N.supported(s.language)) I18N.set(s.language, "account");
    var cur = currentCurrency();
    els.sRecorderName.value = s.recorderName || "";
    els.sDefaultTimeIn.value = s.defaultTimeIn || "";
    els.sDefaultTimeOut.value = s.defaultTimeOut || "";
    els.sLockTimeIn.checked = !!s.lockTimeIn;
    els.sLockTimeOut.checked = !!s.lockTimeOut;
    els.sLockTimeOutWeekend.checked = !!s.lockTimeOutWeekend;
    updateLockToggleAvailability();
    updateCurrencyTrigger();
    els.hourlyRateLabel.textContent = tr("ค่าแรงต่อชั่วโมง (") + cur.symbol + " " + cur.label + tr(") — ใช้คำนวณ OT เท่านั้น");
    els.monthlySalaryLabel.textContent = tr("เงินเดือน (") + cur.symbol + " " + cur.label + ")";
    els.otGoalLabel.textContent = tr("เป้าหมายเงิน OT ต่อเดือน (") + cur.symbol + " " + cur.label + ")";
    setMoneyInputValue(els.sHourlyRate, s.hourlyRate);
    setMoneyInputValue(els.sMonthlySalary, s.monthlySalary);
    setMoneyInputValue(els.sOtGoal, s.otGoal);
    els.sWorkStart.value = s.workStart;
    els.sHasLunchBreak.checked = !!s.hasLunchBreak;
    els.sLunchStart.value = s.lunchStart;
    els.sLunchEnd.value = s.lunchEnd;
    els.sNormalEnd.value = s.normalEnd;
    els.sNotifyLateOut.checked = !!s.notifyEnabled;
    els.sNotifyTime.value = s.notifyTime || "";
    updateNotifyTimeVisible();
    els.sHasMandatoryOt.checked = !!s.hasMandatoryOt;
    els.sMandatoryOtEnd.value = s.mandatoryOtEnd;
    els.sHasEveningBreak.checked = !!s.hasEveningBreak;
    els.sEveningBreakStart.value = s.eveningBreakStart;
    els.sEveningBreakEnd.value = s.eveningBreakEnd;
    els.sOtMultiplier.value = s.otMultiplier;
    els.sWeekendOtMultiplier.value = s.weekendOtMultiplier;
    updatePresetButtons();
    updateScheduleToggleAvailability();
  }

  // Dims and disables the time inputs for whichever schedule window is
  // switched off, so it's visually clear they're not in effect right now
  // (the underlying values are preserved in case the user re-enables it).
  function updateScheduleToggleAvailability() {
    var s = state.settings;
    els.sLunchStart.disabled = els.sLunchEnd.disabled = !s.hasLunchBreak;
    els.sMandatoryOtEnd.disabled = !s.hasMandatoryOt;
    els.sEveningBreakStart.disabled = els.sEveningBreakEnd.disabled = !s.hasEveningBreak;
  }

  function updatePresetButtons() {
    var vWeekday = String(state.settings.otMultiplier);
    var vWeekend = String(state.settings.weekendOtMultiplier);
    Array.prototype.forEach.call(document.querySelectorAll(".preset-btn"), function (b) {
      var v = b.dataset.target === "weekend" ? vWeekend : vWeekday;
      b.classList.toggle("is-active", b.dataset.preset === v);
    });
  }

  // Currency picker: a native <select> can't render the flag SVGs inside its
  // options, so this reuses the app's existing "trigger button opens an
  // overlay" pattern (same as the date picker) instead.
  function updateCurrencyTrigger() {
    var code = state.settings.currency;
    var options = els.currencyList.querySelectorAll(".currency-option");
    var match = els.currencyList.querySelector('.currency-option[data-currency="' + code + '"]') || options[0];
    els.currencyTriggerFlag.innerHTML = match.querySelector(".currency-flag").innerHTML;
    els.currencyTriggerLabel.textContent = match.querySelector(".currency-option__label").textContent;
    Array.prototype.forEach.call(options, function (b) {
      b.classList.toggle("is-selected", b === match);
    });
  }

  function openCurrencyPicker() {
    updateCurrencyTrigger();
    els.currencyOverlay.classList.remove("hidden");
  }
  function closeCurrencyPicker() {
    els.currencyOverlay.classList.add("hidden");
  }

  els.currencyTrigger.addEventListener("click", openCurrencyPicker);
  els.currencyClose.addEventListener("click", closeCurrencyPicker);
  els.currencyOverlay.addEventListener("click", function (e) {
    if (e.target === els.currencyOverlay) closeCurrencyPicker();
  });

  els.currencyList.addEventListener("click", function (e) {
    var btn = e.target.closest(".currency-option");
    if (!btn) return;
    state.settings.currency = btn.dataset.currency;
    persistSettings();
    loadSettingsToForm();
    renderEntryList();
    renderSummary();
    updatePreview();
    closeCurrencyPicker();
  });

  els.sRecorderName.addEventListener("input", function () {
    state.settings.recorderName = els.sRecorderName.value;
    persistSettings();
    updateHeaderTitle();
    renderSummary();
  });

  // The lock toggles only make sense once there's a value to lock to, so
  // they stay disabled (and force back off) whenever the matching default
  // time field is empty.
  function updateLockToggleAvailability() {
    var hasIn = !!state.settings.defaultTimeIn;
    var hasOut = !!state.settings.defaultTimeOut;
    els.sLockTimeIn.disabled = !hasIn;
    els.sLockTimeOut.disabled = !hasOut;
    els.lockTimeInRow.classList.toggle("is-disabled", !hasIn);
    els.lockTimeOutRow.classList.toggle("is-disabled", !hasOut);
    // the weekend sub-toggle only makes sense once clock-out is actually locked
    var canWeekend = hasOut && state.settings.lockTimeOut;
    els.sLockTimeOutWeekend.disabled = !canWeekend;
    els.lockTimeOutWeekendRow.classList.toggle("is-disabled", !canWeekend);
  }

  els.sDefaultTimeIn.addEventListener("input", function () {
    state.settings.defaultTimeIn = els.sDefaultTimeIn.value;
    if (!state.settings.defaultTimeIn) {
      state.settings.lockTimeIn = false;
      els.sLockTimeIn.checked = false;
    }
    updateLockToggleAvailability();
    persistSettings();
  });

  els.sDefaultTimeOut.addEventListener("input", function () {
    state.settings.defaultTimeOut = els.sDefaultTimeOut.value;
    if (!state.settings.defaultTimeOut) {
      state.settings.lockTimeOut = false;
      els.sLockTimeOut.checked = false;
    }
    updateLockToggleAvailability();
    persistSettings();
  });

  els.sLockTimeIn.addEventListener("change", function () {
    state.settings.lockTimeIn = els.sLockTimeIn.checked;
    persistSettings();
  });

  els.sLockTimeOut.addEventListener("change", function () {
    state.settings.lockTimeOut = els.sLockTimeOut.checked;
    updateLockToggleAvailability();
    persistSettings();
  });

  els.sLockTimeOutWeekend.addEventListener("change", function () {
    state.settings.lockTimeOutWeekend = els.sLockTimeOutWeekend.checked;
    persistSettings();
  });

  // Shared by the push toggle below and the upcoming work-note reminder.
  function notificationSupport() {
    if (typeof Notification === "undefined") return "unsupported";
    return Notification.permission; // "granted" | "denied" | "default"
  }

  /* ------------ Upcoming work-note reminder (Web Notification API) ------------
   * No separate toggle - only gated on browser Notification permission
   * (independent of notifyEnabled, which now just controls the server-side
   * late-clock-out push reminder). Checks only once per app open, not on a
   * poll - it's date-based (does a note start tomorrow?), not
   * time-of-day-based, so nothing changes between checks within a single
   * session.
   */
  var NOTE_NOTIFY_KEY = "ot-tracker-notified-notes-v1";

  // Per-device "which note ids already got a notification today" marker -
  // throwaway scheduling state, deliberately kept out of state.settings
  // and out of the Supabase sync payload.
  function getNotifiedNoteState() {
    try {
      var raw = localStorage.getItem(NOTE_NOTIFY_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      return (parsed && parsed.date && Array.isArray(parsed.ids)) ? parsed : { date: "", ids: [] };
    } catch (e) {
      return { date: "", ids: [] };
    }
  }
  function setNotifiedNoteState(s) {
    try { localStorage.setItem(NOTE_NOTIFY_KEY, JSON.stringify(s)); } catch (e) {}
  }

  // Foreground safety-net for event reminders: when the tab happens to be
  // open at/after a note's chosen reminder time (today), show a local
  // notification, once per note per day. The reliable delivery path is the
  // server-side push (send-event-reminders); this just covers the case where
  // push isn't set up on this device but the app is open.
  function checkUpcomingNoteNotifications() {
    if (notificationSupport() !== "granted") return;

    var now = new Date();
    var todayISO = toISODate(now);
    var nowMinutes = now.getHours() * 60 + now.getMinutes();
    var notified = getNotifiedNoteState();
    if (notified.date !== todayISO) notified = { date: todayISO, ids: [] };

    state.workNotes.forEach(function (note) {
      if (!note.reminderEnabled || !note.reminderDate || !note.reminderTime) return;
      if (note.reminderDate !== todayISO) return;
      if (nowMinutes < timeToMinutes(note.reminderTime)) return; // ยังไม่ถึงเวลา
      if (notified.ids.indexOf(note.id) !== -1) return;
      try {
        new Notification("OT Fast", { body: "🔔 " + note.title });
      } catch (e) {
        console.error(tr("แสดงการแจ้งเตือนไม่สำเร็จ"), e);
      }
      notified.ids.push(note.id);
    });
    setNotifiedNoteState(notified);
  }

  [
    [els.sHasLunchBreak, "hasLunchBreak"],
    [els.sHasMandatoryOt, "hasMandatoryOt"],
    [els.sHasEveningBreak, "hasEveningBreak"]
  ].forEach(function (pair) {
    var el = pair[0], key = pair[1];
    el.addEventListener("change", function () {
      state.settings[key] = el.checked;
      updateScheduleToggleAvailability();
      persistSettings();
      renderEntryList();
      renderSummary();
      updatePreview();
    });
  });

  document.querySelectorAll(".preset-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      if (b.dataset.target === "weekend") {
        els.sWeekendOtMultiplier.value = b.dataset.preset;
        state.settings.weekendOtMultiplier = Number(b.dataset.preset);
      } else {
        els.sOtMultiplier.value = b.dataset.preset;
        state.settings.otMultiplier = Number(b.dataset.preset);
      }
      persistSettings();
      updatePresetButtons();
      renderEntryList();
      renderSummary();
      updatePreview();
    });
  });

  var settingsInputs = [
    els.sHourlyRate, els.sMonthlySalary, els.sOtGoal, els.sOtMultiplier, els.sWeekendOtMultiplier,
    els.sWorkStart, els.sLunchStart, els.sLunchEnd, els.sNormalEnd,
    els.sMandatoryOtEnd, els.sEveningBreakStart, els.sEveningBreakEnd
  ];
  settingsInputs.forEach(function (input) {
    input.addEventListener("input", function () {
      state.settings.hourlyRate = parseMoneyInput(els.sHourlyRate);
      state.settings.monthlySalary = parseMoneyInput(els.sMonthlySalary);
      state.settings.otGoal = parseMoneyInput(els.sOtGoal);
      state.settings.otMultiplier = Number(els.sOtMultiplier.value) || 1;
      state.settings.weekendOtMultiplier = Number(els.sWeekendOtMultiplier.value) || 1;
      state.settings.workStart = els.sWorkStart.value || DEFAULT_STATE.settings.workStart;
      state.settings.lunchStart = els.sLunchStart.value || DEFAULT_STATE.settings.lunchStart;
      state.settings.lunchEnd = els.sLunchEnd.value || DEFAULT_STATE.settings.lunchEnd;
      state.settings.normalEnd = els.sNormalEnd.value || DEFAULT_STATE.settings.normalEnd;
      state.settings.mandatoryOtEnd = els.sMandatoryOtEnd.value || DEFAULT_STATE.settings.mandatoryOtEnd;
      state.settings.eveningBreakStart = els.sEveningBreakStart.value || DEFAULT_STATE.settings.eveningBreakStart;
      state.settings.eveningBreakEnd = els.sEveningBreakEnd.value || DEFAULT_STATE.settings.eveningBreakEnd;
      updatePresetButtons();
      persistSettings();
      renderEntryList();
      renderSummary();
      updatePreview();
    });
  });

  var saveIndicatorTimer = null;
  function persistSettings() {
    saveState();
    els.saveIndicator.classList.add("show");
    clearTimeout(saveIndicatorTimer);
    saveIndicatorTimer = setTimeout(function () { els.saveIndicator.classList.remove("show"); }, 1200);
  }

  /* ============================================================
   * Data management
   * ========================================================== */
  els.exportBtn.addEventListener("click", function () {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var stamp = toISODate(new Date());
    a.href = url;
    a.download = "ot-tracker-backup-" + stamp + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast(tr("สำรองข้อมูลแล้ว"));
  });

  els.importInput.addEventListener("change", function () {
    var file = els.importInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(reader.result);
        if (!parsed || !Array.isArray(parsed.entries)) throw new Error(tr("รูปแบบไฟล์ไม่ถูกต้อง"));
        showConfirm(tr("นำเข้าข้อมูลจะแทนที่ข้อมูลปัจจุบันทั้งหมด ดำเนินการต่อหรือไม่?")).then(function (ok) {
          if (!ok) { els.importInput.value = ""; return; }
          state.settings = Object.assign(clone(DEFAULT_STATE.settings), parsed.settings || {});
          state.entries = parsed.entries;
          state.workNotes = Array.isArray(parsed.workNotes) ? parsed.workNotes : [];
          saveState();
          loadSettingsToForm();
          updateHeaderTitle();
          renderEntryList();
          renderSummary();
          resetNoteForm();
          renderNoteList();
          showToast(tr("นำเข้าข้อมูลสำเร็จ ✓"));
          els.importInput.value = "";
        });
      } catch (err) {
        showToast(tr("ไม่สามารถอ่านไฟล์นี้ได้"));
        els.importInput.value = "";
      }
    };
    reader.readAsText(file);
  });

  els.clearBtn.addEventListener("click", function () {
    showConfirm(tr("ล้างข้อมูลทั้งหมด (รายการเวลาทำงานทุกรายการ) จะไม่สามารถกู้คืนได้ ยืนยันหรือไม่?")).then(function (ok) {
      if (!ok) return;
      state = clone(DEFAULT_STATE);
      saveState();
      loadSettingsToForm();
      updateHeaderTitle();
      resetForm();
      renderEntryList();
      renderSummary();
      resetNoteForm();
      renderNoteList();
      showToast(tr("ล้างข้อมูลแล้ว"));
    });
  });

  /* ============================================================
   * PWA: service worker + install prompt
   * ========================================================== */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("service-worker.js").catch(function (err) {
        console.warn(tr("ลงทะเบียน Service Worker ไม่สำเร็จ"), err);
      });
    });

    // A tab left open across a deploy keeps running the JS it already
    // loaded even after a new service worker installs in the background -
    // reload once the new one actually takes control so an open desktop
    // tab can't get stuck running a stale (potentially buggy) version.
    var swRefreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (swRefreshing) return;
      swRefreshing = true;
      window.location.reload();
    });
  }

  var deferredInstallPrompt = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredInstallPrompt = e;
    els.installBtn.classList.remove("hidden");
  });
  els.installBtn.addEventListener("click", function () {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.finally(function () {
      deferredInstallPrompt = null;
      els.installBtn.classList.add("hidden");
    });
  });
  window.addEventListener("appinstalled", function () {
    els.installBtn.classList.add("hidden");
  });

  /* ============================================================
   * Auth (Supabase Google login) + cloud sync — same Supabase project
   * as todo-practice. localStorage stays the source of truth for
   * offline use; when signed in, every saveState() also mirrors the
   * full state up to ot_settings/ot_entries (see hook in saveState()
   * above). window.supabase may be missing if the CDN script failed
   * to load (e.g. first launch while offline) - guarded so the rest
   * of the app still boots normally.
   * ========================================================== */
  var SUPABASE_URL = "https://tnbxahwxiocgmabrajpz.supabase.co";
  var SUPABASE_KEY = "sb_publishable_u8s6AuflgTbsn8Or1TJxnw_GezZH5kS";

  var supabaseClient = (window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { autoRefreshToken: true, persistSession: true }
      })
    : null;

  // Signed-in user's id once cloud sync has kicked in for this session,
  // null while signed out. Doubles as the "have we already run the
  // initial sync for this login" guard, since onAuthStateChange also
  // re-fires (with the same user id) on token refresh etc.
  var currentUserId = null;

  function renderAuthState(session) {
    var signedIn = !!session;
    els.authSignedOut.classList.toggle("hidden", signedIn);
    els.authSignedIn.classList.toggle("hidden", !signedIn);
    els.userEmailDisplay.textContent = signedIn ? session.user.email : "";
  }

  /* ------------ Cloud sync status (icon + banner + retry) ------------
   * Purely a UI layer on top of pushStateToCloud() below - never affects
   * whether/when data gets saved locally (saveState() always writes to
   * localStorage first, regardless of sync outcome).
   */
  var SYNC_LAST_KEY = "ot-tracker-last-sync-v1";
  var syncStatus = "idle"; // idle | syncing | success | error
  // Only toast once per failure streak so a sustained outage (which can
  // trigger many pushStateToCloud() calls, one per edit) doesn't spam
  // repeated toasts - reset back to false as soon as a push succeeds.
  var syncErrorNotified = false;
  // Bumped by every pushStateToCloud() call so an older, still-in-flight
  // push can tell that fresher data is already on its way up and skip its
  // own cleanup delete (see pushStateToCloud).
  var pushSeq = 0;
  var pushInFlight = null;
  var pushAgain = false;
  var authGeneration = 0;
  var syncErrorMessage = "";
  var lastSyncFailures = null;
  var sessionRefreshJob = null;
  var sessionRevision = 0;
  var authNeedsReconnect = false;
  var cloudClockWaiters = 0;
  var syncRetryTimer = null;
  var syncRetryAttempt = 0;
  var syncCanAutoRetry = false;
  var cloudSyncJob = null;
  var SYNC_RETRY_DELAYS = [5000, 15000, 30000, 60000, 120000];
  // Set by the logout button so a lapsed session can be told apart from
  // somebody deliberately handing the browser back (see handleAuthChange).
  var explicitLogout = false;
  // The open Realtime subscription, if any (see subscribeToLiveChanges).
  var liveChannel = null;

  function getLastSyncISO() {
    try { return localStorage.getItem(SYNC_LAST_KEY); } catch (e) { return null; }
  }

  function setLastSyncISO(iso) {
    try { localStorage.setItem(SYNC_LAST_KEY, iso); } catch (e) {}
  }

  function formatLastSync() {
    var iso = getLastSyncISO();
    return iso ? tr("ซิงก์ล่าสุดเมื่อ ") + dfDateTime.format(new Date(iso)) : tr("ยังไม่เคยซิงก์");
  }

  function renderSyncStatus() {
    els.reconnectBtn.classList.toggle("hidden", !authNeedsReconnect);
    if (!currentUserId) {
      els.syncStatusRow.classList.add("hidden");
      els.syncErrorBanner.classList.toggle("hidden", !authNeedsReconnect);
      if (authNeedsReconnect) els.syncErrorBanner.textContent = tr("เซสชันหมดอายุ ข้อมูลยังอยู่ในเครื่อง · เชื่อมต่อ Google อีกครั้งด้วยบัญชีเดิมเพื่อซิงก์ต่อ");
      return;
    }
    els.syncStatusRow.classList.remove("hidden");
    els.syncStatusRow.classList.remove("sync-status--syncing", "sync-status--error");
    if (syncStatus === "syncing") {
      els.syncStatusRow.classList.add("sync-status--syncing");
      els.syncStatusIcon.innerHTML = ICON_REFRESH;
      els.syncStatusText.textContent = cloudClockWaiters > 0
        ? tr("กำลังรอเวลาฝั่งคลาวด์ แล้วลองซิงก์ใหม่...")
        : tr("กำลังซิงก์...");
      els.syncRetryBtn.classList.add("hidden");
      els.syncErrorBanner.classList.add("hidden");
    } else if (syncStatus === "error") {
      els.syncStatusRow.classList.add("sync-status--error");
      els.syncStatusIcon.innerHTML = ICON_WARNING;
      els.syncStatusText.textContent = tr("ซิงก์ไม่สำเร็จ · ") + formatLastSync();
      els.syncRetryBtn.classList.remove("hidden");
      els.syncErrorBanner.classList.remove("hidden");
      els.syncErrorBanner.textContent = (syncErrorMessage || tr("ข้อมูลยังอยู่ในเครื่อง แต่ยังไม่ได้ซิงก์ขึ้นคลาวด์")) +
        (syncRetryTimer !== null ? tr(" · จะลองซิงก์ใหม่อัตโนมัติ") : "");
    } else {
      els.syncStatusIcon.innerHTML = ICON_CLOUD_CHECK;
      els.syncStatusText.textContent = formatLastSync();
      els.syncRetryBtn.classList.add("hidden");
      els.syncErrorBanner.classList.add("hidden");
    }
  }

  function entryToRow(entry, userId) {
    return {
      id: entry.id,
      user_id: userId,
      updated_at: entry.updatedAt || nowISO(),
      deleted_at: null,
      date: entry.date,
      time_in: entry.timeIn,
      time_out: entry.timeOut,
      ot_multiplier: (entry.otMultiplier === null || entry.otMultiplier === undefined) ? null : entry.otMultiplier,
      note: entry.note || ""
    };
  }

  function rowToEntry(row) {
    return {
      id: row.id,
      updatedAt: row.updated_at || null,
      date: row.date,
      timeIn: row.time_in,
      timeOut: row.time_out,
      otMultiplier: row.ot_multiplier,
      note: row.note || ""
    };
  }

  function noteToRow(note, userId) {
    return {
      id: note.id,
      user_id: userId,
      updated_at: note.updatedAt || nowISO(),
      deleted_at: null,
      title: note.title,
      description: note.description || "",
      start_date: note.startDate,
      end_date: note.endDate,
      reminder_enabled: !!note.reminderEnabled,
      reminder_date: (note.reminderEnabled && note.reminderDate) ? note.reminderDate : null,
      reminder_time: (note.reminderEnabled && note.reminderTime) ? note.reminderTime : null,
      // Round-trip the server-written "sent" flag: work_notes rows are
      // upserted wholesale from local state on every sync (see
      // pushStateToCloud), so if we didn't carry this value back it would
      // reset to false every sync and re-fire past reminders.
      reminder_sent: !!note.reminderSent
    };
  }

  function rowToNote(row) {
    return {
      id: row.id,
      updatedAt: row.updated_at || null,
      title: row.title,
      description: row.description || "",
      startDate: row.start_date,
      endDate: row.end_date,
      reminderEnabled: !!row.reminder_enabled,
      reminderDate: row.reminder_date || "",
      reminderTime: row.reminder_time || "",
      reminderSent: !!row.reminder_sent
    };
  }

  // เดา IANA timezone จริงของเครื่อง (เช่น "Asia/Seoul") จาก Intl ของ browser
  // - ot_settings.timezone เดิม default เป็น "Asia/Bangkok" เสมอเพราะไม่เคยมี
  // โค้ดฝั่ง client เขียนค่านี้เลย ทำให้ send-push-reminders/send-event-reminders
  // (ฝั่ง server) คำนวณเวลาแจ้งเตือนผิดเขตเวลาสำหรับผู้ใช้ที่อยู่นอกไทย
  function detectTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch (e) {
      return null;
    }
  }

  // Mirrors local state up to Supabase. Two properties matter more than
  // anything else here, because getting them wrong is what lost this app's
  // data once already:
  //
  //  1. It never deletes a row. Live records are upserted; deleted ones are
  //     marked with deleted_at on the rows that already exist (tombstones,
  //     sent as an UPDATE - a tombstone can't be upserted because it no
  //     longer carries the NOT NULL columns the insert half would need).
  //     There is no statement in this path capable of destroying a record.
  //  2. It only ever adds this device's knowledge to the cloud. Deciding
  //     what the truth is happens in syncWithCloud() via mergeRecords(),
  //     never by one side flattening the other.
  //
  // Errors are swallowed (they only log and flag the sync status) so
  // saveState() can fire this off without a failure blocking local editing.
  // Resolves true only once the data has really landed and false if
  // anything failed - any caller that tells the user "uploaded ✓" must wait
  // for that rather than assuming success the moment the request goes out.
function describeCloudError(err){
 var code=String(err&&err.code||'');
 var message=String(err&&err.message||err||'').slice(0,180);
 if(code==='PGRST204'||code==='42703'||code==='42P01'||code==='PGRST205')return tr('ฐานข้อมูลยังขาดตารางหรือคอลัมน์สำหรับซิงก์')+(code?' ('+code+')':'')+(message?' · '+message:'');
 if(isFutureTokenError(err))return tr('คลาวด์ตรวจเวลาโทเคนไม่ผ่าน (PGRST303: JWT issued at future) · ลองรอแล้วแต่ยังไม่สำเร็จ ให้ผู้ดูแลตรวจอัปเดตโปรเจกต์ Supabase');
 if(isTokenError(err))return tr('โทเคนบัญชีถูกปฏิเสธ')+(code?' ('+code+')':'')+' · '+message.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[token]');
 if(code==='42501'||/not authorized|invalid.*key/i.test(message))return tr('สิทธิ์บัญชีไม่พร้อม')+(code?' ('+code+')':'');
 if(/fetch|network|timeout|offline/i.test(message))return tr('เชื่อมต่อคลาวด์ไม่ได้ ตรวจสอบอินเทอร์เน็ต');
 return (code?'('+code+') ':'')+(message||tr('คลาวด์ไม่ตอบรับการบันทึก'));
}

// Expired/invalid JWTs can need refresh. "Issued at future" is different:
// PostgREST can have stale cached server time (upstream issue #5196).
// Retry with backoff before asking the owner to update the hosted project.
// Minting another token moves iat forward and does not repair server time.
function isFutureTokenError(err) {
 return String(err&&err.code||'')==='PGRST303' &&
   /jwt issued at future/i.test(String(err&&err.message||''));
}
function isTokenError(err) {
 var code=String(err&&err.code||'');
 return code==='PGRST301'||code==='PGRST303'||/jwt.*(expired|invalid|claims|future)|invalid.*jwt/i.test(String(err&&err.message||''));
}
// Retry connectivity/service outages, not database schema or account permission
// failures. A temporary refresh failure must not force a fresh Google login.
function isTransientCloudError(err) {
 var code=String(err&&err.code||'');
 if(isTokenError(err)||code==='42501'||code==='PGRST204'||code==='42703'||
    code==='42P01'||code==='PGRST205')return false;
 var status=Number(err&&err.status||0);
 return status>=500||/^PGRST00[0-3]$/.test(code)||
   /fetch|network|timeout|timed out|offline|load failed|connection.*(lost|failed|reset)/i.test(String(err&&err.message||''));
}
function checkedCloudResult(result) {
 if(result&&result.error){
  var err=result.error;
  if(result.status&&!err.status)err=Object.assign({},err,{status:result.status});
  throw err;
 }
 return result;
}
function clearSyncRetry(resetAttempts) {
 if(syncRetryTimer!==null)clearTimeout(syncRetryTimer);
 syncRetryTimer=null;
 if(resetAttempts)syncRetryAttempt=0;
}
function scheduleSyncRetry() {
 if(syncRetryTimer!==null||!syncCanAutoRetry||authNeedsReconnect||
    !currentUserId||!supabaseClient||document.hidden||navigator.onLine===false||
    syncRetryAttempt>=SYNC_RETRY_DELAYS.length)return;
 var userId=currentUserId,generation=authGeneration;
 syncRetryTimer=setTimeout(function(){
  syncRetryTimer=null;
  if(userId!==currentUserId||generation!==authGeneration)return;
  if(!syncCanAutoRetry||authNeedsReconnect||syncStatus!=='error'||
     document.hidden||navigator.onLine===false)return;
  ++syncRetryAttempt;
  initialSyncOnLogin(userId).then(syncNotificationUI);
 },SYNC_RETRY_DELAYS[syncRetryAttempt]);
}
function refreshCloudSession(userId,generation,revision) {
 if(userId!==currentUserId||generation!==authGeneration)return Promise.reject(new Error(tr('บัญชีเปลี่ยนระหว่างซิงก์')));
 if(revision!==sessionRevision)return Promise.resolve();
 if(sessionRefreshJob)return sessionRefreshJob;
 if(authNeedsReconnect)return Promise.reject(new Error(tr('เชื่อมต่อ Google อีกครั้งด้วยบัญชีเดิมเพื่อซิงก์ต่อ')));
 // Defer auth work outside onAuthStateChange's callback/SDK session lock.
 var job=new Promise(function(resolve){setTimeout(resolve,0);}).then(function(){
  return supabaseClient.auth.refreshSession();
 }).then(function(result){
  if(result.error)throw result.error;
  var session=result.data&&result.data.session;
  if(!session||session.user.id!==userId||currentUserId!==userId||generation!==authGeneration)
   throw new Error(tr('เซสชันไม่ตรงกับบัญชีที่กำลังซิงก์'));
  ++sessionRevision;authNeedsReconnect=false;
 }).catch(function(err){
  // Automatic SIGNED_OUT can happen when the refresh token was revoked.
  // Its handler hides the view but keeps localStorage for the original owner.
  if((currentUserId===userId||(!currentUserId&&state.ownerId===userId))&&!isTransientCloudError(err)){
   authNeedsReconnect=true;renderSyncStatus();
  }
  throw err;
 }).then(function(value){if(sessionRefreshJob===job)sessionRefreshJob=null;return value;},
 function(err){if(sessionRefreshJob===job)sessionRefreshJob=null;throw err;});
 sessionRefreshJob=job;return job;
}
function cloudRequest(operation,userId,generation) {
 var revision=sessionRevision,refreshed=false,clockAttempt=0;
 var clockDelays=[1000,2000,4000,8000];
 function stillCurrent(){return userId===currentUserId&&generation===authGeneration;}
 function request(){
  if(!stillCurrent())throw new Error(tr('บัญชีเปลี่ยนระหว่างซิงก์'));
  return Promise.resolve().then(operation).then(checkedCloudResult);
 }
 function run(){
  return Promise.resolve().then(request).catch(function(err){
   if(!stillCurrent())throw err;
   if(isFutureTokenError(err)){
    // Keep the signed-in session and local edits. Total backoff is bounded
    // to 15 seconds, then show an actionable server-side error.
    if(clockAttempt>=clockDelays.length)throw err;
    var delay=clockDelays[clockAttempt++];
    ++cloudClockWaiters;renderSyncStatus();
    return new Promise(function(resolve){setTimeout(resolve,delay);}).then(function(){
     --cloudClockWaiters;renderSyncStatus();
     return run(); // request() rechecks the account after every wait.
    });
   }
   if(!isTokenError(err))throw err;
   if(refreshed){
    authNeedsReconnect=true;renderSyncStatus();throw err;
   }
   refreshed=true;
   return refreshCloudSession(userId,generation,revision).then(run);
  });
 }
 return run();
}

function localizedSyncFailureMessage() {
 return tr("ข้อมูลยังอยู่ในเครื่อง · ")+lastSyncFailures.map(function(f){return tr(f.label)+": "+describeCloudError(f.error);}).join(" / ");
}

function reportSyncFailures(failures){
 syncStatus='error';
 syncCanAutoRetry=failures.some(function(f){return isTransientCloudError(f.error);});
 if(syncCanAutoRetry)scheduleSyncRetry();else clearSyncRetry(false);
 lastSyncFailures=failures.map(function(f){return {label:I18N.canonical(f.label),error:f.error};});
 syncErrorMessage=localizedSyncFailureMessage();
 renderSyncStatus();
 if(!syncErrorNotified){syncErrorNotified=true;showToast(tr('ยังมีข้อมูลที่ซิงก์ไม่สำเร็จ ดูสาเหตุในหน้าตั้งค่า'));}
}

function pushStateToCloud(){
 if(!supabaseClient||!currentUserId||(state.ownerId&&state.ownerId!==currentUserId))return Promise.resolve(false);
 ++pushSeq;
 if(pushInFlight){pushAgain=true;return pushInFlight;}
 var userId=currentUserId,generation=authGeneration;
 syncStatus='syncing';renderSyncStatus();
 function stillCurrent(){return generation===authGeneration&&userId===currentUserId;}
 function checked(result){return checkedCloudResult(result);}
 function runPass(){
  if(!stillCurrent())return Promise.resolve(false);
  pushAgain=false;
  var seq=pushSeq,snapshot=clone(state),failures=[];
  var settingsRow={user_id:userId,data:snapshot.settings,updated_at:snapshot.settingsUpdatedAt||nowISO()};
  var tz=detectTimeZone();if(tz)settingsRow.timezone=tz;
  function attempt(label,operation){
   return cloudRequest(operation,userId,generation).catch(function(err){
    failures.push({label:label,error:err});console.error(tr('ซิงก์ ')+label+tr(' ไม่สำเร็จ'),err);
   });
  }
  function records(table,live,dead,toRow){
   var upload=live.length?supabaseClient.from(table).upsert(live.map(function(item){return toRow(item,userId);})):Promise.resolve(null);
   return Promise.resolve(upload).then(checked).then(function(){
    if(!stillCurrent())return null;
    // Preserve the original deletion version across retries. Advancing it to
    // "now" could let an old device delete a newer edit made elsewhere.
    // Sequential tombstones let a retry safely replay idempotent updates.
    return dead.reduce(function(previous,t){return previous.then(function(){
     if(!stillCurrent())return null;
     var deletedAt=t.deletedAt||nowISO();
     return Promise.resolve(supabaseClient.from(table).update({deleted_at:deletedAt,updated_at:deletedAt}).eq('user_id',userId).in('id',[t.id])).then(checked);
    });},Promise.resolve());
   });
  }
  return Promise.all([
   attempt(tr('การตั้งค่า'),function(){
    return Promise.resolve(supabaseClient.from('ot_settings').upsert(settingsRow)).then(checked).then(function(){
     if(stillCurrent()&&seq===pushSeq&&JSON.stringify(state.settings)===JSON.stringify(snapshot.settings)){
      state.settingsDirty=false;
      try{persistWorkingState(state);}catch(e){console.warn(tr('อัปเดตสถานะในเครื่องไม่ได้'),e);}
     }
    });
   }),
   attempt(tr('รายการ OT'),function(){return records('ot_entries',snapshot.entries,snapshot.deletedEntries,entryToRow);}),
   attempt(tr('เหตุการณ์'),function(){return records('work_notes',snapshot.workNotes,snapshot.deletedNotes,noteToRow);})
  ]).then(function(){
   if(!stillCurrent())return false;
   // One writer per account. A save made in flight is included in a fresh
   // pass, so a late old response cannot overwrite the latest save.
   if(pushAgain||seq!==pushSeq)return runPass();
   if(failures.length){reportSyncFailures(failures);return false;}
   clearSyncRetry(true);syncCanAutoRetry=false;
   setLastSyncISO(nowISO());syncStatus='success';syncErrorMessage='';syncErrorNotified=false;renderSyncStatus();return true;
  });
 }
 var job=runPass().catch(function(err){
  if(stillCurrent())reportSyncFailures([{label:tr('การซิงก์'),error:err}]);
  return false;
 }).then(function(ok){if(pushInFlight===job)pushInFlight=null;return ok;});
 pushInFlight=job;return job;
}

  // Brings this device and the cloud to the same state by *merging* them,
  // then pushing the merged result back up. This replaced a pull that
  // overwrote local records with whatever the cloud held: that was fine
  // when the cloud was healthy and catastrophic when it wasn't, and it also
  // meant a device holding records the cloud had never seen lost them just
  // by signing in. Merging removes the whole category of problem - neither
  // side can flatten the other, and a record only ever disappears because
  // of an explicit tombstone.
  function syncWithCloud(userId) {
    var generation = authGeneration;
    var settingsBeforeRead = JSON.stringify(state.settings);
    if (currentUserId !== userId) return Promise.resolve(false);
    syncStatus = "syncing";
    renderSyncStatus();
    return Promise.all([
      cloudRequest(function(){return supabaseClient.from("ot_settings").select("data,updated_at").eq("user_id",userId).maybeSingle();},userId,generation),
      cloudRequest(function(){return supabaseClient.from("ot_entries").select("*").eq("user_id",userId);},userId,generation),
      cloudRequest(function(){return supabaseClient.from("work_notes").select("*").eq("user_id",userId);},userId,generation)
    ]).then(function (results) {
      if (generation !== authGeneration || userId !== currentUserId) return false;
      var settingsRes = results[0], entriesRes = results[1], notesRes = results[2];
      if (settingsRes.error) throw settingsRes.error;
      if (entriesRes.error) throw entriesRes.error;
      if (notesRes.error) throw notesRes.error;
      if (settingsRes.data && !state.settingsDirty && settingsBeforeRead === JSON.stringify(state.settings) &&
          tsOf(settingsRes.data.updated_at) >= tsOf(state.settingsUpdatedAt)) {
        state.settings = Object.assign(clone(DEFAULT_STATE.settings), settingsRes.data.data || {});
        state.settingsUpdatedAt = settingsRes.data.updated_at || null;
        lastSavedSettings = JSON.stringify(state.settings);
      }

      // Soft-deleted rows come back from the cloud too - they are how a
      // delete made on another device reaches this one.
      function split(rows, toRecord) {
        var live = [], dead = [];
        (rows || []).forEach(function (row) {
          if (row.deleted_at) dead.push({ id: row.id, deletedAt: row.deleted_at });
          else live.push(toRecord(row));
        });
        return { live: live, dead: dead };
      }
      var cloudEntries = split(entriesRes.data, rowToEntry);
      var cloudNotes = split(notesRes.data, rowToNote);

      // Merging is only ever safe between one account's own copies. On a
      // shared browser the previous person's records are still sitting in
      // localStorage, and folding those into whoever signs in next would
      // both show them their colleague's OT and upload it into that
      // account. Anything belonging to a different account is dropped here
      // instead - it is already safe in its own account in the cloud.
      // A device that has never signed in has no owner yet, so data
      // recorded before the first login is adopted rather than discarded.
      if (state.ownerId && state.ownerId !== userId) {
        state.entries = [];
        state.workNotes = [];
        state.deletedEntries = [];
        state.deletedNotes = [];
      }
      state.ownerId = userId;

      var mergedEntries = mergeRecords([
        { live: state.entries, dead: state.deletedEntries },
        cloudEntries
      ]);
      var mergedNotes = mergeRecords([
        { live: state.workNotes, dead: state.deletedNotes },
        cloudNotes
      ]);
      state.entries = mergedEntries.live;
      state.deletedEntries = mergedEntries.dead;
      state.workNotes = mergedNotes.live;
      state.deletedNotes = mergedNotes.dead;

      persistWorkingState(state);
      loadSettingsToForm();
      updateHeaderTitle();
      resetFormsIfUntouched();
      renderEntryList();
      renderSummary();
      renderNoteList();
      checkUpcomingNoteNotifications();
      // Push the merged result so the cloud ends up holding everything this
      // device just contributed, not only what it already had.
      return pushStateToCloud();
    });
  }

  // Applies one row the database pushed to us. Merged through exactly the
  // same rules as a full sync, so a live update can no more drop a record
  // than a sync can, and applying the same row twice changes nothing.
  //
  // Deliberately does NOT push anything back: our own writes echo back to us
  // as events too, and answering an event with a write would have two
  // devices talking in circles forever.
  function applyLiveRow(kind, row) {
    if (!row || !row.id || row.user_id !== currentUserId) return;
    var incoming = row.deleted_at
      ? { live: [], dead: [{ id: row.id, deletedAt: row.deleted_at }] }
      : { live: [kind === "entries" ? rowToEntry(row) : rowToNote(row)], dead: [] };
    var merged = kind === "entries"
      ? mergeRecords([{ live: state.entries, dead: state.deletedEntries }, incoming])
      : mergeRecords([{ live: state.workNotes, dead: state.deletedNotes }, incoming]);
    if (kind === "entries") {
      state.entries = merged.live;
      state.deletedEntries = merged.dead;
    } else {
      state.workNotes = merged.live;
      state.deletedNotes = merged.dead;
    }
    try { persistWorkingState(state); } catch (e) {}
    // Only the views - never the forms. A live update arriving while
    // somebody is typing must not disturb what they are entering.
    renderEntryList();
    renderSummary();
    renderNoteList();
  }

  // Subscribes to this account's own rows so a change made on another device
  // shows up here as it happens, with no need to reopen or refocus the app.
  // The filters are scoped to this user id, and the database's row level
  // security independently limits the stream to rows this account may read.
  function subscribeToLiveChanges(userId) {
    if (!supabaseClient || !supabaseClient.channel) return;
    unsubscribeFromLiveChanges();
    try {
      liveChannel = supabaseClient
        .channel("ot-live-" + userId)
        .on("postgres_changes",
          { event: "*", schema: "public", table: "ot_entries", filter: "user_id=eq." + userId },
          function (payload) { applyLiveRow("entries", payload.new); })
        .on("postgres_changes",
          { event: "*", schema: "public", table: "work_notes", filter: "user_id=eq." + userId },
          function (payload) { applyLiveRow("notes", payload.new); })
        .subscribe();
    } catch (err) {
      // Live updates are a convenience on top of syncing, never the thing
      // that keeps data safe - if the socket can't be opened the app still
      // syncs on sign-in and whenever it regains focus.
      console.warn(tr("เปิดการอัปเดตแบบเรียลไทม์ไม่สำเร็จ"), err);
      liveChannel = null;
    }
  }

  function unsubscribeFromLiveChanges() {
    if (!liveChannel) return;
    try { supabaseClient.removeChannel(liveChannel); } catch (e) {}
    liveChannel = null;
  }

  // Runs when an account is seen for the first time in this session. There
  // is no "is the cloud empty?" branch any more: merging is correct whether
  // the cloud is empty, this device is empty, or both hold different data.
  function initialSyncOnLogin(userId) {
    if(!supabaseClient||!userId||currentUserId!==userId)return Promise.resolve(false);
    if(!accountStorageReady&&!restoreLocalRecordsFor(userId))return Promise.resolve(false);
    var generation=authGeneration;
    // Online, focus, retry and SDK auth events can arrive together.
    // Share one pull/merge per account; local saves retain their single writer.
    if(cloudSyncJob&&cloudSyncJob.userId===userId&&cloudSyncJob.generation===generation)
      return cloudSyncJob.promise;
    clearSyncRetry(false);
    var job={userId:userId,generation:generation,promise:null};
    job.promise=Promise.resolve().then(function(){
      if(currentUserId!==userId||authGeneration!==generation)return false;
      return syncWithCloud(userId);
    }).then(function(ok){
      if(ok&&currentUserId===userId&&authGeneration===generation)showToast(tr("ซิงก์ข้อมูลกับ cloud แล้ว ✓"));
      return ok;
    }).catch(function(err){
      if(currentUserId===userId&&authGeneration===generation)
        reportSyncFailures([{label:tr("โหลดข้อมูลคลาวด์"),error:err}]);
      return false;
    }).then(function(ok){
      if(cloudSyncJob===job)cloudSyncJob=null;
      return ok;
    });
    cloudSyncJob=job;return job.promise;
  }
  // Reloads the records this device has stored, but only if they belong to
  // the account signing in. Needed because signing out empties the in-memory
  // copy while leaving the stored one alone: anything recorded offline and
  // not yet synced has to survive a session that simply expired.
  function restoreLocalRecordsFor(userId) {
    var working = loadState();
    accountStorageReady = true;
    if (working.ownerId && working.ownerId !== userId) {
      // Preserve a previous person's pending records before a new account
      // can replace the working key. Failure blocks editing, not recovery.
      try { archiveAccountState(working); }
      catch (err) {
        clearRecordsFromView(false);
        state.ownerId = userId;
        accountStorageReady = false;
        showToast(tr("เก็บข้อมูลบัญชีก่อนหน้าไม่สำเร็จ ข้อมูลเดิมยังอยู่ กรุณาตรวจพื้นที่ในเครื่อง"));
        return false;
      }
    }
    var cached = loadState(accountCacheKey(userId));
    var copies = [];
    if (!working.ownerId || working.ownerId === userId) copies.push(working);
    if (cached.ownerId === userId) copies.push(cached);
    copies.sort(function(left,right){return (right.localRevision || 0)-(left.localRevision || 0);});
    var selected = copies[0] || clone(DEFAULT_STATE);
    var entries = mergeRecords(copies.map(function(copy){return {live:copy.entries,dead:copy.deletedEntries};}));
    var notes = mergeRecords(copies.map(function(copy){return {live:copy.workNotes,dead:copy.deletedNotes};}));
    state.settings = selected.settings;
    state.settingsDirty = selected.settingsDirty;
    state.settingsUpdatedAt = selected.settingsUpdatedAt;
    state.localRevision = selected.localRevision || 0;
    lastSavedSettings = JSON.stringify(state.settings);
    state.ownerId = userId;
    state.entries = entries.live;
    state.workNotes = notes.live;
    state.deletedEntries = entries.dead;
    state.deletedNotes = notes.dead;
    // Render the recovered account even if the cloud read subsequently fails.
    persistWorkingState(state);
    loadSettingsToForm(); updateHeaderTitle();
    renderEntryList(); renderSummary(); renderNoteList();
    return true;
  }

  // Signing out hides records and clears only the working view. The owned
  // recovery copy remains available when that same account signs in again.
  function clearRecordsFromView(alsoEraseStored) {
    state.entries = [];
    state.workNotes = [];
    state.deletedEntries = [];
    state.deletedNotes = [];
    state.settings = clone(DEFAULT_STATE.settings);
    state.settingsDirty = false;
    state.settingsUpdatedAt = null;
    state.localRevision = 0;
    lastSavedSettings = JSON.stringify(state.settings);
    if (alsoEraseStored) {
      state.ownerId = null;
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    }
    loadSettingsToForm();
    updateHeaderTitle();
    resetForm();
    resetNoteForm();
    renderEntryList();
    renderSummary();
    renderNoteList();
  }

  function handleAuthChange(session) {
    if (!session || session.user.id !== currentUserId) lastSyncFailures = null;
    renderAuthState(session);
    var userId = session ? session.user.id : null;
    if (userId && userId !== currentUserId) {
      ++authGeneration;
      clearSyncRetry(true);
      syncCanAutoRetry = false;
      cloudSyncJob = null;
      sessionRefreshJob = null;
      pushInFlight = null;
      pushAgain = false;
      currentUserId = userId;
      if (!restoreLocalRecordsFor(userId)) {
        syncStatus = "error";
        syncErrorMessage = tr("ข้อมูลบัญชีก่อนหน้ายังอยู่ในเครื่อง แต่เก็บสำเนาแยกไม่สำเร็จ กรุณาตรวจพื้นที่ก่อนเปลี่ยนบัญชี");
        renderSyncStatus(); return;
      }
      subscribeToLiveChanges(userId);
      authNeedsReconnect = false;
      syncStatus = "syncing";
      syncErrorNotified = false;
      renderSyncStatus();
      // Wait for the cloud settings pull to land before syncing the
      // notification UI, so the leave-work toggle reflects the authoritative
      // cloud notifyEnabled value (not a stale local one) and the push
      // self-heal runs against the right account.
      setTimeout(function(){if(currentUserId===userId)initialSyncOnLogin(userId).then(syncNotificationUI);},0);
    } else if (!userId) {
      ++authGeneration;
      clearSyncRetry(true);
      syncCanAutoRetry = false;
      cloudSyncJob = null;
      sessionRefreshJob = null;
      pushInFlight = null;
      pushAgain = false;
      var deliberate = explicitLogout;
      explicitLogout = false;
      currentUserId = null;
      accountStorageReady = true;
      unsubscribeFromLiveChanges();
      clearRecordsFromView(deliberate);
      syncStatus = "idle";
      renderSyncStatus();
      setTimeout(syncNotificationUI,0);
    } else {
      renderSyncStatus();
      setTimeout(syncNotificationUI,0);
    }
  }

  if (supabaseClient) {
    function reconnectGoogle() {
      // OAuth does not clear the pending data or call signOut first.
      supabaseClient.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin + window.location.pathname,
          queryParams: { prompt: "select_account" } }
      }).then(function(result){if(result&&result.error)showToast(tr("เชื่อมต่อ Google ไม่สำเร็จ ลองอีกครั้ง"));})
        .catch(function(){showToast(tr("เชื่อมต่อ Google ไม่สำเร็จ ลองอีกครั้ง"));});
    }
    els.googleLoginBtn.addEventListener("click", reconnectGoogle);
    els.reconnectBtn.addEventListener("click", reconnectGoogle);

    var logoutBusy = false;
    els.logoutBtn.addEventListener("click", function () {
      if (logoutBusy) return;
      logoutBusy = true;
      els.logoutBtn.disabled = true;
      var userId = currentUserId;
      var flush = syncStatus === "success" && !pushInFlight && !state.settingsDirty
        ? Promise.resolve(true)
        : initialSyncOnLogin(userId);
      flush.then(function (ok) {
        if (!ok || currentUserId !== userId) {
          showToast(tr("ยังออกจากระบบไม่ได้ เพราะมีข้อมูลที่ซิงก์ไม่สำเร็จ ข้อมูลในเครื่องยังอยู่ครบ"));
          return;
        }
        // Never destroy the recovery copy. A failed storage write must not
        // silently turn sign-out into deleting the last local record.
        try { archiveAccountState(state); }
        catch (err) {
          showToast(tr("ยังออกจากระบบไม่ได้ เพราะเก็บสำเนาข้อมูลในเครื่องไม่สำเร็จ ข้อมูลเดิมยังอยู่"));
          return;
        }
        explicitLogout = true;
        return supabaseClient.auth.signOut().then(function (result) {
          if (result && result.error) {
            explicitLogout = false;
            showToast(tr("ออกจากระบบไม่สำเร็จ ข้อมูลในเครื่องยังอยู่ครบ"));
          }
        });
      }).catch(function (err) {
        explicitLogout = false;
        reportSyncFailures([{ label: tr("ออกจากระบบ"), error: err }]);
      }).finally(function () {
        logoutBusy = false;
        els.logoutBtn.disabled = false;
      });
    });

    els.syncRetryBtn.addEventListener("click", function () {
      authNeedsReconnect = false;
      clearSyncRetry(true);
      initialSyncOnLogin(currentUserId).then(syncNotificationUI);
    });

    // Auto-retry as soon as connectivity comes back, but only if there's
    // actually a failed sync to retry - a healthy connection firing this
    // event (e.g. switching wifi networks) shouldn't trigger extra pushes.
    window.addEventListener("online", function () {
      if (currentUserId && syncStatus === "error" && syncCanAutoRetry && !authNeedsReconnect) {
        clearSyncRetry(true);
        initialSyncOnLogin(currentUserId).then(syncNotificationUI);
      }
    });

    // Coming back to the app re-syncs, so a record added on the phone shows
    // up on the laptop without signing out and back in. Sync on login alone
    // is not enough for someone actually using two devices. Throttled so
    // flicking between tabs doesn't hammer the network; safe to run often
    // either way, since syncing merges rather than overwrites.
    var RESYNC_AFTER_MS = 60 * 1000;
    var lastResyncAt = 0;
    document.addEventListener("visibilitychange", function () {
      if (document.hidden || !currentUserId || syncStatus === "syncing") return;
      if(authNeedsReconnect)return;
      if(syncStatus==="error"&&syncCanAutoRetry){
        clearSyncRetry(true);
        initialSyncOnLogin(currentUserId).then(syncNotificationUI);
        return;
      }
      var now = Date.now();
      if (now - lastResyncAt < RESYNC_AFTER_MS) return;
      lastResyncAt = now;
      initialSyncOnLogin(currentUserId).then(syncNotificationUI);
    });

    supabaseClient.auth.getSession().then(function (result) {
      if(result.error)throw result.error;
      handleAuthChange(result.data.session);
    }).catch(function(){authNeedsReconnect=true;renderAuthState(null);renderSyncStatus();});

    supabaseClient.auth.onAuthStateChange(function (_event, session) {
      if(_event==="TOKEN_REFRESHED")++sessionRevision;
      // No Supabase work inside the auth callback: older SDK versions hold
      // their session lock until this callback returns.
      setTimeout(function(){
        handleAuthChange(session);
        if(_event==="TOKEN_REFRESHED"&&session&&session.user.id===currentUserId&&
           syncStatus==="error"&&!sessionRefreshJob){
          authNeedsReconnect=false;
          initialSyncOnLogin(currentUserId).then(syncNotificationUI);
        }
      },0);
    });
  } else {
    els.googleLoginBtn.disabled = true;
    els.googleLoginBtn.textContent = tr("ต้องเชื่อมต่ออินเทอร์เน็ตเพื่อเข้าสู่ระบบ");
  }

  /* ============================================================
   * Web Push Notification (infrastructure only - stage 1)
   * Separate from the tab-only reminder above (notifyEnabled/
   * Notification API): this subscribes the device to browser Push via
   * the Service Worker's pushManager, so notifications can eventually
   * be delivered even when the app/tab is closed. No push is actually
   * sent yet - this stage only wires up subscribe/unsubscribe and
   * persists the subscription to Supabase (push_subscriptions) so a
   * later server-side stage has something to send to. Requires being
   * signed in, since a subscription is meaningless without a user_id
   * to send it to.
   * ========================================================== */
  // Paste the VAPID public key here before enabling real push delivery.
  var VAPID_PUBLIC_KEY = "BMoirSRJxpo5bN9SR1YrTDm4BqqhwCvpIqWq31WCufA-EtgIQ5rXN46Yg9LTXa_Ep0hJWSCpACp_KbI14ahA4Zc";

  function pushSupported() {
    return "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
  }

  // Web Push application server keys arrive as URL-safe base64; the Push
  // API wants raw bytes.
  function urlBase64ToUint8Array(base64String) {
    var padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  function notificationPermission() {
    return (typeof Notification !== "undefined") ? Notification.permission : "denied";
  }

  // Best-effort self-heal of THIS device's push subscription. Runs on every
  // app load / login so a subscription that the browser silently dropped (a
  // Service Worker update, iOS PWA eviction, or a benign server-side stale
  // cleanup) gets recreated automatically - this is what keeps push working
  // "across days" without the user re-enabling anything. Crucially it NEVER
  // prompts (only acts when permission is already granted) and NEVER touches
  // notifyEnabled. Resolves to whether this device now has a subscription.
  function ensurePushSubscription() {
    if (!pushSupported()) return Promise.resolve(false);
    return navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription().then(function (sub) {
        if (sub) {
          // Re-persist to the server so a subscription that was wrongly pruned
          // there (e.g. one failed send) is restored on the next app open.
          savePushSubscription(sub).catch(function () {});
          return true;
        }
        if (!currentUserId || notificationPermission() !== "granted") return false;
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        }).then(function (fresh) {
          savePushSubscription(fresh).catch(function () {});
          return true;
        }).catch(function (err) {
          console.error("[push] auto-subscribe failed", err);
          return false;
        });
      });
    }).catch(function () { return false; });
  }

  // Single source of truth for both notification toggles. It reflects state,
  // it never decides intent: the leave-work toggle mirrors the cloud-synced
  // notifyEnabled flag directly and is NEVER cleared here, so losing a device
  // subscription can no longer silently disable reminders for the account
  // (the old bug). The Push toggle reflects only whether THIS device is
  // subscribed, after a self-heal attempt.
  function syncNotificationUI() {
    var supported = pushSupported();
    var loggedIn = !!currentUserId;

    // Intent mirror - independent of subscription state.
    els.sNotifyLateOut.checked = !!state.settings.notifyEnabled;
    els.sNotifyLateOut.disabled = !supported || !loggedIn;

    if (!supported || !loggedIn) {
      els.sPushEnabled.checked = false;
      els.sPushEnabled.disabled = true;
      els.pushRow.classList.add("is-disabled");
      els.pushHint.textContent = !supported
        ? tr("อุปกรณ์นี้ไม่รองรับ หรือถ้าใช้ iPhone ต้องกด Add to Home Screen ก่อน (Safari → แชร์ → เพิ่มไปยังหน้าจอโฮม)")
        : tr("ต้องเข้าสู่ระบบก่อนจึงจะเปิดใช้ได้ — เมื่อเปิด เบราว์เซอร์จะลงทะเบียนรับ push ให้อุปกรณ์นี้ ทำงานได้แม้ปิดแอปหรือแท็บนี้ไปแล้ว");
      return;
    }

    els.sPushEnabled.disabled = false;
    els.pushRow.classList.remove("is-disabled");

    ensurePushSubscription().then(function (subscribed) {
      els.sPushEnabled.checked = subscribed;
      var perm = notificationPermission();
      if (state.settings.notifyEnabled && !subscribed) {
        els.pushHint.textContent = perm === "denied"
          ? tr("⚠️ แจ้งเตือนจดบันทึก OT เปิดอยู่ แต่อุปกรณ์นี้บล็อกการแจ้งเตือน — เปิดสิทธิ์แจ้งเตือนของเว็บนี้ในตั้งค่าเบราว์เซอร์ แล้วกลับมาเปิดสวิตช์ Push ด้านบนอีกครั้ง")
          : tr("⚠️ แจ้งเตือนจดบันทึก OT เปิดอยู่ แต่อุปกรณ์นี้ยังไม่ได้รับ push — แตะสวิตช์ Push ด้านบนเพื่อเปิดรับบนอุปกรณ์นี้");
      } else if (subscribed) {
        els.pushHint.textContent = tr("เปิดใช้แล้วสำหรับอุปกรณ์นี้ จะได้รับการแจ้งเตือนแม้ปิดแอปหรือแท็บนี้ไปแล้ว");
      } else if (perm === "denied") {
        els.pushHint.textContent = tr("อุปกรณ์นี้บล็อกการแจ้งเตือนอยู่ — เปิดสิทธิ์แจ้งเตือนของเว็บนี้ในตั้งค่าเบราว์เซอร์ก่อน");
      } else {
        els.pushHint.textContent = tr("เมื่อเปิด เบราว์เซอร์จะขอสิทธิ์การแจ้งเตือนและลงทะเบียนรับ push ให้อุปกรณ์นี้ ทำงานได้แม้ปิดแอปหรือแท็บนี้ไปแล้ว");
      }
    });
  }

  // Called after the user explicitly turns the leave-work reminder ON. The
  // intent itself is already saved by the caller; this only makes sure the
  // current device can actually receive it, prompting for permission inside
  // the user gesture when needed. It never rolls the intent back on failure -
  // the setting stays on and simply gets delivered once the device is ready
  // (e.g. after the user grants permission and reloads).
  function ensureDeviceReadyForReminders() {
    if (!pushSupported()) {
      showToast(tr("บันทึกการตั้งค่าแล้ว แต่อุปกรณ์นี้ไม่รองรับ push (iPhone ต้อง Add to Home Screen ก่อน)"));
      syncNotificationUI();
      return;
    }
    var perm = notificationPermission();
    if (perm === "granted") {
      ensurePushSubscription().then(function (sub) {
        showToast(sub ? tr("เปิดแจ้งเตือนจดบันทึก OT แล้ว ✓") : tr("บันทึกแล้ว แต่ยังลงทะเบียน push บนอุปกรณ์นี้ไม่สำเร็จ"));
        syncNotificationUI();
      });
      return;
    }
    if (perm === "denied") {
      showToast(tr("บันทึกแล้ว — แต่อุปกรณ์นี้บล็อกการแจ้งเตือน เปิดสิทธิ์ในตั้งค่าเบราว์เซอร์เพื่อรับบนเครื่องนี้"));
      syncNotificationUI();
      return;
    }
    Notification.requestPermission().then(function (p) {
      if (p === "granted") {
        subscribeToPush()
          .then(function () { showToast(tr("เปิดแจ้งเตือนจดบันทึก OT แล้ว ✓")); })
          .catch(function (err) { console.error(tr("สมัครรับ Push ไม่สำเร็จ"), err); })
          .finally(syncNotificationUI);
      } else {
        showToast(tr("บันทึกแล้ว — แต่ยังไม่ได้อนุญาตแจ้งเตือน จะได้รับเมื่ออนุญาตสิทธิ์ในเบราว์เซอร์"));
        syncNotificationUI();
      }
    });
  }

  function savePushSubscription(sub) {
    if (!supabaseClient || !currentUserId) return Promise.resolve();
    var json = sub.toJSON();
    console.log("[push debug] savePushSubscription: upserting", { user_id: currentUserId, endpoint: json.endpoint });
    return supabaseClient.from("push_subscriptions").upsert({
      user_id: currentUserId,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth
    }, { onConflict: "user_id,endpoint" }).then(function (res) {
      console.log("[push debug] savePushSubscription result", res);
      if (res.error) throw res.error;
      return res;
    });
  }

  function deletePushSubscription(endpoint) {
    if (!supabaseClient || !currentUserId) return Promise.resolve();
    return supabaseClient.from("push_subscriptions").delete().eq("user_id", currentUserId).eq("endpoint", endpoint)
      .then(function (res) {
        console.log("[push debug] deletePushSubscription result", res);
        if (res.error) throw res.error;
        return res;
      });
  }

  function subscribeToPush() {
    console.log("[push debug] subscribeToPush: waiting for serviceWorker.ready");
    return navigator.serviceWorker.ready.then(function (reg) {
      console.log("[push debug] serviceWorker ready, calling pushManager.subscribe", reg);
      return reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }).then(function (sub) {
      console.log("[push debug] pushManager.subscribe succeeded", sub);
      return savePushSubscription(sub);
    });
  }

  function unsubscribeFromPush() {
    return navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      if (!sub) return null;
      var endpoint = sub.endpoint;
      return sub.unsubscribe().then(function () {
        return deletePushSubscription(endpoint);
      });
    });
  }

  // This toggle governs only THIS device's push subscription (shared by both
  // the leave-work reminder and the upcoming-event reminder). It does not
  // touch the account-level notifyEnabled intent.
  els.sPushEnabled.addEventListener("change", function () {
    if (!els.sPushEnabled.checked) {
      unsubscribeFromPush().then(function () {
        showToast(tr("ปิดการแจ้งเตือนแบบ Push บนอุปกรณ์นี้แล้ว"));
      }).catch(function (err) {
        console.error(tr("ยกเลิกการสมัครรับ Push ไม่สำเร็จ"), err);
      }).finally(syncNotificationUI);
      return;
    }

    if (!pushSupported()) {
      showToast(tr("อุปกรณ์นี้ไม่รองรับ หรือถ้าใช้ iPhone ต้องกด Add to Home Screen ก่อน (Safari → แชร์ → เพิ่มไปยังหน้าจอโฮม)"));
      syncNotificationUI();
      return;
    }
    if (!currentUserId) {
      showToast(tr("กรุณาเข้าสู่ระบบก่อนเปิดการแจ้งเตือนแบบ Push"));
      syncNotificationUI();
      return;
    }

    Notification.requestPermission().then(function (permission) {
      if (permission !== "granted") {
        showToast(tr("การแจ้งเตือนถูกปฏิเสธ กรุณาเปิดสิทธิ์การแจ้งเตือนสำหรับเว็บนี้ในตั้งค่าเบราว์เซอร์ก่อน"));
        syncNotificationUI();
        return;
      }
      subscribeToPush()
        .then(function () { showToast(tr("เปิดการแจ้งเตือนแบบ Push แล้ว ✓")); })
        .catch(function (err) {
          console.error(tr("สมัครรับ Push ไม่สำเร็จ"), err);
          showToast(tr("เปิดการแจ้งเตือนแบบ Push ไม่สำเร็จ"));
        })
        .finally(syncNotificationUI);
    });
  });

  // The leave-work reminder toggle is pure account-level intent: flipping it
  // saves immediately and unconditionally (that is what makes it persist
  // across days and survive this device losing its subscription). Turning it
  // on then makes a best-effort attempt to get this device ready to receive
  // it; the setting is never rolled back if that attempt can't complete.
  els.sNotifyLateOut.addEventListener("change", function () {
    var wantOn = els.sNotifyLateOut.checked;
    state.settings.notifyEnabled = wantOn;
    updateNotifyTimeVisible();
    persistSettings();
    if (wantOn) {
      ensureDeviceReadyForReminders();
    } else {
      showToast(tr("ปิดแจ้งเตือนจดบันทึก OT แล้ว"));
      syncNotificationUI();
    }
  });

  // The reminder time only matters while the reminder is on, so hide the row
  // when it's off to keep the settings card uncluttered.
  function updateNotifyTimeVisible() {
    els.notifyTimeRow.classList.toggle("hidden", !state.settings.notifyEnabled);
  }

  els.sNotifyTime.addEventListener("input", function () {
    state.settings.notifyTime = els.sNotifyTime.value || "";
    persistSettings();
  });


  /* Account-owned UI language. Re-render labels without resetting open forms. */
  function refreshLanguageLabels() {
    refreshDateFormats();
    var currencyNames = {"KRW":"วอนเกาหลี","THB":"บาทไทย","JPY":"เยนญี่ปุ่น","TWD":"ดอลลาร์ไต้หวัน","USD":"ดอลลาร์สหรัฐ","MYR":"มาเลเซียริงกิต","ILS":"อิสราเอลเชคเกล","SGD":"ดอลลาร์สิงคโปร์"};
    Object.keys(currencyNames).forEach(function (code) { CURRENCIES[code].label = tr(currencyNames[code]); });
    ICON_SUN = tr('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="โหมดสว่าง"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>');
    ICON_MOON = tr('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="โหมดมืด"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/></svg>');
    ICON_REFRESH = tr('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="กำลังซิงก์"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>');
    ICON_WARNING = tr('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="คำเตือน"><path d="m12 2 10 18H2L12 2Z"/><line x1="12" y1="9" x2="12" y2="13"/><circle cx="12" cy="16.5" r="0.6" fill="currentColor" stroke="none"/></svg>');
    ICON_CLOUD_CHECK = tr('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="ซิงก์แล้ว"><path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.5A4 4 0 0 0 6 19h11.5Z"/><path d="m9 15 2 2 4-4"/></svg>');
    ICON_NOTE = tr('<svg class="note-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="โน้ต"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>');
    ICON_BELL = tr('<svg class="note-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="แจ้งเตือน"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>');
    updateThemeToggleIcon(currentTheme());
    updateDateTriggerText();
    updateDateTriggerTextGeneric(els.nStartDate, els.noteStartTriggerText, els.noteStartTrigger);
    updateDateTriggerTextGeneric(els.nEndDate, els.noteEndTriggerText, els.noteEndTrigger);
    updateDateTriggerTextGeneric(els.nRemindDate, els.noteRemindTriggerText, els.noteRemindTrigger);
    updateCurrencyTrigger();
    var cur = currentCurrency();
    els.hourlyRateLabel.textContent = tr("ค่าแรงต่อชั่วโมง (") + cur.symbol + " " + cur.label + tr(") — ใช้คำนวณ OT เท่านั้น");
    els.monthlySalaryLabel.textContent = tr("เงินเดือน (") + cur.symbol + " " + cur.label + ")";
    els.otGoalLabel.textContent = tr("เป้าหมายเงิน OT ต่อเดือน (") + cur.symbol + " " + cur.label + ")";
    els.entryFormTitle.textContent = editingId ? tr("แก้ไขรายการ") : tr("บันทึกเวลาทำงาน");
    els.saveEntryBtn.textContent = editingId ? tr("บันทึกการแก้ไข") : tr("บันทึก");
    els.noteFormTitle.textContent = editingNoteId ? tr("แก้ไขบันทึกเหตุการณ์") : tr("บันทึกเหตุการณ์ล่วงหน้า");
    els.saveNoteBtn.textContent = editingNoteId ? tr("บันทึกการแก้ไข") : tr("บันทึก");
    updateHolidayNotice(); updatePreview();
    renderEntryList(); renderNoteList(); renderSummary();
    if (!els.calendarOverlay.classList.contains("hidden")) renderCalendar();
    if (syncStatus === "error") {
      syncErrorMessage = lastSyncFailures ? localizedSyncFailureMessage() : tr(I18N.canonical(syncErrorMessage));
    }
    if (!els.exportOverlay.classList.contains("hidden")) {
      var rangeButton = els.exportRangeTabs.querySelector('[data-range="month"]');
      rangeButton.textContent = summaryState.mode === "year" ? tr("ปีนี้") : tr("เดือนนี้");
    }
    renderSyncStatus(); syncNotificationUI();
  }
  window.addEventListener("ot:languagechange", function (event) {
    if (event.detail.source === "user" && activeOwnerId()) {
      state.settings.language = event.detail.language;
      try { persistSettings(); } catch (err) { showToast(tr("บันทึกข้อมูลในเครื่องไม่ได้")); }
    }
    refreshLanguageLabels();
  });

  /* ============================================================
   * Init
   * ========================================================== */
  initMoneyInputs(document);
  updateHeaderTitle();
  resetForm();
  renderEntryList();
  resetNoteForm();
  renderNoteList();
  loadSettingsToForm();
  renderSummary();
  checkUpcomingNoteNotifications();
  syncNotificationUI();
})();
