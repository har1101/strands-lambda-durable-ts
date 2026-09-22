import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { readEvents } from "./events.js";

const functionArn = process.env.DURABLE_FUNCTION_ARN;
const table = process.env.EVENTS_TABLE;
if (!functionArn || !table) throw new Error("Set DURABLE_FUNCTION_ARN and EVENTS_TABLE from the SAM stack outputs");
const lambda = new LambdaClient({});
const port = Number(process.env.PORT ?? 8787);

const page = String.raw`<!doctype html><html lang="ja"><meta charset="utf-8"><title>Durable Strands PoC</title>
<style>body{font:16px system-ui;max-width:800px;margin:3rem auto;padding:0 1rem;color:#17212b}textarea{width:100%;height:5rem;font:inherit}button{padding:.6rem 1rem;margin:.7rem 0}pre{white-space:pre-wrap;background:#f2f5f8;padding:1rem;min-height:8rem}small{color:#52606d}</style>
<h1>Durable Strands Agent</h1><p>Lambda Durable Functions / Bedrock / live text</p>
<textarea id="prompt">add_numbers を使って 12 と 30 を足し、結果を日本語で説明して。</textarea><br>
<label><input type="checkbox" id="probe">モデル完了後に一度中断して replay を検証</label><br><button id="start">実行</button>
<div><small id="status">待機中</small></div><pre id="output"></pre><small id="tools"></small>
<script>
let source, attempts = new Map(), textByCall = new Map();
function visible(raw) {
  return raw.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '').replace(/<think[\s\S]*$/g, '');
}
function render(output) {
  output.textContent = [...textByCall.entries()].sort((a,b) => a[0]-b[0]).map(([call,text]) => '[model ' + call + '] ' + visible(text)).join('\n');
}
document.getElementById('start').onclick = async () => {
  if (source) source.close(); attempts = new Map(); textByCall = new Map();
  const output = document.getElementById('output'), status = document.getElementById('status'), tools = document.getElementById('tools');
  output.textContent = ''; tools.textContent = ''; status.textContent = '開始中…';
  try {
    const response = await fetch('/runs', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({prompt:document.getElementById('prompt').value,replayProbe:document.getElementById('probe').checked}) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error);
    status.textContent = '実行中: ' + data.runId;
    source = new EventSource('/events?runId=' + encodeURIComponent(data.runId));
    source.onmessage = ({data}) => {
      const event = JSON.parse(data);
      if (event.kind === 'model_start') { attempts.set(event.call,event.attempt); textByCall.set(event.call,''); render(output); }
      if (event.kind === 'text' && attempts.get(event.call) === event.attempt) { textByCall.set(event.call, textByCall.get(event.call) + event.text); render(output); }
      if (event.kind === 'tool' && event.status !== 'progress') tools.textContent += '\n' + event.tool + ': ' + event.status;
      if (event.kind === 'done') { status.textContent = '完了: ' + data.runId; source.close(); }
      if (event.kind === 'failed') { status.textContent = '失敗: ' + event.text; source.close(); }
    };
  } catch (error) { status.textContent = String(error); }
};
</script></html>`;

async function body(req: IncomingMessage): Promise<string> {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 4096) throw new Error("Request too large");
  }
  return data;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
    return;
  }
  if (req.method === "POST" && url.pathname === "/runs") {
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
      throw new Error("Cross-origin request rejected");
    }
    if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("Expected JSON");
    const input = JSON.parse(await body(req)) as { prompt?: string; replayProbe?: boolean };
    if (!input.prompt || input.prompt.length > 2000) throw new Error("Prompt must be 1–2000 characters");
    const runId = randomUUID();
    const response = await lambda.send(new InvokeCommand({
      FunctionName: functionArn,
      InvocationType: "Event",
      DurableExecutionName: runId,
      Payload: new TextEncoder().encode(JSON.stringify({ runId, prompt: input.prompt, replayProbe: input.replayProbe === true })),
    }));
    res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ runId, durableExecutionArn: response.DurableExecutionArn }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/events") {
    const runId = url.searchParams.get("runId");
    if (!runId || !/^[a-zA-Z0-9-]{1,80}$/.test(runId)) throw new Error("Invalid runId");
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    const lastEventId = req.headers["last-event-id"];
    let after = typeof lastEventId === "string" && /^[0-9]{13}-[0-9]{8}-[0-9a-f-]{36}$/.test(lastEventId)
      ? lastEventId : undefined;
    const deadline = Date.now() + 120000;
    while (!res.destroyed && Date.now() < deadline) {
      const events = await readEvents(table!, runId, after);
      for (const event of events) {
        after = event.key;
        res.write(`id: ${event.key}\ndata: ${JSON.stringify(event)}\n\n`);
        if (event.kind === "done" || event.kind === "failed") { res.end(); return; }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    res.end();
    return;
  }
  res.writeHead(404); res.end("Not found");
}

createServer((req, res) => {
  handle(req, res).catch(error => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  });
}).listen(port, "127.0.0.1", () => console.log(`Viewer: http://127.0.0.1:${port}`));
