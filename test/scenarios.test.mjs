import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
test('来源变更与异常边界具有可观察的区别',async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const choose = name => client('/__scenario',{method:'POST',body:{name}});
await choose('overwritten');
await assert.rejects(client('/range',{method:'POST',body:{generation:'g1',start:1,count:2}}),error => error.status === 410);
const page = await client('/range',{method:'POST',body:{generation:'g1',start:6,count:2}});
assert.equal(page.records[0].sequence,6);
assert.equal(page.moreItems,true);
await choose('remapped');
await assert.rejects(client('/range',{method:'POST',body:{generation:'g1',start:1,count:2}}),error => error.status === 409);
} finally {await source.close();}
});
