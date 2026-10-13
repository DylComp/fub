import {controlledTestPaths} from './controlled-test-paths.js';
import {controlledTestPolicy, controlledOwnerOutflowCap, controlledProposalPolicy, validateLeaderTestState, type LeaderTestState} from './controlled-leader-test.js';
import {isMint} from '../src/assets.js';

// No implicit current run: a stale shortcut must never pick a newer wallet or
// reuse an old approval. The caller supplies both the run and saved plan ID.
export function controlledWindowSelection(argv:string[],root:string){
  const [mode,...options]=argv;
  if(!['--check','--execute','--check-sell','--resume-sell','--stop'].includes(mode)||options.length!==2)throw Error('Specify mode, run and plan.');
  const runOptions=options.filter(x=>x.startsWith('--run='));
  const plans=options.filter(x=>/^--plan=[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(x));
  if(runOptions.length!==1||plans.length!==1)throw Error('Invalid run or plan selection.');
  const paths=controlledTestPaths(['status',runOptions[0]],root);
  return {mode,run:paths.run!,directory:paths.directory,planId:plans[0].slice(7)};
}

export function controlledWindowProposal(proposal:any,state:LeaderTestState){
  const policy=proposal?.version===2?controlledProposalPolicy(proposal):controlledTestPolicy('50000');
  validateLeaderTestState(state,policy);
  if(!proposal||![1,2].includes(proposal.version)||!isMint(proposal.leader)||proposal.leader!==state.leader||
    proposal.follower!==policy.follower||proposal.mint!==policy.mint||proposal.buyLamports!==policy.buyLamports||
    proposal.leaderDebitCap!==policy.leaderDebitCap||proposal.followerDebitCap!==policy.followerDebitCap||
    proposal.fundingFeeCap!==policy.fundingFeeCap||proposal.slippageBps!==policy.slippageBps||
    proposal.maximumFollowerWalletOutflowLamports!==controlledOwnerOutflowCap(policy)||JSON.stringify(proposal.carryover)!==JSON.stringify(state.carryover)||JSON.stringify(proposal.closedCycle)!==JSON.stringify(state.closedCycle))throw Error('Test proposal does not match the bounded scope.');
  return {leader:proposal.leader as string,policy};
}
