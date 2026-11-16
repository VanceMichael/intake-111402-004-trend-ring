import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient,SourceError} from '../src/transport.mjs';
import {Archive} from '../src/archive.mjs';
import {createApi} from '../src/api.mjs';
import {backfill,trendReport,TrendStore,mergeIntervals,subtractIntervals} from '../src/trend.mjs';

async function withTempDir(fn) {
  const directory = await mkdtemp(join(tmpdir(),'trend-'));
  try {return await fn(directory);}
  finally {await rm(directory,{recursive:true,force:true});}
}
async function withSource(scenario,fn) {
  const source = await createSource({scenario});
  try {return await fn(source,createClient(source.origin));}
  finally {await source.close();}
}
const onlyGeneration = store => trendReport(store).objects[0].generations[0];

test('区间合并与差集',() => {
  assert.deepEqual(mergeIntervals([[5,6],[1,2],[3,4]]),[[1,6]]);
  assert.deepEqual(mergeIntervals([[1,2],[4,5]]),[[1,2],[4,5]]);
  assert.deepEqual(subtractIntervals([[1,10]],[[3,4],[7,7]]),[[1,2],[5,6],[8,10]]);
  assert.deepEqual(subtractIntervals([[1,3]],[[1,3]]),[]);
});

test('正常场景补读收齐，重复补读保持记录身份',async () => withSource('normal',async (source,client) => {
  await withTempDir(async directory => {
    const store = await new TrendStore(join(directory,'trend-state.json')).load();
    const archive = new Archive(directory);
    const first = await backfill(client,store);
    assert.deepEqual(first.rows.map(row => row.id),['trend1:g1:seq:1','trend1:g1:seq:2']);
    assert.equal((await archive.put(first.rows,{source:source.origin,adapter:'trend'})).added,2);
    await store.save();
    const generation = onlyGeneration(store);
    assert.deepEqual(generation.collected,[[1,2]]);
    assert.deepEqual(generation.overwritten,[]);
    assert.deepEqual(generation.pending,[]);
    assert.equal(generation.complete,true);
    const again = await backfill(client,store);
    assert.equal(again.rows.length,0);
    assert.equal((await archive.put(again.rows,{source:source.origin,adapter:'trend'})).added,0);
    const audit = await client('/__audit');
    assert.equal(audit.requests.filter(request => request.path === '/range').length,1);
  });
}));

test('已被覆盖的区间与可补回的区间分别标注',async () => withSource('overwritten',async (source,client) => {
  await withTempDir(async directory => {
    const store = await new TrendStore(join(directory,'trend-state.json')).load();
    const result = await backfill(client,store);
    assert.deepEqual(result.rows.map(row => row.sequence),[6,7,8]);
    const generation = onlyGeneration(store);
    assert.deepEqual(generation.collected,[[6,8]]);
    assert.deepEqual(generation.overwritten,[[1,5]]);
    assert.deepEqual(generation.pending,[]);
    assert.equal(generation.snapshot.totalRecordCount,8);
    assert.equal(generation.complete,false);
  });
}));

test('读取期间缓冲继续转动，被挤出的区间记为被覆盖',async () => withSource('rotating',async (source,client) => {
  await withTempDir(async directory => {
    const store = await new TrendStore(join(directory,'trend-state.json')).load();
    const first = await backfill(client,store,{pageSize:1});
    assert.deepEqual(first.rows.map(row => row.sequence),[2]);
    let generation = onlyGeneration(store);
    assert.deepEqual(generation.collected,[[2,2]]);
    assert.deepEqual(generation.overwritten,[[1,1],[3,7]]);
    assert.deepEqual(generation.pending,[[8,10]]);
    const second = await backfill(client,store);
    assert.deepEqual(second.rows.map(row => row.sequence),[8,9,10]);
    generation = onlyGeneration(store);
    assert.deepEqual(generation.collected,[[2,2],[8,10]]);
    assert.deepEqual(generation.overwritten,[[1,1],[3,7]]);
    assert.deepEqual(generation.pending,[[11,12]]);
  });
}));

test('配置切换到另一被监测属性时分段保存，不跨配置拼接',async () => {
  const source = await createSource({scenario:'normal'});
  try {
    const client = createClient(source.origin);
    await withTempDir(async directory => {
      const store = await new TrendStore(join(directory,'trend-state.json')).load();
      const before = await backfill(client,store);
      assert.equal(before.generation,'g1');
      await client('/__scenario',{method:'POST',body:{name:'remapped'}});
      const after = await backfill(client,store);
      assert.equal(after.generation,'g2');
      assert.deepEqual(after.rows.map(row => row.id),['trend1:g2:seq:1']);
      assert.equal(after.rows[0].property,'ahu/humidity');
      const generations = trendReport(store).objects[0].generations;
      assert.equal(generations.length,2);
      const [g1,g2] = generations;
      assert.equal(g1.property,'ahu/temp');
      assert.deepEqual(g1.collected,[[1,2]]);
      assert.equal(g2.property,'ahu/humidity');
      assert.deepEqual(g2.collected,[[1,1]]);
      assert.equal(g1.complete && g2.complete,true);
    });
  } finally {await source.close();}
});

test('读取途中配置变更即停止，已收部分留在原代际',async () => {
  await withTempDir(async directory => {
    const store = await new TrendStore(join(directory,'trend-state.json')).load();
    const snapshot = {generation:'g1',capacity:4,totalRecordCount:4,firstSequence:1,lastSequence:4,logDeviceObjectProperty:'ahu/temp'};
    const client = async (path,request = {}) => {
      if (path === '/objects/trend1') return snapshot;
      if (path === '/range' && request.body.start === 1) return {firstSequence:1,itemCount:2,moreItems:true,
        records:[{sequence:1,time:11,value:21},{sequence:2,time:12,value:22}]};
      if (path === '/range') throw new SourceError(409,{error:'generation changed'});
      throw new Error(`unexpected ${path}`);
    };
    const result = await backfill(client,store,{pageSize:2});
    assert.equal(result.generationChanged,true);
    assert.deepEqual(result.rows.map(row => row.sequence),[1,2]);
    const generation = onlyGeneration(store);
    assert.deepEqual(generation.collected,[[1,2]]);
    assert.deepEqual(generation.pending,[[3,4]]);
    assert.deepEqual(generation.overwritten,[]);
  });
});

test('启停与异常事件随记录归档并进入区间报告',async () => withSource('shutdown',async (source,client) => {
  await withTempDir(async directory => {
    const store = await new TrendStore(join(directory,'trend-state.json')).load();
    const result = await backfill(client,store);
    assert.equal(result.rows.length,6);
    assert.equal(result.rows.find(row => row.logDisabled).sequence,3);
    assert.ok(result.rows.find(row => row.bufferPurged));
    assert.ok(result.rows.find(row => row.timeChange));
    const generation = onlyGeneration(store);
    assert.deepEqual(generation.events,[
      {sequence:3,time:13,type:'logDisabled'},
      {sequence:5,time:15,type:'bufferPurged'},
      {sequence:6,time:16,type:'timeChange'}
    ]);
    assert.equal(generation.complete,true);
  });
}));

test('重启后仍说明历史缺口，而不是从新的首条记录抹掉',async () => withSource('overwritten',async (source,client) => {
  await withTempDir(async directory => {
    const file = join(directory,'trend-state.json');
    const store = await new TrendStore(file).load();
    await backfill(client,store);
    await store.save();
    const restored = await new TrendStore(file).load();
    const generation = onlyGeneration(restored);
    assert.deepEqual(generation.collected,[[6,8]]);
    assert.deepEqual(generation.overwritten,[[1,5]]);
    const again = await backfill(client,restored);
    assert.equal(again.rows.length,0);
  });
}));

test('查询服务暴露趋势区间报告',async () => withSource('normal',async (source,client) => {
  await withTempDir(async directory => {
    const store = await new TrendStore(join(directory,'trend-state.json')).load();
    const archive = new Archive(directory);
    await backfill(client,store);
    const api = await createApi(archive,0,{trend:() => trendReport(store)});
    try {
      const report = await (await fetch(`${api.origin}/trend`)).json();
      assert.equal(report.objects[0].generations[0].complete,true);
      assert.equal((await fetch(`${api.origin}/records`)).status,200);
    } finally {await api.close();}
  });
}));
