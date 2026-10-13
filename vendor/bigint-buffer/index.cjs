'use strict';
function bytes(value){if(!Buffer.isBuffer(value)&&!(value instanceof Uint8Array))throw new TypeError('Expected bytes');if(value.length>4096)throw new RangeError('Integer buffer exceeds 4096 bytes');return Buffer.from(value)}
function toBigIntBE(value){const b=bytes(value);return b.length?BigInt('0x'+b.toString('hex')):0n}
function toBigIntLE(value){return toBigIntBE(bytes(value).reverse())}
function toBufferBE(value,width){if(typeof value!=='bigint'||value<0n||!Number.isInteger(width)||width<0||width>4096)throw new RangeError('Invalid unsigned integer or width');if(value>=(1n<<BigInt(width*8)))throw new RangeError('Integer does not fit');if(width===0)return Buffer.alloc(0);return Buffer.from(value.toString(16).padStart(width*2,'0'),'hex')}
function toBufferLE(value,width){return toBufferBE(value,width).reverse()}
module.exports={toBigIntBE,toBigIntLE,toBufferBE,toBufferLE};
