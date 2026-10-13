import {matchesFubOrigin} from '../src/fub-origin.js';
import { createPublicKey, verify, createHash } from 'node:crypto';
import bs58 from 'bs58';
import { directExitMessage, type DirectExitTerms } from '../src/direct-exits.js';
export function verifyDirectExit(t: DirectExitTerms, signature: string, origin: string) {
  const message=directExitMessage(t);
  if(!matchesFubOrigin(t.origin,origin) || typeof signature!=='string' || signature.length>88)throw Error('Exit authorization refused.');
  const bytes=bs58.decode(signature),key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),bs58.decode(t.wallet)]),format:'der',type:'spki'});
  if(bytes.length!==64||bs58.encode(bytes)!==signature||!verify(null,Buffer.from(message),key,bytes))throw Error('Exit authorization refused.');
  return createHash('sha256').update(message).digest('hex');
}
