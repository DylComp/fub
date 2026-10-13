// This stores only a new coin's mint signer, never a user's wallet key. Keeping
// its non-extractable CryptoKey lets a paired launch resume after table setup.
export async function launchMintKey(publicationId:string):Promise<CryptoKeyPair>{
 if(!/^[a-f0-9]{64}$/.test(publicationId))throw Error('Invalid mint publication.');
 const candidate=await crypto.subtle.generateKey('Ed25519',false,['sign','verify']) as CryptoKeyPair;
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{
  const request=indexedDB.open('fub-launch-mints',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('mints');
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('Browser storage is required to resume this paired launch.'));
 });
 try{
  return await new Promise<CryptoKeyPair>((resolve,reject)=>{
   const tx=db.transaction('mints','readwrite'),store=tx.objectStore('mints'),read=store.get(publicationId);let pair:CryptoKeyPair;
   read.onsuccess=()=>{pair=read.result??candidate;if(!read.result)store.add(candidate,publicationId);};
   tx.oncomplete=()=>{
    if(!pair?.privateKey||pair.privateKey.type!=='private'||pair.privateKey.extractable||pair.privateKey.algorithm.name!=='Ed25519'||!pair.privateKey.usages.includes('sign')||pair.publicKey?.algorithm.name!=='Ed25519'||pair.publicKey.type!=='public')reject(Error('Saved mint signer is unavailable.'));
    else resolve(pair);
   };
   tx.onerror=tx.onabort=()=>reject(Error('Could not save this coin’s mint signer. No setup was submitted.'));
  });
 }finally{db.close();}
}
