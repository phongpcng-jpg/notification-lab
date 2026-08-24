import WebSocket from "ws";
import { wsBaseUrl } from "../lib/apiClient.js";
import type { ReceivedEvent } from "../lib/types.js";
import type { SimulatedClient, SimulatedClientOptions } from "./simulatedClient.js";
interface WsNotificationPayload { id:number; createdAt:number; serverSentAtMs:number; }
export class WebSocketClient implements SimulatedClient {
  readonly clientIndex:number; readonly userId:number; readonly isSlowClient:boolean; readonly events:ReceivedEvent[]=[]; errorCount=0; reconnectCount=0;
  private after=0; private stopped=true; private socket:WebSocket|null=null; private reconnectTimer:ReturnType<typeof setTimeout>|null=null; private readonly extraDelayMs:number;
  constructor(opts:SimulatedClientOptions){this.clientIndex=opts.clientIndex;this.userId=opts.userId;this.isSlowClient=opts.isSlowClient;this.extraDelayMs=opts.isSlowClient?opts.slowClientExtraDelayMs:0;}
  async connect():Promise<void>{this.stopped=false;await this.open(false);}
  async disconnect():Promise<void>{this.stopped=true;if(this.reconnectTimer)clearTimeout(this.reconnectTimer);this.socket?.close();this.socket=null;}
  private open(isReconnect:boolean):Promise<void>{
    if(this.stopped)return Promise.resolve();if(isReconnect)this.reconnectCount++;
    const socket=new WebSocket(`${wsBaseUrl()}/ws?userId=${this.userId}&after=${this.after}`);this.socket=socket;
    return new Promise<void>((resolve,reject)=>{let settled=false;const resolveOnce=()=>{if(settled)return;settled=true;resolve();};const rejectOnce=(e:Error)=>{if(settled)return;settled=true;reject(e);};
      socket.once("open",resolveOnce);socket.on("message",raw=>{void this.handleMessage(raw as Buffer,socket);});socket.on("close",()=>this.handleDisconnect());socket.on("error",err=>{this.errorCount++;rejectOnce(err instanceof Error?err:new Error(String(err)));});});
  }
  private async handleMessage(raw:Buffer,socket:WebSocket):Promise<void>{let msg:{type?:string;data?:WsNotificationPayload};try{msg=JSON.parse(raw.toString("utf-8"));}catch{this.errorCount++;return;}if(msg.type!=="notification"||!msg.data)return;if(this.extraDelayMs>0)await sleep(this.extraDelayMs);const receivedAtMonoMs=performance.now();this.events.push({notificationId:msg.data.id,receivedAtMonoMs,serverCreatedAtMs:msg.data.createdAt*1000,serverSentAtMs:msg.data.serverSentAtMs});this.after=Math.max(this.after,msg.data.id);if(socket.readyState===socket.OPEN)socket.send(JSON.stringify({type:"ack",notificationId:msg.data.id}));}
  private handleDisconnect():void{if(this.stopped)return;this.reconnectTimer=setTimeout(()=>void this.open(true),1000);}
}
function sleep(ms:number):Promise<void>{return new Promise(resolve=>setTimeout(resolve,ms));}
