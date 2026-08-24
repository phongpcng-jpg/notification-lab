import "dotenv/config";
let baseUrlOverride:string|null=null;
export function setApiBaseUrl(url:string):void{baseUrlOverride=url;}
export function resetApiBaseUrl():void{baseUrlOverride=null;}
export function apiBaseUrl():string{return baseUrlOverride??process.env.BENCHMARK_API_BASE_URL??"http://localhost:3000";}
export function wsBaseUrl():string{return apiBaseUrl().replace(/^http/,"ws");}
export function benchmarkApiKey():string{const key=process.env.BENCHMARK_API_KEY;if(!key)throw new Error("Missing BENCHMARK_API_KEY. Set it in benchmark/.env or environment variables.");return key;}
export interface ApiUser{id:number;display_name:string;created_at:number;}
export interface CreatedPost{post:{id:number;author_id:number;script:string;posted_at:number};eventId:number;notificationIds:number[];notificationCount:number;recipientIds:number;}
export interface DeliveryAttempt{notificationId:number;transport:"short_polling"|"long_polling"|"sse"|"websocket"|"web_push";result:"success"|"failed"|"timeout";latencyMs:number|null;}
export interface ServerClockCalibration{serverMsPerMonoMs:number;roundTripMs:number;uncertaintyMs:number;}
export async function listUsers():Promise<ApiUser[]>{const res=await fetch(`${apiBaseUrl()}/users`);if(!res.ok)throw new Error(`GET /users thất bại: HTTP ${res.status}`);return ((await res.json()) as {users:ApiUser[]}).users;}
export async function getFollowers(userId:number):Promise<ApiUser[]>{const res=await fetch(`${apiBaseUrl()}/users/${userId}/followers`);if(!res.ok)throw new Error(`GET /users/${userId}/followers thất bại: HTTP ${res.status}`);return ((await res.json()) as {followers:ApiUser[]}).followers;}
export async function createPost(authorId:number,script:string):Promise<CreatedPost>{const res=await fetch(`${apiBaseUrl()}/posts`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({authorId,script})});if(!res.ok)throw new Error(`POST /posts thất bại: HTTP ${res.status}`);return res.json() as Promise<CreatedPost>;}

/**
 * Return the current notification cursor for a user without treating any of
 * the existing notifications as benchmark events. We intentionally use the
 * normal polling endpoint because the benchmark branch does not require a
 * backend-only latest-id endpoint. Pagination is drained so the cursor is the
 * actual high-water mark even when a user has more than one page of history.
 *
 * Any notifications created after the final probe have ids greater than this
 * cursor and are therefore eligible for the measured run. The extra
 * short-polling delivery-attempt rows created by this warm-up are for old
 * notification ids and are excluded later because the benchmark only queries
 * attempts for notification ids created during the measured run.
 */
export async function getLatestNotificationId(userId:number):Promise<number>{
  let after=0;
  for(;;){
    const params=new URLSearchParams({userId:String(userId),after:String(after),limit:"200"});
    const res=await fetch(`${apiBaseUrl()}/notifications/poll?${params.toString()}`);
    if(!res.ok)throw new Error(`GET /notifications/poll thất bại khi calibrating cursor: HTTP ${res.status}`);
    const body=await res.json() as {notifications?:Array<{id:number}>;nextAfter?:number};
    const notifications=body.notifications??[];
    const nextAfter=typeof body.nextAfter==="number"&&Number.isFinite(body.nextAfter)?body.nextAfter:after;
    if(notifications.length===0||nextAfter<=after)return after;
    after=nextAfter;
  }
}

export async function getDeliveryAttempts(notificationIds:number[]):Promise<DeliveryAttempt[]>{if(notificationIds.length===0)return[];const params=new URLSearchParams({notificationIds:notificationIds.join(",")});const res=await fetch(`${apiBaseUrl()}/benchmark/delivery-attempts?${params}`,{headers:{"X-Benchmark-Key":benchmarkApiKey()}});if(!res.ok)throw new Error(`GET /benchmark/delivery-attempts thất bại: HTTP ${res.status}`);return ((await res.json()) as {attempts:DeliveryAttempt[]}).attempts;}

/**
 * Cristian-style calibration: use several health probes and keep the probe
 * with the smallest RTT. The server timestamp is captured just before the
 * response is built, so midpoint gives the best unbiased offset under the
 * usual approximately symmetric network-delay assumption. The returned
 * uncertainty is RTT/2 and is recorded rather than hidden.
 */
export async function calibrateServerClock(probeCount=7):Promise<ServerClockCalibration>{
  let best:{offset:number;rtt:number}|null=null;
  for(let i=0;i<probeCount;i++){
    const start=performance.now();
    const res=await fetch(`${apiBaseUrl()}/health`,{cache:"no-store"});
    const end=performance.now();
    if(!res.ok)throw new Error(`GET /health thất bại: HTTP ${res.status}`);
    const body=await res.json() as {serverTimestampMs?:number};
    if(typeof body.serverTimestampMs!=="number"||!Number.isFinite(body.serverTimestampMs))throw new Error("GET /health không trả serverTimestampMs hợp lệ.");
    const midpoint=(start+end)/2;
    const offset=body.serverTimestampMs-midpoint;
    const rtt=end-start;
    if(best===null||rtt<best.rtt)best={offset,rtt};
  }
  if(!best)throw new Error("Clock calibration failed: no probes completed.");
  return {serverMsPerMonoMs:best.offset,roundTripMs:best.rtt,uncertaintyMs:best.rtt/2};
}
export async function checkHealth():Promise<boolean>{try{return (await fetch(`${apiBaseUrl()}/health`)).ok;}catch{return false;}}
