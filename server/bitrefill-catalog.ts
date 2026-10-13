import { decode } from '@toon-format/toon';
import { reserveProviderSlot } from './provider-budget.js';
const origin='https://api.bitrefill.com';
const record=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const text=(v:unknown,max=200)=>typeof v==='string'?v.slice(0,max):'';
export const validBitrefillProduct=(v:unknown):v is string=>typeof v==='string'&&/^[a-z0-9][a-z0-9_-]{0,159}$/.test(v);
export function bitrefillLink(v:unknown){try{const u=new URL(String(v));if(u.origin==='https://www.bitrefill.com'&&!u.username&&!u.password&&!u.port)return u.href;}catch{}throw Error('Invalid Bitrefill product link.');}
export function decodeBitrefillResponse(raw:string){
 let envelope:Record<string,unknown>;
 try{const payload=raw.trimStart().startsWith('{')?raw:raw.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).find(l=>l.startsWith('{'));envelope=record(JSON.parse(payload||''));}catch{throw Error('Invalid Bitrefill response.');}
 const result=record(envelope.result);if(envelope.error||result.isError||!Array.isArray(result.content))throw Error('Bitrefill catalog unavailable.');
 const blocks=result.content.map(record).filter(b=>b.type==='text'&&typeof b.text==='string');
 if(blocks.length!==1)throw Error('Invalid Bitrefill catalog.');
 const value=blocks[0].text as string;
 return record(value.trimStart().startsWith('{')?JSON.parse(value):decode(value));
}
export function normalizeBitrefillSearch(value:Record<string,unknown>){
 if(!Array.isArray(value.products)||value.products.length>24||!Number.isSafeInteger(value.found)||Number(value.found)<0)throw Error('Invalid Bitrefill products.');
 return {products:value.products.map(item=>{const p=record(item);if(!validBitrefillProduct(p.slug)||!text(p.name)||typeof p.in_stock!=='boolean'||!Array.isArray(p.countries)||!p.countries.every(c=>typeof c==='string'&&/^[A-Z]{2}$/.test(c)))throw Error('Invalid Bitrefill product.');return {id:p.slug,name:text(p.name),countries:p.countries,currency:text(p.currency,8),inStock:p.in_stock,url:bitrefillLink(p.product_url)};}),found:value.found,page:value.page,checkedAt:Date.now()};
}
export function normalizeBitrefillDetails(value:Record<string,unknown>,id:string){
 if(value.id!==id||!text(value.name)||typeof value.in_stock!=='boolean')throw Error('Invalid Bitrefill product details.');
 const methods=record(value.payment_methods).address_based;
 return {id,name:text(value.name),currency:text(value.currency,8),inStock:value.in_stock,url:bitrefillLink(value.url),note:text(value.specialNote,1000),subtitle:text(value.subtitles,500),recipientType:text(value.recipient_type,30),requiresPrepayment:!!value.prepayment,country:text(value.country_code,2),terms:text(value.termsConditions,4000),paymentMethods:Array.isArray(methods)?methods.filter(m=>m==='solana'||m==='usdc_solana'):[],packages:(Array.isArray(value.packages)?value.packages:[]).slice(0,100).map(item=>{const p=record(item);return {value:text(p.package_value,100),currency:text(p.package_currency,8),price:text(p.payment_price,40),priceCurrency:text(p.payment_currency,8)};}).filter(p=>p.value&&/^(0|[1-9]\d*)(\.\d+)?$/.test(p.price)),checkedAt:Date.now()};
}
async function boundedBody(r:Response){if(!r.body)throw Error('Empty provider response.');let size=0;const chunks:Uint8Array[]=[],reader=r.body.getReader();try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>512*1024)throw Error('Provider response too large.');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}return Buffer.concat(chunks).toString('utf8');}
export function bitrefillCatalog(options:{env?:()=>Record<string,string|undefined>;fetch?:typeof fetch;reserve?:()=>Promise<number>}={}){
 const env=options.env||(()=>process.env),request=options.fetch||fetch;
 let token:{value:string;expires:number}|null=null,refresh:Promise<string>|null=null;
 const cache=new Map<string,{until:number;value:Record<string,unknown>}>(),pending=new Map<string,Promise<Record<string,unknown>>>();
 async function access(){if(token&&token.expires>Date.now()+60000)return token.value;if(refresh)return refresh;
  refresh=(async()=>{const e=env();if(!e.BITREFILL_CLIENT_ID||!e.BITREFILL_CLIENT_SECRET)throw Error('Bitrefill access is not configured.');const r=await request(origin+'/oauth/mcp/token',{method:'POST',body:new URLSearchParams({grant_type:'client_credentials',client_id:e.BITREFILL_CLIENT_ID,client_secret:e.BITREFILL_CLIENT_SECRET,scope:'mcp',resource:origin+'/mcp'}),redirect:'error',signal:AbortSignal.timeout(12000)});if(!r.ok){await r.body?.cancel();throw Error('Bitrefill access unavailable.');}const data=record(JSON.parse(await boundedBody(r)));if(typeof data.access_token!=='string'||data.access_token.length>8000||typeof data.expires_in!=='number'||data.expires_in<120)throw Error('Invalid Bitrefill access.');token={value:data.access_token,expires:Date.now()+Math.min(data.expires_in,21600)*1000};return token.value;})().finally(()=>{refresh=null;});return refresh;
 }
 async function call(name:'search-products'|'get-product-details'|'buy-products'|'get-invoice-by-id',args:Record<string,unknown>){
  const cached=name==='search-products'||name==='get-product-details';
  const key=cached?JSON.stringify([name,args]):'',hit=cached?cache.get(key):undefined;if(hit&&hit.until>Date.now())return hit.value;if(cached&&pending.has(key))return pending.get(key)!;
  const task=(async()=>{const token=await access(),wait=await (options.reserve||(()=>{const url=env().DATABASE_URL;if(!url)throw Error('Provider budget unavailable.');return reserveProviderSlot(url,'bitrefill-catalog');}))();if(wait)await new Promise(r=>setTimeout(r,wait));
   const r=await request(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}),redirect:'error',signal:AbortSignal.timeout(15000)});
   if(!r.ok){await r.body?.cancel();throw Error('Bitrefill catalog unavailable.');}const value=decodeBitrefillResponse(await boundedBody(r));if(cached){if(cache.size>=100)cache.delete(cache.keys().next().value!);cache.set(key,{value,until:Date.now()+60000});}return value;
  })().finally(()=>{if(cached)pending.delete(key);});if(cached)pending.set(key,task);return task;
 }
 return {async createInvoice(product:string,value:string,email:string){return call('buy-products',{cart_items:[{product_id:product,package_value:value}],payment_method:'usdc_solana',email,return_payment_link:false});},async invoice(id:string,accessToken:string){return call('get-invoice-by-id',{invoice_id:id,invoice_access_token:accessToken});},async search(query:string,country:string,page:number){return normalizeBitrefillSearch(await call('search-products',{query:query||'*',intent:'Browse gift cards to spend from a Solana wallet',country,product_type:'giftcard',in_stock:true,page,per_page:12}));},async details(id:string){return normalizeBitrefillDetails(await call('get-product-details',{product_id:id,language:'en',currency:'USD'}),id);}};
}
