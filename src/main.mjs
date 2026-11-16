import {resolve} from 'node:path';
import {createSource} from './source.mjs';
import {createClient} from './transport.mjs';
import {collect} from './reader.mjs';
import {backfill,trendReport,TrendStore} from './trend.mjs';
import {Archive} from './archive.mjs';
import {createApi} from './api.mjs';

const directory = resolve(process.env.DATA_DIR ?? '.state');
const source = await createSource({port:Number(process.env.SOURCE_PORT ?? 4010),scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(directory);
const store = await new TrendStore(resolve(directory,'trend-state.json')).load();
const api = await createApi(archive,Number(process.env.PORT ?? 4020),{trend:() => trendReport(store)});
console.log(JSON.stringify({source:source.origin,api:api.origin}));
const client = createClient(source.origin);
try {
  const rows = await collect(client);
  console.log(JSON.stringify(await archive.put(rows,{source:source.origin,adapter:'current'})));
} catch(error) {console.error(error.message);}
let running = false;
const runBackfill = async () => {
  if (running) return;
  running = true;
  try {
    const result = await backfill(client,store);
    const saved = await archive.put(result.rows,{source:source.origin,adapter:'trend'});
    await store.save();
    console.log(JSON.stringify({adapter:'trend',generation:result.generation,fetched:result.rows.length,...saved}));
  } catch(error) {console.error(error.message);} finally {running = false;}
};
await runBackfill();
const timer = setInterval(runBackfill,Number(process.env.TREND_INTERVAL_MS ?? 30000));
timer.unref();
let stopping = false;
const stop = async () => {if(stopping) return;stopping = true;clearInterval(timer);await store.save();await Promise.all([source.close(),api.close()]);};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
