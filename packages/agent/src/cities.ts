export type PlaceCost = "free" | "low" | "mid";

export type Place = {
  name: string;
  area: string;
  detail: string;
  indoor: boolean;
  cost: PlaceCost;
  keywords: string[];
  evening?: boolean;
  fullDay?: boolean;
};

export type CityGuide = {
  name: string;
  english: string;
  outbound: boolean;
  places: Place[];
  food: string[];
  stayNote: string;
};

function place(
  name: string,
  area: string,
  detail: string,
  extra: Partial<Place> & { indoor?: boolean; cost?: PlaceCost } = {},
): Place {
  return {
    name,
    area,
    detail,
    indoor: extra.indoor ?? false,
    cost: extra.cost ?? "free",
    keywords: extra.keywords ?? [],
    evening: extra.evening,
    fullDay: extra.fullDay,
  };
}

export const CITIES: CityGuide[] = [
  {
    name: "苏州",
    english: "Suzhou",
    outbound: false,
    stayNote: "住平江路或观前附近，园林和晚饭可以走路衔接。",
    food: ["汤面或生煎当早餐", "本帮或苏帮小馆", "观前附近早一点吃完"],
    places: [
      place("拙政园", "东北街", "苏州园林的代表，园子大，上午人相对少。门票与预约请出发前核实。", {
        cost: "mid",
        keywords: ["园林", "拙政园"],
      }),
      place("苏州博物馆", "东北街", "和拙政园只隔一条街，室内，适合慢慢看或躲雨。", {
        indoor: true,
        cost: "low",
        keywords: ["博物馆", "园林"],
      }),
      place("平江路", "平江", "沿河走路，不需要门票。店多，看着吃一点就好。", {
        keywords: ["老街", "本地菜"],
      }),
      place("山塘街", "山塘", "傍晚灯光好看，但容易挤。走一段就离开。", {
        evening: true,
        keywords: ["老街"],
      }),
      place("虎丘", "虎丘", "离城区有一段路，当作单独半天，不要和园林挤在同一上午。", {
        cost: "mid",
        keywords: ["虎丘"],
      }),
    ],
  },
  {
    name: "杭州",
    english: "Hangzhou",
    outbound: false,
    stayNote: "住西湖东侧或湖滨，走路能到湖边。住宿自己看，路书不代订。",
    food: ["片儿川或葱包桧当早餐", "湖滨简单解决午餐", "晚饭离开景区，回住处附近"],
    places: [
      place("西湖", "湖滨", "沿白堤或苏堤走一段即可，不必环湖。人多就在岸边坐下。", {
        keywords: ["西湖", "湖"],
      }),
      place("灵隐寺", "西湖西", "上午去相对从容。门票请出发前核实，路书不代购。", {
        cost: "mid",
        keywords: ["灵隐"],
      }),
      place("浙江省博物馆", "西湖文化广场", "室内。西湖下雨或想歇脚时优先来这里。闭馆日请核实。", {
        indoor: true,
        cost: "free",
        keywords: ["博物馆", "室内", "雨"],
      }),
      place("河坊街", "清河坊", "看一条街就离开，不把正餐安排在街上。", {
        keywords: ["河坊"],
      }),
      place("龙井", "龙井", "一段上坡。累了就在村口停，不必走完整条。", {
        keywords: ["龙井", "茶"],
      }),
      place("中国茶叶博物馆", "龙井", "室内，用来替换龙井村里的步行。", {
        indoor: true,
        cost: "free",
        keywords: ["博物馆", "室内", "茶"],
      }),
    ],
  },
  {
    name: "上海",
    english: "Shanghai",
    outbound: false,
    stayNote: "住在地铁沿线即可，外滩和法租界不用住在景区门口。",
    food: ["生煎或小笼", "本帮家常", "夜宵只留一顿"],
    places: [
      place("外滩", "外滩", "适合傍晚走路，不安排购物。风大时改到室内。", { evening: true }),
      place("上海博物馆", "人民广场", "室内，馆藏够看一个下午。周一等闭馆日请先查。", {
        indoor: true,
        cost: "free",
        keywords: ["博物馆"],
      }),
      place("武康路", "徐汇", "一段松的步行，看街景和喝一杯东西。", { keywords: ["慢慢"] }),
      place("豫园", "城隍庙", "园子不大，周边很挤。看完园子就离开商圈。", { cost: "mid" }),
    ],
  },
  {
    name: "东京",
    english: "Tokyo",
    outbound: true,
    stayNote: "住在山手线转乘方便的车站附近，少换两次地铁。",
    food: ["便利店或咖啡店解决一个早上", "车站附近定食", "晚饭不要排太长的队"],
    places: [
      place("浅草寺与仲见世", "浅草", "早上开门前到，走完寺前街道就可以离开。", { keywords: ["浅草"] }),
      place("东京国立博物馆", "上野", "室内，能看一个完整下午。闭馆日请出发前核实。", {
        indoor: true,
        cost: "low",
        keywords: ["博物馆"],
      }),
      place("上野公园", "上野", "和博物馆同一片，当作散步，不另花半天赶路。", { keywords: ["公园"] }),
      place("筑地场外", "筑地", "吃一顿简单的，不把市场当成景点清单。", {
        keywords: ["吃", "美食"],
        cost: "low",
      }),
      place("涩谷到原宿步行", "涩谷", "只走路，不安排购物。人多就改去旁边的小公园。", {
        keywords: ["市区"],
      }),
      place("东京迪士尼度假区", "浦安", "这一天几乎都留给园区。门票、预约和开园时间变动很大，请出发前核实。路书不代购。", {
        cost: "mid",
        fullDay: true,
        keywords: ["迪士尼"],
        indoor: true,
      }),
    ],
  },
  {
    name: "京都",
    english: "Kyoto",
    outbound: true,
    stayNote: "如果想住町家，选清水、祗园或今出川沿线，保证一天最多转一次车。",
    food: ["豆腐或面条当午餐", "锦市场吃一点就离开", "晚饭在住处附近"],
    places: [
      place("清水寺与二年坂", "东山", "坡多。早上到，看完沿二年坂往下走，不原路爬回去。", {
        cost: "mid",
        keywords: ["清水"],
      }),
      place("哲学之道", "左京", "一段河边步行，适合慢慢走，没有打卡任务。", { keywords: ["慢慢", "散步"] }),
      place("伏见稻荷", "伏见", "千本鸟居很耗体力。走到半山就可以返回，不必登顶。", { keywords: ["稻荷"] }),
      place("岚山", "岚山", "单独半天，竹林人多就改去河边。", { keywords: ["岚山"] }),
      place("京都国立博物馆", "东山", "室内备选，和清水寺同一侧，雨天优先。", {
        indoor: true,
        cost: "low",
        keywords: ["博物馆", "室内"],
      }),
      place("锦市场", "中京", "用来解决一餐，不买伴手礼。", { keywords: ["吃", "美食"], cost: "low" }),
    ],
  },
  {
    name: "北京",
    english: "Beijing",
    outbound: false,
    stayNote: "住在东西城或朝阳靠近地铁的地方，减少跨城。",
    food: ["饺子或面", "故宫或博物馆附近简单解决", "晚饭早吃，避开景区餐厅"],
    places: [
      place("故宫", "东城", "上午开馆就进，看中轴线一段即可，不必每座殿都进。预约和闭馆请核实。", {
        cost: "mid",
        keywords: ["故宫"],
      }),
      place("中国国家博物馆", "天安门东", "室内，和天安门同一区域，适合有老人小孩或下雨。", {
        indoor: true,
        cost: "free",
        keywords: ["博物馆", "室内"],
      }),
      place("景山", "故宫北", "从故宫北门出来再决定爬不爬，累了就只在门口看看。", { cost: "low" }),
      place("颐和园", "海淀", "单独半天，湖边风大。不要和故宫排在同一天。", { cost: "mid", keywords: ["颐和园"] }),
      place("天坛", "东城", "公园可以走，祈年殿是否购票看当天体力。", { cost: "low", keywords: ["天坛"] }),
    ],
  },
  {
    name: "成都",
    english: "Chengdu",
    outbound: false,
    stayNote: "住在地铁沿线的旧城附近，晚饭可以走路回去。",
    food: ["豆浆油条或一碗小吃", "小面或钟水饺", "晚饭在住处附近，不专门赶夜市"],
    places: [
      place("人民公园", "青羊", "看本地人喝茶，花费低，待多久都行。", {
        cost: "free",
        keywords: ["喝茶", "小吃"],
      }),
      place("宽窄巷子外侧", "青羊", "从巷子边走过即可，不在里面吃饭。", { keywords: ["巷子"] }),
      place("成都博物馆", "天府广场", "室内，新馆空间大，适合躲雨和歇脚。", {
        indoor: true,
        cost: "free",
        keywords: ["博物馆", "室内"],
      }),
      place("武侯祠", "武侯", "需要门票，当作一个上午，不和市区来回穿插。", {
        cost: "mid",
        keywords: ["武侯"],
      }),
      place("玉林或小公园", "武侯", "晚饭后散步，不安排演出。", { evening: true, keywords: ["慢慢"] }),
      place("成都大熊猫繁育研究基地", "成华", "交通和门票都要单独算，只在不差预算时作为半天。", {
        cost: "mid",
        keywords: ["熊猫"],
      }),
    ],
  },
  {
    name: "广州",
    english: "Guangzhou",
    outbound: false,
    stayNote: "住老城区或珠江边，早茶不用跨城。",
    food: ["老城区早茶，先看排队再进", "糖水当下午的一站", "夜宵只留一顿，吃完就回"],
    places: [
      place("永庆坊", "荔湾", "早上茶楼出来顺路走走，建筑看一看即可。", { keywords: ["早茶"] }),
      place("沙面", "荔湾", "一段平路，适合吃完早茶慢慢走。", { keywords: ["散步"] }),
      place("陈家祠", "荔湾", "室内外都有，人多就缩短。门票请核实。", {
        indoor: true,
        cost: "low",
        keywords: ["祠堂"],
      }),
      place("广东省博物馆", "珠江新城", "室内大馆，雨天或想坐下来时来。", {
        indoor: true,
        cost: "free",
        keywords: ["博物馆", "室内"],
      }),
      place("珠江边散步", "江边", "晚饭后走一段，不安排游船也成立。", { evening: true }),
    ],
  },
  {
    name: "青岛",
    english: "Qingdao",
    outbound: false,
    stayNote: "住在栈桥到八大关之间的公交能到的地方，风大时少靠海边走。",
    food: ["海鲜只吃一顿清淡的", "啤酒博物馆附近不必喝完", "晚饭避开景区大排档"],
    places: [
      place("栈桥", "市南", "风大或下雨就只看一眼。人多时不要在桥上停留。", { keywords: ["海边"] }),
      place("八大关", "市南", "用来散步。雨天路滑，改去室内。", { keywords: ["散步"] }),
      place("青岛啤酒博物馆", "市北", "室内，适合作为下雨时的主行程。门票请核实。", {
        indoor: true,
        cost: "mid",
        keywords: ["啤酒", "室内", "雨"],
      }),
      place("青岛市博物馆", "市南", "另一处室内备选，节奏比景区慢。", {
        indoor: true,
        cost: "free",
        keywords: ["博物馆", "室内"],
      }),
      place("信号山", "市南", "天气好再上。风大就取消，不影响整天。", { keywords: ["看海"] }),
    ],
  },
  {
    name: "昆明",
    english: "Kunming",
    outbound: false,
    stayNote: "进云南的第一晚住昆明城区，第二天再赶路，不连夜换乘。",
    food: ["米线当早餐", "城区家常", "不要为了特色菜横跨市区"],
    places: [
      place("翠湖", "五华", "进城先走一圈，看城市尺度。", { keywords: ["慢慢"] }),
      place("云南省博物馆", "官渡", "室内，适合刚下火车或下雨的半天。", {
        indoor: true,
        cost: "free",
        keywords: ["博物馆", "室内"],
      }),
      place("官渡古镇", "官渡", "比市区远一点，只安排半天。", { cost: "low" }),
    ],
  },
  {
    name: "大理",
    english: "Dali",
    outbound: false,
    stayNote: "住古城或下关其中一处，不要两头换酒店。",
    food: ["本地米线或饵丝", "古城晚饭早点吃", "白族菜只安排一顿"],
    places: [
      place("大理古城", "古城", "把古城当住处的延伸，不要按景点打卡。", { keywords: ["古城"] }),
      place("洱海生态廊道", "海东", "骑行或坐车看一段就回头，不环湖。", { keywords: ["洱海"] }),
      place("崇圣寺三塔", "大理镇", "需要门票，上午去，中午回古城休息。", {
        cost: "mid",
        keywords: ["三塔"],
      }),
      place("大理市博物馆", "下关", "室内备选，人少。", {
        indoor: true,
        cost: "free",
        keywords: ["博物馆", "室内"],
      }),
    ],
  },
  {
    name: "丽江",
    english: "Lijiang",
    outbound: false,
    stayNote: "住古城边缘或束河，避开酒吧街。海拔高，第一天少安排。",
    food: ["清淡的面条或米线", "晚饭少喝酒", "小吃看着吃，不专门扫街"],
    places: [
      place("丽江古城白天", "古城", "白天走路，晚上如果吵就回住处。", { keywords: ["古城"] }),
      place("木府", "古城", "在古城里面，作为半天，不必再找远的景点。", {
        cost: "mid",
        indoor: true,
        keywords: ["木府"],
      }),
      place("束河古镇", "束河", "比大研安静，安排一个松的下午。", { keywords: ["慢慢"] }),
      place("狮子山", "古城", "想看城的时候再上，累了就取消。", { cost: "low" }),
    ],
  },
  {
    name: "深圳",
    english: "Shenzhen",
    outbound: false,
    stayNote: "跟着出差住的酒店走，不为了景点换区。",
    food: ["晚饭在酒店附近", "只留一顿想尝试的", "午餐默认工作餐"],
    places: [
      place("南头古城", "南山", "晚上灯光和街道够看，适合下班之后。", {
        evening: true,
        keywords: ["晚上"],
      }),
      place("深圳湾公园", "南山", "一段平路，适合周五下午放风。", { keywords: ["下午", "散步"] }),
      place("华侨城创意文化园", "南山", "室内外都有，下雨也能逛。", {
        indoor: true,
        keywords: ["室内"],
      }),
      place("海上世界", "蛇口", "晚饭可以放在这里，看完海就走。", { evening: true }),
    ],
  },
  {
    name: "西安",
    english: "Xi'an",
    outbound: false,
    stayNote: "住城墙里或地铁沿线，兵马俑那天单独算路程。",
    food: ["早餐在住处附近解决", "回民街改到上午或干脆不专门去", "晚饭避开整点"],
    places: [
      place("兵马俑", "临潼", "单独一天的上午出发。门票、预约和往返时间请出发前核实。", {
        cost: "mid",
        fullDay: true,
        keywords: ["兵马俑"],
      }),
      place("陕西历史博物馆", "雁塔", "室内，假期非常挤。尽量早上到，并查预约。", {
        indoor: true,
        cost: "free",
        keywords: ["博物馆", "室内"],
      }),
      place("西安城墙", "碑林", "早上骑或走一段，不必绕完整圈。", {
        cost: "low",
        keywords: ["城墙", "早上"],
      }),
      place("大雁塔北广场外围", "雁塔", "看建筑即可，不赶喷泉整点。", { keywords: ["排队"] }),
      place("西安博物院", "碑林", "小一点的室内馆，用来替换排长队的地方。", {
        indoor: true,
        cost: "free",
        keywords: ["博物馆", "室内"],
      }),
    ],
  },
];

export function hasCityGuide(name: string): boolean {
  return CITIES.some((city) => city.name === name);
}

export function guideFor(name: string): CityGuide {
  const found = CITIES.find((city) => city.name === name);
  if (found) return found;
  return {
    name,
    english: name,
    outbound: false,
    stayNote: `住在${name}换乘少的城区。住宿请自己看，路书不代订。`,
    food: ["当地早餐", "家常小馆", "住处附近收摊早的小吃"],
    places: [
      place(`${name}的博物馆`, "城区", "优先当作室内底，开放时间请出发前核实。", {
        indoor: true,
        cost: "low",
        keywords: ["博物馆", "室内"],
      }),
      place("中心城区步行", "市中心", "用一个下午把街道尺度走明白，不列打卡清单。", {
        keywords: ["慢慢", "散步"],
      }),
      place("本地市场", "市场", "看本地人买什么，顺便吃一顿简单的。", {
        cost: "low",
        keywords: ["吃", "美食", "小吃"],
      }),
      place("城市公园", "城区", "一段平路，累了就坐下。", {
        keywords: ["散步", "公园"],
      }),
      place("老街走一段", "老街", "看一条街就离开，不把正餐安排在街上。", {
        keywords: ["老街"],
      }),
    ],
  };
}
