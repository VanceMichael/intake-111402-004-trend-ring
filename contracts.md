# 来源网关契约

GET /objects/trend1 返回 generation、capacity、totalRecordCount、firstSequence、lastSequence、logDeviceObjectProperty。POST /range 接受 generation、start、count；返回 firstSequence、itemCount、moreItems、records。状态记录含 logDisabled、bufferPurged 或 timeChange。generation 不一致返回 409；起点已被覆盖返回 410 和新的 firstSequence。

缓冲是环形的：窗口随 totalRecordCount 滑动，容量之外的旧序号被覆盖。读取期间窗口可能继续前进，相邻两次请求的 firstSequence、lastSequence 不必相同；同一条记录的内容只取决于它的序号，与分页方式无关。适配器按 对象:代际:序号 确定记录身份，按代际分段，不把不同代际（被监测属性不同）的数据接成连续曲线。

## 本地来源操作

默认场景 normal，其他场景为 overwritten, shutdown, rotating, remapped。设置 SCENARIO 后启动可固定一个变体。POST /__scenario 的 name 切换来源场景并清空来源会话状态，供开发人员在测试中模拟外部变化；采集适配器不调用此控制入口。GET /__audit 返回所有真实来源请求、当前场景与会话状态。除明确列出的状态变化外，GET 可重复读取，消息可能重复领取。

来源路由的 requires 表示通信前提，sets 是来源端会话状态转移。源端拒绝返回对应HTTP状态和JSON原因，适配器不能把错误响应当业务内容。所有URL限定本地来源，未知资源404；fixture中的静态资料与 src/behavior.mjs 的状态处理共同构成来源行为。接口为授权网关的有限资料投影，不宣称覆盖协议全部版本或完整线路栈。

## 收存约定

当前适配器 collect(client) 返回带字符串 id 的原件行。Archive.put(rows, provenance) 按实际内容和来源生成摘要，保留不同内容。该原件归档不自动决定业务当前值、引用已解析、区间完整或远端已确认；业务投影与领取状态需要各自维护。GET /records 保留兼容，不将未知状态伪造为成功。

## 趋势补读约定

backfill(client, store) 每轮只处理一个代际：先取对象快照，按窗口内未收序号分段读取 /range；410 时把没来得及收的序号段记入被覆盖并从新的 firstSequence 续读，409 时结束本轮，新代际留给下一轮。已收区间、被覆盖区间、启停事件与最新窗口持久化在 DATA_DIR/trend-state.json，重启后报告仍能说明历史缺口。GET /trend 按对象和代际返回 collected、overwritten、pending 三类区间、计数与事件；pending 非空表示还有日志可以补回。报告是适配器一侧的维护视图，不修改来源，也不把归档内容改写为业务当前值。
