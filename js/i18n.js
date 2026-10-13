(function () {
  "use strict";
  var catalog = window.OT_I18N_CATALOG;
  if (!catalog) return; // app.js provides a safe legacy-shell fallback
  var PREF_KEY = "ot-tracker-language-v1";
  var codes = catalog.locales.map(function (locale) { return locale.code; });
  var current = "th";
  try { var saved = localStorage.getItem(PREF_KEY); if (codes.indexOf(saved) !== -1) current = saved; } catch (e) {}
  var bindings = [];
  var originals = Object.create(null);
  Object.keys(catalog.messages).forEach(function (source) {
    catalog.messages[source].forEach(function (translation) {
      if (translation) originals[translation] = source;
    });
  });
  function canonical(value) { return originals[value] || value; }
  var keys = Object.keys(catalog.messages).filter(function (key) {
    return key.length > 1 && /[\u0e01-\u0e3a\u0e40-\u0e4e]/.test(key);
  }).sort(function (a, b) { return b.length - a.length; });
  function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  var matcher = new RegExp(keys.map(escapeRegex).join("|"), "g");
  function supported(code) { return codes.indexOf(code) !== -1; }
  function info() { return catalog.locales[codes.indexOf(current)]; }
  function text(value) {
    value = String(value);
    if (current === "th") return value;
    var column = codes.indexOf(current);
    if (Object.prototype.hasOwnProperty.call(catalog.messages, value)) return catalog.messages[value][column];
    // Only developer-authored strings are passed here. User-entered names,
    // notes and descriptions are never sent through this translator.
    return value.replace(matcher, function (source) { return catalog.messages[source][column]; });
  }
  function applyStatic() {
    document.documentElement.lang = current;
    document.documentElement.dataset.language = current;
    bindings.forEach(function (binding) {
      var actual = binding.attr ? binding.node.getAttribute(binding.attr) : binding.node.nodeValue;
      // A runtime renderer may have replaced this label. Do not restore an
      // obsolete placeholder over a live status, date or user-entered value.
      if (actual !== binding.rendered && actual !== binding.source) return;
      var translated = text(binding.source);
      if (binding.attr) binding.node.setAttribute(binding.attr, translated);
      else binding.node.nodeValue = translated;
      binding.rendered = translated;
    });
    document.querySelectorAll("[data-language-select]").forEach(function (select) { select.value = current; });
  }
  function set(code, source) {
    if (!supported(code)) return false;
    var changed = current !== code;
    current = code;
    try { localStorage.setItem(PREF_KEY, code); } catch (e) {}
    applyStatic();
    if (changed) window.dispatchEvent(new CustomEvent("ot:languagechange", { detail: { language: code, source: source || "account" } }));
    return true;
  }
  function capture() {
    var walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (!node.parentElement || node.parentElement.closest("script,style,[data-i18n-ignore]")) continue;
      if (/[\u0e01-\u0e3a\u0e40-\u0e4e]/.test(node.nodeValue)) {
        bindings.push({ node: node, source: node.nodeValue, rendered: node.nodeValue });
      }
    }
    document.querySelectorAll("[aria-label],[placeholder],[title],meta[name=description]").forEach(function (el) {
      ["aria-label", "placeholder", "title", "content"].forEach(function (attr) {
        var value = el.getAttribute(attr);
        if (value && /[\u0e01-\u0e3a\u0e40-\u0e4e]/.test(value)) bindings.push({ node: el, attr: attr, source: value, rendered: value });
      });
    });
    document.querySelectorAll("[data-language-select]").forEach(function (select) {
      catalog.locales.forEach(function (locale) {
        var option = document.createElement("option");
        option.value = locale.code; option.textContent = locale.label;
        select.appendChild(option);
      });
      select.addEventListener("change", function () { set(select.value, "user"); });
    });
    applyStatic();
  }
  window.OTI18N = {
    t: text, set: set, supported: supported, canonical: canonical,
    current: function () { return current; },
    locale: function () { return info().locale; },
    locales: catalog.locales,
    sheetName: function (source) {
      // Excel limits names to 31 UTF-16 code units and excludes these symbols.
      return text(source).replace(/[\\/?*\[\]:]/g, " ").slice(0, 31);
    }
  };
  capture();
})();
