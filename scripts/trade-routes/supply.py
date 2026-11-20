# -*- coding: utf-8 -*-
# Each supply point's words (user 2026-11-20: "首次解锁时查抄了路霸的存货，后面再次路过时当地百姓的爱戴、或我们经营得当，所以
# 可以获得资源补充以休整"): when its guards are beaten and their stores taken (first), and when the team passes again
# (pass). (zh first, en first, zh pass, en pass), by route and chapter.
SUPPLY = {
 ('silk', 1): (
  '恶霸的地窖里堆着二十多袋陈麦和十几匹没开封的绢，都是这些年拿井水换来的。你们把绢分给了被敲诈过的牧人，把麦子装上了驼背。',
  'In the bullies\' cellar lie twenty-odd sacks of old wheat and a dozen bolts of silk still sealed, all of it bought with well water over the years. You give the silk back to the herders they squeezed and load the wheat onto the camels.',
  '井绳上系着牧人们留下的一小袋干酪，没有人看守，井水随便打。',
  'A small bag of dried cheese hangs on the well rope, left by the herders; nobody guards it, and the water is free to draw.'),
 ('silk', 2): (
  '马帮把抢来的货藏在沙山背后的帐篷里：水囊、腌肉、成捆的草料。头领临走前说，这些本来就是给"多出来的那些人"预备的。',
  'The caravan gang hid their plunder in tents behind the dune: water skins, salted meat, bales of fodder. Their leader says as he goes that it was all laid by for "the extra ones" anyway.',
  '泉边多了一顶新帐篷，是附近的驼户替你们搭的，里面摆着刚烤好的馕。',
  'A new tent stands by the spring, put up for you by the camel drivers nearby; inside are flatbreads fresh from the fire.'),
 ('silk', 3): (
  '假和尚的禅房里藏着几十两碎银和半仓小米。你们把米交还给寺里，僧人只收下一半，另一半硬塞给了你们。',
  'The false monks\' cells hide a few dozen taels of silver and half a granary of millet. You hand the millet back to the temple; the monks keep only half and press the rest on you.',
  '粥棚照旧施粥，僧人认得你们的旗，每回都多舀一勺，还给牲口备了豆料。',
  'The shelter still gives out gruel; the monks know your banner and ladle a little more each time, with beans for the animals.'),
 ('silk', 4): (
  '家丁们把敲诈来的东西都堆在驿馆后院：成桶的葡萄酒、银器、上好的鞍具。你们拿走了能吃能用的，把银器留给了老仆。',
  'The household men stacked what they extorted in the post\'s back court: casks of wine, silver, fine saddles. You take what can be eaten and used, and leave the silver for the old servant.',
  '老仆把驿馆打理得干干净净，每次你们来，后院的马槽都已经添满了草料。',
  'The old servant keeps the post spotless; whenever you come, the troughs in the back court are already full of fodder.'),
 ('tea', 1): (
  '兵痞们收来的茶包在库房里堆成了墙，还有十几坛青稞酒。你们拆开茶包，给锅庄里每个烤火的人都分了一份。',
  'The tea bricks the soldiers took as tolls are stacked into a wall in the store, with a dozen jars of barley wine. You open them and give a share to everyone warming at the fire.',
  '火塘一直烧着，掌柜给你们留了靠火最近的位子，酥油茶管够。',
  'The hearth burns on; the keeper saves you the seats nearest the fire, and the butter tea never runs out.'),
 ('tea', 2): (
  '寨丁的仓里有成筐的草药、腊肉和米酒。药农们只要回了自己的药种，剩下的都让你们带走。',
  'The guards\' store holds baskets of herbs, cured pork and rice wine. The herb growers ask back only their seed; the rest they let you take.',
  '药农们记着你们的好，每回路过，田埂上都摆着一捆晒好的草药和一篮糯米粑。',
  'The herb growers remember you; each time you pass, a bundle of dried herbs and a basket of rice cakes waits on the field bank.'),
 ('tea', 3): (
  '流兵抢来的青稞和干草够一支马队吃半个月，洞深处还有几张完好的牦牛皮。你们把皮子铺在洞里，在这里歇了一整夜。',
  'The grain and hay the stragglers stole would feed a pack train for half a month, and deep in the cave lie a few whole yak hides. You spread them out and rest there a whole night.',
  '你们留在洞里的人把岩洞营打理成了驿站，来往的背夫都在这里歇脚，也替你们添柴备粮。',
  'The men you left have turned the cave into a waystation; porters stop here, and they lay in wood and food for you.'),
 ('tea', 4): (
  '盗马贼的马厩里拴着二十多匹好马，鞍袋里装满了风干肉和盐。马你们还给了附近的牧民，肉和盐留下了。',
  'The horse thieves\' stable holds twenty-odd good horses, their saddlebags full of dried meat and salt. The horses you give back to the herders nearby; the meat and salt you keep.',
  '老喇嘛每次都煮好一锅酥油茶等你们，牧民们也赶着牦牛送来了奶渣。',
  'The old lama has a pot of butter tea ready each time, and the herders drive up yaks with dried curd for you.'),
 ('sea', 1): (
  '海贼从拆船上卸下来的东西堆满了一个棚子：缆绳、帆布、成桶的淡水和咸鱼。老船匠把能用的都搬上了你们的船。',
  'What the pirates stripped from the hulks fills a whole shed: rope, canvas, casks of water and salt fish. The old shipwright carries everything useful onto your ship.',
  '船坞里新造的船越来越多，船匠们轮流替你们补帆修舵，不收一文钱。',
  'More new ships stand in the yard each time; the shipwrights take turns mending your sails and rudder, and take not a coin.'),
 ('sea', 2): (
  '海盗的营地里有整整一船的椰子、腌鱼和几十个空水桶。你们把水桶灌满，在木牌下面也刻上了自己的名字。',
  'The pirates\' camp holds a boatload of coconuts and salt fish and dozens of empty casks. You fill the casks and carve your own names under the wooden board.',
  '泉边有了守泉的渔民，他们说既然千里号留了水，你们也留了，那这泉就永远有人守。',
  'Fishermen keep the spring now; they say that since the Thousand Li left water and you did too, someone will always guard it.'),
 ('sea', 3): (
  '蜃兵散去以后，摊子上的货都还在：香料、丝绸、晒干的海参。没有人来收钱，你们照着价牌把钱压在了摊上。',
  'When the mirage soldiers scatter, the goods remain on the stalls: spices, silk, dried sea cucumbers. Nobody comes to take payment; you leave coins on each stall by its price board.',
  '每回路过，海市里都有一个摊子摆着你们上次留下的钱，旁边是满满一筐干粮。',
  'Each time you pass, one stall in the sea market shows the coins you left last time, beside a full basket of provisions.'),
 ('sea', 4): (
  '落难的海盗把仅有的存粮都交了出来：半袋米、几坛酒、一桶带茶香的井水。他们说，能活着走出归墟的人，配得上这些。',
  'The stranded pirates hand over all they have: half a sack of rice, a few jars of wine, a cask of the tea-scented water. Whoever can walk out of the Abyss alive, they say, deserves it.',
  '海盗们留了下来，替你们守着这口井。每次你们来，井边都摆着一桶打好的水和一盏点亮的灯。',
  'The pirates stay on to keep the well for you. Each time you come, a cask of fresh-drawn water and a lit lamp wait beside it.'),
}
