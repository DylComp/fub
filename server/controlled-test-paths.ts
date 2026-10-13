import {resolve,join} from 'node:path';
// Separate funded acceptance windows must keep separate keys and journals.
// Selecting a new run never copies approval, funding, or attempt state.
export function controlledTestPaths(argv:string[],root:string){
 const [command,...options]=argv;
 if(!['init','review','status','funding','preflight','preflight-sell','buy','sell','recover','resolve-expiry'].includes(command)||options.length>1)throw Error('Invalid controlled test command.');
 const run=options.length?options[0].match(/^--run=([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/)?.[1]:undefined;
 if(options.length&&(!run||run.length>60))throw Error('Invalid controlled test run.');
 const parent=resolve(root,'.controlled-leader-tests');
 const directory=run?join(parent,run):resolve(root,'.controlled-leader-test');
 const evidence=(name:string)=>{
  if(!/^[a-z]+(?:-[a-z]+)*$/.test(name))throw Error('Invalid evidence name.');
  return resolve(root,'docs/evidence',name+(run?'-'+run:'')+'.json');
 };
 return {command,run,directory,parent:run?parent:null,evidence};
}
