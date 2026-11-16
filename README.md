# 楼宇趋势环形日志的越界采集

楼宇趋势接入器。对象读取已支持 presentValue；趋势接口使用本地网关投影，ReadRange 返回的序号受 32 位环回约束。

## 运行

Node.js 22.23.4，依赖仅为标准库，package-lock.json 不含网络依赖。无需安装数据库或访问外站。

```sh
npm test
npm run demo
npm start
```

demo 从空临时目录启动来源与查询服务，实际领取并打印收件结果后退出，通常不到 5 秒。持续运行时来源监听 4010，查询服务监听 4020；GET /records 返回已收原件，GET /trend 返回趋势区间报告，GET /health 检查服务。

```sh
docker build --network=none -t trend-ring .
docker run --rm --network=none trend-ring npm test
docker run --rm --network=none trend-ring npm run demo
```

Dockerfile 固定 Node 镜像摘要。首次使用需预载该镜像，运行和测试不下载任何内容。现场演示可执行 npm run demo，在90秒内完成启动、实际收件与查询。

## 工程结构

- src/reader.mjs 是当前来源适配器；不修改来源来迎合适配结果。
- src/trend.mjs 是趋势补读：按代际分段读取 /range，维护收齐、被覆盖、待补区间与启停事件。
- src/source.mjs 与 src/behavior.mjs 实现本地来源网关，契约见 contracts.md。
- src/archive.mjs 保存来源与内容摘要；同内容重收不新增，内容变化保留版本。
- src/api.mjs 提供收件查询；.state 为运行状态，停止后可删除恢复空收件箱。
- fixtures/source.json 是虚构来源资料和状态变化，不含真实账号、交易或个人数据。

## 趋势补读

补读以网关给出的代际（generation）、总写入计数（totalRecordCount）和记录序号为依据：

- 每个代际独立分段。配置换成另一个被监测属性时代际变化，旧代际已收部分原样保留，新代际从零开始自己分段，不为凑连续曲线把不同配置的数据接在一起；读取途中收到 409 即停止本次补读。
- 已收序号区间持久化在 DATA_DIR/trend-state.json，重启后继续说明历史缺口，不会从新的 firstSequence 起把缺口抹掉。该文件与 records.json 同生命周期，一起删除即恢复空白。
- 读取期间缓冲仍在转动：请求起点被覆盖时来源返回 410 和新的 firstSequence，没来得及收的序号段记为被覆盖，从新起点续读；每轮结束刷新一次窗口，报告反映最新水位。
- 同一条来源记录的身份是 对象:代际:序号，与分页和补读次数无关；已收区间不会重复抓取，重复补读归档新增为零。
- 状态记录（logDisabled、bufferPurged、timeChange）随数据记录归档，并作为启停事件列入区间报告，解释停机与对时造成的时间断点。

GET /trend 的报告按对象和代际给出 collected（真正收齐）、overwritten（未收且缓冲已越过）、pending（仍在窗口内可补回）三类区间及计数，维修人员可据此判断还有多少日志可以补回。TREND_INTERVAL_MS 控制持续运行时的补读间隔，默认 30000 毫秒。

环境变量 DATA_DIR、PORT、SOURCE_PORT 控制目录和端口；SCENARIO 选择本地来源资料版本；TREND_INTERVAL_MS 控制补读间隔。测试和演示自己创建空目录，不依赖上次执行遗留状态。
