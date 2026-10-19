import { require } from "./h.mjs";
import { readFileSync, writeFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync("$NOPM_UAT_ENV","utf8").split(/\r?\n/).map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2]]));
const { createClient } = require("@supabase/supabase-js");
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY,{auth:{persistSession:false}});
const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const who = {admin:"admin@example.com",demo:"demo@example.com","uat-a-member":"uat-a-member@example.com","priya.nair":"priya.nair@stillnotbald.com","daniel.okoro":"daniel.okoro@stillnotbald.com"};
for (const [f,email] of Object.entries(who)) {
  const gl = await admin.auth.admin.generateLink({type:"magiclink",email});
  if (gl.error) { console.log(f,"ERR",gl.error.message); continue; }
  let v = await anon.auth.verifyOtp({type:"email",token_hash:gl.data.properties.hashed_token});
  if (v.error) v = await anon.auth.verifyOtp({type:"magiclink",token_hash:gl.data.properties.hashed_token});
  if (v.error) { console.log(f,"ERR",v.error.message); continue; }
  const val = "base64-"+Buffer.from(JSON.stringify(v.data.session)).toString("base64url");
  const name = `sb-${ref}-auth-token`;
  const pairs = val.length<=3180?[[name,val]]:Array.from({length:Math.ceil(val.length/3180)},(_,n)=>[`${name}.${n}`,val.slice(n*3180,n*3180+3180)]);
  writeFileSync(`session-${f}.json`, JSON.stringify(pairs.map(([k,x])=>({name:k,value:x}))));
  console.log(f,"ok");
}
