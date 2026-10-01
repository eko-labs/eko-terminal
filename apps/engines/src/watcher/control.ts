/** Checked at refresh boundaries. Changing a service environment needs a process restart, not a code deploy. */
export function watcherRefreshControl(env:()=>NodeJS.ProcessEnv=()=>process.env,log:(event:string)=>void=event=>console.log(JSON.stringify({event}))) {
  let logged=false;
  return ()=>{
    const value=env().ENGINE_WATCHER_REFRESH_ENABLED;
    if(value!==undefined&&!['true','false','1','0',''].includes(value))throw new Error('Invalid ENGINE_WATCHER_REFRESH_ENABLED');
    const enabled=value!=='false'&&value!=='0';
    if(!enabled&&!logged){log('watcher_refresh_paused');logged=true;}
    return enabled;
  };
}
export const watcherRefreshEnabled=watcherRefreshControl();
