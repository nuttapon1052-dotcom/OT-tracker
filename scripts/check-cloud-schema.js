const fs=require('node:fs');
 const source=fs.readFileSync('js/app.js','utf8');
 const url=source.match(/var SUPABASE_URL = "([^"]+)"/)[1];
 const key=source.match(/var SUPABASE_KEY = "([^"]+)"/)[1];
 const columns={
  ot_settings:'user_id,data,updated_at,timezone',
  ot_entries:'id,user_id,date,time_in,time_out,ot_multiplier,note,updated_at,deleted_at',
  work_notes:'id,user_id,title,description,start_date,end_date,reminder_enabled,reminder_date,reminder_time,reminder_sent,updated_at,deleted_at'
 };
 async function probe(path,label){
  try{
   const response=await fetch(url+path,{headers:{apikey:key},signal:AbortSignal.timeout(20000)});
   const body=await response.text();
   if(!response.ok){
    let message;try{const e=JSON.parse(body);message=[e.code,e.message,e.msg].filter(Boolean).join(' ');}catch{message=body.slice(0,250);}
    console.error(label+': HTTP '+response.status+' '+message);return false;
   }
   console.log(label+': HTTP '+response.status+' OK');return true;
  }catch(e){console.error(label+': '+e.message);return false;}
 }
function checkPublishedClient(){
 const repo=process.env.GITHUB_REPOSITORY||'';
 const branch=repo.endsWith('/ot-tracker-dev')?'master':'main';
 if(process.env.GITHUB_REF!=='refs/heads/'+branch)return Promise.resolve(true);
 const [owner,name]=repo.split('/');
 const address='https://'+owner+'.github.io/'+name+'/js/app.js';
 const crypto=require('node:crypto');
 const expected=crypto.createHash('sha256').update(source).digest('hex');
 return (async()=>{
  for(let attempt=1;attempt<=24;attempt++){
   try{
    const response=await fetch(address+'?deploy='+process.env.GITHUB_SHA+'&attempt='+attempt,{signal:AbortSignal.timeout(5000),cache:'no-store'});
    if(response.ok){
     const actual=crypto.createHash('sha256').update(await response.text()).digest('hex');
     if(actual===expected){console.log('Published client: HTTP 200 exact validated app.js hash matches at '+address);return true;}
    }
   }catch(err){console.log('Published client request: '+err.message);}
   console.log('Waiting for GitHub Pages to publish the validated client ('+attempt+'/24)');
   if(attempt<24)await new Promise(resolve=>setTimeout(resolve,5000));
  }
  console.error('GitHub Pages is still serving a different client. Check the configured publishing branch.');
  return false;
 })();
}
 (async()=>{
  console.log('Read-only checks: authentication availability and schema names; REST requests use limit=0 and never read user records.');
  const checks=await Promise.all([
   probe('/auth/v1/settings','Auth'),
   ...Object.entries(columns).map(([table,fields])=>probe('/rest/v1/'+table+'?select='+encodeURIComponent(fields)+'&limit=0',table))
  ]);
  if(checks.some(ok=>!ok))process.exitCode=1;
  if(!await checkPublishedClient())process.exitCode=1;
 })();
