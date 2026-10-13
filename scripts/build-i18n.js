const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const source = JSON.parse(fs.readFileSync(path.join(__dirname, "i18n-source.json"), "utf8"));
function buildCatalog(source) {
 const {rows,aliases,locales}=source;
 function resolve(id,code,seen=[]){
  const r=rows[id];if(!r)throw Error("Missing row "+id);
  if(Object.hasOwn(r,code))return r[code];
  const a=aliases[id];if(!a)throw Error("Missing "+code+" row "+id+" "+r.en);
  if(seen.includes(id))throw Error("Alias cycle");seen=seen.concat(id);
  if(Object.hasOwn(a,"literal"))return a.literal;
  if(Object.hasOwn(a,"weekday"))return new Intl.DateTimeFormat(locales.find(x=>x.code===code).locale,{weekday:"short",timeZone:"UTC"}).format(new Date(Date.UTC(2024,0,1+a.weekday)));
  return a.parts.map(p=>typeof p==="number"?resolve(p,code,seen):p).join("");
 }
 const messages={};for(const[id,r]of Object.entries(rows)){if(messages[r.th])throw Error("Duplicate source "+id+" "+r.th);messages[r.th]=locales.map(l=>resolve(+id,l.code));}
 return {locales,messages};
}
const catalog = buildCatalog(source);
const output = "// Generated from scripts/i18n-source.json. Run node scripts/build-i18n.js to regenerate.\nwindow.OT_I18N_CATALOG = " + JSON.stringify(catalog) + ";\n";
const target = path.join(root, "js/i18n-catalog.js");
if (process.argv.includes("--check")) {
  if (fs.readFileSync(target, "utf8") !== output) throw new Error("Regenerate js/i18n-catalog.js");
  console.log("Complete catalog: " + Object.keys(catalog.messages).length + " messages × " + catalog.locales.length + " locales");
} else fs.writeFileSync(target, output);
