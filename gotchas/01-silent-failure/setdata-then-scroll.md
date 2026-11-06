# setData 之后立刻调 pageScrollTo，滚动没反应

- **分类**：静默失败
- **触发概率**：极高。只要 AI 写「点某条之后自动滚到它」，基本必踩
- **危险等级**：功能整体失效，且无任何报错提示

## 症状

场景：列表页支持展开某一条，展开后要自动滚动到它。

实际表现：

- 点击后条目确实展开了（说明 `setData` 生效了）
- 页面纹丝不动，没有滚动
- 控制台干干净净，没有报错、没有警告
- 模拟器上偶尔"看起来是好的"，真机上稳定失败

最容易让人误判的是**展开生效了但滚动没生效**——于是第一反应是"滚动 API 用错了"，去查参数、查选择器写法，查半天查不出问题。

## AI 的默认写法

```js
// ❌ 会踩雷
onExpand(e) {
  const id = e.currentTarget.dataset.id;
  this.setData({ list: this.data.list, expandedId: id });
  wx.pageScrollTo({ selector: '#item-' + id, duration: 300 });
}
```

AI 为什么会这么写：这是从 React / Vue 那套直觉推出来的——状态更新完，DOM 就位，接下来操作 DOM 天经地义。在 React 里最多用个 `useEffect` 兜一下，在这个场景下 AI 甚至不会觉得需要兜。

它不知道的是：小程序的 `setData` 是**跨线程通信**，不是给本地对象赋个值。

## 根因

小程序的运行时分两层：

- **逻辑层**（你的 JS 跑在这里）
- **视图层**（WXML 渲染在这里）

`setData` 做的事情是「把数据序列化后发给视图层」，是个异步过程。你写下一行 `wx.pageScrollTo` 的时候：

- 逻辑层已经执行到下一行了
- 视图层可能**还没渲染出 `#item-xx` 这个元素**

于是选择器找不到目标。而 `pageScrollTo` 找不到元素时**不抛错**——它走 `fail` 回调，而你没写 `fail`，于是什么都没有发生。

三段信息一起消失：滚动的效果、报错、以及你对"到底哪一步错了"的判断依据。

## 正确写法

```js
// ✅
onExpand(e) {
  const id = e.currentTarget.dataset.id;

  this.setData({ expandedId: id }, () => {
    wx.nextTick(() => {
      wx.pageScrollTo({
        selector: '#item-' + id,
        duration: 300,
        fail() {}   // 元素确实不存在时（列表为空等）静默跳过
      });
    });
  });
}
```

两个要点：

1. **`setData` 的第二个参数是渲染完成回调**，比 `setData` 本身晚得多
2. **回调里再套一层 `wx.nextTick`**，等视图层真正把这一帧落下去

`wx.nextTick` 的开销接近于零，这里不需要权衡"要不要为了性能省掉"——省掉它换来的是偶发的、难复现的失败。

## 为什么不能省掉 nextTick

`setData` 的回调触发时，逻辑层已确认数据下发成功。但"数据到位"和"节点可被选择器查到"之间还隔着一个渲染帧。

这层差距在高端机上通常被掩盖，在低端机或者列表很长的时候暴露出来——表现为"有时候能滚，有时候不能滚"。这种偶发性是最贵的 bug，因为 CI 抓不到、用户投诉也说不清。

## 怎么验证

不要靠"点一下看看"。按顺序做：

1. **真机测，不是模拟器**。模拟器和真机是两套渲染时序，模拟器通过不代表真机通过
2. **列表拉长到 50 条以上再测**，渲染压力会放大时序差
3. **来回切两次不同条目**，确认不是只有第一次生效
4. 想更确定，在回调里用 `this.createSelectorQuery().select('#item-xx').boundingClientRect()` 查一下，`null` 说明节点还没出来

## 反例：用 setTimeout 当修法

```js
// ⚠️ 能跑，但不是修法
this.setData({ expandedId: id });
setTimeout(() => {
  wx.pageScrollTo({ selector: '#item-' + id, duration: 300 });
}, 300);
```

这是碰运气。低端机上 300ms 不够，仍然失败；高端机上白等 300ms，用户感知到卡顿。

判断标准很简单：**修法如果依赖"等足够久"，那它就不是修法，是把时序问题换成了概率问题。**

## 相关的坑

同一个根因还会在别的 API 上复现——凡是「需要读取渲染后节点」的操作，都不能紧跟在 `setData` 后面：

- `createSelectorQuery()` 查节点尺寸
- `pageScrollTo` 的 `selector` 参数
- 获取某个元素的 `boundingClientRect` 做动画起点

反过来说，`setData` 的**渲染回调**是这类操作的唯一正确入口。
