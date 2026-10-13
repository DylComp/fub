import {publicProviderJson} from './public-provider-json.js';
import {isEvmAddress} from '../src/networks.js';
// Credentials never leave this fixed server-side origin. Quote JSON cannot
// choose an endpoint, forward credentials, or supply a redirect destination.
export function cashRelay(fetcher:typeof fetch=fetch, key=process.env.RELAY_API_KEY||'') {
  if(key && !/^[\x21-\x7e]{8,512}$/.test(key)) throw Error('Relay access is not configured.');
  async function request(path:string,body?:unknown){
    const response=await fetcher(`https://api.relay.link${path}`,{method:body?'POST':'GET',
      headers:{...(body?{'Content-Type':'application/json'}:{}),...(key?{'x-api-key':key}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
    return publicProviderJson(response);
  }
  return {quote:(body:unknown)=>request('/quote/v2',body),requests:(filter:{fillTxHash:string}|({recipient:string}|{user:string})&{continuation?:string;startTimestamp?:number;endTimestamp?:number})=>{
    const query=new URLSearchParams({limit:'20'});
    if('fillTxHash' in filter){
      if(!/^0x[0-9a-f]{64}$/i.test(filter.fillTxHash))throw Error('Invalid Relay fill.');
      query.set('fillTxHash',filter.fillTxHash);
    }else{
      const field='recipient' in filter?'recipient':'user',address='recipient' in filter?filter.recipient:filter.user;
      if(!isEvmAddress(address))throw Error('Invalid Relay wallet.');
      query.set(field,address.toLowerCase());query.set('sortBy','updatedAt');query.set('sortDirection','asc');
      for(const field of ['startTimestamp','endTimestamp'] as const)if(filter[field]!==undefined){if(!Number.isSafeInteger(filter[field])||filter[field]!<0)throw Error('Invalid Relay time window.');query.set(field,String(filter[field]));}
      if(filter.startTimestamp!==undefined&&filter.endTimestamp!==undefined&&filter.startTimestamp>filter.endTimestamp)throw Error('Invalid Relay time window.');
      if(filter.continuation!==undefined){if(typeof filter.continuation!=='string'||!filter.continuation.length||filter.continuation.length>2048||/[\x00-\x1f]/.test(filter.continuation))throw Error('Invalid Relay cursor.');query.set('continuation',filter.continuation);}
    }
    return request('/requests/v3?'+query.toString());
  },status:(id:string)=>{
    if(!/^0x[0-9a-f]{64}$/i.test(id))throw Error('Invalid Relay request.');
    return request(`/intents/status/v3?requestId=${id}`);
  }};
}
