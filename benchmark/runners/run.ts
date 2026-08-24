import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { calibrateServerClock, checkHealth, createPost, getDeliveryAttempts } from "../lib/apiClient.js";
import { pickPublisher } from "../lib/pickPublisher.js";
import { generateScript } from "../lib/payload.js";
import { mulberry32 } from "../lib/random.js";
import { buildScenarioResult } from "../lib/metrics.js";
import { writeScenarioResult, printSummary } from "../lib/report.js";
import { createSimulatedClient } from "../generators/clientFactory.js";
import { ALL_AUTOMATABLE_TRANSPORTS, type ScenarioConfig, type Transport } from "../lib/types.js";
const __dirname=dirname(fileURLToPath(import.meta.url));
function parseArgs():Record<string,string>{return Object.fromEntries(process.argv.slice(2).map(a=>{const[k,...rest]=a.replace(/^--/,"").split("=");return[k,rest.join("=")];}));}
function loadScenarioConfig(args:Record<string,string>):ScenarioConfig{const scenarioPath=args.config?args.config:join(__dirname,"..","scenarios",`${args.scenario}.json`);const config=JSON.parse(readFileSync(scenarioPath,"utf-8")) as ScenarioConfig;if(args.subscribers)config.subscriberCount=Number(args.subscribers);if(args.duration)config.durationMs=Number(args.duration);if(args["posts-per-second"]){config.postRate.mode="fixed";config.postRate.postsPerSecond=Number(args["posts-per-second"]);}if(args["burst-size"]){config.postRate.mode="burst";config.postRate.burstSize=Number(args["burst-size"]);}return config;}
function sleep(ms:number):Promise<void>{return new Promise(resolve=>setTimeout(resolve,ms));}
async function waitForDeliveryAttempts(notificationIds:number[],transport:Transport,timeoutMs=2000){if(notificationIds.length===0)return[];const deadline=performance.now()+timeoutMs;let attempts=await getDeliveryAttempts(notificationIds);while(performance.now()<deadline){const deliveredIds=new Set(attempts.filter(a=>a.transport===transport).map(a=>a.notificationId));if(notificationIds.every(id=>deliveredIds.has(id)))return attempts;await sleep(50);attempts=await getDeliveryAttempts(notificationIds);}return attempts;}
export async function runScenario(config:ScenarioConfig,transport:Transport):Promise<import("../lib/metrics.js").ScenarioResult>{
 console.log(`\n>>> Chạy scenario ${config.id} (${config.name}) trên transport=${transport}`);
 if(!(await checkHealth()))throw new Error("Backend không phản hồi tại /health. Chạy `cd backend && npm run dev` trước khi benchmark.");
 const{publisherId,followerIds}=await pickPublisher(config.subscriberCount);const subscriberIds=followerIds.slice(0,config.subscriberCount);console.log(`Publisher: user#${publisherId} — dùng ${subscriberIds.length}/${config.subscriberCount} follower làm subscriber`);
 const rng=mulberry32(config.seed),slowRatio=config.slowClients?.ratio??0,slowExtraDelayMs=config.slowClients?.extraDelayMs??0;
 const clients=subscriberIds.map((userId,i)=>createSimulatedClient(transport,{clientIndex:i,userId,isSlowClient:config.slowClients?rng()<slowRatio:false,slowClientExtraDelayMs:slowExtraDelayMs}));
 if(config.connectionStorm?.enabled){const rampUpMs=config.connectionStorm.rampUpMs,delayPerClient=clients.length>0?rampUpMs/clients.length:0;console.log(`Connection storm: mở ${clients.length} kết nối trong ${rampUpMs}ms (~${delayPerClient.toFixed(1)}ms/client)`);for(const c of clients){void c.connect();if(delayPerClient>0)await sleep(delayPerClient);}}else await Promise.all(clients.map(c=>c.connect()));
 await sleep(500);for(const client of clients)client.events.length=0;
 const clockCalibration=await calibrateServerClock();console.log(`Clock calibration: RTT=${clockCalibration.roundTripMs.toFixed(1)}ms (uncertainty<=${clockCalibration.uncertaintyMs.toFixed(1)}ms)`);
 const startedAt=new Date(),startedMonoMs=performance.now(),expectedNotificationIds=new Set<number>();
 const reconnectTimers:ReturnType<typeof setTimeout>[]=[];
 if(config.reconnectStorm?.enabled)for(const atMs of config.reconnectStorm.atMs){const timer=setTimeout(async()=>{console.log(`Reconnect storm tại t=${atMs}ms: ngắt + kết nối lại ${clients.length} client`);await Promise.all(clients.map(c=>c.disconnect()));await Promise.all(clients.map(c=>c.connect()));},atMs);reconnectTimers.push(timer);}
 let postsCreated=0;const deadlineMonoMs=startedMonoMs+config.durationMs;
 async function createMeasuredPost(){const created=await createPost(publisherId,generateScript(config.payloadSize));postsCreated++;for(const id of created.notificationIds)expectedNotificationIds.add(id);}
 async function runFixedRate(){const rate=config.postRate.postsPerSecond??1;if(rate<=0)return;const intervalMs=1000/rate;while(performance.now()<deadlineMonoMs){await createMeasuredPost();if(performance.now()>=deadlineMonoMs)break;await sleep(Math.min(intervalMs,deadlineMonoMs-performance.now()));}}
 async function runBurstRate(){const burstSize=config.postRate.burstSize??10,intervalMs=config.postRate.burstIntervalMs??10000;while(performance.now()<deadlineMonoMs){const burstPromises:Promise<void>[]=[];for(let i=0;i<burstSize&&performance.now()<deadlineMonoMs;i++)burstPromises.push(createMeasuredPost());await Promise.all(burstPromises);if(performance.now()>=deadlineMonoMs)break;await sleep(Math.min(intervalMs,deadlineMonoMs-performance.now()));}}
 try{if(config.postRate.mode==="burst")await runBurstRate();else await runFixedRate();}catch(err){console.error("[postGenerator] lỗi:",err);}
 for(const t of reconnectTimers)clearTimeout(t);await sleep(2000);await Promise.all(clients.map(c=>c.disconnect()));const finishedAt=new Date();
 const e2eLatencySamplesMs:number[]=[],transportDeliveryLatencySamplesMs:number[]=[],serverClockOffsetMs=clockCalibration.serverMsPerMonoMs;
 for(const client of clients){const seen=new Set<number>();for(const event of client.events){if(seen.has(event.notificationId))continue;seen.add(event.notificationId);const estimatedServerReceiveMs=event.receivedAtMonoMs+serverClockOffsetMs;const e2e=estimatedServerReceiveMs-event.serverCreatedAtMs;const transportLatency=estimatedServerReceiveMs-event.serverSentAtMs;if(Number.isFinite(e2e)&&e2e>=0)e2eLatencySamplesMs.push(e2e);if(Number.isFinite(transportLatency)&&transportLatency>=0)transportDeliveryLatencySamplesMs.push(transportLatency);}}
 let serverDeliveryLatencySamplesMs:number[]=[];if(expectedNotificationIds.size>0)try{const attempts=await waitForDeliveryAttempts([...expectedNotificationIds],transport);const seenSuccessful=new Set<number>();serverDeliveryLatencySamplesMs=attempts.filter(a=>a.transport===transport).filter(a=>a.result==="success").filter(a=>!seenSuccessful.has(a.notificationId)).map(a=>{seenSuccessful.add(a.notificationId);return a.latencyMs;}).filter((latency):latency is number=>typeof latency==="number"&&Number.isFinite(latency)&&latency>=0);}catch(err){console.warn(`[benchmark] Không đọc được server delivery attempts: ${err instanceof Error?err.message:String(err)}`);}
 const result=buildScenarioResult({scenarioId:config.id,scenarioName:config.name,transport,startedAt,finishedAt,config,publisherId,requestedSubscriberCount:config.subscriberCount,postsCreated,e2eLatencySamplesMs,serverDeliveryLatencySamplesMs,transportDeliveryLatencySamplesMs,perClient:clients.map(c=>({clientIndex:c.clientIndex,userId:c.userId,isSlowClient:c.isSlowClient,events:c.events,errorCount:c.errorCount,reconnectCount:c.reconnectCount}))});
 printSummary(result);const paths=writeScenarioResult(result);console.log(`Raw:       ${paths.rawPath}`);console.log(`Processed: ${paths.processedPath}`);return result;
}
async function main():Promise<void>{const args=parseArgs();if(!args.scenario&&!args.config){console.error("Thiếu --scenario=<id> (ví dụ --scenario=A) hoặc --config=<path>.\n"+`Transport hợp lệ (--transport=): ${ALL_AUTOMATABLE_TRANSPORTS.join(", ")}`);process.exit(1);}const transport=(args.transport??"sse") as Transport;if(!ALL_AUTOMATABLE_TRANSPORTS.includes(transport)){console.error(`Transport không hợp lệ: ${transport}. Hợp lệ: ${ALL_AUTOMATABLE_TRANSPORTS.join(", ")}\n`+"(Web Push không chạy qua runner này — xem benchmark/README.md)");process.exit(1);}await runScenario(loadScenarioConfig(args),transport);process.exit(0);}
const isMainModule=process.argv[1]===fileURLToPath(import.meta.url);if(isMainModule)main().catch(err=>{console.error("Benchmark thất bại:",err);process.exit(1);});
