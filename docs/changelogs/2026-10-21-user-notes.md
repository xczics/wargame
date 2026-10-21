# 2026-10-21 用户留言

- ✅ 340 **GM 指定英雄的天赋和饰品栏位**（用户 2026-10-21："GM发放英雄/拼图兑换 的英雄，增加GM 指定天赋（精细到六维）和指定配饰数量 的功能"）。
  - 奖励类型「指定英雄」（`starter-rewards` 的 `hero`，邮件附件、群发、拼图共用）的配置多了两组可选字段，和原有字段一样按表单原样存，重新打开编辑器能看到：
    - `talent:<属性id>`：该维的天赋点，整数 0–100。填了任意一项，英雄的分维天赋就是填的这些（没填的为 0，总额 = 之和）；全不填照旧按招募地点抽。
    - `accessories`：饰品栏位数，整数 0–12（饰品种数）。填了就按它，不填照旧按天赋总额查 `accessories.csv`；男性英雄仍为 0。
    - 小数、负数、超范围、非数字一律被 `parse` 拒绝（`fields.int`）。
  - 接口：`heroes.grant` 的 spec 加 `talents?`（取代抽到的分维天赋）、`extras?`；`Hero.extras`（别的插件存在英雄身上的数，键带读它的插件 id 前缀，英雄插件不读），新列 `heroes_heroes.extras`（迁移 `0030_heroes_extras.sql`，上线先 `pnpm db:migrate`）。`starterEquipment.accessoryKinds`、`accessorySlots(n)`（给 `extras` 用的键值）；饰品的栏位上限先看 `extras['starter-equipment.accessories']`。
  - 暂按（gameplay.md 13.3）："配饰数量"理解为饰品栏位数，不是随英雄附赠几件饰品。
  - 文案：`starter-rewards` 的 "Talent: {0}"（天赋：{0}）、"Accessories (heroines)"（饰品栏位（女英雄））。
  - 测试 `test/game/puzzles.spec.ts`：非法值被拒、配置原样保存、兑换后英雄的天赋只有 GM 填的那一维、栏位为 12（天赋 6 本该是 3）。
