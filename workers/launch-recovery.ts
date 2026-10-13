import {serviceConnection} from '../server/copy-service.js';
import {initialLaunchRecoveryHealth,launchRecoveryTick,runLaunchRecovery} from '../server/launch-recovery-worker.js';
async function start(){
 if(process.env.LAUNCH_RECOVERY_RUN!=='true')throw Error('Explicit activation required.');
 const config=serviceConnection(process.env),controller=new AbortController();
 const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{await runLaunchRecovery(launchRecoveryTick({...config,archiveEndpoint:process.env.SOLANA_ARCHIVE_RPC_URL}),initialLaunchRecoveryHealth(),controller.signal,s=>console.log(JSON.stringify({event:'launch_recovery_state',phase:s.phase,checked:s.checked,failed:s.failed})),process.argv.includes('--once'));}
 finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
start().catch(()=>{console.error('Launch recovery configuration or service unavailable.');process.exitCode=1;});
