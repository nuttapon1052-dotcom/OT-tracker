(function () {
  "use strict";

  /* ============================================================
   * Storage
   * ========================================================== */
  var STORAGE_KEY = "ot-tracker-data-v1";

  var DEFAULT_STATE = {
    version: 1,
    settings: {
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
    entries: [], // { id, date, timeIn, timeOut, otMultiplier(number|null), note }
    workNotes: [] // { id, title, description, startDate, endDate, reminderEnabled, reminderDate, reminderTime, reminderSent }
  };

  var CURRENCIES = {
    KRW: { symbol: "₩", decimals: 0, locale: "ko-KR", label: "วอนเกาหลี" },
    THB: { symbol: "฿", decimals: 2, locale: "th-TH", label: "บาทไทย" },
    JPY: { symbol: "¥", decimals: 0, locale: "ja-JP", label: "เยนญี่ปุ่น" },
    TWD: { symbol: "NT$", decimals: 0, locale: "zh-TW", label: "ดอลลาร์ไต้หวัน" },
    USD: { symbol: "$", decimals: 2, locale: "en-US", label: "ดอลลาร์สหรัฐ" },
    MYR: { symbol: "RM", decimals: 2, locale: "ms-MY", label: "มาเลเซียริงกิต" },
    ILS: { symbol: "₪", decimals: 2, locale: "he-IL", label: "อิสราเอลเชคเกล" },
    SGD: { symbol: "S$", decimals: 2, locale: "en-SG", label: "ดอลลาร์สิงคโปร์" }
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
        console.error("ดึงข้อมูลวันหยุดราชการไม่สำเร็จ", err);
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
    return dict[name] || name;
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

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return clone(DEFAULT_STATE);
      var parsed = JSON.parse(raw);
      var state = clone(DEFAULT_STATE);
      state.settings = Object.assign({}, state.settings, parsed.settings || {});
      state.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      state.workNotes = Array.isArray(parsed.workNotes) ? parsed.workNotes : [];
      // Own try/catch: the outer one falls back to an empty DEFAULT_STATE,
      // so a throw in here would hide every record the user has. Repairing
      // ids is a nice-to-have; never let it cost data.
      try {
        var entriesRepaired = repairInvalidIds(state.entries);
        var notesRepaired = repairInvalidIds(state.workNotes);
        if (entriesRepaired || notesRepaired) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        }
      } catch (e) {
        console.error("ซ่อม id ของรายการไม่สำเร็จ", e);
      }
      return state;
    } catch (e) {
      console.error("โหลดข้อมูลผิดพลาด", e);
      return clone(DEFAULT_STATE);
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    pushStateToCloud();
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  var state = loadState();

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
    return (Math.round(h * 100) / 100).toLocaleString("th-TH", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  }

  function fmtMoney(v) {
    var cur = currentCurrency();
    var factor = Math.pow(10, cur.decimals);
    var rounded = Math.round(v * factor) / factor;
    return cur.symbol + rounded.toLocaleString(cur.locale, { minimumFractionDigits: cur.decimals, maximumFractionDigits: cur.decimals });
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

  var dfFull = new Intl.DateTimeFormat("th-TH", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  var dfShort = new Intl.DateTimeFormat("th-TH", { weekday: "short", day: "numeric", month: "short" });
  var dfMonthYear = new Intl.DateTimeFormat("th-TH", { month: "long", year: "numeric" });
  var dfYear = new Intl.DateTimeFormat("th-TH", { year: "numeric" });
  var dfMonthShort = new Intl.DateTimeFormat("th-TH", { month: "short" });
  var dfDateTime = new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

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

  var ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="โหมดสว่าง"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
  var ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="โหมดมืด"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/></svg>';
  var ICON_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="กำลังซิงก์"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>';
  var ICON_WARNING = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="คำเตือน"><path d="m12 2 10 18H2L12 2Z"/><line x1="12" y1="9" x2="12" y2="13"/><circle cx="12" cy="16.5" r="0.6" fill="currentColor" stroke="none"/></svg>';
  var ICON_CLOUD_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="ซิงก์แล้ว"><path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.5A4 4 0 0 0 6 19h11.5Z"/><path d="m9 15 2 2 4-4"/></svg>';
  var ICON_NOTE = '<svg class="note-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="โน้ต"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  var ICON_BELL = '<svg class="note-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="แจ้งเตือน"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

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
    els.entryForm.reset();
    els.fDate.value = toISODate(new Date());
    els.fTimeIn.value = lockedTimeIn();
    els.fTimeOut.value = lockedTimeOutWeekday();
    applyWeekendTimeDefault();
    els.fOtRate.value = "default";
    els.fOtCustomWrap.classList.add("hidden");
    els.entryFormTitle.textContent = "บันทึกเวลาทำงาน";
    els.saveEntryBtn.textContent = "บันทึก";
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
    els.entryFormTitle.textContent = "แก้ไขรายการ";
    els.saveEntryBtn.textContent = "บันทึกการแก้ไข";
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
      els.holidayNotice.innerHTML = '<svg class="notice-icon" viewBox="0 0 24 24" fill="currentColor" role="img" aria-label="วันหยุดราชการ"><circle cx="12" cy="12" r="6"/></svg> ' + escapeHtml(holidayDisplayName(holidayName)) + " — วันหยุดราชการ";
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
    textEl.textContent = v ? dfFull.format(fromISODate(v)) : "เลือกวันที่";
    triggerEl.classList.toggle("is-empty", !v);
  }

  function updateDateTriggerText() {
    updateDateTriggerTextGeneric(els.fDate, els.dateTriggerText, els.dateTrigger);
  }

  function updatePreview() {
    updateWeekendNotice();
    updateHolidayNotice();
    updateDateTriggerText();
    var draft = draftEntryFromForm();
    if (!draft.timeIn || !draft.timeOut) {
      els.entryPreview.innerHTML = "กรอกเวลาเข้า-ออกงานเพื่อดูผลคำนวณ";
      return;
    }
    var c = computeEntry(draft, state.settings);
    if (!c) {
      els.entryPreview.innerHTML = '<span class="preview__error">ข้อมูลเวลาไม่ถูกต้อง</span>';
      return;
    }
    var html = "";
    if (c.overnight) html += "กะข้ามคืน (คำนวณเลยเที่ยงคืน)<br/>";
    html += "ชั่วโมงทำงานปกติ <strong>" + fmtHours(c.normalHours) + " ชม.</strong> = " + fmtMoney(c.normalPay) + "<br/>";
    html += "ชั่วโมง OT รวม <strong class=\"preview__ot\">" + fmtHours(c.otHours) + " ชม.</strong>";
    if (c.otHours > 0) html += " (x" + c.multiplier + ")";
    html += " = <span class=\"preview__ot\">" + fmtMoney(c.otPay) + "</span><br/>";
    html += "ยอดรวมทั้งหมด <span class=\"preview__total\">" + fmtMoney(c.totalPay) + "</span>";
    els.entryPreview.innerHTML = html;
  }

  ["input", "change"].forEach(function (evt) {
    els.entryForm.addEventListener(evt, function (e) {
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
    var draft = draftEntryFromForm();
    if (!draft.date || !draft.timeIn || !draft.timeOut) {
      showToast("กรุณากรอกข้อมูลให้ครบ");
      return;
    }
    if (!computeEntry(draft, state.settings)) {
      showToast("เวลาไม่ถูกต้อง");
      return;
    }
    if (editingId) {
      var idx = state.entries.findIndex(function (x) { return x.id === editingId; });
      if (idx !== -1) state.entries[idx] = Object.assign({ id: editingId }, draft);
      showToast("แก้ไขรายการแล้ว ✓");
    } else {
      draft.id = uid();
      state.entries.push(draft);
      showToast("บันทึกแล้ว ✓");
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

    els.entryCount.textContent = sorted.length ? sorted.length + " รายการ" : "";

    if (!sorted.length) {
      els.entryList.innerHTML = '<div class="empty-state">ยังไม่มีข้อมูล เริ่มบันทึกเวลาทำงานวันแรกของคุณได้เลย ✨</div>';
      return;
    }

    els.entryList.innerHTML = sorted.map(function (entry) {
      var c = computeEntry(entry, state.settings);
      var dateLabel = dfFull.format(fromISODate(entry.date));
      var noteHtml = entry.note ? '<div class="entry-item__note">' + ICON_NOTE + escapeHtml(entry.note) + "</div>" : "";
      var payLine = c ? fmtMoney(c.totalPay) : "-";
      var hoursLine = c
        ? ("ปกติ " + fmtHours(c.normalHours) + " ชม. (" + fmtMoney(c.normalPay) + ")" +
           (c.otHours > 0 ? ' · <span class="ot-val">OT ' + fmtHours(c.otHours) + " ชม. (" + fmtMoney(c.otPay) + ")</span>" : ""))
        : "ข้อมูลผิดพลาด";
      return (
        '<div class="entry-item" data-id="' + entry.id + '">' +
          '<div class="entry-item__main">' +
            '<div class="entry-item__date">' + dateLabel + "</div>" +
            '<div class="entry-item__time">' + entry.timeIn + " - " + entry.timeOut + "</div>" +
            noteHtml +
          "</div>" +
          '<div class="entry-item__hours"><b>' + payLine + "</b><br/>" + hoursLine + "</div>" +
          '<div class="entry-item__actions">' +
            '<button class="icon-btn icon-btn--tonal" data-action="edit" aria-label="แก้ไข"><span class="icon-tonal icon-tonal--sm icon-tonal--secondary"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="แก้ไข"><path d="M4 20l1-4L16 5l3 3L8 19l-4 1z"/><line x1="13.5" y1="6.5" x2="17.5" y2="10.5"/></svg></span></button>' +
            '<button class="icon-btn icon-btn--tonal" data-action="delete" aria-label="ลบ"><span class="icon-tonal icon-tonal--sm icon-tonal--danger"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="ลบ"><line x1="4" y1="7" x2="20" y2="7"/><path d="M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13"/><path d="M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></span></button>' +
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
      showConfirm("ลบรายการวันที่ " + dfShort.format(fromISODate(entry.date)) + " ใช่หรือไม่?").then(function (ok) {
        if (!ok) return;
        state.entries = state.entries.filter(function (x) { return x.id !== id; });
        saveState();
        renderEntryList();
        showToast("ลบรายการแล้ว");
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
    els.noteFormTitle.textContent = "บันทึกเหตุการณ์ล่วงหน้า";
    els.saveNoteBtn.textContent = "บันทึก";
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
    els.noteFormTitle.textContent = "แก้ไขบันทึกเหตุการณ์";
    els.saveNoteBtn.textContent = "บันทึกการแก้ไข";
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

  els.noteForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var title = els.nTitle.value.trim();
    var startDate = els.nStartDate.value;
    // Single-day note when no end date was picked: start === end, per spec.
    var endDate = els.nEndDate.value || startDate;
    if (!title || !startDate) {
      showToast("กรุณากรอกหัวข้อและวันที่เริ่ม");
      return;
    }
    if (endDate < startDate) {
      showToast("วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่ม");
      return;
    }

    var remindEnabled = els.nRemindEnabled.checked;
    var remindDate = remindEnabled ? els.nRemindDate.value : "";
    var remindTime = remindEnabled ? els.nRemindTime.value : "";
    if (remindEnabled && (!remindDate || !remindTime)) {
      showToast("กรุณาเลือกวันและเวลาแจ้งเตือน");
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
        state.workNotes[idx] = Object.assign({ id: editingNoteId }, draft);
      }
      showToast("แก้ไขบันทึกแล้ว ✓");
    } else {
      draft.id = uid();
      draft.reminderSent = false;
      state.workNotes.push(draft);
      showToast("บันทึกแล้ว ✓");
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

    els.noteCount.textContent = sorted.length ? sorted.length + " รายการ" : "";

    if (!sorted.length) {
      els.noteList.innerHTML = '<div class="empty-state">ยังไม่มีบันทึกเหตุการณ์ เพิ่มรายการแรกได้เลย ✨</div>';
      return;
    }

    els.noteList.innerHTML = sorted.map(function (note) {
      var descHtml = note.description ? '<div class="entry-item__note">' + ICON_NOTE + escapeHtml(note.description) + "</div>" : "";
      var remindHtml = (note.reminderEnabled && note.reminderDate && note.reminderTime)
        ? '<div class="entry-item__note">' + ICON_BELL + "แจ้งเตือน " +
            dfShort.format(fromISODate(note.reminderDate)) + " " + escapeHtml(note.reminderTime) + " น." + "</div>"
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
            '<button class="icon-btn icon-btn--tonal" data-action="edit" aria-label="แก้ไข"><span class="icon-tonal icon-tonal--sm icon-tonal--secondary"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="แก้ไข"><path d="M4 20l1-4L16 5l3 3L8 19l-4 1z"/><line x1="13.5" y1="6.5" x2="17.5" y2="10.5"/></svg></span></button>' +
            '<button class="icon-btn icon-btn--tonal" data-action="delete" aria-label="ลบ"><span class="icon-tonal icon-tonal--sm icon-tonal--danger"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="ลบ"><line x1="4" y1="7" x2="20" y2="7"/><path d="M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13"/><path d="M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></span></button>' +
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
      showConfirm('ลบบันทึก "' + note.title + '" ใช่หรือไม่?').then(function (ok) {
        if (!ok) return;
        state.workNotes = state.workNotes.filter(function (x) { return x.id !== id; });
        saveState();
        renderNoteList();
        showToast("ลบรายการแล้ว");
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
    if (quickRangeBtn) quickRangeBtn.textContent = summaryState.mode === "year" ? "ปีนี้" : "เดือนนี้";
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
      showToast("โหลดไลบรารี Excel ไม่สำเร็จ ลองเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่");
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
      showToast("ไม่มีข้อมูลในช่วงวันที่ที่เลือก");
      return;
    }

    var rows = entries.map(function (e) {
      var c = computeEntry(e, state.settings);
      return {
        "วันที่": e.date,
        "เวลาเข้า": e.timeIn || "",
        "เวลาออก": e.timeOut || "",
        "ชั่วโมงปกติ": c ? Math.round(c.normalHours * 100) / 100 : 0,
        "ชั่วโมง OT": c ? Math.round(c.otHours * 100) / 100 : 0,
        "เงิน OT": c ? Math.round(c.otPay * 100) / 100 : 0
      };
    });

    // Sheet 1: รายละเอียดรายวัน (ของเดิม)
    var wsDetail = XLSX.utils.json_to_sheet(rows);

    // Sheet 2: สรุปช่วงที่ export
    var rangeAgg = aggregate(entries, state.settings);
    var summaryRows = [
      { "รายการ": "ช่วงที่ export", "ค่า": startISO + " ถึง " + endISO },
      { "รายการ": "จำนวนวันที่บันทึก", "ค่า": rangeAgg.count },
      { "รายการ": "ชั่วโมงทำงานปกติ", "ค่า": Math.round(rangeAgg.normalHours * 100) / 100 },
      { "รายการ": "ชั่วโมง OT รวม", "ค่า": Math.round(rangeAgg.otHours * 100) / 100 },
      { "รายการ": "  - OT วันธรรมดา", "ค่า": Math.round(rangeAgg.otHoursWeekday * 100) / 100 },
      { "รายการ": "  - OT วันหยุด", "ค่า": Math.round(rangeAgg.otHoursWeekend * 100) / 100 },
      { "รายการ": "เงิน OT รวม", "ค่า": Math.round(rangeAgg.otPay * 100) / 100 },
      { "รายการ": "รายได้รวม (ปกติ+OT)", "ค่า": Math.round(rangeAgg.totalPay * 100) / 100 }
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
        "เดือน": dfMonthYear.format(m.d),
        "ชั่วโมงปกติ": m.normalHours,
        "ชั่วโมง OT": m.otHours,
        "เงิน OT": m.otPay,
        "รายได้รวม": m.totalPay,
        "กราฟ OT": "█".repeat(barLen) + " " + m.otHours + " ชม."
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
      "เดือน": "รวม 12 เดือน",
      "ชั่วโมงปกติ": Math.round(totals.normalHours * 100) / 100,
      "ชั่วโมง OT": Math.round(totals.otHours * 100) / 100,
      "เงิน OT": Math.round(totals.otPay * 100) / 100,
      "รายได้รวม": Math.round(totals.totalPay * 100) / 100,
      "กราฟ OT": ""
    });
    var wsCompare = XLSX.utils.json_to_sheet(compareRows);
    wsCompare["!cols"] = [{ wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 28 }];

    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsSummary, "สรุป");
    XLSX.utils.book_append_sheet(wb, wsCompare, "เปรียบเทียบ 12 เดือน");
    XLSX.utils.book_append_sheet(wb, wsDetail, "รายละเอียด");
    XLSX.writeFile(wb, "ot-tracker-" + filenameStamp + ".xlsx");
    showToast("Export Excel แล้ว ✓");
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
      if (!current) return '<span class="badge-change badge-change--flat">— ไม่มีข้อมูล' + suffixLabel + "</span>";
      return '<span class="badge-change badge-change--new">✨ ใหม่</span> ไม่มีข้อมูล' + suffixLabel;
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
    els.statTotalHours.textContent = fmtHours(agg.totalHours) + " ชม.";
    els.otWeekdayVal.textContent = fmtHours(agg.otHoursWeekday) + " ชม. · " + fmtMoney(agg.otPayWeekday);
    els.otWeekendVal.textContent = fmtHours(agg.otHoursWeekend) + " ชม. · " + fmtMoney(agg.otPayWeekend);
  }

  function updateSummaryRecorderLine() {
    var name = (state.settings.recorderName || "").trim();
    els.summaryRecorderLine.textContent = name ? "บันทึกโดย " + name : "";
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
    els.exportHint.textContent = "ดาวน์โหลดรายการบันทึกเวลาของเดือนนี้เป็นไฟล์ Excel";
    exportMonthRange = range;

    var agg = monthAgg(a.getFullYear(), a.getMonth());
    var prev = addMonths(a, -1);
    var prevAgg = monthAgg(prev.getFullYear(), prev.getMonth());

    fillStatTiles(agg);
    els.compareTotalPay.innerHTML = changeBadgeHtml(agg.totalPay, prevAgg.totalPay, "จากเดือนก่อน");
    els.compareOtHours.innerHTML = changeBadgeHtml(agg.otHours, prevAgg.otHours, "จากเดือนก่อน");
    els.compareOtPay.innerHTML = changeBadgeHtml(agg.otPay, prevAgg.otPay, "จากเดือนก่อน");

    els.chartTitle.textContent = "แนวโน้ม OT ย้อนหลัง 6 เดือน";
    els.dayListTitle.textContent = "รายวันในเดือนนี้";

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
    els.exportHint.textContent = "ดาวน์โหลดรายการบันทึกเวลาของปีนี้เป็นไฟล์ Excel";
    exportMonthRange = range;

    var agg = yearAgg(year);
    var prevAgg = yearAgg(year - 1);

    fillStatTiles(agg);
    els.compareTotalPay.innerHTML = changeBadgeHtml(agg.totalPay, prevAgg.totalPay, "จากปีก่อน");
    els.compareOtHours.innerHTML = changeBadgeHtml(agg.otHours, prevAgg.otHours, "จากปีก่อน");
    els.compareOtPay.innerHTML = changeBadgeHtml(agg.otPay, prevAgg.otPay, "จากปีก่อน");

    els.chartTitle.textContent = "OT รายเดือนของปีนี้";
    els.dayListTitle.textContent = "สรุปรายเดือนในปีนี้";

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
              'aria-label="' + m.fullLabel + " OT " + fmtHours(m.otHours) + ' ชั่วโมง" ' +
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
        fmtHours(m.otHours) + " ชม. · " + fmtMoney(m.otPay);
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
          "<span>ปกติ " + fmtHours(agg.normalHours) + " ชม.</span>" +
          "<span>" + (agg.otHours > 0 ? "OT " + fmtHours(agg.otHours) + " ชม." : "") + "</span>" +
        "</div>" +
      "</div>"
    );
  }

  function renderSummaryDays(entriesInRange) {
    if (!entriesInRange.length) {
      els.summaryDays.innerHTML = '<div class="empty-state">ไม่มีข้อมูลในช่วงนี้</div>';
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
      els.summaryDays.innerHTML = '<div class="empty-state">ไม่มีข้อมูลในปีนี้</div>';
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
    var cur = currentCurrency();
    els.sRecorderName.value = s.recorderName || "";
    els.sDefaultTimeIn.value = s.defaultTimeIn || "";
    els.sDefaultTimeOut.value = s.defaultTimeOut || "";
    els.sLockTimeIn.checked = !!s.lockTimeIn;
    els.sLockTimeOut.checked = !!s.lockTimeOut;
    els.sLockTimeOutWeekend.checked = !!s.lockTimeOutWeekend;
    updateLockToggleAvailability();
    updateCurrencyTrigger();
    els.hourlyRateLabel.textContent = "ค่าแรงต่อชั่วโมง (" + cur.symbol + " " + cur.label + ") — ใช้คำนวณ OT เท่านั้น";
    els.monthlySalaryLabel.textContent = "เงินเดือน (" + cur.symbol + " " + cur.label + ")";
    els.otGoalLabel.textContent = "เป้าหมายเงิน OT ต่อเดือน (" + cur.symbol + " " + cur.label + ")";
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
        console.error("แสดงการแจ้งเตือนไม่สำเร็จ", e);
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
    showToast("สำรองข้อมูลแล้ว");
  });

  els.importInput.addEventListener("change", function () {
    var file = els.importInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(reader.result);
        if (!parsed || !Array.isArray(parsed.entries)) throw new Error("รูปแบบไฟล์ไม่ถูกต้อง");
        showConfirm("นำเข้าข้อมูลจะแทนที่ข้อมูลปัจจุบันทั้งหมด ดำเนินการต่อหรือไม่?").then(function (ok) {
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
          showToast("นำเข้าข้อมูลสำเร็จ ✓");
          els.importInput.value = "";
        });
      } catch (err) {
        showToast("ไม่สามารถอ่านไฟล์นี้ได้");
        els.importInput.value = "";
      }
    };
    reader.readAsText(file);
  });

  els.clearBtn.addEventListener("click", function () {
    showConfirm("ล้างข้อมูลทั้งหมด (รายการเวลาทำงานทุกรายการ) จะไม่สามารถกู้คืนได้ ยืนยันหรือไม่?").then(function (ok) {
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
      showToast("ล้างข้อมูลแล้ว");
    });
  });

  /* ============================================================
   * PWA: service worker + install prompt
   * ========================================================== */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("service-worker.js").catch(function (err) {
        console.warn("ลงทะเบียน Service Worker ไม่สำเร็จ", err);
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
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
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

  function getLastSyncISO() {
    try { return localStorage.getItem(SYNC_LAST_KEY); } catch (e) { return null; }
  }

  function setLastSyncISO(iso) {
    try { localStorage.setItem(SYNC_LAST_KEY, iso); } catch (e) {}
  }

  function formatLastSync() {
    var iso = getLastSyncISO();
    return iso ? "ซิงก์ล่าสุดเมื่อ " + dfDateTime.format(new Date(iso)) : "ยังไม่เคยซิงก์";
  }

  function renderSyncStatus() {
    if (!currentUserId) {
      els.syncStatusRow.classList.add("hidden");
      els.syncErrorBanner.classList.add("hidden");
      return;
    }
    els.syncStatusRow.classList.remove("hidden");
    els.syncStatusRow.classList.remove("sync-status--syncing", "sync-status--error");
    if (syncStatus === "syncing") {
      els.syncStatusRow.classList.add("sync-status--syncing");
      els.syncStatusIcon.innerHTML = ICON_REFRESH;
      els.syncStatusText.textContent = "กำลังซิงก์...";
      els.syncRetryBtn.classList.add("hidden");
      els.syncErrorBanner.classList.add("hidden");
    } else if (syncStatus === "error") {
      els.syncStatusRow.classList.add("sync-status--error");
      els.syncStatusIcon.innerHTML = ICON_WARNING;
      els.syncStatusText.textContent = "ซิงก์ไม่สำเร็จ · " + formatLastSync();
      els.syncRetryBtn.classList.remove("hidden");
      els.syncErrorBanner.classList.remove("hidden");
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

  // Mirrors the full local state up to Supabase: upserts the single
  // settings row, then upserts every current ot_entries row and only
  // *afterwards* deletes whatever's left in the cloud that's no longer in
  // local state (rows not in the just-written id set). Upsert-then-delete
  // (rather than the old delete-then-insert) matters here: if the write
  // step fails partway (bad data, dropped connection, tab closed while the
  // fire-and-forget chain is still running), nothing has been deleted yet,
  // so a sync failure can never wipe rows that were already safely on the
  // cloud. Errors are swallowed (they only log and flag the sync status),
  // so saveState() can fire this off without a failure ever blocking or
  // breaking local editing. Resolves true only once the data has really
  // landed on the cloud and false if anything failed - any caller that
  // tells the user "uploaded ✓" must wait for that rather than assuming
  // success the moment the request goes out.
  function pushStateToCloud() {
    if (!supabaseClient || !currentUserId) return Promise.resolve(false);
    var userId = currentUserId;
    var mySeq = ++pushSeq;
    syncStatus = "syncing";
    renderSyncStatus();
    var settingsRow = { user_id: userId, data: state.settings, updated_at: new Date().toISOString() };
    var tz = detectTimeZone();
    if (tz) settingsRow.timezone = tz;
    // One snapshot per push, used for both the rows written and the id list
    // the cleanup delete keeps. Reading state.entries live inside the steps
    // below would let the two disagree: an entry added mid-flight would be
    // uploaded by the upsert and then deleted again by a filter built before
    // it existed.
    var entries = state.entries.slice();
    var notes = state.workNotes.slice();
    var entryIds = entries.map(function (e) { return e.id; });
    var noteIds = notes.map(function (n) { return n.id; });
    // Deletes are the only destructive step, and this push's id list is a
    // snapshot: once a newer push exists, that list is stale and deleting by
    // it would remove rows the newer push just wrote. Let the newest push do
    // the cleanup - it has the current data.
    function isStale() { return mySeq !== pushSeq; }
    return supabaseClient
      .from("ot_settings")
      .upsert(settingsRow)
      .then(function (res) {
        if (res.error) throw res.error;
        if (!entries.length) return null;
        return supabaseClient.from("ot_entries").upsert(entries.map(function (e) { return entryToRow(e, userId); }));
      })
      .then(function (res) {
        if (res && res.error) throw res.error;
        if (isStale()) return null;
        var del = supabaseClient.from("ot_entries").delete().eq("user_id", userId);
        if (entryIds.length) del = del.not("id", "in", "(" + entryIds.join(",") + ")");
        return del;
      })
      .then(function (res) {
        if (res && res.error) throw res.error;
        if (!notes.length) return null;
        return supabaseClient.from("work_notes").upsert(notes.map(function (n) { return noteToRow(n, userId); }));
      })
      .then(function (res) {
        if (res && res.error) throw res.error;
        if (isStale()) return null;
        var del = supabaseClient.from("work_notes").delete().eq("user_id", userId);
        if (noteIds.length) del = del.not("id", "in", "(" + noteIds.join(",") + ")");
        return del;
      })
      .then(function (res) {
        if (res && res.error) throw res.error;
        // A newer push owns the status line; don't paint "synced" over a
        // sync that is still running (or has already failed).
        if (isStale()) return true;
        setLastSyncISO(new Date().toISOString());
        syncStatus = "success";
        syncErrorNotified = false;
        renderSyncStatus();
        return true;
      })
      .catch(function (err) {
        console.error("ซิงก์ข้อมูลขึ้น cloud ไม่สำเร็จ", err);
        syncStatus = "error";
        renderSyncStatus();
        if (!syncErrorNotified) {
          syncErrorNotified = true;
          showToast("⚠️ ข้อมูลบันทึกในเครื่องแล้ว แต่ยังไม่ได้ซิงก์ขึ้น cloud (ตรวจสอบอินเทอร์เน็ต)");
        }
        return false;
      });
  }

  // Replaces local state with what's already in the cloud - used when a
  // second device/browser logs in and the cloud already has data. Writes
  // straight to localStorage (not saveState()) so this doesn't immediately
  // re-trigger a redundant push of the very data just pulled down.
  // Resolves true when it refused to apply an empty cloud copy over local
  // records (see below) and pushed the local data back up instead.
  function pullStateFromCloud(userId) {
    return Promise.all([
      supabaseClient.from("ot_settings").select("data").eq("user_id", userId).maybeSingle(),
      supabaseClient.from("ot_entries").select("*").eq("user_id", userId),
      supabaseClient.from("work_notes").select("*").eq("user_id", userId)
    ]).then(function (results) {
      var settingsRes = results[0], entriesRes = results[1], notesRes = results[2];
      if (settingsRes.error) throw settingsRes.error;
      if (entriesRes.error) throw entriesRes.error;
      if (notesRes.error) throw notesRes.error;
      if (settingsRes.data) {
        state.settings = Object.assign(clone(DEFAULT_STATE.settings), settingsRes.data.data || {});
      }
      var cloudEntries = (entriesRes.data || []).map(rowToEntry);
      var cloudNotes = (notesRes.data || []).map(rowToNote);
      // An empty list from the cloud while this device still holds records
      // means the cloud copy is broken (a sync that deleted but never
      // rewrote), not that the user erased everything. Treat it as "no
      // information" and keep the local copy: this pull writes straight to
      // localStorage, so overwriting here would destroy the last surviving
      // data on the device.
      var keptLocal = false;
      if (!cloudEntries.length && state.entries.length) keptLocal = true;
      else state.entries = cloudEntries;
      if (!cloudNotes.length && state.workNotes.length) keptLocal = true;
      else state.workNotes = cloudNotes;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      loadSettingsToForm();
      updateHeaderTitle();
      resetForm();
      renderEntryList();
      renderSummary();
      resetNoteForm();
      renderNoteList();
      checkUpcomingNoteNotifications();
      if (keptLocal) {
        showToast("⚠️ ข้อมูลบน cloud ว่างเปล่า จึงใช้ข้อมูลในเครื่องและอัปโหลดขึ้นใหม่");
        return pushStateToCloud().then(function () { return true; });
      }
      setLastSyncISO(new Date().toISOString());
      syncStatus = "success";
      syncErrorNotified = false;
      renderSyncStatus();
      return false;
    });
  }

  // First time this user id is seen: if the cloud has nothing for them
  // yet, seed it from whatever's already in localStorage on this device;
  // otherwise the cloud is treated as authoritative and overwrites local.
  function initialSyncOnLogin(userId) {
    return Promise.all([
      supabaseClient.from("ot_settings").select("user_id").eq("user_id", userId).maybeSingle(),
      supabaseClient.from("ot_entries").select("id", { count: "exact", head: true }).eq("user_id", userId)
    ]).then(function (results) {
      var settingsRes = results[0], entriesCountRes = results[1];
      if (settingsRes.error) throw settingsRes.error;
      if (entriesCountRes.error) throw entriesCountRes.error;
      var cloudEmpty = !settingsRes.data && !entriesCountRes.count;
      if (cloudEmpty) {
        // Wait for the upload to actually land before claiming it did - the
        // old code fired this off and announced success in the same breath,
        // so a failed upload still told the user their data was safe.
        return pushStateToCloud().then(function (ok) {
          if (ok) showToast("อัปโหลดข้อมูลขึ้น cloud แล้ว ✓");
        });
      }
      return pullStateFromCloud(userId).then(function (keptLocal) {
        if (!keptLocal) showToast("ดึงข้อมูลจาก cloud แล้ว ✓");
      });
    }).catch(function (err) {
      console.error("ซิงก์ข้อมูลเริ่มต้นไม่สำเร็จ", err);
      syncStatus = "error";
      renderSyncStatus();
      if (!syncErrorNotified) {
        syncErrorNotified = true;
        showToast("⚠️ ข้อมูลบันทึกในเครื่องแล้ว แต่ยังไม่ได้ซิงก์ขึ้น cloud (ตรวจสอบอินเทอร์เน็ต)");
      }
    });
  }

  function handleAuthChange(session) {
    renderAuthState(session);
    var userId = session ? session.user.id : null;
    if (userId && userId !== currentUserId) {
      currentUserId = userId;
      syncStatus = "syncing";
      syncErrorNotified = false;
      renderSyncStatus();
      // Wait for the cloud settings pull to land before syncing the
      // notification UI, so the leave-work toggle reflects the authoritative
      // cloud notifyEnabled value (not a stale local one) and the push
      // self-heal runs against the right account.
      initialSyncOnLogin(userId).then(syncNotificationUI);
    } else if (!userId) {
      currentUserId = null;
      syncStatus = "idle";
      renderSyncStatus();
      syncNotificationUI();
    } else {
      renderSyncStatus();
      syncNotificationUI();
    }
  }

  if (supabaseClient) {
    els.googleLoginBtn.addEventListener("click", function () {
      supabaseClient.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin + window.location.pathname }
      });
    });

    els.logoutBtn.addEventListener("click", function () {
      supabaseClient.auth.signOut();
    });

    els.syncRetryBtn.addEventListener("click", function () {
      pushStateToCloud();
    });

    // Auto-retry as soon as connectivity comes back, but only if there's
    // actually a failed sync to retry - a healthy connection firing this
    // event (e.g. switching wifi networks) shouldn't trigger extra pushes.
    window.addEventListener("online", function () {
      if (currentUserId && syncStatus === "error") pushStateToCloud();
    });

    supabaseClient.auth.getSession().then(function (result) {
      handleAuthChange(result.data.session);
    });

    supabaseClient.auth.onAuthStateChange(function (_event, session) {
      handleAuthChange(session);
    });
  } else {
    els.googleLoginBtn.disabled = true;
    els.googleLoginBtn.textContent = "ต้องเชื่อมต่ออินเทอร์เน็ตเพื่อเข้าสู่ระบบ";
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
        ? "อุปกรณ์นี้ไม่รองรับ หรือถ้าใช้ iPhone ต้องกด Add to Home Screen ก่อน (Safari → แชร์ → เพิ่มไปยังหน้าจอโฮม)"
        : "ต้องเข้าสู่ระบบก่อนจึงจะเปิดใช้ได้ — เมื่อเปิด เบราว์เซอร์จะลงทะเบียนรับ push ให้อุปกรณ์นี้ ทำงานได้แม้ปิดแอปหรือแท็บนี้ไปแล้ว";
      return;
    }

    els.sPushEnabled.disabled = false;
    els.pushRow.classList.remove("is-disabled");

    ensurePushSubscription().then(function (subscribed) {
      els.sPushEnabled.checked = subscribed;
      var perm = notificationPermission();
      if (state.settings.notifyEnabled && !subscribed) {
        els.pushHint.textContent = perm === "denied"
          ? "⚠️ แจ้งเตือนจดบันทึก OT เปิดอยู่ แต่อุปกรณ์นี้บล็อกการแจ้งเตือน — เปิดสิทธิ์แจ้งเตือนของเว็บนี้ในตั้งค่าเบราว์เซอร์ แล้วกลับมาเปิดสวิตช์ Push ด้านบนอีกครั้ง"
          : "⚠️ แจ้งเตือนจดบันทึก OT เปิดอยู่ แต่อุปกรณ์นี้ยังไม่ได้รับ push — แตะสวิตช์ Push ด้านบนเพื่อเปิดรับบนอุปกรณ์นี้";
      } else if (subscribed) {
        els.pushHint.textContent = "เปิดใช้แล้วสำหรับอุปกรณ์นี้ จะได้รับการแจ้งเตือนแม้ปิดแอปหรือแท็บนี้ไปแล้ว";
      } else if (perm === "denied") {
        els.pushHint.textContent = "อุปกรณ์นี้บล็อกการแจ้งเตือนอยู่ — เปิดสิทธิ์แจ้งเตือนของเว็บนี้ในตั้งค่าเบราว์เซอร์ก่อน";
      } else {
        els.pushHint.textContent = "เมื่อเปิด เบราว์เซอร์จะขอสิทธิ์การแจ้งเตือนและลงทะเบียนรับ push ให้อุปกรณ์นี้ ทำงานได้แม้ปิดแอปหรือแท็บนี้ไปแล้ว";
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
      showToast("บันทึกการตั้งค่าแล้ว แต่อุปกรณ์นี้ไม่รองรับ push (iPhone ต้อง Add to Home Screen ก่อน)");
      syncNotificationUI();
      return;
    }
    var perm = notificationPermission();
    if (perm === "granted") {
      ensurePushSubscription().then(function (sub) {
        showToast(sub ? "เปิดแจ้งเตือนจดบันทึก OT แล้ว ✓" : "บันทึกแล้ว แต่ยังลงทะเบียน push บนอุปกรณ์นี้ไม่สำเร็จ");
        syncNotificationUI();
      });
      return;
    }
    if (perm === "denied") {
      showToast("บันทึกแล้ว — แต่อุปกรณ์นี้บล็อกการแจ้งเตือน เปิดสิทธิ์ในตั้งค่าเบราว์เซอร์เพื่อรับบนเครื่องนี้");
      syncNotificationUI();
      return;
    }
    Notification.requestPermission().then(function (p) {
      if (p === "granted") {
        subscribeToPush()
          .then(function () { showToast("เปิดแจ้งเตือนจดบันทึก OT แล้ว ✓"); })
          .catch(function (err) { console.error("สมัครรับ Push ไม่สำเร็จ", err); })
          .finally(syncNotificationUI);
      } else {
        showToast("บันทึกแล้ว — แต่ยังไม่ได้อนุญาตแจ้งเตือน จะได้รับเมื่ออนุญาตสิทธิ์ในเบราว์เซอร์");
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
        showToast("ปิดการแจ้งเตือนแบบ Push บนอุปกรณ์นี้แล้ว");
      }).catch(function (err) {
        console.error("ยกเลิกการสมัครรับ Push ไม่สำเร็จ", err);
      }).finally(syncNotificationUI);
      return;
    }

    if (!pushSupported()) {
      showToast("อุปกรณ์นี้ไม่รองรับ หรือถ้าใช้ iPhone ต้องกด Add to Home Screen ก่อน (Safari → แชร์ → เพิ่มไปยังหน้าจอโฮม)");
      syncNotificationUI();
      return;
    }
    if (!currentUserId) {
      showToast("กรุณาเข้าสู่ระบบก่อนเปิดการแจ้งเตือนแบบ Push");
      syncNotificationUI();
      return;
    }

    Notification.requestPermission().then(function (permission) {
      if (permission !== "granted") {
        showToast("การแจ้งเตือนถูกปฏิเสธ กรุณาเปิดสิทธิ์การแจ้งเตือนสำหรับเว็บนี้ในตั้งค่าเบราว์เซอร์ก่อน");
        syncNotificationUI();
        return;
      }
      subscribeToPush()
        .then(function () { showToast("เปิดการแจ้งเตือนแบบ Push แล้ว ✓"); })
        .catch(function (err) {
          console.error("สมัครรับ Push ไม่สำเร็จ", err);
          showToast("เปิดการแจ้งเตือนแบบ Push ไม่สำเร็จ");
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
      showToast("ปิดแจ้งเตือนจดบันทึก OT แล้ว");
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
