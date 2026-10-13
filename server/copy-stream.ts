import { isMint } from '../src/assets.js';
export type StreamPlan = { planId: string; leader: string };
type Socket = Pick<WebSocket, 'addEventListener' | 'send' | 'close' | 'readyState'>;

// Standard Solana notifications are wake-up hints only. They never become a
// receipt, advance a cursor, authorize a trade, or bypass finalized RPC reads.
export function copyStream(
  endpoint: string,
  connect: (url: string) => Socket = url => new WebSocket(url),
  now = Date.now,
) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.hostname !== 'mainnet.helius-rpc.com' || url.username || url.password)
    throw Error('Standard Helius stream endpoint required.');
  url.protocol = 'wss:';
  let plans: StreamPlan[] = [], targets = '', socket: Socket | null = null;
  let startedAt = 0, lastMessage = 0, nextAttempt = 0, failures = 0, stopped = false;
  let heartbeatId: number | null = null;
  const subscriptions = new Map<number, string>();
  const requests = new Map<number, string>();
  const generations = new Map<string, number>();
  const acknowledged = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const healthy = () => !!socket && heartbeatId !== null && requests.size === 0 && lastMessage > 0 && now()-lastMessage < 30000;
  const disconnect = (retry: boolean) => {
    const previous = socket; socket = null;
    subscriptions.clear(); requests.clear(); heartbeatId = null; lastMessage = 0;
    if (retry) { failures = Math.min(failures+1,5); nextAttempt = now()+Math.min(30000,1000*2**failures); }
    try { previous?.close(); } catch { /* No credentials or raw network errors are logged. */ }
  };
  function maintain() {
    if (stopped || !plans.length) return;
    if (socket) {
      if ((heartbeatId === null && now()-startedAt > 10000) ||
          (lastMessage && now()-lastMessage >= 30000) ||
          (requests.size && now()-startedAt > 10000)) disconnect(true);
      return;
    }
    if (now() < nextAttempt) return;
    startedAt = now();
    let current: Socket;
    try { current = connect(url.toString()); socket = current; }
    catch { disconnect(true); return; }
    current.addEventListener('open', () => {
      if (socket !== current || stopped) return;
      try {
        requests.set(1, '');
        current.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'slotSubscribe',params:[]}));
        [...new Set(plans.map(p=>p.leader))].sort().forEach((leader,i)=>{
          requests.set(i+2,leader);
          current.send(JSON.stringify({jsonrpc:'2.0',id:i+2,method:'logsSubscribe',params:[{mentions:[leader]},{commitment:'finalized'}]}));
        });
      } catch { disconnect(true); }
    });
    current.addEventListener('message', event => {
      if (socket !== current || stopped) return;
      try {
        const text = (event as MessageEvent).data;
        if (typeof text !== 'string' || text.length > 262144) throw Error();
        const message = JSON.parse(text);
        if (!message || message.jsonrpc !== '2.0' || Array.isArray(message)) throw Error();
        if (Object.hasOwn(message,'id')) {
          if (!requests.has(message.id) || message.error || !Number.isSafeInteger(message.result) || message.result < 0) throw Error();
          const leader = requests.get(message.id)!; requests.delete(message.id);
          if (heartbeatId === message.result || subscriptions.has(message.result)) throw Error();
          if (leader) {
            subscriptions.set(message.result,leader);
            // Reconnect always asks each plan to backfill from its own durable cursor.
            generations.set(leader,(generations.get(leader)||0)+1);
          } else heartbeatId = message.result;
          lastMessage = now();
          if (healthy()) failures = 0;
          return;
        }
        const params = message.params;
        if (message.method === 'slotNotification' && params?.subscription === heartbeatId &&
            Number.isSafeInteger(params?.result?.slot) && params.result.slot >= 0) {
          lastMessage = now(); return;
        }
        const leader = subscriptions.get(params?.subscription);
        if (message.method !== 'logsNotification' || !leader ||
            !Number.isSafeInteger(params?.result?.context?.slot) || params.result.context.slot < 0 ||
            !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(params?.result?.value?.signature || '')) throw Error();
        lastMessage = now();
        generations.set(leader,(generations.get(leader)||0)+1);
      } catch { disconnect(true); }
    });
    for (const event of ['close','error']) current.addEventListener(event,()=>{
      if (socket === current) disconnect(true);
    });
  }
  return {
    update(next: StreamPlan[]) {
      if (stopped) return;
      if (next.length > 25 || new Set(next.map(p=>p.planId)).size !== next.length || next.some(p=>!isMint(p.leader)))
        throw Error('Invalid observer stream targets.');
      const previousLeaders = new Map(plans.map(p=>[p.planId,p.leader]));
      for(const plan of next)if(previousLeaders.get(plan.planId)!==plan.leader)acknowledged.delete(plan.planId);
      plans = next.map(p=>({...p}));
      const ids = new Set(plans.map(p=>p.planId)), leaders = new Set(plans.map(p=>p.leader));
      for (const id of acknowledged.keys()) if (!ids.has(id)) acknowledged.delete(id);
      for (const leader of generations.keys()) if (!leaders.has(leader)) generations.delete(leader);
      const key = [...leaders].sort().join(',');
      if (key !== targets) { targets = key; disconnect(false); nextAttempt = 0; }
      if (!plans.length) {
        if (timer) clearInterval(timer); timer = undefined;
      } else if (!timer) { timer = setInterval(maintain,1000); timer.unref(); }
      maintain();
    },
    snapshot() {
      const captured = new Map(plans.map(p=>[p.planId,generations.get(p.leader)||0]));
      return {
        wakePlanIds: plans.filter(p=>(acknowledged.get(p.planId)??-1)<captured.get(p.planId)!).map(p=>p.planId),
        acknowledge(planId: string) {
          const generation = captured.get(planId);
          if (generation !== undefined) acknowledged.set(planId,generation);
        },
      };
    },
    status: () => ({mode: !plans.length?'standby':healthy()?'stream':'polling',subscriptions:subscriptions.size,connected:healthy()}),
    close() { stopped = true; if(timer)clearInterval(timer); disconnect(false); acknowledged.clear(); generations.clear(); },
  };
}
