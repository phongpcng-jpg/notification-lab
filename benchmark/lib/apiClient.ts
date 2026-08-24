import "dotenv/config";
let baseUrlOverride:string|null=null;
export function setApiBaseUrl(url:string):void{baseUrlOverride=url;}
export function resetApiBaseUrl():void{baseUrlOverride=null;}
export function apiBaseUrl():string{return baseUrlOverride??process.env.BENCHMARK_API_BASE_URL??"http://localhost:3000";}
export function wsBaseUrl():string{return apiBaseUrl().replace(/^http/,"ws");}
export function benchmarkApiKey():string{const key=process.env.BENCHMARK_API_KEY;if(!key)throw new Error("Missing BENCHMARK_API_KEY. Set it in benchmark/.env or environment variables.");return key;}
export interface ApiUser{id:number;display_name:string;created_at:number;}
export interface CreatedPost{post:{id:number;author_id:number;script:string;posted_at:number};eventId:number;notificationIds:number[];notificationCount:number;recipientIds:number[];}
export interface DeliveryAttempt{notificationId:number;transport:"short_polling"|"long_polling"|"sse"|"websocket"|"web_push";result:"success"|"failed"|"timeout";latencyMs:number|null;}
export interface ServerClockCalibration{serverMsPerMonoMs:number;roundTripMs:number;uncertaintyMs:number;}
export async function listUsers():Promise<ApiUser[]>{const res=await fetch(`${apiBaseUrl()}/users`);if(!res.ok)throw new Error(`GET /users thất bại: HTTP ${res.status}`);return ((await res.json()) as {users:ApiUser[]}).users;}
export async function getFollowers(userId:number):Promise<ApiUser[]>{const res=await fetch(`${apiBaseUrl()}/users/${userId}/followers`);if(!res.ok)throw new Error(`GET /users/${userId}/followers thất bại: HTTP ${res.status}`);return ((await res.json()) as {followers:ApiUser[]}).followers;}
export async function createPost(authorId:number,script:string):Promise<CreatedPost>{const res=await fetch(`${apiBaseUrl()}/posts`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({authorId,script})});if(!res.ok)throw new Error(`POST /posts thất bại: HTTP ${res.status}`);return res.json() as Promise<CreatedPost>;}
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
