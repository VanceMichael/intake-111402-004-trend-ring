import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect} from '../src/reader.mjs';
let source,client;
before(async () => {source = await createSource();client = createClient(source.origin);});
after(async () => {await source.close();});

test('对象快照包含属性映射与缓冲代际', async () => {
  const rows = await collect(client);
  assert.equal(rows[0].property, 'ahu/temp');
  const range = await client('/range', {method:'POST',body:{generation:'g1',start:1,count:2}});
  assert.equal(range.records.length, 2);
});
