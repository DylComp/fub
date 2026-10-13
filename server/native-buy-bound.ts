// The default preserves existing copy-route limits. Only independently signed
// direct-buy terms supply a larger bound; it is never read from a route quote.
export function nativeBuyBound(value='10000000'){
 if(!/^[1-9]\d{0,11}$/.test(value)||BigInt(value)>100000000000n)throw Error('Invalid authorized native buy bound.');return BigInt(value);
}
