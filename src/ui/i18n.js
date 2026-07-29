/**
 * Localisation.
 *
 * ## Why it is a lookup and not a rewrite
 *
 * Every data table in the game already carries an English `name`, and those
 * names are used in code, in tests and in save files. Replacing them would mean
 * touching every one of those, so instead they stay as they are and become the
 * **fallback**: `t('item.water')` returns the Chinese string if there is one and
 * the English one otherwise. That means a missing translation degrades to
 * readable English rather than to `item.water`, and adding a language is adding
 * one object to this file.
 *
 * ## Only the surface is translated
 *
 * Ids, event names, skill keys and save payloads stay English for ever. What
 * gets translated is exactly what a player reads.
 *
 * The language comes from `?lang=`, then from the browser, defaulting to
 * Chinese when the browser asks for any variety of it.
 */

/** @type {Record<string, Record<string, string>>} */
const TABLES = {
  zh: {
    // --- menu ---------------------------------------------------------
    'menu.tagline': '这就是你的死法',
    'menu.new': '新的幸存者',
    'menu.continue': '继续游戏',
    'menu.nosave': '没有存档',
    'menu.seed': '小镇种子',
    'menu.begin': '开始',
    'menu.overbudget': '点数超支',
    'menu.random': '随便来一个',
    'menu.clear': '清空',
    'menu.back': '返回',
    'menu.points': '剩余点数',
    'menu.occupation': '职业',
    'menu.take': '选取',
    'menu.take.hint': '消耗点数',
    'menu.give': '缺陷',
    'menu.give.hint': '获得点数',
    'menu.population': '尸群密度',
    'menu.noTraining': '没有专长',
    'menu.name': '姓名',
    'menu.survivor': '幸存者',

    'population.sparse': '稀疏',
    'population.normal': '普通',
    'population.dense': '密集',
    'population.sparse.desc': '街上偶尔才有一个。适合先熟悉操作',
    'population.normal.desc': '小镇已经沦陷，但还走得动',
    'population.dense.desc': '到处都是。你需要非常小心',

    // --- controls -----------------------------------------------------
    'help.title': '操作方式',
    'help.dismiss': '按任意键开始 · 之后按 / 或 F1 再看',
    'help.close': '知道了',
    'help.section.move': '移动',
    'help.section.fight': '战斗',
    'help.section.world': '互动',
    'help.section.camera': '视角',
    'help.move': 'WASD / 方向键',
    'help.move.desc': '朝屏幕方向走，人物会转向你走的方向',
    'help.run': 'Shift',
    'help.run.desc': '奔跑。会消耗耐力，跑空之后只能走',
    'help.sneak': 'Ctrl',
    'help.sneak.desc': '潜行。安静，但很慢',
    'help.attack': '鼠标左键',
    'help.attack.desc': '朝光标方向挥击',
    'help.shove': '鼠标右键',
    'help.shove.desc': '推开。不造成伤害，但能争取一秒',
    'help.interact': 'E',
    'help.interact.desc': '开关门、翻窗、翻栅栏',
    'help.inventory': 'Tab / I',
    'help.inventory.desc': '打开背包。站在容器旁边可以搜刮',
    'help.consume': 'F',
    'help.consume.desc': '吃掉或喝掉背包里的东西',
    'help.equip': 'G',
    'help.equip.desc': '换一件武器',
    'help.treat': 'H',
    'help.treat.desc': '包扎伤口或吃止痛药',
    'help.torch': 'L',
    'help.torch.desc': '开关手电（需要背包里有）',
    'help.rotate': 'Q / .',
    'help.rotate.desc': '镜头旋转 90 度',
    'help.zoom': '滚轮',
    'help.zoom.desc': '拉近拉远',
    'help.pause': '空格',
    'help.pause.desc': '暂停',
    'help.marker': '你脚下的青色圆环就是你。隔着墙时会显示轮廓。',

    // --- hud ----------------------------------------------------------
    'hud.hp': '生命',
    'hud.end': '耐力',
    'hud.broken': '已损坏',
    'hud.asleep': '睡着了',
    'hud.infected': '感染',
    'hud.help': 'WASD 移动 · 左键攻击 · 右键推开 · Shift 跑 · Ctrl 潜行 · E 互动 · Tab 背包 · / 操作说明',

    'part.head': '头部',
    'part.torso': '躯干',
    'part.armL': '左臂',
    'part.armR': '右臂',
    'part.legL': '左腿',
    'part.legR': '右腿',

    // --- death --------------------------------------------------------
    'death.title': '这就是 {name} 的死法',
    'death.title.you': '这就是你的死法',
    'death.survived': '存活',
    'death.kills': '击杀',
    'death.restart': '再来一次',
    'death.days': '{n} 天',

    'death.wounds': '被撕碎',
    'death.injuries': '伤重不治',
    'death.bloodloss': '失血而死',
    'death.infection': '变成了它们',
    'death.starvation': '饿死',
    'death.dehydration': '渴死',

    // --- panels -------------------------------------------------------
    'panel.carrying': '携带',
    'panel.container': '容器',
    'panel.craft': '制作',
    'panel.empty': '空的',
    'panel.weight': '重量',
    'panel.nothing': '附近没有容器',
    'panel.overloaded': '超重',

    // --- moodles ------------------------------------------------------
    'moodle.hunger.1': '有点饿', 'moodle.hunger.2': '饿', 'moodle.hunger.3': '很饿', 'moodle.hunger.4': '快饿死了',
    'moodle.thirst.1': '口渴', 'moodle.thirst.2': '很渴', 'moodle.thirst.3': '脱水', 'moodle.thirst.4': '快渴死了',
    'moodle.fatigue.1': '发困', 'moodle.fatigue.2': '疲倦', 'moodle.fatigue.3': '很疲倦', 'moodle.fatigue.4': '精疲力竭',
    'moodle.pain.1': '轻微疼痛', 'moodle.pain.2': '疼痛', 'moodle.pain.3': '剧痛', 'moodle.pain.4': '痛不欲生',
    'moodle.panic.1': '不安', 'moodle.panic.2': '紧张', 'moodle.panic.3': '恐慌', 'moodle.panic.4': '惊骇',
    'moodle.cold.1': '微凉', 'moodle.cold.2': '寒冷', 'moodle.cold.3': '很冷', 'moodle.cold.4': '冻僵了',
    'moodle.hot.1': '温热', 'moodle.hot.2': '热', 'moodle.hot.3': '很热', 'moodle.hot.4': '中暑',
    'moodle.sickness.1': '反胃', 'moodle.sickness.2': '恶心', 'moodle.sickness.3': '生病', 'moodle.sickness.4': '发烧',

    // --- skills -------------------------------------------------------
    'skill.blunt': '钝器', 'skill.blunt.effect': '球棒、撬棍和拳头的伤害',
    'skill.blade': '利器', 'skill.blade.effect': '刀和斧头的伤害',
    'skill.fitness': '体能', 'skill.fitness.effect': '耐力的消耗与恢复',
    'skill.sneak': '潜行', 'skill.sneak.effect': '你发出的声音能传多远',
    'skill.carpentry': '木工', 'skill.carpentry.effect': '路障强度与施工速度',
    'skill.scavenging': '搜刮', 'skill.scavenging.effect': '一个容器能翻出多少东西',
    'skill.firstAid': '急救', 'skill.firstAid.effect': '包扎的效果',
    'skill.cooking': '烹饪', 'skill.cooking.effect': '一顿熟食能顶多少',

    // --- occupations --------------------------------------------------
    'job.unemployed': '无业',
    'job.unemployed.desc': '没有任何专长，也没有退路 —— 但多八点可以分配',
    'job.carpenter': '木匠',
    'job.carpenter.desc': '钉窗户又快又牢',
    'job.police': '警察',
    'job.police.desc': '受过训练，知道怎么抡重物砸迎面而来的东西',
    'job.burglar': '窃贼',
    'job.burglar.desc': '整个职业生涯都在练习不被听见',
    'job.nurse': '护士',
    'job.nurse.desc': '知道该拿流血怎么办',
    'job.lumberjack': '伐木工',
    'job.lumberjack.desc': '斧头是工具，他们用了一辈子',
    'job.trainer': '健身教练',
    'job.trainer.desc': '所有人都停下来的时候，他们还能跑',
    'job.security': '保安',
    'job.security.desc': '上夜班、走空廊、带手电',
    'job.scavenger': '拾荒者',
    'job.scavenger.desc': '总能翻出柜子最里面那样东西',

    // --- traits -------------------------------------------------------
    'trait.athletic': '体格健壮', 'trait.athletic.desc': '走得更快，跑起来也更省力',
    'trait.strong': '力气大', 'trait.strong.desc': '打得更重',
    'trait.packMule': '能扛', 'trait.packMule.desc': '多背三成才会拖慢你',
    'trait.lightFooted': '脚步轻', 'trait.lightFooted.desc': '你发出的动静传得近得多',
    'trait.eagleEyed': '眼力好', 'trait.eagleEyed.desc': '看得更远',
    'trait.fastHealer': '愈合快', 'trait.fastHealer.desc': '伤口好得快，也止血得早',
    'trait.resilient': '抵抗力强', 'trait.resilient.desc': '被咬一口未必就是终点',
    'trait.ironGut': '铁胃', 'trait.ironGut.desc': '不太容易饿',
    'trait.camel': '骆驼', 'trait.camel.desc': '不太容易渴',
    'trait.brave': '胆大', 'trait.brave.desc': '房间里有死人时手也不抖',
    'trait.painTolerant': '耐痛', 'trait.painTolerant.desc': '受伤没那么疼，代价也就小',
    'trait.wakeful': '精神好', 'trait.wakeful.desc': '不容易累',
    'trait.fastLearner': '学得快', 'trait.fastLearner.desc': '做同样的事，你学到的更多',

    'trait.outOfShape': '缺乏锻炼', 'trait.outOfShape.desc': '更慢，而且跑起来非常费力',
    'trait.feeble': '力气小', 'trait.feeble.desc': '打人像是在道歉',
    'trait.weakShoulders': '肩膀弱', 'trait.weakShoulders.desc': '很快就被压得走不动',
    'trait.clumsy': '笨手笨脚', 'trait.clumsy.desc': '你做什么都能被更远的地方听见',
    'trait.shortSighted': '近视', 'trait.shortSighted.desc': '等你看见它们时已经很近了',
    'trait.slowHealer': '愈合慢', 'trait.slowHealer.desc': '伤口拖得久，血也止得慢',
    'trait.thinSkinned': '皮薄', 'trait.thinSkinned.desc': '被抓一下几乎等于被咬一口',
    'trait.heartyAppetite': '饭量大', 'trait.heartyAppetite.desc': '很快又饿了',
    'trait.parched': '总是口渴', 'trait.parched.desc': '水比什么都消耗得快',
    'trait.cowardly': '胆小', 'trait.cowardly.desc': '很早就慌，很久才平复',
    'trait.sensitive': '怕疼', 'trait.sensitive.desc': '每一处伤都让你付出更多',
    'trait.restless': '觉少', 'trait.restless.desc': '很快就累',
    'trait.slowLearner': '学得慢', 'trait.slowLearner.desc': '经验在你身上是浪费',

    // --- items --------------------------------------------------------
    'item.bread': '面包', 'item.cheese': '奶酪', 'item.steak': '牛排', 'item.apple': '苹果',
    'item.milk': '牛奶', 'item.beans': '罐头豆子', 'item.soup': '罐头汤', 'item.crisps': '薯片',
    'item.chocolate': '巧克力', 'item.water': '瓶装水', 'item.soda': '汽水',
    'item.bandage': '绷带', 'item.rag': '布条', 'item.painkillers': '止痛药', 'item.firstaid': '急救包',
    'item.knife': '菜刀', 'item.bat': '棒球棍', 'item.axe': '消防斧', 'item.crowbar': '撬棍',
    'item.torch': '手电筒', 'item.hammer': '锤子', 'item.nails': '一盒钉子',
    'item.plank': '木板', 'item.sheet': '床单', 'item.bag': '行李袋',
    'item.petrol': '汽油桶', 'item.generator': '发电机',
    'item.rawmeat': '生肉', 'item.potato': '土豆', 'item.bakedpotato': '烤土豆',
    'item.spoiled': '（腐坏）',

    // --- weapons ------------------------------------------------------
    'weapon.fists': '徒手', 'weapon.knife': '菜刀', 'weapon.bat': '棒球棍',
    'weapon.axe': '消防斧', 'weapon.crowbar': '撬棍',

    // --- recipes ------------------------------------------------------
    'recipe.rip-sheet': '把床单撕成布条',
    'recipe.make-bandage': '把布条煮成绷带',
    'recipe.barricade': '钉路障',
    'recipe.make-torch': '临时手电',
    'recipe.salvage-planks': '拆下木板',
    'recipe.cook-meat': '烤肉',
    'recipe.bake-potato': '烤土豆',
    'recipe.boil-water': '烧开水',
    'recipe.rain-barrel': '搭一个接雨桶',
    'recipe.campfire': '生一堆篝火',
    'recipe.place-generator': '放下发电机',
    'recipe.plank-wall': '用木板封住缺口',
    'recipe.repair-barricade': '修补路障',
    'recipe.dismantle': '拆掉',
    'recipe.place-crate': '打一个木箱',
    'recipe.place-table': '打一张桌子',
    'recipe.place-bed': '搭一张床',
    'craft.faceOpening': '要面对一个门洞或窗口',
    'craft.faceGap': '要面对两块地板之间的空缺',
    'craft.faceSomething': '要面对能拆的东西',
    'craft.nothingBroken': '这里没有需要修的东西',
    'craft.noRoom': '前面放不下',

    // --- M18: weather and what you build against it -------------------
    'object.rain barrel': '接雨桶', 'object.campfire': '篝火', 'object.generator': '发电机',
    'weather.clear': '晴', 'weather.overcast': '阴',
    'weather.rain': '下雨', 'weather.storm': '暴雨',
    'weather.rain.started': '下雨了。雨声盖得住你弄出的动静。',
    'weather.storm.started': '暴雨。这是干吵闹活儿最好的时候。',
    'weather.stopped': '雨停了。',
    'station.barrel.empty': '桶是空的。',
    'station.barrel.drank': '你从接雨桶里舀水喝。',
    'station.fire.fed': '你往火里添了木板。',
    'station.fire.out': '火灭了。',
    'station.generator.fuelled': '发电机加了油，启动了。',
    'station.generator.out': '发电机没油停了。',
    'craft.needFire': '需要旁边有一堆点着的火',
    'craft.needWater': '需要旁边有水',
    'panel.held': '需持有',
    'panel.searchHint': '走到容器旁边按 Tab 搜刮。',
    'panel.hint': '点击物品可以移动，点击配方可以制作 · F 吃喝 · G 换武器 · H 治疗 · L 手电 · Tab 关闭',
    'item.rotten': '已腐坏',
    'item.rottenSuffix': '（腐坏）',
    'item.staleSuffix': '（不新鲜）',
    'object.counter': '台面', 'object.fridge': '冰箱', 'object.wardrobe': '衣柜',
    'object.shelf': '架子', 'object.desk': '书桌', 'object.crate': '木箱',
    'object.bed': '床', 'object.stove': '炉灶', 'object.bin': '垃圾桶',
    'object.container': '容器',

    // --- the metagame -------------------------------------------------
    'meta.water.warning': '紧急广播：自来水供应将在一天内中断。',
    'meta.power.warning': '紧急广播：电网将在一天内失效。',
    'meta.water.off': '水龙头没水了。',
    'meta.power.off': '停电了。',
    'meta.heli.warning': '紧急广播：侦测到空中活动。',
    'meta.heli.inbound': '远处传来直升机的声音。',
    'meta.heli.spotted': '直升机发现你了。',
    'meta.heli.leaving': '直升机正在离开。',
    'meta.drank': '你喝了水。',
    'meta.dry': '没有水。',

    // --- misc ---------------------------------------------------------
    'time.day': '第 {n} 天',
    'weekday.0': '周日', 'weekday.1': '周一', 'weekday.2': '周二',
    'weekday.3': '周三', 'weekday.4': '周四', 'weekday.5': '周五', 'weekday.6': '周六',
    'date.format': '{month} 月 {d} 日',
  },
};

let current = 'en';

/** Pick a language. Called once at boot; exported for tests. */
export function setLanguage(lang) {
  current = TABLES[lang] ? lang : 'en';
  return current;
}

export function getLanguage() {
  return current;
}

/**
 * Choose from the URL, then the browser. Chinese by default when the browser
 * asks for any variety of it — `zh`, `zh-CN`, `zh-Hant` and so on.
 */
export function detectLanguage(search = '', navLangs = []) {
  const forced = new URLSearchParams(search).get('lang');
  if (forced) return setLanguage(forced);
  for (const l of navLangs) {
    if (typeof l === 'string' && l.toLowerCase().startsWith('zh')) return setLanguage('zh');
  }
  return setLanguage('en');
}

/**
 * Look up a string.
 *
 * @param {string} key
 * @param {string|Record<string, string|number>} [fallbackOrVars] the English
 *   text to use when there is no translation, or the substitution map
 * @param {Record<string, string|number>} [vars] `{name}`-style substitutions
 */
export function t(key, fallbackOrVars, vars) {
  let fallback = key;
  let subs = vars;
  if (typeof fallbackOrVars === 'string') fallback = fallbackOrVars;
  else if (fallbackOrVars) subs = fallbackOrVars;

  let text = TABLES[current]?.[key] ?? fallback;
  if (subs) {
    for (const [k, v] of Object.entries(subs)) text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}

/** True when the current language has an entry for this key. */
export function has(key) {
  return !!TABLES[current]?.[key];
}

export { TABLES };
