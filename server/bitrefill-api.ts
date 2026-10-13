import type {IncomingMessage,ServerResponse} from 'node:http';
import {bitrefillCatalog,validBitrefillProduct} from './bitrefill-catalog.js';
export function bitrefillHandler(service:Pick<ReturnType<typeof bitrefillCatalog>,'search'|'details'>=bitrefillCatalog()){
 let active=0,start=0,calls=0;
 return async(req:IncomingMessage,res:ServerResponse)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const send=(status:number,data:unknown)=>{res.statusCode=status;res.end(JSON.stringify(data));};
  if(req.method!=='GET'){res.setHeader('Allow','GET');return send(405,{message:'Catalog reads only.'});}
  const q=new URL(req.url||'/','https://localhost').searchParams,keys=[...q.keys()].sort().join(','),id=q.get('id');
  if(id?keys!=='id'||!validBitrefillProduct(id):keys!=='country,page,q'||!/^[A-Z]{2}$/.test(q.get('country')||'')||!/^([1-9]|[1-9][0-9])$/.test(q.get('page')||'')||(q.get('q')||'').length>80||/[\x00-\x1f\x7f]/.test(q.get('q')||''))return send(400,{message:'Check the country and search.'});
  if(Date.now()-start>60000){start=Date.now();calls=0;}if(active>=3||calls>=40){res.setHeader('Retry-After','5');return send(429,{message:'The catalog is busy. Try again shortly.'});}calls++;active++;
  try{return send(200,id?await service.details(id):await service.search(q.get('q')!.trim(),q.get('country')!,Number(q.get('page'))));}catch{return send(503,{message:'Bitrefill’s catalog is temporarily unavailable. You can still browse on Bitrefill.'});}finally{active--;}
 };
}
export const handleBitrefill=bitrefillHandler();
