import {Component,createRef,type ReactNode} from 'react';

// A cached lazy route can disappear after deployment. Keep a usable recovery
// screen instead of an empty root. Never reload during a wallet prompt or
// automatically retry a financial action as part of recovering the interface.
export class AppRecovery extends Component<{children:ReactNode},{failed:boolean;loading:boolean;stale:boolean}> {
 state={failed:false,loading:false,stale:false};
 private recovery=createRef<HTMLDialogElement>();
 private staleChunk=()=>this.setState({stale:true});
 componentDidMount(){window.addEventListener('vite:preloadError',this.staleChunk);}
 componentWillUnmount(){window.removeEventListener('vite:preloadError',this.staleChunk);}
 componentDidUpdate(){
  // The native top layer remains visible even when the provider's own dialog is blank.
  if(this.state.stale&&!this.recovery.current?.open)this.recovery.current?.showModal();
 }
 static getDerivedStateFromError(error:unknown){
  const message=error instanceof Error?error.message:'';
  return {failed:true,loading:/Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk|Unable to preload CSS/i.test(message)};
 }
 render(){
  if(!this.state.failed)return <>{this.props.children}{this.state.stale&&<dialog ref={this.recovery} aria-labelledby="fub-update-title" onCancel={()=>this.setState({stale:false})} style={{maxWidth:440,padding:28,border:'1px solid #7561b8',borderRadius:20,background:'#13101e',color:'#fff'}}>
   <h2 id="fub-update-title">Fub was updated.</h2>
   <p>A wallet screen could not load. Dismiss any wallet confirmation before reloading this page.</p>
   <p>Reloading does not approve or retry a transaction. If you already signed, check the saved attempt after reloading before starting another.</p>
   <button className="button primary" onClick={()=>location.reload()}>Reload Fub</button>
   <button className="word-link" onClick={()=>this.setState({stale:false})}>Stay on this page</button>
  </dialog>}</>;
  return <main className="app-recovery" role="alert">
   <p className="eyebrow">Fub</p>
   <h1>{this.state.loading?'This page needs a reload.':'This page could not open.'}</h1>
   <p>Reload Fub to try again. If you just approved a trade, check its status before creating another.</p>
   <button className="button primary" onClick={()=>location.reload()}>Reload Fub</button>
  </main>;
 }
}
