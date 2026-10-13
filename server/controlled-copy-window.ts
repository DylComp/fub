// Local acceptance supervisor. Production transaction validators remain the
// authority for signing, inventory, budgets and finalized receipt recovery.
export type WindowSnapshot = {
  leader: { side: 'buy' | 'sell'; outcome: string; lifetimeExpired?:boolean }[];
  follower: { side: 'buy' | 'sell'; settlement: string | null; signature: string | null }[];
  accountingComplete: boolean;
  followerStopped?: boolean;
};
export type WindowDependencies = {
  preflight(): Promise<void>;
  claim(): Promise<void>;
  enableSigner(): Promise<void>;
  enableDispatch(): Promise<void>;
  trade(side: 'buy' | 'sell'): Promise<void>;
  tick(): Promise<void>;
  snapshot(): Promise<WindowSnapshot>;
  haltDispatch(): Promise<void>;
  disableSigner(): Promise<void>;
  verifyClosed(): Promise<void>;
  sleep(): Promise<void>;
  now(): number;
  interrupted(): boolean;
  progress(stage: string): void;
};
export type WindowReport = {
  completed: boolean; stage: string; failureStage?: string;
  dispatchDisabled?: boolean; signerDisabled?: boolean; closureVerified?: boolean;
  lastSnapshot?: WindowSnapshot;
};

export function controlledWindowDeadline(now: number, authorities: number[]): number {
  if (authorities.length !== 3 || authorities.some(t => !Number.isSafeInteger(t))) throw Error('Missing authority expiry.');
  const deadline = Math.min(now + 600000, ...authorities.map(t => t - 60000));
  if (deadline < now + 420000) throw Error('Not enough permission time for a new test.');
  return deadline;
}

export function canResumeUntradedWindow(prior: WindowReport, leaderAttempts: number, followerAttempts: number, jobs: number): boolean {
  return prior.completed === false && ['starting-private-signer', 'starting-copy-execution', 'leader-buy'].includes(prior.failureStage ?? '') &&
    prior.dispatchDisabled === true && prior.signerDisabled === true && prior.closureVerified === true &&
    leaderAttempts === 0 && followerAttempts === 0 && jobs === 0;
}

// Resuming a dropped buy is permitted only after the operator has independently
// proved finalized expiry, with no follower execution and verified shutdown.
export function canResumeExpiredBuyWindow(prior: WindowReport, expiredBuys:number, followerAttempts:number, jobs:number):boolean {
 return prior.completed===false && prior.failureStage==='waiting-for-copied-buy' &&
  prior.dispatchDisabled===true && prior.signerDisabled===true && prior.closureVerified===true &&
  expiredBuys===1 && followerAttempts===0 && jobs===0;
}

// Continue the already purchased position, never another buy. The caller must
// reverify both receipts, inventory and unchanged journals before activation.
export function canResumeCopiedSell(prior:WindowReport,current:WindowSnapshot,expiredSaleProven=false):boolean{
 return prior.completed===false && (prior.failureStage==='leader-sell'||prior.failureStage==='waiting-for-copied-sell'&&expiredSaleProven) &&
  prior.dispatchDisabled===true && prior.signerDisabled===true && prior.closureVerified===true &&
  current.accountingComplete && !current.followerStopped &&
  current.leader.length===1 && current.leader[0].side==='buy' && current.leader[0].outcome==='succeeded' &&
  !current.leader[0].lifetimeExpired && current.follower.length===1 && current.follower[0].side==='buy' &&
  current.follower[0].settlement==='succeeded' && !!current.follower[0].signature;
}

// A failed read/quote before the durable attempt is not a submitted trade.
// Never retry after either journal contains an attempt, even without a receipt.
export async function prepareFirstBuy<T>(attempt:()=>Promise<T>, untouched:()=>Promise<boolean>, wait:()=>Promise<void>):Promise<T>{
 for(let n=0;n<3;n++){
  try{return await attempt();}
  catch(error){if(n===2||!await untouched())throw error;await wait();}
 }
 throw Error('Buy preparation stopped.');
}

export async function controlledCopyWindow(d: WindowDependencies, deadline: number, start:'buy'|'sell'='buy'): Promise<WindowReport> {
  const report: WindowReport = { completed: false, stage: 'preflight' };
  let activationClaimed = false;
  const stage = (name: string) => { report.stage = name; d.progress(name); };
  const active = () => {
    if (d.interrupted() || d.now() >= deadline) throw Error('Window ended.');
  };
  async function settled(side: 'buy' | 'sell') {
    stage('waiting-for-copied-' + side);
    while (true) {
      active();
      await d.tick();
      const s = await d.snapshot();
      report.lastSnapshot = s;
      const expected = side === 'buy' ? ['buy'] : ['buy', 'sell'];
      if (s.followerStopped || s.leader.length > expected.length || s.follower.length > expected.length ||
          s.leader.some((a, i) => a.side !== expected[i] || a.lifetimeExpired===true || ['failed', 'expired', 'not_signed'].includes(a.outcome)) ||
          s.follower.some((a, i) => a.side !== expected[i] || (a.settlement !== null && !['pending', 'succeeded'].includes(a.settlement)))) {
        throw Error('Test sequence did not settle.');
      }
      if (s.leader.length === expected.length && s.follower.length === expected.length &&
          s.leader.every(a => a.outcome === 'succeeded') &&
          s.follower.every(a => a.settlement === 'succeeded' && !!a.signature) && s.accountingComplete) return;
      await d.sleep();
    }
  }
  try {
    active(); await d.preflight(); active();
    stage('claiming-window'); await d.claim();
    // Claim before a possibly lost activation reply. Always attempt both stops.
    activationClaimed = true;
    active(); stage('starting-private-signer'); await d.enableSigner(); active();
    stage('starting-copy-execution'); await d.enableDispatch(); active();
    if(start==='buy'){stage('leader-buy'); await d.trade('buy');}
    await settled('buy'); active();
    stage('leader-sell'); await d.trade('sell');
    await settled('sell');
    report.completed = true;
  } catch {
    report.failureStage = report.stage;
  } finally {
    if (activationClaimed) {
      stage('stopping-execution');
      try { await d.haltDispatch(); report.dispatchDisabled = true; }
      catch { report.dispatchDisabled = false; }
      try { await d.disableSigner(); report.signerDisabled = true; }
      catch { report.signerDisabled = false; }
      try { await d.verifyClosed(); report.closureVerified = true; }
      catch { report.closureVerified = false; }
      if (!report.closureVerified || !report.dispatchDisabled || !report.signerDisabled) report.completed = false;
    }
  }
  return report;
}
