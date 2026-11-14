export async function collect(client) {
  const object = await client('/objects/trend1');
  return [{id:`trend1:${object.generation}`,property:object.logDeviceObjectProperty,
    value:object.presentValue,generation:object.generation,total:object.totalRecordCount}];
}
