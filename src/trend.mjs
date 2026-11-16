import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,open} from 'node:fs/promises';
import {dirname,join} from 'node:path';

export const STATUS_FLAGS = ['logDisabled','bufferPurged','timeChange'];

// 区间为闭区间 [lo,hi]，按序号计。合并相邻区间，差集用于从待读计划中扣除已收部分。
export function mergeIntervals(intervals) {
  const sorted = [...intervals].filter(([lo,hi]) => lo <= hi).sort((a,b) => a[0]-b[0] || a[1]-b[1]);
  const merged = [];
  for (const [lo,hi] of sorted) {
    const last = merged[merged.length-1];
    if (last && lo <= last[1]+1) last[1] = Math.max(last[1],hi);
    else merged.push([lo,hi]);
  }
  return merged;
}

export function subtractIntervals(intervals, cuts) {
  let remaining = mergeIntervals(intervals);
  for (const [cutLo,cutHi] of mergeIntervals(cuts)) {
    const next = [];
    for (const [lo,hi] of remaining) {
      if (cutHi < lo || cutLo > hi) {next.push([lo,hi]);continue;}
      if (lo < cutLo) next.push([lo,cutLo-1]);
      if (hi > cutHi) next.push([cutHi+1,hi]);
    }
    remaining = next;
  }
  return remaining;
}

export function intersectIntervals(intervals, others) {
  const result = [];
  for (const [alo,ahi] of mergeIntervals(intervals)) for (const [blo,bhi] of mergeIntervals(others)) {
    const lo = Math.max(alo,blo), hi = Math.min(ahi,bhi);
    if (lo <= hi) result.push([lo,hi]);
  }
  return result;
}

export const countIntervals = intervals => intervals.reduce((total,[lo,hi]) => total+hi-lo+1,0);

// 补读状态随 DATA_DIR 持久化：重启后已收区间、被覆盖区间与事件仍然可查，
// 不会从新的 firstSequence 起把历史缺口抹掉。状态文件与 records.json 同生命周期。
export class TrendStore {
  constructor(file) { this.file = file; this.data = {objects:{}}; this.serial = Promise.resolve(); }
  async load() {
    try {this.data = JSON.parse(await readFile(this.file,'utf8'));}
    catch(error) {if(error.code === 'ENOENT') return this;throw error;}
    return this;
  }
  generation(object, generation, property) {
    const entry = this.data.objects[object] ??= {generations:{}};
    const state = entry.generations[generation] ??= {
      generation,property,collected:[],overwritten:[],events:[],
      highWater:0,snapshot:null,firstSeen:null,lastSeen:null
    };
    if (property) state.property = property;
    return state;
  }
  save() {
    const operation = this.serial.then(async () => {
      await mkdir(dirname(this.file),{recursive:true});
      const temporary = join(dirname(this.file),`${randomUUID()}.tmp`);
      await writeFile(temporary,JSON.stringify(this.data,null,2)+'\n');
      const handle = await open(temporary,'r');
      try {await handle.sync();} finally {await handle.close();}
      await rename(temporary,this.file);
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
}

const snapshotOf = object => ({
  capacity:object.capacity,totalRecordCount:object.totalRecordCount,
  firstSequence:object.firstSequence,lastSequence:object.lastSequence
});

function noteSnapshot(state, object, seen) {
  state.snapshot = snapshotOf(object);
  state.highWater = Math.max(state.highWater ?? 0,object.totalRecordCount ?? 0,object.lastSequence ?? 0);
  if (seen) {state.lastSeen = seen;state.firstSeen ??= seen;}
}

// 同一条来源记录的身份由 对象:代际:序号 决定，与读取分页、补读次数无关。
function rowFor(object, snapshot, record) {
  const row = {
    id:`${object}:${snapshot.generation}:seq:${record.sequence}`,
    object,generation:snapshot.generation,property:snapshot.logDeviceObjectProperty,
    sequence:record.sequence,time:record.time
  };
  if (Object.hasOwn(record,'value')) row.value = record.value;
  for (const flag of STATUS_FLAGS) if (record[flag]) row[flag] = true;
  return row;
}

function noteEvent(state, record) {
  for (const type of STATUS_FLAGS) {
    if (!record[type]) continue;
    if (!state.events.some(event => event.sequence === record.sequence && event.type === type))
      state.events.push({sequence:record.sequence,time:record.time,type});
  }
  state.events.sort((a,b) => a.sequence-b.sequence);
}

// 单次补读只处理一个代际：读取途中遇到 409（配置换成另一个被监测属性）即停，
// 已收部分留在旧代际名下，新代际由下一次补读独立分段，绝不跨配置拼接。
export async function backfill(client, store, options = {}) {
  const object = options.object ?? 'trend1';
  const pageSize = Math.max(1,Math.min(100,options.pageSize ?? 100));
  const snapshot = await client(`/objects/${object}`);
  const state = store.generation(object,snapshot.generation,snapshot.logDeviceObjectProperty);
  noteSnapshot(state,snapshot,new Date().toISOString());
  const plan = subtractIntervals(
    snapshot.lastSequence >= snapshot.firstSequence ? [[snapshot.firstSequence,snapshot.lastSequence]] : [],
    state.collected);
  const rows = [];
  let generationChanged = false;
  for (const [lo,hi] of plan) {
    let start = lo;
    while (start <= hi && !generationChanged) {
      let page;
      try {
        page = await client('/range',{method:'POST',body:{generation:snapshot.generation,start,count:Math.min(pageSize,hi-start+1)}});
      } catch(error) {
        if (error.status === 410 && Number.isInteger(error.data?.firstSequence)) {
          // 读取期间缓冲仍在转动，[start, firstSequence-1] 这段没来得及收就被覆盖了。
          const lostHi = Math.min(hi,error.data.firstSequence-1);
          if (lostHi >= start) state.overwritten = mergeIntervals([...state.overwritten,[start,lostHi]]);
          state.snapshot.firstSequence = Math.max(state.snapshot.firstSequence,error.data.firstSequence);
          start = error.data.firstSequence;
          continue;
        }
        if (error.status === 409) {generationChanged = true;break;}
        throw error;
      }
      const records = Array.isArray(page.records) ? page.records : [];
      if (!records.length) break;
      for (const record of records) {rows.push(rowFor(object,snapshot,record));noteEvent(state,record);}
      const first = Number.isInteger(page.firstSequence) ? page.firstSequence : records[0].sequence;
      state.collected = mergeIntervals([...state.collected,[first,first+records.length-1]]);
      start = first+records.length;
      if (!page.moreItems) break;
    }
  }
  // 读完后刷新一次窗口：缓冲在读取期间继续转动，报告要反映最新水位。
  try {
    const refreshed = await client(`/objects/${object}`);
    if (refreshed.generation === snapshot.generation) noteSnapshot(state,refreshed,new Date().toISOString());
    else noteSnapshot(store.generation(object,refreshed.generation,refreshed.logDeviceObjectProperty),refreshed,new Date().toISOString());
  } catch { /* 刷新失败则保留本次快照 */ }
  return {object,generation:snapshot.generation,rows,generationChanged};
}

// 把已知序号空间分成三类：真正收齐（已归档）、被覆盖（未收且缓冲已越过）、
// 仍在等待（未收但窗口内还可补回）。不同代际各自分段，互不拼接。
export function trendReport(store, objectName) {
  const objects = [];
  for (const [name,entry] of Object.entries(store.data.objects)) {
    if (objectName && name !== objectName) continue;
    const generations = [];
    for (const state of Object.values(entry.generations)) {
      if (!state.snapshot) continue;
      const snapshot = state.snapshot;
      const low = Math.min(1,snapshot.firstSequence);
      const high = Math.max(state.highWater ?? 0,snapshot.lastSequence ?? 0);
      const universe = high >= low ? [[low,high]] : [];
      const collected = intersectIntervals(state.collected,universe);
      const overwritten = intersectIntervals(
        subtractIntervals(mergeIntervals([...state.overwritten,[low,snapshot.firstSequence-1]]),state.collected),
        universe);
      const pending = subtractIntervals(subtractIntervals(universe,state.collected),overwritten);
      const counts = {collected:countIntervals(collected),overwritten:countIntervals(overwritten),pending:countIntervals(pending)};
      generations.push({
        generation:state.generation,property:state.property,snapshot,highWater:state.highWater,
        collected,overwritten,pending,events:state.events,counts,
        complete:counts.pending === 0 && counts.overwritten === 0,
        firstSeen:state.firstSeen,lastSeen:state.lastSeen
      });
    }
    objects.push({object:name,generations});
  }
  return {objects};
}
