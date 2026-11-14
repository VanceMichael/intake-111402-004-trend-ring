export function behavior(entry,state,fixture,scenario) {
if (entry.path !== '/range' || entry.method !== 'POST') return null;
const object = [...(fixture.cases[scenario] ?? []),...fixture.exchanges].find(route => route.path === '/objects/trend1').body;
if (entry.body?.generation !== object.generation) return {status:409,body:{error:'generation changed'}};
if (entry.body?.start < object.firstSequence) return {status:410,body:{error:'overwritten',firstSequence:object.firstSequence}};
const start = entry.body?.start, count = entry.body?.count;
if (!Number.isInteger(start) || !Number.isInteger(count) || count < 1 || count > 100) return {status:400,body:{error:'invalid range'}};
const records = Array.from({length:Math.max(0,Math.min(count,object.lastSequence-start+1))},(unusedValue,index) => ({sequence:start+index,time:10+start+index,value:21+index}));
return {body:{firstSequence:start,itemCount:records.length,moreItems:start+records.length <= object.lastSequence,records}};
}
