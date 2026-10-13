import {createPublicKey,createPrivateKey,publicEncrypt,privateDecrypt,randomBytes,createHash,type KeyObject} from 'node:crypto';
import {sealLedgerBackup,openLedgerBackup,type PrivateLedgerBackup} from './private-ledger-backup.js';
import {sealApplicationBackup,openApplicationBackup,type ApplicationBackup} from './application-ledger-backup.js';
const magic=Buffer.from('fub-ledger-archive:v1\0'),wrappedLength=384;
const headerLength=magic.length+1+32,limit=34*1024*1024;
export type LedgerKind='private'|'application';
export function archivePublicKey(encoded:string){
 if(!/^[A-Za-z0-9+/]+=*$/.test(encoded)||encoded.length>2048)throw Error('Invalid archive public key.');
 const key=createPublicKey({key:Buffer.from(encoded,'base64'),format:'der',type:'spki'});
 if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails?.modulusLength!==3072)throw Error('Archive key must be RSA-3072.');
 return key;
}
function fingerprint(key:KeyObject){return createHash('sha256').update(key.export({format:'der',type:'spki'}) as Buffer).digest();}
export function sealLedgerArchive(kind:LedgerKind,value:PrivateLedgerBackup|ApplicationBackup,encodedPublicKey:string){
 const publicKey=archivePublicKey(encodedPublicKey),key=randomBytes(32);
 const header=Buffer.concat([magic,Buffer.from([kind==='private'?1:2]),fingerprint(publicKey)]);
 try{
  const body=kind==='private'?sealLedgerBackup(value as PrivateLedgerBackup,key):sealApplicationBackup(value as ApplicationBackup,key);
  const wrapped=publicEncrypt({key:publicKey,oaepHash:'sha256',oaepLabel:header},key);
  if(wrapped.length!==wrappedLength)throw Error('Unexpected wrapped key length.');
  return Buffer.concat([header,wrapped,body]);
 }finally{key.fill(0);}
}
// Operator-only decryption. Hosts receive only the public key, never this input.
export function openLedgerArchive(bytes:Buffer,privatePem:string):{kind:LedgerKind;value:PrivateLedgerBackup|ApplicationBackup}{
 let key:Buffer|undefined;
 try{
  if(bytes.length>limit||bytes.length<headerLength+wrappedLength+29||!bytes.subarray(0,magic.length).equals(magic))throw Error();
  const kind=bytes[magic.length];if(kind!==1&&kind!==2)throw Error();
  const privateKey=createPrivateKey(privatePem),publicKey=createPublicKey(privateKey);
  if(privateKey.asymmetricKeyDetails?.modulusLength!==3072||!fingerprint(publicKey).equals(bytes.subarray(magic.length+1,headerLength)))throw Error();
  key=privateDecrypt({key:privateKey,oaepHash:'sha256',oaepLabel:bytes.subarray(0,headerLength)},bytes.subarray(headerLength,headerLength+wrappedLength));
  const body=bytes.subarray(headerLength+wrappedLength);
  return kind===1?{kind:'private',value:openLedgerBackup(body,key)}:{kind:'application',value:openApplicationBackup(body,key)};
 }catch{throw Error('Ledger archive authentication failed.');}finally{key?.fill(0);}
}
