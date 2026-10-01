# 插件架构参考指南

> 为第三方开发者生成的完整插件分析文档。日期：2026-10-01

## 概述

wargame 项目包含 **38 个插件**，按依赖关系分为 6 个层级（0-5）。该文档详细记录了每个插件的：

- ID 和功能描述
- 依赖关系
- 对外暴露的 API（服务、视图、命令、配置规则）
- 所属的架构层级

## 架构分层

### Layer 0 - 核心基础 (10 个插件)

不依赖任何其他游戏系统的基础设施。这些是系统运行的最底层。

| 插件 ID | 描述 | 服务 | 视图 | 配置 |
| --------- | ------ | ------ | ------ | ------ |
| `accounts` | 登录、会话和 GM 超级用户 | accounts, session | - | - |
| `forms` | 通用表单渲染 | - | ui.forms | - |
| `http-api` | JSON API 端点 | - | - | - |
| `items` | 玩家物品栏 | items | items.inventory | - |
| `mail` | 邮箱系统 | mail | mail.inbox | keep |
| `resources` | 资源池管理 | resources | resources.pool | baseCapacity, debtLimit, initial |
| `settlements` | 城池基础 | settlements | - | - |
| `stats` | 数值系统（基础值+加成） | stats | - | - |
| `timeline` | 时间线事件系统 | timeline | - | - |
| `world-map` | 1024x1024 地图和占用管理 | worldMap | world-map.markers | - |

### Layer 1 - 系统插件 (7 个插件)

基于 Layer 0 实现的关键游戏系统。

| 插件 ID | 描述 | 依赖 | 服务 | 关键特性 |
| --------- | ------ | ------ | ------ | --------- |
| `buildings` | 建筑系统 | settlements, resources, stats, timeline | buildings | 升级队列、容量、时间修改器 |
| `equipment` | 装备系统 | heroes, settlements, resources, stats, timeline, buildings | equipment | 装备存储、穿戴 |
| `gm` | GM 控制台 | accounts | configStore | 规则修改、玩家检查、审计日志 |
| `heroes` | 英雄系统 | settlements, buildings, resources, stats | heroes | 招募、属性、责任 |
| `invites` | 邀请码注册 | accounts | - | 条件注册 |
| `research` | 科技树系统 | buildings, settlements, resources, stats, timeline | research | 队列、解锁、加成 |
| `troops` | 兵种系统 | settlements, resources, timeline | troops | 训练、驻防、消耗 |

### Layer 2 - 核心游戏 (5 个插件)

基于系统插件实现的核心玩法。

| 插件 ID | 描述 | 依赖 | 服务 | 关键机制 |
| --------- | ------ | ------ | ------ | --------- |
| `armies` | 行军系统 | troops, settlements, world-map, timeline, resources, accounts, stats | armies | 任务、阵型选项、遭遇 |
| `battle` | 战斗系统 | troops, settlements, armies, stats | battle | 5车道、修饰符、伤亡 |
| `player-settlements` | 玩家城池类型 | settlements, resources | - | 首都、城市、要塞 |
| `settling` | 建立新城 | armies, settlements, stats, world-map | - | 远征、定居任务 |
| `terrain` | 地形系统 | world-map, settlements, buildings, resources | terrain | 地块地形、生产加成 |

### Layer 3 - 内容系统 (7 个插件)

基于核心游戏实现的内容和 NPC 系统。

| 插件 ID | 描述 | 特点 |
| --------- | ------ | ------ |
| `battle` | 5 车道战斗 | 修饰符、伤亡钩子 |
| `npc-camps` | NPC 要塞和前哨 | 可掠夺、多等级 |
| `pvp` | 玩家对战 | 掠夺、初级保护 |
| `realms` | 冒险副本 | 英雄冒险、怪物战 |
| `shop` | 优惠券商店 | 每日限额、价格配置 |
| `starter-army` | 默认兵种 | 6 个等级、三个系族 |
| `starter-content` | 默认资源建筑 | 4 种资源、生产建筑 |

### Layer 4 - 高级内容 (6 个插件)

建立在内容系统之上的高级特性。

| 插件 ID | 描述 | 关键依赖 |
| --------- | ------ | --------- |
| `starter-auxiliary` | 辅助兵种 | troops, battle, armies |
| `starter-defense` | 城墙和隐藏储存 | buildings, battle, pvp |
| `starter-equipment` | 装备内容 | equipment, heroes, realms, battle |
| `starter-heroes` | 英雄招募点 | heroes 的 6 个属性和 3 个招募处 |
| `starter-research` | 科技树内容 | 4x4 科技树矩阵 |
| `war-reports` | 战争报告 | mail, armies, pvp, troops |

### Layer 5 - 内容表现 (4 个插件)

最高层级的内容表现和扩展。

| 插件 ID | 描述 | 依赖 |
| --------- | ------ | ------ |
| `starter-items` | 物品系统内容 | 许多（11 个） |
| `starter-realms` | 冒险副本内容 | realms, heroes, items, 等 |
| `starter-shop` | 商店默认商品 | shop, starter-items |
| `starter-siege` | 壁垒防御工程 | starter-defense, buildings, 等 |

## 核心服务 (20 个)

所有系统通过服务相互通信。主要服务包括：

| 服务名 | 提供者 | 用途 |
| -------- | -------- | ------ |
| `accounts` | accounts | 用户管理、身份验证 |
| `armies` | armies | 行军管理 |
| `battle` | battle | 战斗计算 |
| `buildings` | buildings | 建筑查询、升级 |
| `configStore` | gm | GM 规则覆盖 |
| `equipment` | equipment | 装备管理 |
| `heroes` | heroes | 英雄管理 |
| `items` | items | 物品库存 |
| `mail` | mail | 邮件系统 |
| `pvp` | pvp | 玩家对战 |
| `realms` | realms | 冒险副本 |
| `research` | research | 科技树 |
| `resources` | resources | 资源池 |
| `session` | accounts | 会话管理 |
| `settlements` | settlements | 城池查询 |
| `shop` | shop | 商店购买 |
| `stats` | stats | 数值计算 |
| `terrain` | terrain | 地形查询 |
| `timeline` | timeline | 事件系统 |
| `worldMap` | world-map | 地图占用 |

## 设计原则

### 1. 插件隔离

- 每个插件只修改自己的 D1 表（前缀为插件 ID）
- 跨插件数据通过服务接口访问
- **禁止**直接导入其他插件的运行时代码

### 2. 依赖管理

- 声明 `dependsOn` 表述硬依赖
- 通过 service 接口进行解耦
- 按 6 层架构构建，避免循环依赖

### 3. 内容与系统分离

- 系统插件（Layer 1-2）不含游戏逻辑
- 内容插件（Layer 3-5）使用系统提供的扩展点
- 新功能 = 新内容插件，不修改系统

### 4. 配置驱动

- 影响平衡的数字用 `ctx.config.define` 暴露
- GM 可实时修改，无需重启
- 支持部分覆盖（与默认值合并）

## 关键扩展点

### 注册新内容的方式

```typescript
// 资源
resources.define({ id: "gold", name: "黄金" })
resources.defineFromCsv(csv)

// 建筑
buildings.define({ id: "farm", name: "农场", ... })
buildings.defineFromCsv(csv, levelsCsv)

// 兵种
troops.define({ id: "spearman", name: "枪手", ... })

// 科技
research.define({ id: "masonry-1", name: "砌体...`, ... })
research.defineFromCsv(csv, levelsCsv)

// 英雄属性/venue/责任
heroes.defineAttribute({ id: "might", name: "力量" })
heroes.defineVenue({ id: "tavern", name: "酒馆", ... })
heroes.defineDuty({ id: "governor", name: "总督", ... })

// 工具
items.define({ id: "expansion-permit", name: "拓展许可", ... })

// 战斗修饰符/伤亡钩子
battle.addModifier(async (api, side) => [...])
battle.addCasualtyHook({ final: async (api, c) => ... })

// 冒险副本
realms.define({ id: "forest", name: "森林", ... })
realms.addDrop({ id: "equipment.rare", ... })
realms.addClearReward({ id: "key", ... })
```

## 统计数据

- **总插件**: 38 个
- **核心系统** (Layer 0-2): 22 个
- **内容扩展** (Layer 3+): 16 个
- **核心服务**: 20 个
- **视图总数**: 30+
- **命令总数**: 50+
- **可调规则**: 100+

## 开发指南

### 创建新插件的步骤

1. **确定位置**: 属于哪一层？
   - Layer 0-2: 核心系统，谨慎添加
   - Layer 3-5: 内容扩展，建议添加

2. **声明 ID 和依赖**:

   ```typescript
   export default definePlugin({
     id: "my-plugin",
     dependsOn: ["resource", "settlements"],  // 仅列出直接依赖
     setup(ctx) { ... }
   })
   ```

3. **暴露服务** (如需要):

   ```typescript
   const myService = { ... }
   ctx.services.provide("myService", myService)
   ```

4. **声明扩展点** (如需要):

   ```typescript
   declare module "../../kernel" {
     interface ServiceMap { myService: MyService }
   }
   ```

5. **使用数据与代码分离**:
   - 把配置、表格放在 `data/*.csv`
   - 代码中尽量引用而不是硬编码
   - 通过 GM 规则暴露平衡参数

6. **编写测试**:
   - 正常路径和错误路径都要覆盖
   - 使用 `createKernel()` 测试集成

### 禁忌

❌ **不要**:

- 直接修改其他插件的表
- 在系统插件中硬编码内容 ID
- 循环依赖
- 在命令中调用外部 API（只在 cron 任务中）
- 创建新的顶层插件结构（所有新功能都是内容插件）

✅ **要**:

- 通过服务接口通信
- 用配置规则暴露数字
- 编写测试用例
- 记录依赖关系
- 支持回滚（幂等性）

## 相关文档

- [README.md](../README.md) - 项目概述、命令、开发指南
- [HANDOFF.md](./HANDOFF.md) - 当前状态和待办项
- [设计文档](./design/) - gameplay, ui, architecture
- [变更日志](./changelogs/) - 完成的改动记录

---

**生成时间**: 2026-10-01  
**数据来源**: 分析 `src/plugins/*/index.ts` 的 definePlugin 声明
