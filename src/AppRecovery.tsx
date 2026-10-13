import {Component,type ReactNode} from 'react';

// A cached lazy route can disappear after deployment. Keep a usable recovery
// screen instead of an empty root. Never reload during a wallet prompt or
// automatically retry a financial action as part of recovering the interface.
export class AppRecovery extends Component<{children:ReactNode},{failed:boolean;loading:boolean}> {
 state={failed:false,loading:false};
 static getDerivedStateFromError(error:unknown){
  const message=error instanceof Error?error.message:'';
  return {failed:true,loading:/Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk|Unable to preload CSS/i.test(message)};
 }
 render(){
  if(!this.state.failed)return this.props.children;
  return <main className="app-recovery" role="alert">
   <p className="eyebrow">Fub</p>
   <h1>{this.state.loading?'This page needs a reload.':'This page could not open.'}</h1>
   <p>Reload Fub to try again. If you just approved a trade, check its status before creating another.</p>
   <button className="button primary" onClick={()=>location.reload()}>Reload Fub</button>
  </main>;
 }
}
