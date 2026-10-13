import {expect,it,vi} from 'vitest';
import {cashDynamicStreams} from '../server/cash-dynamic-streams';
it('starts a new leader without restarting unaffected chains and closes removed chains',()=>{
 const all:any[]=[],create=vi.fn((network:string,leaders:string[])=>{const m={start:vi.fn(),retire:vi.fn(),close:vi.fn(),snapshot:()=>({streams:[{network,connected:true}],accepted:2})};all.push(m);return m;});
 const d=cashDynamicStreams({networks:['base','bnb'],create}),a={sourceWallet:'a',wallet:'0x'+'1'.repeat(40),networks:['base' as const]},b={sourceWallet:'b',wallet:'0x'+'2'.repeat(40),networks:['bnb' as const]};
 d.update([a]);d.update([a]);expect(create).toHaveBeenCalledTimes(1);d.update([a,b]);expect(all[0].close).not.toHaveBeenCalled();expect(d.snapshot()).toMatchObject({status:'connected',accepted:4});d.update([b]);expect(all[0].retire).toHaveBeenCalledOnce();d.update([b]);expect(all[0].close).toHaveBeenCalledOnce();d.close();expect(all[1].close).toHaveBeenCalledOnce();d.update([a]);expect(create).toHaveBeenCalledTimes(2);
});
it('preserves a healthy chain when replacement construction fails',()=>{let fail=false;const close=vi.fn(),d=cashDynamicStreams({networks:['base'],create:()=>{if(fail)throw Error('config');return{start:()=>{},retire:()=>{},close,snapshot:()=>({streams:[{connected:true}]})};}});const a={sourceWallet:'a',wallet:'a',networks:['base' as const]};d.update([a]);fail=true;expect(()=>d.update([a,{...a,wallet:'b'}])).toThrow();expect(close).not.toHaveBeenCalled();d.close();});
it('keeps the old feed until replacement connects and drains accepted work without aborting',()=>{
 const monitors:any[]=[],d=cashDynamicStreams({networks:['base'],create:()=>{const m={connected:false,active:0,start:vi.fn(),retire:vi.fn(),close:vi.fn(),snapshot:()=>({active:m.active,queued:0,streams:[{connected:m.connected}]})};monitors.push(m);return m;}});
 const a={sourceWallet:'a',wallet:'a',networks:['base' as const]},b={...a,wallet:'b'};
 d.update([a]);expect(d.ready('a',['base'])).toBe(false);monitors[0].connected=true;d.update([a]);expect(d.ready('a',['base'])).toBe(true);
 monitors[0].active=1;d.update([a,b]);expect(monitors[0].retire).not.toHaveBeenCalled();expect(monitors[0].close).not.toHaveBeenCalled();monitors[1].connected=true;d.update([a,b]);expect(monitors[0].retire).toHaveBeenCalledOnce();expect(monitors[0].close).not.toHaveBeenCalled();expect(d.ready('b',['base'])).toBe(true);d.update([a,b]);expect(monitors[0].close).not.toHaveBeenCalled();monitors[0].active=0;d.update([a,b]);expect(monitors[0].close).toHaveBeenCalledOnce();d.close();
});

it('exposes bounded sanitized rejection histories through the private aggregate',()=>{
 const transaction='0x'+'a'.repeat(64),records=Array.from({length:20},(_,at)=>({network:'base',transaction,at,reason:'arc-native-calls',stage:'fill',rawError:'PRIVATE_KEY'}));
 const d=cashDynamicStreams({networks:['base','arc'],create:(network)=>({start(){},retire(){},close(){},snapshot:()=>({streams:[{network,connected:true}],observationRejections:network==='base'?records:[{network,transaction,at:100,reason:'https://rpc.invalid/SECRET',stage:'sale'},{network,transaction:'invalid',at:101,reason:'unclassified',stage:'sale'}],associationRejections:[{network,transaction,at:10,reason:'status-binding',rawError:'SECRET'}]})})});
 d.update([{sourceWallet:'a',wallet:'a',networks:['base','arc']}]);
 const s=d.snapshot();expect(s.observationRejections).toHaveLength(16);expect(s.observationRejections[0].at).toBe(5);expect(s.observationRejections.at(-1)).toEqual({network:'arc',transaction,at:100,reason:'unclassified',stage:'sale'});expect(s.associationRejections).toHaveLength(2);expect(s.associationRejections.every(r=>r.reason==='status-binding')).toBe(true);expect(JSON.stringify(s)).not.toMatch(/SECRET|PRIVATE_KEY|rawError|rpc.invalid/);
 s.observationRejections[0].reason='changed';expect(d.snapshot().observationRejections[0].reason).toBe('arc-native-calls');d.close();
});

it('includes failures from a connecting replacement and its draining predecessor',()=>{
 const transaction='0x'+'b'.repeat(64),monitors:any[]=[],d=cashDynamicStreams({networks:['base'],create:()=>{const index=monitors.length,m={connected:index===0,active:1,start(){},retire(){},close(){},snapshot:()=>({active:m.active,streams:[{connected:m.connected}],associationRejections:[{network:'base',transaction,at:index,reason:'status-binding'}]})};monitors.push(m);return m;}});
 const a={sourceWallet:'a',wallet:'a',networks:['base' as const]},b={...a,wallet:'b'};d.update([a]);d.update([a,b]);expect(d.snapshot().associationRejections.map(r=>r.at)).toEqual([0,1]);monitors[1].connected=true;d.update([a,b]);expect(d.snapshot().associationRejections.map(r=>r.at)).toEqual([0,1]);d.close();
});
