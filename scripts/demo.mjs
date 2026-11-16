import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect} from '../src/reader.mjs';
import {backfill,trendReport,TrendStore} from '../src/trend.mjs';
import {Archive} from '../src/archive.mjs';
import {createApi} from '../src/api.mjs';

const directory = await mkdtemp(join(tmpdir(),'intake-'));
const source = await createSource({scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(directory);
const store = await new TrendStore(join(directory,'trend-state.json')).load();
const api = await createApi(archive,0,{trend:() => trendReport(store)});
try {
  console.log('本地来源',source.origin);
  const client = createClient(source.origin);
  const rows = await collect(client);
  console.log('当前值收件',JSON.stringify(await archive.put(rows,{source:source.origin,adapter:'current'})));
  const trend = await backfill(client,store);
  console.log('趋势补读收件',JSON.stringify(await archive.put(trend.rows,{source:source.origin,adapter:'trend'})));
  await store.save();
  const again = await backfill(client,store);
  console.log('重复补读新增记录数',again.rows.length);
  console.log('区间报告',JSON.stringify(trendReport(store)));
  const response = await fetch(`${api.origin}/records`);
  console.log('查询原始结果',await response.text());
  console.log('趋势区间接口',JSON.stringify(await (await fetch(`${api.origin}/trend`)).json()));
  console.log('来源交互',JSON.stringify(await createClient(source.origin)('/__audit')));
} finally {await Promise.all([source.close(),api.close()]);await rm(directory,{recursive:true,force:true});}
