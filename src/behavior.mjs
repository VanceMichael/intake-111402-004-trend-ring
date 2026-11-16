export function behavior(entry,state,fixture,scenario) {
const routes = [...(fixture.cases[scenario] ?? []),...fixture.exchanges];
const route = routes.find(candidate => candidate.path === '/objects/trend1' && candidate.method === 'GET');
if (!route) return null;
const object = route.body;
const log = route.log ?? {};
const rotate = log.rotatePerRange ?? 0;
const writes = state.writes ?? 0;
// 环形缓冲：窗口随总写入计数滑动，容量之外的旧序号被覆盖。
const total = object.totalRecordCount+writes;
const first = Math.max(object.firstSequence,total-object.capacity+1);
const last = total;
if (entry.path === '/objects/trend1' && entry.method === 'GET') {
  if (!rotate) return null;
  return {body:{...object,totalRecordCount:total,firstSequence:first,lastSequence:last}};
}
if (entry.path !== '/range' || entry.method !== 'POST') return null;
if (entry.body?.generation !== object.generation) return {status:409,body:{error:'generation changed'}};
if (entry.body?.start < first) {state.writes = writes+rotate;return {status:410,body:{error:'overwritten',firstSequence:first}};}
const start = entry.body?.start, count = entry.body?.count;
if (!Number.isInteger(start) || !Number.isInteger(count) || count < 1 || count > 100) return {status:400,body:{error:'invalid range'}};
// 同一条记录的内容只取决于序号，与读取分页无关；状态记录（启停、清除、对时）按序号就位。
const status = new Map((log.status ?? []).map(record => [record.sequence,record]));
const records = Array.from({length:Math.max(0,Math.min(count,last-start+1))},(unusedValue,index) => {
  const sequence = start+index;
  return status.get(sequence) ?? {sequence,time:10+sequence,value:20+sequence};
});
state.writes = writes+rotate;
return {body:{firstSequence:start,itemCount:records.length,moreItems:start+records.length <= last,records}};
}
