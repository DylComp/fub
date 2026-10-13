import {monitorEventLoopDelay} from 'node:perf_hooks';

type DelayHistogram={enable():unknown;disable():unknown;reset():void;max:number;percentile(value:number):number};
/** Bounded process telemetry only; never changes authorization or readiness. */
export function signerEventLoop(options:{histogram?:DelayHistogram;now?:()=>number;warn?:(report:object)=>void}={}){
 const histogram=options.histogram??monitorEventLoopDelay({resolution:20}),now=options.now??Date.now;
 let stopped=false,samples=0,stalls=0,report={checkedAt:0,maxMs:0,p99Ms:0};
 histogram.enable();
 return{
  sample(){
   if(stopped)return;
   const milliseconds=(ns:number)=>Number.isFinite(ns)&&ns>=0?Math.round(ns/1000000):0;
   report={checkedAt:now(),maxMs:milliseconds(histogram.max),p99Ms:milliseconds(histogram.percentile(99))};
   histogram.reset();samples++;
   if(report.maxMs>=1000){stalls++;options.warn?.({event:'signer_event_loop_stall',...report});}
  },
  snapshot(){return{...report,samples,stalls};},
  stop(){if(stopped)return;stopped=true;histogram.disable();},
 };
}
