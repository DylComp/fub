import {isMint} from './assets.js';
export function tokenKeyFromHash(hash:string){const key=hash.startsWith('#tokens/')?hash.slice(8):'';return isMint(key)||/^[a-f0-9]{64}$/.test(key)?key:null;}
export const tokenPagePath=(key:string)=>{if(!isMint(key)&&!/^[a-f0-9]{64}$/.test(key))throw Error('Invalid token link');return `#tokens/${key}`;};
