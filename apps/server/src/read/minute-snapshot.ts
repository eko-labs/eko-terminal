/** Host-refreshed header data. Reads never schedule database work, including on expiry or failure. */
export class MinuteSnapshot<T> {
  private at?:number;
  private running?:Promise<void>;
  constructor(public value:T,readonly compute:()=>Promise<T>,readonly now:()=>number) {}
  refresh(force=false):Promise<void> {
    if(this.running)return this.running;
    const now=this.now();
    if(!force && this.at!==undefined && now>=this.at && now-this.at<60_000)return Promise.resolve();
    this.running=this.compute().then(value=>{this.value=value;this.at=now;}).finally(()=>{this.running=undefined;});
    return this.running;
  }
}
