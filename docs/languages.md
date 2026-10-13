# Languages
OT Fast offers 11 display-language options: ไทย, English, 한국어, 日本語, 简体中文, 繁體中文, Tiếng Việt, မြန်မာ, Bahasa Indonesia, Filipino and नेपाली. These represent 10 languages with two Chinese writing-system options.

Choose the globe/language menu in the header before or after sign-in, or Settings → Display language. Thai remains the default for existing visitors. The browser remembers a visitor's choice; after sign-in, a saved account language takes precedence and travels with the account's existing settings JSON. No SQL migration or translation API key is needed.

The interface, validation messages, dates/month names, Excel column/sheet names and standard reminder text are localized. Changing language preserves typed forms, user-entered names/notes, recorded times, currency, hourly rates and the holiday country. Numeric spreadsheet values remain numbers. Inputs continue accepting ordinary 0–9 digits. Public-holiday proper names retain their source name when no English equivalent exists.

Translations are bundled and included in the offline app shell. They do not use an online AI translation service. New releases require Ctrl+Shift+R to receive the updated app shell.

## Maintaining translations
- Source: scripts/i18n-source.json. Each message row contains the original Thai source, English and native locale text; aliases combine shared labels or fixed symbols.
- Run: node scripts/build-i18n.js
- Verify: node scripts/build-i18n.js --check and node scripts/check-i18n.js
- Browser checks: npx playwright test tests/i18n.spec.js --workers=2
- Add a locale consistently to the source, client controls and supabase/functions/_shared/i18n.mjs.

Web Push text reads ot_settings.data.language. The existing Deploy Edge Functions workflow publishes the reminder functions after changes on main, using the owner's configured SUPABASE_ACCESS_TOKEN. Check that the deploy steps actually ran; a skipped deployment leaves previously deployed server reminder text in place. Keep --no-verify-jwt for the scheduled functions: they check X-Reminder-Auth themselves.

Automated UI checks cover all locale options, signed-out use, saved preferences across devices and account switches, drafts, spreadsheet data and cloud outages. Native-speaker feedback can improve wording without changing OT calculation or stored records.
