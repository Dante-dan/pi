import { fauxAssistantMessage, type AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { stream as streamCompletions } from "../../../../ai/src/api/openai-completions.ts";

const wire = vi.hoisted(() => ({calls: 0}));
vi.mock("openai", () => ({ default: class {
  chat = {completions: {create: () => {
    const attempt = ++wire.calls;
    const data = {async *[Symbol.asyncIterator]() {
      yield {id:"fake",choices:[{index:0,delta:attempt===1?{reasoning:"still thinking"}:{content:"recovered"}}]};
      if (attempt===1) throw new TypeError("terminated");
      yield {id:"fake",choices:[{index:0,delta:{},finish_reason:"stop"}]};
    }};
    const p = Promise.resolve(data) as Promise<typeof data> & {withResponse:()=>Promise<unknown>};
    p.withResponse=async()=>({data,response:{status:200,headers:new Headers()}});
    return p;
  }}};
}}));

// Local investigation only: synthetic versions of the issue's two independent symptoms.
const harnesses: Harness[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

it("retries a zero-usage terminated response after partial thinking", async () => {
  const harness = await createHarness({settings:{retry:{enabled:true,maxRetries:2,baseDelayMs:1}}});
  harnesses.push(harness);
  const failure = fauxAssistantMessage("", {stopReason:"error",errorMessage:"terminated"});
  failure.content = [{type:"thinking", thinking:"partial reasoning"}];
  failure.usage = {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  harness.setResponses([failure,fauxAssistantMessage("recovered")]);
  await harness.session.prompt("test local provider interruption");
  expect(harness.faux.state.callCount).toBe(2);
  expect(harness.eventsOfType("auto_retry_end").at(-1)).toMatchObject({success:true});
});

it("retries the actual OpenAI-compatible stream adapter after its SDK iterator terminates", async () => {
  wire.calls=0;
  const harness=await createHarness({settings:{retry:{enabled:true,maxRetries:2,baseDelayMs:1}}});
  harnesses.push(harness);
  harness.session.agent.streamFunction=(model,context,options)=>streamCompletions({...model,api:"openai-completions",reasoning:true,baseUrl:"http://127.0.0.1:11434/v1"},context,{...options,apiKey:"test"});
  await harness.session.prompt("test partial stream failure");
  expect(wire.calls).toBe(2);
  expect(harness.eventsOfType("auto_retry_end").at(-1)).toMatchObject({success:true});
});

it("re-arms threshold checks after the first compaction for the reported usage sequence", async () => {
  const harness = await createHarness({models:[{id:"faux-1",contextWindow:81920,maxTokens:8192}],settings:{compaction:{enabled:true,reserveTokens:8192,keepRecentTokens:16384}}});
  harnesses.push(harness);
  harness.sessionManager.appendMessage({role:"user",content:"before compaction",timestamp:Date.now()-10000});
  harness.sessionManager.appendCompaction("summary",harness.sessionManager.getEntries()[0]!.id,81917,undefined,false);
  const session = harness.session as unknown as {_checkCompaction:(m:AssistantMessage)=>Promise<boolean>;_runAutoCompaction:(r:string,w:boolean)=>Promise<boolean>};
  const run = vi.spyOn(session,"_runAutoCompaction").mockResolvedValue(false);
  const model=harness.getModel();
  for(const input of [70895,72577,74545,75438,76519,78782,78788,78756,81251]) {
    run.mockClear();
    const message = {...fauxAssistantMessage("next",{timestamp:Date.now()+1000}),api:model.api,provider:model.provider,model:model.id};
    message.usage={input,output:0,cacheRead:0,cacheWrite:0,totalTokens:input,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
    await session._checkCompaction(message);
    expect(run.mock.calls.length,`input=${input}`).toBe(input>73728?1:0);
  }
});

it("persists two automatic compactions after retained context genuinely grows again", async () => {
  const harness=await createHarness({models:[{id:"faux-1",contextWindow:81920,maxTokens:8192}],settings:{compaction:{enabled:true,reserveTokens:8192,keepRecentTokens:16384}}});
  harnesses.push(harness);
  harness.setResponses(Array.from({length:8},()=>fauxAssistantMessage("synthetic compact summary")));
  const session=harness.session as unknown as {_checkCompaction:(m:AssistantMessage)=>Promise<boolean>};
  for (let pass=0;pass<2;pass++) {
    const model=harness.getModel();
    harness.sessionManager.appendMessage({role:"user",content:"x".repeat(80000),timestamp:Date.now()+1000+pass});
    const message={...fauxAssistantMessage("y".repeat(80000),{timestamp:Date.now()+2000+pass}),api:model.api,provider:model.provider,model:model.id};
    message.usage={input:74545,output:0,cacheRead:0,cacheWrite:0,totalTokens:74545,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
    harness.sessionManager.appendMessage(message);
    harness.session.agent.state.messages=harness.sessionManager.buildSessionContext().messages;
    await session._checkCompaction(message);
  }
  expect(harness.sessionManager.getEntries().filter(e=>e.type==="compaction")).toHaveLength(2);
});
