import {useEffect,useRef} from 'react';

export const TASK_COMPLETED='fub-task-completed';
export type TaskCompletion={message:string;destination?:'#launch'|'#orders'|'#pay'};
export function finishTask(detail:TaskCompletion){
 window.dispatchEvent(new CustomEvent<TaskCompletion>(TASK_COMPLETED,{detail}));
}
// A verified result closes its working view once. Pending, failed and recovery
// states never count as success. Unmounting cancels the return navigation.
export function useCompletedTask(key:string|null,onComplete:()=>void,delay=1800){
 const callback=useRef(onComplete),handled=useRef<string|null>(null);callback.current=onComplete;
 useEffect(()=>{
  if(!key||handled.current===key)return;
  const timer=setTimeout(()=>{handled.current=key;callback.current();},delay);
  return()=>clearTimeout(timer);
 },[key,delay]);
}
