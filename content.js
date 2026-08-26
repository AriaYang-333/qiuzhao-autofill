// content.js — 注入到招聘网页，负责识别板块、扫描字段、自动填充并高亮。

// 自动把本扩展 ID 广播给网页（Get Offer 产品页可自填插件ID，免去手动粘贴）
// 通道说明：CustomEvent 跨隔离世界不一定送达页面，最可靠的是「共享 DOM 属性」
// （document 在隔离世界与页面世界是同一个对象，设置的 attribute 双方都可见）。
(function(){
  try{
    function rfaBroadcastId(){
      try{ document.dispatchEvent(new CustomEvent('rfa-extid', { detail: chrome.runtime.id })); }catch(e){}
      try{ document.documentElement.setAttribute('data-rfa-extid', chrome.runtime.id); }catch(e){}
    }
    rfaBroadcastId();
    document.addEventListener('DOMContentLoaded', rfaBroadcastId);
    document.addEventListener('readystatechange', function(){ if(document.readyState!=='loading') rfaBroadcastId(); });
    // 持续补发，确保页面脚本较晚注册监听/轮询时仍能拿到
    setTimeout(rfaBroadcastId, 400);
    setTimeout(rfaBroadcastId, 1200);
    setTimeout(rfaBroadcastId, 2500);
  }catch(e){}
})();

const ATTR = "data-rfa-idx";

// 板块关键词映射
const SECTION_KEYWORDS = {
  basic: /基本信息|基础信息|个人资料|个人信息| Basic Info/i,
  education: /教育经历|教育背景|学历信息|毕业院校|学习经历|院校信息|Education/i,
  internships: /实习经历|实习经验|Internship/i,
  work: /工作经历|工作经验|职业经历|Work Experience/i,
  projects: /项目经历|项目经验|项目作品|项目实践|Project/i,
  // v0.6.71：美团有独立的「校园经历」板块（社团/学生工作），此前没有识别规则，
  // 它的字段会被 guessSection 归到上方最近的「项目经历」里，导致项目索引越界、校园卡片全空。
  campus: /校园经历|校内经历|在校经历|学生工作|社团经历|社团活动|Campus Experience/i,
  portfolio: /作品集|^作品$|作品经历|作品经验|作品实践|Portfolio/i,
  awards: /获奖|荣誉|奖项|获奖情况|Awards?/i,
  // v0.6.71：证书 / 论文 / 竞赛 同样是美团的独立板块（顺序：荣誉 → 证书 → 论文 → 竞赛）。
  // 注意「竞赛」板块内唯一的字段叫「获奖大赛」，含「获奖」二字，
  // 已在 FIELD_LABEL_HINT 里登记为字段标签，避免它被误判成一个 awards 板块。
  certificates: /证书|资格证|职业资格|技能证书|Certificates?$/i,
  papers: /论文|著作|发表情况|Papers?$|Publications?$/i,
  competitions: /竞赛|大赛|比赛|Competitions?$/i,
  languages: /语言能力|外语能力|语言技能|语言水平|^语言$|Language Skill|Languages?$/i,
  // v0.7.0（腾讯招聘）：以下 5 个板块为本次新增。
  // 排序讲究：aiSkills 必须排在 skills 之前（「AI应用技能」含「技能」二字，否则被 skills 抢走）；
  // otherInfo 必须排在 selfEval 之前（腾讯把自我评价/爱好特长/补充信息合并为一个「补充信息」文本域，
  // 若 selfEval 先命中，就只会填自我评价一段，丢掉另外两段）。
  //
  // intent 故意写得很窄（只认「意向信息」这个标题），不敢放宽到「求职意向」——
  // 因为美团/字节把「求职意向」当作 basic 板块里的一个字段标签，放宽会把它误判成板块标题，
  // 导致后面所有字段的板块归属整体偏移（这个坑在 v0.6.71 的 campus/awards 上踩过一次）。
  intent: /意向信息|意向岗位信息|求职意向信息|应聘意向信息/i,
  aiSkills: /AI\s*应用技能|AI\s*技能|AI\s*Skills?/i,
  skills: /专业技能|技能特长|技能清单|开发语言|编程语言|IT技能|Technical Skills?/i,
  reference: /资料证明人|证明人信息|背景调查|推荐人信息/i,
  otherInfo: /其他关键信息|补充信息|其他信息|附加信息/i,
  selfEval: /自我评价|个人评价|自我介绍|自我描述|Self/i,
  social: /社交账号|社交平台|社交主页|社交链接|个人主页|社交媒体|^社交$|Social/i,
};

// 运行日志：记录每个板块的「需要几条 / 当前几条 / 点了几次添加 / 最终几条」，
// 出问题时用户点「导出当前页面字段」就能把它一起带出来，便于精准定位（而不是靠猜）。
let RFA_LOG = [];
// 2026-08-07 踩坑：环形缓冲只有 200 条，而 intentDeclaredValue() 每评估一个字段就打一条
// intent-date-bumped —— 一轮下来 174 条，把逐字段决策日志全挤没了，事后完全没法定位
// 「哪个字段没映射上」。这里①把缓冲放大到 800 ②给高频同类日志做去重（same act+同内容
// 只留第一条，后面只累加次数）。
const RFA_LOG_ONCE = new Set();
function rfaLog(entry, once) {
  try {
    if (once) {
      const k = typeof once === "string" ? once : JSON.stringify(entry);
      if (RFA_LOG_ONCE.has(k)) return;
      RFA_LOG_ONCE.add(k);
    }
    RFA_LOG.push(Object.assign({ t: new Date().toLocaleTimeString() }, entry));
    if (RFA_LOG.length > 2500) RFA_LOG.shift();
    dumpLogToDom();
  } catch (e) {}
}

// ── v0.8.6（#270 · 可观测性）─────────────────────────────────────────────────
// 为什么需要这个：RFA_LOG 活在 content script 的 **isolated world**，而跑批端 / dbg.js
// 走 CDP Runtime.evaluate 求值是在 **MAIN world**，两个世界的 JS 变量互不可见 →
// 事后完全读不到「哪个字段为什么没填」，只能靠肉眼看截图猜，一晚上都在盲调。
// DOM 是两个世界**共享**的，所以把日志倾泻到一个不可见的 <script type=application/json>
// 里，dbg.js 就能直接 document.getElementById('__rfa_log__').textContent 拿到全量决策日志。
// 用 script 标签而不是 div/attribute 的原因：
//   ① script[type=application/json] 不参与渲染、不触发布局、不会被站点的样式/校验扫到；
//   ② 内容再长也不影响页面（attribute 超长会拖慢某些框架的 MutationObserver）。
// 节流 400ms，避免每条日志都做一次 JSON.stringify（一轮 800 条会明显拖慢填充）。
let RFA_LOG_DUMP_TIMER = 0;
function dumpLogToDom() {
  if (RFA_LOG_DUMP_TIMER) return;
  RFA_LOG_DUMP_TIMER = setTimeout(() => {
    RFA_LOG_DUMP_TIMER = 0;
    try {
      let n = document.getElementById("__rfa_log__");
      if (!n) {
        n = document.createElement("script");
        n.type = "application/json";
        n.id = "__rfa_log__";
        (document.documentElement || document.body).appendChild(n);
      }
      n.textContent = JSON.stringify(RFA_LOG.slice(-1500));
    } catch (e) {}
  }, 400);
}

// 「当前正在处理哪个字段」——写在 dataset 上，跑批端 TIMEOUT 时一眼就能看出卡死点。
// 之前 run() 卡住只能看到 rfaRun 有值、rfaDone 没值，完全不知道死在哪一步。
function rfaMark(stage) {
  try { document.documentElement.dataset.rfaCur = String(stage).slice(0, 120); } catch (e) {}
}

// 需要用户自己拿主意的主观/决策类字段，一律不填（避免误填“是否接受调剂/期望薪资/到岗时间”等）
// v0.6.58：「是否全日制」从黑名单移出——它是客观事实（可由 education[].eduType 推导），不是用户决策项。
// v0.7.1（#187 蔚来）：但「是否为全日制**在校**学生」是另一回事——它是「你是否 currently enrolled」的
//   校区合规题，且蔚来把这两个问题塞进了「社交账号」板块标题下方，导致 guessSection 把它们归到 social，
//   fallbackMap 的 social 分支对不认识的标签直接吐社交账号 ID（实测把「全日制在校学生」填成了
//   exampleuser_2026）。必须拦住。注意只拦「全日制+在校」组合，不能拦裸「是否全日制」——
//   后者在 education 段 2546 行要从 eduType 推导 是/否，必须在 FORBIDDEN 之后执行，否则会回归。
const FORBIDDEN_RE =
  /调剂|是否接受|是否到岗|是否应届|是否统招|是否在职|同意.*条款|隐私政策|用户协议|我已阅读|确认无误|承诺真实|信息真实|实习时长|到岗时间|可实习|每周到岗|入职时间|期望薪资|薪资范围|薪资待遇|薪资要求|全日制.*在校学生|在校学生|期望工作地点|意向工作地点/;

// ── v0.8.17（#289 蔚来）：黑名单的「必填豁免」白名单 ────────────────────────────
// 冲突现场：蔚来把「期望工作地点」和「是否为全日制在校学生」都设成了**必填**，
// 页面直接飘红「XXX为必填」，不填根本提交不了；可这两个标签又都在 FORBIDDEN_RE 里
// （前者当初是为规避多选大列表卡死，后者是防 social 板块兜底乱灌社交账号 ID）。
// 结果：插件为了"不替用户拿主意"，把两个必填项永久交白卷 —— 这不是稳健，是失职。
//
// 拆解：黑名单里其实混了两类东西
//   A. 真·主观决策（期望薪资 / 是否接受调剂 / 同意条款）—— 填错有实质代价，必填也不猜；
//   B. 客观事实（期望工作地点 / 是否全日制在校生 / 到岗时间）—— 档案里本来就有答案，
//      当初拉黑只是因为「组件难搞」或「归错板块」，属于技术债，不是价值判断。
// 只对 B 类开豁免，且必须同时满足「字段确为必填」+「能取到确定值」，取不到照样留空。
// v0.8.40（A3）：从豁免名单里剔除「全日制.*在校学生 / 在校学生」——用户明令不填（源文档无此答案）。
// 保留「到岗时间/入职时间/实习时长/可实习/每周到岗」：这几项源文档确有数据（到岗时间 2026.07 /
// 可实习时长 6 个月 / 每周出勤 5 天），且腾讯投实习时它们是必填项，不填提交不了。
// 注意执行顺序：intentDeclaredValue 在黑名单**之前**跑，档案里声明过的值会直接放行；
// 只有"档案里没有值"时才会走到这里，此时豁免也取不到值，自然留空——不会瞎猜。
const FORBIDDEN_REQUIRED_RE =
  /期望工作地点|意向工作地点|期望工作地|意向工作地|到岗时间|入职时间|实习时长|可实习|每周到岗/;

// ── v0.8.40（2026-08-14 · A3 硬闸门）─────────────────────────────────────────────
// 「源文档里没有对应数据」的字段，任何通道都不许填（含唯一选项必选 R4、radio 兜底、
// intent 声明值）。这是用户 08-13 复核蔚来后立的铁律，优先级高于「必填就得填」。
//   · 亲友/亲属/家属就职       —— 源文档无此信息，旧代码硬编码答「否」
//   · 是否为全日制在校学生     —— 源文档只有学历「学习形式」，没有这道合规问答的答案
//   · 预计入职时间             —— 蔚来站点专属问法；⚠️ 绝不能写成宽泛的 /入职时间/，
//                                否则会误伤腾讯必填的「最早可入职时间*」（源文档有到岗时间）
//   · 是否接受调剂             —— 虽然源文档写了「是」，但用户明令此项交由本人决定
const NO_SOURCE_DATA_RE =
  // 「调剂/分配」类：接受|服从 与 调剂 之间可能夹「专业/院校/岗位」等词（如「是否服从专业调剂」），
  // 故用 .{0,6} 宽松连接；单测 /tmp/a3.js 覆盖此用例。
  /(亲友|亲属|家属|亲戚).{0,8}(就职|工作|任职|在职)|是否.{0,4}(亲友|亲属|家属|亲戚)|全日制.*在校学生|在校学生|在读学生|是否在校|预计入职|预计到岗|(接受|服从).{0,6}(调剂|分配)/;

// 判定：该字段是否命中 A3 硬闸门（无源数据 → 一律不填，必填也不填）
function isNoSourceDataField(label) {
  if (!label) return false;
  // 「最早可入职时间」是腾讯必填且源文档有数据（到岗时间），必须放过，不能被 预计入职 类规则连坐
  if (/最早.*(入职|到岗)/.test(label)) return false;
  return NO_SOURCE_DATA_RE.test(label);
}

// 「同意条款/隐私政策」这类哪怕标了必填也绝不代劳勾选——法律意义上必须用户本人确认。
const NEVER_AUTO_RE = /同意.*条款|隐私政策|用户协议|我已阅读|确认无误|承诺真实|信息真实|调剂|期望薪资|薪资范围|薪资待遇|薪资要求/;

// 判定：这个字段虽然命中黑名单，但因为它是必填的客观题，应当放行填充。
function forbiddenButRequired(label, field) {
  if (!label) return false;
  if (NEVER_AUTO_RE.test(label)) return false;
  if (!(field && field.required)) return false;
  return FORBIDDEN_REQUIRED_RE.test(label);
}

// v0.7.0：上面的黑名单解决的是「插件不许替用户拿主意」。
// 但腾讯把「实习时长*」「每周可出勤天数*」「最早可入职时间*」都做成了必填，
// 用户如果在详细文档的 intent 里**明确声明**了值，那就是用户自己的决定、不是插件猜的 → 应当放行照填。
// 判定顺序：先查声明值，查到就返回；查不到才走黑名单拦截（对老站点行为完全不变，因为它们的档案里没有 intent）。
function intentDeclaredValue(label, profile, field) {
  const it = (profile && profile.intent) || {};
  if (!label) return null;
  // v0.8.11（#3 收尾）：用户铁律——「期望工作地点 / 意向工作地点」等城市偏好多选框，
  // 即便在 intent 里声明过 expectedCities 也绝不自动填。原因有二：
  //  ① 这类多选城市下拉选项成千上万，插件一展开就卡死主线程，连带后面所有字段都填不上
  //     （实测填充卡在「期望工作地点」100s+，current_city/hometown/education_type 全红）；
  //  ② 用户已明确选择手动处理。黑名单字段必须优先于 intent 声明，否则声明值会绕过黑名单。
  // v0.8.17（#289）修正：上面这条硬跳过**整个撤销**，理由今天都已不成立：
  //  ① 「一展开就卡死」的真凶是把 expectedCities 全部 3~5 个城市逐个丢进几百项列表线性查找。
  //     现在下面那条规则只取**前 2 个**城市，地址类还走搜索框直达（pickAddressBySearch），
  //     不再全表遍历 —— 卡死的前提没了。
  //  ② 「用户选择手动处理」已被用户改口推翻（「期望工作城市要填」），v0.7.5 据此放开了
  //     同义的「期望工作城市」分支，却漏改飞书系的叫法「期望工作地点」，两边一直自相矛盾。
  // 安全性不变：值只来自 intent 里用户**亲自声明**的 expectedCities，没声明就返回 null 留空。
  // 【踩过的坑】曾试图用「字段是否必填」当开关，实测行不通 —— 蔚来这类站点的必填红字
  // （「期望工作地点为必填」）**只在提交校验失败后才渲染**，首轮扫描时页面上一个标记都没有。
  // v0.7.7：字段别名。实测档案里存的是 intent.availableDate，代码却只读 availableFrom，
  // 于是腾讯实习的必填项「最早可入职时间*」永远取不到值 → 被黑名单拦下 → 交白卷。
  // 同类别名一次性补齐，避免以后再因为改名对不上号而静默漏填。
  const pick = (...ks) => {
    for (const k of ks) {
      const v = it[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return v;
    }
    return null;
  };
  // 「最早可入职时间」若档案里写的是已经过去的日期（档案放一阵子就会过期），
  // 日期控件通常直接禁选过去日期 → 点不中 → 必填项交白卷。这里做过期顺延：取 max(声明值, 今天)。
  // 这不属于「替用户拿主意」，只是把一个已失效的值纠正到最近的合法值，并会在结果页标出来。
  const availableAt = (() => {
    const raw = pick("availableFrom", "availableDate", "onboardDate", "entryDate", "startDate");
    if (!raw) return null;
    const m = String(raw).match(/(\d{4})\D{0,2}(\d{1,2})\D{0,2}(\d{1,2})?/);
    if (!m) return raw;
    const d = new Date(+m[1], +m[2] - 1, +(m[3] || 1));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (isNaN(d.getTime()) || d >= today) return raw;
    const p2 = (n) => String(n).padStart(2, "0");
    const fixed = today.getFullYear() + "-" + p2(today.getMonth() + 1) + "-" + p2(today.getDate());
    rfaLog({ act: "intent-date-bumped", from: String(raw), to: fixed }, "intent-date-bumped");
    return fixed;
  })();
  if (/实习时长|可实习(时长|时间|期限)?|实习期限/.test(label)) return pick("internshipDuration","internDuration","duration");
  if (/每周.*(出勤|到岗|工作)|出勤天数|到岗天数/.test(label)) return pick("weeklyDays","daysPerWeek","attendDays");
  if (/最早.*(入职|到岗)|入职时间|到岗时间|可到岗/.test(label)) return availableAt;
  if (/期望薪资|薪资范围|薪资待遇|薪资要求|expected\s*salary/i.test(label)) return it.expectedSalary || null;
  if (/(接受|服从).*(其他|其它).*城市|城市分配|调剂/.test(label)) return it.acceptOtherCities || null;
  // v0.7.0（腾讯）：意向板块的自定义下拉（Element UI el-select，非 filterable 时无内部 input）。
  // 「期望工作城市*」可能是多城市——档案里 expectedCities 是数组，用顿号拼接；
  // 「参加面试城市*」取 interviewCity。两者都是用户明确的客观意向，不属于「插件替用户拿主意」。
  // v0.8.17（#289）：「期望工作**地点**」（蔚来/字节飞书系的叫法）与「期望工作城市」同义，
  // 合并到同一条规则。多选城市只取前 2 个 —— 这类下拉动辄几百上千项，
  // 每多一个 token 就要多遍历一整轮选项列表，是当初把整字段拉黑的直接原因。
  if (/期望.{0,4}工作城市|目标城市|期望城市|期望.{0,4}工作地点|意向.{0,4}工作地点|期望工作地|意向工作地/.test(label)) {
    const ec = it.expectedCities;
    if (Array.isArray(ec) && ec.length) {
      // v0.8.40：上限改成「读标签怎么写就填几个」。
      // 原先无脑 slice(0,2) 是为了防几百项的城市下拉逐 token 线性查找卡死（v0.8.17），
      // 但腾讯标签明写「期望工作城市（至多三个）」，只填 2 个 = 白丢一个用户已声明的城市。
      // 规则：标签里能解析出数量上限就用它（封顶 3，再多也不填以保住性能），否则维持 2。
      let cap = 2;
      const cn = { 一: 1, 二: 2, 三: 3, 两: 2 };
      const m = String(label).match(/(?:至多|最多|不超过|上限)\s*([0-9一二三两])\s*(?:个|项|座|城市)?/);
      if (m) cap = Math.min(3, cn[m[1]] || parseInt(m[1], 10) || 2);
      return ec.slice(0, cap).join("、");
    }
    return it.expectedCity || null;
  }
  if (/参加.{0,4}面试城市|面试城市|可?参加?面试城市/.test(label)) return it.interviewCity || null;
  // v0.8.30（2026-08-11）：腾讯「当前所处地」= 当前所在城市，取 basic.location（如「北京市朝阳区」）。
  if (/当前所处地|目前所在地|现居[所住]地|当前所在城[市乡]/.test(label)) {
    const _loc = (profile && profile.basic && (profile.basic.location || profile.basic.city)) || null;
    if (_loc) return _loc;
  }
  // 意向板块里那个裸 placeholder 为「选择日期」的日期框就是「最早可入职时间」
  // （教育/实习的日期框已被日期配对加上「（开始）/（结束）」后缀，不会命中这里）。
  if (/^选择日期$|最早.*(入职|到岗)|入职时间|到岗时间|可到岗|到岗日期/.test(label)) return availableAt;
  return null;
}

// v0.7.0：判断一个文本域是不是「三合一」的其他关键信息框。
// 背景：插件读 label 时会优先取有含义的 placeholder（见 getLabel），
// 腾讯这个框的 placeholder 是「请输入其他相关信息，如自我评价，爱好特长，补充信息等…
// 1、自我评价：… 2、爱好特长：… 3、补充信息：…」，三个关键词同时出现。
// 若不先拦下来，它会被更靠前的「自我评价」单条规则命中，结果只填一段、丢掉另外两段。
function isComboOtherInfoLabel(label) {
  if (!label) return false;
  const s = String(label);
  let n = 0;
  if (/自我评价/.test(s)) n++;
  if (/爱好|特长/.test(s)) n++;
  if (/补充信息|其他相关信息|其他关键信息/.test(s)) n++;
  return n >= 2;
}

// 按腾讯官方建议格式拼 3 段；任一段为空则跳过该段编号内容，不留空壳。
function composeOtherInfo(profile) {
  const oi = (profile && profile.otherInfo) || {};
  const self = oi.selfEval || (profile && profile.selfEval) || "";
  const parts = [];
  if (self) parts.push(`1、自我评价：${self}`);
  if (oi.hobbies) parts.push(`2、爱好特长：${oi.hobbies}`);
  if (oi.supplement) parts.push(`3、补充信息：${oi.supplement}`);
  return parts.length ? parts.join("\n") : null;
}

// v0.7.0：R4 规则——必填（带 *）的下拉若「只有唯一一个可选项」，那它就没有决策成分，直接选。
// 这条规则优先级高于黑名单：腾讯「参加面试城市*」只有一个选项时，不选就过不了校验。
function isSingleOptionRequired(field) {
  if (!field) return false;
  const req = field.required || /[*＊]/.test(String(field.rawLabel || field.label || ""));
  const n = typeof field.optionCount === "number" ? field.optionCount : -1;
  return !!req && n === 1;
}

// v0.8.13：用户在面板设置的手机区号（chrome.storage.local.rfa_phone_cc，如 "86"/"852"）。
// 填充启动（onMessage autofill）时预读进此全局变量；区号下拉在「档案手机号无国家码」时按此选择——
// 用户明确选择 = 有数据，不违反「无数据不选」铁律；未设置时维持铁律（留空提示用户手动确认）。
let RFA_USER_PHONE_CC = "";

// v0.8.13：从档案手机号提取国家码（"86"/"852"…）。
// 只认「+ 开头」的号码（无 + 视为无国家码，铁律：不猜）；
// 按已知国家码列表最长优先匹配，且要求后面至少 5 位本地号码——
// 修历史 bug：原 /^\+(\d{1,4})/ 贪婪匹配会把手机号开头吞掉
//（"+86 13800138000" 被误取成 "8617"、"+852 61234567" 被误取成 "8526"）。
const KNOWN_CC = ["886", "852", "853", "86", "65", "81", "82", "44", "61", "33", "49", "91", "7", "1"];
function extractCcFromPhone(phone) {
  const s = String(phone || "").replace(/[\s\-()]/g, "");
  if (!/^\+/.test(s)) return "";
  const d = s.slice(1);
  for (const cc of KNOWN_CC) {
    if (d.startsWith(cc) && /^\d{5,}$/.test(d.slice(cc.length))) return cc;
  }
  return "";
}

// v0.6.58：招聘站的手机号框旁边基本都有独立的「+86」区号选择器，
// 若把 +86 一起打进号码框会变成「+86+8613800138000」导致校验失败（字节跳动实测）。
// 因此填号码框前统一剥掉国家码，只留 11 位本机号。
function stripCnPhone(phone) {
  let s = String(phone || "").trim();
  if (!s) return s;
  const compact = s.replace(/[\s\-()]/g, "");
  const m = compact.match(/^(?:\+?86|0086)(1\d{10})$/);
  if (m) return m[1];
  return s;
}

// v0.6.47：主观评级字段（精通程度/熟练程度/语言水平等）一律不填，只填客观字段（语言/社交平台）。
// 注意：本正则只拦截「评级」类 label，不会误伤「语言」「语种」「社交平台」等客观字段。
const SUBJECTIVE_RATING_RE =
  /精通程度|熟练程度|熟练度|掌握程度|语言水平|语言等级|level|proficiency|听说读写|读写能力|口语水平|等级评分/;

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (style.opacity === "0") return false;
  return true;
}

function isFillable(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === "button") return false;
  // #561b（2026-08-26 北森）：北森顶部「上传简历/拖拽上传」区有个 textarea（粘贴简历文本用），
  // 它会被 scanFields 当普通 textarea 扫到并被误填经历内容。凡祖先含「上传简历/拖拽/粘贴简历」语义的输入一律跳过。
  if (tag === "textarea" || tag === "input") {
    try {
      const anc = el.closest('[class*="upload"], [class*="Upload"], [class*="drop"], [class*="Drop"]');
      if (anc && /上传|拖拽|drag|粘贴|paste|resume|简历/i.test((anc.innerText || "").slice(0, 120))) return false;
    } catch (e) {}
  }
  // 飞书/字节系自定义下拉框（role=combobox 的输入框，含只读框内部 input）必须点开才能选。
  // 必须放在 readOnly 判断之前：只读下拉框内部 input 带 readonly，但下拉本身是要被点开选的，
  // 否则性别/学历/学历类型/语言/精通程度/社交平台等只读框全部被漏扫（这是 v0.6.x 一直没填上的根因）。
  if (el.getAttribute && el.getAttribute("role") === "combobox") return true;
  // v0.6.46：只放行「真正带 .ud__select__selector 的下拉容器」（飞书自定义下拉的内部盒子），
  // 不再放行裸 .ud__select 包装 div——蔚来「学校名称」就是裸 .ud__select 包装、内部是普通文本 input，
  // v0.6.45 误把它当下拉框导致填不上（回归）。裸 .ud__select 不应在此放行，其内部 input 会被标准 input 分支正常填。
  const _cls = (el.className || "").toString();
  if (/ud__select__selector|formily-select|semi-select/.test(_cls)) return true;
  // v0.7.0：腾讯招聘用 Element UI（el-select）。非 filterable 的 el-select 不渲染内部 <input>，
  // 选中值以 <span> 呈现，标准 input 选择器完全漏扫——意向里的「期望工作城市/参加面试城市/
  // 实习时长/每周可出勤天数」、教育里的「学历/成绩排名」、获奖里的「获奖类型」、语言里的
  // 「外语考试/等级」整批漏掉。放行 .el-select 包裹层（内部 input 会被嵌套去重剔除）。
  if (/\bel-select\b/.test(_cls)) return true;
  // v0.8.2（#266）：百度 talent.baidu.com 的「学校 / 专业」是 Ant Design Select（.ant-select），
  // 可点盒子是外层 div，内部 input 只是搜索入口且宽高常被压到很小。isCombobox 虽然认识，
  // 但 scanFields 先过 isFillable，这里没放行 → 整组 ant-select 被当成不可填元素丢弃，
  // 学校/专业永远进不了候选列表，后面再强的下拉选择逻辑都无用武之地。
  if (/\bant-select\b/.test(_cls)) return true;
  // 百度校招自定义下拉（brick-select）：内部无 input、纯点击选，按只读下拉处理
  if (/\bbrick-select\b/.test(_cls)) return true;
  // v0.6.58：美团 mtd-select 的内部 input 常带 readonly（只能点开选，不能打字），
  // 但它必须被扫进来，否则「学历/性别/工作类型/是否全日制」整批下拉全部漏填。
  // 注意只豁免 readOnly，disabled 的仍然跳过（页面禁用的下拉不该去动）。
  if (!el.disabled && el.closest && el.closest(".mtd-select")) return true;
  // v0.6.62：美团 mtd-date-picker 的输入框一律带 readonly（只能点开日历选，不能打字），
  // 之前被下面的 readOnly 判断整批拦掉，导致「入学/毕业/开始/结束时间」42 个日期框一个都没扫进来
  // ——这是美团日期全空的真正根因（不是匹配问题，是根本没进候选列表）。
  if (!el.disabled && el.closest && el.closest(".mtd-date-picker")) return true;
  // 2026-08-10（大疆实测）：Moka 自研 sd-* 组件的日期选择器，可点容器是
  //   <label class="sd-Input-container-… sd-picker-input-cc1UP day_info …">
  // 里面的 <input readonly>，和美团 mtd-date-picker 是同一类坑：readOnly 被下面一行拦死，
  // 字段**根本进不了 scanFields 的候选列表**（大疆「出生日期 (年龄)」连 data-rfa-idx 都没有，
  // map-table 里查无此行）。只豁免 readOnly，disabled 的仍旧跳过。
  if (!el.disabled && el.closest && el.closest('[class*="sd-picker-input"]')) return true;
  // v0.8.18（#290）：京东 campus.jd.com 用 Ant Design 日历选择器（v3 = .ant-calendar-picker /
  // v4 = .ant-picker），内部 <input readonly> 被下方 readOnly 判断整批拦掉，导致「开始/结束/请选择日期」
  // 等 22 个日期框根本没进 scanFields 候选列表（map-table 无日期行、antd-cal 日志为 0）——这是京东 R1 卡在 67% 的真正根因。
  // 与美团 mtd-date-picker / 大疆 sd-picker 同一类坑，放行其容器；下方 tryPickAntdCalendar / tryPickAntdPickerV4 会接管真实点选。
  // 只豁免 readOnly（disabled 的仍跳过）；容器判断用 closest 而非 className，兼容「input 自身不带 ant-calendar-picker 类」的情况。
  if (!el.disabled && el.closest && (el.closest(".ant-calendar-picker") || el.closest(".ant-picker"))) return true;
  if (el.disabled || el.readOnly) return false;
  if (el.getAttribute("contenteditable") === "true" || el.getAttribute("role") === "textbox") {
    return true;
  }
  if (tag === "input") {
    const t = (el.type || "").toLowerCase();
    return ["text", "search", "tel", "email", "url", "date", "month", "", "number"].includes(t);
  }
  return tag === "textarea" || tag === "select";
}

function containsInteractive(el) {
  if (!el) return false;
  return !!el.querySelector("input, textarea, select, [contenteditable='true']");
}

function getText(el) {
  return (el && (el.innerText || el.textContent || "")).trim();
}

function findNearestText(el) {
  let node = el;
  for (let depth = 0; depth < 6 && node; depth++) {
    let prev = node.previousElementSibling;
    while (prev) {
      const text = getText(prev);
      if (text && text.length < 60 && !containsInteractive(prev)) return text;
      prev = prev.previousElementSibling;
    }
    node = node.parentElement;
  }
  node = el.parentElement;
  for (let depth = 0; depth < 3 && node; depth++) {
    const text = getText(node);
    if (text && text.length < 80 && !containsInteractive(node)) return text;
    node = node.parentElement;
  }
  return "";
}

// v0.7.2：通用「上溯取容器标签」。不绑定任何站点类名，antd / element / mtd / moka / 北森通吃。
// 用途：当控件自身的 placeholder 是「年」「月」这类无语义碎片时，真实标签在外层容器上。
function labelFromContainer(el) {
  const BAD = /^[*＊:：\s]+$|^\d+\s*\/\s*\d+$|^请(输入|选择)|^(年|月|日)$|不正确|不匹配|不能为空|必填|格式错误/;
  const SEL =
    ".ant-form-item,.el-form-item,.mtd-form-item,[class*='form-item']," +
    "[class*='formItem'],[class*='FormItem'],[class*='field'],[class*='Field']";
  const LAB =
    "label,[class*='label'],[class*='Label'],[class*='title'],[class*='Title']," +
    "legend,h1,h2,h3,h4,h5";
  const pick = (root) => {
    let lab;
    try { lab = root.querySelector(LAB); } catch (e) { return ""; }
    if (!lab) return "";
    const t = getText(lab).replace(/[:：*＊\s]+$/, "").trim();
    return t && t.length <= 24 && !BAD.test(t) ? t : "";
  };
  // ① 优先沿「表单项容器」上溯——语义最准
  let node = el.closest && el.closest(SEL);
  for (let hop = 0; hop < 3 && node; hop++) {
    const t = pick(node);
    if (t) return t;
    node = node.parentElement && node.parentElement.closest(SEL);
  }
  // ② 兜底：类名被 CSS Modules 混淆的站点（实测 Moka 的 sd-Input-input-QsLkW）匹配不到
  //    任何 form-item 容器，只能纯 DOM 逐级上溯，找最近的标签/标题元素。
  //    Moka 的「毕业时间 / 就读时间 / 起止时间 / 获奖时间」就是靠这一步拿到的。
  node = el.parentElement;
  for (let hop = 0; hop < 8 && node; hop++) {
    const t = pick(node);
    if (t) return t;
    node = node.parentElement;
  }
  return "";
}

function getLabel(el) {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();
  // v0.7.1（#185）：.el-dropdown 字段（外语考试类型等）收集时已把干净标签写入属性，优先读取，
  // 否则会退化到 findNearestText 只拿到触发文字「请选择」，fallbackMap 路由不到正确分支。
  if (el.getAttribute && el.getAttribute(DROPDOWN_ATTR) === "1") {
    const l = el.getAttribute("data-rfa-dropdown-label");
    if (l) return l;
  }
  // 飞书/字节 formily 组件把中文标签放在 data-form-field-i18n-name 上（如「公司名称」「项目名称」），
  // 这是最可靠的标签来源——之前没读它，导致大量字段 label 为空、被错填/漏填。
  const i18n = el.getAttribute("data-form-field-i18n-name");
  if (i18n && i18n.trim()) return i18n.trim();
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => getText(document.getElementById(id)))
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }
  if (el.id) {
    try {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab && getText(lab)) return getText(lab);
    } catch (e) {}
  }
  const ancestor = el.closest("label");
  if (ancestor && getText(ancestor)) return getText(ancestor);
  // v0.6.71：美团(mtd)表单不用 label[for] / aria-label，字段名只是 .mtd-form-item 里的一段纯文本，
  // 之前只能退而取 placeholder。后果是 placeholder 没信息量的字段读不出名字：
  //   「考试分数」placeholder 仅「请输入」→ 语言分支全部不匹配 → 命中兜底 return item.name
  //    → 分数框被填成语种名「英语」，页面直接报「考试分数格式不正确」；
  //   「论文链接」placeholder 是「请选择」→ 同样读不出。
  //
  // 但 placeholder 不能一概让位：美团把「起止日期」两个输入放在同一个 form-item 内
  // （标签只有一个「在校时间/项目时间」），唯一能区分起/止的就是 placeholder
  // （入学时间 vs 毕业时间、开始时间 vs 结束时间）。若改用 form-item 标签，
  // 起止两框会拿到同一个名字，17/18 个已填好的日期会全部错位。
  // 所以规则是：placeholder 只要有具体含义就保留，仅当它是「请输入 / 请选择」这类空壳时才用标签。
  const placeholder = (el.getAttribute("placeholder") || "").trim();
  // ── v0.7.2：年 / 月 / 日「分段日期」下拉（Moka、北森这类 ATS 大量使用）──────────
  // 页面结构是 <label>开始时间</label> 后跟两个 select，placeholder 分别为「年」「月」。
  // 旧逻辑把 placeholder 直接当标签返回，matchField 收到的就是光秃秃的「年」，
  // 任何日期规则都匹配不上 —— Moka 实测 7 个「年」+ 7 个「月」全部空白，占其空白总数一半。
  // 修法：识别出分段后上溯取真实标签，拼成「开始时间（年）」，
  // 再由 matchField 的包装层按后缀切出 YYYY / MM。保持通用，不写死任何站点。
  const _segRaw = placeholder.replace(/^请选择/, "").trim();
  const _seg = /^(年|yyyy)$/i.test(_segRaw) ? "年"
    : /^(月|mm)$/i.test(_segRaw) ? "月"
    : /^(日|dd)$/i.test(_segRaw) ? "日" : "";
  if (_seg) {
    const owner = labelFromContainer(el);
    if (owner) return owner + "（" + _seg + "）";
  }
  if (!placeholder || /^请(输入|选择)$/.test(placeholder)) {
    const mtdItem = el.closest && el.closest(".mtd-form-item");
    if (mtdItem) {
      // 排除：必填星号、字数计数器(0/2000)、占位提示、校验报错文案
      const bad = /^[*＊]+$|^\d+\s*\/\s*\d+$|^请(输入|选择)|不正确|不匹配|不能为空|必填|格式错误/;
      const line = (mtdItem.innerText || "")
        .split("\n")
        .map((s) => s.trim().replace(/[*＊]+\s*$/, "").trim())
        .find((s) => s && s.length <= 20 && !bad.test(s));
      if (line) return line;
    }
    // ── v0.7.9（#264）：Moka 体系（app.mokahr.com 全家 + 大疆 apply.careers.dji.com）──
    // 结构：<div class="apply-field-xxx">
    //         <div class="title-xxx"><span><span>性别</span></span></div>
    //         <div class="ctrl-xxx">…<input placeholder="请选择">…</div>
    //       </div>
    // 字段名既不在 label[for] 也不在 aria-label，而在兄弟节点 .title-xxx 里，
    // 且 placeholder 统一是空壳「请选择」。旧逻辑此处只认美团的 .mtd-form-item，
    // 其余站点直接 return placeholder → matchField 收到的字段名就是「请选择」，
    // 任何映射规则都匹配不上 → 性别 / 工作经验 / 最高学历 / 学历 / 出生日期 全站留白。
    // 实测证据：插件自己的浮窗写着「未填字段（6）：请选择 ×4 + 证件号码 + 当前薪资」。
    // 注意：真正的坑不是下拉弹层选择器 —— v0.7.8 已实测能命中「男 / 女」选项，
    // 而是压根没拿到字段名，连"该填什么值"都算不出来，弹层根本没被打开过。
    // 修法：placeholder 是空壳时，从最近的「字段盒」里取标题文本。通用写法，不写死站点。
    const fieldBox =
      el.closest &&
      el.closest(
        '[class*="apply-field"], [class*="form-item"], [class*="formItem"], [class*="field-item"]'
      );
    if (fieldBox) {
      const titleEl = fieldBox.querySelector('[class*="title"], [class*="Title"], label');
      let t = titleEl ? (getText(titleEl) || "").trim() : "";
      t = t.replace(/[*＊]+/g, "").replace(/[:：]\s*$/, "").trim();
      const bad2 = /^$|^\d+\s*\/\s*\d+$|^请(输入|选择)|不正确|不匹配|不能为空|必填|格式错误/;
      if (t && t.length <= 24 && !bad2.test(t)) return t;
    }
    // #561b（2026-08-26 北森攻破）：北森（zhiye.com）的字段容器是 .form-item--phoenix，
    // 容器文本就是完整 label（如「工作职责 0/2000」「单位名称」「出生日期 请选择」）。
    // 旧逻辑 fieldBox 只认 apply-field/form-item 等 class，北森匹配不上 → label 全空 → 28 字段未填。
    // 注意容器文本会带「0/2000」字数、其他字段名（form-part 是整行）——只取第一个中文短语。
    const phBox = el.closest && el.closest(".form-item--phoenix, [class*='form-item--phoenix']");
    if (phBox) {
      const raw = (phBox.innerText || "").replace(/\s+/g, " ").trim();
      // 取第一段中文标签（如「工作职责 0/2000」→「工作职责」；「出生日期 请选择」→「出生日期」）
      const m = raw.match(/^([\u4e00-\u9fa5A-Za-z0-9（）()·/]{2,16})/);
      const t = m ? m[1].replace(/^[＊*]+/, "").trim() : "";
      const bad3 = /^$|^\d+\s*\/\s*\d+$|^请(输入|选择)|不正确|不匹配|不能为空|必填|格式错误/;
      if (t && t.length <= 16 && !bad3.test(t)) return t;
    }
  }
  if (placeholder) return placeholder;
  const title = el.getAttribute("title");
  if (title) return title.trim();
  // formily 组件：标签在兄弟节点 .ud-formily-item-label 内（用于没有 i18n-name 的选择框，如 学历/性别）
  const formilyItem = el.closest && el.closest("[class*='formily-item']");
  if (formilyItem) {
    const lab = formilyItem.querySelector("[class*='formily-item-label'], label");
    if (lab) {
      const t = getText(lab).replace(/[:：]\s*$/, "").trim();
      if (t) return t;
    }
  }
  return findNearestText(el);
}

// 检测页面上的板块标题
// 这些词通常是「字段标签」而非板块标题（如「获奖时间」「项目名称」含板块关键词却不是板块），用来排除误判。
// 注意：只把真正的字段标签词放进来，不要把「项目/公司/学校/添加」等会出现在板块标题里的词放进去，
// 否则「项目经历」「实习经历」「工作经历」「获奖」等合法板块会被误判为字段标签而漏识别。
// v0.6.71：补上美团新板块里的字段标签。这些词自身带着板块关键词
//（「获奖大赛」含"获奖"、「语言考试」含"语言"），不排除就会被当成板块标题，
// 同一板块被检测两次 → expandExperienceSections 连点两轮「添加」，空白卡片翻倍。
// v0.7.0 追加（腾讯实测）：下面这批是「板块内部的字段标签」，绝不是板块标题。
//   ·「导师 *」——教育经历展开区 div.education_more 的首个标签，被 papers 正则命中，
//     整块教育扩展字段（导师/实验室/研究方向）全被归进不存在的 papers 板块 → 三项全空。
//   ·「外语考试/等级」——语言能力板块内的一行标签（div.send_content），被 skills 正则命中，
//     后面的「请填写分数」跟着被判成 skills → 语言分数填不进去。
//   ·「绩点 / 满绩 / 已发表论文」同理，都是字段名而非板块名。
const FIELD_LABEL_HINT =
  /(名称|时间|起止|描述|链接|角色|职位|岗位|部门|专业|学历类型|城市|性别|邮箱|手机|电话|出生|地址|主页|id|url)$|^添加$|^没有|^语言$|^语种$|^精通程度$|^熟练程度$|^语言水平$|^获奖大赛$|^发表渠道$|^作者顺序$|^影响因子$|^语言考试$|^考试分数$|^成绩排名$|^获奖情况$|^导师$|^实验室$|^课题组$|^研究方向$|^绩点$|^满绩$|^分数$|^外语考试[\/／]?等级$|^已发表论文$|^个人主页$/i;
// v0.6.63：这些容器里的文字永远不是「简历板块标题」——
//   .mtd-popover  美团的隐藏气泡（实测「你需要阅读并同意《个人信息保护隐私政策》」，
//                 rect 是 0×0、根节点 display:none，isVisible 没拦住，被当成了一个 basic 板块）
//   .resume_detail-footer  页面最底部的「我已阅读并同意 / 取消 / 保存」操作条（同样被判成 basic）
// 结果是 basic 被检测出 3 个，板块归属整体错位。
const NON_SECTION_CONTAINER =
  ".mtd-popover, .mtd-tooltip, .mtd-modal, .mtd-dialog, .mtd-drawer, .mtd-message, .mtd-toast, " +
  // v0.6.71：下拉/级联/日历「弹层」里的文字永远不是板块标题。
  // 实测：竞赛级联被点开后弹层挂在 body 上（top≈793，正好落在「工作/实习经历」下面），
  // 其中一项文字是「○ 获奖大赛」，被 awards 正则 /获奖/ 命中 → 幽灵 awards 板块，
  // 把工作经历 21 个字段整片吞进 awards（awards 从 8 涨到 29，internships 直接消失）。
  // v0.6.72：类名以实测为准（probe-cascader）。美团级联弹层真实结构是
  //   .mtd-cascader-popup-wrapper > .mtd-cascader-menus-wrapper > .mtd-cascader-menus > ul.mtd-cascader-menu
  // 之前只写了臆测的 .mtd-cascader-popper，外层三个 wrapper 没被排除，幽灵板块照样成立。
  ".mtd-select-dropdown, .mtd-cascader-popper, .mtd-cascader-popup-wrapper, " +
  ".mtd-cascader-menus-wrapper, .mtd-cascader-menus, .mtd-cascader-menu, .mtd-popper, " +
  ".mtd-picker-panel, .mtd-date-picker-panel, .mtd-dropdown, " +
  "[role='dialog'], [role='tooltip'], [role='alert'], [role='listbox'], .resume_detail-footer, .resume_detail_popover, " +
  // v0.7.0 关键修复：「侧边目录 / 锚点导航」里的文字不是板块标题。
  // 实测腾讯简历页左侧有一条 .toc-sidebar（position:fixed）> ul.toc-sidebar-list > li.toc-sidebar-link，
  // 13 个目录项文字正是「基础信息 / 意向信息 / 教育经历 / 实习经历 / 项目经历 / 获奖信息 /
  // AI应用技能 / 语言能力 / 资料证明人 / 其他关键信息」——每一条都命中 SECTION_KEYWORDS，
  // 于是板块被检测出两套：真表单一套（rect.top 为负，页面已滚过）＋ 目录一套（rect.top 258~587）。
  // guessSection 取「上方最近板块」，凡是 rect.top 落在 258~890 之间的真实字段全被目录劫持：
  //   「请输入作品链接」→ intent、「请输入密码或提取码」→ projects、「个人主页超链接」→ otherInfo。
  // 更阴的是目录是 fixed 的，会跟着视口跑 —— 页面滚到不同位置，被劫持的字段还不一样，
  // jsdom 单测（无滚动、无 fixed 布局）永远复现不出来。
  "nav, [role='navigation'], [role='tablist'], .toc-sidebar, [class*='toc-sidebar'], " +
  // v0.8.18（#291 拼多多）：拼多多用 rocket 组件库的 `.rocket-anchor.fixed`，
  // class 叫 anchor-link / anchor-wrapper，既不含 "anchor-nav" 也不含 "nav-anchor"，
  // 下面那两条通配全都躲过去了。结果左侧 7 个目录项（"1.基本信息"…"7.作品集"，彼此只差 48px）
  // 被当成 7 个板块锚点，而真表单标题在 y=853~1758 —— addBtnBelongsTo 于是拿目录项算边界：
  // education 的 myTop=183、nextTop=231，真实「添加教育经历」按钮在 y=926 → 判「已落进下一板块」
  // 直接否决 → 每个板块都 expand-nobtn，四大板块一张卡都建不出来（实测全页只有 11 个字段）。
  // 「anchor」这个词本身就是导航语义，正常表单容器不会用它命名，故按裸词通配排除。
  "[class*='anchor'], " +
  "[class*='anchor-nav'], [class*='nav-anchor'], [class*='sidebar-link'], [class*='catalog'], [class*='side-menu']";
// 协议/条款类文案不可能是板块标题
const NON_SECTION_TEXT = /(隐私政策|阅读并同意|用户协议|服务条款|使用协议)/;
function detectSections() {
  const sections = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const el = walker.currentNode;
    if (!isVisible(el)) continue;
    // v0.6.71 关键修复：表单控件永远不是板块标题。
    // 实测美团荣誉卡的 textarea 值是「负责模型构建与论文撰写…」，含「论文」二字，
    // 被当成了一个 papers 板块锚点插在荣誉板块中间，把后面 3 张荣誉卡整体吞进 papers，
    // 于是荣誉索引错位、论文板块拿到 16 个字段（真实只有 10 个）。
    if (/^(INPUT|TEXTAREA|SELECT|OPTION|BUTTON)$/.test(el.tagName)) continue;
    // v0.6.63：浮层/气泡/底部操作条 一律不是板块
    if (el.closest && el.closest(NON_SECTION_CONTAINER)) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue; // 0×0 的隐藏浮层
    const text = getText(el);
    if (!text || text.length > 60) continue;
    if (NON_SECTION_TEXT.test(text)) continue;

    // v0.6.71：先看「首行」自己命中哪个板块——首行才是真标题。
    // 实测美团竞赛板块 innerText = 「竞赛\n获奖大赛*\n请选择…」，
    // 整段文本里的「获奖」会先命中 awards（awards 在对象里排得更靠前），
    // 导致竞赛板块被错判成荣誉；反过来荣誉卡填上「…数学建模竞赛 一等奖」后
    // 又会反向命中 competitions。只有以首行为准才两边都对。
    // 剥掉尾部必填星号 + 头部的单选圈/勾选框/项目符号（弹层选项常带「○ 」「√ 」「• 」前缀），
    // 否则 FIELD_LABEL_HINT 里的 ^锚点$ 永远匹配不上。
    const headLine = (text.split("\n").map((s) => s.trim()).filter(Boolean)[0] || text)
      .replace(/^[○●◯□■▪•·✓√\-–—*＊\s]+/, "")
      .replace(/[*＊]+\s*$/, "")
      .trim();
    let entries = Object.entries(SECTION_KEYWORDS);
    const headHit = entries.find(([, re]) => re.test(headLine));
    if (headHit) entries = [headHit];

    for (const [name, regex] of entries) {
      if (regex.test(text)) {
        // 只检查「首行」是否是字段标签：板块标题元素常把内部字段文本一起 innerText 出来
        // （如「获奖\n\n获奖名称\n获奖时间\n描述\n添加」），首行「获奖」是合法标题；
        // 而幽灵板块（如获奖卡片「获奖名称\n获奖时间\n描述」）首行「获奖名称」是字段标签 → 排除。
        // v0.6.71：美团必填字段的标签自带星号（「获奖大赛*」「语言考试*」），
        // 不先剥掉星号，FIELD_LABEL_HINT 的 $ 锚点就永远匹配不上。
        const firstLine = headLine;
        if (FIELD_LABEL_HINT.test(firstLine)) break;
        // v0.6.62：排除「添加教育经历 / 添加项目经历 / 添加荣誉 / 添加语言水平」这类按钮。
        // 它们的文字里带着板块关键词，之前被当成板块标题，于是同一个板块被检测出两次；
        // expandExperienceSections 就会对同一板块点两轮「添加」，空白卡片直接翻倍
        // （实测：教育 7 张、项目 8 张、荣誉 8 张、实习 6 张），
        // 而且多出来的卡片会把后面字段的 section 归属整个打乱（教育字段被算进 basic/languages）。
        if (/^(添加|新增|\+\s*添加|add\b)/i.test(firstLine)) break;
        if (isRealAddButton(el)) break;
        const rect = el.getBoundingClientRect();
        sections.push({ name, el, text, top: rect.top, left: rect.left });
        break;
      }
    }
  }
  // 按页面从上到下排序
  sections.sort((a, b) => a.top - b.top || a.left - b.left);
  // 去重：同一区域只保留第一个
  // v0.6.63：除了「距离很近」，还要判断 DOM 包含关系。
  // 实测作品集：外层 .mtd-upload（top=3069）和它内部的 div.info_1（top=3152）文字都含「作品集」，
  // 相距 83px 超过了 60px 阈值 → portfolio 被检测成 2 个板块。
  // 已排序为 top 升序，祖先的 top 必然 ≤ 后代，所以保留先出现的（外层）即可。
  const deduped = [];
  sections.forEach((s) => {
    const dup = deduped.find(
      (d) =>
        d.name === s.name &&
        (Math.abs(d.top - s.top) < 60 ||
          (d.el && s.el && d.el !== s.el && (d.el.contains(s.el) || s.el.contains(d.el))))
    );
    if (!dup) deduped.push(s);
  });

  // v0.7.0 通用兜底：剔除「目录/锚点导航」整组。
  // 上面的 NON_SECTION_CONTAINER 按 class 名精确排除（腾讯 .toc-sidebar 已覆盖），
  // 但换个站点换套 class 就又会中招，所以这里再补一条不依赖类名的形态判定：
  //   同一个父容器下挂着 ≥3 个板块锚点，且相邻锚点垂直间距全都 ≤ 60px → 这是一份目录，不是板块。
  // 为什么安全：真板块之间一定隔着若干输入框，间距是几百上千 px。
  // 实测腾讯 —— 目录 ul.toc-sidebar-list 下 10 个锚点间距恒为 33px；
  // 而真板块虽然也共用父容器 ul.send_list，间距却是 1286 / 1157 / 1035 px，不会被误伤。
  const byParent = new Map();
  deduped.forEach((s) => {
    const p = s.el && s.el.parentElement;
    if (!p) return;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(s);
  });
  const navSet = new Set();
  byParent.forEach((group, parent) => {
    if (group.length < 3) return;
    // 判据一：目录本质是一份「列表」。父容器必须是 ul/ol/nav 或显式的导航语义节点，
    // 否则一律不当导航看。少了这条，页面直接把 <h3> 平铺在 body 下的简单布局
    // （单测就是这种）会被整片误杀 —— 实测 ghost-section 的 9 个合法板块全没了。
    const pTag = (parent.tagName || "").toUpperCase();
    const pRole = (parent.getAttribute && parent.getAttribute("role")) || "";
    if (!/^(UL|OL|NAV)$/.test(pTag) && !/^(navigation|tablist|menu|menubar)$/.test(pRole)) return;
    // 判据二：目录容器里不可能有任何表单控件，真板块的容器里必然有一堆输入框。
    // 腾讯真板块的父容器 ul.send_list 也是 UL，靠这条＋间距两重保险区分开。
    if (parent.querySelector("input, textarea, select, [contenteditable='true'], [role='combobox']")) return;
    const tops = group.map((g) => g.top).sort((a, b) => a - b);
    let dense = true;
    for (let i = 1; i < tops.length; i++) {
      if (tops[i] - tops[i - 1] > 60) { dense = false; break; }
    }
    if (dense) group.forEach((g) => navSet.add(g));
  });
  return navSet.size ? deduped.filter((s) => !navSet.has(s)) : deduped;
}

function guessSection(el, sections) {
  const rect = el.getBoundingClientRect();
  // 找到在元素上方最近的板块
  let best = null;
  for (const s of sections) {
    if (s.top > rect.top + 5) continue; // 板块标题必须在输入框上方或同高
    if (!best || s.top > best.top) best = s;
  }
  return best ? best.name : "unknown";
}

function isDateInput(el) {
  if (el.tagName.toLowerCase() !== "input") return false;
  const t = (el.type || "").toLowerCase();
  return ["date", "month"].includes(t);
}

function isTextLikeInput(el) {
  if (el.tagName.toLowerCase() !== "input") return false;
  const t = (el.type || "").toLowerCase();
  return ["text", "search", "", "tel", "email", "number"].includes(t);
}

// 判断元素或其祖先是否是飞书/字节系月份范围选择器
function isMonthRangePicker(el) {
  let node = el;
  for (let i = 0; i < 6 && node; i++) {
    const cls = (node.className || "").toString();
    if (/date[-_]?range[-_]?picker|month[-_]?range[-_]?picker|date[-_]?picker/i.test(cls)) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

// 解析 YYYY.MM 或 YYYY-MM 为 {year, month}
function parseYearMonth(value) {
  const m = String(value || "").match(/(\d{4})\s*[\.\-/年]\s*(\d{1,2})/);
  if (!m) return null;
  return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
}

// 模拟点击元素
// v0.6.65 关键修复：旧实现「既 dispatch 了合成 click，又调用了原生 el.click()」，
// 一次调用实际派发了两个 click 事件。
// 实测后果：美团「添加」按钮每点一次新增两张卡片
//   —— 实习需要 3 条却出现 6 张、项目需要 4 条却出现 8 张、荣誉 4 条变 8 张；
// 复选框更糟：连点两下等于没点（toggleNoExperienceCheckbox 形同失效）。
// 现在保证「一次调用 = 一个 click 事件」：
//   优先原生 click()（语义最完整，能正确触发 a/button/label/checkbox 的默认行为）；
//   只有元素没有 click 方法时（如 SVG 图标按钮）才退回合成事件。
// 事件顺序也修正为浏览器真实顺序：pointerdown → mousedown → mouseup → pointerup → click。
function simulateClick(el) {
  if (!el) return false;
  // Chrome 安全限制：文件选择框必须由真实用户手势触发，
  // 脚本调用 input[type=file].click() 会抛出
  // "File chooser dialog can only be shown with a user activation"
  // 并导致扩展错误页红点。跳过文件上传框的自动点击，后续由用户手动上传。
  if (el.tagName === "INPUT" && el.type === "file") return false;
  // 有些站点把文件输入包在 label 内并监听 label click，也跳过
  let parent = el.closest && el.closest("label");
  if (parent && parent.querySelector('input[type="file"]')) return false;

  const opts = { bubbles: true, cancelable: true, view: window };
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  try { el.focus && el.focus(); } catch (e) {}
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  if (typeof el.click === "function") {
    el.click();
  } else {
    el.dispatchEvent(new MouseEvent("click", opts));
  }
  return true;
}

// 探测当前打开的日历弹窗（飞书/字节/通用）
function findCalendarPanel() {
  const all = Array.from(document.querySelectorAll("div, section, article, ul"));
  const candidates = all.filter((p) => {
    if (!isVisible(p)) return false;
    const rect = p.getBoundingClientRect();
    if (rect.width < 160 || rect.height < 160) return false;
    if (rect.width > window.innerWidth * 0.95 || rect.height > window.innerHeight * 0.95) return false;
    const style = getComputedStyle(p);
    if (style.position !== "fixed" && style.position !== "absolute") return false;
    const text = getText(p);
    return /(0?1月|0?2月|0?3月|0?4月|0?5月|0?6月|0?7月|0?8月|0?9月|10月|11月|12月|至今)/.test(text);
  });
  // 面积最小的最可能是刚弹出的面板
  candidates.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return ra.width * ra.height - rb.width * rb.height;
  });
  return candidates[0] || null;
}

// 在面板内找文本匹配 regex 的元素，优先短文本
function findTextEl(panel, regex) {
  const all = Array.from(panel.querySelectorAll("*"));
  for (const el of all) {
    const t = getText(el);
    if (t && regex.test(t) && t.length < 24) return el;
  }
  return all.find((el) => regex.test(getText(el))) || null;
}

function closeCalendarPanel() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

async function pickYearInPanel(panel, year) {
  const yearStr = String(year);
  // 先点当前显示的年份（通常是下拉触发器）
  const yearDisplay = findTextEl(panel, new RegExp(yearStr + "年?$"));
  if (yearDisplay) {
    simulateClick(yearDisplay);
    await new Promise((r) => setTimeout(r, 220));
    // 展开后再次点精确年份
    const exact = findTextEl(panel, new RegExp("^" + yearStr + "年?$"));
    if (exact && exact !== yearDisplay) {
      simulateClick(exact);
      await new Promise((r) => setTimeout(r, 220));
    }
    return true;
  }

  // 若当前显示不是目标年份，找左右箭头翻页
  const left = panel.querySelector("[class*='left'], [class*='prev'], [class*='arrow-left'], [class*='chevron-left']");
  const right = panel.querySelector("[class*='right'], [class*='next'], [class*='arrow-right'], [class*='chevron-right']");
  if (left || right) {
    const currentMatch = getText(panel).match(/(\d{4})年?/);
    let currentYear = currentMatch ? parseInt(currentMatch[1], 10) : new Date().getFullYear();
    let attempts = 0;
    while (currentYear !== year && attempts < 30) {
      if (currentYear > year && left) simulateClick(left);
      else if (currentYear < year && right) simulateClick(right);
      else break;
      await new Promise((r) => setTimeout(r, 180));
      const m = getText(panel).match(/(\d{4})年?/);
      if (m) currentYear = parseInt(m[1], 10);
      attempts++;
    }
    return currentYear === year;
  }
  return false;
}

async function pickMonthGrid(panel, month) {
  const monthStr = String(month).padStart(2, "0");
  const regex = new RegExp("^(?:" + monthStr + "月|" + month + "月|" + monthStr + "|" + month + ")$");
  const monthEl = findTextEl(panel, regex);
  if (monthEl) {
    simulateClick(monthEl);
    await new Promise((r) => setTimeout(r, 250));
    return true;
  }
  return false;
}

// 在飞书/字节系月份选择器里选年月
async function pickMonthInPanel(el, value, isEnd = false) {
  const parsed = parseYearMonth(value);
  const isPresent = /至今|现在|current|present/i.test(String(value));
  if (!parsed && !isPresent) return false;

  // 先点击输入框，尝试弹出日历
  simulateClick(el);
  await new Promise((r) => setTimeout(r, 400));

  // 某些组件允许直接输入；若成功则返回
  if (parsed) {
    const dateStr = `${parsed.year}-${String(parsed.month).padStart(2, "0")}`;
    if (fillReactInput(el, dateStr)) return true;
    if (typeLikeHuman(el, dateStr)) return true;
  }

  // 通用探测弹窗
  const panel = findCalendarPanel();
  if (!panel) {
    // 没探测到弹窗，再试一次直接输入
    if (parsed) typeLikeHuman(el, `${parsed.year}-${String(parsed.month).padStart(2, "0")}`);
    return verifyFill(el, value);
  }

  // 处理“至今”
  if (isPresent) {
    const presentBtn = findTextEl(panel, /至今|现在|Present|Current/);
    if (presentBtn) {
      simulateClick(presentBtn);
      await new Promise((r) => setTimeout(r, 250));
      closeCalendarPanel();
      return verifyFill(el, "至今");
    }
  }

  if (parsed) {
    const { year, month } = parsed;

    // 1) 选年份
    const yearOk = await pickYearInPanel(panel, year);
    if (!yearOk && !typeLikeHuman(el, `${year}-${String(month).padStart(2, "0")}`)) {
      // 年份搞不定，input 也写不进，放弃
    }

    // 2) 选月份
    await pickMonthGrid(panel, month);

    // 关闭面板，让组件回写值
    closeCalendarPanel();
    await new Promise((r) => setTimeout(r, 180));

    // 最终兜底：若失败再直接输入一次
    if (!verifyFill(el, value)) {
      typeLikeHuman(el, `${year}-${String(month).padStart(2, "0")}`);
    }
    return verifyFill(el, value);
  }

  closeCalendarPanel();
  return false;
}

function looksLikeDatePair(a, b) {
  // 飞书/字节月份范围选择器：两个 input 在共享容器内，直接判定为一对
  if (isMonthRangePicker(a) && isMonthRangePicker(b)) {
    const rectA = a.getBoundingClientRect();
    const rectB = b.getBoundingClientRect();
    const sameRow = Math.abs(rectA.top - rectB.top) < 40;
    const gap = rectB.left - rectA.right;
    if (sameRow && gap > 0 && gap < 320) return true;
  }

  const bothDate = isDateInput(a) && isDateInput(b);
  const bothText = isTextLikeInput(a) && isTextLikeInput(b);
  if (!bothDate && !bothText) return false;

  const labelA = getLabel(a);
  const labelB = getLabel(b);
  // v0.7.0（腾讯）：正则必须包含「日期」。
  // 腾讯教育/实习/项目/意向的起止时间是两个并排的 el-date-editor，两个框
  // placeholder 都只有「选择日期」三个字 —— 既不含「起止」也不含「时间」，
  // 于是配对判定失败，两个框都拿不到「（开始）/（结束）」后缀；
  // 到了 matchField 里 /开始|起始|入学/ 和 /结束|截止|毕业/ 全都匹配不上，
  // 8 个日期字段（教育2＋实习2＋项目2＋意向1＋备用1）集体填不进去。
  if (labelA && labelA === labelB && /起止|时间|年月|日期|期限|周期|duration|period|date/i.test(labelA)) {
    return true;
  }
  const parent = a.parentElement;
  if (parent && parent === b.parentElement) {
    const containerText = getText(parent);
    if (/起止|时间|年月|期限|周期/.test(containerText)) {
      const range = document.createRange();
      range.setStartAfter(a);
      range.setEndBefore(b);
      const div = document.createElement("div");
      div.appendChild(range.cloneContents());
      if (/[至\-~～]/.test(div.innerText || "")) return true;
    }
  }
  if (bothDate) {
    const rectA = a.getBoundingClientRect();
    const rectB = b.getBoundingClientRect();
    const sameRow = Math.abs(rectA.top - rectB.top) < 20;
    const gap = rectB.left - rectA.right;
    if (sameRow && gap > 0 && gap < 200) return true;
  }
  return false;
}

// v0.6.71：美团竞赛板块的「获奖大赛」是一个**纯 .mtd-cascader 容器** ——
// 实测它内部一个 input/textarea 都没有（probe-fix.cjs: inputs=[]），
// 而 scanFields 的选择器全是 input/textarea/select 系，所以竞赛字段从来没进过候选列表，
// 无论 matchField / fillFieldAsync 写得多对都填不上。
// 这里单独把「不含任何 input 的 mtd 下拉/级联容器」收进来，用容器本身代表这个字段。
// 只收「无 input」的是刻意为之：既有的 mtd-select 内部都有 input，仍走原来的分支，零回归。
const MTD_POPUP_CONTAINER =
  ".mtd-select-dropdown, .mtd-cascader-popper, .mtd-cascader-popup-wrapper, " +
  ".mtd-cascader-menus-wrapper, .mtd-cascader-menus, .mtd-popper, .mtd-picker-panel";
function collectInputlessMtdControls() {
  const list = Array.from(document.querySelectorAll(".mtd-cascader, .mtd-select")).filter(
    (el) =>
      isVisible(el) &&
      !el.querySelector("input, textarea") &&
      !(el.closest && el.closest(MTD_POPUP_CONTAINER))
  );
  // 嵌套去重：.mtd-cascader 外面可能还套着 .mtd-select，保留最外层代表
  return list.filter((el) => !list.some((o) => o !== el && o.contains(el)));
}

// ───────────────────────── 单选组（radio）支持 · v0.7.1（#185） ─────────────────────────
// 背景：插件此前**完全没有 radio 处理逻辑**（全文件搜 radio 零命中），
// 导致腾讯「性别*」这类必填单选一直空着 —— 而它既不涉隐私也不是站点专属选择，
// 按产品铁律必须由插件 100% 自动填完。
// 腾讯的坑：radio 是**裸 .el-radio**，外面没有 .el-radio-group 包裹，
// 所以不能只找标准组容器，必须按「直接父节点」把散装 radio 聚合成虚拟组。
const RADIO_ITEM_SEL = ".el-radio, .mtd-radio, .ant-radio-wrapper, .ud__radio, [role='radio']";
const RADIO_GROUP_SEL = ".el-radio-group, .mtd-radio-group, .ant-radio-group, [role='radiogroup']";
const RADIO_ATTR = "data-rfa-radio";

function collectRadioGroups() {
  const groups = [];
  const push = (box) => {
    if (!box || groups.indexOf(box) >= 0) return;
    if (!isVisible(box)) return;
    if (!box.querySelector(RADIO_ITEM_SEL) && !box.querySelector("input[type=radio]")) return;
    // ⚠️ 安全阀：scanFields 的候选去重保留「最外层」（被别人包含者会被删掉）。
    // 若这里塞进一个大容器，它会把内部所有 input/下拉整批挤出候选列表 —— 灾难性回归。
    // 因此只接受「除 radio 外不含任何其它可填元素」的紧凑容器；宁可漏一个组也不能吃掉别的字段。
    if (
      box.querySelector(
        "input:not([type=radio]), textarea, select, [contenteditable='true'], [class*='el-select'], " +
          "[class*='el-cascader'], [class*='ud__select__selector'], [class*='formily-select'], " +
          "[class*='semi-select'], [class*='mtd-select'], [role='combobox'], [role='textbox']"
      )
    )
      return;
    groups.push(box);
  };
  // ① 标准单选组容器
  Array.from(document.querySelectorAll(RADIO_GROUP_SEL)).forEach(push);
  // ② 裸 radio（腾讯就是这种）：按直接父节点聚合成虚拟组
  Array.from(document.querySelectorAll(RADIO_ITEM_SEL)).forEach((r) => {
    if (r.closest(RADIO_GROUP_SEL)) return;
    push(r.parentElement);
  });
  // ③ 原生 input[type=radio]（无组件库的老站点）：按 name 聚合到能装下全组的最近祖先
  const byName = {};
  Array.from(document.querySelectorAll("input[type=radio]")).forEach((r) => {
    if (r.closest(RADIO_ITEM_SEL) || r.closest(RADIO_GROUP_SEL)) return;
    const n = r.name || "";
    if (!n) return;
    (byName[n] = byName[n] || []).push(r);
  });
  Object.keys(byName).forEach((n) => {
    const list = byName[n];
    let anc = list[0].parentElement;
    let hop = 0;
    while (anc && hop < 6 && !list.every((x) => anc.contains(x))) {
      anc = anc.parentElement;
      hop++;
    }
    if (anc && list.every((x) => anc.contains(x))) push(anc);
  });
  // 父子都被收进来时保留最内层（最贴近 radio 的那一层）
  const tight = groups.filter((g) => !groups.some((o) => o !== g && g.contains(o)));
  tight.forEach((g) => {
    try {
      g.setAttribute(RADIO_ATTR, "1");
    } catch (e) {}
  });
  return tight;
}

// v0.7.1（#185）：Element UI 的「外语考试/等级」等字段用 .el-dropdown 实现（非 .el-select），
// scanFields 原本只认 input / el-select，导致考试类型永远填不进去。这里补一套识别 + 填充。
// 只收「像表单字段」的下拉：触发文字是「请选择」类占位符，或所在信息盒标题像字段
// （考试/等级/类型/类别/语种…）；排除右上角用户菜单（"你好，xxx"）、操作菜单（"添加"）等。
const DROPDOWN_ATTR = "data-rfa-dropdown";
function getDropdownLabel(dd) {
  // 行内标签通常在 dropdown 紧邻的前一个兄弟节点（如「外语考试/等级」），优先取它，
  // 避免把同信息盒里别的字段长文案（如项目名、证件说明）也带进来导致误判 / fallbackMap 路由错。
  let prev = dd.previousElementSibling;
  while (prev) {
    const t = (prev.innerText || prev.textContent || "").replace(/\s+/g, " ").trim();
    if (t && t.length <= 30 && !/^(请选择|未选择|选择|未填|请挑|请选)$/.test(t))
      return t.replace(/[*＊]+\s*$/, "").trim();
    prev = prev.previousElementSibling;
  }
  const box = dd.closest(".info_box") || dd.closest(".el-form-item") || dd.parentElement;
  if (box) {
    const full = (box.innerText || "").replace(/\s+/g, " ").trim();
    const self = (dd.innerText || "").replace(/\s+/g, " ").trim();
    const idx = self ? full.indexOf(self.slice(0, 8)) : -1;
    let lead = idx > 0 ? full.slice(0, idx) : full;
    lead = lead.replace(/(请选择|未选择|选择|未填|请挑|请选)\s*$/i, "").replace(/[*＊]+\s*$/, "").trim();
    if (lead && lead.length <= 30) return lead;
  }
  return "选项";
}
function collectDropdownFields() {
  const out = [];
  Array.from(document.querySelectorAll(".el-dropdown")).forEach((dd) => {
    if (!isVisible(dd)) return;
    const menu = dd.querySelector(".el-dropdown-menu");
    if (!menu) return;
    if (!menu.querySelectorAll(".el-dropdown-menu__item").length) return;
    const trig = dd.querySelector(".el-dropdown-link, .el-dropdown-selfdefine") || dd;
    const trigTxt = (trig.innerText || "").replace(/\s+/g, " ").trim();
    const box = dd.closest(".info_box") || dd.closest(".el-form-item") || dd.parentElement;
    const lbl = getDropdownLabel(dd);
    // 关键词闸门（基于干净标签）：只收真正的「选项类」字段（考试/等级/类型/类别/证件…）。
    // 排除纯导航/动作菜单（用户菜单「你好，xxx」、操作菜单等）。
    const boxHasTextField =
      box && box.querySelector("input[type=text], input:not([type]), textarea, input[type=search], input[type=email], input[type=tel]");
    const looksField =
      /考试|等级|类型|类别|来源|渠道|方式|状态|级别|语种|语言|证件/.test(lbl) ||
      (/请选择|未选择|选择|未填|请挑|请选/.test(trigTxt) && !boxHasTextField);
    if (!looksField) return;
    if (/退出|登录|账号|我的简历|应聘进度|设置|帮助|个人中心|你好/.test(lbl)) return;
    out.push(dd);
  });
  const tight = out.filter((g) => !out.some((o) => o !== g && g.contains(o)));
  tight.forEach((g) => {
    try {
      g.setAttribute(DROPDOWN_ATTR, "1");
      g.setAttribute("data-rfa-dropdown-label", getDropdownLabel(g));
    } catch (e) {}
  });
  return tight;
}
function isDropdownField(el) {
  return !!(el && el.getAttribute && el.getAttribute(DROPDOWN_ATTR) === "1");
}
function isDropdownEmpty(dd) {
  const trig = dd.querySelector(".el-dropdown-link, .el-dropdown-selfdefine") || dd;
  const t = (trig.innerText || "").replace(/\s+/g, " ").trim();
  if (/请选择|未选择|选择|未填|请挑|请选|^$/.test(t)) return true;
  return false; // 触发文字已是具体选项（如 CET-4）即视为已选
}

function isRadioGroup(el) {
  return !!(el && el.getAttribute && el.getAttribute(RADIO_ATTR) === "1");
}

// 取单选组里「已选中」的那一项（没选中返回 null）
function getCheckedRadio(box) {
  if (!box || !box.querySelector) return null;
  const hit = box.querySelector(
    ".el-radio.is-checked, .mtd-radio.is-checked, .ant-radio-wrapper-checked, [role='radio'][aria-checked='true']"
  );
  if (hit) return hit;
  const native = Array.from(box.querySelectorAll("input[type=radio]")).find((i) => i.checked);
  if (!native) return null;
  return native.closest(RADIO_ITEM_SEL) || native.parentElement || native;
}

// 列出单选组里的所有可选项，形如 [{text, value, el}]，直接喂给 findSelectOption 复用全部智能匹配
function listRadioOptions(box) {
  let items = Array.from(box.querySelectorAll(RADIO_ITEM_SEL));
  if (!items.length) {
    items = Array.from(box.querySelectorAll("input[type=radio]")).map((i) => i.closest("label") || i.parentElement || i);
  }
  return items
    .map((it) => {
      const labEl = it.querySelector(".el-radio__label, .mtd-radio-label, .ant-radio-label") || it;
      const text = (labEl.innerText || labEl.textContent || "").replace(/\s+/g, " ").trim();
      const inp = it.querySelector ? it.querySelector("input[type=radio]") : null;
      return { text, value: (inp && inp.value) || text, el: it };
    })
    .filter((o) => o.text);
}

// 合并「标准可填元素」+「无 input 的 mtd 容器」，并按文档顺序排好。
// 顺序很重要：scanFields 靠 candidates[i-1] 判断日期起止对，乱序会让日期配对错位。
function mergeInDocOrder(a, b) {
  if (!b.length) return a;
  const all = a.concat(b.filter((x) => !a.includes(x)));
  return all.sort((x, y) => {
    const p = x.compareDocumentPosition(y);
    if (p & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (p & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
}

// ── v0.8.17（#289 蔚来）：字段「是否必填」探测 ─────────────────────────────────
// 背景：代码里有 6 处在读 `field.required`（1784/1810/2442/2475/2511/8678 行），
// 但 scanFields 从来没给这个属性赋过值 —— 它恒为 undefined，全靠 `/\*/.test(label)`
// 这个兜底在撑。于是凡是**不用星号、改用红字提示**标必填的站点（蔚来飞书系写作
// 「家乡为必填」「期望工作地点为必填」），必填感知整个失效：
//   · 单选项下拉的「等一帧再确认」保护不触发
//   · 必填豁免（下面 FORBIDDEN_REQUIRED_RE）无从谈起
// 修法：统一探测，一次赋值，六处受益。
//
// 判定信号（任一命中即必填），只在**紧邻的 5 层祖先**内找，且容器文本 ≤ 120 字，
// 避免层数放太宽后一路找到 <form> 把整页字段全判成必填。
function detectRequired(el) {
  try {
    if (!el) return false;
    if (el.required === true) return true;
    const ar = el.getAttribute && el.getAttribute("aria-required");
    if (ar === "true") return true;
    let p = el;
    for (let k = 0; k < 5 && p && p.parentElement; k++) {
      p = p.parentElement;
      const txt = (p.innerText || "").trim();
      if (txt.length > 120) break; // 已经涨到板块级容器，再往上没有意义
      // ① 显式 class 标记：antd/element/飞书 都用 *-required / is-required
      if (p.querySelector("[class*='required'], [class*='Required']")) return true;
      // ② 红字校验提示：「XXX为必填」「此项为必填项」「必填项」「required」
      if (/为必填|必填项|不能为空|请填写|此项必填|is required/i.test(txt)) return true;
      // ③ 星号：只认**独立成节点**的星号（label 旁的小红星），
      //    不能直接对整段文本 /\*/ 匹配 —— 描述文本里出现 * 会误伤。
      const star = Array.prototype.some.call(
        p.querySelectorAll("i, em, span, label, sup"),
        (e) => e.children.length === 0 && /^[*＊]$/.test((e.textContent || "").trim())
      );
      if (star) return true;
    }
  } catch (e) {}
  return false;
}

// 扫描页面所有可填字段，并标记所属板块
function scanFields() {
  const sections = detectSections();
  // v0.6.46：只把「带 .ud__select__selector 的内部盒子」当作下拉候选（飞书自定义下拉的真实可点盒子）。
  // 不再抓裸 .ud__select 包装 div（蔚来「学校名称」即此类，内部是普通 input，应回落标准 input 分支正常填）。
  // 内部 <input role=combobox> 宽高常为 0 被 isVisible 判不可见，但 .ud__select__selector 盒子自身可见，故由它代表。
  const sel =
    "input, textarea, select, [contenteditable='true'], [role='textbox'], [role='combobox'], " +
    "[class*='ud__select__selector'], [class*='formily-select'], [class*='semi-select'], [class*='el-select'], " +
    // v0.8.18（2026-08-10）：京东校招 / 腾讯校招用 Ant Design，**其 ant-select 内部 input 不一定带 role=combobox**
    // （京东部分下拉的内部 input 不带该 role），导致仅靠 `role='combobox'` 收集时漏扫 → 这些下拉永远不填。
    // 直接把 .ant-select 容器纳入候选：去重会保留最外层 div，填充时回落内部 input，与现有分支一致，零回归。
    "[class*='ant-select'], " +
    // 2026-08-11（#PDD）：拼多多用自研 rocket-select 下拉（class 形如 rocket-select / rocket-select-selection-search-input），
    // 内部 input 无 role=combobox，且 .ant-select 匹配不到 → 下拉全漏扫。这里补上 rocket-select 容器。
    "[class*='rocket-select']";
  const raw0 = Array.from(document.querySelectorAll(sel)).filter((el) => isVisible(el) && isFillable(el));
  // v0.7.1（#185）：单选组以「组容器」为代表混进候选（腾讯性别等必填单选此前完全没被扫到）
  const raw = mergeInDocOrder(mergeInDocOrder(mergeInDocOrder(raw0, collectInputlessMtdControls()), collectRadioGroups()), collectDropdownFields());
  // 嵌套去重：下拉框用最外层 div 容器作代表，忽略其内部 <input role=combobox>/<input>，避免重复候选
  const candidates = raw.filter((el) => !raw.some((other) => other !== el && other.contains(el)));

  // ── v0.7.2：分段日期（年 / 月 拆成两个框）的起止配对 ──────────────────────────
  // getLabel 已把它们标成「就读时间（年）」「就读时间（月）」，但同一个标签下往往有两组：
  // 开始的年月 + 结束的年月（Moka 实测「就读时间」4 个框、「起止时间」8 个框）。
  // 这里按标签分批，遇到「年」就算一个新时点；一批正好两个时点，就给前者补「（开始）」、
  // 后者补「（结束）」，从而复用下面既有的日期配对规则，无需为分段日期另写匹配逻辑。
  const SEG_LABEL_RE = /^(.*)（([年月日])）$/;
  const segSuffix = new Map();
  {
    const segs = [];
    candidates.forEach((el, i) => {
      const m = (getLabel(el) || "").match(SEG_LABEL_RE);
      if (m) segs.push({ i: i, owner: m[1], seg: m[2] });
    });
    let k = 0;
    while (k < segs.length) {
      let j = k;
      while (j < segs.length && segs[j].owner === segs[k].owner) j++;
      const groups = [];
      segs.slice(k, j).forEach((it) => {
        if (it.seg === "年" || !groups.length) groups.push([it]);
        else groups[groups.length - 1].push(it);
      });
      // 同一个标签下可能有多段经历（Moka 的「起止时间」实测 8 个框 = 2 段经历 × 起止两组）。
      // 只要时点总数是偶数就按「偶数位=开始、奇数位=结束」两两配对；
      // 奇数（含单点的「毕业时间」「获奖时间」）一律不加后缀，避免把单点日期误判成起止。
      if (groups.length >= 2 && groups.length % 2 === 0) {
        groups.forEach((g, gi) => {
          const sfx = gi % 2 === 0 ? "（开始）" : "（结束）";
          g.forEach((it) => segSuffix.set(it.i, sfx));
        });
      }
      k = j;
    }
  }

  const fields = [];
  candidates.forEach((el, i) => {
    el.setAttribute(ATTR, String(i));
    let label = getLabel(el);
    const section = guessSection(el, sections);

    // 分段日期：把起止后缀插到「（年）」之前 →「就读时间（开始）（年）」，
    // 剥掉分段后缀后正好是既有规则认识的「就读时间（开始）」。
    const _sfx = segSuffix.get(i);
    if (_sfx) label = label.replace(SEG_LABEL_RE, "$1" + _sfx + "（$2）");

    const prev = candidates[i - 1];
    // 分段日期的相邻两框是「年 + 月」（同一时点的两半），不是起止对，
    // 若交给 looksLikeDatePair 会被错加「（开始）/（结束）」，把标签搞乱。
    const _isSeg = SEG_LABEL_RE.test(label) || (fields.length && SEG_LABEL_RE.test(fields[fields.length - 1].label || ""));
    if (!_isSeg && prev && looksLikeDatePair(prev, el)) {
      const prevField = fields[fields.length - 1];
      prevField.label = prevField.label ? prevField.label + "（开始）" : "开始时间";
      label = label ? label + "（结束）" : "结束时间";
    }

    fields.push({
      idx: String(i),
      label,
      type: el.tagName.toLowerCase() + (el.type ? ":" + el.type : ""),
      // role 必须带上：飞书自定义下拉的 type 是 input:search，只有 role="combobox" 才认得出来。
      // 之前漏了它，导致「无标签下拉框反推」分支永远不执行（学历/性别/城市一直没选）。
      role: (el.getAttribute && el.getAttribute("role")) || "",
      required: detectRequired(el), // v0.8.17（#289）：见 detectRequired 注释
      section,
    });
  });
  return fields;
}

// 兜底扫描：不依赖 scanFields 的 idx/fields，直接把所有可见的可填元素抓出来。
// 用来给未填字段标黄、生成未填面板，避免 scanFields 因时序/懒加载/动态渲染漏掉某些字段。
function getAllFillableEls() {
  const sel =
    "input, textarea, select, [contenteditable='true'], [role='textbox'], [role='combobox'], " +
    "[class*='ud__select__selector'], [class*='formily-select'], [class*='semi-select'], [class*='el-select'], " +
    // v0.8.18（2026-08-10）：京东校招 / 腾讯校招用 Ant Design，**其 ant-select 内部 input 不一定带 role=combobox**
    // （京东部分下拉的内部 input 不带该 role），导致仅靠 `role='combobox'` 收集时漏扫 → 这些下拉永远不填。
    // 直接把 .ant-select 容器纳入候选：去重会保留最外层 div，填充时回落内部 input，与现有分支一致，零回归。
    "[class*='ant-select'], " +
    // 2026-08-11（#PDD）：拼多多用自研 rocket-select 下拉（class 形如 rocket-select / rocket-select-selection-search-input），
    // 内部 input 无 role=combobox，且 .ant-select 匹配不到 → 下拉全漏扫。这里补上 rocket-select 容器。
    "[class*='rocket-select']";
  const raw0 = Array.from(document.querySelectorAll(sel)).filter((el) => isVisible(el) && isFillable(el));
  const raw = mergeInDocOrder(mergeInDocOrder(mergeInDocOrder(raw0, collectInputlessMtdControls()), collectRadioGroups()), collectDropdownFields());
  // 嵌套去重：保留最外层可填容器
  return raw.filter((el) => !raw.some((other) => other !== el && other.contains(el)));
}

function getEmptyFillableEls() {
  return getAllFillableEls().filter((el) => !isFieldFilled(el));
}

// 调试用：导出专用字段扫描（独立于 runAutofill 用的 scanFields，绝不改动填充逻辑）。
// 关键升级：
//  - 把飞书/字节系「div 下拉容器」（.ud__select__selector / .ud__select）也纳入候选，
//    原 scanFields 只认 <input>，导致教育经历等板块的「学历/学制/学习形式」下拉框被漏扫。
//  - 异步展开每个下拉框，读取真实选项文本（之前 options 永远为空，因为没展开过）。
//  - label 走 getLabel（已含父级 formily-item-label 识别），解决「无标签」问题。
//  - 嵌套去重：下拉框用最外层 div 容器作代表，忽略其内部的 <input role=combobox>，避免重复。
async function exportScanFields() {
  const sections = detectSections();
  const sel =
    "input, textarea, select, [contenteditable='true'], [role='textbox'], [role='combobox'], " +
    "[class*='ud__select__selector'], [class*='formily-select'], [class*='semi-select'], [class*='el-select'], " +
    "[class*='ant-select']";
  const raw = Array.from(document.querySelectorAll(sel)).filter((el) => isVisible(el));
  // 去重：去掉被其它候选元素嵌套包含的项，保留最外层代表
  const candidates = raw.filter((el) => !raw.some((other) => other !== el && other.contains(el)));

  const fields = [];
  let idx = 0;
  for (const el of candidates) {
    const tag = el.tagName.toLowerCase();
    const cls = (el.className || "").toString();
    const isCombo = isCombobox(el) || /ud__select/.test(cls) || /formily-select/.test(cls);
    const label = getLabel(el);
    const section = guessSection(el, sections);

    let options = [];
    if (isCombo) {
      try {
        if (tag === "select") {
          options = Array.from(el.options)
            .map((o) => (o.text || o.value || "").trim())
            .filter(Boolean);
        } else {
          options = await readComboboxOptions(el);
        }
      } catch (e) {
        options = [];
      }
    }

    fields.push({
      idx: String(idx++),
      label,
      type: tag + (el.type ? ":" + el.type : "") + (isCombo ? " [combobox]" : ""),
      role: (el.getAttribute && el.getAttribute("role")) || "",
      isCombobox: isCombo,
      required: detectRequired(el), // v0.8.17（#289）
      section,
      options,
      outerHTML: (el.outerHTML || "").slice(0, 600),
    });
  }
  return fields;
}

// 调试用：把页面上所有可填字段（含飞书 div 下拉框）的「标签 / 板块 / 类型 / 下拉选项 / 外层HTML」一次性抓取，
// 供开发者看清目标站真实结构，从而精准修复字段匹配。异步展开下拉框抓选项。
async function exportFields() {
  try {
    if (typeof showToast === "function") showToast("正在展开下拉框抓取选项，请稍候…", "wait");
  } catch (e) {}
  const sections = detectSections().map((s) => ({ name: s.name, title: s.text }));
  const fields = await exportScanFields();
  return { url: location.href, sections, fields, lastRunLog: RFA_LOG.slice() };
}

function getNativeValueSetter(el) {
  const tag = (el && el.tagName ? el.tagName : "").toLowerCase();
  // v0.8.13c（#285）：补 select 分支 + 非表单元素直接返回 null。
  // 旧版只认 input/textarea，遇到原生 <select> 或 antd 容器 <div> 会拿
  // HTMLInputElement 的 value setter 去 call 一个 select/div → 抛「Illegal invocation」，
  // 京东学历层次/城市等下拉整片填不进去（实测一次运行报 20 次 field-error）。
  let proto;
  if (tag === "textarea") proto = window.HTMLTextAreaElement.prototype;
  else if (tag === "select") proto = window.HTMLSelectElement.prototype;
  else if (tag === "input") proto = window.HTMLInputElement.prototype;
  else return null; // div/span 等容器：不要调原生 setter，交给上层 unwrap
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  return desc && desc.set;
}

function setNativeValue(el, value) {
  const setter = getNativeValueSetter(el);
  if (setter) setter.call(el, value);
  else el.value = value;
}

function dispatchInputEvent(el, data, inputType = "insertText") {
  const event = new InputEvent("input", {
    bubbles: true,
    cancelable: true,
    inputType,
    data,
    isComposing: false,
  });
  el.dispatchEvent(event);
  // 部分旧版 React 监听 propertychange/keydown，额外补一个通用 Event
  el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
}

function getFieldValue(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === "select") {
    return el.options[el.selectedIndex]?.text || el.value || "";
  }
  if (el.getAttribute("contenteditable") === "true" || el.getAttribute("role") === "textbox") {
    return el.innerText || "";
  }
  return el.value || "";
}

function verifyFill(el, expected) {
  const actual = getFieldValue(el);
  const str = String(expected || "");
  if (!str) return false;
  // 期望内容至少前 4 个字符要出现在实际值中
  return actual.includes(str.slice(0, Math.min(4, str.length)));
}

function fillContentEditable(el, value) {
  try {
    el.focus();
    el.innerText = "";
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.addRange(range);
    document.execCommand("insertText", false, value);
    dispatchInputEvent(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return verifyFill(el, value);
  } catch (e) {
    return false;
  }
}

// 方案 A：标准 React 受控输入填充
function fillReactInput(el, value) {
  try {
    const str = String(value);
    el.focus();
    el.dispatchEvent(new Event("focus", { bubbles: true }));
    // 清空旧值
    setNativeValue(el, "");
    dispatchInputEvent(el, "", "deleteContentBackward");
    // 写入新值
    setNativeValue(el, str);
    dispatchInputEvent(el, str, "insertText");
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return verifyFill(el, value);
  } catch (e) {
    return false;
  }
}

// 方案 B：模拟真人逐个字符输入，绕过强受控组件
function typeLikeHuman(el, value) {
  try {
    const str = String(value);
    el.focus();
    el.dispatchEvent(new Event("focus", { bubbles: true }));
    if (typeof el.select === "function") el.select();
    else if (el.setSelectionRange) el.setSelectionRange(0, el.value.length);

    // 清空
    setNativeValue(el, "");
    dispatchInputEvent(el, "", "deleteContentBackward");

    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      const keyCode = char.charCodeAt(0);
      const keyInit = { key: char, code: "Key" + char.toUpperCase(), keyCode, which: keyCode, bubbles: true };
      el.dispatchEvent(new KeyboardEvent("keydown", keyInit));
      el.dispatchEvent(new KeyboardEvent("keypress", { ...keyInit, charCode: keyCode }));

      const current = getFieldValue(el);
      setNativeValue(el, current + char);
      dispatchInputEvent(el, char, "insertText");

      el.dispatchEvent(new KeyboardEvent("keyup", keyInit));
    }

    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return verifyFill(el, value);
  } catch (e) {
    return false;
  }
}

// 方案 C：execCommand 兜底，部分 Lark 组件只认这个
function fillByExecCommand(el, value) {
  try {
    el.focus();
    if (typeof el.select === "function") el.select();
    else if (el.setSelectionRange) el.setSelectionRange(0, el.value.length);
    const ok = document.execCommand("insertText", false, String(value));
    dispatchInputEvent(el, String(value), "insertText");
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return ok && verifyFill(el, value);
  } catch (e) {
    return false;
  }
}

// 飞书/字节系自定义下拉（role=combobox 的输入框或 div），不是原生 <select>，
// 需要「点击打开选项面板 → 点击选项」才能填值。
// 注意：蔚来页面的普通文本框（姓名/学校/公司/描述等）也带 options="" 属性，
// 但那只是框架默认属性，不代表下拉框 —— 绝不能据此误判（v0.6.30 就因此全空）。
function isCombobox(el) {
  if (!el || !el.getAttribute) return false;
  if (el.getAttribute("role") === "combobox") return true;
  const cls = (el.className || "").toString();
  // v0.6.46：候选现在是带 .ud__select__selector 的内部盒子（裸 .ud__select 包装如「学校名称」不算下拉）。
  if (/ud__select__selector|formily-select|semi-select|select__selector/.test(cls)) return true;
  // v0.7.1（#185）：腾讯招聘用 Element UI，下拉容器是 .el-select；级联容器是 .el-cascader。
  // 二者内部都没有 role=combobox，必须显式放行，否则走纯文本分支整批漏填。
  if (/\bel-select\b|\bel-cascader\b/.test(cls)) return true;
  // v0.7.4（#210）：字节 / 阿里 / 网易等大量自研站用 Ant Design 的 Select（.ant-select）。
  // 其可点盒子是 .ant-select-selector，内部 input 带 aria-haspopup="listbox"。
  // 不识别 → 这些站的所有下拉整批漏填（字节黄字段主因）。
  if (/\bant-select\b|\bant-select-selector\b|\bant-cascader\b/.test(cls)) return true;
  // #561b（北森）：phoenix-select 输入型选择器，必须走 fillCombobox 的 phoenix 分支。
  if (/phoenix-select/.test(cls)) return true;
  if ((el.getAttribute && el.getAttribute("aria-haspopup")) === "listbox") return true;
  return false;
}

// v0.7.1（#185）：整个填充流程都是 `await sleep()` 驱动的。一旦标签页退到后台，
// Chrome 会对 setTimeout 做节流：隐藏后先是最小 1s 钳制，满 5 分钟触发 intensive throttling，
// 直接降到约 1 次/分钟。结果就是填充「假死」——实测卡在「国家/地区*」展开下拉那一步
// 8 分钟纹丝不动，日志停在 stage=opening，很容易被误判成插件死循环。
//
// 对策：隐藏时**干净地暂停**在两步之间，等页面重新可见再继续（visibilitychange 事件不受节流影响）。
// 比让它用 1 分钟一拍的节奏爬着跑要可预期得多——那种半节流状态下 UI 动画/防抖全部错位，
// 填出来的结果反而是错的。同时挂一个提示条，告诉用户为什么停住了。
let RFA_PAUSE_TIP = null;
function rfaShowPauseTip(show) {
  try {
    if (show) {
      if (RFA_PAUSE_TIP && RFA_PAUSE_TIP.isConnected) return;
      const d = document.createElement("div");
      d.textContent = "简历一键填充已暂停：请保持本标签页在最前台，切回后自动继续";
      d.style.cssText =
        "position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;" +
        "background:#ff8f1f;color:#fff;font:14px/1.6 -apple-system,PingFang SC,sans-serif;" +
        "padding:10px 18px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);pointer-events:none;";
      document.documentElement.appendChild(d);
      RFA_PAUSE_TIP = d;
    } else if (RFA_PAUSE_TIP) {
      try { RFA_PAUSE_TIP.remove(); } catch (e) {}
      RFA_PAUSE_TIP = null;
    }
  } catch (e) {}
}
function rfaWaitVisible() {
  if (typeof document === "undefined" || !document.hidden) return null;
  try { rfaLog({ act: "paused-hidden", why: "tab-backgrounded-timer-throttling" }); } catch (e) {}
  rfaShowPauseTip(true);
  return new Promise((res) => {
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      try { document.removeEventListener("visibilitychange", h); } catch (e) {}
      rfaShowPauseTip(false);
      try { rfaLog({ act: "resumed-visible" }); } catch (e) {}
      res();
    };
    const h = () => { if (!document.hidden) finish(); };
    document.addEventListener("visibilitychange", h);
    // v0.8.20（夜晚自治）：后台/锁屏标签 document.hidden=true 时不再无限挂起。
    // 原实现只在 visibilitychange→visible 时才 resolve，若显示器睡眠/窗口在后台，
    // 填充会永远卡在 sleep() 里——实名导致「用户睡后自治」整段失效。
    // 兜底：最多等 10s 后继续填（直接 DOM 操作不依赖动画，后台也能填）。
    setTimeout(finish, 10000);
  });
}
const sleep = (ms) => {
  const w = rfaWaitVisible();
  if (w) return w.then(() => new Promise((r) => setTimeout(r, ms)));
  return new Promise((r) => setTimeout(r, ms));
};

// v0.6.70：下拉框「值 → 选项」的语义兜底需要读档案（例如「证件号码」下拉其实要选证件类型，
// 而传进匹配器的却是身份证号）。这里在 runAutofill 开始时记一份当前档案的引用。
let CURRENT_PROFILE = null;

// v0.7.1（#185）：原来只往 document 派发一个 Escape。Element UI 2.x 的 el-select 是靠
// v-clickoutside（监听 document 的 mousedown/mouseup）和 input 上的 @keydown.esc 收起面板的，
// 只发 document 的 keydown 它根本收不到 → 下拉填完不关，页面上同时开着好几个面板，
// queryOptionEls() 于是把多个下拉的选项混在一起返回（实测「获奖类型」拿到 22 项 =
// 4 个城市 + 3 个获奖类型 + 15 种语言），匹配自然全错。
function closeCombobox(box) {
  try {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, which: 27, bubbles: true }));
  } catch (e) {}
  // Escape 打到当前下拉自己的 input 上
  try {
    const inp = box && box.querySelector && box.querySelector("input");
    if (inp) inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, which: 27, bubbles: true }));
  } catch (e) {}
  // 模拟一次「点击面板外部」：v-clickoutside 只认 document 上的 mousedown + mouseup 配对
  try {
    ["mousedown", "mouseup", "click"].forEach((t) => {
      document.body.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    });
  } catch (e) {}
}

// 当前可见的 Element UI 下拉面板集合（用来把选项查询限定在「刚打开的那一个」里）
function elVisibleDropdowns() {
  return Array.from(document.querySelectorAll(".el-select-dropdown")).filter((d) => {
    try {
      if (/el-select-dropdown--hidden|is-hidden/.test((d.className || "").toString())) return false;
      const st = getComputedStyle(d);
      if (st.display === "none" || st.visibility === "hidden") return false;
      return d.getBoundingClientRect().height > 0;
    } catch (e) {
      return false;
    }
  });
}

// 飞书/字节系下拉选项渲染在 body 下的 portal，统一选择器抓取可见选项
// v0.6.47 修复：补上飞书自定义下拉的真实选项节点 .ud__select__list__item（及其内部 __content）。
// 之前漏抓这几类，导致「展开不选中」——下拉明明展开了，脚本却一个选项都读不到，自然点不中。
// v0.7.1（#185）：增补腾讯 Element UI 的选项节点：.el-select-dropdown__item（下拉）/ .el-cascader-node（级联）。
// 关键：Element UI 会把【所有】下拉的选项都渲染进 DOM，未激活的用 display:none / --hidden 隐藏，
// 必须只保留「所属 .el-select-dropdown 可见」的那一组，否则会跨下拉误选到隐藏的同名选项。
function elSelectDropdownVisible(item) {
  const dd = item.closest && item.closest(".el-select-dropdown");
  if (!dd) return true; // 不属于 el 下拉的节点照常返回
  if (/el-select-dropdown--hidden|is-hidden/.test(dd.className || "")) return false;
  const st = getComputedStyle(dd);
  if (st.display === "none" || st.visibility === "hidden") return false;
  return dd.getBoundingClientRect().height > 0;
}
// scope：可选，限定只在某个下拉面板内取选项（腾讯多面板同时打开时必须限定，否则选项串台）
function queryOptionEls(scope) {
  if (scope && scope.querySelectorAll) {
    // v0.7.1（#185）：限域取选项。这里**不能**用 isVisible + O(n²) 去重：
    //  · isVisible 每个节点都 getComputedStyle + getBoundingClientRect，会反复强制同步布局；
    //  · .el-select-dropdown__item / .el-cascader-node 之间**天然不嵌套**（都是兄弟节点），
    //    去重纯属多余，却是 O(n²)。「期望工作城市」这种上百项的城市多选下拉，
    //    3 个 token × 每次上千次 contains()，直接把填充卡死（实测停在「期望工作城市」30s+ 不动）。
    // 改为：只用「无 display:none 内联样式 + 有尺寸」的廉价判据（Element UI 过滤选项就是打 display:none），
    // 且不做去重，O(n) 完成。
    const scopedRaw = scope.querySelectorAll(".el-select-dropdown__item, .el-cascader-node, .brick-select-option, [class*='brick-menu-item']");
    const scoped = [];
    for (let i = 0; i < scopedRaw.length; i++) {
      const n = scopedRaw[i];
      if (n.style && n.style.display === "none") continue;
      if (!n.offsetWidth && !n.offsetHeight && !n.getClientRects().length) continue;
      scoped.push(n);
    }
    if (scoped.length) return scoped;
  }
  const sel =
    '[role="option"], .brick-select-option, [class*="brick-menu-item"], .ud__select-dropdown__option, .ud__option, ' +
    '[class*="ud__select-option"], .ud__select-dropdown li, [class*="option-item"], ' +
    '.ud__select-dropdown [class*="option"], [class*="option-list"] > *, ' +
    '.ud__select__list__item, [class*="ud__select__list__item"], ' +
    '.ud__cascader__menu-item, [class*="cascader"] [class*="menu-item"], [class*="cascader__column"] [class*="item"], ' +
    // v0.6.55：飞书 Tree/Cascader 面板里的节点（所在地点/家乡四级级联）
    '.ud__tree__node__label, .ud__tree-node-label, [class*="tree__node__label"], [class*="tree-node-label"], ' +
    '.ud__cascader__menu__item__label, [class*="cascader"] [class*="label"], [class*="cascader__item__label"], ' +
    // v0.7.1（#185）：腾讯 Element UI 下拉 / 级联选项节点
    '.el-select-dropdown__item, [class*="el-select-dropdown__item"], ' +
    '.el-cascader-node, [class*="el-cascader__node"], [class*="el-cascader-menu"] [class*="item"], ' +
    // #561b（北森）：phoenix-select 远程搜索后渲染的选项（实测结构：li.phoenix-selectList__listItem）
    '.phoenix-select__option, [class*="phoenix-selectList"] [class*="listItem"], [class*="phoenix-selectList"] li, [class*="phoenix-select"] [class*="option"], [class*="phoenix"] [role="option"], [class*="phoenix-select__dropdown"] li, [class*="phoenix-select__dropdown"] [class*="item"]';
  const all = Array.from(document.querySelectorAll(sel)).filter(isVisible);
  // el 下拉：只保留「所属下拉面板可见」的那一组，排除其它被隐藏的同名选项
  const elFiltered = all.filter((el) => {
    if (!/\bel-select-dropdown__item\b/.test((el.className || "").toString())) return true;
    return elSelectDropdownVisible(el);
  });
  const useAll = elFiltered.length ? elFiltered : all;
  // 去重：优先保留可点击的 item 容器（.ud__select__list__item 包住内部 content），
  // 去掉被 item 包含的内部 content 子节点，避免重复点击 / 重复匹配。
  // v0.7.1（#185）：这一步是 O(n²)。省市区级联能匹配出上千个节点，n² 直接把页面算死
  // （实测填充停在「当前所处地」不动）。节点太多时改用「父节点是否也在集合里」的 O(n) 近似判断。
  if (useAll.length > 300) {
    const set = new Set(useAll);
    const fast = useAll.filter((el) => {
      let p = el.parentElement;
      for (let i = 0; i < 6 && p; i++) { if (set.has(p)) return false; p = p.parentElement; }
      return true;
    });
    return fast.length ? fast : useAll;
  }
  const dedup = useAll.filter((el) => !useAll.some((other) => other !== el && other.contains(el)));
  return dedup.length ? dedup : useAll;
}

// #561b（北森）：按文本找可见选项（phoenix-select 远程搜索后）。
// 遍历 queryOptionEls() 的结果，文本包含目标文字即命中；返回可点击节点。
function findVisibleOptionByText(text) {
  if (!text) return null;
  const t = String(text).trim();
  const opts = queryOptionEls();
  for (const o of opts) {
    const ot = getText(o).trim();
    if (ot && (ot === t || ot.indexOf(t) >= 0)) return o;
  }
  // 兜底：宽匹配（去掉多余空格/符号）
  const compact = t.replace(/[\s（(]/g, "");
  for (const o of opts) {
    const ot = getText(o).trim().replace(/[\s（(]/g, "");
    if (ot && ot.indexOf(compact) >= 0) return o;
  }
  return null;
}

// #561b（北森）：phoenix-date-picker 日历选择（出生日期/到岗时间/起止时间）。
// 实测日历结构：
//   .phoenix-date-picker / .phoenix-calendar（面板）
//   .phoenix-calendar-header        → 显示「2004年1月」
//   .phoenix-calendar-year-select   → 年份（点开选年）
//   .phoenix-calendar-month-select  → 月份（点开选月）
//   .phoenix-calendar-cell          → 日期格子（含 .phoenix-calendar-date 文字）
// 策略：解析目标 yyyy-mm(-dd) → 先切到目标年（点 year-select 翻年/选年）→ 目标月 → 点目标日。
async function pickPhoenixDate(box, phInput, value, label) {
  try {
    // 解析日期
    let ym = String(value).match(/(\d{4})\s*[-/年]\s*(\d{1,2})(?:\s*[-/月]\s*(\d{1,2}))?/);
    if (!ym) {
      // 至今：尝试勾「至今」复选框
      if (/至今|至\s*今|现在|在读|在职|present|now/i.test(String(value))) {
        const ok = tickToNowCheckbox(box || phInput);
        if (ok) return true;
      }
      return false;
    }
    const year = parseInt(ym[1], 10);
    const month = parseInt(ym[2], 10);
    const day = ym[3] ? parseInt(ym[3], 10) : 1;
    // 找日历面板（点开后挂 body 或 box 附近）
    const panelOf = () => {
      const cands = Array.from(document.querySelectorAll(".phoenix-calendar, .phoenix-date-picker"));
      for (const p of cands) {
        const r = p.getBoundingClientRect();
        const s = getComputedStyle(p);
        if (r.width > 100 && r.height > 100 && s.display !== "none" && s.visibility !== "hidden") return p;
      }
      return null;
    };
    let panel = panelOf();
    if (!panel) {
      // 还没点开？补点一次
      simulateClick(phInput);
      await sleep(500);
      panel = panelOf();
    }
    if (!panel) { rfaLog({ act: "phx-date-nopanel", label: String(label || "").slice(0, 14) }); return false; }
    // 工具：点元素
    const click = (el) => { try { simulateClick(el); } catch (e) {} };
    // 当前面板显示的「年份」「月份」（header 文本如「2004年1月」；year-select 文本「2004年」）
    const curYear = () => {
      const ys = panel.querySelector(".phoenix-calendar-year-select");
      if (ys) { const m = (ys.innerText || "").match(/(\d{4})/); if (m) return parseInt(m[1], 10); }
      const h = panel.querySelector(".phoenix-calendar-header");
      if (h) { const m = (h.innerText || "").match(/(\d{4})/); if (m) return parseInt(m[1], 10); }
      return new Date().getFullYear();
    };
    const curMonth = () => {
      const ms = panel.querySelector(".phoenix-calendar-month-select");
      if (ms) { const m = (ms.innerText || "").match(/(\d{1,2})月/); if (m) return parseInt(m[1], 10); }
      const h = panel.querySelector(".phoenix-calendar-header");
      if (h) { const m = (h.innerText || "").match(/(\d{1,2})月/); if (m) return parseInt(m[1], 10); }
      return new Date().getMonth() + 1;
    };
    // 翻年到目标年：点 year-select 打开年面板，找目标年点选；找不到则翻页
    const goYear = async (target) => {
      for (let guard = 0; guard < 12; guard++) {
        const cy = curYear();
        if (cy === target) return true;
        const ys = panel.querySelector(".phoenix-calendar-year-select");
        if (!ys) return false;
        click(ys); await sleep(400);
        // 年面板 cell（实测 .phoenix-calendar-year-panel-cell，文本纯年份）
        const yearItems = Array.from(panel.querySelectorAll(".phoenix-calendar-year-panel-cell"))
          .filter((el) => { const t = (el.innerText || "").trim(); return /^\d{4}$/.test(t) && el.getBoundingClientRect().width > 10; });
        const hit = yearItems.find((el) => (el.innerText || "").trim() === String(target));
        if (hit) { click(hit); await sleep(450); return true; }
        // 目标年不在当前页：找上一页/下一页箭头（年面板里通常有两个切换按钮）
        const arrows = Array.from(panel.querySelectorAll("[class*='year-panel'] [class*='arrow'], [class*='year-panel'] [class*='Arrow'], [class*='year-panel'] [class*='icon'], [class*='year-panel'] [class*='Icon'], [class*='year-panel'] button"))
          .filter((el) => el.getBoundingClientRect().width > 8);
        if (arrows.length >= 2) { click(arrows[1]); await sleep(400); continue; } // 第二个=下一年
        if (arrows.length >= 1) { click(arrows[0]); await sleep(400); continue; }
        // 无箭头：Esc 关掉年面板，从月视图的 header 箭头翻年（如有）
        try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, which: 27, bubbles: true })); } catch (e) {}
        await sleep(250);
        panel = panelOf() || panel;
        const hArrows = Array.from(panel.querySelectorAll("[class*='header'] [class*='arrow'], [class*='header'] [class*='Arrow'], [class*='header'] [class*='icon'], [class*='header'] button"))
          .filter((el) => el.getBoundingClientRect().width > 8);
        if (hArrows.length >= 2) { click(hArrows[1]); await sleep(400); continue; }
        return false;
      }
      return false;
    };
    // 翻月到目标月
    const goMonth = async (target) => {
      for (let guard = 0; guard < 8; guard++) {
        const cm = curMonth();
        if (cm === target) return true;
        const ms = panel.querySelector(".phoenix-calendar-month-select");
        if (!ms) return false;
        click(ms); await sleep(400);
        // 月面板 cell（实测 .phoenix-calendar-month-panel-cell，文本「3月」）
        const monthItems = Array.from(panel.querySelectorAll(".phoenix-calendar-month-panel-cell"))
          .filter((el) => { const t = (el.innerText || "").trim(); return /^\d{1,2}月$/.test(t) && el.getBoundingClientRect().width > 10; });
        const hit = monthItems.find((el) => (el.innerText || "").trim() === target + "月");
        if (hit) { click(hit); await sleep(450); return true; }
        try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, which: 27, bubbles: true })); } catch (e) {}
        await sleep(250);
        return false;
      }
      return false;
    };
    // 1) 翻年
    if (!(await goYear(year))) { rfaLog({ act: "phx-date-yearfail", label: String(label || "").slice(0, 14), year }); closeCombobox(box); return false; }
    // 2) 翻月
    if (!(await goMonth(month))) { rfaLog({ act: "phx-date-monthfail", label: String(label || "").slice(0, 14), month }); closeCombobox(box); return false; }
    // 2.5) #569 安全阀：翻年翻月后必须确认 header 真的是目标年月，再点日。
    //      否则翻页失败会停在本年（如 2026）只选对月，把「2019-09」错填成「2026-09」——
    //      违反铁律「宁愿不填错」。header 不对就放弃，绝不让错误日期落进输入框。
    panel = panelOf() || panel;
    const hdrTxt = (panel.querySelector(".phoenix-calendar-header") || {}).innerText || "";
    const hdrYm = hdrTxt.match(/(\d{4})\s*年\s*(\d{1,2})月/);
    if (!hdrYm || parseInt(hdrYm[1], 10) !== year || parseInt(hdrYm[2], 10) !== month) {
      rfaLog({ act: "phx-date-badnav", label: String(label || "").slice(0, 14), year, month, header: hdrTxt.slice(0, 16) });
      // 清掉可能已写入的错误值（点年/点月可能已把错误日期提交进输入框）
      try { setNativeValue(phInput, ""); dispatchInputEvent(phInput, ""); } catch (e) {}
      closeCombobox(box);
      return false;
    }
    // 3) 点目标日（面板可能因翻年翻月重渲染，重新取）
    panel = panelOf() || panel;
    const dayCells = Array.from(panel.querySelectorAll(".phoenix-calendar-cell")).filter((el) => el.getBoundingClientRect().width > 10);
    const dayHit = dayCells.find((el) => (el.innerText || "").trim() === String(day));
    if (!dayHit) {
      // 日可能被「今天」覆盖或面板没刷出来，兜底直接找文字=day 的 cell
      const all = Array.from(panel.querySelectorAll("[class*='calendar'] td, [class*='calendar'] [class*='cell']"));
      const hit2 = all.find((el) => (el.innerText || "").trim() === String(day) && el.getBoundingClientRect().width > 10);
      if (!hit2) { closeCombobox(box); return false; }
      click(hit2); await sleep(350);
    } else {
      click(dayHit); await sleep(350);
    }
    // 4) 校验：box 文本不再是「请选择」
    const after = (box.innerText || "").trim().replace(/\s+/g, " ");
    const ok = after.indexOf(String(year)) >= 0 && after !== "请选择";
    rfaLog({ act: "phx-date-ok", label: String(label || "").slice(0, 14), val: String(value).slice(0, 14), ok });
    return ok;
  } catch (e) {
    rfaLog({ act: "phx-date-err", label: String(label || "").slice(0, 14), err: String(e).slice(0, 80) });
    return false;
  }
}

// 取选项真正可点击的节点：优先 .ud__select__list__item 容器，点击它才会触发选中。
function optionClickTarget(o) {
  try {
    if (o.closest) {
      const item = o.closest(".ud__select__list__item");
      if (item) return item;
    }
  } catch (e) {}
  return o;
}

// 触发展开：定位真正可点的 .ud__select__selector 盒子，并多点内容区/箭头/内部 input，再补 ArrowDown 键盘事件。
// v0.6.46：readonly 下拉（性别/学历/学历类型/语言/精通程度/社交平台等）在 v0.6.45 只点盒子本身不展开，
// 真实可点区域往往是 .ud__select__selector__content / __arrow / __placeholder，或聚焦内部 input 后按 ArrowDown（ARIA combobox 标准）。
async function openCombobox(box) {
  // 百度校招 brick-select：纯点击下拉，内部无 input，直接点 .brick-select-selection 展开
  if (/\bbrick-select\b/.test((box.className || "").toString())) {
    const sel = box.querySelector(".brick-select-selection") || box;
    for (const ev of ["pointerdown", "mousedown", "mouseup", "click"]) {
      try { sel.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true })); } catch (e) {}
    }
    try { if (sel.click) sel.click(); } catch (e) {}
    return true;
  }
  let base = box;
  if (box.closest) {
    const sel = box.closest(".ud__select__selector");
    if (sel) base = sel;
  }
  const targets = [base];
  // 真实可点子区域
  base
    .querySelectorAll(".ud__select__selector__content, .ud__select__selector__arrow, .ud__select__selector__placeholder")
    .forEach((n) => targets.push(n));
  // v0.7.1（#185）：腾讯 Element UI el-select 的可点区域是 .el-select__selection / .el-input__inner /
  // .el-select__caret 等，内部 input 带 readonly 但点击它仍能展开下拉。
  if (/\bel-select\b/.test((base.className || "").toString())) {
    base
      .querySelectorAll(".el-select__selection, .el-input__inner, .el-select__caret, .el-select__wrapper, .el-select__input")
      .forEach((n) => targets.push(n));
  }
  const innerInput = base.querySelector("input");
  if (innerInput) targets.push(innerInput);

  // 点击前的基线：用于判断这次点击是否真的「新开」了一个面板。
  // v0.7.1（#185）：这里**不能**用 queryOptionEls() 计数——它的选择器很宽（含 [class*="option"]、
  // [class*="cascader"] [class*="item"]），碰上省市区级联能匹配到上千节点，而内部去重是 O(n²)，
  // 在 12 次轮询 × 多个候选点击区里反复跑，直接把整个填充卡死（实测停在「当前所处地」不动）。
  // el-select/el-cascader 改用「可见面板数」这种廉价判据，其余站点才退回选项计数。
  const isElBox = /\bel-select\b|\bel-cascader\b/.test((base.className || "").toString());
  const cheapCount = () => (isElBox ? elVisibleDropdowns().length + document.querySelectorAll(".el-cascader-panel:not([style*='display: none'])").length : queryOptionEls().length);
  const baseOptCount = cheapCount();

  for (const t of targets) {
    try { if (t.focus) t.focus(); } catch (e) {}
    // 飞书/字节 React 组件对 pointerdown / mousedown 敏感，多事件都触发一遍提高展开成功率
    try { t.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true })); } catch (e) {}
    try { t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); } catch (e) {}
    try { t.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true })); } catch (e) {}
    try { t.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); } catch (e) {}
    try { if (t.click) t.click(); } catch (e) {}
    // ARIA combobox 标准展开方式：聚焦后按方向键展开选项面板
    try { t.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); } catch (e) {}
    let appeared = false;
    for (let i = 0; i < 12; i++) {
      await sleep(100);
      // v0.7.1（#185）：不能只看「页面上有没有选项」——别的下拉可能还开着，
      // 那样会在本框其实没展开的情况下误判成功。要求比点击前**变多**才算展开。
      if (cheapCount() > baseOptCount) { appeared = true; break; }
    }
    if (appeared) return true;
  }
  return false;
}

// 把 value 填进自定义下拉框（飞书/字节系：点击展开 → 选选项）。
//  - 只读框（性别/学历/学历类型/语言/精通程度/社交平台等）：展开后从全部选项里挑
//  - 可输入过滤框（国籍/所在地点/家乡/期望城市）：输入过滤后再点第一个匹配，最稳
//  - 多选框（期望工作地点）：按分隔符拆分逐个勾选，面板保持展开
// v0.8.2（#266）：剔除下拉里的「空态占位」。
// antd / brick 等组件库在远程检索无结果或加载中时，会往列表里塞一个同样带 role="option"
// 的占位节点（「暂无数据」「加载中」）。它被当成候选点下去等于什么都没选，
// 还会把面板关掉，导致后面的重试全部落空。
const REMOTE_EMPTY_RE = /^\s*(暂无数据|暂无选项|无匹配|无数据|无结果|没有找到|没有数据|not\s*found|no\s*data|no\s*results?|loading|加载中|搜索中)\s*[.。…]*\s*$/i;
function dropRemoteEmptyState(list) {
  if (!list || !list.length) return [];
  const real = list.filter((o) => !REMOTE_EMPTY_RE.test(getText(o).trim()));
  return real;
}

async function fillCombobox(el, rawValue, field) {
  const valStr = String(rawValue || "").trim();
  if (!valStr) return false;

  // 已选中的自动完成框（如学校名称）无需重复操作，避免误改
  if (!/ud__select__selector-multiple/.test((el.className || "").toString()) &&
      el.value && el.value.trim() && el.value.trim() === valStr) {
    return true;
  }

  // 解析真正可点的盒子与属性
  let box = el;
  if (el.getAttribute && el.getAttribute("role") === "combobox") {
    // v0.8.2（#266）：antd 的可点盒子是 .ant-select，role=combobox 挂在里面那个宽度近 0 的
    // 搜索 input 上。原来这里只认飞书的 ud__select__*，antd 站点会退化成 box=input 本身，
    // openCombobox 点在 1px 的输入框上，弹层时开时不开（百度学校/专业时好时坏的根因之一）。
    box = el.closest(".ud__select__selector") || el.closest(".ud__select") || el.closest(".ant-select") || el.closest(".brick-select") || el;
  } else if (el.className && /ud__select/.test(el.className)) {
    // v0.8.13（字节修复）：期望工作地点等**可搜索多选下拉**扫进来的是内部搜索 input
    //（class 含 ud__select__selector__search__input，非 readonly），这里必须向上取 .ud__select__selector 容器，
    // 否则 box=input 本身，openCombobox 点的是 1px 搜索框、multiple/tags 上下文全丢。
    box = el.closest && el.closest(".ud__select__selector") ? el.closest(".ud__select__selector") : (el.querySelector(".ud__select__selector") || el);
  }
  const boxCls = (box.className || "").toString();
  const isBrick = /\bbrick-select\b/.test(boxCls);
  const isElSel = /\bel-select\b/.test(boxCls);
  // v0.7.6（#254）：label 必须在这里就声明。
  // 【踩坑记录】原来 `const label` 写在下面第 1562 行，但第 1535 行的「至多三个/多选」兜底
  // 判断已经引用了 label —— 触发 TDZ（暂时性死区）异常 "Cannot access 'label' before
  // initialization"。因为该行写成 `!multiple && test(label)`，多选下拉会因短路求值躲过，
  // 单选下拉则必崩：腾讯的「学历/成绩排名/获奖类型/国家地区/参加面试城市」5 类字段
  // 全部因此填不进去（实测一次运行报 19 次 field-error）。
  const label = (field && field.label) || "";
  // v0.7.1（#185）：腾讯用的是 Element UI **2.x（Vue2）**，多选下拉的根节点类名就是光秃秃的 `el-select`，
  // 既没有 el-select--multiple 也没有 is-multiple（那是 Element Plus 才有的）。
  // 2.x 的唯一可靠特征是内部会渲染一个 `.el-select__tags` 容器来放已选标签。
  // 之前漏了这条 → 17 个下拉一个都没识别成多选 → 「期望工作城市/开发语言」只当单选填了 1 项。
  // 注意必须是 let：下一行的兜底判断会给它重新赋值（原来写 const，改 label 之后会立刻
  // 报 "Assignment to constant variable"，属同一处的连环 bug）。
  let multiple =
    /ud__select__selector-multiple/.test(boxCls) ||
    /\bel-select--multiple\b|\bis-multiple\b/.test(boxCls) ||
    !!(box.querySelector && box.querySelector(".el-select__tags")) ||
    !!(box.getAttribute && box.getAttribute("multiple") !== null) ||
    !!(box.querySelector && box.querySelector("input[multiple]"));
  // 兜底：标签明确「至多三个 / 多选」的必为多选（Element UI 2.x 未选中时 .el-select__tags 可能尚未渲染）
  // v0.8.13（字节修复）：补上飞书/字节系叫法「期望工作地点 / 意向工作地点」——之前只有「期望工作城市」，
  //   字节社招「期望工作地点」被当单选 → "北京、上海" 整个串打进搜索框 → 匹配不上任何城市（真机 input 值=「北京、上海」、无选中项铁证）。
  if (!multiple && /（至多三个）|至多三个|可多选|多选|多个|开发语言|编程语言|technical\s*skills?|tech\s*stack|期望工作城市|期望.{0,4}工作地点|意向.{0,4}工作地点|掌握.*语言/i.test(label)) multiple = true;
  // v0.7.1（#185）：el-select 无论 filterable 与否，选项都靠「点选项」选中，强制走只读（按文本点选）分支；
  // 否则会误把只读 input 当可输入过滤框去 setNativeValue，非 filterable 的下拉根本不吃文本过滤。
  const readonly = isElSel
    ? true
    : (el.getAttribute && el.getAttribute("readonly") !== null) || /readOnly/.test(boxCls) || isBrick;

  // #561b（2026-08-26 北森攻破）：北森系统（zhiye.com）的 phoenix-select 是**输入搜索型选择器**
  // （class 含 phoenix-select--editable，内部 input 非 readonly），不是点击弹出预渲染选项的下拉。
  // 实测（CDP 键盘/execCommand 双验证）：
  //   · 点开不弹任何选项层，必须**输入文字**才触发远程搜索渲染选项；
  //   · 且 React 受控组件**拒绝 setNativeValue/合成 input 事件**（input.value 打完仍空串），
  //     只有 document.execCommand('insertText') 能触发其内部 state 更新（选项层出现「英语」）。
  //   · 但**日期类下拉**（出生日期/到岗时间/起止时间）点开弹的是 **phoenix-date-picker 日历面板**
  //     （phoenix-calendar-header/year-select/month-select/cell），输入文字无效，必须翻日历点选。
  // 适配：先判断值是否为日期 → 是则走日历选择；否则走文本搜索选择。
  const boxClsL = boxCls.toLowerCase();
  if (/phoenix-select/.test(boxClsL) || /zhiye\.com/i.test(location.hostname)) {
    const phInput = box.querySelector("input.phoenix-select__input, input") || box;
    // 元素可能在视口外（北森表单很长），必须先滚到可见再操作
    try { phInput.scrollIntoView({ block: "center" }); } catch (e) {}
    await sleep(300);
    // 点开（完整事件序列）
    simulateClick(phInput);
    await sleep(400);
    // ── 日期值：走 phoenix 日历选择 ──────────────────────────────────────────
    const isDateVal = /^\s*\d{4}[-/年]\s*\d{1,2}([-/月]\s*\d{1,2})?/.test(String(valStr)) ||
                      /至今|至\s*今|现在|在读|在职|present|now/i.test(String(valStr));
    if (isDateVal) {
      const dOk = await pickPhoenixDate(box, phInput, String(valStr), label);
      rfaLog({ act: "phoenix-date", label: label.slice(0, 16), val: String(valStr).slice(0, 16), ok: dOk });
      closeCombobox(box);
      return dOk;
    }
    try { phInput.focus(); } catch (e) {}
    // #568（2026-08-26 实测修正）：phoenix-select 分两类——
    //   · 点击型（到岗时间"一周内/一个月内…"、掌握程度"入门/熟练/精通/母语"等）：
    //     点开后**选项直接预渲染**，无需输入；直接文本匹配点选即可。
    //   · 搜索型（语言类型"英语"等）：点开后无选项，必须输入文字才触发远程搜索。
    // 顺序：先查预渲染选项（点击型），没有再输入搜索（搜索型）。绝不能先输入——
    // 对点击型先输入会把已渲染的选项过滤掉，且值不在选项里时 execCommand 无效。
    // 多值（phoenix-select--multi，如期望工作城市"北京、上海"）：逐段输入点选，面板保持展开。
    const isMulti = /phoenix-select--multi/.test(boxClsL);
    const parts = String(valStr).split(/[、,，;；\s]+/).filter(Boolean);
    let okAll = true;
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi];
      let optEl = findVisibleOptionByText(part);
      if (!optEl) {
        // 搜索型：execCommand 输入（React 受控组件唯一认的输入方式）
        try {
          fillByExecCommand(phInput, part);
        } catch (e) { okAll = false; break; }
        // 等远程选项渲染（最多 ~4s）
        for (let w = 0; w < 10; w++) {
          await sleep(400);
          optEl = findVisibleOptionByText(part);
          if (optEl) break;
        }
      }
      if (!optEl) {
        // 值不在选项里（如档案"流利" vs 选项"入门/熟练/精通/母语"；日期 vs "一周内"）：
        // 铁律「宁愿不填错」——不硬选，留空由用户手动确认。
        rfaLog({ act: "phoenix-nomatch", label: label.slice(0, 16), val: String(part).slice(0, 16) });
        okAll = false;
        break;
      }
      try { optEl.scrollIntoView({ block: "center" }); } catch (e) {}
      try { simulateClick(optEl); } catch (e) {}
      await sleep(350);
      // 多选：面板保持展开，清空搜索词再选下一段；点选后 input 可能残留搜索文字，需清掉
      if (pi < parts.length - 1) {
        if (isMulti) {
          try { setNativeValue(phInput, ""); dispatchInputEvent(phInput, ""); } catch (e) {}
          await sleep(200);
          // 多选点选后面板可能收起（若收起则重新点开）
          const stillOpen = !!findVisibleOptionByText("请选择") || !!document.querySelector(".phoenix-selectList");
          if (!stillOpen) {
            simulateClick(phInput);
            await sleep(300);
          }
        } else {
          closeCombobox(box);
          simulateClick(phInput);
          await sleep(300);
        }
      }
    }
    closeCombobox(box);
    // 校验：输入框已带所选值（值不再是"请选择"占位）即成功
    const curVal = (box.innerText || "").trim().replace(/\s+/g, " ");
    const okPhoenix = okAll && (curVal.indexOf(String(valStr)) >= 0 || (phInput.value || "").indexOf(String(valStr)) >= 0 || (isMulti && parts.every(function (p) { return curVal.indexOf(p) >= 0; })));
    rfaLog({ act: "phoenix-fill", label: label.slice(0, 16), val: String(valStr).slice(0, 16), ok: okPhoenix, multi: isMulti, parts: parts.length });
    return okPhoenix;
  }

  // v0.7.1（#185）：开之前先把别的面板关干净，并记录「打开前已可见的面板」，
  // 开完之后用差集拿到「这次新开的那个面板」，后续所有取选项都锁定在它里面。
  let elScope = null;
  let beforeDrops = [];
  try { if (window.__RFA_CUR__) { window.__RFA_CUR__.stage = "pre-close"; window.__RFA_CUR__.st = Date.now(); } } catch (e) {}
  if (isElSel) {
    closeCombobox();
    await sleep(150);
    beforeDrops = elVisibleDropdowns();
  }
  try { if (window.__RFA_CUR__) { window.__RFA_CUR__.stage = "opening"; window.__RFA_CUR__.st = Date.now(); } } catch (e) {}
  if (!(await openCombobox(box))) { closeCombobox(box); return false; }
  // 百度校招 brick-select：展开后浮层挂在 body（.brick-popup-visible），锁定到含选项的那个
  if (isBrick) {
    // 【坑】页面上常驻 8+ 个 .brick-popup-visible —— 都是预渲染的隐藏浮层，
    // 光按类名取会锁定到「别的下拉」的面板，点进去要么无匹配要么串值。
    // 必须按「几何真实可见 + 内部有可见选项 + 离触发器最近」三重判定。
    const _visible = (e) => {
      if (!e) return false;
      try {
        const s = getComputedStyle(e), r = e.getBoundingClientRect();
        return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0" && r.width > 0 && r.height > 0;
      } catch (err) { return false; }
    };
    let pop = null;
    const tRect = (() => { try { return box.getBoundingClientRect(); } catch (e) { return { bottom: 0, left: 0 }; } })();
    for (let _p = 0; _p < 20 && !pop; _p++) {
      const pops = Array.from(document.querySelectorAll(".brick-popup-visible")).filter(
        (p) => _visible(p) && Array.from(p.querySelectorAll(".brick-select-option")).some(_visible)
      );
      if (pops.length) {
        // 离触发器垂直距离最近的那个浮层才是本次展开的
        pops.sort((a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return (Math.abs(ra.top - tRect.bottom) + Math.abs(ra.left - tRect.left))
               - (Math.abs(rb.top - tRect.bottom) + Math.abs(rb.left - tRect.left));
        });
        pop = pops[0];
      }
      if (!pop) await sleep(150);
    }
    elScope = pop;
    rfaLog({ act: "brick-scope", label: (field && field.label) || "", scoped: !!pop });
  }
  try { if (window.__RFA_CUR__) { window.__RFA_CUR__.stage = "opened"; window.__RFA_CUR__.st = Date.now(); } } catch (e) {}
  if (isElSel) {
    const afterDrops = elVisibleDropdowns();
    const fresh = afterDrops.filter((d) => beforeDrops.indexOf(d) < 0);
    elScope = fresh[fresh.length - 1] || afterDrops[afterDrops.length - 1] || null;
    rfaLog({ act: "el-select-scope", label: (field && field.label) || "", before: beforeDrops.length, after: afterDrops.length, scoped: !!elScope });
  }

  // （label 已在函数开头声明，见上方 #254 注释）
  const tokens = multiple
    ? valStr.split(/[,，/、;；]+/).map((s) => s.trim()).filter(Boolean)
    : [valStr];

  if (!readonly) {
    const input = box.querySelector("input") || el;
    let pickedAny = false;
    for (const tok of tokens) {
      setNativeValue(input, tok);
      dispatchInputEvent(input, tok);
      await sleep(260);
      let opts = dropRemoteEmptyState(queryOptionEls(elScope));
      // v0.8.2（#266）：远程搜索型下拉——选项来自后端接口，260ms 根本等不到回包。
      // 百度 talent.baidu.com 的「学校 / 专业」就是 antd Select + 远程检索：
      // 点开时列表为空（只有「暂无数据」占位），敲字后要等一次网络往返才渲染出 role=option。
      // 旧逻辑等 260ms 拿不到就把输入清空、再取一次（依然空）→ picked=null → 一个字都没落下，
      // 却因为分支末尾无条件 return true 被记成「已填」。
      // 表现就是：跑完两轮、日志显示成功，这两格却始终红着（ant-select-status-error）。
      if (!opts.length) {
        for (let _w = 0; _w < 12 && !opts.length; _w++) {
          await sleep(250); // 最多再等约 3s
          opts = dropRemoteEmptyState(queryOptionEls(elScope));
        }
      }
      // v0.8.2：整串搜不到时退到「前 4 字 / 前 2 字」再搜。
      // 学校库里常见「中国传媒大学」能搜到，但专业库里「广播电视编导」可能登记为
      // 「广播电视编导（电视编辑方向）」之类，整串精确匹配不到、前缀却能召回。
      if (!opts.length && tok.length > 4) {
        for (const term of [tok.slice(0, 4), tok.slice(0, 2)]) {
          setNativeValue(input, term);
          dispatchInputEvent(input, term);
          for (let _w = 0; _w < 10 && !opts.length; _w++) {
            await sleep(250);
            opts = dropRemoteEmptyState(queryOptionEls(elScope));
          }
          if (opts.length) break;
        }
      }
      if (!opts.length) {
        // 输入过滤没出选项，退化为清空后从全部里选
        setNativeValue(input, "");
        dispatchInputEvent(input, "");
        await sleep(200);
        opts = dropRemoteEmptyState(queryOptionEls(elScope));
      }
      const optObjs = opts.map((o) => ({ text: getText(o), value: getText(o) }));
      // v0.8.41（#378）：证书类下拉「无精确匹配→瞎选首项」会把 CS 候选的真证书全填成
      // 下拉首项（字节实测 4 张证书全选「教师资格证」）。修正：证书类优先选「其他/其它/other」，
      // 没有就留空——绝不填错证书类型（A3：只填能正确映射的字段）。其余字段维持原 opts[0] 兜底。
      const picked =
        findSelectOption(optObjs, tok, label) ||
        (/证书|资格|cert/i.test(label) && opts.length > 1
          ? (() => {
              const _other = opts.find((o) => /其他|其它|other/i.test(getText(o)));
              return _other ? { text: getText(_other) } : null;
            })()
          : opts[0]
            ? { text: getText(opts[0]) }
            : null);
      if (picked) {
        const target =
          opts.find((o) => getText(o) === picked.text) ||
          opts.find((o) => getText(o).includes(picked.text)) ||
          opts[0];
        if (target) {
          try { simulateClick(optionClickTarget(target)); } catch (e) {}
          await sleep(220);
          pickedAny = true;
          rfaLog({ act: "search-select-pick", label: label, tok: tok, picked: getText(target).trim().slice(0, 20), opts: opts.length });
        }
      } else {
        rfaLog({ act: "search-select-miss", label: label, tok: tok, opts: opts.length });
      }
      if (multiple) { setNativeValue(input, ""); dispatchInputEvent(input, ""); await sleep(160); }
    }
    // v0.8.2：一个选项都没点中时，把残留的搜索词清掉——否则失焦后
    // 组件把它当"未提交的检索词"丢弃，DOM 上留下半截脏文本，干扰下一轮校验。
    if (!pickedAny) { try { setNativeValue(input, ""); dispatchInputEvent(input, ""); } catch (e) {} }
    closeCombobox(box);
    return pickedAny;
  }

  // 只读框：从全部选项里挑（多选则逐个点，面板保持展开）
  await sleep(400); // 等首帧选项渲染：城市多选下拉几百项需时间，否则 queryOptionEls 拿到空→漏填
  for (const tok of tokens) {
    try { if (window.__RFA_CUR__) { window.__RFA_CUR__.stage = "tok:" + tok; window.__RFA_CUR__.st = Date.now(); } } catch (e) {}
    let opts = [];
    for (let _a = 0; _a < 3 && !opts.length; _a++) { opts = queryOptionEls(elScope); if (!opts.length) await sleep(300); }
    try { if (window.__RFA_CUR__) { window.__RFA_CUR__.stage = "tok:" + tok + ":opts=" + opts.length; window.__RFA_CUR__.st = Date.now(); } } catch (e) {}
    // 防首帧误判：必填下拉首帧可能只渲染出 1 个选项，等 300ms 再确认是否真只有一项，
    // 避免把「多选项下拉首帧只画了第 1 项」误当成单选项去硬选第 1 项（如 实习时长 误选 远程面试）。
    if (opts.length === 1 && (field && (field.required || /\*/.test(field.rawLabel || field.label || "")))) {
      await sleep(300);
      const re = queryOptionEls(elScope);
      if (re.length >= 2) opts = re;
    }
    const optObjs = opts.map((o) => ({ text: getText(o), value: getText(o) }));
    const picked = findSelectOption(optObjs, tok, label);
    rfaLog({ act: "el-select-dbg", label: label, tok: tok, multiple: multiple, opts: opts.length, picked: picked ? picked.text : null });
    if (picked) {
      const target =
        opts.find((o) => getText(o) === picked.text) ||
        opts.find((o) => getText(o).includes(picked.text)) ||
        opts[0];
      // v0.7.1（#185）：多选下拉里点已选中的项 = 取消选中。
      // 重跑/补填时不判断这个，就会把上一轮选好的标签一个个点掉。
      if (target && multiple && /\bselected\b|\bis-selected\b/.test((target.className || "").toString())) {
        rfaLog({ act: "el-select-multi-skip-selected", label: label, tok: tok });
        continue;
      }
      if (target) { try { simulateClick(optionClickTarget(target)); } catch (e) {} await sleep(160); }
      if (multiple) { rfaLog({ act: "el-select-multi-pick", label: label, tok: tok, picked: picked.text }); }
      if (!multiple) break;
      continue;
    }
    // R4 兜底：必填且确实只有唯一可选项 → 直接选那一项（不再用 profile 值去匹配）。
    // 放在「匹配失败」之后，确保优先按 profile 值精确匹配；仅当无任何匹配且确为单选项时才兜底。
    if (opts.length === 1 && (field && (field.required || /\*/.test(field.rawLabel || field.label || "")))) {
      try { simulateClick(optionClickTarget(opts[0])); } catch (e) {}
      await sleep(180);
      rfaLog({ act: "el-select-single-option", label: label, picked: getText(opts[0]).trim() });
      if (!multiple) { closeCombobox(box); return true; }
      continue;
    }
    // v0.7.1（#185）：档案里确实有值、但选项集里没有对得上的（如腾讯「获奖类型」只有
    // 奖学金/竞赛获奖/其他，档案里却是「校级」），按产品铁律「非隐私、非站点专属的选项要 100% 填完」，
    // 退而选「其他」。只在有明确意图（tok 非空）且存在「其他」选项时才这么做，不会瞎填。
    if (tok && opts.length > 1) {
      const other = opts.find((o) => /^(其他|其它|other|others)$/i.test(getText(o).trim()));
      if (other) {
        try { simulateClick(optionClickTarget(other)); } catch (e) {}
        await sleep(160);
        rfaLog({ act: "el-select-fallback-other", label: label, tok: tok });
        if (!multiple) { closeCombobox(box); return true; }
        continue;
      }
    }
  }
  closeCombobox(box);
  return true;
}

// v0.6.55：填充飞书「国家/地区 → 省 → 市 → 区」四级级联地址选择器（所在地点/家乡）。
// 插件保存格式：中国大陆/四川省/成都市/锦江区；港澳台如 中国香港。
// 实际页面是 Tree/Cascader 面板：父节点需点击展开，叶子节点点击后选中并关闭面板。
// ── v0.8.17（#289 蔚来）：连写地址拆级 ──────────────────────────────────────────
// fillAddressTree 原本只认「中国大陆/浙江省/杭州市/西湖区」这种斜杠分隔的格式，
// 可档案里实际存的是**连写串**「北京市朝阳区」「浙江省杭州市西湖区」（map-table 实测）。
// split("/") 拆出来只有一段 → 被当成"省"去逐级点 → 树里当然没有叫「北京市朝阳区」的省
// → 所在地点 / 家乡两个字段连跑三轮 refill 都填不进去（蔚来 R1 实测 pending 到最后）。
// 按行政区划后缀切词即可还原层级；已是斜杠格式的原样返回。
function splitCnAddress(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];
  if (s.indexOf("/") >= 0) return s.split("/").map((x) => x.trim()).filter(Boolean);
  const m = s.match(/[^省市区县州盟旗]+(?:省|市|区|县|自治州|自治区|地区|盟|旗)/g);
  // 切不动就原样返回（如「中国香港」「深圳」这类无后缀写法）
  return m && m.length ? m : [s];
}

// 用树面板自带的搜索框直达目标，替代「一级一级点开」。
// 实测（蔚来飞书 ud__treeSelect）：搜「朝阳区」→ 面板扁平列出
//   中国大陆 | 北京 | 北京 | 朝阳区 | 吉林 | 长春 | 朝阳区
// 也就是把**每条命中路径**按层级顺序铺开。所以同名区（朝阳区北京有、长春也有）
// 必须靠前置节点消歧，不能无脑点第一个。
async function pickAddressBySearch(box, tokens) {
  try {
    const input = box.querySelector("input");
    if (!input || !tokens.length) return false;
    const core = (x) => String(x).replace(/(省|市|区|县|自治州|自治区|地区|盟|旗)$/g, "").trim();
    const leaf = tokens[tokens.length - 1];
    const parents = tokens.slice(0, -1).map(core).filter(Boolean);
    const visibleLabels = () =>
      Array.prototype.filter.call(
        document.querySelectorAll("[class*='ud__tree__node__label'], [class*='tree__node__label']"),
        (e) => isVisible(e)
      );

    // 末级词搜不到时，逐级往上退（「西湖区」搜不到就搜「杭州」）
    const terms = [leaf, core(leaf)].concat(tokens.slice(0, -1).reverse().map(core));
    for (const term of terms) {
      if (!term) continue;
      setNativeValue(input, term);
      dispatchInputEvent(input, term);
      let labels = [];
      for (let w = 0; w < 8 && !labels.length; w++) {
        await sleep(220);
        labels = visibleLabels();
      }
      if (!labels.length) continue;
      const texts = labels.map((e) => (e.innerText || "").trim());
      // 只在「文本等于搜索词」的节点里挑，避免点到路径上的省级节点
      let idx = -1;
      for (let i = 0; i < texts.length; i++) {
        if (core(texts[i]) !== core(term)) continue;
        const path = texts.slice(Math.max(0, i - 3), i).map(core).join("/");
        if (!parents.length || parents.some((p) => p && path.indexOf(p) >= 0)) { idx = i; break; }
      }
      if (idx < 0) idx = texts.findIndex((t) => core(t) === core(term)); // 消歧失败 → 取首个同名
      if (idx < 0) continue;
      try { simulateClick(optionClickTarget(labels[idx])); } catch (e) { labels[idx].click(); }
      await sleep(320);
      rfaLog({ act: "addr-search-pick", term: term, picked: texts[idx], cands: texts.length });
      return true;
    }
  } catch (e) {
    rfaLog({ act: "addr-search-err", err: String((e && e.message) || e) });
  }
  return false;
}

async function fillAddressTree(el, rawValue, field) {
  const REGION_OPTIONS = ["中国大陆", "中国香港", "中国澳门", "中国台湾"];
  const parts = splitCnAddress(rawValue); // v0.8.17：兼容「北京市朝阳区」连写
  if (!parts.length) return false;

  let region = "", province = "", city = "", district = "";
  if (REGION_OPTIONS.includes(parts[0])) {
    region = parts[0];
    province = parts[1] || "";
    city = parts[2] || "";
    district = parts[3] || "";
  } else {
    // 旧数据（省/市/区）默认中国大陆
    region = "中国大陆";
    province = parts[0] || "";
    city = parts[1] || "";
    district = parts[2] || "";
  }

  const box = el.closest(".ud__select__selector") || el.closest(".ud__select") || el;
  if (!(await openCombobox(box))) { closeCombobox(); return false; }

  // v0.8.17（#289）：先走搜索直达。逐级点击要展开 4 层虚拟滚动树，
  // 每层都得等渲染、还得处理"节点没滚进视口点不着"，慢且脆；
  // 搜索框一步到位（实测 <1s 命中），失败再落回下面的逐级点击老路径。
  if (box.querySelector("input")) {
    const searched = await pickAddressBySearch(box, parts.filter((p) => !REGION_OPTIONS.includes(p)));
    if (searched) {
      closeCombobox(box);
      return true;
    }
  }

  // 在 document / portal 里找所有可见节点（含 Tree/Cascader）
  // 注意：飞书的 Tree/Cascader 面板是 body 下的 portal，不在某个固定容器内，
  // 因此这里**不传 scope**（传 scope 是腾讯 Element UI 多面板同开时才需要的限域手段）。
  const getNodes = () => queryOptionEls();
  const findNode = (text) => {
    const nodes = getNodes();
    return nodes.find((o) => getText(o).trim() === text) || nodes.find((o) => getText(o).trim().includes(text));
  };
  const nodeIsExpanded = (node) => {
    // Tree：看最近父节点是否有展开类或可见子节点
    const treeNode = node.closest('.ud__tree__node, .ud__tree-node, [class*="tree__node"], [class*="tree-node"]');
    if (treeNode) {
      const children = treeNode.querySelector('.ud__tree__node__children, .ud__tree-node-children, [class*="tree__node__children"], [class*="tree-node-children"]');
      if (children && isVisible(children)) return true;
      const switcher = treeNode.querySelector('.ud__tree__node__switcher, .ud__tree-node-switcher, [class*="tree__node__switcher"], [class*="tree-node-switcher"]');
      if (switcher) {
        const cls = (switcher.className || "").toString();
        if (/open|expanded|collapse/.test(cls)) return true;
      }
    }
    return false;
  };
  const expandNode = (node) => {
    if (nodeIsExpanded(node)) return true;
    // 优先点展开箭头
    const treeNode = node.closest('.ud__tree__node, .ud__tree-node, [class*="tree__node"], [class*="tree-node"]');
    if (treeNode) {
      const switcher = treeNode.querySelector('.ud__tree__node__switcher, .ud__tree-node-switcher, [class*="tree__node__switcher"], [class*="tree-node-switcher"]');
      if (switcher) { simulateClick(switcher); return true; }
    }
    // 没有箭头就点节点本身（通常也能展开）
    simulateClick(node);
    return true;
  };
  const clickNode = (node) => {
    // 对 Tree 节点，优先点 label 本身；对普通 option，用 optionClickTarget 兜底
    simulateClick(node);
  };
  const waitForNode = async (text, maxWait = 1200) => {
    let waited = 0;
    while (waited < maxWait) {
      const n = findNode(text);
      if (n) return n;
      await sleep(120);
      waited += 120;
    }
    return null;
  };
  const expectedLast = region === "中国大陆" ? (district || city || province || region) : region;
  const isFilled = () => {
    if (!String(box.className).includes("ud__select__selector-not-empty")) return false;
    const item = box.querySelector(".ud__select__selector__selectItem");
    const t = item ? getText(item).trim() : "";
    return t.length > 0 && t.includes(expectedLast);
  };
  const ensureOpen = async () => {
    if (getNodes().length) return true;
    return await openCombobox(box);
  };

  // 兜底搜索：对带搜索输入框的组件，直接搜叶子可能更快
  const trySearchLeaf = async () => {
    const input = box.querySelector("input");
    const leaf = region === "中国大陆" ? (district || city || province) : region;
    if (!input || input.readOnly || !leaf) return false;
    setNativeValue(input, ""); dispatchInputEvent(input, ""); await sleep(80);
    setNativeValue(input, leaf); dispatchInputEvent(input, leaf); await sleep(350);
    const hit = findNode(leaf);
    if (hit) { clickNode(hit); await sleep(300); }
    return isFilled();
  };

  // 策略 A：先尝试搜索框直接搜叶子（最可靠时一步到位）
  if (await trySearchLeaf()) { closeCombobox(); return true; }

  // 策略 B：逐级展开 Tree/Cascader
  const doStep = async (text, shouldExpand = true) => {
    await ensureOpen();
    const node = await waitForNode(text);
    if (!node) return false;
    if (shouldExpand) expandNode(node);
    else clickNode(node);
    await sleep(300);
    return true;
  };

  if (region) {
    const isMainland = region === "中国大陆";
    const ok = await doStep(region, isMainland);
    if (!ok) { closeCombobox(); return false; }
  }

  if (region === "中国大陆") {
    // v0.8.11（#2 修复）：省/市/区逐级下钻时，只有「末级（叶子）」应当点击选中，
    // 中间级才展开。旧逻辑把 city 也按 shouldExpand=true 处理 → 当地址只有
    // 「中国大陆/北京市」两级、city 就是叶子时，city 被当成可展开节点去点箭头，
    // 永远不触发选中 → 所在地点/家乡整字段留空（实测 FIELDS notEmpty=false）。
    // 改成收集 [province, city, district] 非空层级，仅最后一级点击选中。
    const levels = [];
    if (province) levels.push(province);
    if (city) levels.push(city);
    if (district) levels.push(district);
    for (let li = 0; li < levels.length; li++) {
      const isLast = li === levels.length - 1;
      const ok = await doStep(levels[li], !isLast); // 中间级展开，末级点击选中
      if (!ok) { closeCombobox(); return false; }
    }
  }

  // 最终校验：若未选中，再尝试搜索框兜底
  if (!isFilled()) {
    await ensureOpen();
    await trySearchLeaf();
  }

  const ok = isFilled();
  closeCombobox();
  return ok;
}

// 展开一个 combobox 并读取其选项文本（用于无 label 的选择框反推该填什么）。
// 飞书/字节系自定义下拉把选项渲染到 body 下的 portal，需要点击展开后才能拿到。
async function readComboboxOptions(el) {
  // 若已经展开（已有可见 option），直接读
  let opts = Array.from(document.querySelectorAll('[role="option"], [class*="option"]')).filter(isVisible);
  if (opts.length === 0) {
    try { el.focus(); } catch (e) {}
    // 飞书/React 组件对事件敏感，多种方式都触发一遍提高展开成功率
    try { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true })); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); } catch (e) {}
    try { el.click(); } catch (e) {}
    for (let i = 0; i < 12; i++) {
      await sleep(120);
      opts = Array.from(document.querySelectorAll('[role="option"], [class*="option"]')).filter(isVisible);
      if (opts.length) break;
    }
  }
  const texts = opts.map((o) => getText(o).trim()).filter(Boolean);
  closeCombobox();
  return texts;
}

// 根据下拉选项内容反推这个选择框是「性别 / 城市 / 学历 / 学历类型 / 政治面貌 / 语言」等哪一类。
// 飞书「基本信息」里的几个选择框常常完全不带标签，只能靠选项内容猜。
function inferLabelFromOptions(opts) {
  if (!opts.length) return "";
  // 性别：出现 男 / 女
  if (opts.some((o) => /^(男|女)$/.test(o))) return "性别";
  // 政治面貌
  if (opts.some((o) => /(党员|团员|群众|民主党派|无党派|预备党员)/.test(o))) return "政治面貌";
  // 学历
  if (opts.some((o) => /(本科|硕士|博士|大专|中专|高中|研究生|学士|博士后|专升本)/.test(o))) return "学历";
  // 学历类型 / 培养方式
  if (opts.some((o) => /(全日制|非全日制|统招|自考|成人教育|网络教育|在职|脱产)/.test(o))) return "学历类型";
  // 语言
  if (opts.some((o) => /(英语|日语|韩语|朝鲜语|法语|德语|俄语|西班牙语|葡萄牙语|阿拉伯语|汉语|普通话|粤语|意大利语)/.test(o)))
    return "语言";
  // 城市/地址：选项里带「市 / 省 / 区 / 县」且数量较多（常见城市名也认）
  const cityRe = /北京|上海|广州|深圳|杭州|成都|武汉|南京|西安|苏州|天津|重庆|长沙|青岛|厦门|宁波|无锡|合肥|郑州|济南|沈阳|大连|福州|昆明|哈尔滨|石家庄/;
  const cityLike = opts.filter((o) => /(市|省|自治区|特区|区|县)$/.test(o) || cityRe.test(o));
  if (cityLike.length >= 3 || (opts.length >= 5 && cityLike.length >= 1)) return "所在城市";
  return "";
}

// 无 label 的选择框：展开后读选项反推类型，再从简历档案取对应值。
async function inferComboboxValue(el, field, profile) {
  const opts = await readComboboxOptions(el);
  const label = inferLabelFromOptions(opts);
  if (!label) return null;
  const basics = profile.basic || {};
  const edu = (profile.education || [])[0] || {};
  let value = null;
  if (/性别/.test(label)) value = basics.gender;
  else if (/政治面貌/.test(label)) value = basics.political;
  else if (/学历类型|学习形式|培养方式|全日制/.test(label)) value = edu.eduType;
  else if (/学历/.test(label)) value = edu.degree;
  else if (/所在城市/.test(label)) value = basics.location;
  else if (/语言/.test(label)) value = (profile.languages || [])[0] && (profile.languages[0].name || profile.languages[0]);
  if (!value || !String(value).trim()) return null;
  return { label, value: String(value).trim() };
}

function tryFillField(el, value, field) {
  const tag = el.tagName.toLowerCase();
  const valStr = String(value || "");
  try {
    // "至今" 对原生日期/月份输入框无意义，清空让用户手动选择
    if (valStr === "至今" && tag === "input" && ["date", "month"].includes((el.type || "").toLowerCase())) {
      setNativeValue(el, "");
      dispatchInputEvent(el, "");
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return false;
    }
    if (tag === "select") {
      const opts = Array.from(el.options);
      const valStr = String(value);
      const label = (field && field.label) || "";
      const match = findSelectOption(opts, valStr, label);
      if (match) {
        el.value = match.value;
        dispatchInputEvent(el, valStr);
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return verifyFill(el, value);
      }
      return false;
    }
    if (el.getAttribute("contenteditable") === "true" || el.getAttribute("role") === "textbox") {
      return fillContentEditable(el, String(value));
    }
    // 飞书/字节系月份选择器
    if (isMonthRangePicker(el) && /\d{4}[\.\-/]\d{1,2}/.test(String(value))) {
      // 这里同步返回 Promise 不方便，单独在外层处理
      return false;
    }
    // 文本类 input / textarea 依次尝试三种方案
    if (tag === "textarea") {
      const _idx = (el.getAttribute ? el.getAttribute("data-rfa-idx") : "");
      const _r1 = fillReactInput(el, value);
      rfaLog({ act: "ta-dbg", idx: _idx, vlen: String(value).length, vhead: String(value).slice(0, 10), r1: _r1, cur: (getFieldValue(el) || "").slice(0, 12) });
      if (_r1) return true;
      const _r2 = typeLikeHuman(el, value);
      rfaLog({ act: "ta-dbg2", idx: _idx, r2: _r2, cur: (getFieldValue(el) || "").slice(0, 12) });
      if (_r2) return true;
      return fillByExecCommand(el, value);
    }
    if (fillReactInput(el, value)) return true;
    if (typeLikeHuman(el, value)) return true;
    return fillByExecCommand(el, value);
  } catch (e) {
    return false;
  }
}

// v0.7.1（#185）：腾讯 Element UI el-cascader 级联选择器（当前所处地 / 目前就读地）。
// 值形如「中国大陆/北京市/北京市/朝阳区」，逐列下钻：点第 0 列匹配项 → 下一列出现 → 点第 1 列 → …
// 面板结构：.el-cascader-panel 内含多个 .el-cascader-menu 列，每列 .el-cascader-node 为选项。
async function fillElCascader(el, rawValue, field) {
  const box = el.closest && el.closest(".el-cascader") ? el.closest(".el-cascader") : el;
  const want = String(rawValue || "").trim();
  if (!want) return false;
  let segs = want.split("/").map((s) => s.trim()).filter(Boolean);
  if (!segs.length) return false;
  const label = (field && field.label) || getLabel(el);

  // 复位：若已有面板开着，先关掉再开，避免「点了等于关闭」的坑
  const closePanel = () => {
    try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, which: 27, bubbles: true })); } catch (e) {}
    try { simulateClick(document.body); } catch (e) {}
  };
  if (document.querySelector(".el-cascader-panel, .el-cascader__dropdown")) { closePanel(); await sleep(350); }

  // 开面板：点 input 或容器都试一遍
  const triggers = [el, box.querySelector("input"), box];
  let opened = false;
  for (const t of triggers) {
    if (!t) continue;
    try { t.click(); t.focus(); } catch (e) {}
    await sleep(500);
    if (document.querySelector(".el-cascader-panel, .el-cascader__dropdown")) { opened = true; break; }
  }
  if (!opened) { rfaLog({ act: "el-cascader-nopopup", label: label, want: want }); return false; }

  // v0.7.x：col0 是大区（中国大陆/亚太/美洲/欧洲/中东及非洲），传入的却是城市名（北京），
  // 直接按 city 下钻会在第 1 级就「无匹配」。自动补「中国大陆」大区前缀。
  {
    const _col0 = Array.from(document.querySelectorAll(".el-cascader-panel .el-cascader-menu:first-child .el-cascader-node")).map((n) => getText(n).trim());
    const _isRegion = _col0.length && /中国大陆|亚太|美洲|欧洲|中东|非洲/.test(_col0[0] || "");
    const _first = segs[0] || "";
    const _inCol0 = _col0.some((t) => t === _first || t.indexOf(_first) >= 0 || _first.indexOf(t) >= 0);
    if (_isRegion && !_inCol0) segs = ["中国大陆"].concat(segs);
  }

  const lastCol = () => {
    const menus = Array.from(document.querySelectorAll(".el-cascader-panel .el-cascader-menu, .el-cascader-menu"));
    return menus[menus.length - 1];
  };
  const picked = [];
  let aborted = "";
  // v0.7.6（#255）：两处致命缺陷一起修——
  //  ① 城市名「北京市」对不上腾讯的节点文本「北京」：原打分只做裸包含，
  //     '北京'.indexOf('北京市') = -1、'北京市'.indexOf('北京') = 0 只得 1 分，
  //     虽然勉强能选中，但遇到同列有「北京大学城」这类噪声就会串台。改为先剥
  //     行政后缀（市/省/自治区/特别行政区…）再比，精确度大幅提升。
  //  ② 选完 segs 就 break，但腾讯「北京」下面还有一层（区/县），没点到叶子，
  //     Element UI 不会把值回写进 input → shown="" → 整个字段判为失败（实测
  //     日志 el-cascader-nomatch picked=中国大陆/北京 shown=""）。
  //     现在改成：segs 用完后若 input 仍为空且还有新列，就继续自动下钻
  //     （优先挑与末段同名的项，否则挑第一个可选项），直到 input 有值。
  const cnorm = (s) => {
    let t = String(s || "").replace(/[\s()（）]/g, "");
    for (let i = 0; i < 2; i++) t = t.replace(/(市辖区|特别行政区|自治区|自治州|地区|省|市|县|区)$/, "");
    return t || String(s || "").trim();
  };
  const inpEl = () => box.querySelector("input");
  const inpVal = () => { const i = inpEl(); return i ? (i.value || "").trim() : ""; };
  const colCount = () => document.querySelectorAll(".el-cascader-panel .el-cascader-menu, .el-cascader-menu").length;

  for (let guard = 0; guard < 8; guard++) {
    const col = lastCol();
    if (!col) break;
    const nodes = Array.from(col.querySelectorAll(".el-cascader-node")).filter(isVisible);
    if (!nodes.length) break;

    const hasSeg = picked.length < segs.length;
    let best = null;
    if (hasSeg) {
      const seg = segs[picked.length];
      const ns = cnorm(seg);
      let bestScore = 0;
      nodes.forEach((n) => {
        const t = getText(n).trim();
        const nt = cnorm(t);
        let sc = 0;
        if (t === seg) sc = 5;
        else if (nt && nt === ns) sc = 4;
        else if (ns && nt.indexOf(ns) === 0) sc = 3;
        else if (nt && ns.indexOf(nt) === 0 && nt.length >= 2) sc = 2;
        else if (ns && nt.indexOf(ns) > 0) sc = 1;
        if (sc > bestScore) { bestScore = sc; best = n; }
      });
      if (!best) { aborted = "第" + (picked.length + 1) + "级无匹配(" + seg + ")"; break; }
    } else {
      // segs 已用完但 input 还是空的 → 说明当前还不是叶子，自动往下钻一层
      const lastNs = cnorm(segs[segs.length - 1] || "");
      best =
        nodes.find((n) => cnorm(getText(n).trim()) === lastNs) ||
        nodes.find((n) => !/is-disabled/.test((n.className || "").toString())) ||
        nodes[0];
      if (!best) break;
    }

    const beforeCols = colCount();
    if (/\bis-active\b|\bis-checked\b/.test((best.className || "").toString())) {
      // 已是选中态：**不要**再点（多选/单选级联里再点一次等于取消），只记录并看下一列
      if (hasSeg) picked.push(getText(best).trim());
      await sleep(220);
    } else {
      simulateClick(best);
      picked.push(getText(best).trim());
      await sleep(450);
    }

    if (inpVal()) break;                 // input 已回写 → 到叶子了，收工
    const nowCols = colCount();
    if (!nowCols) break;                 // 弹层收起
    if (nowCols <= beforeCols && !hasSeg) break; // 没有新列且已无 seg 可用 → 到头，别死循环
  }

  await sleep(300);
  // 选中值回写到 input（el-cascader 把路径以「 / 」拼接进 input.value）
  const inp = box.querySelector("input");
  const shown = inp ? (inp.value || "").trim() : "";
  const ok = picked.length > 0 && shown.length > 0;
  rfaLog({ act: ok ? "el-cascader" : "el-cascader-nomatch", label: label, want: want, picked: picked.join("/"), shown: shown.slice(0, 40), why: aborted });
  closePanel();
  await sleep(200);
  return ok;
}

// v0.7.1（#185）：腾讯 Element UI el-date-picker 日期/月份选择器。
// 值形如「2019.09」(年月) 或「2026.07.01」(完整日期)。Element UI 的 input 默认可编辑，
// 直接把 ISO 串（年-月[-日]）打进 input 并触发 change/blur 即被解析；解析失败再回落日历点选。
function parseQQDate(value) {
  const s = String(value || "").trim();
  const m = s.match(/(\d{4})[.\-/](\d{1,2})(?:[.\-/](\d{1,2}))?/);
  if (!m) return null;
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10);
  const d = m[3] ? parseInt(m[3], 10) : null;
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || (d && (d < 1 || d > 31))) return null;
  return { year: y, month: mo, day: d };
}
// v0.7.1（#185）：从 el-date-editor 的类名/placeholder 判断日期精度。
// Element UI 的编辑器类名形如 el-date-editor--date / --month / --year / --datetime / --daterange。
function detectElDateMode(box, inp) {
  const cls = ((box && box.className) || "").toString();
  if (/el-date-editor--year\b/.test(cls)) return "year";
  if (/el-date-editor--month(?!range)\b/.test(cls)) return "month";
  if (/el-date-editor--(date|datetime)(?!range)\b/.test(cls)) return "date";
  // 类名没命中就看 placeholder 文案
  const ph = ((inp && inp.placeholder) || "") + " " + ((box && box.getAttribute && box.getAttribute("placeholder")) || "");
  if (/选择年|年份|^\s*年\s*$|\byyyy\b(?!-)/i.test(ph)) return "year";
  if (/选择月|月份|yyyy-mm(?!-)/i.test(ph)) return "month";
  return "date";
}

async function fillElDatePicker(el, rawValue, field) {
  const box = el.closest && (el.closest(".el-date-editor") || el.closest(".el-date-picker")) ? el.closest(".el-date-editor") || el.closest(".el-date-picker") : null;
  const inp = box ? box.querySelector("input") : (el.tagName === "INPUT" ? el : null);
  if (!inp) return false;
  const ym = parseQQDate(rawValue);
  if (!ym) {
    // v0.7.1（#185）：「至今 / 现在 / 在读 / 在职」不是能在月历里选出来的日期。
    // 此处原先写着「腾讯这类字段一般没有至今勾选框，留空交给用户」并直接放弃 —— 经 DOM 探测证伪：
    // 腾讯每张实习/项目卡的结束时间旁都有 <label class="el-checkbox sofar_check">…至今</label>（全页 7 个，均可见）。
    // 正确做法是勾上同一张卡里的那个复选框，而不是留空标黄（否则 VizLib 项目的结束时间永远挂未填清单）。
    if (/至今|今|现在|在读|在职|至现在|present|now|current/i.test(String(rawValue))) {
      const ok = tickToNowCheckbox(box || inp);
      rfaLog({
        act: "el-date-tonow",
        label: (field && field.label) || inp.placeholder,
        want: String(rawValue),
        ok,
      });
      if (ok) return true;
    }
    rfaLog({ act: "el-date-unparsable", label: (field && field.label) || inp.placeholder, want: String(rawValue) });
    return false;
  }
  const digits = (s) => String(s || "").replace(/\D/g, "");
  const label = (field && field.label) || inp.placeholder;

  // 1) 判断精度（年 / 月 / 日）。
  // v0.7.1（#185）踩过的坑：原本靠「面板里有没有 .el-month-table」判断，
  // 但 Element UI 会把年/月/日三张表**全部渲染进同一个面板**，只用 display:none 藏起不激活的那两张，
  // 于是 querySelector('.el-month-table') 永远为真 → 所有日期一律按「月」精度填 "2019-09"。
  // 而腾讯这些其实是 el-date-editor--date（日精度），"2019-09" 会被 Element UI 解析成垃圾日期
  // （实测面板 header 显示「1666 年8 月」），输入框表面留着字、内部 model 无效，重渲染后就被清空 —— 
  // 这正是「日志说填了、页面却是空的」21 个日期框的真凶。
  // 现在改为看编辑器自身的类名（最可靠，且不必打开面板，省掉 24×400ms）。
  const mode = detectElDateMode(box, inp);
  const wantStr = mode === "year"
    ? `${ym.year}`
    : mode === "month"
      ? `${ym.year}-${String(ym.month).padStart(2, "0")}`
      : `${ym.year}-${String(ym.month).padStart(2, "0")}-${String(ym.day || 1).padStart(2, "0")}`;

  // 2) 收起面板后用 typing 主路径（最稳）：直接写 input + 触发 change/blur
  try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, which: 27, bubbles: true })); } catch (e) {}
  await sleep(200);
  setNativeValue(inp, wantStr);
  dispatchInputEvent(inp, wantStr);
  // Element UI 的日期输入是在 Enter / blur 时才走 handleChange 去 parse 的，
  // 只派发 input 事件的话组件内部 model 还是空的（表面有字、提交为空）。
  try { inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true })); } catch (e) {}
  try { inp.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) {}
  try { inp.dispatchEvent(new Event("blur", { bubbles: true })); } catch (e) {}
  await sleep(400);

  let after = String(inp.value || "").trim();
  // v0.7.1（#185）：只看「刚写完」那一帧会被骗。Element UI 解析失败时是等一次重渲染才把值抹掉的，
  // 所以再等 500ms 复查一次，值还在才算真的填上了。
  if (digits(after) === digits(wantStr)) {
    await sleep(500);
    after = String(inp.value || "").trim();
  }
  if (digits(after) === digits(wantStr)) {
    rfaLog({ act: "el-date", label: label, want: wantStr, after: after, mode: mode, ok: true });
    return true;
  }

  // 3) 回落：日历点选
  rfaLog({ act: "el-date-typing-failed", label: label, want: wantStr, after: after, mode: mode });
  return await pickElDateInPanel(inp, ym, mode, label);
}

// el-date-picker 日历点选兜底：年 → 月 → 日（或月模式下 年 → 月）。
async function pickElDateInPanel(inp, ym, mode, label) {
  try { inp.click(); inp.focus(); } catch (e) {}
  await sleep(400);
  // 页面里常同时存在多个 el-picker-panel（每个日期框一个，未激活的 display:none），
  // 直接 querySelector 会抓到隐藏的那个，点了等于没点 → 必须只取可见面板。
  const picker = Array.from(document.querySelectorAll(".el-date-picker, .el-picker-panel")).filter(isVisible).pop();
  if (!picker) return false;

  const headerLabels = () => Array.from(picker.querySelectorAll(".el-date-picker__header-label, .el-picker-panel__header-label"));
  // 切到年视图
  const yrLabel = headerLabels()[0];
  if (yrLabel) { simulateClick(yrLabel); await sleep(300); }
  // 在年表格里点目标年（可能在多页，左右翻）
  let yearHit = null;
  for (let p = 0; p < 12 && !yearHit; p++) {
    const cells = Array.from(picker.querySelectorAll(".el-year-table td, .el-date-picker__year-cell")).filter(isVisible);
    yearHit = cells.find((c) => /\b\d{4}\b/.test(getText(c)) && parseInt(getText(c), 10) === ym.year);
    if (yearHit) break;
    const sw = picker.querySelector(".el-date-picker__prev-btn, .el-icon-d-arrow-left");
    if (!sw) break;
    simulateClick(sw); await sleep(220);
  }
  if (yearHit) { simulateClick(yearHit); await sleep(300); }

  if (mode === "year") {
    // 年精度：点完年就结束（腾讯「获奖时间」就是这种）
  } else if (mode === "month") {
    const monthCells = Array.from(picker.querySelectorAll(".el-month-table td, .el-date-picker__month-cell")).filter(isVisible);
    const mHit = monthCells.find((c) => { const t = getText(c); return new RegExp("^0*" + ym.month + "\\s*月?$").test(t.trim()); });
    if (mHit) { simulateClick(mHit); await sleep(300); }
  } else {
    // 回到月视图（点月份标签）
    const moLabel = headerLabels()[1];
    if (moLabel) { simulateClick(moLabel); await sleep(300); }
    const monthCells = Array.from(picker.querySelectorAll(".el-month-table td, .el-date-picker__month-cell")).filter(isVisible);
    const mHit = monthCells.find((c) => { const t = getText(c); return new RegExp("^0*" + ym.month + "\\s*月?$").test(t.trim()); });
    if (mHit) { simulateClick(mHit); await sleep(300); }
    // 点日
    const dayCells = Array.from(picker.querySelectorAll(".el-date-table td")).filter(isVisible);
    const dHit = dayCells.find((c) => {
      const cls = (c.className || "").toString();
      if (/disabled|prev-month|next-month|available/.test(cls) === false && /available/.test(cls) === false) return false;
      return getText(c).trim() === String(ym.day);
    }) || dayCells.find((c) => getText(c).trim() === String(ym.day));
    if (dHit) { simulateClick(dHit); await sleep(300); }
  }
  const after = String(inp.value || "").trim();
  const digits = (s) => String(s || "").replace(/\D/g, "");
  const wantStr = mode === "year"
    ? `${ym.year}`
    : mode === "month"
      ? `${ym.year}-${String(ym.month).padStart(2, "0")}`
      : `${ym.year}-${String(ym.month).padStart(2, "0")}-${String(ym.day || 1).padStart(2, "0")}`;
  const ok = digits(after) === digits(wantStr);
  rfaLog({ act: "el-date-cal", label: label, want: wantStr, after: after, mode: mode, ok: ok });
  return ok;
}

// v0.7.1（#185）：单字段填充熔断。
// 腾讯这类「一页几十个下拉」的表单，只要有一个组件的等待条件不满足（面板没弹出、选项没渲染、
// 级联节点上千导致遍历变慢），整轮填充就会永远卡在那个字段上——用户看到的就是「插件不动了」。
// 这里给每个字段套一个硬超时：超时就放弃该字段（标黄留给用户手填）、关掉可能还开着的面板，
// 让后面的字段继续填完。宁可少填一个，也不能整轮挂死。
function fillFieldGuarded(el, value, field, ms) {
  const label = (field && (field.label || field.rawLabel)) || "";
  if (/国家\/地区|区号|如您是中国大陆|手机|86/i.test(label) || /^\+\d/.test(String(value || ""))) {
    if (!window.__RFA_DBG3__) window.__RFA_DBG3__ = [];
    window.__RFA_DBG3__.push({ ts: Date.now(), stage: "ffg", label: label, val: String(value).slice(0, 18), elIdx: el && el.getAttribute && el.getAttribute("data-rfa-idx"), elTag: el && el.tagName });
  }
  const limit = ms || 25000;
  let timer = null;
  const guard = new Promise((res) => {
    timer = setTimeout(() => {
      try { rfaLog({ act: "field-timeout", label: label, value: String(value).slice(0, 24), ms: limit }); } catch (e) {}
      try { closeCombobox(el); } catch (e) {}
      res(false);
    }, limit);
  });
  return Promise.race([
    Promise.resolve()
      .then(() => fillFieldAsync(el, value, field))
      .catch((e) => {
        try { rfaLog({ act: "field-error", label: label, err: String((e && e.message) || e).slice(0, 120) }); } catch (x) {}
        return false;
      }),
    guard,
  ]).then((r) => {
    if (timer) clearTimeout(timer);
    return r;
  });
}

// v0.7.1（#185）：填单选组。腾讯「性别*」等必填单选此前一直空着（插件根本没有 radio 逻辑）。
// 匹配复用 findSelectOption——学历/性别/是否类的别名、冲突排除全都能直接用上。
// v0.7.1（#185）：.el-dropdown 字段填充（外语考试类型等）。
// 交互：点触发元素展开 .el-dropdown-menu，在 .el-dropdown-menu__item 里找匹配项点击。
// 注意：Element UI 的 el-dropdown 默认 popper-append-to-body=true，展开后 .el-dropdown-menu
// 会被挂到 document.body 上（不在 .el-dropdown 内部），所以菜单要从 document 找「可见的那一个」。
function findOpenDropdownMenu(dd) {
  let m = dd.querySelector(".el-dropdown-menu");
  if (m) return m;
  const all = Array.from(document.querySelectorAll(".el-dropdown-menu"));
  m = all.find(function (x) {
    try {
      return x.getBoundingClientRect().height > 0 && getComputedStyle(x).display !== "none";
    } catch (e) {
      return false;
    }
  });
  return m || all[0] || null;
}
async function fillDropdown(dd, value, field) {
  if (value == null || value === "") {
    rfaLog({ act: "dropdown-skip", label: field && field.label, reason: "no-value" });
    return false;
  }
  const trig = dd.querySelector(".el-dropdown-link, .el-dropdown-selfdefine") || dd;
  const valStr = String(value).trim();
  trig.click();
  await sleep(250);
  let tries = 0;
  let menu = findOpenDropdownMenu(dd);
  while (menu && menu.offsetParent === null && getComputedStyle(menu).display === "none" && tries < 12) {
    await sleep(120);
    tries++;
    menu = findOpenDropdownMenu(dd);
  }
  const items = menu
    ? Array.from(menu.querySelectorAll(".el-dropdown-menu__item")).filter(
        (i) => !i.classList.contains("el-dropdown-menu__item--divided")
      )
    : [];
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  let hit = items.find((i) => norm(i.innerText) === valStr);
  if (!hit) hit = items.find((i) => norm(i.innerText).indexOf(valStr) >= 0);
  if (!hit) hit = items.find((i) => valStr.indexOf(norm(i.innerText)) >= 0);
  // R4 规则：必填且确实只有唯一可选项 → 直接选那一项（与 fillCombobox/fillRadioGroup 对齐）。
  // 产品铁律：单选唯一项必选，不让用户去点。放在匹配失败之后，优先按 profile 值精确匹配。
  if (!hit && items.length === 1) {
    const req = (field && field.required) || /\*/.test(String((field && (field.rawLabel || field.label)) || ""));
    if (req) hit = items[0];
  }
  if (!hit) {
    rfaLog({ act: "dropdown-nohit", label: field && field.label, value: valStr });
    try { document.body.click(); } catch (e) {}
    return false;
  }
  hit.click();
  await sleep(300);
  const ok = !isDropdownEmpty(dd);
  rfaLog({ act: "dropdown-fill", label: field && field.label, value: valStr, ok: ok });
  return ok;
}

async function fillRadioGroup(box, value, field) {
  const label = (field && (field.label || field.rawLabel)) || "";
  // 产品铁律：需要用户自己拍板的主观/意愿类单选（是否接受调剂、是否服从分配…）插件不代答
  if (/接受调剂|服从调剂|服从分配|是否同意|是否接受|愿意|意向岗位|是否需要/.test(label)) {
    rfaLog({ act: "radio-skip-subjective", label });
    return false;
  }
  // v0.8.40（A3 硬闸门）：源文档里没有答案的题（亲友就职 / 是否为全日制在校学生 / 预计入职时间…）
  // 连「唯一选项必选 R4」也不许代答 —— 下面 R4 分支会在只有一个选项且必填时直接勾中，
  // 蔚来这类 是/否 合规问答一旦被勾上就是插件替用户表态，用户明令禁止。
  if (isNoSourceDataField(label)) {
    rfaLog({ act: "radio-skip-a3-gate", label });
    return false;
  }
  const opts = listRadioOptions(box);
  if (!opts.length) return false;
  let hit = findSelectOption(opts, String(value), label);
  // 兜底：性别/是否这类短词做包含匹配
  if (!hit) {
    const v = String(value).trim();
    hit = opts.find((o) => o.text === v) || opts.find((o) => o.text.indexOf(v) >= 0 || v.indexOf(o.text) >= 0) || null;
  }
  // R4 规则：只有一个选项且必填（标题带 *）→ 直接选那个唯一项，不让用户去点
  // 注意不能复用 isSingleOptionRequired()，它读的是 field.optionCount（下拉专用，radio 组没有这个字段）
  if (!hit && opts.length === 1) {
    const req = (field && field.required) || /[*＊]/.test(String((field && (field.rawLabel || field.label)) || ""));
    if (req) hit = opts[0];
  }
  if (!hit) {
    rfaLog({ act: "radio-nomatch", label, value: String(value).slice(0, 20), opts: opts.map((o) => o.text).slice(0, 8) });
    return false;
  }
  const item = hit.el;
  // Element UI 的 .el-radio 点 label 或内部 input 都能触发；原生 radio 直接点 input 最稳
  const nativeInp = item.querySelector ? item.querySelector("input[type=radio]") : null;
  const target = nativeInp || item;
  try {
    ["pointerdown", "mousedown", "mouseup"].forEach((t) => {
      item.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    });
  } catch (e) {}
  try {
    target.click();
  } catch (e) {}
  try {
    if (nativeInp && !nativeInp.checked) {
      nativeInp.checked = true;
      nativeInp.dispatchEvent(new Event("change", { bubbles: true }));
    }
  } catch (e) {}
  await sleep(80);
  const ok = !!getCheckedRadio(box);
  rfaLog({ act: "radio-fill", label, pick: hit.text, ok });
  return ok;
}

// ── v0.8.17（#364）：京东校招基本信息卡专用填充（Ant Design v3）──────────────────────
// 通用 fillCombobox/tryPickGenericSelect 对 antd v3 处理不稳：v3 选项类是
// .ant-select-dropdown-menu-item（非 v4 的 .ant-select-item-option）、单选是 .ant-radio-group、
// 地址是 .ant-cascader-picker。实测 民族/城市 下拉弹层开了却点不中选项、性别 radio 整段漏填、
// 城市级联被误丢给飞书 fillAddressTree。故基本信息卡字段改走下列专用交互，其余卡维持原流程。
async function jdFillAntSelectV3(el, value, field) {
  const valStr = String(value || "").trim();
  if (!valStr) return false;
  const sel = el.closest(".ant-select");
  if (!sel) return false;
  const cur = sel.querySelector(".ant-select-selection-selected-value, .ant-select-selection__rendered");
  if (cur && (cur.innerText || "").trim() === valStr) return true;
  const trigger = sel.querySelector(".ant-select-selector") || sel;
  simulateClick(trigger);
  await sleep(500);
  let dd = Array.from(document.querySelectorAll(".ant-select-dropdown")).filter(function (d) {
    return !d.className.includes("hidden") && d.offsetWidth > 0;
  })[0];
  if (!dd) { await sleep(300); dd = Array.from(document.querySelectorAll(".ant-select-dropdown")).filter(function (d) {
    return !d.className.includes("hidden") && d.offsetWidth > 0;
  })[0]; }
  if (!dd) { rfaLog({ act: "jd-antselect-no-panel", label: (field && field.label) || "", val: valStr, trig: (trigger && trigger.className || "").toString().slice(0, 40) }); return false; }
  const opts = Array.from(dd.querySelectorAll("li.ant-select-dropdown-menu-item, [role=option]")).filter(function (o) { return o.offsetWidth > 0; });
  rfaLog({ act: "jd-antselect-dbg", label: (field && field.label) || "", val: valStr, ddCls: (dd.className || "").toString().slice(0, 50), optN: opts.length });
  // v0.8.17（#364）：地址类下拉选项常不带「市/省」后缀（如档案值「北京市」、选项「北京」），
  // 故匹配时双向去除尾缀再比对，避免整段漏填。
  const _norm = function (s) { return (s || "").trim().replace(/(市|省|自治区|特别行政区)$/, ""); };
  const _txt = function (o) { return (o.getAttribute("title") || o.innerText || "").trim(); };
  const hit = opts.find(function (o) { return _norm(_txt(o)) === _norm(valStr); }) ||
              opts.find(function (o) { return _txt(o) === valStr; }) ||
              opts.find(function (o) { return (o.innerText || "").trim().indexOf(valStr) >= 0; }) ||
              opts.find(function (o) { return _norm(o.innerText || "").indexOf(_norm(valStr)) >= 0; });
  if (!hit) { try { document.body.click(); } catch (e) {} rfaLog({ act: "jd-antselect-nohit", label: (field && field.label) || "", val: valStr, optSample: opts.slice(0, 5).map(function (o) { return (o.innerText || "").trim(); }) }); return false; }
  simulateClick(hit);
  await sleep(300);
  return true;
}
async function jdFillRadio(box, value) {
  const valStr = String(value || "").trim();
  if (!valStr) return false;
  const labels = Array.from(box.querySelectorAll("label"));
  const hit = labels.find(function (l) { return (l.innerText || "").trim() === valStr; }) ||
              labels.find(function (l) { return (l.innerText || "").trim().indexOf(valStr) >= 0; });
  if (!hit) { rfaLog({ act: "jd-radio-nohit", val: valStr }); return false; }
  simulateClick(hit);
  await sleep(200);
  rfaLog({ act: "jd-radio-ok", val: valStr });
  return true;
}
// 读取级联选项文本：antd v3 的 li 同时带 title 与内部文本，优先取非空者
function cascItemText(o) {
  try {
    var t = o.getAttribute("title");
    if (t && t.trim()) return t.trim();
    t = (o.innerText || "").trim();
    if (t) return t;
    if (typeof getText === "function") { t = getText(o); if (t && t.trim()) return t.trim(); }
  } catch (e) {}
  return "";
}
// 京东一页有多个级联（籍贯/专业类别/所在城市），document.querySelector 取到的可能是
// 别的字段的面板。改取「可见且含有效选项文本」的那一个。
function visibleCascMenu() {
  var all = Array.from(document.querySelectorAll(".ant-cascader-menus"));
  for (var i = 0; i < all.length; i++) {
    var m = all[i];
    try {
      var s = getComputedStyle(m);
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") continue;
      var r = m.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
    } catch (e) { continue; }
    var lis = Array.from(m.querySelectorAll(".ant-cascader-menu li"));
    if (lis.some(function (o) { return cascItemText(o); })) return m;
  }
  return null;
}
async function jdFillCascader(el, value, field) {
  const valStr = String(value || "").trim();
  if (!valStr) return false;
  const picker = el.closest(".ant-cascader-picker") || el.closest(".ant-cascader");
  if (!picker) return false;
  const lbl = picker.querySelector(".ant-cascader-picker-label");
  if (lbl && (lbl.innerText || "").trim() && (lbl.innerText || "").trim().indexOf(valStr) >= 0) return true;
  try { picker.scrollIntoView({ block: "center" }); await sleep(200); } catch (e) {}
  const br = picker.getBoundingClientRect();
  const x = Math.round(br.left + br.width / 2), y = Math.round(br.top + br.height / 2);
  // antd v3 级联对合成 click 不灵敏，需 mousedown→mouseup→click 真实序列
  ["mousedown", "mouseup", "click"].forEach(function (t) {
    try { picker.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window })); } catch (e) {}
  });
  // 轮询「可见且含文本选项」的面板（京东多级联同存，不能取 DOM 中第一个）
  let menu = null;
  for (let _p = 0; _p < 12 && !menu; _p++) { await sleep(250); menu = visibleCascMenu(); }
  if (!menu) { rfaLog({ act: "jd-cascader-no-panel", label: (field && field.label) || "", val: valStr }); return false; }
  const segs = splitCnAddress(valStr);
  for (let s = 0; s < segs.length; s++) {
    let col = null;
    for (let _c = 0; _c < 8 && !col; _c++) {
      const cols = Array.from(menu.querySelectorAll(".ant-cascader-menu"));
      col = cols[cols.length - 1];
      if (!col) { await sleep(200); continue; }
      const have = Array.from(col.querySelectorAll("li")).filter(function (o) { return cascItemText(o) && o.offsetWidth > 0; });
      if (!have.length) { col = null; await sleep(200); }
    }
    if (!col) break;
    const seg = segs[s];
    const items = Array.from(col.querySelectorAll("li")).filter(function (o) { return o.offsetWidth > 0; });
    const hit = items.find(function (o) { return cascItemText(o) === seg; }) ||
                items.find(function (o) { return cascItemText(o).indexOf(seg) >= 0; });
    if (!hit) { rfaLog({ act: "jd-cascader-miss", label: (field && field.label) || "", seg: seg }); break; }
    simulateClick(hit);
    await sleep(450);
  }
  try { document.body.click(); } catch (e) {}
  rfaLog({ act: "jd-cascader-ok", label: (field && field.label) || "", val: valStr });
  return true;
}
async function jdFillBasicCard(profile) {
  // v0.8.17（#364）：基本信息卡的下拉/单选/级联字段，主循环的「按 data-rfa-idx 取元素」会因
  // scanFields 序号与京东原生 data-rfa-idx 不一致而取不到元素（el 为 null → 整段跳过），
  // 故这里改为【按标签定位】直接填充，彻底绕开 idx 错配。纯文本字段（姓名/手机/邮箱/证件号/
  // 出生/微信/爱好）仍由通用流已填，这里只处理 radio / ant-select / cascader。
  try {
    const ctx = { basic: (profile && profile.basic) || {} };
    const cards = Array.from(document.querySelectorAll('[class*="formGroupItem___"]'));
    const basic = cards.find(function (c) { return c.querySelector('[data-rfa-idx="1"]') || c.innerText.indexOf("姓名") >= 0; });
    if (!basic) return;
    const items = Array.from(basic.querySelectorAll('[class*="fieldItem___"]'));
    for (const pair of JD_RULES.basic) {
      const re = pair[0], fn = pair[1];
      const it = items.find(function (i) {
        const n = i.querySelector('[class*="filedName___"]');
        return n && re.test((n.innerText || "").replace(/\s+/g, " ").split(/[:：]/)[0].replace(/^\*/, "").trim());
      });
      if (!it) continue;
      let val; try { val = fn(it, ctx, 0, 0); } catch (e) { val = null; }
      if (val == null || val === "") continue;
      val = String(val);
      const radio = it.querySelector(".ant-radio-group");
      const casc = it.querySelector(".ant-cascader-picker");
      const sel = it.querySelector(".ant-select");
      if (radio) { await jdFillRadio(radio, val); rfaLog({ act: "jd-basic-radio", label: (re.toString().slice(0, 16)), val: val }); }
      else if (casc) { await jdFillCascader(casc, val); rfaLog({ act: "jd-basic-casc", label: (re.toString().slice(0, 16)), val: val }); }
      else if (sel) { await jdFillAntSelectV3(sel, val); rfaLog({ act: "jd-basic-antselect", label: (re.toString().slice(0, 16)), val: val }); }
      // 纯文本字段不在此处理
    }
  } catch (e) { rfaLog({ act: "jd-basic-card-err", err: String((e && e.message) || e) }); }
}

// v0.8.17（#364）：论文详情文本框。通用取值链对该「详情」标签命中失败（只认 描述/摘要/简介），
// 导致主循环喂给 fillFieldAsync 的 value 为空、文本框恒空。这里单独按标签定位 textarea，
// 直接拼「发表于+影响因子+描述」富文本写进去（与京东专用重映射 JD_RULES 一致），绕开通用链。
async function jdFillPapers(profile) {
  try {
    const cards = Array.from(document.querySelectorAll('[class*="formGroupItem___"]'));
    const paperCards = cards.filter(function (c) {
      return /论文/.test(c.innerText) && /作者顺序|刊物|机构/.test(c.innerText);
    });
    const ps = (profile && profile.papers) || [];
    for (let i = 0; i < paperCards.length; i++) {
      const card = paperCards[i];
      const item = ps[i] || {};
      const items = Array.from(card.querySelectorAll('[class*="fieldItem___"]'));
      const it = items.find(function (x) {
        const n = x.querySelector('[class*="filedName___"]');
        return n && /论文详情|论文描述|论文链接/.test(n.innerText || "");
      });
      if (!it) continue;
      const ta = it.querySelector("textarea,input");
      if (!ta) continue;
      const val = [item.venue ? "发表于 " + item.venue : "", item.impact ? "影响因子 " + item.impact : "", item.description]
        .filter(Boolean).join("，");
      if (!val) continue;
      const ok = fillReactInput(ta, val);
      rfaLog({ act: "jd-paper-detail", idx: i, ok: ok, val: val.slice(0, 30) });
    }
  } catch (e) { rfaLog({ act: "jd-paper-detail-err", err: String((e && e.message) || e) }); }
}

// v0.8.17（#366）：京东「其他信息」4 个独立上传槽（成绩单/证书/专利/作品集）
// 不在插件通用 fileVault 类目（resume/photo/portfolio）里，按 uploadItem 容器标签定位 input[type=file] 注入。
// 注：京东用 antd Upload，必须配 setFileInput 的 MAIN 世界注入（bubbles:true 的 change 事件）才能被 React 吃到。
async function jdFillAttachments(fileVault) {
  if (!fileVault) { rfaLog({ act: "jd-att-skip", why: "no fileVault" }); return; }
  const map = [
    { label: /成绩单/, key: "transcript" },
    { label: /证书/, key: "certificate" },
    { label: /专利/, key: "patent" },
    { label: /作品集|作品/, key: "portfolio" },
  ];
  for (const m of map) {
    const att = fileVault[m.key];
    if (!att || !att.dataUrl) { rfaLog({ act: "jd-att-no-data", key: m.key }); continue; }
    // 仅在该 input 所属 uploadItem 容器的文本命中标签时才认 —— 避免误命中其它槽/简历附件
    const input = Array.from(document.querySelectorAll('input[type=file]')).find(function (inp) {
      const ui = inp.closest('[class*="uploadItem"]');
      return ui ? m.label.test((ui.innerText || '').replace(/\s+/g, '')) : false;
    });
    if (!input) { rfaLog({ act: "jd-att-no-input", key: m.key }); continue; }
    try {
      const ok = await setFileInput(input, att.dataUrl, att.name || (m.key + ".pdf"));
      rfaLog({ act: "jd-att-fill", key: m.key, ok: ok, name: att.name });
    } catch (e) { rfaLog({ act: "jd-att-err", key: m.key, err: String((e && e.message) || e) }); }
  }
}

async function fillFieldAsync(el, value, field) {
  // v0.8.17（#364）：京东基本信息卡字段改走 antd-v3 专用交互（见上方 jdFill*）。
  if (/campus\.jd\.com/i.test(location.hostname)) {
    rfaLog({ act: "jd-fa-enter", idx: el && el.getAttribute && el.getAttribute("data-rfa-idx"), cls: (el && el.className || "").toString().slice(0, 30), basic: !!(el && el.closest && el.closest('[class*="formGroupItem___"]') && el.closest('[class*="formGroupItem___"]').querySelector('[data-rfa-idx="1"]')) });
  }
  if (/campus\.jd\.com/i.test(location.hostname)) {
    // v0.8.41（#380）：奖项类型等 awards 板块的 antd 下拉此前被通用分支 div-skip 跳过——
    // 因为原路由被「仅在基本信息卡内」的闸门挡住，awards 不在基本信息卡。
    // 放宽：京东所有 antd Select 统一走 jdFillAntSelectV3（basic 卡本就走它，行为零回归）。
    if (el.closest(".ant-select")) return await jdFillAntSelectV3(el, String(value), field);
    const _basic = el.closest('[class*="formGroupItem___"]');
    if (_basic && _basic.querySelector('[data-rfa-idx="1"]')) {
      const _kind = el.closest(".ant-radio-group") ? "radio" : el.closest(".ant-cascader-picker, .ant-cascader") ? "cascader" : el.closest(".ant-select") ? "antselect" : "?";
      rfaLog({ act: "jd-basic-delegate", kind: _kind, label: (field && field.label) || "", val: String(value).slice(0, 16) });
      if (el.closest(".ant-radio-group")) return await jdFillRadio(el, String(value));
      if (el.closest(".ant-cascader-picker, .ant-cascader")) return await jdFillCascader(el, String(value), field);
    }
  }
  // v0.8.40（A3 硬闸门·通用化）：亲友入职 / 预计入职 / 全日制在校 / 接受调剂 / 服从分配 等
  // 源文档【无答案】的合规·意愿类字段，无论 radio / 下拉 / 勾选 / 文本，一律跳过不填（必填也不填）。
  // 旧版只在 fillRadioGroup 里拦，下拉/勾选类会绕过被误选 —— 蔚来实测「是否有亲友入职 / 预计入职时间 /
  // 申请信息(是否接受调剂·是否全日制)」被插件代答，用户明令禁止。
  // isNoSourceDataField 已内置「腾讯最早可入职时间」例外（该字段源文档有值、须放过），不受影响。
  if (field && isNoSourceDataField(String(field.label || field.rawLabel || ""))) {
    rfaLog({ act: "fa-skip-a3-gate", label: (field && field.label) || "" });
    return false;
  }
  if (!value && value !== 0) {
    // v0.7.4（#210）：必填选择类字段（单选组/下拉/组合框）即使档案无值，也要走 fillXxx
    // 让 R4「唯一选项必选」兜底选中，满足产品铁律：单选唯一项必选，不让用户去点。
    // 仅选择类放行；文本框空值仍直接跳过，避免塞脏值。
    const _req = (field && field.required) || /\*/.test(String((field && (field.rawLabel || field.label)) || ""));
    if (!_req || !(isRadioGroup(el) || isDropdownField(el) || isCombobox(el))) return false;
  }
  // 2026-08-10（大疆）：「至今」是**复选框语义**，不是能在任何日期控件里选出来的值。
  // 原先只有 Element UI 的 fillElDatePicker 里挂了 tickToNowCheckbox（腾讯/美团），
  // Moka/大疆的 sd-Select 年月下拉走不到那条路 → 值「至今」被拿去下拉里找选项 →
  // 必然找不到 → 留空，卡片旁边现成的「至今」复选框始终没人勾。
  // 这里提到通用入口：凡是日期类字段拿到「至今」，一律改为勾同卡的复选框。
  // tickToNowCheckbox 自带幂等（已勾则直接返回 true），起止年月两格重复触发也安全。
  if (/^\s*(至今|至\s*今|今|现在|在读|在职|至现在|present|now|current)\s*$/i.test(String(value))) {
    const _lb = String((field && (field.label || field.rawLabel)) || (el && el.placeholder) || "");
    if (/时间|日期|date|至今/i.test(_lb)) {
      const ok = tickToNowCheckbox(el);
      rfaLog({ act: "tonow-generic", label: _lb.slice(0, 20), ok: ok });
      if (ok) return true;
      // v0.8.16（#288，字节社招）：并非所有站点都提供「至今」复选框。
      // 字节 jobs.bytedance.com 的经历卡结束时间旁**一个至今控件都没有**（实测全页 0 个），
      // 上面 tickToNowCheckbox 必然返回 false → 结束时间永远留空 → 站点标黄「请填写完整时间」。
      // 降级策略：确认全页确实没有任何「至今」UI 时，把「至今」翻译成**当前年月**再走正常填充。
      // 有复选框的站（腾讯 / 美团 / 大疆 / Moka）hasToNowUI=true，行为与之前完全一致，零回归。
      let hasToNowUI = false;
      try {
        hasToNowUI = Array.prototype.some.call(
          document.querySelectorAll("label,span,div,em,i,b"),
          (e) => e.children.length === 0 && /^(至今|至\s*今|今|present|now|current)$/i.test((e.textContent || "").trim())
        );
      } catch (e) {}
      if (!hasToNowUI) {
        const _d = new Date();
        const _now = _d.getFullYear() + "-" + String(_d.getMonth() + 1).padStart(2, "0");
        rfaLog({ act: "tonow-fallback-now", label: _lb.slice(0, 20), v: _now });
        return await fillFieldAsync(el, _now, field);
      }
      return false;
    }
  }
  // v0.7.1（#185）：单选组 / .el-dropdown 这类「div 即字段」必须最先拦截——
  // 它们本质是个 div（不是 input/textarea/select），若先落到下方通用容器守卫（#285），
  // 因内部无 input 会被误判「无可填元素」而静默 skip（见 #376 个人证件复填仍空：map 出值
  // 但 fill-skip-container，el-dropdown 分支永远到不了）。与单选组同理前置。
  if (isRadioGroup(el)) return await fillRadioGroup(el, value, field);
  if (isDropdownField(el)) return await fillDropdown(el, value, field);
  // v0.8.13c（#285）：容器 <div>（antd .ant-select / 飞书 ud__Select 等）被当字段扫进来时，
  // 直接对 div 调 setNativeValue 会抛「Illegal invocation」。先拆到内部真实可编辑元素再递归填充，
  // 由下层各组件分支（antd v4 / tryPickGenericSelect / 原生 select）按类型正确接管。
  if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.tagName !== "SELECT") {
    const inner = el.querySelector && el.querySelector("input:not([type=hidden]),textarea,select");
    // v0.8.x（腾讯 #fix）：Element UI 的 .el-select / .el-cascader 容器本身即为组合框，
    // 内部 input 是 readonly，拆到内部 input 会丢失组合框上下文（isCombobox(inner)=false），
    // 导致「国家/地区」「+86 区号」等 Element UI 下拉永远走不到 fillCombobox、恒为空。
    // 故自身是 Element UI 组合框容器时不拆，直接穿透到下方 isCombobox 分支用容器整体接管点选。
    const _isElCombo = /\bel-select\b|\bel-cascader\b/.test((el.className || "").toString());
    if (inner && !_isElCombo) return await fillFieldAsync(inner, value, field);
    if (!_isElCombo) {
      rfaLog({ act: "fill-skip-container", label: (field && (field.label || field.rawLabel)) || "" });
      return false;
    }
    // 是 Element UI 组合框：穿透，继续往下走 isCombobox 分支
  }
  // 看门狗：记录「当前正在填哪个字段」，卡住时能一眼看出停在哪（诊断用，无副作用）
  try {
    window.__RFA_CUR__ = {
      label: (field && (field.label || field.rawLabel)) || (el && el.placeholder) || "",
      value: String(value).slice(0, 24),
      t: Date.now(),
    };
    // v0.8.6：同步写 DOM——__RFA_CUR__ 在 isolated world，CDP 读不到（见 dumpLogToDom 注释）
    rfaMark("fill:" + (window.__RFA_CUR__.label || "?") + "=" + window.__RFA_CUR__.value);
  } catch (e) {}

  // v0.7.1（#185）：腾讯 Element UI el-cascader（当前所处地/目前就读地）与 el-date-picker（日期）专用通道，
  // 必须在通用分支之前拦截——它们的「可填元素」是普通 input，但内部是级联/日历面板，纯文本打字无效。
  if (el.closest && el.closest(".el-cascader")) {
    return await fillElCascader(el, String(value), field);
  }
  // v0.8.30（2026-08-11）：腾讯「开发语言/编程语言」是 .el-select 多选下拉，但偶尔被上面的
  // el-date 通道误抢（日志 el-date-unparsable|开发语言）。这里把开发语言类字段排除出日期通道，
  // 让它落到下方 isCombobox → fillCombobox 的 el-select 多选点选逻辑。
  if (el.closest && el.closest(".el-date-editor, .el-date-picker") && !(field && /开发语言|编程语言|tech\s*stack|technical\s*skills?/i.test(field.label || ""))) {
    return await fillElDatePicker(el, String(value), field);
  }

  // v0.8.5（#269）：Ant Design 日历 / 级联专用通道，必须排在 isCombobox 之前。
  //   · .ant-calendar-picker-input 是 readonly，isCombobox 认不出、打字也无效
  //   · .ant-cascader-input 会被下面「label 含所在/家乡」的分支抢去走飞书 fillAddressTree，
  //     那套选择器全是 ud__*，对 antd 一个都不匹配 → 网易两个地址字段恒空
  {
    const _cls = (el.className || "").toString();
    if (/ant-calendar-picker-input/.test(_cls) || (el.closest && el.closest(".ant-calendar-picker"))) {
      const cal = await tryPickAntdCalendar(el, String(value), field);
      if (cal === true) return true;
      if (cal === false) return false; // 面板开了但选不中：留空标黄，不硬打字造脏值
    }
    if (/ant-cascader-input/.test(_cls) || (el.closest && el.closest(".ant-cascader-picker, .ant-cascader"))) {
      const cas = await tryPickAntdCascader(el, String(value), field);
      if (cas === true) return true;
      if (cas === false) return false;
    }
    // v0.8.9（2026-08-08）：Ant Design **v4** 日期选择器（.ant-picker / .ant-picker-input）。
    // 与 v3（ant-calendar-picker-input）不同，v4 支持直接在输入框打字 yyyy-MM-dd / yyyy-MM 再回车提交，
    // 无需点开面板。影响面：小红书（出生年月/毕业时间）、快手（出生日期/毕业日期/起止时间）。
    if (/ant-picker-input/.test(_cls) || (el.closest && el.closest(".ant-picker"))) {
      const ok = await tryPickAntdPickerV4(el, String(value), field);
      if (ok === true) return true;
      if (ok === false) return false;
    }
    // v0.8.9（2026-08-08）：Ant Design **v4** 选择框（输入是 .ant-select-selection-search-input）。
    // 直接走通用「点开→匹配→点选」（tryPickGenericSelect 已认 .ant-select-item-option），
    // 不走飞书 ud__ 那套 fillCombobox（对 v4 选项点不中，导致快手「国家地区/专业」等恒空）。
    // 只匹配 v4 搜索输入框，不碰 v3（v3 输入是 .ant-select-search__field，走原 isCombobox 流程）。
    if (el.closest && el.closest(".ant-select") && /ant-select-selection-search-input/.test((el.className || "").toString())) {
      const gp = await tryPickGenericSelect(el, String(value), field);
      if (gp === true) return true;
      if (gp === false) return false;
    }
  }

  // 飞书/字节系自定义下拉框（学历/性别/城市等）：点击展开后选选项
  if (isCombobox(el)) {
      // v0.6.53：地址类字段（所在地点/家乡）实为飞书带搜索的 Select/Cascader（非 Tree 组件）。
      // 直接用区/县名(叶子)搜匹配项，命中即填；失败按 市/完整路径 兜底。
      const label = (field && field.label) || "";
      // v0.7.1（#185）：地址树分支是**飞书专用**（ud__tree / ud__cascader）。
      // 腾讯的「期望工作城市 / 参加面试城市」虽然标签里带「城市」，但组件是 Element UI 的
      // el-select 多选，必须交给 fillCombobox 走「点选项」逻辑。
      // 之前没排除 → 走进 fillAddressTree → 直接抛 ReferenceError，两个必填城市字段全空。
      const isElComp = !!(el.closest && el.closest(".el-select, .el-cascader"));
      // v0.8.13（字节修复）：「期望工作地点/期望工作城市/意向工作地点」是**城市多选下拉**，不是地址级联树！
      // 之前 label 命中 /城市|地点/ 被误送进 fillAddressTree（省市区级联专用）→ 城市多选永远填不上
      // （真机铁证：字节「期望工作地点」input 残留整串"北京、上海"、无任何选中项、fillCombobox 从未执行）。
      // 排除后落到 fillCombobox：multiple 兜底（期望.{0,4}工作地点）→ 顿号拆分逐个搜索选择。
      const isCityMultiPick = /期望.{0,4}(工作城市|工作地点)|意向.{0,4}(工作地点|工作城市)|期望城市|目标城市/.test(label);
      if (!isElComp && !isCityMultiPick && /所在|现居|居住|城市|地点|location|家乡|籍贯|户籍|出生地/i.test(label)) {
        return await fillAddressTree(el, String(value), field);
      }
      const _cb = await fillCombobox(el, String(value), field);
      if (_cb) return true;
      // v0.8.5（#269）：fillCombobox 整套是按飞书 ud__select 结构写的，对 Ant Design 的
      // .ant-select-dropdown 常常展开了却点不中选项（网易「国籍 / 学校」、拼多多那个无标签下拉）。
      // 失败后回落到通用「点开 → 匹配 → 点选」再试一次，命中率明显更高。
      if (el.closest && el.closest(".ant-select")) {
        const _gp = await tryPickGenericSelect(el, String(value), field);
        if (_gp === true) return true;
      }
      return _cb;
  }

  // v0.6.62：美团 mtd-date-picker（入学/毕业/开始/结束时间）走年月日历选择。
  // 必须排在 mtd-select 之前判断——两者都是「点开选」的组件，但面板结构完全不同。
  //
  // v0.6.70 关键修复：这一段还必须排在下面的 isMonthRangePicker 之前！
  // isMonthRangePicker 用 /date[-_]?picker/ 匹配 class，而美团的容器 class 恰好就叫
  // 「mtd-date-picker」，于是 18 个日期里有 17 个被飞书分支 pickMonthInPanel 抢走，
  // 静默失败且不打日志（只有值为「至今」的那个因为不匹配 \d{4}.\d{1,2} 才漏下来）。
  // 表现就是：日期全部匹配到了值，却一个都没填进去。
  if (el.closest && el.closest(".mtd-date-picker")) {
    const dt = await pickMeituanMonth(el, value, field);
    if (dt === true) return true;
    if (dt === false) return false; // 「至今」等选不出来的值：留空标黄，不硬打字
  }

  // 如果是飞书/字节系月份选择器，走专门的日历选择
  if (isMonthRangePicker(el) && /\d{4}[\.\-/]\d{1,2}/.test(String(value))) {
    return pickMonthInPanel(el, value);
  }

  // v0.6.71：美团 mtd-cascader 级联选择器（「竞赛 → 获奖大赛」用的就是它）。
  // 必须排在 mtd-select 前面：级联的内部也有 input，但弹层是多列 .mtd-cascader-menu，
  // 走 mtd-select 分支会找不到 li.mtd-select-item 而静默失败。
  if (el.closest && el.closest(".mtd-cascader")) {
    const cas = await tryPickMtdCascader(el, value, field);
    if (cas === true) return true;
    if (cas === false) return false; // 级联里没有这个赛事：留空标黄，交给用户自己选
  }

  // v0.6.58：美团 mtd-select 下拉框专用通道。
  // 只要元素落在 .mtd-select 容器里就走它——不再依赖 label 白名单，
  // 因为「是否全日制/成绩排名/工作类型」这些新字段也可能是下拉，白名单永远列不全。
  if (el.closest && el.closest(".mtd-select")) {
    const mtd = await tryPickMtdSelect(el, value, field);
    if (mtd === true) return true;
    if (mtd === false) return false; // 展开了但没匹配项：保持空白，不要硬打字造出脏值
  }

  // ── v0.8.5（#268 · Moka 系「假填充」根治）────────────────────────────────────
  // 真机 CDP 实测（速腾 robosense）结论，三条都反直觉，务必别再改回去：
  //   ① Moka 自研 sd-Select 选中后 **不把值写回 input.value**，而是渲染成字段盒内的
  //      第二行文本，同时把 input 的 placeholder 从「请选择」清成空串。
  //   ② tryPickGenericSelect 里 v0.7.8 早就补齐了 sd-* 弹层选择器，但那个函数
  //      **只在 isMeituan() 分支被调用过** —— Moka 从来没走到过它。
  //   ③ 于是 Moka 的所有下拉都掉到 tryFillField 硬打字：性别/最高学历 看着有字
  //      （其实是没提交的输入残留，placeholder 仍为「请选择」），而
  //      听说/读写/工作经验 连打的字都会在失焦时被组件清掉 → 5 家站长期 83~88%。
  // 修复：把 sd-Select 显式路由到「点开→匹配→点选」，并先清掉上一轮的打字残留，
  //      否则残留文本会把候选列表过滤成空。
  // v0.8.7（#276）：Moka 日历 sd-picker-input（出生日期）必须排在 sd-Select 之前——
  // 它的外层同样挂着 sd-Dropdown-container，会被下面那条选择器抢走走成「找选项」，
  // 而日历面板里根本没有 sd-Menu-content-item，结果静默失败、出生日期恒空。
  if (el.closest && el.closest('[class*="sd-picker-input"]')) {
    const dp = await fillMokaDatePicker(el, String(value), field);
    if (dp === true) return true;
    if (dp === false) return false; // 面板开了但选不到：留空标黄，不硬打字
  }

  if (
    el.closest &&
    el.closest('[class*="apply-field"][class*="Select-"], [class*="sd-Select"], [class*="sd-Dropdown"]')
  ) {
    try {
      if (el.tagName === "INPUT" && el.value) {
        const _setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        _setter.call(el, "");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } catch (e) {}
    const sd = await tryPickGenericSelect(el, value, field);
    if (sd === true) return true;
    if (sd === false) return false; // 弹层开了但没匹配项：留空标黄，不要硬打字造脏值
  }

  // ── v0.8.6（#272 · Moka 搜索型输入框）─────────────────────────────────────────
  // Moka 的「学校名称 / 专业名称 / 公司名称」不是普通文本框，而是**远程搜索下拉**：
  // 打字会异步拉候选，**不点候选项就等于没填 —— 失焦瞬间 input.value 被组件清成空串**。
  // 真机实测（robosense，见 /tmp/batch/e_moka_ac.js）：
  //   setNativeValue(inp,'示例学校') → 1.2s 后弹出
  //     示例学校 / 示例学校法学院 / 示例学校医学院 / 示例学校 / 没有找到学校？ / 添加学校全称
  //   然后 blur → inp.value === ""   ← 就是「映射明明取到了示例学校、页面却始终空白」的真相
  // 候选项类名是 **sd-Menu-item-xxxx**，注意它和 tryPickGenericSelect 里已覆盖的
  // `sd-Menu-content-item` **不是同一个类名**（少了 content-），所以那边一个都匹配不到。
  // 另：「没有找到学校？」「添加学校全称」是兜底入口不是真选项，必须排除，
  // 否则会把学校名填成「添加学校全称」这种垃圾值。
  if (
    el.tagName === "INPUT" &&
    el.closest &&
    el.closest('[class*="apply-field"]') &&
    /mokahr\.com|careers\.dji\.com/i.test(location.hostname)
  ) {
    const ac = await tryPickMokaAutocomplete(el, String(value), field);
    if (ac === true) return true;
    // ac === null → 打字后没有候选弹层，说明是普通文本框，继续走下面的通用文本填充
  }

  // v0.6.57：其它自研站把下拉框渲染成普通 input，先尝试「点击展开→选选项」，
  // 失败（无弹层）再回落到普通文本输入。避免把「性别/学历/工作类型」等当纯文本硬填。
  if (isMeituan() && MEITUAN_SELECT_LABEL_RE.test((field && field.label) || "")) {
    const picked = await tryPickGenericSelect(el, value, field);
    if (picked === true) return true;
    if (picked === false) return false; // 有弹层但无匹配项，不再打字
  }

  return tryFillField(el, value, field);
}

function fillField(el, value, field) {
  if (!value && value !== 0) return false;
  if (isCombobox(el)) return fillCombobox(el, String(value), field);
  return tryFillField(el, value, field);
}

// 标准化下拉框匹配：支持学历、学习形式、语言等常见选项
function findSelectOption(opts, valStr, label) {
  const v = String(valStr).trim().toLowerCase();
  if (!v) return null;
  const lb = (label || "").toLowerCase();
  if (/国家\/地区|区号|如您是中国大陆|手机|86/.test(lb) || /^\+\d/.test(v)) {
    if (!window.__RFA_DBG__) window.__RFA_DBG__ = [];
    window.__RFA_DBG__.push({ ts: Date.now(), stage: "fso-IN", label: lb, tok: v, nopts: (opts || []).length });
  }

  // 1) 完全匹配
  let m = opts.find((o) => o.text.trim().toLowerCase() === v);
  if (m) return m;
  m = opts.find((o) => o.value.trim().toLowerCase() === v);
  if (m) return m;

  // 2) 学历标准化匹配
  const isDegree = /学历|学位|degree/.test(lb);
  if (isDegree) {
    const aliases = {
      本科: ["本科", "大学本科", "学士", "bachelor", "bachelors"],
      硕士: ["硕士", "硕士研究生", "研究生", "master", "masters"],
      博士: ["博士", "博士研究生", "doctor", "phd", "doctorate"],
      大专: ["大专", "大学专科", "专科", "associate"],
    };
    // v0.6.70 修复「硕士被填成博士研究生」：
    // 硕士的别名里含「研究生」，旧代码 opts.find(text.includes("研究生")) 会先命中
    // 排在前面的「博士研究生」。现在加两道约束：
    //   ① 异档禁止——想要硕士就绝不能选到含「博士/本科/专科」的选项；
    //   ② 同档里按精确度排序，优先「完全相等 > 以档位词开头 > 仅包含」。
    const CONFLICT = {
      本科: /博士|硕士|专科|大专|高中|中专|mba|emba/i,
      硕士: /博士|本科|专科|大专|高中|中专/,
      博士: /硕士|本科|专科|大专|高中|中专/,
      大专: /博士|硕士|本科|高中|中专/,
    };
    for (const [key, list] of Object.entries(aliases)) {
      const hit = list.some((a) => v.includes(a) || a.includes(v));
      if (!hit) continue;
      const bad = CONFLICT[key];
      const cands = opts
        .filter((o) => list.some((a) => o.text.toLowerCase().includes(a)))
        .filter((o) => !bad || !bad.test(o.text));
      if (!cands.length) continue;
      const score = (o) => {
        const t = o.text.trim();
        if (t === key) return 3;
        if (t.indexOf(key) === 0) return 2;
        if (t.indexOf(key) > -1) return 1;
        return 0;
      };
      cands.sort((a, b) => score(b) - score(a));
      return cands[0];
    }
  }

  // 2.5) v0.6.70：美团实测的三类「标签和值对不上」的下拉，做语义映射。
  //      这些字段直接按值匹配永远匹配不到，之前全部落空标黄。
  {
    const texts = opts.map((o) => (o.text || "").trim());
    const pickBy = (re) => opts.find((o) => re.test((o.text || "").trim())) || null;

    // (0) v0.7.1（#185）：手机号国家/区号下拉（腾讯 247 项）。传进来的值是「+86」这种纯区号，
    //     直接文本匹配对不上「中国 +86」「中国香港 +852」这类带国家名的选项。
    //     必须排除港澳台条目——「中国香港 +852」同样以「中国」开头，模糊匹配极易串台。
    // v0.8.20：字节/飞书系的区号选择器是 formily 自定义组件，**没有任何文字 label**
    // （实测 label 抓到空串），旧的「按 label 命中」判定完全失效 → 落到通用模糊匹配，
    // 被错选成「+1340」这类邻近条目（用户实测字节显示 +1340）。
    // 改为**标签无关的选项形态判定**：候选项里出现 ≥3 个「+区号」形态条目，
    // 即可断定这是国家区号下拉（正常业务下拉不会有一堆 +数字），强制走区号逻辑。
    const ccLike = opts.filter((o) => /[+＋]\s*\d{1,4}(?!\d)/.test(String(o.text || ""))).length;
    const looksAreaCode = ccLike >= 3;
    if (
      /(如您是中国大陆籍|区号|国家.*地区|country\s*code)/i.test(lb) ||
      /^\+\d{1,4}$/.test(v) ||
      looksAreaCode
    ) {
      // 区号下拉一律以档案手机号自带国家码为准；⚠️ 无国家码一律不选（铁律，用户 2026-08-20）。
      // 注意：此处不能用传进来的 valStr（字节把身份证号/姓名等值也可能传进来），
      // 只在 valStr 确实是纯区号时才采信它。
      const vIsCc = /^[+＋]?\d{1,4}$/.test(String(valStr).trim());
      const rawPhone = String(
        ((CURRENT_PROFILE && CURRENT_PROFILE.basic && CURRENT_PROFILE.basic.phone) || "")
      ).replace(/[\s\-()]/g, "");
      // v0.8.13：用安全提取函数（v0.8.20 的 /^\+(\d{1,4})/ 贪婪会把手机号开头吞进国家码）
      const phoneCc = extractCcFromPhone(rawPhone);
      // ⚠️ 铁律：档案手机号没有国家码（非 + 开头）→ 不选区号下拉，返回 null 留空标黄让用户手动确认，
      //    绝不默认「+86」、绝不猜（避免 +1340 类错选）。
      // v0.8.13：用户在面板明确设置了区号（RFA_USER_PHONE_CC，如 "86"）→ 按用户设置选（用户明确选择=有数据）。
      if (!vIsCc && !phoneCc && !RFA_USER_PHONE_CC) return null;
      const cc = vIsCc
        ? (String(valStr).match(/\d{1,4}/) || ["86"])[0]
        : (phoneCc || RFA_USER_PHONE_CC);
      const ccRe = new RegExp("(^|[^\\d])\\+?" + cc + "(?![\\d])");
      const cands = opts.filter((o) => ccRe.test((o.text || "").trim()));
      if (cands.length) {
        if (cc === "86") {
          const mainland = cands.filter((o) => !/香港|澳门|台湾|hong\s*kong|macao|macau|taiwan/i.test(o.text));
          // 精确优先：先「中国大陆 +86」，再退「中国 +86」，最后普通大陆条目
          const exact =
            mainland.find((o) => /^中国大陆\s*[（(]?\+?86/.test((o.text || "").trim())) ||
            mainland.find((o) => /^中国\s*[（(]?\+?86/.test((o.text || "").trim())) ||
            mainland.find((o) => /中国大陆/.test((o.text || "").trim()));
          return exact || mainland[0] || cands[0];
        }
        return cands[0];
      }
      // 兜底：opts 未提取（腾讯等站）时，86 区号直接返回「中国 +86」（档案为中国大陆）。
      // 注意真实选项文本是「中国 +86」（中国 与 +86 之间有空格），必须带空格才能精确匹配上。
      if (cc === "86") return "中国 +86";
      // 确认是区号下拉（label 命中 / 值是纯区号 / 选项形态像区号），但没匹配到目标区号：
      // 宁可返回 null（留空标黄让用户点），也绝不穿透到通用模糊匹配去错选「+1340」。
      if (/^\+\d{1,4}$/.test(v) || looksAreaCode || /(如您是中国大陆籍|区号|国家.*地区|country\s*code)/i.test(lb))
        return null;
    }

    // (a) 「证件号码*」其实是证件类型下拉（选项：居民身份证/中国护照/港澳居民来往内地通行证…），
    //     但传进来的值是身份证号本身。改用档案里的证件类型；没有就按号码格式推断。
    if (/证件|证照|id\s*type|证件类型|证件号/i.test(lb) && texts.some((t) => /身份证|护照|通行证|居住证/.test(t))) {
      const basic = (CURRENT_PROFILE && CURRENT_PROFILE.basic) || {};
      const idType = String(basic.idType || "").trim();
      const raw = String(valStr).trim();
      const looksMainlandId = /^\d{17}[\dXx]$/.test(raw) || /^\d{15}$/.test(raw);
      const want2 = idType || (looksMainlandId ? "身份证" : "");
      if (/护照/.test(want2)) return pickBy(/^中国护照$/) || pickBy(/护照/);
      if (/港澳.*通行证|回乡证/.test(want2)) return pickBy(/港澳居民来往内地通行证/);
      if (/台湾.*通行证|台胞证/.test(want2)) return pickBy(/台湾居民来往大陆通行证/);
      if (/香港身份证/.test(want2)) return pickBy(/香港身份证/);
      if (/台湾身份证/.test(want2)) return pickBy(/台湾身份证/);
      if (/港澳.*居住证/.test(want2)) return pickBy(/港澳居民居住证/);
      if (/台湾.*居住证/.test(want2)) return pickBy(/台湾居民居住证/);
      if (/身份证/.test(want2)) return pickBy(/^居民身份证$/) || pickBy(/居民身份证/);
      return null;
    }

    // (a2) v0.8.20：国家/地区下拉归一化。档案 nationality/country = "中国"，但腾讯等站的
    //      选项是「中国大陆 / 中国香港 / 中国澳门 / 中国台湾 / 美国…」。"中国" 是前四项的公共子串，
    //      模糊匹配会串台（可能选到"中国香港"）或整体落空。这里强制把"中国/中国大陆/大陆"
    //      归一到「中国大陆」选项（无该选项时退回纯"中国"精确项）。
    // v0.8.x（#cn86fix2）：放宽判定——【标签命中即可】进国家/地区归一化分支。
    // 旧逻辑要求 label 命中「且」选项文本里出现「中国大陆/中国香港…」才进块；
    // 但腾讯国家/地区下拉在 matchField 阶段拿到的 opts/texts 为空（面板复用/elScope 锁定），
    // 导致 isCountryField=false → 兜底到不了 → 通用匹配返 null → 整格空着不填。
    // 标签「国家/地区*」是 unambiguous 的国家字段，仅凭标签即可进块，不再卡 texts。
    const isCountryField =
      /国家|地区|国籍|country|region|nationality/i.test(lb) ||
      texts.some((t) => /中国大陆|中国香港|中国澳门|中国台湾|大陆|hong\s*kong|taiwan|macao/i.test(t));
    if (isCountryField) {
      const wantCn = /^(中国|中国大陆|大陆|中华人民共和国|china|prc)$/i.test(String(valStr).trim());
      if (wantCn) {
        return (
          pickBy(/^中国大陆$/) ||
          pickBy(/中国大陆/) ||
          pickBy(/^中国$/) ||
          pickBy(/^大陆$/) ||
          // 仍找不到就选一个「以中国开头且非港澳台」的条目
          (opts.find(
            (o) => /^中国/.test((o.text || "").trim()) && !/香港|澳门|台湾/.test(o.text)
          ) || null) ||
          "中国" // 兜底：腾讯等站 opts 提取为空时，档案中国籍直接填「中国」（选项文本即"中国"）
        );
      }
      // 非中国国籍：按值精确/包含匹配，匹配不上宁可留空也不乱选
      return pickBy(new RegExp("^" + String(valStr).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$")) ||
        opts.find((o) => (o.text || "").includes(String(valStr).trim())) || null;
    }

    // (b) 「实验室*」在美团是实验室【级别】下拉（省部级/国家级/市级/校级/其他/无），
    //     传进来的却是实验室名字。从名字里推断级别；名字里没线索就选「其他」。
    //     （实验室名字本身由旁边的「请输入实验室」文本框承载，已能正确填入。）
    if (/实验室|课题组|lab/i.test(lb) && texts.some((t) => /^(省部级|国家级|市级|校级)$/.test(t))) {
      const name = String(valStr);
      if (!name.trim()) return pickBy(/^无$/);
      if (/国家|国重|国防/.test(name)) return pickBy(/^国家级$/);
      if (/省|部级|教育部|部属/.test(name)) return pickBy(/^省部级$/);
      if (/市/.test(name)) return pickBy(/^市级$/);
      if (/校|学院|大学/.test(name)) return pickBy(/^校级$/);
      return pickBy(/^其他$/);
    }

    // (c) 「语言水平*」的选项是沟通场景（母语／双语/无障碍商务沟通/商务会话/日常会话/入门），
    //     而简历里写的是「精通/熟练/良好」这类等级词，直接匹配一个都对不上。
    if (/水平|等级|熟练|程度|掌握|level|proficiency/i.test(lb) && texts.some((t) => /母语|商务会话|日常会话/.test(t))) {
      const w = String(valStr);
      if (/母语|native|双语/i.test(w)) return pickBy(/母语|双语/);
      if (/精通|proficient|fluent|流利/i.test(w)) return pickBy(/无障碍商务沟通/) || pickBy(/商务会话/);
      if (/熟悉|熟练|良好|advanced|good|familiar/i.test(w)) return pickBy(/商务会话/);
      if (/了解|略懂|略知|初级/i.test(w)) return pickBy(/日常会话/) || pickBy(/入门/);
      if (/中等|一般|日常|intermediate/i.test(w)) return pickBy(/日常会话/);
      if (/入门|基础|beginner|basic/i.test(w)) return pickBy(/入门/);
      return null;
    }

    // (c2) 【2026-08-10 大疆实测补的反向分支】(c) 只处理了「站点选项是场景词、简历值是等级词」，
    //      大疆/Moka 的「掌握程度 / 听说 / 读写」恰好**反过来**：
    //          站点选项 = 一般 / 良好 / 熟练 / 精通（纯等级词）
    //          简历值   = 无障碍商务沟通 / 母语（场景词，见源文档 languages[].level）
    //      两边一个字都对不上 → findSelectOption 返回 null → 三个下拉长期留白。
    //      实测大疆语言板块 8 个控件因此全空，是 84%→96% 最大的一块缺口。
    //      映射按「等级阶梯」保守取值：母语→精通、无障碍商务沟通→熟练（IELTS 7.5 这种写精通偏满，
    //      写熟练更经得起追问）、商务会话→熟练、日常会话/入门→一般。
    if (
      /水平|等级|熟练|程度|掌握|听说|读写|口语|书面|level|proficiency/i.test(lb) &&
      texts.some((t) => /^(精通|熟练|良好|一般)$/.test(t.trim()))
    ) {
      const w = String(valStr);
      const ladder = (...res) => { for (const re of res) { const h = pickBy(re); if (h) return h; } return null; };
      if (/母语|native|双语|bilingual/i.test(w)) return ladder(/^母语$/, /^精通$/, /^熟练$/);
      if (/^精通$|proficient|expert/i.test(w)) return ladder(/^精通$/, /^熟练$/);
      if (/无障碍|流利|fluent|商务沟通/i.test(w)) return ladder(/^熟练$/, /^精通$/, /^良好$/);
      if (/商务会话|熟练|advanced|working/i.test(w)) return ladder(/^熟练$/, /^良好$/);
      if (/良好|good|熟悉|familiar/i.test(w)) return ladder(/^良好$/, /^熟练$/);
      if (/日常会话|一般|中等|intermediate|conversational/i.test(w)) return ladder(/^一般$/, /^良好$/);
      if (/入门|基础|了解|略懂|beginner|basic|elementary/i.test(w)) return ladder(/^一般$/, /^良好$/);
      return null;
    }
  }

  // 3) 学习形式/培养方式标准化匹配
  const isEduType = /学习形式|培养方式|全日制|非全日制|统招|自考|成人教育|网络教育|edutype/.test(lb);
  if (isEduType) {
    const aliases = {
      全日制: ["全日制", "统招", "full-time", "fulltime"],
      非全日制: ["非全日制", "part-time", "parttime", "在职"],
      自考: ["自考", "自学考试", "self-study"],
      成人教育: ["成人教育", "成教", "成人高考", "成人"],
      网络教育: ["网络教育", "网教", "远程教育"],
    };
    for (const [key, list] of Object.entries(aliases)) {
      const hit = list.some((a) => v.includes(a) || a.includes(v));
      if (hit) {
        m = opts.find((o) => list.some((a) => o.text.toLowerCase().includes(a)));
        if (m) return m;
      }
    }
  }

  // 4) 语言/语种标准化匹配
  const isLang = /语言|语种|language|外语/.test(lb);
  if (isLang) {
    const aliases = {
      英语: ["英语", "英文", "english", "en"],
      日语: ["日语", "日文", "japanese", "jp", "日本语"],
      韩语: ["韩语", "韩文", "korean", "kr"],
      法语: ["法语", "法文", "french", "fr"],
      德语: ["德语", "德文", "german", "de"],
      西班牙语: ["西班牙语", "西语", "spanish", "es"],
      俄语: ["俄语", "俄文", "russian", "ru"],
      普通话: ["普通话", "中文", "汉语", "chinese", "cn"],
      粤语: ["粤语", "cantonese"],
    };
    for (const [key, list] of Object.entries(aliases)) {
      const hit = list.some((a) => v.includes(a) || a.includes(v));
      if (hit) {
        m = opts.find((o) => list.some((a) => o.text.toLowerCase().includes(a)));
        if (m) return m;
      }
    }
  }

  // 4.5) 时长/数量短语规整：「6个月及以上 / 3天以上 / 5天+」→「6个月 / 3天 / 5天」再走包含匹配。
  // 简历常写「6个月及以上」，站点选项却叫「6个月以上」——剥掉后缀即可命中同一项。仅当 value 末端带此类后缀才生效。
  // v0.7.1（#185）：「6个月及以上」这类值要先按「以上」语义找，再退化成裸数字包含。
  // 踩过的坑：直接剥成「6个月」再 includes，会命中排在前面的「3-6个月」——腾讯实习时长就这样填错过。
  const hasPlus = /(及以上|或以上|以上|起|plus|more|\+)\s*$/i.test(v);
  const normV = v.replace(/(及以上|或以上|以上|起|plus|more|\+)\s*$/i, "").replace(/\s+/g, "").trim();
  if (normV && normV !== v.replace(/\s+/g, "").trim()) {
    if (hasPlus) {
      // 先找同样带「以上/+」语义、且含同一数字量的选项（如「6个月以上」）
      m = opts.find((o) => {
        const t = o.text.replace(/\s+/g, "");
        return /以上|及以上|\+|起/.test(t) && t.includes(normV);
      });
      if (m) return m;
      // 再找「数字在开头」的选项，避免命中「3-6个月」这种把目标数字当区间上界的
      m = opts.find((o) => o.text.replace(/\s+/g, "").indexOf(normV) === 0);
      if (m) return m;
    }
    m = opts.find((o) => o.text.replace(/\s+/g, "").includes(normV));
    if (m) return m;
  }

  // 4.9) v0.7.6（#256）：城市/地点类下拉的「名实不符」归一化。
  //   实测坑：档案写「深圳市」，腾讯期望工作城市的选项却叫「深圳总部」；
  //   档案写「北京市」，选项叫「北京」。裸包含两边都对不上（'深圳总部'.includes('深圳市')=false，
  //   '深圳市'.includes('深圳总部')=false），整个字段就空着。
  //   这里把两边同时剥掉行政/办公后缀再比，只在城市/地点类标签下启用，避免误伤别的下拉。
  if (/城市|地点|地区|工作地|所在地|办公|base|city|location/i.test(lb)) {
    const cityNorm = (s) => {
      let t = String(s || "").replace(/[\s()（）]/g, "");
      for (let i = 0; i < 2; i++) {
        t = t.replace(/(总部|分部|园区|研发中心|运营中心|中心|基地|办公室|办公地|市辖区|特别行政区|自治区|自治州|地区|省|市)$/, "");
      }
      return t;
    };
    const nv = cityNorm(v);
    if (nv && nv.length >= 2) {
      m = opts.find((o) => cityNorm(o.text) === nv);
      if (m) return m;
      m = opts.find((o) => cityNorm(o.text).indexOf(nv) === 0);
      if (m) return m;
      m = opts.find((o) => { const t = cityNorm(o.text); return t.length >= 2 && nv.indexOf(t) === 0; });
      if (m) return m;
    }
  }

  // 5) 通用：忽略空白后互相包含
  m = opts.find((o) => o.text.replace(/\s+/g, "").includes(v.replace(/\s+/g, "")));
  if (m) return m;
  m = opts.find((o) => v.replace(/\s+/g, "").includes(o.text.replace(/\s+/g, "")));
  if (m) return m;

  // 6) 通用：关键词拆分匹配
  const keywords = v.replace(/\s+/g, "").split(/[\|\/，,；;]/).filter(Boolean);
  m = opts.find((o) => keywords.some((k) => o.text.replace(/\s+/g, "").includes(k)));
  if (m) return m;

  // 7) 忽略大小写英文匹配
  m = opts.find((o) => o.text.toLowerCase() === v);
  if (m) return m;

  return null;
}

function highlight(el, status) {
  // v0.6.49/v0.6.52：用户要求去掉绿色高亮，避免误以为已填；只保留黄色高亮提示未填字段。
  // v0.6.55：统一所有黄色高亮样式并加 !important，防止页面 focus/open 等状态样式覆盖。
  // v0.6.56：彻底放弃 outline，改用 box-shadow 做统一黄色高亮框——outline 在不同元素（input vs 下拉容器）上粗细/圆角表现差异大，box-shadow 能保证所有字段上的黄框粗细完全一致。
  if (status === "ok") {
    el.style.setProperty("box-shadow", "", "");
  } else {
    el.style.setProperty("box-shadow", "0 0 0 2px #EF9F27", "important");
  }
}

// ── v0.8.40（2026-08-14 · A2）「按 DOM 真实状态全量重绘标黄」──────────────────────
// 用户复核京东/安踏时反复报「我明明填对了，你还给我标黄」。根因不是判空判错，而是
// **旧黄框没人擦**：填充中途某一轮 fillFieldGuarded 返回 ok=false（例如京东基本信息卡
// 由 jdFillBasicCard 专管、主循环 continue 跳过 → idx 没进 filledIdx → cascadeRefill
// 误判 pending 再填一次并 ok=false）就会打上黄框；等最终步只给「空字段」补黄时，
// 这些已填字段不再被处理，黄框就永久留在页面上。
//
// 解法：不再做「增量补黄」，改成**以当前 DOM 真实状态为唯一依据的全量重绘**：
//   已填 → highlight(el,"ok") 擦黄；空 → highlight(el,"warn") 打黄。
// 幂等，可在清卡前后各调一次；对全站通用（京东 antd / 安踏·大疆 Moka sd-Select / 飞书系）。
function repaintWarnByRealState(phase) {
  let warnN = 0, clearedStale = 0, okN = 0;
  let els = [];
  try {
    els = getAllFillableEls();
  } catch (e) {
    rfaLog({ act: "warn-repaint-error", phase: phase || "", err: String(e && e.message) });
    return { warn: 0, ok: 0, clearedStale: 0 };
  }
  for (const el of els) {
    let filled = false;
    try {
      filled = isFieldFilled(el);
    } catch (e) {
      filled = false;
    }
    if (filled) {
      // 只统计「确实残留黄框」的数量，方便日志里量出这次到底擦掉了多少误标黄
      if (el.style && /239,\s*159,\s*39|EF9F27/i.test(el.style.boxShadow || "")) clearedStale++;
      highlight(el, "ok");
      okN++;
    } else {
      highlight(el, "warn");
      warnN++;
    }
  }
  rfaLog({ act: "warn-repaint", phase: phase || "", warn: warnN, ok: okN, clearedStale });
  return { warn: warnN, ok: okN, clearedStale };
}

function formatRange(start, end) {
  if (start && end) return `${start}-${end}`;
  return start || end || "";
}

// v0.6.62：把「CET-6 621」「雅思 7.5」「TOEFL 105」这类语言成绩拆成 {exam, score}。
// 招聘站常把「考试名称」和「分数」拆成两个框，整串塞进分数框会触发纯数字校验失败。
function splitLangScore(raw) {
  let s = String(raw || "").trim();
  if (!s) return { exam: "", score: "" };
  // 0) 一栏里写了多个证书（「CET-4 598；CET-6 621；雅思 7.5」）时只取第一个，
  //    否则末尾数字会被当分数、前面一长串全被当考试名塞进框里。
  s = s.split(/[；;、,，]/)[0].trim();
  // 括号补充说明去掉：「JLPT N1（180/180，满分）」→「JLPT N1」
  s = s.replace(/[（(][^）)]*[）)]\s*$/, "").trim();
  if (!s) return { exam: "", score: "" };
  // 1) 有空格/冒号分隔：「CET-6 621」→ CET-6 / 621
  let m = s.match(/^(.*?)[\s:：]+(\d+(?:\.\d+)?)\s*分?$/);
  if (m && m[1].trim()) return { exam: m[1].trim(), score: m[2] };
  // 2) 无分隔但分数是小数或两位以上整数：「雅思7.5」→ 雅思 / 7.5
  //    （限制两位以上是为了不误拆「CET-6」这种考试名自带单个数字的情况）
  m = s.match(/^([^\d]*[^\d\-])(\d+\.\d+|\d{2,})\s*分?$/);
  if (m && m[1].trim()) return { exam: m[1].trim(), score: m[2] };
  // 3) 纯数字就是分数，否则整串当考试名（如「CET-6」「专业八级」）
  if (/^\d+(\.\d+)?$/.test(s)) return { exam: "", score: s };
  return { exam: s, score: "" };
}

// v0.6.71：把用户写法各异的考试名归一到招聘站下拉里的标准写法。
// 美团「语言考试」下拉实测只有 8 个选项：CET-4 / CET-6 / TEM-4 / TEM-8 / TOEFL / IELTS / GRE / 其他。
// 用户在文档里写「四级」「六级」「雅思」「托福」「日语能力考试 N1」「普通话」都要能对上，
// 对不上的（日语 / 普通话等下拉里根本没有的考试）统一归到「其他」，分数照填。
const LANG_EXAM_ALIASES = [
  [/cet[\s\-_]*4|大学英语四级|英语四级|^四级$|四级考试/i, "CET-4"],
  [/cet[\s\-_]*6|大学英语六级|英语六级|^六级$|六级考试/i, "CET-6"],
  [/tem[\s\-_]*4|专业四级|专四/i, "TEM-4"],
  [/tem[\s\-_]*8|专业八级|专八/i, "TEM-8"],
  [/toefl|托福/i, "TOEFL"],
  [/ielts|雅思/i, "IELTS"],
  [/^gre$|\bgre\b/i, "GRE"],
];
function normalizeLangExam(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  for (const [re, std] of LANG_EXAM_ALIASES) if (re.test(s)) return std;
  // 已经是标准写法就原样返回；其余（JLPT / 普通话等级测试 …）交给「其他」
  if (/^(CET-4|CET-6|TEM-4|TEM-8|TOEFL|IELTS|GRE|其他)$/i.test(s)) return s.toUpperCase() === "其他" ? "其他" : s;
  return "其他";
}

// ---- v0.6.57：美团（自研 / antd 系）站点适配 ----
function isMeituan() {
  try { return /meituan\.com/.test(location.hostname); } catch (e) { return false; }
}

// 从「国家/省/市/区」(如 中国大陆/四川省/成都市/锦江区) 提取「市」
function extractCity(loc) {
  if (!loc) return "";
  const parts = String(loc).split("/").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return "";
  const withCity = parts.find((p) => /市/.test(p) && !/区市|自治州|地区/.test(p));
  if (withCity) return withCity;
  if (parts.length >= 4) return parts[2];   // 国家/省/市/区
  if (parts.length === 3) return parts[1];   // 省/市/区（旧格式）
  return parts[parts.length - 2] || parts[0];
}

// 美团里「看起来是普通 input、实则点击展开的下拉框」字段（需要点开再选）
const MEITUAN_SELECT_LABEL_RE =
  /性别|学历|学位|工作类型|语言水平|证件类型|培养方式|学习形式|全日制|学制|政治面貌|婚姻|国籍|民族/;

// 美团专属字段映射；返回 undefined 表示交给通用 matchField 继续处理
// v0.6.58：证件类型 / 工作类型 已提升为全站通用规则（见 matchField），此处只保留美团特有的「城市取到市级」。
function matchFieldMeituan(field, profile) {
  const basics = profile.basic || {};
  const label = (field.label || "").toLowerCase();
  if (/城市|所在地|现居|居住/.test(label)) return extractCity(basics.location);
  return undefined;
}

// ---- v0.6.72：美团 mtd-cascader 级联选择器实现（竞赛「获奖大赛」） ----
// 结构以实测为准（probe-cascader / probe-cascader2），不是猜的：
//   <div class="mtd-cascader mtd-cascader-large">
//     <div class="mtd-select-filter …">   ← **真正的触发器**，容器内没有任何 input
//   点开后 body 追加：
//     .mtd-cascader-popup-wrapper > .mtd-cascader-menus-wrapper > .mtd-cascader-menus
//        > ul.mtd-cascader-menu > div > li.mtd-cascader-menu-item
//   共两级：一级=赛事（ACM Final / ACM Regional / IOI / NOI / Code Jam / Top Coder /
//   Code Forces / KDD Cup / Hacker Cup / CodeM），二级=金牌 / 银牌 / 铜牌。
//   点到叶子后弹层**自动关闭**，选中值写进 .mtd-select-filter-label，形如「ACM Regional/金牌」。
//
// v0.6.71 一直报 mtd-cascader-nopopup 的真因：点的是 .mtd-cascader 容器本身，
// 而 React 的 onClick 挂在子节点 .mtd-select-filter 上——DOM 事件只冒泡不下传，弹层根本没开。
//
// 策略：一级按赛事别名表匹配，二级按奖牌档次匹配；匹配不到就关掉弹层返回 false，
// 绝不硬打字，也绝不随便点第一项 —— 宁可留空标黄让用户自己选，也不造一个假履历。
function cascaderMenus() {
  return Array.from(document.querySelectorAll("ul.mtd-cascader-menu, .mtd-cascader-menu")).filter(isVisible);
}
function cascaderItemsIn(menu) {
  return Array.from(menu.querySelectorAll("li.mtd-cascader-menu-item, li")).filter(isVisible);
}
// 触发器候选：.mtd-select-filter 排第一（实测唯一有效的那个）
function cascaderTrigger(box) {
  return [
    box.querySelector(".mtd-select-filter"),
    box.querySelector("[role='button']"),
    box.querySelector(".mtd-select"),
    box.querySelector("input"),
    box,
  ].filter(Boolean);
}

// 站点一级选项 ←→ 简历里可能的赛事写法。这张表同时充当「美团支持的赛事白名单」：
// 表里匹配不上的竞赛（如数学建模、互联网+），美团这个级联根本没有对应项，
// 建了卡也只能空着，而「获奖大赛」是必填，空着反而卡住保存——所以干脆不给它建卡。
// 这类竞赛在「荣誉」板块已经以「赛事名 + 奖项」的形式完整体现，信息没有丢。
const MTD_CONTEST_ALIASES = [
  { opt: /acm\s*final/i, re: /(acm|icpc)[\s\S]*(final|总决赛|全球总决赛|世界总决赛)/i },
  { opt: /acm\s*regional/i, re: /(acm|icpc)[\s\S]*(regional|区域赛|亚洲区|亚洲赛)/i },
  { opt: /^ioi$/i, re: /\bioi\b|国际信息学奥林匹克/i },
  { opt: /^noi$/i, re: /\bnoi\b|全国青少年信息学奥林匹克|信息学奥赛/i },
  { opt: /code\s*jam/i, re: /code\s*jam|谷歌编程挑战/i },
  { opt: /top\s*coder/i, re: /top\s*coder/i },
  { opt: /code\s*forces/i, re: /code\s*forces/i },
  { opt: /kdd\s*cup/i, re: /kdd\s*cup/i },
  { opt: /hacker\s*cup/i, re: /hacker\s*cup|黑客杯/i },
  { opt: /^codem$/i, re: /\bcodem\b|美团[\s\S]*(编程|算法|程序设计)/i },
];
// 一条简历竞赛能否落进站点赛事列表
function contestSupportedByMtd(item) {
  const s = [item && item.name, item && item.level].filter(Boolean).join(" ");
  if (!s) return false;
  return MTD_CONTEST_ALIASES.some((a) => a.re.test(s));
}
// 页面上的「获奖大赛」是不是美团那种纯级联（是 → 竞赛列表要按白名单过滤）
function mtdContestCascaderPresent() {
  if (document.querySelector("[class*='competition'] .mtd-cascader")) return true;
  // 兜底：getSectionNeeded 在「展开卡片之前」就要算条数，那时卡片（连同级联）还没渲染。
  // 只要是美团、且页面上有竞赛板块容器，就按级联处理——美团这个字段只有级联一种形态。
  try {
    return isMeituan() && !!document.querySelector("[class*='competition_edit']");
  } catch (e) {
    return false;
  }
}
// 供 getSectionNeeded / matchField 共用：保证「建几张卡」和「第 i 张卡填谁」用的是同一个列表
function contestListForPage(profile) {
  const list = (profile && profile.competitions) || [];
  if (!Array.isArray(list) || !list.length) return [];
  if (!mtdContestCascaderPresent()) return list;
  return list.filter(contestSupportedByMtd);
}
// 简历里的奖项写法 → 站点二级选项（金牌/银牌/铜牌）
function medalFromText(s) {
  const t = String(s || "");
  if (/金牌|金奖|gold|一等奖|冠军|first\s*prize/i.test(t)) return "金牌";
  if (/银牌|银奖|silver|二等奖|亚军|second\s*prize/i.test(t)) return "银牌";
  if (/铜牌|铜奖|bronze|三等奖|季军|third\s*prize/i.test(t)) return "铜牌";
  return "";
}
// 一级选项打分：先走别名表（权威），再退回通用的字面相似度（给非美团站留后路）
function scoreContestOption(optText, wantText) {
  const alias = MTD_CONTEST_ALIASES.find((a) => a.opt.test(optText.trim()));
  if (alias) return alias.re.test(wantText) ? 100 : 0;
  return scoreCascaderItem(optText, wantText);
}
// 赛事名归一：去掉「全国/中国/国际/大学生/第N届」等修饰与标点，只留核心词做包含匹配
function normCompName(s) {
  return String(s || "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/第[一二三四五六七八九十百零\d]+届/g, "")
    .replace(/[\s“”"'‘’·、,，.。\-—_]/g, "")
    .replace(/^(全国|中国|国际|世界)/, "")
    .replace(/大学生|高校|青年/g, "")
    .toLowerCase();
}
function scoreCascaderItem(text, want) {
  const a = normCompName(text);
  const b = normCompName(want);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (b.includes(a) || a.includes(b)) return 80 - Math.abs(a.length - b.length);
  // 逐字重合度（中文赛事名靠公共字符判断比编辑距离直观）
  let hit = 0;
  for (const ch of new Set(a)) if (b.includes(ch)) hit++;
  const ratio = hit / new Set(a).size;
  return ratio > 0.6 ? Math.round(ratio * 60) : 0;
}
async function tryPickMtdCascader(el, value, field) {
  const box =
    el.classList && el.classList.contains("mtd-cascader") ? el : el.closest && el.closest(".mtd-cascader");
  if (!box) return null;
  const want = String(value || "").trim();
  if (!want) return null;
  const label = (field && field.label) || getLabel(el);
  const medal = medalFromText(want); // want 形如「ACM-ICPC 国际大学生程序设计竞赛 区域赛金牌」

  // 开之前先复位：上一张卡可能把弹层留着开着，不关掉的话这次点击会被当成「关闭」。
  // 这是实测踩过的坑——同一段代码第二次跑就再也打不开了。
  if (cascaderMenus().length) {
    simulateClick(document.body);
    await sleep(350);
  }
  for (const c of cascaderTrigger(box)) {
    simulateClick(c);
    await sleep(500);
    if (cascaderMenus().length) break;
  }
  if (!cascaderMenus().length) {
    rfaLog({ act: "mtd-cascader-nopopup", label: label, want: want });
    return null; // 压根没弹层，交给后面的通用逻辑
  }

  // 逐列下钻：第 0 列匹配赛事，其余列匹配奖牌档次。最多 4 层。
  const picked = [];
  let aborted = "";
  for (let depth = 0; depth < 4; depth++) {
    const menus = cascaderMenus();
    const menu = menus[menus.length - 1];
    if (!menu) break;
    const items = cascaderItemsIn(menu);
    if (!items.length) break;
    let best = null;
    items.forEach((it) => {
      const t = getText(it).trim();
      const sc = depth === 0 ? scoreContestOption(t, want) : medal ? scoreCascaderItem(t, medal) : 0;
      if (sc > 0 && (!best || sc > best.sc)) best = { it: it, sc: sc, t: t };
    });
    if (!best) {
      aborted = depth === 0 ? "赛事无对应项" : medal ? "奖项无对应项" : "档案没写奖项等级";
      break;
    }
    simulateClick(best.it);
    picked.push(best.t);
    await sleep(450);
    const now = cascaderMenus();
    if (!now.length) break; // 点到叶子，弹层自动收起
    if (now.length <= menus.length) break; // 列数没增加 = 已经是叶子
  }

  await sleep(300);
  // 选中值写在 .mtd-select-filter-label（「ACM Regional/金牌」）；带 -hint 的是占位灰字
  const lab = box.querySelector(".mtd-select-filter-label, .mtd-cascader-label");
  const labTxt = lab ? getText(lab).trim() : "";
  const isHint = !!lab && /-hint\b/.test((lab.className || "").toString());
  const shown = isHint || /^请选择$/.test(labTxt) ? "" : labTxt;
  const ok = picked.length > 0 && !!shown;
  rfaLog({
    act: ok ? "mtd-cascader" : "mtd-cascader-nomatch",
    label: label,
    want: want.slice(0, 30),
    picked: picked.join("/"),
    shown: shown.slice(0, 30),
    why: aborted,
  });
  if (!ok) {
    // 关掉弹层，避免它盖住后续字段（弹层浮在 body 上，挡住的话后面全填不了）
    simulateClick(document.body);
    await sleep(250);
  }
  return ok;
}

// ---- v0.6.58：美团 mtd-select 下拉框专用实现 ----
// 真实结构（用户从页面上取到的）：
//   <div class="mtd-select mtd-select-large">
//     <div class="mtd-select-filter-input"><input type="text"></div>
//     <span class="mtd-select-filter-label" title="博士研究生">博士研究生</span>
//     <span class="mtd-select-filter-icon"><i class="mtdicon mtdicon-down-thick"></i></span>
//   </div>
// 弹层（挂到 body 上）：<li class="mtd-select-item" role="tab" tabindex="0">
//                        <span class="mtd-select-item-content">大学专科</span></li>
// 关键点：可点击的是 li.mtd-select-item 本身，不是里面的 span。

// 取当前页面上可见、可选的 mtd 下拉项
function visibleMtdItems() {
  return Array.from(document.querySelectorAll("li.mtd-select-item")).filter((li) => {
    if (!isVisible(li)) return false;
    const cls = (li.className || "").toString();
    if (/disabled/.test(cls)) return false;
    if (li.getAttribute("aria-disabled") === "true") return false;
    return true;
  });
}

function mtdItemText(li) {
  const c = li.querySelector(".mtd-select-item-content");
  return getText(c || li);
}

// 关闭已展开的 mtd 弹层，避免挡住后面的字段
function closeMtdPopup(box) {
  try {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, which: 27, bubbles: true }));
    if (box) box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, which: 27, bubbles: true }));
    simulateClick(document.body);
  } catch (e) {}
}

// v0.6.70：判断 mtd 下拉弹层是否已经展开（哪怕里面一个候选都没有）。
// 「学校名称 / 公司名称」这类服务端搜索下拉，点开时列表是空的，
// 弹层只渲染一个 .mtd-select-popup-empty（内容是「请输入」占位），
// 此时 li.mtd-select-item 数量为 0 —— 不能据此判定「没弹层」。
function mtdPopupOpen() {
  const pops = document.querySelectorAll(
    ".mtd-select-popup, .mtd-select-popup-wrapper, .mtd-select-popup-empty"
  );
  for (const p of pops) if (isVisible(p)) return true;
  return false;
}

// v0.6.70：往「可搜索下拉」的输入框里打字。
// 不能复用 typeLikeHuman —— 它结尾会派发 change + blur，blur 会立刻把下拉弹层关掉，
// 服务端返回的候选还没来得及点就没了。这里只发 keydown/input/keyup，全程保持焦点。
function typeIntoMtdSearch(el, value) {
  try {
    const str = String(value == null ? "" : value);
    el.focus();
    setNativeValue(el, "");
    dispatchInputEvent(el, "", "deleteContentBackward");
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      const kc = ch.charCodeAt(0);
      const ki = { key: ch, keyCode: kc, which: kc, bubbles: true };
      el.dispatchEvent(new KeyboardEvent("keydown", ki));
      setNativeValue(el, str.slice(0, i + 1));
      dispatchInputEvent(el, ch, "insertText");
      el.dispatchEvent(new KeyboardEvent("keyup", ki));
    }
    return true;
  } catch (e) {
    return false;
  }
}

// 读取 mtd 下拉当前已选中的文本（用于填完后校验是否真的选上了）
function mtdSelectedText(box) {
  if (!box) return "";
  const lab = box.querySelector(".mtd-select-filter-label");
  if (lab) return (lab.getAttribute("title") || getText(lab) || "").trim();
  const inp = box.querySelector("input");
  return inp ? String(inp.value || "").trim() : "";
}

// 返回 true=选中成功；false=展开了但没有匹配项（不要再打字）；null=不是 mtd 下拉，交回文本输入
async function tryPickMtdSelect(el, value, field) {
  const box =
    (el.closest && el.closest(".mtd-select")) ||
    (el.classList && el.classList.contains("mtd-select") ? el : null);
  if (!box) return null;

  const label = (field && field.label) || "";
  const want = String(value == null ? "" : value).trim();
  if (!want) return null;

  // 已经是目标值就不用再点了（避免二次点击把已选的又清掉）
  const already = mtdSelectedText(box);
  if (already && already === want) return true;

  // 展开：优先点内部 input，其次点展开箭头，最后点整个容器
  const innerInput = box.querySelector(".mtd-select-filter-input input") || box.querySelector("input");
  const icon = box.querySelector(".mtdicon-down-thick") || box.querySelector(".mtd-select-filter-icon");
  const triggers = [innerInput, icon, box].filter(Boolean);

  let items = [];
  let popupOpen = false;
  for (const t of triggers) {
    simulateClick(t);
    try { t.focus && t.focus(); } catch (e) {}
    await sleep(300);
    items = visibleMtdItems();
    popupOpen = items.length > 0 || mtdPopupOpen();
    if (popupOpen) break;
    await sleep(200);
    items = visibleMtdItems();
    popupOpen = items.length > 0 || mtdPopupOpen();
    if (popupOpen) break;
  }
  // v0.6.70 关键修复：过去这里写的是 `if (!items.length) return null`。
  // 「学校名称 / 公司名称」是服务端异步搜索下拉——点开时候选列表本来就是空的
  // （弹层只有 .mtd-select-popup-empty「请输入」占位），必须先打字才会返回候选。
  // 旧逻辑因此直接判定「没弹层」，把它退回普通文本框处理：值写进 input 了，
  // 但没有点中任何选项，React 状态没变，页面上仍然显示「请选择」——2 个学校 + 3 个公司全空。
  // 现在只要弹层确实展开了就继续往下走，交给下面的「打字 + 轮询等异步候选」分支。
  if (!items.length && !popupOpen) return null; // 真的没弹层 → 当普通文本框处理

  const buildNorm = (list) =>
    list.map((li) => ({
      el: li,
      text: mtdItemText(li),
      value: (li.getAttribute && (li.getAttribute("data-value") || li.getAttribute("value"))) || "",
    }));

  let match = findSelectOption(buildNorm(items), want, label);

  // 没命中：如果是可搜索下拉，打字过滤再试（例如公司/学校/城市这种服务端搜索的长列表）
  //
  // v0.6.62 关键修复：公司名称、学校名称这类是「服务端异步搜索」，实测输入「字节跳动」后
  // 要 ~2.5s 才返回候选。原来只 sleep(420ms) 就判定无匹配 → 公司/学校 100% 填不上。
  // 改成轮询等待：最长 3s，每 180ms 查一次，一旦列表内容变化且能匹配上就立刻点，
  // 匹配到就提前退出，不会白白拖慢那些本地即时过滤的下拉。
  let lastItems = items;
  if (!match && innerInput && !innerInput.readOnly && !innerInput.disabled) {
    try {
      const snapshot = (list) => list.map(mtdItemText).join("|");
      const before = snapshot(items);
      // v0.6.70：改用 typeIntoMtdSearch —— typeLikeHuman 结尾会 blur，
      // 会在服务端候选返回之前就把弹层关掉，导致永远选不上。
      typeIntoMtdSearch(innerInput, want);

      const deadline = Date.now() + 3000;
      let lastSnap = before;
      let stableRounds = 0;
      while (Date.now() < deadline) {
        await sleep(180);
        const filtered = visibleMtdItems();
        if (!filtered.length) continue;
        lastItems = filtered;
        const snap = snapshot(filtered);
        // 还在加载中（"加载中/搜索中/暂无数据"）就继续等
        if (/加载中|搜索中|loading|正在/i.test(snap)) { lastSnap = snap; continue; }

        match = findSelectOption(buildNorm(filtered), want, label);
        if (match) break;

        if (snap === lastSnap) {
          // 列表连续两轮没变化，说明异步结果已稳定
          if (++stableRounds >= 2) {
            // 稳定后仍无精确匹配：只剩一项时采信它（服务端搜索命中唯一结果的常见形态）
            if (filtered.length === 1) match = buildNorm(filtered)[0];
            // 首项完全包含关键词也采信（如输入「字节跳动」返回「字节跳动有限公司」）
            if (!match) {
              const first = buildNorm(filtered)[0];
              const norm = (s) => String(s || "").replace(/\s+/g, "");
              if (first && (norm(first.text).includes(norm(want)) || norm(want).includes(norm(first.text)))) {
                match = first;
              }
            }
            break;
          }
        } else {
          stableRounds = 0;
          lastSnap = snap;
        }
      }
    } catch (e) {}
  }

  if (!match) {
    closeMtdPopup(box);
    // v0.6.70：日志改用 lastItems（打字后拿到的那批候选），
    // 否则搜索型下拉这里永远打印空数组，看不出到底服务端返回了什么。
    rfaLog({
      act: "mtd-select-nomatch",
      label,
      want,
      searched: lastItems !== items,
      opts: lastItems.slice(0, 12).map(mtdItemText),
    });
    return false;
  }

  simulateClick(match.el);
  await sleep(240);

  // 校验是否真的选上了；没选上再补一次点击
  let now = mtdSelectedText(box);
  if (!now || (now !== match.text && !now.includes(match.text))) {
    if (document.body.contains(match.el) && isVisible(match.el)) {
      simulateClick(match.el);
      await sleep(240);
      now = mtdSelectedText(box);
    }
  }
  if (visibleMtdItems().length) closeMtdPopup(box);
  rfaLog({ act: "mtd-select", label, want, picked: match.text, after: now });
  return true;
}

// ---- v0.6.62：美团 mtd-date-picker（年月选择器）专用实现 ----
// 真实结构（实测 dump 自招聘页，共 42 个）：
//   <div class="mtd-date-picker">
//     <input readonly placeholder="入学时间" type="text" value="">
//   </div>
// 面板挂在 body 上：.mtd-datepicker-pop-wrapper
//   月视图头：.mtd-month-calendar-month-header
//              > .mtd-month-calendar-year-btn            文本 "2026年"（点它进年视图）
//              > .mtd-month-calendar-year-switcher.left-switcher / .right-switcher   （±1 年）
//   年视图：  .mtd-month-calendar-year-header
//              > .mtd-month-calendar-year-header-range   文本 "2020-2029"
//              > .left-switcher / .right-switcher        （±10 年）
//             年份项 .mtd-year-panel-list-data           文本 "2024"
//   月份项：  .mtd-month-panel-list-data                 文本 "6月"
// 选完 input.value 变成 "2024/06"。
// 返回 true=已选中；false=值不可选（如「至今」）需留空标黄；null=不是该组件，交回上层。
// v0.6.70：勾选「至今」复选框。
// 美团每张经历/项目卡的「结束时间」旁边都配了一个「至今」复选框（页面上共 7 个，
// 3 段实习 + 4 个项目各一个）。简历里写「至今」时，正确做法是勾上它，而不是把日期框留空标黄。
// 难点在于必须勾「同一张卡」里的那个：从日期框往上逐层找祖先，
// 取第一个「恰好只包含 1 个至今复选框」的层级——找到 2 个就说明已经跨到相邻卡片了，立即放弃。
// v0.7.1（#185）：泛化到腾讯。原名 tickMeituanToNow，只认美团的 .mtd-checkbox；
// 实测腾讯（Element UI）每张实习/项目卡的结束时间旁同样配了「至今」复选框——
// 结构是 <label class="el-checkbox sofar_check"><input class="el-checkbox__original" type=checkbox><span class="el-checkbox__label">至今</span></label>，
// 全页 7 个（3 段实习 + 4 个项目），全部可见且未勾选。
// 此前 fillElDatePicker 里写死一句注释「腾讯这类字段一般没有至今勾选框，留空交给用户」——纯属臆断，
// 导致 VizLib 项目的「结束时间=至今」永远留空标黄，挂在未填清单里。这里统一走同一套勾选逻辑。
function tickToNowCheckbox(dateBox) {
  try {
    if (!dateBox) return false;
    const wrapOf = (cb) =>
      cb.closest("label, .mtd-checkbox, .mtd-checkbox-wrapper, .el-checkbox") || cb.parentElement;
    const isToNow = (cb) => /^(至今|至\s*今|今)$/.test(getText(wrapOf(cb)).trim());
    // v0.6.70 踩坑记录：这里绝对不能用 isVisible(cb) 判可见性！
    // mtd 把真实的 <input type=checkbox> 设成 opacity:0 藏起来，只显示外层样式化的方块；
    // 而 isVisible 里有一条 `style.opacity === "0" → false`，
    // 于是 7 个「至今」复选框全被判成不可见，过滤后一个不剩（实测：至今原始 1 个 → 过滤后 0 个）。
    // 正确做法是判外层 label / .mtd-checkbox 容器的可见性。
    const cbUsable = (cb) => !cb.disabled && isVisible(wrapOf(cb)) && isToNow(cb);
    let p = dateBox;
    for (let i = 0; i < 8 && p; i++) {
      p = p.parentElement;
      if (!p) break;
      const cbs = Array.from(p.querySelectorAll("input[type=checkbox]")).filter(cbUsable);
      if (cbs.length === 0) continue; // 还没扩到含复选框的层级，继续往上
      if (cbs.length > 1) break; // 已经跨卡，别乱勾别人的
      const cb = cbs[0];
      const wrap = wrapOf(cb);
      // 已经勾上了（二次填充重入时会走到这里），不要再点，否则会取消勾选
      if (cb.checked || (wrap && wrap.classList && wrap.classList.contains("is-checked"))) return true;
      const target = cb.closest("label, .mtd-checkbox, .el-checkbox") || cb;
      simulateClick(target);
      if (!cb.checked) simulateClick(cb);
      // Element UI 用外层 label 的 is-checked 类表达选中态，原生 input.checked 未必同步
      return !!cb.checked || !!(wrap && wrap.classList && wrap.classList.contains("is-checked"));
    }
  } catch (e) {}
  return false;
}
// 兼容旧调用点
const tickMeituanToNow = tickToNowCheckbox;

function mtdVisiblePanel() {
  const list = Array.from(document.querySelectorAll(".mtd-datepicker-pop-wrapper")).filter(isVisible);
  return list.length ? list[list.length - 1] : null;
}

function mtdPanelYear(panel) {
  const btn = panel.querySelector(".mtd-month-calendar-year-btn");
  if (!btn) return null;
  const m = getText(btn).match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

async function pickMeituanMonth(el, value, field) {
  const box = (el.closest && el.closest(".mtd-date-picker")) || null;
  if (!box) return null;
  const inp = box.querySelector("input") || (el.tagName === "INPUT" ? el : null);
  if (!inp) return null;

  const ym = parseYearMonth(value);
  if (!ym) {
    // v0.6.70：「至今 / 现在 / 在读 / 在职」不是一个能在月历里选出来的日期，
    // 但美团每张经历/项目卡的结束时间旁边都配了一个「至今」复选框——正确做法是勾上它，而不是留空。
    if (/至今|今|现在|在读|在职|至现在|present|now|current/i.test(String(value))) {
      const ok = tickMeituanToNow(box);
      rfaLog({
        act: "mtd-date-tonow",
        label: (field && field.label) || inp.placeholder,
        want: String(value),
        ok,
      });
      if (ok) return true;
    }
    // 其它选不出来的值：留空标黄让用户自己点，绝不硬打字造脏值
    rfaLog({ act: "mtd-date-unparsable", label: (field && field.label) || inp.placeholder, want: String(value) });
    return false;
  }

  const want = `${ym.year}/${String(ym.month).padStart(2, "0")}`;
  const digits = (s) => String(s || "").replace(/\D/g, "");
  if (digits(inp.value) === digits(want)) return true; // 已经是目标值

  // 1) 打开面板
  let panel = null;
  for (const t of [inp, box.querySelector(".mtd-input-suffix"), box]) {
    if (!t) continue;
    simulateClick(t);
    await sleep(300);
    panel = mtdVisiblePanel();
    if (panel) break;
  }
  if (!panel) return null; // 打不开日历 → 交回上层当普通文本框

  // 2) 切到目标年份
  let cur = mtdPanelYear(panel);
  if (cur !== ym.year) {
    // 2a) 优先走年视图（一屏 12 年，跨度大也只需翻几次 10 年）
    const yearBtn = panel.querySelector(".mtd-month-calendar-year-btn");
    if (yearBtn) {
      simulateClick(yearBtn);
      await sleep(300);
      panel = mtdVisiblePanel() || panel;

      let hit = null;
      for (let page = 0; page < 12; page++) {
        const cells = Array.from(panel.querySelectorAll(".mtd-year-panel-list-data")).filter(isVisible);
        hit = cells.find((c) => getText(c) === String(ym.year));
        if (hit) break;
        // 读当前页范围 "2020-2029"，决定往前翻还是往后翻
        const rangeEl = panel.querySelector(".mtd-month-calendar-year-header-range");
        const rm = rangeEl ? getText(rangeEl).match(/(\d{4})\s*[-–~]\s*(\d{4})/) : null;
        let dir = 0;
        if (rm) dir = ym.year < parseInt(rm[1], 10) ? -1 : ym.year > parseInt(rm[2], 10) ? 1 : 0;
        else {
          const nums = cells.map((c) => parseInt(getText(c), 10)).filter((n) => !isNaN(n));
          if (!nums.length) break;
          dir = ym.year < Math.min(...nums) ? -1 : 1;
        }
        if (!dir) break;
        const header = panel.querySelector(".mtd-month-calendar-year-header") || panel;
        const sw = header.querySelector(
          dir < 0 ? ".mtd-month-calendar-year-switcher.left-switcher" : ".mtd-month-calendar-year-switcher.right-switcher"
        );
        if (!sw) break;
        simulateClick(sw);
        await sleep(220);
        panel = mtdVisiblePanel() || panel;
      }
      if (hit) {
        simulateClick(hit);
        await sleep(300);
        panel = mtdVisiblePanel() || panel;
      }
    }

    // 2b) 年视图没搞定 → 回落月视图左右箭头逐年翻（最多 40 次）
    cur = mtdPanelYear(panel);
    let guard = 0;
    while (cur !== null && cur !== ym.year && guard++ < 40) {
      const header = panel.querySelector(".mtd-month-calendar-month-header") || panel;
      const sw = header.querySelector(
        cur > ym.year ? ".mtd-month-calendar-year-switcher.left-switcher" : ".mtd-month-calendar-year-switcher.right-switcher"
      );
      if (!sw) break;
      simulateClick(sw);
      await sleep(180);
      panel = mtdVisiblePanel() || panel;
      const next = mtdPanelYear(panel);
      if (next === cur) break; // 翻不动了，别死循环
      cur = next;
    }
  }

  // 3) 点月份
  panel = mtdVisiblePanel() || panel;
  const monthCells = Array.from(panel.querySelectorAll(".mtd-month-panel-list-data")).filter(isVisible);
  const monthRe = new RegExp("^0*" + ym.month + "\\s*月$");
  const mCell =
    monthCells.find((c) => monthRe.test(getText(c))) ||
    monthCells[ym.month - 1] ||
    null;
  if (!mCell) {
    closeCalendarPanel();
    rfaLog({ act: "mtd-date-nomonth", want, opts: monthCells.slice(0, 12).map(getText) });
    return false;
  }
  simulateClick(mCell);
  await sleep(280);

  // 4) 校验；面板没关掉就补一刀
  if (mtdVisiblePanel()) closeCalendarPanel();
  const after = String(inp.value || "").trim();
  const ok = digits(after) === digits(want);
  rfaLog({ act: "mtd-date", label: (field && field.label) || inp.placeholder, want, after, ok });
  return ok ? true : false;
}

// ── v0.8.5（#269）：Ant Design 日历选择器（网易 campus.163.com / 拼多多 careers.pddglobalhr.com）──
// 这两站的日期字段是 <input class="ant-calendar-picker-input" readonly>，纯文本打字 100% 无效
// （readOnly + React 受控，setNativeValue 会被 rerender 覆盖）。必须点开弹层在面板里选。
// 面板分三种，结构完全不同，必须分开处理：
//   · 日面板  .ant-calendar          → 面板内有可编辑的 .ant-calendar-input，打字 + Enter 直接提交（最稳）
//   · 月面板  .ant-calendar-month-panel → 无输入框，靠 prev/next-year 按钮翻到目标年再点「N月」格子
//   · 年面板  .ant-calendar-year-panel  → 靠 prev/next-decade 按钮翻到目标十年再点年份格子
// 影响面：网易 4 个（预计毕业/入校/获奖时间×2）+ 拼多多 1 个（出生年月）+ 学位证时间。
function antdVisiblePanel() {
  const ps = Array.from(document.querySelectorAll(".ant-calendar-picker-container")).filter(
    (p) => isVisible(p) && getComputedStyle(p).display !== "none"
  );
  return ps.length ? ps[ps.length - 1] : null;
}

async function tryPickAntdCalendar(el, value, field) {
  const m = String(value || "").match(/(\d{4})\D{0,3}(\d{1,2})?\D{0,3}(\d{1,2})?/);
  // v0.8.9：这两个静默 return 让 B站「出生日期」查了半天查不出卡在哪一步，补留痕。
  if (!m) { rfaLog({ act: "antd-cal-badvalue", label: (field && field.label) || el.placeholder, want: String(value).slice(0, 20) }); return false; }
  const Y = parseInt(m[1], 10);
  const M = m[2] ? parseInt(m[2], 10) : 1;
  const D = m[3] ? parseInt(m[3], 10) : 1;
  const p2 = (n) => String(n).padStart(2, "0");

  simulateClick(el);
  await sleep(340);
  let panel = antdVisiblePanel();
  if (!panel) { await sleep(320); panel = antdVisiblePanel(); }
  if (!panel) { rfaLog({ act: "antd-cal-nopanel", label: (field && field.label) || el.placeholder, want: String(value).slice(0, 20) }); return null; } // 弹层没开 → 大概率不是 antd 日历，交回调用方打字

  const clickN = async (btn, times) => {
    for (let i = 0; i < times; i++) { simulateClick(btn); await sleep(90); }
  };
  const closePanel = () => {
    try {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      document.body.click();
    } catch (e) {}
  };

  // ── A) 年面板（网易「获奖时间」placeholder=请选择年份）
  const yPanel = panel.querySelector(".ant-calendar-year-panel");
  if (yPanel) {
    for (let guard = 0; guard < 14; guard++) {
      const cells = Array.from(yPanel.querySelectorAll(".ant-calendar-year-panel-year"));
      const hit = cells.find((c) => getText(c).trim() === String(Y));
      if (hit) { simulateClick(hit); await sleep(240); break; }
      const cur = cells.length ? parseInt(getText(cells[0]).trim(), 10) : Y;
      const btn = yPanel.querySelector(
        Y < cur ? ".ant-calendar-year-panel-prev-decade-btn" : ".ant-calendar-year-panel-next-decade-btn"
      );
      if (!btn) break;
      await clickN(btn, 1);
    }
    closePanel();
    await sleep(160);
    const okY = String(el.value || "").includes(String(Y));
    rfaLog({ act: "antd-year", label: (field && field.label) || el.placeholder, want: Y, after: el.value, ok: okY });
    return okY;
  }

  // ── B) 月面板（拼多多「出生年月」placeholder=请选择月份）
  const mPanel = panel.querySelector(".ant-calendar-month-panel");
  if (mPanel) {
    for (let guard = 0; guard < 40; guard++) {
      const yTxt = getText(mPanel.querySelector(".ant-calendar-month-panel-year-select-content") || {}) || "";
      const cur = parseInt(String(yTxt).replace(/\D/g, ""), 10);
      if (!cur || cur === Y) break;
      const btn = mPanel.querySelector(
        Y < cur ? ".ant-calendar-month-panel-prev-year-btn" : ".ant-calendar-month-panel-next-year-btn"
      );
      if (!btn) break;
      await clickN(btn, 1);
    }
    const cells = Array.from(mPanel.querySelectorAll(".ant-calendar-month-panel-month"));
    const hit =
      cells.find((c) => getText(c).trim() === M + "月") ||
      cells.find((c) => parseInt(getText(c).trim(), 10) === M) ||
      cells[M - 1];
    if (hit) { simulateClick(hit); await sleep(260); }
    closePanel();
    await sleep(160);
    const okM = /\d/.test(String(el.value || ""));
    rfaLog({ act: "antd-month", label: (field && field.label) || el.placeholder, want: Y + "-" + p2(M), after: el.value, ok: okM });
    return okM;
  }

  // ── C) 日面板：面板自带输入框，打字 + Enter 最稳（避免翻月份翻几十次）
  const inp = panel.querySelector(".ant-calendar-input");
  if (inp) {
    const txt = Y + "-" + p2(M) + "-" + p2(D);
    setNativeValue(inp, txt);
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(220);
    for (const type of ["keydown", "keyup"]) {
      inp.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    }
    await sleep(280);
    if (antdVisiblePanel()) closePanel();
    await sleep(160);
    const okD = String(el.value || "").length > 0;
    rfaLog({ act: "antd-date", label: (field && field.label) || el.placeholder, want: txt, after: el.value, ok: okD });
    return okD;
  }
  closePanel();
  return false;
}

// ── v0.8.9（2026-08-08）：Ant Design **v4** 日期选择器（.ant-picker-input）────────────────
// antd v4 的 DatePicker/MonthPicker 支持直接在输入框按 yyyy-MM-dd（或 yyyy-MM）打字，
// 回车即提交（面板内也有输入框，但打字路径更稳、不依赖翻年翻月）。
//   年-月-日 → "YYYY-MM-DD"；年-月（无日，如毕业时间/起止时间常见） → "YYYY-MM"。
// 影响面：小红书（出生年月/毕业时间）、快手（出生日期/毕业日期/起止时间）。
async function tryPickAntdPickerV4(el, value, field) {
  const m = String(value || "").match(/(\d{4})\D{0,3}(\d{1,2})?\D{0,3}(\d{1,2})?/);
  if (!m) { rfaLog({ act: "antd4-badvalue", label: (field && field.label) || el.placeholder, want: String(value).slice(0, 20) }); return false; }
  const Y = parseInt(m[1], 10);
  const M = m[2] ? parseInt(m[2], 10) : 1;
  const D = m[3] ? parseInt(m[3], 10) : null;
  const p2 = (n) => String(n).padStart(2, "0");
  const fmt = D != null ? `${Y}-${p2(M)}-${p2(D)}` : `${Y}-${p2(M)}`;
  // 入口可能是 .ant-picker 容器内的 input；优先用 el 本身（探针确认 el 即 input）
  const inp = (el.tagName === "INPUT") ? el : (el.querySelector("input") || el);
  try {
    inp.focus();
    setNativeValue(inp, fmt);
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(160);
    for (const t of ["keydown", "keyup"]) {
      inp.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    }
    await sleep(280);
    if (inp.blur) try { inp.blur(); } catch (e) {}
    await sleep(160);
  } catch (e) {}
  const after = String(inp.value || "");
  const ok = after.length > 0 && after !== fmt ? true : after.length > 0;
  rfaLog({ act: "antd4-date", label: (field && field.label) || el.placeholder, want: fmt, after, ok });
  return ok;
}

// ── v0.8.5（#269）：Ant Design 级联选择（网易「学校所在地 / 家庭所在地」）────────────────
// 结构：<input class="ant-cascader-input"> + body 挂载 .ant-cascader-menus（多列 .ant-cascader-menu）。
// 飞书那套 fillAddressTree 完全不认它（选择器全是 ud__*），之前两个字段恒空。
// 策略：逐级在当前列里找包含目标片段的 item 点进去；点不到就停在已选层级（省级也算填了）。
async function tryPickAntdCascader(el, value, field) {
  const parts = String(value || "")
    .split(/[\s/、,，>·-]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return false;
  simulateClick(el);
  await sleep(340);
  let menus = Array.from(document.querySelectorAll(".ant-cascader-menus")).filter(isVisible);
  if (!menus.length) { await sleep(300); menus = Array.from(document.querySelectorAll(".ant-cascader-menus")).filter(isVisible); }
  if (!menus.length) return null;
  const root = menus[menus.length - 1];
  let picked = 0;
  for (let lv = 0; lv < parts.length; lv++) {
    const cols = Array.from(root.querySelectorAll(".ant-cascader-menu"));
    const col = cols[lv] || cols[cols.length - 1];
    if (!col) break;
    const items = Array.from(col.querySelectorAll(".ant-cascader-menu-item"));
    const want = parts[lv].replace(/[省市区县自治州]$/g, "");
    const hit =
      items.find((i) => getText(i).trim() === parts[lv]) ||
      items.find((i) => getText(i).trim().indexOf(want) === 0) ||
      items.find((i) => getText(i).trim().indexOf(want) >= 0);
    if (!hit) break;
    simulateClick(hit);
    picked++;
    await sleep(260);
  }
  await sleep(200);
  const after = String(el.value || "") || getText(el.closest(".ant-cascader-picker") || el);
  const ok = picked > 0;
  rfaLog({ act: "antd-cascader", label: (field && field.label) || "", want: value, picked, after: String(after).slice(0, 40), ok });
  return ok;
}

// 通用「点击展开 → 匹配选项 → 点击」：适配任意框架（antd / semi / formily / 飞书）。
// 无弹层出现则判定为纯文本输入，返回 null 让调用方回落到 typing。
// ── v0.8.6（#274）：通用「进入编辑态」──────────────────────────────────────────
// 只在**页面几乎没有可填控件**时才动手（阈值 3），避免在正常表单页乱点按钮。
// 点击后轮询等待控件出现，最多 ~8 秒；一旦控件数明显上升就立刻返回，不空等。
// 严格只点「创建/编辑/完善简历」这类入口，绝不碰提交/投递（产品铁律：只填不投）。
async function enterEditModeIfNeeded() {
  try {
    const countCtl = () =>
      Array.from(document.querySelectorAll("input:not([type=hidden]),textarea,select")).filter(isVisible)
        .length;
    if (countCtl() >= 3) return false; // 已经是表单页，什么都不做

    // 入口文案白名单。特意**不含**「投递 / 提交 / 申请职位 / 上传」——点错就是事故。
    const ENTER_RE =
      /^(立即创建|创建简历|新建简历|去创建|马上创建|编辑简历|编辑|去编辑|完善简历|去完善|完善信息|填写简历|去填写|开始填写)$/;
    const cands = Array.from(
      document.querySelectorAll("button, a, div[role=button], span[role=button], [class*='btn'], [class*='Button']")
    ).filter((e) => {
      if (!isVisible(e)) return false;
      const t = (e.textContent || "").replace(/\s+/g, "");
      if (!ENTER_RE.test(t)) return false;
      // 只取「最内层」那个可点元素，避免点到包了一大片的外层容器
      return !Array.from(e.querySelectorAll("button,a,[role=button]")).some((c) => isVisible(c));
    });
    if (!cands.length) {
      rfaLog({ act: "enter-edit", note: "no-entry-button", ctl: countCtl() });
      return false;
    }
    const btn = cands[0];
    rfaLog({ act: "enter-edit", click: (btn.textContent || "").trim().slice(0, 12), ctl: countCtl() });
    simulateClick(btn);

    for (let i = 0; i < 16; i++) {
      await sleep(500);
      const n = countCtl();
      if (n >= 3) {
        rfaLog({ act: "enter-edit", note: "form-appeared", ctl: n, waitedMs: (i + 1) * 500 });
        await sleep(800); // 让框架把剩余字段渲染完
        return true;
      }
    }
    rfaLog({ act: "enter-edit", note: "form-never-appeared", ctl: countCtl() });
    return false;
  } catch (e) {
    rfaLog({ act: "enter-edit-error", err: String(e).slice(0, 120) });
    return false;
  }
}

// ── v0.8.6（#272）：Moka 远程搜索型输入框（学校 / 专业 / 公司）─────────────────
// 返回 true = 已点中候选项并落值；null = 没有候选弹层（当作普通文本框，交回上层打字）。
// 绝不返回 false 硬失败：Moka 有些文本框确实是纯输入（如「所在地」），不能一刀切。
// v0.8.9（#278）：只有「可能是远程搜索」的字段才走这条路。
// 之前对姓名/手机号/邮箱等纯文本框也跑一遍，每个白等 900+700×3 ≈ 3s，
// 一张 Moka 表单 47 个字段光这里就烧掉 2 分钟，还把跑批顶到超时。
const MOKA_AC_LABEL_RE = /学校|院校|学院|大学|专业|公司|企业|单位|雇主|职位|岗位|机构|证书|资格/;
async function tryPickMokaAutocomplete(el, value, field) {
  const val = String(value || "").trim();
  if (!val) return null;
  const acHint = ((field && field.label) || "") + "|" + (el.placeholder || "") + "|" + (el.name || "");
  if (!MOKA_AC_LABEL_RE.test(acHint)) return null;
  try {
    // 0) 先关掉上一个字段遗留的浮层。真机实测：填完「证件类型」后那个下拉一直开着，
    //    再去点学校输入框时，屏幕上同时有两个 sd-Dropdown，候选采集极易串味。
    closeMokaPopups();
    // 1) 聚焦并打字触发远程搜索。必须用 setNativeValue —— React 受控组件对
    //    直接赋 el.value 无感知，不会发起搜索请求。
    simulateClick(el);
    el.focus();
    el.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    await sleep(120);
    // v0.8.7：先用**前 2~4 个字**做关键词。真机实测「示例」能召回 7 条，
    // 而整串「计算机科学与技术」这种长词在部分站会 0 召回。
    // v0.8.9：两级关键词——先长后短。长词召回更准，短词召回率更高。
    const kwLong = val.length > 4 ? val.slice(0, Math.max(2, Math.min(4, val.length - 1))) : val;
    const kwShort = val.slice(0, 2);
    const kws = kwShort && kwShort !== kwLong ? [kwLong, kwShort] : [kwLong];

    // 🔴 v0.8.9 关键修复（#278）：这里以前 setNativeValue 之后**只发 keydown/keyup**，
    // 从来没发过 `input` 事件。Moka 是 React 受控组件，onChange 只监听 input —— 没有
    // input 事件 → state 不变 → 远程搜索请求根本不发出 → 页面上一个 sd-Dropdown 都没有，
    // 于是日志里恒为 `moka-autocomplete-none pops:0`，学校/专业永远填不进去。
    // CDP 真机对照实验：`nativeSet.call(el,'示例') + new Event('input')` → pops:2、候选
    // 首项「示例学校」；去掉 input 事件 → pops:0。差别就在这一行。
    let opts = [];
    let kw = kwLong;
    for (const k of kws) {
      kw = k;
      setNativeValue(el, k);
      dispatchInputEvent(el, k, "insertText"); // ← 缺失的那一行
      el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: k.slice(-1) }));
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: k.slice(-1) }));
      // 远程搜索要等网络返回，给足时间；300ms 时经常还是「加载中」。
      await sleep(900);
      opts = collectMokaMenuItems(el);
      for (let r = 0; r < 2 && !opts.length; r++) {
        await sleep(700); // 慢网络多次重试（实测 1.2s 才弹）
        opts = collectMokaMenuItems(el);
      }
      if (opts.length) break;
    }
    if (!opts.length) {
      // v0.8.7：这里以前是「静默 return null」，导致 v0.8.6 排查时看到
      // moka-autocomplete 计数为 0，误判成「路由没走到」，白追了两小时。
      // 现在无论成败都留痕。
      rfaLog({
        act: "moka-autocomplete-none",
        label: (field && field.label) || el.placeholder || "",
        want: val.slice(0, 20),
        kw,
        pops: document.querySelectorAll('[class*="sd-Dropdown-dropdown"]').length,
      });
      return null; // 不是搜索框 → 交回上层按普通文本处理
    }

    // 2) 选项匹配：完全相等 > 候选以输入开头（示例学校 → 示例学校法学院）> 输入以候选开头 > 首项。
    //    「示例学校」这类含子串但不同校的必须排在后面，所以不能用 indexOf>=0 做首选。
    const eq = opts.find((o) => o.text === val);
    const startsWithVal = opts.find((o) => o.text.indexOf(val) === 0);
    const valStartsWith = opts.find((o) => val.indexOf(o.text) === 0);
    const hit = eq || startsWithVal || valStartsWith || opts[0];

    simulateClick(hit.el);
    await sleep(320);

    // 3) 校验：Moka 选中后会把值写回 input.value（搜索框与 sd-Select 行为不同，
    //    后者是渲染成第二行文本），所以这里直接读 value 判断是否真的落了。
    const now = String(el.value || "").trim();
    const ok = !!now;
    rfaLog({
      act: "moka-autocomplete",
      label: (field && field.label) || el.placeholder || "",
      want: val.slice(0, 20),
      picked: hit.text.slice(0, 20),
      got: now.slice(0, 20),
      n: opts.length,
      ok,
    });
    return ok ? true : null;
  } catch (e) {
    rfaLog({ act: "moka-autocomplete-error", err: String(e).slice(0, 120) });
    return null;
  }
}

// ── v0.8.7（#276 · Moka 出生日期 sd-picker）────────────────────────────────────
// 「出生日期 (年龄)」不是文本框也不是 sd-Select，而是 Moka 自研日历 sd-picker-input。
// 真机（速腾）CDP 逐步实测出来的面板层级，照抄即可：
//   ① 点输入框 → 弹 sd-Dropdown-dropdown，**月视图**：
//        header  .sd-basic-selector-year   = "1990年"
//        单元格  .sd-basic-year-item ×12   = 一月 二月 … 十二月
//   ② 点 header → **十年视图**：
//        header  = "1990 - 1999"
//        单元格  = 1989 1990 … 2000（含前后各一个越界年）
//        header 左右各一个 .sd-Icon-icondouble…（双箭头）= 上/下一个十年
//   ③ 选中年 → 自动退回月视图；选中月 → 面板关闭，值写进字段盒
// 另：**直接 setNativeValue 打字完全无效**（实测 input.value 打完仍为空串），
//    所以只能点选，没有捷径。
const MOKA_MONTH_CN = ["一月","二月","三月","四月","五月","六月","七月","八月","九月","十月","十一月","十二月"];
async function fillMokaDatePicker(el, value, field) {
  const m = String(value || "").match(/(\d{4})\D+(\d{1,2})(?:\D+(\d{1,2}))?/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const mon = parseInt(m[2], 10);
  const day = m[3] ? parseInt(m[3], 10) : 0;
  const vis2 = (e) => isVisible(e);
  const panelOf = () =>
    Array.from(document.querySelectorAll('[class*="sd-Dropdown-dropdown"]')).filter(vis2).pop();
  const cells = (p) => Array.from(p.querySelectorAll('[class*="sd-basic-year-item"], [class*="sd-basic-day-item"], [class*="sd-basic-item-wrapper"]')).filter(vis2);
  try {
    closeMokaPopups();
    await sleep(300);
    let p = null;
    for (let k = 0; k < 3 && !p; k++) {
      simulateClick(el);
      el.focus();
      await sleep(700);
      p = panelOf();
    }
    if (!p) { rfaLog({ act: "moka-date-nopanel", label: (field && field.label) || el.placeholder || "" }); return null; }

    // 月视图 → 十年视图
    const head = () => p.querySelector('[class*="sd-basic-selector-year"]');
    if (head()) { simulateClick(head()); await sleep(420); p = panelOf() || p; }

    // 翻到目标年所在的十年
    for (let i = 0; i < 24; i++) {
      const ht = (getText(head()) || "").trim();
      const rg = ht.match(/(\d{4})\s*-\s*(\d{4})/);
      if (rg && year >= +rg[1] && year <= +rg[2]) break;
      const icons = Array.from(p.querySelectorAll('[class*="sd-Icon-icondouble"], [class*="sd-Icon-icondoub"]')).filter(vis2);
      if (icons.length < 2) break;
      const goNext = !rg || year > +rg[2];
      simulateClick(icons[goNext ? icons.length - 1 : 0]);
      await sleep(320);
      p = panelOf() || p;
    }
    // 点年
    let hit = cells(p).find((c) => (getText(c) || "").trim() === String(year));
    if (!hit) { rfaLog({ act: "moka-date-noyear", want: year }); return false; }
    simulateClick(hit);
    await sleep(480);
    p = panelOf() || p;

    // 点月（中文月名）
    hit = cells(p).find((c) => (getText(c) || "").trim() === MOKA_MONTH_CN[mon - 1]);
    if (!hit) hit = cells(p).find((c) => (getText(c) || "").trim() === String(mon));
    if (!hit) { rfaLog({ act: "moka-date-nomonth", want: mon }); return false; }
    simulateClick(hit);
    await sleep(480);

    // 若还停在日视图，补点「日」
    p = panelOf();
    if (p && day) {
      const dcell = cells(p).find((c) => (getText(c) || "").trim() === String(day));
      if (dcell) { simulateClick(dcell); await sleep(400); }
    }
    closeMokaPopups();
    await sleep(200);
    const ok = (el.placeholder || "").trim() === "";
    rfaLog({ act: "moka-date", label: (field && field.label) || "", want: value, ok });
    return ok ? true : false;
  } catch (e) {
    rfaLog({ act: "moka-date-error", err: String(e).slice(0, 120) });
    return null;
  }
}

// v0.8.7：关掉 Moka 页面上所有还开着的下拉浮层。
// Moka 的 sd-Dropdown 是 body 下的 portal，选完不会自动收；下一个字段再点开时
// 页面上会同时挂着两个甚至三个浮层，采集候选就会串味（学校被填成「身份证」这种）。
// 只发 Escape + 在空白处 mousedown，绝不点任何按钮。
function closeMokaPopups() {
  try {
    const pops = Array.from(document.querySelectorAll('[class*="sd-Dropdown-dropdown"]')).filter(isVisible);
    if (!pops.length) return;
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape", keyCode: 27, which: 27 }));
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 2, clientY: 2 }));
    document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 2, clientY: 2 }));
  } catch (e) {}
}

// 采集 Moka 搜索下拉的候选项。
//
// 【2026-08-08 CDP 真机实测，v0.8.6 的注释是错的，已按实测重写】
// 在速腾 robosense 页对「请输入就读学校」打「示例」，1.2s 后弹层结构是：
//   sd-Dropdown-dropdown-1c-rG          ← 浮层根（body 下的 portal）
//     sd-Menu-container-3HY1z           ← 每个候选一层
//       sd-Menu-content-2vKOA sd-Menu-leftItem-2sehK
//         sd-Menu-content-item-37fPj    ← 真正的文字节点
//   文本：示例学校 / 示例学校 / 示例学校医学院 / 示例学校法学院 / 示例学校公共管理学院 /
//         示例独立学院 / 广东示例职业培训学校
// 所以真实类名是 **sd-Menu-content-item**，和 sd-Select 下拉用的是同一套；
// v0.8.6 写成 `[class*="sd-Menu-item"]`（少了 content-）→ **一个都匹配不到** →
// tryPickMokaAutocomplete 在 `if(!opts.length) return null` 处静默退出、连日志都不打，
// 于是 moka-autocomplete 计数恒为 0，学校/专业被回落成硬打字、失焦即清空。
//
// 另一个必须处理的坑：页面上**可能同时存在多个 sd-Dropdown 浮层**（实测上一个字段的
// 「证件类型」下拉在填充结束后仍开着）。全局抓 sd-Menu-content-item 会把「身份证/护照/
// 外国人居留许可证」也收进来，首项兜底就会把学校名填成「身份证」。
// 对策：只在**离目标输入框最近的那个可见浮层**里找候选。
function collectMokaMenuItems(anchorEl) {
  const pops = Array.from(document.querySelectorAll('[class*="sd-Dropdown-dropdown"]')).filter(isVisible);
  let scope = null;
  if (pops.length && anchorEl && anchorEl.getBoundingClientRect) {
    const ar = anchorEl.getBoundingClientRect();
    let best = Infinity;
    pops.forEach((p) => {
      const r = p.getBoundingClientRect();
      // 距离 = 浮层左上角到输入框左下角的曼哈顿距离；同列同高的那个就是它的下拉
      const d = Math.abs(r.left - ar.left) + Math.abs(r.top - ar.bottom);
      if (d < best) { best = d; scope = p; }
    });
    // 太远（>400px）说明这个浮层不是它的，宁可不选也不要选错
    if (best > 400) scope = null;
  } else if (pops.length === 1) {
    scope = pops[0];
  }
  const root = scope || document;
  return Array.from(root.querySelectorAll('[class*="sd-Menu-content-item"], [class*="sd-Menu-item"]'))
    .filter(isVisible)
    .map((o) => ({ el: o, text: (getText(o) || "").trim() }))
    .filter(
      (o) =>
        o.text &&
        o.text.length < 40 &&
        // 「没有找到学校？」「添加学校全称」「暂无选项」是兜底入口，选中会写入垃圾值
        !/没有找到|找不到|添加.*全称|暂无选项|加载中|no\s*data/i.test(o.text)
    );
}

async function tryPickGenericSelect(el, value, field) {
  simulateClick(el);
  await sleep(320);
  const popupSel =
    '.ant-select-dropdown .ant-select-item-option, [class*="select-dropdown"] [class*="option"], ' +
    '[class*="select-item"], [role="option"], .ud__select__list__item, ' +
    '[class*="option-list"] > *, [class*="cascader"] [class*="item"], ' +
    // v0.7.8（#262）：Moka 体系（大疆 apply.careers.dji.com + app.mokahr.com 全家）用的是
    // 自研 sd-* 组件库，下拉结构为
    //   .sd-Dropdown-dropdown-xxxx > .sd-Select-menu-xxxx > .sd-Select-scrollable-xxxx
    //     > .sd-Menu-container-xxxx > .sd-Menu-content-xxxx > .sd-Menu-content-item-xxxx
    //       > .option-label-xxxx（真正带文字的叶子）
    // 类名全部带构建 hash 后缀，必须用 [class*=] 前缀匹配。
    // 之前这套选择器一个都没覆盖 → 弹层其实开了、但 opts 为空被当成「纯文本框」放弃，
    // 表现为 性别 / 工作经验 / 最高学历 在 5 家 Moka 站全部留白（共 15 个空位）。
    // v0.8.6：补 sd-Menu-item（少了 content- 的那套，Moka 搜索型下拉用它）。
    // 左侧导航 .nav-item 不含 sd- 前缀，不会被误收。
    '[class*="option-label"], [class*="sd-Menu-content-item"], [class*="sd-Menu-item"], [class*="sd-Select-menu"] [class*="sd-Menu-content"]';
  const dedupeLeaf = (list) => {
    // 同一个选项会同时命中外层 .sd-Menu-content-item 和内层 .option-label，
    // 只保留最内层（不包含其它候选项的那个），避免 findSelectOption 拿到带多余文字的父节点。
    return list.filter((o) => !list.some((p) => p !== o && o.contains(p)));
  };
  let opts = dedupeLeaf(Array.from(document.querySelectorAll(popupSel)).filter(isVisible));
  if (!opts.length) { await sleep(220); opts = dedupeLeaf(Array.from(document.querySelectorAll(popupSel)).filter(isVisible)); }
  if (!opts.length) return null; // 没弹层 → 纯文本
  const norm = opts.map((o) => ({
    el: o,
    text: getText(o).trim(),
    value: (o.getAttribute && o.getAttribute("value")) || "",
  }));
  const match = findSelectOption(norm, String(value), (field && field.label) || "");
  if (!match) return false; // 弹层开了但没匹配项
  simulateClick(match.el);
  await sleep(200);
  return true;
}

// 校验值是否符合字段语义，防止明显错误（如手机号填进邮箱、描述文字填进链接）
function validateValueForField(value, field) {
  const str = String(value || "").trim();
  if (!str) return false;
  const label = (field.label || "").toLowerCase();
  const elType = (field.type || "").toLowerCase();

  // 邮箱字段：必须包含 @ 且像个邮箱
  if (elType.includes("email") || /邮箱|邮件|e-mail|email/.test(label)) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
  }

  // v0.7.1（#185）：区号下拉的值形如「+86」，只有 3 个字符，会被下面「手机号 7~20 位」的长度校验误杀。
  // 腾讯那个区号下拉的 label 是相邻帮助文案「如您是中国大陆籍，建议您使用+86的中国手机号码注册」，
  // 里面带「手机」二字，于是精准踩中手机分支被判脏值丢弃 —— 表现为「映射规则明明写了却始终未映射」。
  if (/^\+\d{1,4}$/.test(str)) return true;

  // 手机号/电话字段：应当是电话号码格式
  if (/手机|电话|tel|mobile/.test(label)) {
    return /^[\d+\-\s()]{7,20}$/.test(str);
  }

  // 链接/URL 字段：应当至少包含一个点或协议头，避免把描述文字塞进来
  // v0.7.1 例外（#167）：字节社交卡的字段名就叫「URL / ID」——它同时接受网址和账号 ID。
  // 微信号 exampleuser_2026、B站 UID 88480001 这类合法账号里根本没有点，
  // 原来被这条 URL 校验一律判为脏值丢弃 → 8 条社交里 5 条明明取到了值却填不进去
  // （表现和「映射没做」一模一样，极难排查）。标签里带 ID / 账号 / 号 的一律放行。
  const _urlAllowsId = /\bid\b|id\s*[/／、]|[/／、]\s*id|账号|帐号|用户名|昵称/.test(label);
  if (
    (elType.includes("url") || /(链接|网址|url|link|作品|portfolio|视频|demo)/.test(label)) &&
    !/(描述|介绍|说明|名称|标题|概要)/.test(label) &&
    !_urlAllowsId
  ) {
    return /^(https?:\/\/|www\.|[^\s]+\.[^\s]+)/i.test(str) || /^[\w\-]+\.[\w\-]{2,}/.test(str);
  }

  return true;
}

// 根据字段 label 和板块，从对应数据中取最匹配的值
// v0.7.2：按平台名从 social 数组里取账号。
// 用于 basic 没有独立字段（如 wechat / qq）时的数据回落——档案里数据其实存在，只是换了个地方放。
function socialAccountOf(profile, platformRe) {
  const list = (profile && profile.social) || [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s) continue;
    if (platformRe.test(String(s.platform || s.name || ""))) {
      const v = s.account || s.id || s.link || "";
      if (v) return String(v).trim();
    }
  }
  return null;
}

// ── v0.7.2：分段日期包装层 ────────────────────────────────────────────────────
// getLabel 会把 Moka / 北森这类 ATS 的「年」「月」下拉标成「开始时间（年）」。
// 这里先剥掉后缀交给核心匹配拿到完整日期（如 2019-09），再按后缀切出对应片段。
// 之所以做成包装层而不是散落到几十个 return 上：教育 / 实习 / 项目 / 获奖等
// 所有既有日期规则可以一次性生效，且对不含后缀的老站点行为完全不变（直接透传）。
const DATE_SEG_RE = /（(年|月|日)）$/;

function sliceDateSegment(val, seg) {
  if (val == null || val === "") return val;
  // 2026-08-10（大疆）：「至今」必须原样透传，不能在这里被切成 null。
  // 大疆/Moka 把「起止时间」拆成 起年/起月/止年/止月 四个下拉 + 一个「至今」复选框，
  // 走的是 DATE_SEG_RE 切片路径。原先 /(\d{4})/ 匹配不到「至今」→ return null → 值变 ∅ →
  // 整个填充路径压根不执行 → 下游 tickToNowCheckbox 也就永远没机会勾那个复选框
  //（实测 VizLib 项目 end="至今"，结束年/月双双 ∅，复选框空着）。
  // 透传后由 fillFieldAsync 的「至今」分支统一勾选，年/月两格各触发一次也没关系——
  // tickToNowCheckbox 自带 cb.checked 幂等保护，不会二次点击把勾取消。
  if (/^\s*(至今|至\s*今|今|现在|在读|在职|至现在|present|now|current)\s*$/i.test(String(val))) return "至今";
  const m = String(val).match(/(\d{4})\D{0,3}(\d{1,2})?\D{0,3}(\d{1,2})?/);
  if (!m) return null;
  if (seg === "年") return m[1];
  // 去前导零：下拉选项多是「9月」「9」，findSelectOption 用 9 比用 09 命中率高
  if (seg === "月") return m[2] ? String(Number(m[2])) : null;
  return m[3] ? String(Number(m[3])) : null;
}

// v0.7.2：最高学历 = 按学位层级取最高者（博士>硕士>本科>大专>高中…）。
// 用于 Moka 等 ATS 的「最高学历」独立下拉（不挂在某个教育卡内）。
function highestDegree(profile) {
  const list = (profile.education || []).slice();
  if (!list.length) return null;
  const RANK = { 博士后: 7, 博士: 6, 硕士: 5, 研究生: 5, 本科: 4, 学士: 4, 大专: 3, 专科: 3, 高职: 3, 高中: 2, 中专: 2, 中职: 2, 初中: 1, 小学: 0 };
  let best = null, bestR = -1;
  for (const e of list) {
    const d = (e.degree || "").trim();
    const r = RANK[d] != null ? RANK[d] : -1;
    if (r > bestR) { bestR = r; best = d; }
  }
  return best || null;
}

function matchField(field, profile, indices) {
  const seg = (field.label || "").match(DATE_SEG_RE);
  if (!seg) return matchFieldCore(field, profile, indices);
  const base = Object.assign({}, field, {
    label: field.label.replace(DATE_SEG_RE, "").trim(),
  });
  return sliceDateSegment(matchFieldCore(base, profile, indices), seg[1]);
}

function matchFieldCore(field, profile, indices) {
  let label = (field.label || "").toLowerCase();
  // v0.7.2：标签为空（仅 placeholder=请选择/请输入，如 Moka 的「最高学历」「学历」下拉）
  // 用区块标题兜底做匹配，否则这些下拉永远空着。仅当标签本身无信息时兜底，
  // 已有真实标签（学校名称/专业等）的字段不受影响。
  if (!label || /^请(输入|选择)$/.test(label)) {
    const _sec = (field.section || "").trim();
    if (_sec) {
      if (/最高学历/.test(_sec)) return highestDegree(profile);
      label = _sec.toLowerCase();
    }
  }
  // v0.6.57：美团站点先走专属映射（城市提取 / 证件类型默认身份证 / 工作类型默认实习）
  if (isMeituan()) {
    const mt = matchFieldMeituan(field, profile, indices);
    if (mt !== undefined) return mt;
  }
  let section = field.section || "unknown";
  const elType = (field.type || "").toLowerCase();
  const basics = profile.basic || {};

  // ── v0.8.6（#271 · section 归属错乱的根治）──────────────────────────────────
  // guessSection() 的规则是「取输入框上方最近的板块标题」。这在有标题的页面上没问题，
  // 但 Moka（app.mokahr.com 全家 + 大疆）**基本信息区压根没有标题节点**，于是这些字段
  // 会被算到「上方最近」的某个不相干标题名下。真机 map-table 实测（robosense）：
  //     0|work|性别=>∅       1|work|工作经验=>∅     3|internships|所在地=>∅
  //     5|languages|身份证=>∅ 7|awards|当前薪资=>∅   8|awards|期望薪资=>面议
  // 而「性别 / 工作经验 / 最高学历 / 所在地」这些规则全都写在
  // `if (section === "basic" || section === "unknown")` 块里 —— 分支互斥，直接被跳过，
  // 于是映射阶段就吐 ∅。之前一直以为是「下拉点不中」，在组件适配上白折腾了一整晚。
  //
  // 修法：这批字段的语义**只可能属于基本信息**，不管页面把它们排版在哪个板块下面，
  // 一律强制回 basic 分支。全部用 ^$ 锚定或加限定词，避免误伤各经历卡内的同名字段
  //（如教育卡里的「学历」不能被「最高学历」规则抢走，工作卡里的「起止时间」更不能动）。
  const IDENTITY_LABEL_RE =
    /^性别$|^工作经验$|工作年限|从业年限|^最高学历$|^所在地$|^现居住?地$|^目前所在地$|^常住地$|身份证|^证件号码$|^证件类型$|^出生日期|^出生年月|^民族$|^政治面貌$|^婚姻状况$|^籍贯$|^户口所在地$|^当前薪资$|^期望薪资$|^期望城市$|^最近公司$/;
  // 【2026-08-10 修正】原名单里还有 ^听说$|^读写$，是错的：
  // 这两个字段在 Moka/大疆是**语言卡片内部**的下拉（每张卡一组「语言类型/掌握程度/听说/读写」）。
  // 一旦强制改判成 basic，就丢掉了 indices.languages 卡片上下文，落到 4541 行那条
  // 「取 profile.languages[0].level」的兜底 → 日语卡、普通话卡的听说读写全被写成英语的水平。
  // 真机 map-table 实测：92|languages|听说=>无障碍商务沟通（该卡其实是日语，应为精通）。
  // 改法：不再强制改判，section 保持 languages 走下面的按卡取值分支；
  // 若某站点确实把听说/读写放在无卡片的基本信息区，section 本就是 basic/unknown，4541 兜底照旧生效。
  if (section !== "basic" && IDENTITY_LABEL_RE.test(label)) {
    section = "basic";
  }

  // ── v0.8.3（#266）：拼多多专属兜底 ────────────────────────────────────────────
  // 拼多多「编辑」展开后把各类字段平铺在同一张卡里，section 路由不一定命中，
  // 且部分字段（出生月份/证件类型）无 <label> 只有 placeholder。直接按标签/占位兜底最稳。
  // 数据全部来自用户自己导入的档案，不涉及任何隐私。
  if (/pddglobalhr\.com/i.test(location.hostname)) {
    const _b = profile.basic || {};
    const _edu = (profile.education || [])[0] || {};
    const _papers = profile.papers || [];
    const _comps = profile.competitions || [];
    const _awards = profile.awards || [];
    if (/证件号|身份证号/.test(label)) return _b.idNumber || null;
    if (/微信号|微信/.test(label)) return _b.wechat || socialAccountOf(profile, /微信|wechat|weixin/i) || null;
    if (/毕业学校专业/.test(label)) {
      const v = [(_edu.school || ""), (_edu.major || "")].filter(Boolean).join(" ");
      return v || null;
    }
    if (/竞赛获奖情况|竞赛获奖/.test(label)) {
      const c = _comps.slice(0, 3).map((x) => `${x.name || ""} ${x.level || ""}`.trim()).filter(Boolean);
      if (c.length) return c.join("；");
      const a = _awards.map((x) => x.name || "").filter(Boolean);
      return a.length ? a.join("；") : null;
    }
    if (/发表论文情况|已发表论文/.test(label)) {
      const p = _papers.slice(0, 3).map((x) => (x.name || x.title || "")).filter(Boolean);
      return p.length ? p.join("；") : null;
    }
    // 出生年月：拼多多拆成「月份」下拉 + 无标签输入框（如 日）。月份占位含「月份」→ 取 MM。
    if (/月份/.test(label) || /请选择月份/.test((field.placeholder || ""))) {
      const bm = (_b.birth || "").split("-");
      return bm[1] ? String(parseInt(bm[1], 10)) : null;
    }
    // 证件类型：紧随证件号码、无 label 的下拉 → 默认身份证
    if (/^请选择$|^$/.test(label) && elType.indexOf("select") >= 0) return _b.idType || "身份证";
  }

  // ── v0.8.31（2026-08-12）：腾讯 join.qq.com 专属兜底 ───────────────────────────────
  // 腾讯「证件类型」el-select 没有有效 label（仅 placeholder「请选择」），通用链路读不到 →
  // 下拉从未被打开，身份证号填了却显示「请选择」、整组被标黄。这里仿拼多多块，对无 label 的
  // 证件类型/证件号下拉兜底（数据来自 profile.basic，不涉及隐私）。
  if (/join\.qq\.com/i.test(location.hostname)) {
    const _b = profile.basic || {};
    if (/证件号|身份证号/.test(label)) return _b.idNumber || null;
    // 证件类型：无 label 的下拉 → 默认身份证（与拼多多同口径）
    if (/^请选择$|^$/.test(label) && elType.indexOf("select") >= 0) return _b.idType || "身份证";
    // 作品集「密码或提取码」：腾讯作品链接下方提取码框（section=portfolio）
    // 2026-08-13：不要固定取 portfolio[0]，按当前作品卡片的索引取，避免第 N 个作品的密码填错。
    if (section === "portfolio" && /密码|提取码|访问码|口令|password|passcode/i.test(label)) {
      const idx = indices.portfolio;
      const item = (profile.portfolio || [])[idx] || {};
      return item.password || null;
    }
  }

  // ── v0.8.5（#269）：网易 campus.163.com 专属兜底 ────────────────────────────────
  // 只兜「教育卡之外、通用规则确实没有的三个字段」，不碰教育卡内的日期/学校
  // （那些走下面按 indices 取第 N 条经历的通用分支，硬兜会把第 2 段教育写成第 1 段的值）。
  if (/campus\.163\.com/i.test(location.hostname)) {
    const _b = profile.basic || {};
    const _e0 = (profile.education || [])[0] || {};
    if (/^国籍$/.test(label)) return _b.country || "中国";
    // 学校所在地 / 家庭所在地 都是 antd 级联，值给「省 市」两级即可，tryPickAntdCascader 会逐级点
    if (/学校所在地|院校所在地/.test(label)) {
      return _e0.city || _e0.location || _b.locationProvince || "北京市";
    }
    if (/家庭所在地|家庭住址|生源地/.test(label)) {
      const hp = _b.hometownProvince || "";
      const hc = _b.hometownCity || "";
      return (hp || hc) ? [hp, hc].filter(Boolean).join(" ") : _b.hometown || null;
    }
  }

  // ★ v0.8.40（A3）硬闸门必须放在**所有**取值通道之前，包括 intent 声明值通道 ——
  //   「是否接受调剂」源文档里虽写了「是」，intentDeclaredValue 会照填（实测蔚来被选中），
  //   而用户明令此项不填。闸门放这里才能同时封住 intent 通道与下方全部常规规则。
  if (isNoSourceDataField(label)) {
    rfaLog({ act: "a3-gate-skip", label: String(label).slice(0, 30) });
    return null;
  }

  // 需要用户自己拿主意的主观/决策类字段，一律不动（避免误填“是否接受调剂/是否全日制/入职时间”等）。
  // 「是否为全日制在校学生」已含「是否全日制」，会被下面 FORBIDDEN_RE 拦截，本就不填。
  // v0.7.0：先看用户是否在 intent 里明确声明过——声明了就是用户自己的决定，放行。
  const _declared = intentDeclaredValue(label, profile, field);
  if (_declared) return _declared;
  // ── v0.8.40（2026-08-14 · A3 硬闸门：源文档里没有的数据，一个字都不填）──────────
  // 用户 2026-08-13 复核蔚来时明令（原话）：「是否有亲友入职这个地方不选呀？还有一个预计入职
  // 时间，这个地方也别选…申请信息，也别填呀…是否接受调剂？是否为全日制在校大学生？这些都不填。
  // **只要说我们这个里面没有的，都别填**」。
  // 已核对源文档 outputs/test-data/测试最终123.docx：
  //   · 「亲友入职」          → 源文档**无**此项 → 不填（旧代码硬编码 return "否"，属于替用户猜答案）
  //   · 「是否为全日制在校学生」→ 源文档只有学历的「学习形式：全日制」，**没有**"是否在校学生"这道
  //                             合规问答的答案 → 不填（旧代码用 education 反推 是/否，同样是猜）
  // 这两条硬编码于此删除。删除后它们由下方 FORBIDDEN_RE 正常拦截，留空标黄交用户自己答。
  // ⚠️ 回归护栏：删掉「亲友」分支后，务必确认没有别的通用通道（唯一选项必选 R4 / radio 兜底）
  //    再把它勾上 —— 已在 chooseRadioValue 侧同步加拦截，见 NO_SOURCE_DATA_RE。

  // 主观/决策类字段的总闸：上面两条客观规则放行之后，其余（是否接受调剂 / 期望薪资 /
  // 同意条款…）一律不替用户拿主意。forbiddenButRequired 给「必填的客观题」留了一道口子。
  if (FORBIDDEN_RE.test(label) && !forbiddenButRequired(label, field)) return null;

  // v0.7.2：学位下拉（含 Moka「学历」这类无独立 label、已用 section 兜底成 label=学历 的框）。
  // 不依赖 section==="education" 守卫，确保独立学位下拉也能命中；排除「学历类型/学习形式/
  // 培养方式/全日制」等，避免与下方 eduType 规则冲突。
  if (/学历|学位|degree/.test(label) && !/学历类型|学习形式|培养方式|全日制|非全日制|edutype|edu_type/.test(label)) {
    const eds = profile.education || [];
    const ed = eds[indices && indices.education] || eds[0] || {};
    return (ed.degree && String(ed.degree).trim()) || highestDegree(profile) || null;
  }

  // v0.6.47：主观评级字段（精通程度/熟练程度/语言水平等）默认不填，避免插件替用户瞎判断。
  // v0.6.62 例外：语言板块里若用户档案已明确写了水平/分数（如「熟练」「CET-6 621」），
  // 那是简历原文里的客观事实、不是插件猜的，应当照填。仅在档案确有值时放行，否则仍留空。
  if (SUBJECTIVE_RATING_RE.test(label)) {
    // v0.7.1：这里必须与下方 languages 分支、以及 getSectionNeeded 用同一份数组，
    // 否则去重站点（字节）上取到的是原始数组的条目，等级判断跟着错位。
    const _li = section === "languages" ? (languagesForPage(profile)[indices.languages] || {}) : null;
    if (!_li || !(_li.level || _li.score)) return null;
  }

  // ── v0.7.0：资料证明人（腾讯必填三连）──────────────────────────────────────────
  // 必须排在 basic 之前！腾讯这三个框的 label 取自 placeholder：
  //   「请输入资料证明人」「请输入证明人身份」「请输入证明人联系电话」。
  // 若板块识别没兜住、section 落到 unknown，第三个框会先命中 basic 里的 /电话/ 规则，
  // 被填成求职者本人手机号——这是会直接把简历填错的硬故障，所以提前拦截。
  {
    const rf = profile.reference || {};
    // 顺序要紧：「证明人身份」「证明人联系电话」都含「证明人」三字，
    // 身份/电话必须排在姓名规则之前，否则三个框会被填成同一个人名。
    if (/证明人.*(电话|手机|联系方式)|联系电话.*证明人/.test(label)) {
      const rp = rf.phone;
      if (!rp || !/^[\d\-+\s()]{7,20}$/.test(rp)) return null;
      return stripCnPhone(rp);
    }
    if (/证明人.*(身份|职位|职务|关系)|身份.*证明人/.test(label)) return rf.identity || null;
    if (/资料证明人|证明人|推荐人/.test(label)) return rf.name || null;
    // 板块已识别为 reference 时，「联系电话」这类裸标签也归证明人
    if (section === "reference") {
      if (/电话|手机|联系方式/.test(label)) {
        const rp = rf.phone;
        return rp && /^[\d\-+\s()]{7,20}$/.test(rp) ? stripCnPhone(rp) : null;
      }
      if (/身份|职位|职务/.test(label)) return rf.identity || null;
      if (/姓名|名字|name/i.test(label)) return rf.name || null;
    }
  }

  // ── v0.7.2：「概要型」顶层字段（Moka/北森类 ATS 的申请页头部常见）───────────────
  // 这类字段不在任何经历板块里，而是要求填「最近一段」经历的摘要，例如：
  //   Moka：「最近公司」「最近职位」「请输入最近毕业专业」「最近毕业院校」。
  // 必须排在 basic 之前：「最近毕业专业」含「专业」二字，落到 basic 会被当成本人专业
  // （恰好也对），但「最近公司」在 basic 里无规则、会一路穿到 fallbackMap 被乱填。
  // 档案里 education[0] / internships[0] 即视为最新一条（与 1752 行既有约定一致）。
  {
    const _recent = /最近|最新|近期|当前|目前|latest|current|recent|most\s*recent/;
    if (_recent.test(label)) {
      const _edu0 = (profile.education || [])[0] || {};
      const _job0 =
        (profile.work && profile.work.length ? profile.work : profile.internships || [])[0] || {};
      // 顺序要紧：「最近毕业院校」同时含「毕业」和「院校」，学校规则要排在专业之前
      if (/公司|企业|单位|雇主|company|employer/.test(label)) return _job0.company || null;
      if (/职位|岗位|职务|title|position/.test(label)) return _job0.title || _job0.position || null;
      if (/学校|院校|大学|毕业院校|school|university/.test(label)) return _edu0.school || null;
      if (/专业|major/.test(label)) return _edu0.major || null;
      if (/学历|degree/.test(label)) return _edu0.degree || null;
      // 没命中具体子类就放行，交给后面的常规规则，别在这里吞掉
    }
  }

  // 基础信息（通常属于 basic 板块，但也可能在 unknown）
  if (section === "basic" || section === "unknown") {
    // v0.7.0（腾讯）：紧急联系人三连必须排在本块「最前面」。
    // 腾讯的 label 取自 placeholder：「请输入紧急联系人姓名」含「姓名」二字、
    // 「请输入紧急联系人电话」含「电话」二字。若不提前拦截，会分别被下面的通用
    // 「姓名」「手机/电话」规则填成求职者本人的姓名和手机号 —— 这是会把简历填错的硬故障。
    if (/紧急联系人.*(电话|手机|联系方式)|紧急.*(电话|手机)/.test(label)) {
      const ep = basics.emergencyPhone;
      if (!ep || !/^[\d\-+\s()]{7,20}$/.test(ep)) return null;
      return stripCnPhone(ep);
    }
    if (/紧急联系人.*(关系|与本人)|与本人关系/.test(label)) return basics.emergencyRelation || null;
    if (/紧急联系人|紧急联络人/.test(label)) return basics.emergencyContact || null;

    if (/姓名|名字/.test(label)) return basics.name;
    // 邮箱：必须 label/type 明确是邮箱，且值必须含 @
    if (elType.includes("email") || /邮箱|邮件|e-mail|email/.test(label)) {
      return basics.email && basics.email.includes("@") ? basics.email : null;
    }

    // v0.7.1（#185）：手机号「国家/区号」前缀下拉（Element UI el-select，type=div）。
    // 其相邻帮助文案「如您是中国大陆籍…」会被读成 label，落入下面手机规则会被填成号码本身——那是错的，必须先拦截。
    // v0.7.0 曾以「留空即等于 +86」为由显式返回 null，但实测腾讯把它标成必填且默认空值，
    // 且按产品铁律：通用、非隐私、非站点专属的下拉一律由插件 100% 自动选完，不留给用户点。
    // 因此改为主动给值：默认「中国 +86」；若档案手机号自带别国国家码（+852/+1…）则跟随它。
    // v0.8.13（字节修复）：字节/飞书社招的区号下拉 label 就是「手机号码」（无「区号/86」字样），
    //   且是 div 下拉形态——旧判定命中不了，matchValue 会落入下方 /手机|电话/ 规则把「手机号本身」
    //   （如 13800000000）当值返回 → 输入框型下拉用它搜索 → 过滤出含「1340」的邻近选项 → 错选 +1340（真机铁证）。
    //   故放宽：div 下拉形态 + label 含 手机/电话/区号/86 → 一律按区号下拉处理，返回「+档案区号」。
    if (field.type === "div" && /(如您是中国大陆籍|区号|86.*手机|手机.*86|手机号.*区号|国家.*区号|区号|手机号码|手机号|手机|电话)/.test(label)) {
      // v0.8.13：优先级 = 用户面板设置（档案 basic.phoneCc，如 "86"）> 档案自带国家码（+852/+86 等，安全提取）> 无则 null（铁律：不默认 +86）。
      const cc = RFA_USER_PHONE_CC || extractCcFromPhone(String(basics.phone || "")) || "";
      if (!cc) return null;
      return "+" + cc;
    }

    // 手机/电话：label/type 明确是电话，绝不给邮箱
    if (elType.includes("tel") || /手机|电话|tel|mobile/.test(label)) {
      if (!basics.phone || !/^[\d\-+\s()]{7,20}$/.test(basics.phone)) return null;
      return stripCnPhone(basics.phone); // v0.6.58：去掉 +86，避免和区号选择器重复
    }
    // v0.7.0（腾讯）：微信号 / QQ 号
    // v0.7.2：微信 / QQ 先读 basic，读不到再回落到 social 数组按平台名找。
    // 实测（08-06 腾讯真机）：档案 basic 里根本没有 wechat/qq 字段（popup 也没有这两个录入项），
    // 但 social 里明明存着 {platform:"微信", account:"exampleuser_2026"} —— 数据在手边却填不进去。
    // 回落到 social 后，腾讯的「请输入微信号」立刻能填，且对所有站点通用。
    if (/微信号|微信\s*id|wechat|weixin/i.test(label)) {
      return basics.wechat || socialAccountOf(profile, /微信|wechat|weixin/i) || null;
    }
    if (/qq\s*号|^qq$/i.test(label)) {
      return basics.qq || socialAccountOf(profile, /^qq$|qq\s*号/i) || null;
    }
    // 求职意向/目标岗位/应聘职位
    if (/求职意向|目标岗位|应聘岗位|应聘职位|期望岗位|期望职位|岗位|职位/.test(label)) {
      return basics.targetPosition || basics.jobIntention || null;
    }
    if (/性别/.test(label)) return basics.gender;
    // 出生年月：覆盖「出生/生日/birth」语义，以及基本信息里占位标签为 YYYY-MM 的日期框
    if (/出生|生日|birth|yyyy-?mm/i.test(label)) {
      // v0.6.47：统一归一化为 YYYY-MM（月输入框只认这个格式；"2000.08"/"2000年08月"都要转）。
      const b = basics.birth;
      if (b) {
        const pm = parseYearMonth(b);
        if (pm) return `${pm.year}-${String(pm.month).padStart(2, "0")}`;
      }
      return b;
    }
    // v0.7.0：加守卫——「期望工作城市 / 参加面试城市 / 目前就读地」都含「城市/地」二字，
    // 一旦板块识别没兜住（section 回落到 basic/unknown），它们会被填成"当前所处地"，属于硬错误。
    // 「所处地」也要认：腾讯「当前所处地*」是必填级联，原正则只有「所在地」匹配不上，整项空着。
    if (
      /城市|所在地|所处地|现居|居住|location|地址/.test(label) &&
      !/期望|意向|面试|就读|入职|工作城市/.test(label)
    ) {
      return basics.location;
    }
    // v0.7.0（腾讯）：证件所属「国家/地区」与「国籍」不是一回事（腾讯要「中国大陆」，国籍是「中国」）
    if (/国家\s*[\/／]\s*地区|证件.*(国家|地区)/.test(label)) {
      return basics.idCountry || basics.nationality || null;
    }
    // 通用基础字段（所有招聘站通用，不是站点专属）
    if (/国籍|国家|地区/.test(label) && !/地区.*(要求|限制|政策)/.test(label)) {
      // v0.8.5（#269）：档案里的 nationality 存的是**民族**（"汉族"），而网易/拼多多这类站的
      // 「国籍」是下拉，选项是「中国 / 中国香港 / 美国…」，拿"汉族"去匹配一辈子匹配不上 → 恒空。
      // 只要值以「族」结尾（民族口径），国籍一律回落到「中国」；真正的民族字段走下面的 ethnicity。
      const _nat = basics.nationality || "";
      if (/民族/.test(label)) return _nat || basics.ethnicity || null;
      // v0.8.20：值统一给「中国」，findSelectOption 的国家/地区归一化分支会在选项含
      //   「中国大陆」时自动优选大陆条目；纯文本框直接填"中国"也正确。
      if (!_nat || /族$/.test(_nat)) return basics.country || "中国";
      if (/^中国大陆?$|^中华人民共和国$/.test(_nat.trim())) return "中国";
      return _nat;
    }
    if (/家乡/.test(label)) return basics.hometown;
    // v0.7.0（腾讯）：个人主页链接
    if (/个人主页|个人网站|homepage|personal\s*(page|site)/i.test(label)) return basics.homepage || null;
    // v0.8.9（#279 · B站）：jobs.bilibili.com 基本信息区有两个独立链接框
    //   「作品链接」（占位：请填写作品链接（多个请换行））、「GitHub URL/ID」。
    // 旧版没有任何规则命中它俩，B站长期卡在 3/11=27%。
    // 作品链接取 AI 项目链接 → 个人主页兜底；GitHub 先从 socials 按平台名捞，
    // 捞不到再从任意含 github.com 的链接里切一段出来（aiSkills.link 是「A ｜ B」拼串）。
    if (/github/i.test(label)) {
      const _soc = (profile.socials || []).find((s) => /github/i.test((s.platform || "") + (s.link || "")));
      if (_soc) return _soc.link || _soc.account || null;
      const _gl = [(profile.aiSkills || {}).link, basics.homepage]
        .filter(Boolean)
        .map(String)
        .find((s) => /github\.com/i.test(s));
      if (_gl) return _gl.split(/\s*[｜|]\s*/).find((x) => /github\.com/i.test(x)) || _gl;
      return null;
    }
    if (/作品链接|作品集|作品地址|portfolio|demo\s*链接/i.test(label)) {
      return (profile.aiSkills || {}).link || basics.homepage || null;
    }
    // v0.6.58：个人证件（字节跳动等站点必填）。证件号码只在本地匹配，不经过 AI。
    // v0.8.20：档案里 idType 常写全称「中华人民共和国居民身份证」，而多数站下拉/文本
    //   选项写「居民身份证」或「身份证」。这里归一化去掉「中华人民共和国」前缀，
    //   findSelectOption 的证件分支再做精确匹配。
    // v0.8.41（#394）：「个人证件」是卡片标题，会被同时当作类型框与号码框的 label → 号码框误拿 idType("身份证")。
    //   用元素类型消歧：下拉(select)=证件类型→idType；文本(input)=证件号码→idNumber。避免盲收窄正则把类型框反填成号码值。
    if (/证件类型|证件种类|id\s*type/.test(label) || (/个人证件/.test(label) && /select/i.test(elType || ""))) {
      const raw = String(basics.idType || "").trim();
      if (!raw) return "身份证";
      return raw.replace(/^中华人民共和国/, "") || "身份证";
    }
    if (/证件号|身份证号|证件编号|id\s*(number|no)\b/.test(label) || (/个人证件/.test(label) && /input|text/i.test(elType || ""))) return basics.idNumber || null;
    // v0.7.4（#210）：开发语言 / 技术栈（通用，非站点专属）
    if (/开发语言|编程语言|掌握.*语言|技术栈|tech\s*stack/i.test(label)) {
      if (profile.devLang) return profile.devLang;
      if (profile.skills && !Array.isArray(profile.skills) && profile.skills.devLanguages) return profile.skills.devLanguages;
      if (Array.isArray(profile.skills) && profile.skills.length) return profile.skills.join("、");
      return null;
    }
    // v0.7.4（#210）：腾讯「AI应用技能」三连文本域
    if (/AI\s*应用|AI\s*工具|与\s*AI\s*协作|AI\s*协作|相关项目或作品|AI\s*相关/.test(label)) {
      // 注意：popup 存储键为 collabProject / link（见 AI_SKILL_FIELDS），
      // 这里必须与之一致，否则 AI 项目/链接框恒空。
      const ai = profile.aiSkills || {};
      if (/工具|模型/.test(label)) return ai.tools || null;
      if (/协作|项目|任务/.test(label)) return ai.collabProject || null;
      if (/链接|作品|demo|github|blog/i.test(label)) return ai.link || null;
      return ai.tools || null;
    }
    // 实习时长 / 每周可出勤天数（腾讯单选必填唯一项，无值时由 fillDropdown/fillCombobox R4 兜底选唯一项）
    if (/实习时长|可实习时长|实习时间/.test(label)) return basics.internshipDuration || null;
    if (/每周可出勤|出勤天数|到岗天数|每周到岗/.test(label)) return basics.weeklyDays || null;

    // ── v0.7.9（#264 续）：label 提取修好后，Moka 暴露出的两类新留白 ──────────────────
    // (a) Moka 把「证件号码」字段盒的标题渲染成已选证件类型「身份证」，盒里有两个控件：
    //     证件类型下拉（由 findSelectOption 的证件类型分支消化）+ 号码输入框（要的是号码本身）。
    //     两者同名，统一返回号码即可：下拉分支会把号码识别成「居民身份证」，输入框直接填号。
    if (/^(身份证|证件|护照|港澳通行证|台湾通行证|回乡证)$/.test(label)) return basics.idNumber || null;
    // (b) Moka 语言能力拆成「听说」「读写」两个独立等级下拉，取档案首个语言的水平。
    if (/^(听说|读写|听说能力|读写能力|口语|书面|听力|阅读)$/.test(label)) {
      const _lg = (profile.languages || [])[0] || {};
      return _lg.level || "熟练";
    }

    // ── v0.7.8（#263）：Moka 体系（大疆 + app.mokahr.com 全家）三个共性留白字段 ──────────
    // 这几项档案里天然没有（学生档案不会写"工作经验/当前薪资"），但它们是下拉/必填，
    // 空着会被算进未填。给应届生一套合理默认值，让下拉能选中而不是交白卷。
    if (/工作经验|工作年限|工作年份|从业年限|years?\s*of\s*experience/i.test(label)) {
      if (basics.workYears) return basics.workYears;
      // 从工作/实习经历推算：有经历也仍算应届（都是实习），统一给「应届毕业生 / 1年以下」
      // findSelectOption 会在候选项里做语义匹配，两种常见写法都给出去。
      return "应届毕业生";
    }
    if (/当前薪资|目前薪资|现薪资|当前年薪|current\s*salary/i.test(label)) {
      return basics.currentSalary || (profile.intent && profile.intent.currentSalary) || "面议";
    }
    if (/期望薪资|薪资期望|期望年薪|expected\s*salary/i.test(label)) {
      return (profile.intent && (profile.intent.expectedSalary || profile.intent.salary)) || "面议";
    }
    // 最高学历（Moka/大疆是下拉，腾讯是卡片内字段）：从教育经历里取最高的那条
    if (/最高学历|最高教育|highest\s*(degree|education)/i.test(label)) {
      if (basics.highestDegree) return basics.highestDegree;
      const eds = (profile.education || []).map((e) => String((e && (e.degree || e.education)) || ""));
      const rank = ["博士", "硕士", "研究生", "本科", "学士", "大专", "专科", "高中"];
      for (const r of rank) { if (eds.some((d) => d.includes(r))) return r; }
      return eds[0] || null;
    }
    // 注意：是否有亲友在NIO 等属于某站点专属字段，通用版不内置，留给用户手动填。
  }

  // ── v0.7.0：意向信息（腾讯「意向信息」板块；其他站点该类字段散落在 basic 也能命中）────────────
  {
    const it = profile.intent || {};
    // R3 站点专属强制项：腾讯「感兴趣的事业群 / 感兴趣的部门」与公司内部组织架构强绑定，
    // 插件不猜、不填，明确留给用户自己选（用户已确认这条）。
    if (/事业群|感兴趣的部门|意向部门|申请部门|business\s*group/i.test(label)) return null;

    // v0.7.5：期望工作城市「改为要填」（旧的"腾讯不填"hostname 守卫已作废，
    // 那条守卫导致腾讯这个必填项一直空着 → 达不到 100% 填满的验收标准）。
    if (/期望.*(工作)?城市|意向城市|期望工作地|意向工作地|期望城市/.test(label)) {
      const cs = it.expectedCities;
      if (Array.isArray(cs) && cs.length) return cs.slice(0, 3).join("、"); // 腾讯限至多三个
      return cs || null;
    }
    if (/(参加)?面试城市|面试地点/.test(label)) return it.interviewCity || null;
  }

  // v0.7.0：三合一「其他关键信息」必须抢在「自我评价」单条规则之前判定（原因见 isComboOtherInfoLabel）
  if (isComboOtherInfoLabel(label)) return composeOtherInfo(profile);

  // 自我评价（可能单独成板块，也可能在 basic/unknown）
  // 注意：不能只要板块是 selfEval 就填，否则会把“申请信息”等相邻字段误填成自我评价
  if (/自我评价|个人评价|自我介绍|自我描述/.test(label)) {
    return (profile.otherInfo && profile.otherInfo.selfEval) || profile.selfEval;
  }
  // 仅当本字段确实在 selfEval 板块内时，「URL / ID / 主页 / 社交账号 / 作品链接」等才取作品集链接；
  // 必须加 section 守卫，否则会误伤 projects/portfolio 板块里同样含「链接」二字的字段（如「项目链接」）。
  if (section === "selfEval" && /url|链接|主页|作品|社交|id|github|blog|网站|个人|portfolio|git/i.test(label)) {
    const pf = (profile.portfolio || []).find((p) => p && p.link) || {};
    return pf.link || null;
  }
  if (section === "selfEval" && (!label || /内容|描述|评价|介绍|简述|summary|overview/i.test(label))) {
    return profile.selfEval;
  }

  // 教育经历
  if (section === "education") {
    const idx = indices.education;
    const item = (profile.education || [])[idx] || {};
    // v0.7.0（腾讯）：GPA 两个框必须排在本块「最前面」。
    // 腾讯满绩框的 placeholder 是「请输入你所在院校的满绩绩点」，含「院校」二字，
    // 若不提前拦截会被下面的 /学校|院校/ 规则填成学校名（实测填出「示例学校」）。
    if (/满绩|满分绩点|gpa[\s\-_]*base|绩点.*(满|总)|所在院校.*绩点/i.test(label)) {
      return item.gpaBase || "";
    }
    if (/gpa|绩点|平均学分绩/i.test(label)) return item.gpa || "";
    // v0.6.58：「是否全日制」是客观事实，从 eduType 推导出 是/否（必须排在下面的「全日制」规则之前，
    // 否则会被当成「学习形式」直接回填“全日制”三个字，而该字段其实只接受 是/否）。
    if (/是否全日制|是否为全日制|全日制\s*[?？]/.test(label)) {
      const et = item.eduType || "";
      if (!et) return null;
      if (/非全日制|在职|自考|成人|函授|网络教育|业余|夜大/.test(et)) return "否";
      if (/全日制|统招|普通高等|普通全日制/.test(et)) return "是";
      return null;
    }
    // 学历类型（培养方式）优先于学历/学位，避免两者混淆
    if (/学历类型|学习形式|培养方式|全日制|非全日制|edutype|edu_type/.test(label)) return item.eduType || "";
    // v0.6.58：学院/院系必须排在「学校」之前——「学院名称」不含“院校/学校”，但排后面容易被后续规则抢走
    if (/学院|院系|系别|所在院系|faculty/.test(label) && !/院校/.test(label)) return item.college || "";
    if (/学校|院校|毕业院校|school|university|college/.test(label)) return item.school;
    if (/专业|major/.test(label)) return item.major;
    // v0.7.0（腾讯）：目前就读地（级联城市选择器）
    if (/就读地|在读地|学校所在地|院校所在地/.test(label)) return item.studyLocation || item.location || (profile.basic && profile.basic.location) || "";
    // 说明：GPA / 满绩 已在本块开头处理（必须早于「院校」规则），此处不再重复。
    // v0.6.58：成绩排名 / 导师 / 实验室 / 研究方向（研究生岗位常见必填）
    if (/成绩排名|专业排名|年级排名|班级排名|排名|rank/.test(label)) return item.rank || "";
    // v0.7.0（腾讯）：教育板块内的「论文」文本域＝已发表论文，取本条教育经历的 thesis；
    // 若该条没写，回落到全局 papers[] 拼一份（避免研究生岗必填项空着）。
    if (/论文|已发表论文|publication/i.test(label)) {
      if (item.thesis) return item.thesis;
      const ps = profile.papers || [];
      if (!ps.length) return null;
      return ps
        .map((p, i) => `${i + 1}. ${p.name}${p.venue ? `（${p.venue}${p.order ? "，" + p.order : ""}）` : ""}`)
        .join("\n");
    }
    if (/导师|指导老师|指导教师|tutor|supervisor|advisor/.test(label)) return item.tutor || "";
    if (/实验室|课题组|研究所|lab\b/.test(label)) return item.lab || "";
    if (/研究方向|领域方向|研究领域|方向|research/.test(label)) return item.research || "";
    if (/学历|学位|degree/.test(label)) return item.degree || "";
    // v0.8.5（#269）：网易 campus.163.com 的写法是「入校时间」「获得学位证时间」，
    // 旧正则只认「入学 / 毕业」，两格恒空。补进同义词，对其他站点零影响。
    if (/开始|起始|入学|入校|入读|start/.test(label)) return item.start;
    if (/结束|截止|毕业|学位证|离校|end/.test(label)) return item.end;
    if (/起止|时间|年月|period/.test(label)) return formatRange(item.start, item.end);
  }

  // 实习/工作经历
  if (section === "internships") {
    const idx = indices.internships;
    const item = (profile.internships || [])[idx] || {};
    // v0.6.58：工作类型（美团/字节等必填下拉）。必须排在「经历/描述」规则之前，
    // 否则「经历类型」会被 /描述|简介|经历/ 抢走填成一段工作描述。默认「实习」。
    if (/工作类型|经历类型|实习类型|工作性质|任职类型|职位类型/.test(label)) return item.workType || "实习";
    if (/公司|企业|单位|company|employer|organization/.test(label)) return item.company;
    if (/职位|岗位|职务|title|position/.test(label)) return item.title;
    if (/部门|department/.test(label)) return item.department;
    if (/开始|起始|入职|start/.test(label)) return item.start;
    if (/结束|截止|离职|end/.test(label)) return item.end;
    if (/起止|时间|年月|period/.test(label)) return formatRange(item.start, item.end);
    // #561（2026-08-26 用户拍板）：职责/内容/负责/工作描述类字段 —— 板块内只有 1 个职责类框
    // （Moka 实习「工作职责」单框）→ 合并 描述+职责+成果 三段填入；≥2 个框 → 只填职责，各归各的。
    if (/职责|内容|负责|工作描述|responsibilit|work content/.test(label)) {
      const dutyN = (__RFA_DUTY_COUNT__ && __RFA_DUTY_COUNT__.internships) || 0;
      if (dutyN <= 1) {
        const merged = [item.description, item.responsibilities, item.achievements].filter(Boolean).join("\n");
        if (merged) return merged;
      }
      return item.responsibilities || item.description;
    }
    if (/业绩|成果|产出|achieve|result/.test(label)) return item.achievements;
    // v0.7.1 修复：档案 v2.0 没有 description 字段（拆成了 responsibilities + achievements），
    // 字节/蔚来的经历卡又只有一个笼统的「描述」框 —— 原来这里直接 return undefined，
    // 三张实习卡的描述全是空的。改为拼接职责+成果兜底。
    // #569（2026-08-27 蔚来验证发现）：单框合并只覆盖了「职责」类 label，漏了「描述」类——
    // 蔚来实习经历只有一个「描述」框，实际只填了 description 一段（30字符），没合并职责+成果。
    // 修复：描述框同样套用单框合并逻辑（dutyN<=1 时合并三段），≥2 框时各归各的。
    if (/描述|简介|经历|description/.test(label)) {
      const dutyN = (__RFA_DUTY_COUNT__ && __RFA_DUTY_COUNT__.internships) || 0;
      if (dutyN <= 1) {
        const merged = [item.description, item.responsibilities, item.achievements].filter(Boolean).join("\n");
        if (merged) return merged;
      }
      return item.description || joinExpDesc(item);
    }
  }

  // 工作经历（秋招通常只有实习，若页面只有“工作经历”也先用实习数据填充）
  if (section === "work") {
    const idx = indices.work || 0;
    // v0.7.1 关键修复：仅当页面【没有】独立的实习板块时，才允许用实习数据填工作经历。
    // 字节页两个板块并存，原来的无条件回退会让同一段实习被填两遍（详见 getSectionNeeded 注释）。
    const src =
      profile.work && profile.work.length
        ? profile.work
        : pageHasSection("internships")
          ? []
          : profile.internships || [];
    const item = src[idx] || {};
    if (/公司|企业|单位|company|employer|organization/.test(label)) return item.company;
    if (/职位|岗位|职务|title|position/.test(label)) return item.title;
    if (/部门|department/.test(label)) return item.department;
    if (/开始|起始|入职|start/.test(label)) return item.start;
    if (/结束|截止|离职|end/.test(label)) return item.end;
    if (/起止|时间|年月|period/.test(label)) return formatRange(item.start, item.end);
    // #561：同 internships 单框合并逻辑（work 板块只有 1 个职责类框时同样合并三段）
    if (/职责|内容|负责|工作描述|responsibilit|work content/.test(label)) {
      const dutyN = (__RFA_DUTY_COUNT__ && __RFA_DUTY_COUNT__.work) || 0;
      if (dutyN <= 1) {
        const merged = [item.description, item.responsibilities, item.achievements].filter(Boolean).join("\n");
        if (merged) return merged;
      }
      return item.responsibilities || item.description;
    }
    if (/业绩|成果|产出|achieve|result/.test(label)) return item.achievements;
    // v0.8.x：实习「描述」框兜底拼接三段（描述+职责+成果），与项目板块单框合并逻辑一致
    if (/描述|简介|经历|description/.test(label)) return [item.description, item.responsibilities, item.achievements].filter(Boolean).join(" ");
  }

  // 项目经历
  if (section === "projects") {
    const idx = indices.projects;
    const item = (profile.projects || [])[idx] || {};
    if (/项目名|项目名称|课题|project name/.test(label)) return item.name;
    // #561（2026-08-26）：Moka 项目卡的「职位名称/职位角色」→ 填项目岗位(role)。
    // 旧正则 /角色|职务|岗位|role|position/ 匹配不到「职位名称」（含"职位"但无"岗位/角色/职务"）→ 一直漏填。
    if (/职位名称|职位角色|角色|职务|岗位|担任|role|position/.test(label)) return item.role;
    if (/开始|起始|start/.test(label)) return item.start;
    if (/结束|截止|end/.test(label)) return item.end;
    if (/起止|时间|年月|period/.test(label)) return formatRange(item.start, item.end);
    // 链接字段：明确是“链接/URL/网址/作品”且不是“描述/名称”等。
    // 注意区分「项目链接」(取 projects[].link) 与「作品链接」(取 portfolio[].link)。
    if (
      (elType.includes("url") || /(链接|网址|url|link|作品|portfolio|视频|demo)/.test(label)) &&
      !/(描述|介绍|说明|名称|标题|概要)/.test(label)
    ) {
      if (/作品/.test(label)) {
        const pf = (profile.portfolio || [])[indices.projects] || {};
        return pf.link || item.link || null;
      }
      const pj = (profile.portfolio || [])[indices.projects];
      return item.link || (pj && pj.link) || null;
    }
    // #561（2026-08-26 用户拍板·最终版）：项目「描述/职责/成果/链接」——大框塞全、小框单填。
    // 用户原话（21:58 澄清）：「项目描述」框应把 项目描述+项目职责+项目成果+项目链接 全部放进去（填全）；
    // 「项目中的职责」框只单填 项目职责（单独拎出来，不掺别的）；
    // 职位名称/职位角色 → 填项目岗位(role)。任何两个框绝不填成一模一样。
    // 历史回归根因：旧正则 /项目职责/ 匹配不到「项目中的职责」（中间隔着"中的"），它和「项目描述」
    // 一起滑进兜底都返回合并段 → 一模一样。v0.8.15 曾改为"描述只填 description"，
    // 用户纠正：项目描述框也要填全（描述+职责+成果+链接），职责框才单填职责。
    const _pj = [item.description, item.responsibilities, item.achievements].filter(Boolean).join("\n");
    // 项目描述「塞全」：描述 + 职责 + 成果 + 链接
    const _pjFull = [item.description, item.responsibilities, item.achievements, item.link]
      .filter(Boolean).join("\n");
    const pDutyN = (__RFA_DUTY_COUNT__ && __RFA_DUTY_COUNT__.projects) || 0;
    const pSingleBox = pDutyN <= 1; // 整个项目板块只有 1 个职责/描述类框 → 合并
    // 项目中的职责 / 职责 / 项目职责 → 只单填 responsibilities（绝不掺描述/成果/链接）
    if (/项目.*职责|职责/.test(label)) return item.responsibilities || _pj;
    // 项目成果 → 只单填 achievements
    if (/项目成果|成果/.test(label)) return item.achievements || _pj;
    // 项目描述/项目内容/描述/简介/背景/经历 → 塞全（描述+职责+成果+链接）
    if (/项目描述|项目内容|项目介绍|描述|简介|背景|经历|内容|description/i.test(label))
      return pSingleBox ? _pjFull : _pjFull;
    // 兜底：负责/产出/业绩 等描述类残余 → 塞全（单框合并语义）
    if (/负责|产出|业绩|achieve|result/.test(label)) return pSingleBox ? _pjFull : _pjFull;
    return null;
  }

  // 语言能力
  if (section === "languages") {
    const idx = indices.languages;
    // ── v0.8.x（2026-08-14）：腾讯 join.qq.com 语言能力板块是特殊组合控件：
    //   「外语考试/等级」= el-dropdown 选考试 + input 填分数；「开发语言」= el-select 多选。
    //   这两类字段挂在「语言能力」板块下，会被 A1「不填考试/分数」和语言类型规则误伤，
    //   且 languagesForPage 为 A1 已剥除 exam/score。腾讯无独立「语言类型/精通程度」字段，
    //   故此处按原 profile.languages 特判。
    if (/join\.qq\.com/i.test(location.hostname)) {
      // 开发语言虽挂在语言能力板块下，但本质是技能，不能按语种名回填
      if (/开发语言|编程语言|技术栈/i.test(label)) {
        if (profile.devLang) return profile.devLang;
        if (Array.isArray(profile.skills) && profile.skills.length) return profile.skills.join("、");
        return null;
      }
      // 腾讯「外语考试/等级」= el-dropdown(选考试名) + input(填分数)，二者同属一个板块。
      // 分数 input 的 label 是「分数/请填写分数」，不会命中考试名正则，会被 A1「分数不填」规则清空；
      // 故这里用 [考试名正则] ∪ [分数/score 标签] ∪ [elType=input] 一并捕获，统一算好「最佳英语考试项」。
      // 本板块内唯一 plain input 就是分数框（开发语言是 el-select，其内嵌 input 不算独立字段），按 elType=input 捕获安全。
      if (/外语考试[\/／]?等级|考试[\/／]?等级|分数|score|grade/i.test(label) || /^input:/.test(elType)) {
        const all = (profile && profile.languages) || [];
        const rankOf = (lv) => {
          if (/母语|native/i.test(lv)) return 0;
          if (/精通|proficien|expert|master/i.test(lv)) return 1;
          if (/无障碍|商务沟通|流利|fluent|advanced/i.test(lv)) return 2;
          if (/熟练|熟悉|良好|intermediate|business/i.test(lv)) return 3;
          return 4;
        };
        const scored = all.map((it, i) => {
          const examStd = normalizeLangExam(it.exam);
          const isStd = /^(CET-4|CET-6|TEM-4|TEM-8|TOEFL|IELTS|GRE)$/i.test(examStd);
          const lv = String((it && it.level) || "").trim() || examToLevel(it && it.exam, it && it.score);
          const num = parseFloat(String((it && it.score) || "").replace(/[^\d.]/g, "")) || 0;
          return { it, i, isStd: isStd ? 1 : 0, rank: rankOf(lv), num };
        });
        // 标准英语考试优先；同档内按分数从高到低（CET-6 621 > CET-4 598）；再按原序
        scored.sort((a, b) => (b.isStd - a.isStd) || (a.rank - b.rank) || (b.num - a.num) || (a.i - b.i));
        const pick = scored[0] && scored[0].it;
        if (pick) {
          const examStd = normalizeLangExam(pick.exam);
          const sc = splitLangScore(pick.score).score || splitLangScore(String(pick.exam || "") + " " + String(pick.score || "")).score || pick.score || "";
          // 分数框（elType=input 或 label 含分数/score）→ 该考试分数；其余（考试名下拉）→ 考试名
          if (/^input:/.test(elType) || /分数|score|grade/i.test(label)) return sc || null;
          return examStd || null;
        }
        return null;
      }
    }
    // v0.7.1 关键修复（#169）：取值必须与建卡用同一份数组（languagesForPage 已去重）。
    const item = languagesForPage(profile)[idx] || {};
    // v0.8.40（A1 强制规格·全局）：语言能力板块**只填「语言类型 + 精通程度」**，
    // 任何「分数/成绩/得分/考试/证书」类字段一律不填（用户反复强调 7-8 次，禁再错）。
    // 不再以 isMeituan() 为限 —— 旧逻辑仅美团留空、其余站点仍塞分数，正是反复出问题的根因。
    if (/分数|成绩|得分|score|grade|考试|证书|cert|exam|test/i.test(label)) return null;
    // v0.7.2：从 exam / score 中归一化出「考试名」与「纯分数」。
    // 兼容老档案把「CET-4 598」整串写进 score 的写法——既能把分数洗干净，
    // 也能在 exam 为空时反推出考试名去选下拉（修复「外语考试下拉没选」）。
    const examNorm = normalizeLangExam(item.exam) || splitLangScore(item.score).exam || null;
    // v0.6.62：判断顺序——先水平/等级（排除「外语考试等级」这种考试字段）→ 再分数 → 再考试 → 最后语种名。
    // 2026-08-10：把「听说 / 读写」并入本分支（原先被 IDENTITY_LABEL_RE 劫持到 basic，
    // 恒取 languages[0]）。Moka 系把一张语言卡拆成「语言类型 / 掌握程度 / 听说 / 读写」四个下拉，
    // 后三个用的都是**本卡这门语言**的水平，所以统一返回 item.level。
    if (/水平|等级|熟练|程度|掌握|听说|读写|口语|书面|听力|阅读|level|proficiency/.test(label) && !/考试|证书|exam|cert/.test(label)) {
      const _lv = (item.level || "").trim();
      if (/母语|native/i.test(_lv)) return "母语";
      if (/精通|proficien|master|专家/.test(_lv)) return "精通";
      if (/商务|无障碍|流利|fluent/i.test(_lv)) return "流利";
      if (/熟练|良好/.test(_lv)) return "熟练";
      if (/基础|入门|basic|初级/i.test(_lv)) return "基础";
      return _lv || null;
    }
    if (/分数|成绩|得分|score|grade/.test(label)) {
      // 始终用 splitLangScore 兜底，防止 score 写成「CET-4 598」整串污染分数框
      const sc = splitLangScore(item.score).score || item.score || "";
      let out = sc;
      // v0.7.2：特殊语种（exam=其他，括号里写了证书名「其他（JLPT N1）」）：
      // 分数前加证书名，如「JLPT N1 满分（180/180）」；普通话等无括号则不加。
      if (examNorm === "其他" && item.exam) {
        const cert = (item.exam.match(/其他[（(]([^）)]+)[）)]/) || [])[1];
        if (cert) out = (out ? cert + " " + out : cert);
      }
      return out || null;
    }
    if (/考试|证书|cert|exam|test/.test(label)) return examNorm;
    if (/语言|语种|language/.test(label)) return item.name;
    // 宁可留空标黄让用户补，也不塞必然校验失败的脏值。
    return null;
  }

  // 社交账号（飞书「社交账号」板块：社交平台 / 账号 / 链接 / 类型）
  // 数据源：优先 profile.social（{platform, account, link, description}），
  // 用户没维护社交数据时，复用作品集链接（如 GitHub 主页）作为社交链接。
  if (section === "social") {
    const idx = indices.social;
    const hasSocial = Array.isArray(profile.social) && profile.social.length;
    const items = hasSocial
      ? profile.social
      : (profile.portfolio || []).filter((p) => p && (p.link || p.url));
    const item = items[idx] || {};
    if (/平台|类型|type|platform/.test(label))
      return item.platform || guessPlatform(item.link || item.url || "");
    if (/账号|用户名|昵称|account|user/.test(label)) return item.account || item.link || item.url || "";
    // v0.7.1 关键修复（#167）：字节社交卡只有一个框，标签就叫「URL / ID」——链接或账号 ID 都收。
    // 原来只返回 item.link，而档案 8 条社交里有 5 条（微信 / 微博 / 小红书 / B站 / 抖音）
    // 压根没有 link、只有 account，返回空串被 fallbackMap 当 falsy 丢弃 → 这 5 条一个都填不进去。
    // 用 account 兜底；反过来若只有 link 没 account，上面那条账号规则也已用 link 兜底。
    if (/链接|网址|url|主页|地址|homepage|link|(^|[^a-z])id([^a-z]|$)/.test(label))
      return item.link || item.url || item.account || "";
    if (/描述|备注|说明|note|desc/.test(label)) return item.description || "";
    return item.link || item.url || item.account || null;
  }

  // 获奖 / 荣誉
  if (section === "awards") {
    const idx = indices.awards;
    const item = (profile.awards || [])[idx] || {};
    // v0.6.71 关键修复：判断顺序错了会直接填错内容。
    // 美团的字段叫「荣誉描述」，它同时含「荣誉」和「描述」；原来 /名称|奖项|获奖|荣誉/ 排在最前，
    // 于是描述框被填成了奖项名称（实测 4 张荣誉卡的描述全是「国家奖学金」这类名称）。
    // 正确顺序：先描述 → 再时间 → 最后才是名称。
    if (/描述|简介|说明|内容|详情|description/.test(label)) return item.description;
    if (/时间|年份|年月|年|月|date|year|yyyy/i.test(label)) return item.date || item.time;
    // v0.7.0（腾讯）：「获奖类型*」是下拉（国家级/省部级/校级…），必须排在下面的「名称」规则之前，
    // 否则它含「获奖」二字会被当成奖项名称，填进去一个下拉根本不接受的字符串。
    if (/获奖类型|奖项类型|荣誉类型|奖项级别|获奖级别/.test(label)) {
      // v0.8.x（2026-08-14）：奖项「类别」（竞赛奖项/奖学金/评优表彰）与「级别」（国家级/校级）
      // 是不同维度。类型/类别字段优先读 item.category（用户显式标注的京东类别口径），
      // 无 category 才退回原 level 兜底/名称推断。其他站点无 category 字段时不触发，零回归。
      if (/类型|类别/.test(label) && item.category) return item.category;
      if (item.type || item.level) return item.type || item.level;
      const nm = String(item.name || "") + " " + String(item.description || "");
      if (/奖学金|scholarship/i.test(nm)) return "奖学金";
      if (/竞赛|大赛|比赛|挑战杯|建模|编程|算法|hackathon|contest|competition/i.test(nm)) return "竞赛获奖";
      return "其他";
    }
    if (/名称|奖项|获奖|荣誉|name/.test(label)) return item.name;
  }

  // 校园经历（美团独立板块：校园经历名称 / 角色 / 校园经历时间 / 校园经历描述）
  if (section === "campus") {
    const item = (profile.campus || [])[indices.campus] || {};
    // 同样把「描述」放在「名称」前面：「校园经历描述」里也含「校园经历」。
    if (/描述|简介|说明|内容|职责|详情|description/.test(label)) return item.description;
    if (/角色|职务|职位|担任|role/.test(label)) return item.role;
    if (/开始|起始|入学|start/.test(label)) return item.start;
    if (/结束|截止|离开|end/.test(label)) return item.end;
    if (/时间|日期|起止|date/.test(label)) return formatRange(item.start, item.end);
    if (/名称|组织|社团|机构|经历|name/.test(label)) return item.name;
    return null;
  }

  // 证书（美团只有「证书名称」一个字段，其它站可能还有时间/编号）
  if (section === "certificates") {
    const item = (profile.certificates || [])[indices.certificates] || {};
    if (/描述|简介|说明|内容|description/.test(label)) {
      // v0.8.x（#378 后续）：字节等站的「证书名称」是受限下拉，我们的证书名不在选项内，
      // 只能落为「其他」，真实证书名无法进入名称框。故描述框兜底补上证书名称，
      // 确保证书信息不丢失；若描述已含证书名则不重复追加。
      const nm = item.name || "";
      const desc = item.description || "";
      if (nm && desc && !desc.includes(nm)) return nm + "。" + desc;
      if (!desc) return nm || null;
      return desc;
    }
    if (/时间|日期|年份|获得|颁发|date/.test(label)) return item.date || null;
    if (/编号|证书号|no\.?|number/.test(label)) return item.no || null;
    if (/名称|证书|资格|name/.test(label)) return item.name;
    return null;
  }

  // 论文（美团：论文名称 / 发表渠道(下拉) / 作者顺序(下拉) / 影响因子 / 论文链接）
  if (section === "papers") {
    const item = (profile.papers || [])[indices.papers] || {};
    // v0.7.1（#185）：腾讯教育卡片里的「论文」是一个自由文本域，
    // placeholder 为「请输入已发表论文，如未发表则无需填写」——它含「发表」二字，
    // 会被下面的「发表渠道」规则抢走，只填进一个 venue「ACL」（3 个字符），
    // 而腾讯明确要求该域至少 10 个字符 → 保存直接卡校验。必须先拦下，拼一份完整论文清单。
    if (
      /已发表论文|请输入.*论文|论文.*如未发表/.test(label) ||
      (/^论文/.test(label) && !/渠道|期刊|会议|出版|作者|影响因子|链接|时间/.test(label))
    ) {
      const ps = profile.papers || [];
      if (!ps.length) return null;
      return ps
        .map((p, i) => `${i + 1}. ${p.name}${p.venue ? `（${p.venue}${p.order ? "，" + p.order : ""}）` : ""}`)
        .join("\n");
    }
    if (/渠道|期刊|会议|出版|venue|journal|conference|发表/.test(label)) return item.venue || null;
    if (/作者顺序|作者排序|署名|排名|第几作者|author|order/.test(label)) return item.order || null;
    if (/影响因子|impact|if值/.test(label)) return item.impact || null;
    // v0.8.17（#364）：「详情/描述」类字段即使 label 里也写了"链接"（如京东
    // 「请填写论文详情，也可填写论文链接」），也应填【文字描述】而非裸链接——
    // 用户明确要求论文详情必须是文本、不能是链接。纯链接字段（label 仅含链接/url）才填 link。
    if ((elType.includes("url") || /链接|网址|url|link|doi/.test(label)) && !/详情|描述|摘要|简介|内容|正文/.test(label)) return item.link || null;
    if (/时间|日期|年份|发表时间|date/.test(label)) return item.date || null;
    // v0.8.17（#364）：京东「论文详情」标签含「详情」二字，必须单独命中——它不在
    // 原 /描述|摘要|简介/ 里，否则 return null → 主循环拿到空值直接跳过（实测论文详情框恒空）。
    // 返回与京东专用重映射（JD_RULES）一致的富文本：发表于+影响因子+描述。
    if (/详情/.test(label)) {
      const _p = [item.venue ? "发表于 " + item.venue : "", item.impact ? "影响因子 " + item.impact : "", item.description].filter(Boolean);
      return _p.length ? _p.join("，") : null;
    }
    if (/描述|摘要|简介|abstract/.test(label)) return item.description || null;
    if (/名称|题目|标题|论文|title|name/.test(label)) return item.name;
    return null;
  }
  // 发明成果专利（腾讯「其他关键信息」等自由文本域，或独立专利字段）
  if (section === "patents") {
    const item = (profile.patents || [])[indices.patents] || {};
    if (/类型|成果类型/.test(label)) return item.type || null;
    if (/名称|专利名称|成果名称|name/.test(label)) return item.name;
    if (/登记号|专利号|申请号|编号/.test(label)) return item.regNo || null;
    if (/登记日期|授权日期|申请日期/.test(label)) return item.date || null;
    if (/排名|发明人/.test(label)) return item.rank || null;
    if (/简介|摘要|核心/.test(label)) return item.summary || null;
    return null;
  }

  // 竞赛（美团只有「获奖大赛」一个级联选择器；其它站可能拆成 名称/奖项/时间/描述）
  if (section === "competitions") {
    // v0.6.72：必须和 getSectionNeeded 用同一个列表。
    // 美团只支持 10 个编程赛事，数学建模/互联网+ 这类会被过滤掉；
    // 若这里仍按原始数组取第 i 条，第 1 张卡会拿到被过滤掉的「数学建模」而填不上。
    const item = (profile.competitions || [])[indices.competitions] || {};
    if (/描述|简介|说明|内容|description/.test(label)) return item.description || null;
    if (/奖项|等级|名次|获奖情况|rank|level|prize/.test(label)) return item.level || null;
    if (/时间|日期|年份|date/.test(label)) return item.date || null;
    if (/大赛|竞赛|比赛|赛事|名称|name/.test(label)) {
      // 美团「获奖大赛」是两级级联（赛事 → 金牌/银牌/铜牌）。
      // 把奖项一并带上，级联逻辑才知道第二级该点哪一项。
      if (mtdContestCascaderPresent() && item.level) return item.name + " " + item.level;
      return item.name;
    }
    return null;
  }

  // 作品集（用户在插件「作品集」区维护的链接 + 描述）
  if (section === "portfolio") {
    const idx = indices.portfolio;
    const item = (profile.portfolio || [])[idx] || {};
    // v0.7.0（腾讯）：「密码或提取码*」必填。网盘作品常带提取码，档案里写「无」也要照填，
    // 否则这一项过不了校验。必须排在「名称/链接」之前——它含「码」不含「名称」，但顺序清晰更安全。
    if (/密码|提取码|访问码|口令|password|passcode/i.test(label)) return item.password || null;
    if (/作品名|作品标题|作品名称|名称|标题/.test(label)) return item.name;
    // v0.7.0（腾讯）：作品集里的「个人主页超链接」是求职者个人主页，应取 basic.homepage，
    // 而非某个具体作品链接（portfolio.link）。必须排在上一条「链接」规则之前，否则被填成作品链接。
    if (/个人主页|个人网站|主页超链接|homepage|personal\s*(page|site)|home\s*page/i.test(label)) {
      return (profile.basic && profile.basic.homepage) || item.link || null;
    }
    if (elType.includes("url") || /(链接|网址|url|link)/.test(label)) return item.link || null;
    if (/描述|简介|介绍|说明|背景|经历|内容/.test(label)) return item.description;
  }

  // ── v0.7.0：AI 应用技能（腾讯 2026 校招新板块）─────────────────────────────────
  // 三个子项：常用 AI 工具&模型 / 与 AI 协作完成的项目 / 相关项目或作品链接。
  // 不加 section 守卫也安全：这三条正则的关键词（AI 工具、与AI协作）在别的板块不会出现。
  // 注意：插件读到的 label 可能是「板块小标题」也可能是「placeholder」（见 getLabel 的优先级），
  // 所以下面每条规则都同时覆盖这两种文案，实测腾讯两个文本域的 placeholder 是：
  //   ①「请填写具体工具名称&模型名称与版本号，如 Cursor、Copilot、Coze」
  //   ②「请说明项目目标背景、AI 工具及模型的选择及原因、你与 AI 的分工、核心挑战及解决方案、项目结果等」
  // ② 必须先判：它同时含「AI 工具及模型」，若让 ① 的规则先跑会把长描述填成工具清单。
  {
    const ai = profile.aiSkills || {};
    if (
      /与\s*ai\s*协作|ai\s*协作完成|你与\s*ai\s*的分工|项目目标背景|ai\s*工具及模型的选择/i.test(label)
    ) {
      return ai.collabProject || null;
    }
    if (
      /常用的\s*ai|ai\s*工具\s*&\s*模型|工具名称\s*&\s*模型名称|具体工具名称|ai\s*tools?\s*(&|and)\s*models?/i.test(
        label
      )
    ) {
      return ai.tools || null;
    }
    if (
      /相关项目或作品链接|相关.*项目.*作品.*链接/.test(label) ||
      (section === "aiSkills" && /(链接|网址|url|link)/i.test(label))
    ) {
      return ai.link || (profile.portfolio || []).map((p) => p && p.link).find(Boolean) || null;
    }
  }

  // ── v0.7.0：专业技能 / 开发语言 ────────────────────────────────────────────────
  // 腾讯「请输入你擅长的开发语言」在页面上没有独立板块标题（挂在导航文案下面），
  // 所以这里**不加 section 守卫**，只靠标签关键词命中，避免板块识别兜不住时漏填。
  {
    const sk = profile.skills || {};
    if (/擅长的开发语言|开发语言|编程语言|programming\s*language/i.test(label)) {
      if (sk.devLanguages) return sk.devLanguages;
      // v0.8.30（2026-08-11）：开发语言下拉只收编程语言，profile.skills 里混了框架/工具
      //（PyTorch/React/...），整串返回会让多选分支把每个框架当 token 去点、落空后触发「其他」兜底，
      // 反而错选「其他」。这里只保留下拉里真实存在的编程语言。
      const LANG_WL = ["Python","C++","C#","C","Java","JavaScript","Go","PHP","Ruby","Swift","Kotlin","Rust","TypeScript","Scala","Groovy","Objective-C","Perl","Lua","Dart","R","MATLAB","VB","Visual Basic","SQL"];
      if (Array.isArray(profile.skills) && profile.skills.length) {
        const picked = profile.skills.filter(s => LANG_WL.some(w => String(s).toLowerCase() === w.toLowerCase()));
        if (picked.length) return picked.join("、");
      }
      return null;
    }
    if (section === "skills") {
      if (/框架|framework/i.test(label)) return sk.frameworks || null;
      if (/工具|tool/i.test(label)) return sk.tools || null;
      if (/技能|描述|简介|概述|summary/i.test(label)) return sk.summary || null;
    }
  }

  // ── v0.7.0：其他关键信息（自我评价 / 爱好特长 / 补充信息）──────────────────────
  // 腾讯只给一个文本域，但官方建议按 3 段写。用户明确要求「三个地方要分开填，按虚线里的格式」，
  // 因此这里按官方 placeholder 的编号格式拼成一段提交；
  // 若站点各自有独立的三个框，则分别命中下面三条规则各填各的。
  // 说明：三合一的情况已在函数前部由 isComboOtherInfoLabel 拦截，这里只处理「站点把三段拆成
  // 三个独立输入框」的情形（各填各的），以及板块已识别为 otherInfo 的兜底。
  {
    const oi = profile.otherInfo || {};
    // v0.7.0：个人主页必须排在最前。腾讯把「个人主页超链接」这个输入框放在
    // 「其他关键信息」板块里，原来 section==="otherInfo" 的无条件兜底会把
    // 整整三段补充信息（自我评价＋爱好特长＋补充信息，600+ 字）塞进这个链接框，
    // 只是恰好被 validateValueForField 拦下才没写进去 —— 属于必须修掉的错填。
    if (/个人主页|个人网站|主页超链接|homepage|home\s*page|personal\s*site/i.test(label)) {
      return (profile.basic && profile.basic.homepage) || null;
    }
    if (/爱好特长|特长爱好|兴趣爱好|个人特长|爱好/.test(label)) return oi.hobbies || null;
    if (/补充信息|其他关键信息|其他相关信息|其他信息|附加信息/.test(label)) {
      return oi.supplement || composeOtherInfo(profile);
    }
    // v0.7.0：兜底收紧。原来是「只要板块是 otherInfo，任何字段都回填补充信息全文」，
    // 这等于把该板块里所有认不出的框（链接、日期、下拉…）全部污染。
    // 现在只在「确实是一个大文本域」时才兜底 —— 补充信息本来就只该往多行文本里写。
    if (section === "otherInfo" && /textarea/i.test(elType)) return composeOtherInfo(profile);
  }

  return null;
}

// 从链接推断社交平台名（github.com → GitHub，知乎 → 知乎等）；推断不出返回空
function guessPlatform(link) {
  if (!link) return "";
  const s = String(link).toLowerCase();
  const rules = [
    [/github/i, "GitHub"],
    [/gitee/i, "Gitee"],
    [/zhihu/i, "知乎"],
    [/weibo/i, "微博"],
    [/bilibili|哔哩哔哩/i, "哔哩哔哩"],
    [/linkedin/i, "LinkedIn"],
    [/twitter|x\.com/i, "Twitter/X"],
    [/douyin/i, "抖音"],
    [/juejin/i, "掘金"],
    [/csdn/i, "CSDN"],
    [/leetcode/i, "LeetCode"],
    [/微信公众号|wechat|mp\.weixin/i, "微信公众号"],
  ];
  for (const [re, name] of rules) if (re.test(s)) return name;
  return "";
}

// 判断字段是否为经历条目的"锚点"，并区分主要锚点（公司/学校/项目名）和次要锚点（职位/角色）
function getAnchorInfo(field) {
  const label = (field.label || "").toLowerCase();
  const section = field.section;
  let primary = false;
  let secondary = false;
  if (section === "education" && /学校|院校|毕业院校/.test(label)) primary = true;
  if ((section === "work" || section === "internships") && /公司|企业|单位/.test(label)) primary = true;
  if ((section === "work" || section === "internships") && /职位|岗位|职务|title|position/.test(label)) secondary = true;
  if (section === "projects" && /项目名|项目名称|课题/.test(label)) primary = true;
  if (section === "projects" && /角色|职务|岗位|role|position/.test(label)) secondary = true;
  if (section === "portfolio" && /作品名称|作品名|作品标题|作品链接/.test(label)) { primary = true; }
  if (section === "portfolio" && /作品描述|作品简介|描述|介绍/.test(label)) { secondary = true; }
  if (section === "awards" && /奖项名称|获奖名称|奖项|荣誉名称/.test(label)) primary = true;
  if (section === "campus" && /校园经历名称|社团名称|组织名称/.test(label)) primary = true;
  if (section === "campus" && /角色|职务/.test(label)) secondary = true;
  if (section === "competitions" && /获奖大赛|竞赛名称|大赛名称/.test(label)) primary = true;
  if (section === "papers" && /论文题目|论文标题|论文名称/.test(label)) primary = true;
  if (section === "certificates" && /证书名称|证书/.test(label)) primary = true;
  if (section === "skills" && /技能名称|技能/.test(label)) primary = true;
  if (section === "languages" && /语言|语种|language/.test(label)) primary = true;
  if (section === "selfEval" && /自我评价|个人评价|自我介绍|自我描述/.test(label)) primary = true;
  return { primary, secondary: primary || secondary };
}
function isAnchorField(field) {
  return getAnchorInfo(field).secondary;
}

// 用本地规则做字段映射
//
// 条目索引（第几条实习 / 第几个项目 / 第几个作品）的判定方式：
// 旧版靠「主要锚点 + 次要锚点」状态机，但只要一条经历里出现次要锚点（如「职位名称」「项目角色」），
// 状态就被重置成 lastAnchorWasPrimary=false，下一条的「公司名称」就不再触发 index++，
// 结果三条实习 / 三个项目全部被填成第 1 条的内容——这正是用户看到的「内容重复」。
//
// 新版改成更朴素也更可靠的规则：在同一个板块内，某个标签第二次出现 → 说明进入了新的一条，
// index++ 并清空「本条已见标签」集合。教育/实习/项目/作品/获奖/社交/语言全部通用，无需逐个板块配锚点。
// ── v0.8.15（#287）：零需求板块过滤器（主映射 + cascadeRefill 共用）───────────
// 应届生没有 work 数据时，页面自带的「工作经历」默认空卡必须保持空白，
// 否则 fallbackMap 会按「同板块内标签第二次出现」把 internships[0] 灌进去，
// 同一段实习既进「工作经历」又进「实习经历」——HR 眼里的硬伤。
// 2026-08-10 安踏实测：主流程已加过滤仍复现（before=110 after=110 一条没删），
// 真凶是 cascadeRefill 二次调用 fallbackMap 时完全没过滤。故抽成公共函数，两处都必须调。
// 另：section 归属要同时看 field.section 与 mapping.section —— 实测 map-table 里
// 工作经历卡字段标的是 f.section='work'，而 mapping 对象上未必带 section。
// 2026-08-10 二修（安踏 R2 回归）：原先「按 f.section 命中 + 标签白名单放行」太脆——
// 「自我描述/简介」的 f.section 也被错标成 work，不在白名单里就被误删，填充率从 98% 掉到 91%。
// 结论：section 归属本身就是猜的，不能拿它当删除依据。改成 **DOM 边界精准剔除**：
//   只有当控件确实落在「工作经历」板块容器 **内部** 时才丢弃，容器外一律保留（默认保留）。
// 容器边界 = 从板块标题元素向上找，一旦某层祖先把 **别的板块标题** 也吞进去就停手。
// 2026-08-10 三修（安踏 R3 回归 87%）：detectSections 会把「个人信息」整块误判成 work
//   —— 因为块里有个叫「工作经验」的下拉（工作年限），关键词命中 work。
//   于是框出两个 work 容器（work:8 = 个人信息块、work:7 = 真·工作经历卡），
//   性别/所在地/身份证/出生日期 被连坐丢弃。故容器必须过「体检」：
//   ① 含个人信息独占字段（姓名/身份证/出生日期/邮箱/手机）→ 判定为误判块，弃用；
//   ② 板块容器必须含该板块的卡内标识（work→公司/单位/企业），否则不认。
const ZERO_BOX_BASIC_MARK = /姓名|身份证|证件号码|出生日期|邮箱|电子邮件|手机号/;
const ZERO_BOX_REQUIRE = {
  work: /公司|单位|企业/,
  internships: /公司|单位|企业|实习/,
  education: /学校|院校|学历|专业/,
  projects: /项目/,
  awards: /奖|荣誉/,
  certificates: /证书/,
  papers: /论文|期刊/,
  competitions: /竞赛|比赛/,
  languages: /语言|外语/,
  portfolio: /作品|链接/,
  campus: /社团|校园|组织/,
};
function zeroSectionBoxes(sections, zeroNames) {
  const boxes = [];
  const others = sections.filter((s) => !zeroNames.has(s.name)).map((s) => s.el);
  for (const s of sections) {
    if (!zeroNames.has(s.name) || !s.el) continue;
    let box = s.el;
    let chosen = box.querySelector && box.querySelector("[" + ATTR + "]") ? box : null;
    for (let k = 0; k < 14 && box.parentElement; k++) {
      const up = box.parentElement;
      if (up === document.body || up === document.documentElement) break;
      // 越界保护：这层已经把别的板块标题包进来了 → 不能再往上，否则会误伤整页
      if (others.some((o) => o && o !== s.el && up.contains(o))) break;
      // 越界保护 2：吞进个人信息独占字段说明走过头，停在上一层
      if (ZERO_BOX_BASIC_MARK.test(up.innerText || "")) break;
      box = up;
      if (box.querySelector("[" + ATTR + "]")) chosen = box;
    }
    if (!chosen) continue;
    const txt = String(chosen.innerText || "").slice(0, 4000);
    if (ZERO_BOX_BASIC_MARK.test(txt)) continue; // 个人信息块被误判成经历板块
    const need = ZERO_BOX_REQUIRE[s.name];
    if (need && !need.test(txt)) continue; // 缺卡内标识 → 不是真板块容器
    boxes.push({ name: s.name, el: chosen });
  }
  return boxes;
}

function filterZeroSectionMappings(mappings, fields, profile, tag) {
  try {
    const sections = detectSections();
    const expandable = ["education","work","internships","projects","campus","portfolio","awards","certificates","papers","competitions","skills","languages","social"];
    const zeroNames = new Set(
      sections
        .map((s) => s.name)
        .filter((name) => expandable.includes(name) && getSectionNeeded(profile, name) === 0)
    );
    if (!zeroNames.size) return mappings;
    const before = mappings.length;
    const boxes = zeroSectionBoxes(sections, zeroNames);
    // 兜底：DOM 边界没找出来时，只按「卡内字段」黑名单删（默认保留，宁可漏删不可错删）
    const CARD_FIELD_DROP_RE =
      /^(\*?\s*)?(公司名称|单位名称|企业名称|公司|单位|职位名称|岗位名称|职位|岗位|职务|所在部门|部门|工作职责|工作内容|工作描述|任职时间|在职时间|工作时间|入职时间|离职时间|开始时间|结束时间|内容|描述)(（开始）|（结束）|（年）|（月）)*\s*\*?$/;
    const dropped = [];
    const out = mappings.filter((m) => {
      const f = fields.find((x) => x.idx === m.idx);
      const lb = String((f && (f.label || f.rawLabel)) || "");
      const el = document.querySelector("[" + ATTR + '="' + String(m.idx).replace(/"/g, "") + '"]');
      if (el && boxes.length) {
        const hit = boxes.find((b) => b.el.contains(el));
        if (hit) { dropped.push((lb || "?").slice(0, 12) + "@" + hit.name); return false; }
        return true; // 容器外 → 一律保留
      }
      // 找不到元素 / 没框出容器：退回保守黑名单
      const sec = (f && f.section) || m.section;
      if (!zeroNames.has(sec)) return true;
      if (lb && CARD_FIELD_DROP_RE.test(lb.trim())) { dropped.push(lb.slice(0, 12) + "@bl"); return false; }
      return true;
    });
    rfaLog({
      act: "zero-section-filter",
      tag: tag || "main",
      sections: Array.from(zeroNames),
      boxes: boxes.map((b) => b.name + ":" + (b.el.querySelectorAll("[" + ATTR + "]").length)),
      before,
      after: out.length,
      dropped,
    });
    return out;
  } catch (e) {
    rfaLog({ act: "zero-section-filter-err", tag: tag || "main", err: String(e).slice(0, 120) });
    return mappings;
  }
}

function fallbackMap(fields, profile) {
  const mappings = [];
  const indices = {
    education: 0, work: 0, internships: 0, projects: 0, portfolio: 0,
    awards: 0, papers: 0, certificates: 0, skills: 0, languages: 0, social: 0,
    campus: 0, competitions: 0,
  };
  const seenLabels = {}; // section -> Set(本条已出现过的标签)

  // v0.7.1：先落定「本页有哪些板块」，matchField 里的跨板块去重（work vs internships）要用。
  __RFA_PAGE_SECTIONS = new Set(fields.map((f) => f.section).filter(Boolean));

  // #561（2026-08-26 用户拍板）：职责/描述类字段「单框合并、多框分开」。
  // 统计各板块内职责/描述类字段数量：只有 1 个框（如 Moka 实习「工作职责」、单框「项目描述」）
  // → 把 描述+职责+成果 三段合并填入保证完整；≥2 个框 → 各自对号入座（职责→responsibilities、描述→description、成果→achievements）。
  // 历史回归根因：5529 行实习「职责」框只 return responsibilities 不合并；5591 行项目兜底把所有描述/职责/成果
  // 类 label 一律 return _pj(合并段)，导致「项目中的职责」（不匹配 /项目职责/，中间隔"中的"）与「项目描述」填成一样。
  __RFA_DUTY_COUNT__ = {};
  // #569（2026-08-27 蔚来验证修正）：原统计把整板块的职责/描述类字段数加起来——
  // 3 张实习卡 × 1 个描述框 = 3 → dutyN>1 误判"多框"→ 描述框只填 description。
  // 正确语义是「板块内字段的种类」：只有描述类（无职责类）或只有职责类（无描述类）= 单类框 → 合并三段；
  // 描述类 + 职责类并存 = 多类框 → 各归各的。
  __RFA_DUTY_KINDS__ = {};
  const DUTY_DESC_RE = /描述|简介|description/i;
  const DUTY_DUTY_RE = /职责|内容|负责|工作描述|responsibilit|work content|成果|业绩|产出|achieve|result/i;
  fields.forEach((f) => {
    const s = f.section || "unknown";
    if (s !== "internships" && s !== "work" && s !== "projects") return;
    const l = f.label || "";
    if (!__RFA_DUTY_KINDS__[s]) __RFA_DUTY_KINDS__[s] = { hasDesc: false, hasDuty: false };
    if (DUTY_DESC_RE.test(l)) __RFA_DUTY_KINDS__[s].hasDesc = true;
    if (DUTY_DUTY_RE.test(l)) __RFA_DUTY_KINDS__[s].hasDuty = true;
  });
  // 兼容旧字段名：单框判断统一用 hasDuty/hasDesc
  __RFA_DUTY_COUNT__ = { internships: 0, work: 0, projects: 0 };
  for (const s in __RFA_DUTY_KINDS__) {
    const k = __RFA_DUTY_KINDS__[s];
    __RFA_DUTY_COUNT__[s] = (k.hasDesc ? 1 : 0) + (k.hasDuty ? 1 : 0);
  }
  // v0.8.40（A1 规格）：语言条目一律按语种去重、只填精通程度，不再探测「考试/分数槽位」。
  // 旧版用扫描到的标签判定是否去重的逻辑已废弃（与规格冲突且飞书系易误判）。

  // v0.8.20（语言板块修复）：语言「名 + 程度/听说/读写/考试/分数」必须绑同一张卡片。
  // 旧逻辑靠 seenLabels 重复计数推进 indices.languages，一旦卡片内字段顺序/结构不一致
  // （如程度排在名之前、或夹了无 label 的隐藏字段），名与程度会取到去重数组里不同条目，
  // 表现为「英语有名无程度、普通话无名有母语」这类错位。
  // 新逻辑：在 languages 板块内，数到本字段为止出现的「语言名」字段次数 = 卡片序号（0-based），
  // 一张卡的所有子字段共享同一序号，与字段先后顺序无关。
  // 卡片内 DOM 顺序为「名在前、子字段在后」（字节/飞书/Moka 实测），纯前向计数即可：
  // 每遇到一个「语言名」字段，卡片序号 +1；名之前的字段（罕见）归入 card 0。
  // 不做后向补齐——那会把后一张卡的序号污染到前一张卡的子字段。
  const langNameRe = /^(语言|语种|语言类型|语言种类|language)$/i;
  const langCardIdx = new Array(fields.length).fill(0);
  {
    let cnt = -1;
    for (let fi = 0; fi < fields.length; fi++) {
      const ff = fields[fi];
      if ((ff.section || "") === "languages") {
        if (langNameRe.test((ff.label || "").trim())) cnt++;
        langCardIdx[fi] = Math.max(0, cnt);
      }
    }
  }

  fields.forEach((f, fi) => {
    const section = f.section || "unknown";
    const label = (f.label || "").trim();
    if (indices[section] === undefined) indices[section] = 0;
    if (!seenLabels[section]) seenLabels[section] = new Set();

    if (section === "languages") {
      // 见上方说明：卡片序号由语言名出现次数决定，不走通用重复计数
      indices.languages = langCardIdx[fi];
    } else {
      if (label) {
        if (seenLabels[section].has(label)) {
          indices[section]++;
          seenLabels[section] = new Set();
        }
        seenLabels[section].add(label);
      }
    }

    const value = matchField(f, profile, indices);
    if (value && validateValueForField(value, f)) mappings.push({ idx: f.idx, value, section });
  });

  return mappings;
}

// 判断元素是否是真正的"添加"按钮（不是表单内部的小图标、也不是删除按钮）
// 真实站点（飞书/字节系 formily 组件）的「添加」按钮形如：
//   <button class="ud__button ud__button--text ud__button--text-primary ...">
//     <span ...><svg data-icon="AddOutlined">…</svg></span> 添加
//   </button>
// 而「删除」按钮 class 含 apply-form-array-card-delete、data-icon="DeleteTrashOutlined"、无文字。
function isRealAddButton(el) {
  if (!el || el.nodeType !== 1) return false;
  const text = getText(el);
  const aria = (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "");
  const cls = (el.className || "").toString();
  const iconEl = el.querySelector("[data-icon]");
  const iconName = iconEl ? (iconEl.getAttribute("data-icon") || "") : "";
  const combined = (text + " " + aria + " " + cls).toLowerCase();

  // 明确排除「删除/移除/减少」类按钮（含 SVG 图标名 DeleteTrashOutlined / Minus / Remove）
  if (/删除|移除|去掉|减少|minus|delete|remove|trash/i.test(combined)) return false;
  if (/delete|remove|trash/i.test(cls) || /DeleteTrash|Minus|Remove/i.test(iconName)) return false;

  // v0.8.18（#291 拼多多）：国际区号选择器「+86」被 positiveText 的裸 `\+` 命中，
  // 判成了添加按钮。拼多多 portfolio 板块因此 expand-click 点到了手机号区号下拉
  // （日志 btn:"+86"），点两次都 rendered:false，作品集一张卡也没建出来。
  // 「+ 数字」只可能是区号/计数，绝不是添加按钮，先于正向匹配一票否决。
  if (/^[+＋]\s*\d{1,4}$/.test(text.trim())) return false;

  // 正向匹配：文字 / aria 含「添加/新增/增加/＋/+/Add/Append/New」，或图标是 Add/Plus
  // v0.6.79：class 不再并入 combined 做裸子串匹配。原来 combined 含 class，
  // 于是 padding / address / loaded 这类 class 里的 "add" 也算命中，误判面极大。
  const textAria = (text + " " + aria).toLowerCase();
  const positiveText = /添加|新增|增加|＋|\+|add|append|new|继续添加|add item|add more/i.test(textAria);
  const positiveIcon = /add|plus/i.test(iconName);
  // class 改用词界匹配（允许 list_add / add-btn / btn add 这类，排除 padding）
  const positiveClass = /(^|[\s_-])(add|plus)([\s_-]|$)|新增|添加/i.test(cls);
  if (!positiveText && !positiveIcon && !positiveClass) return false;

  // v0.7.1（#185）：原生 <button> / <a> / [role=button] 一旦带添加语义，直接认作添加按钮，
  // 跳过后面「空文字 / 多行容器 / 含子按钮」等严格判定（那些是为普通 div 容器设的防火墙）。
  // 腾讯「添加学历」是 <BUTTON class="el-button el-button--text">添加学历</BUTTON>，
  // 但 getText 取到的值可能因内部结构而漏掉「添加」二字，导致 isRealAddButton 误杀、点到 help 容器毫无反应。
  const isNativeBtn = /^(button|a|i)$/i.test(el.tagName) || el.getAttribute("role") === "button";
  if (isNativeBtn) {
    if (!isVisible(el)) return false;
    if (el.querySelector("input, textarea, select, [contenteditable='true']")) return false;
    return true;
  }

  // v0.6.79 关键修复：文字为空且没有 add 图标的元素一律拒绝。
  // 美团「添加校园经历/论文/竞赛/荣誉/证书」按钮内部套着多层同 class（list_add）的空壳 div，
  // 它们仅凭 class 就通过判定，又因「文字最短」被 findAddButtonInContainer 优先选中，
  // 点上去毫无反应 → 条目行永远创建不出来 → 这五个板块全部 0 字段。
  if (!text.trim() && !positiveIcon) return false;

  if (!isVisible(el)) return false;
  // 自身含可填输入框说明是表单字段，忽略
  if (el.querySelector("input, textarea, select, [contenteditable='true']")) return false;

  // v0.7.0 关键修复：「容器」不是按钮。
  // 原判定只看整段文本里有没有「添加」二字，于是一个「板块标题 + 条目卡片 + 添加按钮」的
  // 外层容器 div（例：「获奖\n获奖名称\n获奖时间\n描述\n添加」）也算命中。
  // 后果有两处，都很致命：
  //   1) detectSections 第 334 行会因 isRealAddButton 为真而 break，整个板块锚点被丢掉
  //      —— 板块识别不出来 → 该板块所有字段永远填不上。空板块（还没渲染出 input，
  //      只剩标题和一个「添加」按钮）最容易踩，腾讯多数板块初始就是这个形态。
  //   2) findAddButtonInContainer 可能选中外层容器去点，点在空白处毫无反应。
  // 真实的添加按钮文字几乎总是单行（「添加」「+ 添加」「添加教育经历」），
  // 图标+文字最多两行；三行以上必是容器。
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
  if (lines.length > 2) return false;
  // 同理：内部还嵌着独立的按钮/链接，说明自己是容器而不是按钮本体
  if (el.querySelector("button, [role='button'], a[href]")) return false;
  return true;
}

// 板块锚点正则（统计某板块已展开条目数用）
function anchorsForSection(sectionName) {
  const anchors = {
    // v0.7.1（#185）：裸 /学校|院校/ 会被**同卡里别的字段的长提示文案**命中。
    // 腾讯「目前就读地*」的提示写着「…国内院校请输入中文名…」，于是一张教育卡被数成 2 条，
    // current=2 → toAdd=0 → 档案里的第 2 段教育根本没展开出来（实测只填了本科，硕士整段丢失）。
    // 锚点的语义是「每张卡的第一个字段」，所以必须从标签**开头**匹配，不能全文搜关键词。
    education: /^[\s*＊]*(学校名称|院校名称|毕业院校|学校|院校)/,
    work: /公司|企业|单位/,
    internships: /公司|企业|单位/,
    projects: /项目名|项目名称|课题/,
    portfolio: /作品名称|作品名|作品标题|作品链接/,
    // v0.6.71：锚点必须「每张卡只匹配到第一个字段」，否则一张卡会被数成 2~3 条，
    // 该加的卡加不出来。所以用「校园经历名称」而不是「校园经历」（后者还会命中时间/描述）。
    campus: /校园经历名称|^社团名称$|^组织名称$|^校园经历$/,
    competitions: /获奖大赛|竞赛名称|大赛名称|^竞赛$/,
    // v0.7.1（#185）：裸「奖项」会同时命中同一张卡里的「奖项名称*」和「奖项说明」，
    // 一张卡被数成 2 条 → 腾讯 4 条获奖只展开出 3 张卡（current 报 2 实为 1 张卡，toAdd 少算一次）。
    // 锚点必须保证「每张卡只匹配第一个字段」，所以裸词一律改成精确匹配。
    awards: /奖项名称|获奖名称|荣誉名称|^奖项$|^荣誉$/,
    papers: /论文题目|论文标题|论文名称/,
    certificates: /证书名称|证书/,
    skills: /技能名称|技能/,
    // v0.6.65：原来的 /语言|语种/ 会把同一张卡里的「语言类型」「语言水平」「语言考试」
    // 全部算成条目，一张卡被数成 2~3 条，导致该加的卡没加（实测语言需要 3 条只加出 2 条）。
    // 收窄成「只匹配每张卡的第一个字段」：美团=语言类型，飞书/字节=语言。
    languages: /语言类型|语种类型|^语种$|^语言$|语言名称/,
    selfEval: /自我评价|个人评价|自我介绍|自我描述/,
  };
  return anchors[sectionName] || null;
}

// 在「当前 section 标题」与「下一个 section 标题」之间，统计该板块已展开的条目数
// 不受表单内部大容器定位不准的影响，按页面纵向范围统计更稳健。
// v0.8.18（#290）：按「卡片序号小标题」计数的兜底依据。
// 拼多多这类站点的表单项**根本没有 <label>**（只有 placeholder），
// 锚点计数恒为 0 → expandSection 误判「点了没渲染」→ 重试一次就放弃，
// 结果需要 2 张教育卡只建出 1 张。但这些站点会给每张卡一个
// 「板块名+序号」的小标题（教育经历1 / 语言能力2），拿它数卡最稳。
function cardTitleReFor(sectionName) {
  const names = {
    education: "教育经历|教育背景|学历信息|教育信息",
    work: "工作经历|工作经验|职业经历",
    internships: "实习经历|实习经验",
    projects: "项目经历|项目经验|项目信息",
    portfolio: "作品集|作品信息|作品",
    campus: "校园经历|在校经历|社团经历",
    competitions: "竞赛经历|竞赛信息|竞赛",
    awards: "获奖经历|获奖情况|获奖信息|奖项",
    papers: "论文信息|论文",
    certificates: "证书信息|证书",
    languages: "语言能力|语言信息|语言",
    skills: "技能信息|专业技能",
    selfEval: "自我评价|个人评价",
  };
  const n = names[sectionName];
  // 序号可能是 1 / （1） / [1] / -1 等写法
  return n ? new RegExp("^(?:" + n + ")\\s*[（(\\[]?\\s*\\d{1,2}\\s*[)）\\]]?$") : null;
}

function countItemsForSection(section, sectionName, sections) {
  const myRect = section.el.getBoundingClientRect();
  const nextTop = (() => {
    const nexts = (sections || []).filter((s) => s.el && s.el.getBoundingClientRect().top > myRect.bottom - 5);
    nexts.sort((a, b) => a.el.getBoundingClientRect().top - b.el.getBoundingClientRect().top);
    return nexts.length ? nexts[0].el.getBoundingClientRect().top : Infinity;
  })();

  // Moka 系：用稳定的「每张卡一个」容器 class 计数（锚点标签在 Moka 上不稳，
  // 会 0↔多 乱跳 → 误判没加成功 → 反复点添加 → 过量叠加空白卡片，实测曾叠出 80 张）。
  // 纵向范围必须用「板块标题(blockTitle)」定位（而非 section.el），实测 section.el 的 rect 罩不住卡片。
  if (isMoka()) {
    const titles = Array.from(document.querySelectorAll('[class*="blockTitle"]'))
      .map((b) => ({ t: (b.innerText || "").replace(/\s+/g, " ").trim(), top: b.getBoundingClientRect().top }))
      .filter((x) => /经历|经验|背景|能力|评价/.test(x.t))
      .sort((a, b) => a.top - b.top);
    const key = (MOKA_SEC_TITLE && MOKA_SEC_TITLE[sectionName]) || "";
    const idx = titles.findIndex((x) => x.t === key || x.t === key + "添加" || x.t.startsWith(key));
    if (idx >= 0) {
      const top = titles[idx].top;
      const bot = idx < titles.length - 1 ? titles[idx + 1].top : Infinity;
      const cards = Array.from(document.querySelectorAll('div[class*="apply-fields"][class*="multi"]')).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= top - 20 && r.top < bot;
      });
      return cards.length;
    }
  }

  // 腾讯作品集专项计数：站点无 <label>（仅 placeholder），且删除按钮是纯文字「删除作品」(无 data-icon)，
  // 导致通用 deleteIcons / 锚点 / byTitle 三路全部失效 → expandSection 误判 rendered:false 放弃建卡（历史「0 卡」根因）。
  // 修复：用「placeholder 含『请输入作品链接』但不含『相关项目』的输入框数」作为卡数（每张卡恰一个；
  // 主字段『请输入相关项目或作品链接』含『相关项目』被排除，避免多算 1）。
  // ⚠️ pf5 关键修正：旧版在末尾额外加了 section.el/nextTop 位置过滤，但新卡的 link 输入框常落在该纵向区间之外
  // （卡片在长表单里被推到下一板块附近），导致 countItemsForSection 恒返 0 → expandSection 把「输入框变多但锚点没变」
  // 误判成「点错按钮」而放弃，实测只建出 2 张卡就停。该 placeholder 全站唯一，直接全局计数 isVisible 的匹配输入框即可。
  if (sectionName === "portfolio") {
    const pfLinks = Array.from(document.querySelectorAll("input"))
      .filter((el) => {
        const ph = el.getAttribute("placeholder") || "";
        return /请输入作品链接/.test(ph) && !/相关项目/.test(ph);
      })
      .filter(isVisible);
    if (pfLinks.length > 0) return pfLinks.length;
  }

  // 优先数「删除按钮」数量：formily 数组卡片每条恰好一个删除按钮（DeleteTrashOutlined 图标）。
  // 比按字段标签计数可靠得多（标签可能读不到/读错，导致误判已展开条数而多加点空白）。
  const deleteIcons = Array.from(document.querySelectorAll("[data-icon]"))
    .filter((el) => /delete|trash|remove|minus/i.test(el.getAttribute("data-icon") || ""))
    .filter((el) => isVisible(el))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.top > myRect.top - 20 && r.top < nextTop;
    });
  if (deleteIcons.length > 0) return deleteIcons.length;

  // v0.8.18（#290）：按「卡片序号小标题」计数（拼多多等无 label 站点的唯一可靠信号）
  const byTitle = (() => {
    const titleRe = cardTitleReFor(sectionName);
    if (!titleRe) return 0;
    try {
      return Array.from(document.querySelectorAll("div,span,p,label,strong,b,h1,h2,h3,h4,h5,h6"))
        .filter((el) => el.children.length === 0 && titleRe.test((el.textContent || "").trim()))
        .filter(isVisible)
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.top > myRect.top - 20 && r.top < nextTop;
        }).length;
    } catch (e) { return 0; }
  })();

  // fallback：按板块锚点标签计数
  const regex = anchorsForSection(sectionName);
  if (!regex) return byTitle;
  // v0.6.71：必须把「无 input 的 mtd 级联/下拉容器」也算进来。
  // 美团竞赛卡片里一个 input 都没有（只有一个 .mtd-cascader），
  // 于是这里恒返回 0 → expandSection 认为「点了添加也没新增」→ rendered:false → 重试一次就放弃，
  // 3 条竞赛只展开出 2 张卡，而且后面每轮都以为一张都没有。
  const inputs = Array.from(document.querySelectorAll("input, textarea, select, [contenteditable='true']"))
    .concat(collectInputlessMtdControls())
    .filter((el) => isVisible(el))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.top > myRect.top - 20 && r.top < nextTop;
    });
  let count = 0;
  inputs.forEach((el) => {
    if (regex.test(getLabel(el))) count++;
  });
  // 锚点数不到（站点无 label）时才用卡片序号标题兜底，保持其它站点行为不变
  return count > 0 ? count : byTitle;
}

// 在「当前 section 标题」与「下一个 section 标题」之间，找「添加」按钮。
// 取该范围内最靠下（列表末尾）的添加按钮——formily 数组卡片把「添加」放在最后一张卡片的操作区。
function findAddButtonAfterSection(section, sections) {
  const myRect = section.el.getBoundingClientRect();
  const nextTop = (() => {
    const nexts = (sections || []).filter((s) => s.el && s.el.getBoundingClientRect().top > myRect.bottom - 5);
    nexts.sort((a, b) => a.el.getBoundingClientRect().top - b.el.getBoundingClientRect().top);
    return nexts.length ? nexts[0].el.getBoundingClientRect().top : Infinity;
  })();

  // 策略1：在本板块标题与下一板块标题（含向下 600px 余量）之间找最靠下的「添加」按钮。
  // v0.7.1（#185）：腾讯「添加学历」按钮恰好落在本板块视觉底部、紧挨下一板块顶部之下一点，
  // 原上界严格卡在 nextTop 会把真按钮裁掉，只剩同区的 help 容器 div 被返回、点了毫无反应。
  // 放宽 600px 余量（addBtnBelongsTo 已用按钮文案做板块归属校验，跨板块会被拒，放宽安全）。
  let candidates = Array.from(document.querySelectorAll("button, a, div, span, i, [role='button']"))
    .filter(isRealAddButton)
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    .filter(({ rect }) => rect.top > myRect.top - 20 && rect.top < nextTop + 600);

  // 策略2：若板块范围内没有，扩大到本板块标题下方 4000px 内找最近的「添加」按钮
  // （飞书有时把按钮放在标题右侧同一行，板块边界判断可能漏掉）
  if (!candidates.length) {
    candidates = Array.from(document.querySelectorAll("button, a, div, span, i, [role='button']"))
      .filter(isRealAddButton)
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.top > myRect.top - 40 && rect.top < myRect.top + 4000);
  }

  if (!candidates.length) return null;
  // v0.7.1（#185）：优先真实 button/a/[role=button]，避免点到 help 容器 div（见 findAddButtonInContainer）。
  const realOnes = candidates.filter(
    (c) => /^(button|a|i)$/i.test(c.el.tagName) || c.el.getAttribute("role") === "button"
  );
  const pool = realOnes.length ? realOnes : candidates;
  pool.sort((a, b) => b.rect.top - a.rect.top); // 最靠下的（列表末尾的「添加」按钮）
  return pool[0].el;
}

// 只在当前板块容器内（section.el 向上若干层祖先内）找「添加」按钮，绝不跨板块全局兜底，
// 避免误点别的板块（如语言能力 / 是否调剂）的「添加」按钮导致凭空多出空白条目。
function findAddButtonInContainer(section) {
  let node = section.el;
  for (let d = 0; d < 12 && node; d++) {
    const btns = Array.from(node.querySelectorAll("button, a, div, span, i, [role='button']")).filter(
      isRealAddButton
    );
    if (btns.length) {
      // v0.7.1（#185）：腾讯「添加学历」是 <BUTTON class="el-button el-button--text">添加学历</BUTTON>，
      // 但同区域还有「带 help 文案且 class 含 add」的容器 div 也通过了 isRealAddButton（按钮是其兄弟节点，不被子按钮判定排除）。
      // 必须优先选真正的 button / a / [role=button]，否则点到 help 容器毫无反应、教育卡创建不出来。
      // 没有真按钮时退回原逻辑（美团/字节的 div 按钮不受影响）。
      const real = btns.filter((b) => /^(button|a|i)$/i.test(b.tagName) || b.getAttribute("role") === "button");
      const pool = real.length ? real : btns;
      const labeled = pool.filter((b) => /^(添加|新增|增加|＋|\+)/.test(getText(b).trim()));
      const use = labeled.length ? labeled : pool;
      use.sort((a, b) => getText(a).length - getText(b).length);
      return use[0];
    }
    node = node.parentElement;
  }
  return null;
}

// 找板块内的"添加"按钮；找不到时扩大到父级或按位置最近找
function findAddButton(container, sectionEl) {
  const candidates = [container, container.parentElement, container.parentElement?.parentElement].filter(Boolean);
  for (const c of candidates) {
    const all = Array.from(c.querySelectorAll("button, a, div, span, i, svg")).filter(isRealAddButton);
    // 优先文本完全等于“添加”且在最前面的
    const exact = all.find((el) => getText(el) === "添加" || getText(el) === "+ 添加");
    if (exact) return exact;
    // 其次选文本最短的（避免点到长句子里的“添加”）
    all.sort((a, b) => getText(a).length - getText(b).length);
    if (all.length) return all[0];
  }

  // 兜底：在整个文档里找，选距离 section 标题下方最近的可见添加按钮
  const sectionRect = sectionEl ? sectionEl.getBoundingClientRect() : null;
  if (!sectionRect) return null;
  const allGlobal = Array.from(document.querySelectorAll("button, a, div, span, i, svg"))
    .filter(isRealAddButton)
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.top > sectionRect.top && r.top < sectionRect.top + 2000;
    });
  // v0.7.1（#185）：优先真实 button/a/[role=button]，避免 help 容器 div。
  const realG = allGlobal.filter((el) => /^(button|a|i)$/i.test(el.tagName) || el.getAttribute("role") === "button");
  const poolG = realG.length ? realG : allGlobal;
  poolG.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return ra.top - rb.top;
  });
  return poolG[0] || null;
}

// 统计某板块当前已展开的条目数（不重复扫描并重置 ATTR）
function countExpandedItemsInContainer(container, sectionName) {
  const anchors = {
    // v0.7.1（#185）：裸 /学校|院校/ 会被**同卡里别的字段的长提示文案**命中。
    // 腾讯「目前就读地*」的提示写着「…国内院校请输入中文名…」，于是一张教育卡被数成 2 条，
    // current=2 → toAdd=0 → 档案里的第 2 段教育根本没展开出来（实测只填了本科，硕士整段丢失）。
    // 锚点的语义是「每张卡的第一个字段」，所以必须从标签**开头**匹配，不能全文搜关键词。
    education: /^[\s*＊]*(学校名称|院校名称|毕业院校|学校|院校)/,
    work: /公司|企业|单位/,
    internships: /公司|企业|单位/,
    projects: /项目名|项目名称|课题/,
    portfolio: /作品名称|作品名|作品标题|作品链接/,
    // v0.6.71：锚点必须「每张卡只匹配到第一个字段」，否则一张卡会被数成 2~3 条，
    // 该加的卡加不出来。所以用「校园经历名称」而不是「校园经历」（后者还会命中时间/描述）。
    campus: /校园经历名称|^社团名称$|^组织名称$|^校园经历$/,
    competitions: /获奖大赛|竞赛名称|大赛名称|^竞赛$/,
    // v0.7.1（#185）：裸「奖项」会同时命中同一张卡里的「奖项名称*」和「奖项说明」，
    // 一张卡被数成 2 条 → 腾讯 4 条获奖只展开出 3 张卡（current 报 2 实为 1 张卡，toAdd 少算一次）。
    // 锚点必须保证「每张卡只匹配第一个字段」，所以裸词一律改成精确匹配。
    awards: /奖项名称|获奖名称|荣誉名称|^奖项$|^荣誉$/,
    papers: /论文题目|论文标题|论文名称/,
    certificates: /证书名称|证书/,
    skills: /技能名称|技能/,
    // v0.6.65：原来的 /语言|语种/ 会把同一张卡里的「语言类型」「语言水平」「语言考试」
    // 全部算成条目，一张卡被数成 2~3 条，导致该加的卡没加（实测语言需要 3 条只加出 2 条）。
    // 收窄成「只匹配每张卡的第一个字段」：美团=语言类型，飞书/字节=语言。
    languages: /语言类型|语种类型|^语种$|^语言$|语言名称/,
    selfEval: /自我评价|个人评价|自我介绍|自我描述/,
  };
  const regex = anchors[sectionName];
  if (!regex) return 0;
  const inputs = container.querySelectorAll("input, textarea, select, [contenteditable='true']");
  let count = 0;
  inputs.forEach((el) => {
    if (!isVisible(el)) return;
    const label = getLabel(el);
    if (regex.test(label)) count++;
  });
  return count;
}

// 根据板块标题位置，找它右侧/下方最近的“添加”按钮（飞书页面里标题和按钮常无共同小容器）
function findSectionAddButton(section) {
  const sectionRect = section.el.getBoundingClientRect();
  const candidates = Array.from(document.querySelectorAll("button, a, div, span, i, svg"))
    .filter(isRealAddButton)
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    .filter(({ rect }) => {
      const horizontalOverlap = rect.left < sectionRect.right + 500 && rect.right > sectionRect.left - 100;
      const belowOrSameRow = rect.top >= sectionRect.top - 40;
      const notTooFar = rect.top < sectionRect.bottom + 400 && rect.left < sectionRect.right + 600;
      return horizontalOverlap && belowOrSameRow && notTooFar;
    });
  candidates.sort((a, b) => {
    const da = Math.hypot(a.rect.left - sectionRect.left, a.rect.top - sectionRect.top);
    const db = Math.hypot(b.rect.left - sectionRect.left, b.rect.top - sectionRect.top);
    return da - db;
  });
  return candidates[0]?.el || null;
}

// 为经历板块自动点击「添加」按钮（在 section 范围内查找并点击末尾的「添加」按钮），点击后轮询验证新条目出现
// 数某个板块纵向范围内可见输入框的总数（比锚点计数更宽松，
// 用来判断「点击添加后有没有真的新增一条」；不依赖锚点标签是否匹配）
function countInputsInSection(section, sections) {
  const myRect = section.el.getBoundingClientRect();
  const nextTop = (() => {
    const nexts = (sections || []).filter((s) => s.el && s.el.getBoundingClientRect().top > myRect.bottom - 5);
    nexts.sort((a, b) => a.el.getBoundingClientRect().top - b.el.getBoundingClientRect().top);
    return nexts.length ? nexts[0].el.getBoundingClientRect().top : Infinity;
  })();
  return Array.from(document.querySelectorAll("input, textarea, select, [contenteditable='true']"))
    .concat(collectInputlessMtdControls()) // v0.6.71：竞赛卡片没有 input，只有 .mtd-cascader
    .filter((el) => isVisible(el))
    .filter((el) => {
      // 决策/主观类字段（是否调剂/薪资等）不计入——防止误点调剂区添加按钮后判定「新增成功」
      if (FORBIDDEN_RE.test(getLabel(el) || "")) return false;
      const r = el.getBoundingClientRect();
      return r.top > myRect.top - 20 && r.top < nextTop;
    }).length;
}

// v0.6.80：「添加」按钮归属校验 —— 点下去之前先确认这个按钮真属于本板块。
// 背景：findAddButtonInContainer 会沿 parentElement 向上冒泡最多 12 层，
// 板块自己没有添加按钮时（如美团作品集是纯上传框），会冒到公共祖先，
// 抓到【隔壁板块】的按钮并点下去 —— 本板块一行没建，邻居却凭空多出空条目。
// 这类污染发生在「点错了就停」的事后判定之前，所以必须在点击前拦住。
// 两条判据：① 按钮纵向必须落在本板块与下一板块之间；② 按钮文案不能带别的板块名。
// v0.7.1（#185）：「添加」按钮文案 → 板块归属的专用映射表。
// 为什么不直接放宽 SECTION_KEYWORDS：那张表同时用于「板块标题识别」，
// 往 education 里塞「学历」会让教育卡片内的「学历*」字段被当成板块标题，整页板块归属立刻崩掉
// （campus/awards 上踩过同样的坑）。这里只在「判断这个添加按钮属于谁」时使用，风险隔离。
//
// 触发这条修复的实际事故：腾讯的「论文」不是独立板块，而是教育卡片内的一个 textarea，
// detectSections 却把它当成 papers 板块 → 该板块找不到自己的添加按钮 → 几何兜底向下抓到
// 「添加学历」并点击 → 凭空多出一段永远填不满的空白教育经历（6 个必填项标红）。
const ADD_BTN_OWNER = [
  [/学历|教育|院校|学校/, "education"],
  [/实习/, "internships"],
  [/工作|职业/, "work"],
  [/项目/, "projects"],
  [/校园|社团|学生工作/, "campus"],
  [/作品/, "portfolio"],
  [/获奖|荣誉|奖项/, "awards"],
  [/证书|资格/, "certificates"],
  [/论文|著作|发表/, "papers"],
  [/专利|发明成果|知识产权/, "patents"],
  [/竞赛|大赛|比赛/, "competitions"],
  [/语言|外语/, "languages"],
  [/社交|主页/, "social"],
];

function addBtnBelongsTo(btn, section, sectionName, sections) {
  if (!btn) return false;
  const myTop = section.el.getBoundingClientRect().top;
  const nextTop = (sections || [])
    .filter((s) => s.el && s.el !== section.el && s.name !== sectionName)
    .map((s) => s.el.getBoundingClientRect().top)
    .filter((top) => top > myTop + 5)
    .sort((a, b) => a - b)[0];
  const r = btn.getBoundingClientRect();
  // 越界：按钮跑到本板块上方，或已经落进下一个板块的地盘
  if (r.top < myTop - 40) return false;
  if (nextTop !== undefined && r.top >= nextTop) return false;
  // 文案自证：「添加荣誉」出现在 portfolio 板块 → 一定是点错了
  const txt = (getText(btn) || "").trim();
  if (txt) {
    // 先查专用归属表：按钮文案里带板块名词的（「添加学历」「添加实习经历」），归属是确定的，
    // 只要和当前板块对不上就直接否决，不再往下走宽松的 SECTION_KEYWORDS 判断。
    for (let ai = 0; ai < ADD_BTN_OWNER.length; ai++) {
      if (ADD_BTN_OWNER[ai][0].test(txt)) {
        const owner = ADD_BTN_OWNER[ai][1];
        if (owner !== sectionName) {
          rfaLog({ act: "addbtn-reject", sec: sectionName, btn: txt.slice(0, 16), owner: owner });
          return false;
        }
        return true;
      }
    }
    const mine = SECTION_KEYWORDS[sectionName];
    if (!(mine && mine.test(txt))) {
      for (const name in SECTION_KEYWORDS) {
        if (name === sectionName) continue;
        if (SECTION_KEYWORDS[name].test(txt)) return false;
      }
    }
  }
  return true;
}

// v0.8.9（#Moka 加卡修复）：Moka 系（mokahr.com 全家 + 大疆 careers.dji.com）的「添加」按钮
// 固定在板块标题栏里、与标题同行（如 "工作经历添加" 的 blockTitle 块内右侧 sd-Button），
// 而通用查找器只往 section.el 内容区向下找、或按纵向范围取"最靠下"按钮（会取到下一板块的按钮），
// 导致 Moka 每个板块都 expand-nobtn、只留 1 张默认卡。此处按板块标题文字精确定位本板块的「添加」按钮，
// 标题匹配即保证归属，无需 addBtnBelongsTo 的越界二次校验。
function isMoka() {
  return /mokahr\.com|careers\.dji\.com/i.test(location.hostname);
}
function isTencent() {
  return /join\.qq\.com/i.test(location.hostname);
}
// 通用展开「添加」按钮定位（含 腾讯作品集专属分支）。
// 腾讯作品集「添加作品链接」按钮在板块底部、紧贴下一板块边界，
// 通用 findAddButtonAfterSection 能找到它，却被 addBtnBelongsTo 的 nextTop 越界判定拒掉
// （nextTop 恰好卡在按钮上方）→ 整段 expand-nobtn 放弃建卡。这里按全站唯一的文案直接定位。
function findExpandAddButton(section, container, sectionName, sections) {
  if (isMoka()) return findMokaAddButton(sectionName);
  if (isTencent() && sectionName === "portfolio") {
    const wrap = Array.from(document.querySelectorAll("button,div,span,a,i,[role='button']")).find((el) => {
      const t = (getText(el) || "").trim();
      return (t === "添加作品链接" || t === "添加作品") && isVisible(el);
    });
    if (wrap) {
      // 真实点击处理器在内部 <button>（Vue @click 绑在子按钮上，点外层 DIV 触发不到），
      // 必须返回内部 button/anchor 而不是文字包裹 DIV，否则 simulateClick 派发在父节点只向上冒泡、到不了子处理器。
      const inner = wrap.querySelector("button,a,[role='button']");
      return inner || wrap;
    }
    return null;
  }
  return [
    findAddButtonInContainer(section),
    findAddButtonAfterSection(section, sections),
    container ? findAddButton(container, section.el) : null,
  ].find((b) => addBtnBelongsTo(b, section, sectionName, sections));
}
const MOKA_SEC_TITLE = {
  education: "教育背景", internships: "实习经历", work: "工作经历",
  projects: "项目经验", campus: "校园经历", awards: "获奖经历",
  competitions: "竞赛", languages: "语言能力", certificates: "证书",
  skills: "技能", selfEval: "自我评价", papers: "论文",
};
function findMokaAddButton(sectionName) {
  const title = MOKA_SEC_TITLE[sectionName];
  if (!title) return null;
  const headers = Array.from(document.querySelectorAll("[class*=blockTitle]")).filter((h) => {
    const t = (h.textContent || "").trim();
    return t === title || t === title + "添加" || t.startsWith(title);
  });
  for (const h of headers) {
    const scope = [h, h.parentElement, h.parentElement && h.parentElement.parentElement].filter(Boolean);
    for (const sc of scope) {
      const btn = Array.from(sc.querySelectorAll("button, [role=button], div, span, i"))
        .find((b) => isRealAddButton(b) && /添加/.test(getText(b)));
      if (btn) return btn;
    }
  }
  return null;
}

async function expandSection(section, container, sectionName, needed, sections) {
  const current = countItemsForSection(section, sectionName, sections);
  const toAdd = Math.max(0, needed - current);
  rfaLog({ act: "expand-begin", sec: sectionName, needed: needed, current: current, toAdd: toAdd });
  if (toAdd <= 0) return;

  for (let i = 0; i < toAdd; i++) {
    // Moka 系：「添加」按钮固定在板块标题栏（与标题同行），通用查找器够不到，
    // 用标题文字精确定位本板块的「添加」按钮（标题匹配即保证归属，跳过越界二次校验）。
    let btn = findExpandAddButton(section, container, sectionName, sections);
    if (!btn) {
      // v0.6.80：宁可这个板块不展开，也绝不点邻居的按钮往别人那儿加空条目
      rfaLog({ act: "expand-nobtn", sec: sectionName, i: i, why: isMoka() ? "moka-no-add-btn" : "no-owned-add-button" });
      break;
    }
    const beforeItems = countItemsForSection(section, sectionName, sections);
    const beforeInputs = countInputsInSection(section, sections);
    rfaLog({ act: "expand-click", sec: sectionName, i: i, before: beforeItems, btn: (getText(btn) || "").slice(0, 16) });
    simulateClick(btn);
    // 飞书/字节系动态表单渲染较慢，轮询等待新条目出现（最多约 4.8s）。
    // 「成功」判定采用严格口径：本板块的锚点条数必须增加才视为真新增；
    // 若只是输入框总数变多而锚点没变，说明点到了别的区域（如调剂区）的添加按钮，
    // 视为点错 —— 立即停止整个板块，绝不继续（用户多次反馈过「加了大量空白」）。
    let rendered = false;
    for (let t = 0; t < 6; t++) {
      await sleep(800);
      const nowItems = countItemsForSection(section, sectionName, sections);
      if (nowItems > beforeItems) {
        rendered = true;
        break;
      }
      if (countInputsInSection(section, sections) > beforeInputs && nowItems <= beforeItems) {
        // 输入框变多但锚点没变 → 点错按钮，立即放弃本板块
        break;
      }
    }
    rfaLog({ act: "expand-after", sec: sectionName, i: i, rendered: rendered, now: countItemsForSection(section, sectionName, sections) });
    if (!rendered) {
      // 首次点击疑似未生效：只重试一次；重试后仍无新增则放弃，
      // 绝不反复点击 —— 防止在「计数失效」时不断添加空白条目（用户多次反馈过此问题）
      const btn2 = findExpandAddButton(section, container, sectionName, sections);
      if (!btn2) {
        rfaLog({ act: "expand-nobtn", sec: sectionName, i: i, why: "retry-no-owned-button" });
        break;
      }
      rfaLog({ act: "expand-retry", sec: sectionName, i: i, before: beforeItems });
      simulateClick(btn2);
      await sleep(1800);
      const afterRetry = countItemsForSection(section, sectionName, sections);
      rfaLog({ act: "expand-retry-after", sec: sectionName, i: i, now: afterRetry });
      if (afterRetry <= beforeItems) {
        break; // 重试仍无效或点错，停止本板块（宁可少加，不可多加空白）
      }
    }
  }
}

// v0.7.1：记录「本页实际存在哪些板块」，供跨板块去重决策使用。
// 由 fallbackMap（按扫描到的字段）与 expandExperienceSections（按 detectSections）双向写入，
// 保证展开阶段和填值阶段看到的是同一份板块清单。
let __RFA_PAGE_SECTIONS = new Set();
let __RFA_DUTY_COUNT__ = {}; // #561：各板块职责/描述类字段数（fallbackMap 开头统计，matchFieldCore 读取判断单框合并/多框分开）
function pageHasSection(name) {
  return __RFA_PAGE_SECTIONS.has(name);
}

// v0.7.1：经历类「描述」兜底拼接。
// 档案 v2.0 把实习/工作描述拆成了 responsibilities（职责）+ achievements（成果）两段，
// 根本不存在 description 字段；而字节/蔚来的经历卡只有一个笼统的「描述」框。
// 原来 /描述/ 规则直接 return item.description → undefined → 三张实习卡描述全空。
// 拼接时按中文习惯处理句末标点，避免两段话粘在一起。
function joinExpDesc(item) {
  if (!item) return null;
  const parts = [item.responsibilities, item.achievements]
    .map((s) => String(s == null ? "" : s).trim())
    .filter(Boolean);
  if (!parts.length) return null;
  return parts.reduce((acc, cur) => {
    if (!acc) return cur;
    return /[。！？.!?；;]$/.test(acc) ? acc + cur : acc + "。" + cur;
  }, "");
}

// v0.8.40（2026-08-14 · A1 语言强制规格）：语言能力板块统一口径 ——
//   · 按「语种名」分组，每个语种只留 1 张卡（杜绝同语种多条证书展开成多张重复/空白卡）；
//   · 每张卡只填「精通程度/熟练程度」，**一律不填分数/考试/证书**（用户反复强调 7-8 次，禁再错）；
//   · 取该语种「精通度最高项」：母语 > 精通 > 双语/无障碍商务沟通 > 熟练 > 良好 > 一般。
// 历史旧逻辑：按页面是否有「考试槽位」决定是否去重、并保留分数 —— 与 A1 规格冲突，
// 是美团「2→4 + 大量空白卡」、飞书系「同语种多张卡」反复出问题的根因，已废弃。
// 注意：langPageHasExamSlot 探测曾被飞书系页面含「语言考试」字样误判，且本就与规格相悖，
// 故整套探测逻辑停用，全部站点一律走 dedupeLanguages。
function languagesForPage(profile) {
  const all = (profile && profile.languages) || [];
  if (!all.length) return [];
  return dedupeLanguages(all);
}

// v0.7.3（#199）：把语言证书映射成熟练程度，用于蔚来等只有「语言+精通程度」、无考试槽位的站点。
// 同语种多条证书会在 dedupeLanguages 按 level 取最高；本函数在没有显式 level 时按证书等级推断。
function examToLevel(exam, score) {
  const e = String(exam || "").trim();
  const s = parseFloat(String(score || "").replace(/[^\d.]/g, "")) || 0;
  if (/CET-?6|六级|专八/.test(e)) return "精通";
  if (/雅思|IELTS/i.test(e)) return s >= 7 ? "精通" : "熟练";
  if (/托福|TOEFL/i.test(e)) return s >= 100 ? "精通" : "熟练";
  if (/CET-?4|四级|专四/.test(e)) return "熟练";
  if (/普通话|母语/.test(e)) return "母语";
  if (/其他/.test(e)) return "熟练";
  return "熟练";
}

// v0.6.90：语言按「语种名」去重，避免同一语种多条证书（英语 CET-4/6/IELTS/TOEFL）
// 在字节等只有「语种+熟练程度」的站点被展开成多张重复卡片。去重后每种语言只留一条，
// 优先保留熟练度更高的条目。美团保持原样（不改动历史已验证行为）。
function dedupeLanguages(langs) {
  if (!Array.isArray(langs) || !langs.length) return [];
  // v0.8.40（A1 规格·熟练度阶梯）：旧版 order 表只收了「母语/精通/熟练/良好/一般」几个纯等级词，
  // 而真实档案里英语写的是**场景词**「无障碍商务沟通」→ 查表 miss → rank 恒为 9，
  // 「取该语种精通度最高项」形同虚设（4 条英语谁先出现就用谁）。这里改为正则阶梯匹配，
  // 场景词与等级词同表排序，且不区分大小写、兼容英文写法。
  const LADDER = [
    /母语|native|bilingual|双语/i,            // 0 最高
    /精通|proficient|expert|master/i,          // 1
    /无障碍|商务沟通|流利|fluent|advanced/i,   // 2（英语「无障碍商务沟通」落这一档）
    /熟练|熟悉|良好|intermediate|business/i,   // 3
    /日常会话|一般|基础|入门|了解|basic|beginner|elementary/i, // 4
  ];
  const rankOf = (lv) => {
    const s = String(lv || "").trim();
    if (!s) return 9;
    for (let i = 0; i < LADDER.length; i++) if (LADDER[i].test(s)) return i;
    return 8; // 有值但不认识：仍优于完全无值
  };
  const map = {};
  for (const it of langs) {
    const name = (it && (it.name || it)) || "";
    const key = String(name).trim();
    if (!key) continue;
    let lv = String((it && it.level) || "").trim();
    if (!lv) lv = examToLevel(it && it.exam, it && it.score); // 无显式 level 时按证书推断
    const rank = rankOf(lv);
    const cur = map[key];
    if (!cur || rank < cur._rank) map[key] = Object.assign({}, it, { level: lv, _rank: rank });
  }
  // A1 规格：每语种只填精通程度，不填分数/考试 —— 这里直接把 exam/score 剥掉，
  // 从数据源头断掉「分数框被塞值」的可能（取值端另有一道拦截，双保险）。
  return Object.values(map).map((o) => {
    const c = Object.assign({}, o);
    delete c._rank;
    delete c.exam;
    delete c.score;
    return c;
  });
}

function getSectionNeeded(profile, sectionName) {
  if (sectionName === "languages") {
    // v0.7.1：改由 languagesForPage 统一决定（页面有考试槽位就不去重），
    // 与取值端共用同一份数组，杜绝「建 3 张卡却按原数组前 3 条取值」的错位。
    return languagesForPage(profile).length;
  }
  if (sectionName === "work") {
    // 秋招常见：页面只有「工作经历」，但用户实际填的是实习经历，实习数据可共用
    const workLen = (profile.work || []).length;
    if (workLen > 0) return workLen;
    // v0.7.1 关键修复：字节页【同时】存在「工作经历」和「实习经历」两个独立板块。
    // 原来无脑用实习数据顶包，结果同一段实习既进工作经历、又进实习经历 ——
    // 简历里一段经历出现两次，是会被 HR 直接扣分的硬错误。
    // 只有页面确实没有实习板块时，才允许拿实习数据填工作经历。
    if (pageHasSection("internships")) return 0;
    return (profile.internships || []).length;
  }
  if (sectionName === "social") {
    // 用户没维护社交数据时，复用作品集里的链接（如 GitHub 主页）；最多 3 条，避免展开过多空白
    if (Array.isArray(profile.social) && profile.social.length) return profile.social.length;
    const links = (profile.portfolio || []).filter((p) => p && (p.link || p.url)).length;
    return Math.min(links, 3);
  }
  if (sectionName === "competitions") {
    // v0.6.72：美团「获奖大赛」是必填级联，且只有 10 个编程赛事可选。
    // 站点选项里没有的竞赛（数学建模、互联网+…）建了卡也只能空着，
    // 必填空值反而会卡住保存——所以只按站点支持的条数建卡。
    // v0.8.x（2026-08-14）：放开保守策略——按档案实际竞赛条数建卡（不再被 contestSupportedByMtd 裁剪）。
    // 名称不在美团固定 10 个编程赛下拉里的竞赛，名称框自然留空（级联 nohit → A3 闸门），
    // 但级别/时间/描述照样填。与下方取值端共用同一份 profile.competitions，保证索引一致。
    return (profile.competitions || []).length;
  }
  const arr = profile[sectionName];
  if (Array.isArray(arr)) return arr.length;
  if (sectionName === "portfolio" && Array.isArray(profile.portfolio)) return profile.portfolio.length;
  // 字符串型板块（如 selfEval）只要有内容就至少需要 1 条
  if (typeof arr === "string" && arr.trim()) return 1;
  return 0;
}

// ── 2026-08-10：「无 X」勾选框独立前置扫描（不依赖 detectSections）──────────────
// 板块被勾选框隐藏时 detectSections 检测不到它，就永远走不到取消勾选那一步（死锁）。
// 这里直接遍历页面上所有可见勾选框，按自身文案反查板块，有数据就取消勾选。
const NO_DATA_BOX_MAP = [
  [/实习/, "internships"],
  [/工作/, "work"],
  [/项目/, "projects"],
  [/获奖|荣誉/, "awards"],
  [/竞赛|比赛/, "competitions"],
  [/证书|资格/, "certificates"],
  [/论文/, "papers"],
  [/专利|发明成果|知识产权/, "patents"],
  [/作品/, "portfolio"],
  [/校园|社团|在校|学生工作/, "campus"],
  [/语言/, "languages"],
  [/教育/, "education"],
  [/社交/, "social"],
];
async function uncheckNoDataBoxes(profile) {
  try {
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    let hits = 0;
    const log = [];
    for (const cb of boxes) {
      const lb = String(getLabel(cb) || findNearestText(cb) || "").trim();
      // 只认「无 / 没有 / 暂无」开头且长度很短的「我没有这类经历」勾选框
      if (!/^(无|没有|暂无)[^，。,;]{1,10}$/.test(lb)) continue;
      const hit = NO_DATA_BOX_MAP.find(([re]) => re.test(lb));
      if (!hit) continue;
      const sec = hit[1];
      const needed = getSectionNeeded(profile, sec);
      // 这里**只做取消勾选**一个方向。反向（没数据就主动勾上）交给后面的
      // toggleNoExperienceCheckbox 按板块处理 —— 主动勾选会隐藏板块，
      // 万一账号里本来存着用户真实数据，勾上等于一键抹掉，风险太高，前置扫描不碰。
      if (needed > 0 && cb.checked) {
        simulateClick(cb);
        hits++;
        log.push(lb + "→uncheck(" + sec + ":" + needed + ")");
        await sleep(600);
      }
    }
    if (log.length) rfaLog({ act: "no-data-box", changed: hits, detail: log });
  } catch (e) {
    rfaLog({ act: "no-data-box-err", err: String((e && e.message) || e).slice(0, 120) });
  }
}

const NO_BOX_SAFE_TO_CHECK = new Set(["work", "internships", "projects"]);

// 处理「没有工作经历/没有实习经历」这类复选框：
// 若用户有相关数据则取消勾选以展开表单；若没有则保持/改为勾选，避免留下空白必填项。
function toggleNoExperienceCheckbox(sectionName, shouldFill) {
  // 2026-08-10（腾讯实测）：只覆盖 work/internships/projects 远远不够——
  // 腾讯「无获奖信息」默认勾选，整个获奖板块 li 挂 hide_box 直接隐藏，
  // 档案里 4 条获奖 + 3 条竞赛一条都填不进去（板块压根不在 DOM 可见范围）。
  // 凡是「无 X」类勾选框，只要档案对应板块有数据就必须取消勾选。
  const labels = {
    work: /没有工作经历|无工作经历|暂无工作经历|目前没有工作经历|no work experience/i,
    internships: /没有实习经历|无实习经历|暂无实习经历|目前没有实习经历|no internship/i,
    projects: /没有项目经历|无项目经历|暂无项目经历|目前没有项目经历|no project/i,
    awards: /没有获奖(信息|经历)?|无获奖(信息|经历)?|暂无获奖|无荣誉|没有荣誉|no award/i,
    competitions: /没有竞赛|无竞赛|暂无竞赛|无比赛经历|no competition/i,
    certificates: /没有证书|无证书|暂无证书|无技能证书|no certificate/i,
    papers: /没有论文|无论文|暂无论文|no paper/i,
    patents: /没有专利|无专利|暂无论文|无发明成果|没有发明成果|no patent/i,
    campus: /没有(校园|社团|在校)经历|无(校园|社团|在校)经历|暂无(校园|社团)经历/i,
    portfolio: /没有作品|无作品|暂无作品|no portfolio/i,
    languages: /没有语言|无语言能力|暂无语言/i,
    education: /没有教育经历|无教育经历|暂无教育经历/i,
    social: /没有社交|无社交(账号|主页)?|暂无社交/i,
  };
  const re = labels[sectionName];
  if (!re) return false;

  const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter((el) => {
    const label = getLabel(el) || findNearestText(el);
    return re.test(label);
  });

  let changed = false;
  for (const cb of checkboxes) {
    if (shouldFill && cb.checked) {
      simulateClick(cb);
      changed = true;
    } else if (!shouldFill && !cb.checked && NO_BOX_SAFE_TO_CHECK.has(sectionName)) {
      // 只有原本就验证过的 work/internships/projects 才允许「主动勾上」，
      // 新扩的获奖/证书/论文等一律不勾 —— 勾上会隐藏整块，
      // 若账号里存着用户真实数据等于一键抹掉（腾讯 hide_box 实测）。
      simulateClick(cb);
      changed = true;
    }
  }
  return changed;
}

// 专门处理「左右布局空板块」：自我评价 / 社交账号的默认状态是 applyFormModuleWrapper-empty，
// 标题在左、唯一的「添加」按钮在右（兄弟节点，不在标题的祖先链上）。
// 通用 expandSection 从标题元素向上找按钮永远碰不到右侧按钮，导致卡片始终展开不了。
// 这里直接按标题文字定位空板块，点其内部的「添加」按钮（class 含 apply-form-array-card-add-float-right）。
async function expandWrapperArraySection(titleText, needed) {
  if (!needed || needed <= 0) return;
  // v0.8.13（字节修复）：wrapper class 是 CSS Modules 哈希（applyFormModuleWrapper__2JZaE）
  // 或空态（applyFormModuleWrapper-empty），旧精确选择器 `div.applyFormModuleWrapper` 匹配 0 个
  // → 语言/社交卡永远建不出来（真机：语言 6 条只填 1 条、社交 8 条只填 1 条）。
  // 改前缀匹配 [class*="applyFormModuleWrapper"]；前缀会命中 title/left/text 等子元素，
  // 故优先选「含添加按钮」的容器（否则 addBtn 永远 null）。
  const wrappers = Array.from(
    document.querySelectorAll("[class*='applyFormModuleWrapper']")
  ).filter((el) => {
    const t = getText(el);
    return t && t.includes(titleText);
  });
  if (!wrappers.length) return;
  const hasAddBtn = (w) =>
    w.querySelector(
      "button.apply-form-array-card-add-float-right__1d6856, button.apply-form-array-card-add-float-right, [class*='apply-form-array-card-add']"
    ) ||
    Array.from(w.querySelectorAll("button, [role='button'], div, span, a")).some(
      (b) => /^(\+\s*)?添加/.test(getText(b).trim()) && isRealAddButton(b)
    );
  // v0.8.13（字节社交最终修复）：空态 wrapper class 是「applyFormModuleWrapper-empty applyFormModuleWrapper__xx」（双 token），
  // 点击「添加」后 React **替换整个 DOM 节点**（空态→非空态不同模板）→ 旧 wrapper 引用 detached → countCards 恒 0
  // → waitRender 永远失败（真机铁证：社交 8 条只填 1 条，wrap-expand-stop at:0）。
  // 修法：每次点击前**重新定位 wrapper / addBtn**（findWrapper 重查 DOM），countCards 也基于最新 wrapper。
  const findWrapper = () => {
    const ws = Array.from(
      document.querySelectorAll("[class*='applyFormModuleWrapper']")
    ).filter((el) => {
      const t = getText(el);
      return t && t.includes(titleText);
    });
    if (!ws.length) return null;
    return ws.find(hasAddBtn) || ws[0];
  };
  let wrapper = findWrapper();
  if (!wrapper) return;
  // 优先按 class 精确定位，兜底按文字含「添加」的元素。
  // v0.7.1 关键修复（#167 根因）：原来三级兜底全部限定 <button>，
  // 但字节的社交板块「添加」是个 DIV（class = apply-form-array-card-operate__xxxx），
  // 三个选择器全部落空 → if (!addBtn) return 直接退出 → 一张卡都没加出来。
  // 后果：档案 8 条社交只有默认那 1 张卡可写，8 条数据挤同一张卡互相覆盖
  // （实测结果是平台停在「微信」、URL 却是最后一条的 github.com/example）。
  // v0.8.13（字节社交修复）：真「添加」是 BUTTON.ud__button--text-primary（文本"添加"），
  // 旧兜底 button+div+span+a 一把抓，先命中了无效的 DIV.apply-form-array-card-operate 包装层
  //（点它不建卡）。必须 **button/[role=button] 优先**、div/span/a 兜底。
  const findAddBtn = (w) =>
    w.querySelector("button.apply-form-array-card-add-float-right__1d6856") ||
    w.querySelector("button.apply-form-array-card-add-float-right") ||
    w.querySelector("[class*='apply-form-array-card-add']") ||
    Array.from(w.querySelectorAll("button, [role='button']")).find(
      (b) => /^(\+\s*)?添加/.test(getText(b).trim()) && isRealAddButton(b)
    ) ||
    Array.from(w.querySelectorAll("div, span, a")).find(
      (b) => /^(\+\s*)?添加/.test(getText(b).trim()) && isRealAddButton(b)
    );
  let addBtn = findAddBtn(wrapper);
  if (!addBtn) return;

  // v0.8.x（2026-08-14·字节语言卡修复）：旧 countCards 只数「含 input/textarea 的卡片」，
  // 但字节语言卡用 ud__select（自定义 div 下拉，卡内没有真正的 input），于是计数恒为 0 →
  // 误判「没有卡片」→ over-click 出一堆幽灵空卡；且字节新卡挂载要等数百毫秒~数秒，旧的 3s 渲染判定太短。
  // v0.8.13（字节社交最终修复）：`[class*='array-card']` 每张卡会命中 4 个嵌套节点
  //（容器 apply-form-array-card__xx / -content- / -operate- / -add-），旧的「含控件」过滤仍重复计数 → waitRender 误判。
  // 改为精确数「卡片容器」：class 以 apply-form-array-card__ 开头（content/operate/add 的 class 是 -content-/-operate-/-add-，
  // 不含 __ 前缀，天然排除）。真机验证：2 张社交卡 → 此口径恰为 2。
  const countCards = () => {
    const w = findWrapper();
    if (!w) return 0;
    let n = 0;
    w.querySelectorAll("[class*='array-card']").forEach((c) => {
      const cn = (typeof c.className === "string" ? c.className : "").trim();
      if (cn.indexOf("apply-form-array-card__") === 0) n++;
    });
    return n;
  };
  const before = countCards();
  const clicks = Math.max(0, needed - Math.max(before, 0));
  rfaLog({ act: "wrap-expand", sec: titleText, needed: needed, have: before, click: clicks });

  // v0.8.13（字节社交最终修复）：字节空态→非空态是**整棵 DOM 替换**，新卡延迟数百毫秒~数秒挂载，
  // waitRender 按 countCards 判定实测不可靠（点击实际成功、计数却判定失败 → 提前 stop，社交 8 条只建 2 张）。
  // 改为：clicks 次点击之间**固定等 2s**（不依赖计数），全部点完；reconcile 再用精确 countCards 核账补点。
  for (let i = 0; i < clicks; i++) {
    // 每次点击前重新定位（空态→非空态 DOM 节点被 React 替换，旧引用已 detached）
    wrapper = findWrapper() || wrapper;
    addBtn = findAddBtn(wrapper) || addBtn;
    simulateClick(addBtn);
    await sleep(2000);
  }
  // v0.8.x：字节新卡常延迟挂载，上面的循环可能漏点。结束后再核账：没到 needed 就补点（同样带 2s 等待），
  // 绝不盲目多点到溢出，也不因单次渲染慢就少卡。
  let guard = 0;
  while (countCards() < needed && guard < needed + 2) {
    // v0.8.13：每次点击前重新定位（空态→非空态 DOM 节点被 React 替换）
    wrapper = findWrapper() || wrapper;
    addBtn = findAddBtn(wrapper) || addBtn;
    simulateClick(addBtn);
    await sleep(2000);
    guard++;
  }
}

// v0.8.x（2026-08-14·字节语言卡修复）：字节简历从服务端**懒加载**，语言等 array-card 板块
// 在开跑瞬间往往还没挂载（expand 阶段 countCards 读到 0 → over-click 出幽灵卡），
// 且「添加」后新卡也要等数百毫秒~数秒才挂载。故字节站内：填充前先等语言卡片稳定（确认已加载），
// 填充后再等一次（确认新卡已挂载），让后续 scanFields 能扫到全部卡片、按语种逐一取值。
async function waitBytedanceLangStable(maxMs) {
  if (!/jobs\.bytedance\.com/i.test(location.hostname)) return -1;
  const langWrapper = () => {
    const ws = Array.from(
      document.querySelectorAll("div.applyFormModuleWrapper, div.applyFormModuleWrapper-empty")
    );
    return ws.find((w) => (getText(w) || "").includes("语言能力")) || null;
  };
  const t0 = Date.now();
  let last = -1,
    stable = 0;
  while (Date.now() - t0 < (maxMs || 30000)) {
    const w = langWrapper();
    const n = w
      ? Array.from(w.querySelectorAll("[class*='array-card']")).filter(
          (c) => !/add/i.test(c.className) && c.querySelector("input, textarea, [contenteditable='true'], [class*='ud__select']")
        ).length
      : 0;
    if (n === last) {
      if (++stable >= 2) {
        rfaLog({ act: "bd-lang-stable", n });
        return n;
      }
    } else {
      stable = 0;
      last = n;
    }
    await sleep(1500);
  }
  rfaLog({ act: "bd-lang-stable-timeout", last });
  return last;
}

async function expandExperienceSections(profile) {
  // 语言板块展开策略：
  //  · 字节（jobs.bytedance.com）：applyFormModuleWrapper 结构，走 expandWrapperArraySection（见循环内 bytedance 分支 + 函数末尾兜底）。
  //  · 飞书系（蔚来/小鹏/小米/携程）：语言板块是「下拉/隐藏组件」，展开后扫不到字段、填不上，
  //    仍走下方通用 expandSection（现状），保持不动以免回归；真机实测飞书语言卡已由其它路径或用户补填。
  const expandable = [
    "education",
    "work",
    "internships",
    "projects",
    // v0.6.71：按美团页面顺序补入 校园经历 / 证书 / 论文 / 竞赛
    "campus",
    "portfolio",
    "awards",
    "certificates",
    "papers",
    "patents",
    "competitions",
    "skills",
    "languages",
    "social",
    "selfEval",
  ];
  const sections = detectSections();
  // v0.7.1：展开阶段早于字段扫描，这里先按 detectSections 结果落一份板块清单，
  // 供 getSectionNeeded 判断「页面是否另有实习板块」（决定工作经历要不要建卡）。
  __RFA_PAGE_SECTIONS = new Set(sections.map((s) => s.name).filter(Boolean));
  // v0.8.13c（#285）：京东校招简历页有自己独立的、按档案条数精准补卡的展开逻辑
  // （expandJdCards + jdFillCombinedSkills），不依赖通用展开器。通用展开器在京东上
  // 「+ 添加」点击大多 rendered:false（React 合成事件不触发），6/7 板块 0 卡；
  // 且会失控叠出上百张教育卡。故京东直接跳过通用展开器，避免把页面搞乱。
  if (/campus\.jd\.com/i.test(location.hostname)) {
    rfaLog({ act: "expand-skip-jd", reason: "JD uses expandJdCards" });
    return;
  }
  // 2026-08-11（#PDD）：拼多多由专门的 expandPddCards 完成板块展开（runAutofill 里已调用）。
  // 通用展开器在拼多多上：① 用 detectSections 定位不到缺 <label> 的板块 → 部分板块漏展开；
  // ② 对已展开的 education/languages 又点一遍「添加」→ 叠卡。故拼多多整段跳过。
  if (/pddglobalhr\.com/i.test(location.hostname)) {
    rfaLog({ act: "expand-skip-pdd", reason: "PDD uses expandPddCards" });
    return;
  }
  // ── 2026-08-10（腾讯根因）：先做一遍「无 X」勾选框独立前置扫描 ────────────────
  // 死锁场景：腾讯「无获奖信息」默认勾选 → 获奖板块 li 挂 hide_box 整块隐藏 →
  // detectSections 里的 isVisible() 过滤掉它 → sections 里根本没有 awards →
  // 下面按 s.name 调 toggleNoExperienceCheckbox 的分支永远不执行 → 板块永远打不开。
  // 所以必须脱离 detectSections，直接按勾选框自身文案反查板块。
  await uncheckNoDataBoxes(profile);

  // v0.6.62：同名板块只展开一次。detectSections 仍可能在一个板块里命中多个元素
  // （标题 + 卡片内文字等），若不去重就会对同一板块连点两轮「添加」，空白卡片成倍增长。
  // 这是「宁可少加、不可多加」原则的最后一道保险。
  const expandedSections = new Set();
  for (const s of sections) {
    if (!expandable.includes(s.name)) continue;
    if (expandedSections.has(s.name)) continue;
    expandedSections.add(s.name);
    const needed = getSectionNeeded(profile, s.name);
    rfaLog({ act: "expand-sec", sec: s.name, needed: needed, txt: (s.text || "").split("\n")[0].slice(0, 14) });
    // 先处理「没有XX经历」复选框：有数据就取消勾选、让表单展开
    if (toggleNoExperienceCheckbox(s.name, needed > 0)) {
      await sleep(500);
    }
    if (needed <= 0) continue;
    // v0.6.65：美团的「作品集」不是可重复卡片，而是一个纯上传拖拽区（.mtd-upload）。
    // 通用展开逻辑会把上传区当成「添加」按钮点下去 —— 轻则无效（实测 rendered:false, now:0），
    // 重则弹出系统文件选择框把浏览器卡住。这里直接跳过，附件交给后面的 handleFileUploads 处理。
    // v0.6.80：上面这段跳过逻辑一直没生效 —— detectSections 给到的 s.el 是【标题元素】
    // （innerText 只有「作品集」三个字），上传区是它的兄弟节点，
    // 所以 closest/querySelector(".mtd-upload") 双双落空，跳过分支从未进入。
    // 实测事故：portfolio 找不到自己的添加按钮，沿 parentElement 冒泡 12 层窜到上方【荣誉】板块，
    // 点了 2 次「添加荣誉」—— 作品集一行没建（rendered:false, now:0），荣誉却多出 2 个空条目。
    // 正确做法：先上溯到板块根容器（.model_edit）再找上传区/文件输入框。
    if (s.name === "portfolio") {
      // v0.8.x（2026-08-15）：腾讯作品集是「可添加卡片(作品链接+密码/提取码)+附件上传」混合结构，
      // 必须展开卡片（用户要求「每卡填文字」）。原跳过逻辑因板块内有 input[type=file]（附件区）
      // 误判为纯上传拖拽区、整段跳过 → 0 卡。故腾讯不跳过，走通用 expandSection（卡数已用 placeholder 修正）。
      // 美团等纯上传站点(.mtd-upload)保持跳过，避免把上传区当添加按钮点。
      const isTencent = /join\.qq\.com/i.test(location.hostname);
      if (!isTencent) {
        const secRoot =
          (s.el.closest && s.el.closest("[class*='model_edit']")) || s.el.parentElement || s.el;
        const dropzone =
          (s.el.closest && s.el.closest(".mtd-upload")) ||
          (secRoot.querySelector &&
            (secRoot.querySelector(".mtd-upload") || secRoot.querySelector('input[type="file"]')));
        if (dropzone) {
          rfaLog({ act: "expand-skip", sec: "portfolio", why: "upload-dropzone" });
          continue;
        }
      }
    }
    // 自我评价 / 社交账号 是左右布局空板块，通用展开扫不到右侧「添加」按钮，走专门逻辑
    if (s.name === "selfEval") { await expandWrapperArraySection("自我评价", needed); continue; }
    if (s.name === "social") { await expandWrapperArraySection("社交账号", needed); continue; }
    // v0.8.x（2026-08-14）：字节语言板块是 applyFormModuleWrapper 结构（空态 applyFormModuleWrapper-empty），
    // 通用 expandSection 在字节上找不到添加按钮/锚点计数失败。故字节站内语言卡走 expandWrapperArraySection
    // （社交账号已在该结构成功复用），填值端按 A1 只填「语言类型+精通程度」、不填分数。
    // 仅对字节生效——飞书系（蔚来/小鹏等）语言板块仍走下方通用路径（保持现状，避免回归）。
    if (s.name === "languages" && /jobs\.bytedance\.com/i.test(location.hostname)) { await expandWrapperArraySection("语言能力", needed); continue; }
    const container = findSectionContainer(s);
    await expandSection(s, container, s.name, needed, sections);
  }
  // v0.8.x（2026-08-14）：字节 detectSections 可能漏识别 applyFormModuleWrapper 结构的语言板块，
  // 上述循环拿不到 languages section，导致语言卡从不被创建。主动兜底：字节站内展开「语言能力」卡片
  // （expandWrapperArraySection 内部按 countCards 去重，已展开不会多卡，不会误伤其他站点）。
  if (/jobs\.bytedance\.com/i.test(location.hostname)) {
    await expandWrapperArraySection("语言能力", getSectionNeeded(profile, "languages"));
  }
}

// 粗略确定板块容器（优先找同时包含标题和“添加”按钮的最近父级）
function findSectionContainer(section) {
  let el = section.el;

  // 策略1：向上遍历，优先找包含可见“添加”按钮的最近祖先
  for (let i = 0; i < 12 && el; i++) {
    const parent = el.parentElement;
    if (!parent) break;
    const addBtns = Array.from(parent.querySelectorAll("button, a, div, span, i, svg")).filter(isRealAddButton);
    if (addBtns.length) {
      return parent;
    }
    el = parent;
  }

  // 策略2：从标题向下找最近的“添加”按钮，再向上找包含标题的祖先
  const sectionRect = section.el.getBoundingClientRect();
  const all = Array.from(document.querySelectorAll("button, a, div, span, i, svg"))
    .filter(isRealAddButton)
    .filter((btn) => {
      const r = btn.getBoundingClientRect();
      return r.top > sectionRect.top && r.top < sectionRect.top + 2000;
    });
  if (!all.length) return section.el.parentElement;

  all.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  const nearest = all[0];
  let node = nearest;
  for (let i = 0; i < 10 && node; i++) {
    if (node.contains(section.el)) return node;
    node = node.parentElement;
  }
  // 兜底：返回按钮的父容器
  return nearest.parentElement || section.el.parentElement;
}

function showToast(text, type) {
  let bar = document.getElementById("rfa-toast");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "rfa-toast";
    bar.style.cssText =
      "position:fixed;top:16px;right:16px;z-index:2147483647;padding:10px 14px;" +
      "border-radius:8px;font-size:13px;font-family:sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.15);" +
      "max-width:320px;line-height:1.5;transition:opacity .3s;";
    document.body.appendChild(bar);
  }
  // v0.7.1：这里原来有两个「看起来能跑、其实一直是坏的」问题：
  //  ① 色值漏了 background: 前缀 —— "#E1F5EE;color:#085041" 拼进 cssText 后，
  //     "#E1F5EE" 是一条非法声明会被浏览器直接丢掉，提示条**从来没有过背景色**。
  //  ② 压根没有 warn 类型 —— 代码里 showToast(..., "warn") 会落到 colors.ok，
  //     于是「⚠ 简历上传失败」用的是绿色成功配色。这正是 #166 要根治的
  //     「失败长得像成功」，光在文案里加 ⚠ 没用，颜色必须跟着对。
  const colors = {
    ok: "background:#E1F5EE;color:#085041",
    err: "background:#FCEBEB;color:#791F1F",
    warn: "background:#FFF3E0;color:#8A4B08",
    wait: "background:#FAEEDA;color:#633806",
  };
  bar.style.cssText += colors[type] || colors.ok;
  bar.textContent = text;
  bar.style.opacity = "1";
  clearTimeout(bar._t);
  // 需要用户动手处理的提示（失败/警告）多留一会儿，4.5 秒很容易被错过
  const hold = type === "warn" || type === "err" ? 12000 : 4500;
  bar._t = setTimeout(() => (bar.style.opacity = "0"), hold);
}

  // 学历已合并进 profile.education，无需 eduPreset 兜底

// 判断字段当前是否已填
function isFieldFilled(el) {
  if (!el) return true;
  // v0.7.1（#185）：单选组容器自身没有 value，只能看有没有选中项（.is-checked / input.checked）
  if (isRadioGroup(el)) return !!getCheckedRadio(el);
  // v0.7.1（#185）：.el-dropdown 字段（外语考试类型）自身无 value，看触发文字是否已离开占位符
  if (isDropdownField(el)) return !isDropdownEmpty(el);
  if (el.tagName === "SELECT") return !!el.value;
  if (el.getAttribute("contenteditable") === "true") return el.innerText.trim().length > 0;
  // v0.6.71：美团 mtd-cascader（竞赛「获奖大赛」）没有 input，选中值写在内部
  // .mtd-select-filter-label 上（未选时是「请选择」且带 -hint 类）。
  // 必须排在下面的 .mtd-select 判断之前——cascader 的 .mtd-select 是它的**子节点**，
  // 从 cascader 容器自身 closest('.mtd-select') 取不到，会一路掉到最后 el.value 判空恒为 false，
  // 导致刚填好的竞赛又被判成未填、refill 反复重试。
  const casBox = el.classList && el.classList.contains("mtd-cascader") ? el : el.closest && el.closest(".mtd-cascader");
  if (casBox) {
    const lab = casBox.querySelector(".mtd-select-filter-label, .mtd-cascader-label");
    const t = (lab && getText(lab).trim()) || "";
    if (!t) return false;
    if (/^(请选择|请输入|未选择|pls?\s*select|select)$/i.test(t)) return false;
    if (lab && /-hint\b/.test((lab.className || "").toString())) return false;
    return true;
  }

  // v0.8.8（2026-08-08）：飞书招聘系（蔚来/小鹏/小米/携程）的 UD Select。
  // 它内部有个 class="ud__select__selector__search__input" 的搜索框，选中后 value 仍是空，
  // 真实已选值渲染在 .ud__select__selector__content；未选时页面上有个可见的
  // .ud__select__selector__placeholder 节点。旧代码按 el.value 判空 → 12 个已选下拉
  // 全被判未填，蔚来卡在 83%（真实约 99%），插件还会一轮轮去重填它们。
  const udBox = el.closest && el.closest('[class*="ud__select"]');
  if (udBox) {
    // v0.8.20 加固：ud 组件自身用 -not-empty 声明「已选中」，这是比内容文本探测更可靠的信号。
    // 只要 udBox 自身、祖先或后代里有 -not-empty 选择器，一律判已填，无论内部内容节点类名
    // 是否被我们的选择器覆盖，杜绝「组件已选、但 selectItem/selector__content 文本读不到」
    // 导致的「填了还标黄」（用户实测字节/蔚来/小鹏已填下拉仍被标黄即此因）。
    const notEmptyRe = /ud__select__selector-not-empty/;
    if (
      notEmptyRe.test((udBox.className || "").toString()) ||
      (udBox.querySelector && udBox.querySelector('[class*="ud__select__selector-not-empty"]')) ||
      (el.closest && el.closest('[class*="ud__select__selector-not-empty"]'))
    )
      return true;
    const udPh = Array.from(
      udBox.querySelectorAll('[class*="selector__placeholder"],[class*="select__placeholder"]')
    ).filter(isVisible)[0];
    if (udPh) return false;
    const udC = Array.from(
      udBox.querySelectorAll('[class*="selector__content"],[class*="selector__value"],[class*="select__value"]')
    ).filter(isVisible)[0];
    const udT = udC ? getText(udC).trim() : "";
    if (udT && !/^(请选择|请输入|未选择)$/.test(udT)) return true;
    return (el.value || "").trim().length > 0;
  }

  // v0.6.59-fix：美团 .mtd-select 的真实已选值在 .mtd-select-filter-label 里，input.value 常为 ""，
  // 导致已选的下拉框仍被右侧未填面板标黄。这里单独判断。
  const mtdBox = el.closest && el.closest(".mtd-select");
  if (mtdBox) {
    const labelEl = mtdBox.querySelector(".mtd-select-filter-label");
    const txt = (labelEl && getText(labelEl).trim()) || "";
    if (txt && !/^(请选择|请输入|未选择|pls?\s*select|select)$/i.test(txt)) return true;
    // 兜底再读 input.value
    if ((el.value || "").trim().length > 0) return true;
    return false;
  }

  // v0.8.5（#254）：Moka 体系（app.mokahr.com 全家 + 大疆）的 sd-Select。
  // 实测（2026-08-08 真机探测 app.mokahr.com/step/94905）：这类下拉选中后
  //   ① input.value 恒为 ""（值不写回 input）
  //   ② 选中值被渲染成字段容器内的第二个文本 <span>
  //   ③ 同时 input 的 placeholder 从「请选择」被清空
  // 对照组：
  //   已填「听说」→ input.value="" placeholder=""     容器文本 "听说\n熟练"
  //   未填「读写」→ input.value="" placeholder="请选择" 容器文本 "读写"
  // 此前没有这条分支，判定一路掉到最后的 el.value 判空 → 恒为 false →
  // 「刚填好也被判成未填」，refill 反复重试把下拉点开点关，状态反而被搞乱
  // （美团 mtd-cascader 在 v0.6.71 踩过一模一样的坑，见上方注释）。
  // 表现：Moka 5 家（大疆/元戎/速腾/安踏/阶跃）「听说」「读写」长期留白，卡在 83~88%。
  // v0.8.7（#275）：上面那版只认「apply-field 的 class 含 Select」，覆盖不到 Moka 的
  // **日期年/月**——它们外壳叫 date_info-xxx，但内部一样是 sd-Select。真机（速腾）实测：
  //   已选「2019」→ input.value="" placeholder=""      容器文本 "2019"
  //   未选        → input.value="" placeholder="请选择"
  // 旧代码让这 18 个年月控件掉到最后的 el.value 判空 → 恒判未填 → 每轮 refill 都去重点一遍，
  // 把已经选好的下拉点开点关，反而更容易搞乱状态；未填面板也虚报 18 个假空。
  // 统一口径：只要 input 落在 sd-Select-container / sd-picker-input 里，
  // **唯一可信信号就是 placeholder 是否被清空**。
  const mkBox =
    el.closest && el.closest('[class*="sd-Select-container"], [class*="sd-picker-input"]');
  if (mkBox) {
    const ph = (el.placeholder || "").trim();
    if (ph === "") return true;
    // v0.8.32（2026-08-12）：placeholder 未被清空、但容器里出现了「标签 + 已选值」两行文本 →
    // 值已渲染，判定已填，避免 Moka/大疆/安踏「已选精通却仍标黄」的误报
    // （值显示了但组件态未提交、placeholder 没清，旧逻辑只看 placeholder 恒判未填）。
    const parts = (getText(mkBox) || "")
      .split("\n").map(s => s.trim()).filter(Boolean)
      .filter(t => !/^(请选择|请输入|未选择)$/.test(t));
    if (parts.length >= 2) return true;
    return false;
  }

  const sdBox =
    el.closest && el.closest('[class*="apply-field"], [class*="apply-fields"]');
  if (sdBox && /Select/.test((sdBox.className || "").toString())) {
    const sdInp = sdBox.querySelector("input");
    const ph = (sdInp && (sdInp.placeholder || "").trim()) || "";
    // v0.8.5 修正：**绝不能拿 input.value 判已填**。真机实测（速腾）：
    //   真·已选 → value="" placeholder=""       容器文本 "听说\n熟练"
    //   假·打字 → value="女" placeholder="请选择" 容器文本 "性别\n女"（组件没收下，提交即丢）
    // 上一版先看 value 非空就 return true，等于把「硬打字残留」认成已填，
    // 于是性别/最高学历常年虚高、真正的问题被掩盖。唯一可信信号是 placeholder 被清空。
    if (/请选择|请输入|未选择/.test(ph)) return false;
    const lines = getText(sdBox)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length > 1) return true;
    return !!(sdInp && (sdInp.value || "").trim());
  }
  // v0.6.45/v0.6.48：飞书/字节系自定义下拉框以 div 容器作为候选，div 本身无 .value。
  // 关键修复：不能拿整个容器的 innerText 判——容器里可能夹着 label 文本（如「精通程度」「所在地点」），
  // 导致空字段被误判为已填，右侧未填面板漏列、用户以为已填。
  // v0.6.50：更稳妥的做法是优先用飞书官方「已选/未选」状态类名判断，其次读内部 input.value，
  // 最后才读已选内容区文本。避免箭头图标、隐藏占位符导致误判。
  const cls = (el.className || "").toString();
  // v0.7.1（#185）：腾讯 Element UI 2.x 的 el-select / el-cascader。
  // ⚠️ 必须排在下面的通用 combobox 分支**之前**：isCombobox() 对 .el-select/.el-cascader 返回 true，
  // 而通用分支最后会用 getText(el) 兜底；Element UI 在 popper-append-to-body=false 时把整个下拉面板
  // （.el-select-dropdown / .el-cascader-panel）渲染成 el-select 的**子节点**，即便 v-show 隐藏，
  // innerText 依然能读出全部候选项文本。实测腾讯「奖项名称*」空下拉（只要之前被点开过一次）
  // getText 返回 "美国大学生数学建模竞赛全国大学生数学建模竞赛挑战杯…"，于是空字段被判成已填、
  // cascadeRefill 直接跳过它 → 必填项永远空着（idx94 没点开过判 false，idx98 点开过判 true，同字段两种结果）。
  // 结论：Element UI 组件只能读「显示值」区域（input.el-input__inner / .el-tag / .el-cascader__label），
  // 绝不能读整个容器的 innerText。
  const elBox = /\bel-select\b|\bel-cascader\b/.test(cls) ? el : el.closest && el.closest(".el-select, .el-cascader");
  if (elBox) {
    // Element UI 2.x 把选中值写在 input.el-input__inner 上（Plus 版才是 el-select__inner），两个都读
    const elInner = elBox.querySelector("input.el-select__inner, input.el-input__inner");
    if (elInner && (elInner.value || "").trim()) return true;
    // 多选：数 .el-tag，但要排除下拉面板内部可能存在的 tag（面板是子节点，会被 querySelectorAll 捞到）
    const tags = elBox.querySelectorAll(".el-tag");
    for (let ti = 0; ti < tags.length; ti++) {
      if (tags[ti].closest(".el-select-dropdown, .el-cascader-panel, .el-cascader__dropdown")) continue;
      if ((tags[ti].innerText || tags[ti].textContent || "").trim()) return true;
    }
    // 级联组件部分版本把已选路径渲染在 .el-cascader__label 上
    const casLab = elBox.querySelector(".el-cascader__label");
    const casTxt = casLab ? (casLab.innerText || casLab.textContent || "").replace(/\s+/g, " ").trim() : "";
    if (casTxt && !/^(请选择|请输入|未选择)/.test(casTxt)) return true;
    return false;
  }
  // v0.8.40（A2·京东）：antd v3 下拉（京东校招 .ant-select）。
  // 京东「国家/地区/民族/所在城市/证件类型」等已填下拉，旧逻辑无此分支 → 掉到末尾 el.value 判空
  // （antd v3 选中值不写回 input.value，渲染在 .ant-select-selection-selected-value）→ 恒判未填 → 误标黄。
  // 判据：容器存在 .ant-select-selection-selected-value（已选值节点）且非占位符即已填；可见 placeholder 即未填。
  const antBox = el.closest && el.closest(".ant-select");
  if (antBox) {
    const sel = antBox.querySelector(".ant-select-selection-selected-value, .ant-select-selection__rendered");
    const selTxt = sel ? getText(sel).replace(/\s+/g, " ").trim() : "";
    if (selTxt && !/^(请选择|请输入|未选择|select)$/i.test(selTxt)) return true;
    const antPh = Array.from(antBox.querySelectorAll(".ant-select-selection__placeholder")).filter(isVisible)[0];
    if (antPh) return false;
    if (antBox.querySelectorAll(".ant-select-selection__choice").length) return true; // 多选已选
    if ((el.value || "").trim().length > 0) return true;
    return false;
  }
  if (isCombobox(el) || /\bud__select\b/.test(cls) || /formily-select|semi-select/.test(cls)) {
    // 飞书自定义下拉：空框有 .ud__select__selector-empty 或没有 .ud__select__selector-not-empty；
    // 已选框一定有 .ud__select__selector-not-empty，且内部是 .ud__select__selector__selectItem 而不是 placeholder。
    if (/\bud__select__selector\b/.test(cls)) {
      const hasNotEmpty = /\bud__select__selector-not-empty\b/.test(cls);
      const hasSelectItem = !!el.querySelector(".ud__select__selector__selectItem");
      if (!hasNotEmpty && !hasSelectItem) return false;
      if (hasNotEmpty || hasSelectItem) return true;
    }
    const innerInput = el.querySelector && el.querySelector("input");
    if (innerInput && (innerInput.value || "").trim().length > 0) return true;
    const contentEl = el.querySelector(
      ".ud__select__selector__content, .ud__select__selector__single, .ud__select__selector__text, .ud__select__selector__input"
    );
    // 只认已选项节点，不认 placeholder
    const selectedItem = contentEl && contentEl.querySelector(".ud__select__selector__selectItem");
    if (selectedItem && getText(selectedItem).trim()) return true;
    const txt = getText(contentEl || el).trim();
    if (txt && !/^(请选择|pls?\s*select|select|请挑选|未选择)$/i.test(txt)) return true;
    return false;
  }
  return (el.value || "").trim().length > 0;
}

// 找与某类文件对应的上传框（input[type=file]）；usedInputs 已占用的框会被跳过，便于多个作品分别上传
// 注意：input[type=file] 本身常被隐藏，所以这里不判断可见性；真正点文件框时会找它可见的 trigger。
// 飞书/字节系把隐藏 input 放在 .atsx-upload 容器内，真正的板块标识在祖先节点上，
// 因此必须往祖先收集 data-form-field-* 和文本，而不是只看 input 自己的 label。
// 收集 input 及其祖先的上下文（data-form-field-*、文本、label），用于判断文件框归属板块。
// 抽成模块级函数：findFileInputFor 与 autoRestoreWorkAttachments 都要用，
// 之前 getContext 仅定义在 findFileInputFor 内部，导致自动恢复一调用就抛 getContext is not defined。
function buildFileContext(inp) {
  const ctx = {
    fieldId: (inp.getAttribute("data-form-field-id") || "").toLowerCase(),
    fieldName: (inp.getAttribute("data-form-field-name") || "").toLowerCase(),
    fieldI18n: (inp.getAttribute("data-form-field-i18n-name") || "").toLowerCase(),
    accept: (inp.getAttribute("accept") || "").toLowerCase(),
    texts: [],
  };
  let p = inp.parentElement;
  for (let i = 0; i < 8 && p; i++) {
    if (!ctx.fieldId) ctx.fieldId = (p.getAttribute("data-form-field-id") || "").toLowerCase();
    if (!ctx.fieldName) ctx.fieldName = (p.getAttribute("data-form-field-name") || "").toLowerCase();
    if (!ctx.fieldI18n) ctx.fieldI18n = (p.getAttribute("data-form-field-i18n-name") || "").toLowerCase();
    const t = getText(p);
    if (t) ctx.texts.push(t);
    p = p.parentElement;
  }
  ctx.all = (
    ctx.fieldId + " " + ctx.fieldName + " " + ctx.fieldI18n + " " + ctx.texts.join(" ") + " " + (getLabel(inp) || "")
  ).toLowerCase();
  return ctx;
}

function findFileInputFor(cat, usedInputs, fileName, workIndex) {
  const allInputs = Array.from(document.querySelectorAll("input[type=file]"));
  const inputs = allInputs.filter((i) => !(usedInputs && usedInputs.has(i)));
  if (!allInputs.length) return null;

  // 收集 input 及其祖先的上下文（data-form-field-id、name、i18n-name、文本、accept），
  // 用于判断这个 input 属于哪个板块（简历/作品/视频）以及是 PDF 框还是视频框。
  // 抽成模块级 buildFileContext（见下方定义），autoRestoreWorkAttachments 也要用，避免作用域报错
  const getContext = buildFileContext;

  // 根据待上传文件扩展名辅助判断该进 PDF 框还是视频框
  const ext = (fileName || "").toLowerCase().split(".").pop();
  const isPdfFile = ext === "pdf";
  const isVideoFile = /^(mp4|mov|avi|mp3|wav|flac|m4v|mkv|webm|m4a|aac|ogg)$/.test(ext);

  // v0.7.6（#257）：**格式硬校验**。腾讯整页只有一个简历上传框（文案写明
  // 「支持格式pdf/.doc/.docx/.jpg/.png」），插件却把作品集 测试作品集.zip 往里塞，
  // 页面每次都弹「不支持当前格式」红条——实测一轮刷了 60 多次，既拖慢填充又遮挡下方控件。
  // 现在：文件后缀与该框明确声明的格式清单冲突时直接判死（-1000），不再瞎传。
  const extConflict = (inp) => {
    if (!ext) return false;
    const c = getContext(inp);
    const accept = c.accept || "";
    const all = c.all || "";
    const hasDecl = /\.[a-z0-9]{2,5}/.test(accept) || /支持格式|支持的格式|格式[:：]/.test(all);
    if (!hasDecl) return false; // 没有明确声明格式 → 交给下面的语义打分
    const src = accept + " " + (/支持格式[^。\n]{0,60}|支持的格式[^。\n]{0,60}/.exec(all) || [""])[0];
    const list = Array.from(new Set((src.match(/\.?[a-z0-9]{2,5}/g) || []).filter((x) => /^\.?[a-z]/.test(x)).map((x) => x.replace(/^\./, ""))));
    if (!list.length) return false;
    return list.indexOf(ext) < 0;
  };

  const score = (inp) => {
    const ctx = getContext(inp);
    const accept = ctx.accept;
    let s = 0;
    if (extConflict(inp)) return -1000; // 格式不兼容，绝不往里塞
    // v0.6.72：美团页面有 3 个 input[type=file]——简历附件(.pdf/.doc/.docx)、
    // **头像(.jpg/.png/.jpeg)**、作品集(.rar/.zip/.7z/.pdf)。
    // 头像框上下文里也有「上传」二字，按老逻辑能拿到 +20 的正分，
    // 而作品附件走的是「按 DOM 顺序取第 workIndex 个正分框」——
    // 头像框排在作品集前面，works[0] 就会被塞进头像框。这里直接把纯图片框判死。
    const imgOnly = /image|\.jpe?g|\.png|\.gif|\.webp/i.test(accept) && !/\.(pdf|docx?|zip|rar|7z)/i.test(accept);
    if (imgOnly && cat !== "avatar") s -= 300;
    if (cat === "resume") {
      if (/attachment_resume/.test(ctx.all)) s += 200;
      if (/简历|resume/.test(ctx.all)) s += 80;
      if (/上传|附件/.test(ctx.all)) s += 20;
      if (/作品|portfolio|视频|video/.test(ctx.all)) s -= 150;
      if (isPdfFile && /\.pdf/.test(accept)) s += 30;
    } else if (cat === "portfolio") {
      // 作品附件是单文件框（PDF 和视频都进这一个框），不再按扩展名区分
      if (/attachment_portfolio|attachment_work|作品附件|作品集/.test(ctx.all)) s += 200;
      // 只有作品集框收压缩包，accept 本身就是最硬的证据
      if (/\.(zip|rar|7z)/i.test(accept)) s += 150;
      if (/作品|portfolio|附件/.test(ctx.all)) s += 80;
      if (/上传/.test(ctx.all)) s += 20;
      // 排除简历区
      if (/简历|resume/.test(ctx.all)) s -= 150;
    } else if (cat === "video") {
      // 作品视频：必须优先找视频专属上传框，严防 MP4 被塞进 PDF 框
      if (/attachment_portfolio|attachment_work|作品附件|作品集/.test(ctx.all)) s += 200;
      if (/视频|video|短片|demo/.test(ctx.all)) s += 120;
      if (/作品|portfolio|附件/.test(ctx.all)) s += 60;
      if (/上传/.test(ctx.all)) s += 20;
      // 明确是视频 accept
      if (/video|audio|mp4|mov|avi|mp3|wav|flac/.test(accept)) s += 120;
      // 明确是 PDF 上传框：上下文或 accept 里有 pdf
      if (/pdf|\.pdf|作品集 pdf/.test(ctx.all)) s -= 140;
      if (/\.pdf/.test(accept)) s -= 120;
      // 排除简历区
      if (/简历|resume/.test(ctx.all)) s -= 150;
    } else if (cat === "avatar") {
      // 证件照/头像框：只收图片，与简历框/作品框彻底隔离。
      // 关键坑：照片框的祖先链会兜到整页共享的「简历注册警告」长文案（含『简历』『作品』二字），
      // 旧逻辑 +200/+120/+80 被 -200/-200 抵消成 0 → 匹配失败、证件照永远传不上去。
      // 这里用「accept 是否为纯图片框」作为压倒性正信号(+500)，盖过共享文案带来的负分。
      const imgOnly = /image|\.jpe?g|\.png|\.gif|\.webp/i.test(accept)
        && !/\.(pdf|docx?|zip|rar|7z)/i.test(accept)
        && !/video|mp4|mov|avi|mkv|webm/i.test(accept);
      if (imgOnly) s += 500; // 纯图片框即证件照框，直接锁定
      if (/照片|头像|证件照|avatar|photo|个人照片/.test(ctx.all)) s += 200;
      if (/个人照片|证件照|头像|照片/.test(ctx.all)) s += 120;
      if (/\.jpe?g|\.png|\.gif|\.webp|image/.test(accept)) s += 80;
      if (/简历|resume/.test(ctx.all)) s -= 200;
      if (/作品|portfolio|视频|video/.test(ctx.all)) s -= 200;
    }
    return s;
  };

  // 作品附件：如果调用方提供了作品索引，按 DOM 顺序取第 workIndex 个候选框，
  // 保证插件里 works[0] 进网页第一个作品卡片，works[1] 进第二个，依此类推。
  // 注意：这里不过滤 usedInputs，因为作品索引对应的是网页上固定的卡片位置；
  // 如果该位置已经被占用，说明重复调用或顺序错乱，直接返回 null。
  if (cat === "portfolio" && typeof workIndex === "number" && workIndex >= 0) {
    const confident = allInputs
      .map((inp) => ({ inp, s: score(inp) }))
      .filter((x) => x.s > 0);
    // v0.6.81 关键修复：上面「按 workIndex 取第 N 个框」是为蔚来/字节那种
    // **每个作品一张卡片、一张卡片一个上传框**的页面设计的。
    // 美团完全相反：整页只有一个 input[type=file][multiple]（accept=.rar,.zip,.7z,.pdf）
    // 收下全部作品附件。旧逻辑在美团上会把 works[0]→候选[0]、works[1]→候选[1]，
    // 而正分候选只有 2 个 → works[2](rar)/works[3](7z) 直接越界 file_input_miss，
    // 用户看到的现象就是「四个格式只上去两个」。
    // 只要候选里存在 multiple 框，就让所有作品附件都落它（调用方那边 !input.multiple
    // 才会加进 usedInputs，所以不会被标记占用，可以连续塞）。
    const multiBox = confident.filter((x) => x.inp.multiple).sort((a, b) => b.s - a.s)[0];
    if (multiBox) {
      rfaLog({
        type: "file_input_match",
        cat,
        fileName,
        workIndex,
        score: multiBox.s,
        multiple: true,
        context: getContext(multiBox.inp).all.slice(0, 200),
      });
      return multiBox.inp;
    }
    // 按 DOM 顺序排列，而不是按分数排列
    confident.sort((a, b) => {
      const pos = a.inp.compareDocumentPosition(b.inp);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    const picked = confident[workIndex];
    if (picked) {
      if (usedInputs && usedInputs.has(picked.inp)) {
        rfaLog({ type: "file_input_miss", cat, fileName, workIndex, reason: "already_used" });
        return null;
      }
      rfaLog({ type: "file_input_match", cat, fileName, workIndex, score: picked.s, context: getContext(picked.inp).all.slice(0, 200) });
      return picked.inp;
    }
    const best = confident.sort((a, b) => b.s - a.s)[0];
    rfaLog({ type: "file_input_miss", cat, fileName, workIndex, bestScore: best ? best.s : null });
    return null;
  }

  const scored = inputs.map((inp) => ({ inp, s: score(inp) })).sort((a, b) => b.s - a.s);
  const best = scored[0];

  // 只有置信度 > 0 才直接返回；否则走兜底，避免把作品错填进简历
  if (best && best.s > 0) {
    rfaLog({ type: "file_input_match", cat, fileName, score: best.s, context: getContext(best.inp).all.slice(0, 200) });
    return best.inp;
  }

  // 兜底：简历找不到明确作品标识时，优先用第一个 input（兼容旧版行为）；
  // 作品/视频如果没有 confident match，宁可返回 null 走手动上传，也绝不 fallback 进简历区。
  if (cat === "resume") {
    const nonWork = inputs.find((inp) => !/作品|portfolio|视频|video/.test(getContext(inp).all));
    return nonWork || inputs[0];
  }
  rfaLog({ type: "file_input_miss", cat, fileName, bestScore: best ? best.s : null });
  return null;
}

// 把 base64 文件塞进 <input type=file>（绕过系统文件框，实现自动上传）
// v0.6.75 关键修复：文件赋值必须在「主世界」完成。
//   旧实现直接在 content.js 的隔离世界里 new File + input.files=dt.files + 派发 change，
//   但隔离世界创建的 File 对象主世界（React 上传处理器）读不到 —— onChange 虽然触发，
//   框架拿到的 files 是空的，整条 S3 预签名上传链路根本不会发出（表现为 upload_ok 报成功、
//   作品集列表却始终为空）。修复办法：给目标 input 打一个临时属性（DOM 跨世界共享），
//   再由注入到页面的 <script>（主世界执行）重建 File 并赋值 + 派发 change。
//   实测：主世界注入 7z/zip/rar/pdf 全部能触发 getPreSignedForUpload → s3plus → updateMetaData。
// 兜底通道：在隔离世界直接赋值（无 CSP / 无 background 时用，老站点仍然有效）
function setFileInputIsolated(input, b64, name, mime) {
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const f = new File([arr], name, { type: mime || "application/octet-stream" });
    const dt = new DataTransfer();
    dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    try {
      const dc = input.closest(".atsx-upload-drag") || input.closest("[class*='atsx-upload']");
      if (dc) {
        const dt2 = new DataTransfer();
        dt2.items.add(f);
        const mk = (t) => {
          const ev = typeof DragEvent !== "undefined"
            ? new DragEvent(t, { bubbles: true, cancelable: true, composed: true })
            : new Event(t, { bubbles: true, cancelable: true, composed: true });
          try { Object.defineProperty(ev, "dataTransfer", { value: dt2 }); } catch (e) {}
          return ev;
        };
        dc.dispatchEvent(mk("dragenter"));
        dc.dispatchEvent(mk("dragover"));
        dc.dispatchEvent(mk("drop"));
      }
    } catch (e) {}
    return input.files && input.files.length > 0;
  } catch (e) {
    return false;
  }
}

function mimeFromName(name) {
  const ext = String(name || "").toLowerCase().split(".").pop();
  const MAP = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    zip: "application/zip",
    rar: "application/x-rar-compressed",
    "7z": "application/x-7z-compressed",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    mp4: "video/mp4",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
  };
  return MAP[ext] || "application/octet-stream";
}

async function setFileInput(input, dataUrl, name) {
  const ATTR = "data-rfa-up";
  let marked = false;
  try {
    const [meta, b64] = dataUrl.split(",");
    let mime = (meta.match(/:(.*?);/) || [, "application/octet-stream"])[1];
    // v0.7.3：base64 解码出的 MIME 常是 application/octet-stream（dataURL 不保证带真实类型），
    // 而字节等站后端按 MIME 严格校验 —— 手动选文件时浏览器按扩展名给 application/zip，
    // 程序化注入若给 octet-stream 会被服务端拒收（文件名渲染后被隐藏）。
    // 这里按文件名后缀强制覆盖成正确 MIME，避免「静默拒收」。
    const realMime = mimeFromName(name);
    if (realMime) mime = realMime;
    if (!b64) return false;

    // 用临时属性标记目标 input（DOM 跨世界共享，主世界脚本据此定位）
    const TOKEN = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    input.setAttribute(ATTR, TOKEN);
    marked = true;

    // 主通道：请 background 用 chrome.scripting 在主世界执行注入（豁免页面 CSP）
    const res = await new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      const timer = setTimeout(() => finish(null), 20000);
      try {
        chrome.runtime.sendMessage(
          { action: "injectFileMainWorld", b64, name, mime, attr: ATTR, token: TOKEN },
          (r) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) return finish(null);
            finish(r || null);
          }
        );
      } catch (e) {
        clearTimeout(timer);
        finish(null);
      }
    });

    if (res && res.ok) {
      rfaLog({ type: "file_inject", world: "MAIN", name, detail: res.detail || null });
      marked = false; // 主世界执行体已自行清理属性
      return true;
    }

    // 兜底：主世界通道不可用时退回隔离世界（会记日志，便于排查静默失败）
    rfaLog({
      type: "file_inject_fallback",
      name,
      reason: (res && (res.error || (res.detail && res.detail.reason))) || "no_response",
    });
    const ok = setFileInputIsolated(input, b64, name, mime);
    return ok;
  } catch (e) {
    return false;
  } finally {
    if (marked) { try { input.removeAttribute(ATTR); } catch (e) {} }
  }
}

// 找实际能点开系统文件框的元素（隐藏的 input 点不出对话框，要找可见的触发按钮/label）
function findUploadTrigger(input) {
  if (isVisible(input)) return input;
  if (input.id) {
    const lbl = document.querySelector(`label[for="${input.id}"]`);
    if (lbl) return lbl;
  }
  let p = input.parentElement;
  while (p) {
    if (/^(button|label)$/i.test(p.tagName) || p.getAttribute("role") === "button") return p;
    p = p.parentElement;
  }
  return input;
}

// 从 chrome.storage.local 读取分片存储的文件（popup 与 content script 共享 storage）。
// 兼容旧格式：如果 storageKey 对应值直接包含 base64，则直接返回。
async function loadFragmentedFileForUpload(storageKey) {
  if (!storageKey) return null;
  const metaRes = await new Promise((resolve) => chrome.storage.local.get(storageKey, resolve));
  const meta = metaRes[storageKey];
  if (!meta) return null;
  if (meta.base64) return meta.base64;
  const fragmentCount = meta.fragments || 0;
  if (!fragmentCount) return null;
  const keys = [storageKey];
  for (let i = 0; i < fragmentCount; i++) keys.push(`${storageKey}_part${i}`);
  const parts = await new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  const arr = [];
  for (let i = 0; i < fragmentCount; i++) {
    arr.push(parts[`${storageKey}_part${i}`] || "");
  }
  return arr.join("");
}

// 文件上传：把收集到的文件逐个匹配到页面上传框。
// items: [{ cat: "resume"|"portfolio", data: {name,size,base64?,manual?,storageKey?}, workIndex? }]
// 小文件(base64)自动注入；大文件/无字节的点开上传框让用户选。
// 作品附件：每个作品卡片各有一个单文件框，按 workIndex 传到对应卡片的框里。
// 简历上传后蔚来会弹「解析并覆盖」提示条 → 自动点掉取消按钮，避免清掉已填字段。
// v0.6.58：美团作品集只有一个上传框，且 accept 限定为 .rar/.zip/.7z/.pdf：
//   <input class="mtd-upload-input" type="file" multiple accept=".rar,.zip,.7z,.pdf">
// 一次塞多个文件 / 塞不支持的格式（mp4、jpg 等）都会被页面直接丢弃，
// 所以这里只保留第一个格式合法的作品附件，其余明确提示用户手动处理。
// v0.6.72：定位「作品集」那个上传框。
// 页面上一共 3 个 input[type=file]：简历附件(.pdf/.doc/.docx)、头像(.jpg/.png/.jpeg)、
// 作品集(.rar/.zip/.7z/.pdf, multiple)。旧代码用 document.querySelector 取第一个，
// 拿到的是**简历框**，于是按 ".pdf,.doc,.docx" 去校验作品附件 ——
// .zip/.7z/.rar 全被判成「格式不支持」跳过，作品集永远传不上去。
function findMeituanPortfolioInput() {
  const inSection = document.querySelector("[class*='upload_sample_reel'] input[type=file]");
  if (inSection) return inSection;
  // 兜底按 accept 认：整页只有作品集框收压缩包
  return (
    Array.from(document.querySelectorAll("input[type=file]")).find((i) =>
      /\.(rar|zip|7z)/i.test(i.getAttribute("accept") || "")
    ) || null
  );
}

function filterMeituanUploads(items) {
  if (!isMeituan()) return items || [];
  const inp = findMeituanPortfolioInput();
  const accept = (inp && inp.getAttribute("accept")) || ".rar,.zip,.7z,.pdf";
  const exts = accept
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.startsWith("."));
  const extOk = (name) => !exts.length || exts.some((e) => String(name || "").toLowerCase().endsWith(e));

  // v0.6.80：早期以为美团作品集只能传 1 个附件，于是硬编码了 portfolioTaken 一刀切。
  // 实测该 input[type=file] 带 multiple=true，页面文案也是
  // 「点击上传或将你的作品集&其他附件拖拽至此区域 / 支持 rar/zip/7z/pdf（150M 以内）」——
  // 本来就支持多个。改为按 input.multiple 判定，多选时四种格式一起传。
  const multi = !!(inp && inp.multiple);
  const out = [];
  const skipped = [];
  let portfolioTaken = false;
  for (const it of items || []) {
    if (!it || !it.data) continue;
    if (it.cat === "resume") { out.push(it); continue; } // 简历框是独立的，不受影响
    // v0.6.83：证件照走独立通道，绝不能用作品集框的 accept(.rar/.zip/.7z/.pdf) 去校验，
    // 否则 jpg/png 会被当成「格式不支持」丢弃（这正是三通道隔离要解决的问题）。
    if (it.cat === "avatar") { out.push(it); continue; }
    const name = it.data.name || "";
    if (!extOk(name)) { skipped.push(name + "（格式不支持）"); continue; }
    if (!multi && portfolioTaken) { skipped.push(name + "（页面只允许 1 个）"); continue; }
    portfolioTaken = true;
    out.push(it);
  }
  if (skipped.length) {
    rfaLog({ type: "mt_upload_skip", accept, multiple: multi, skipped });
    showToast(
      `以下附件未上传：${skipped.join("、")}（页面支持 ${exts.join("/")}${multi ? "" : "，且只允许 1 个"}）。如需上传请手动操作。`,
      "wait"
    );
  }
  return out;
}

// v0.6.80：判断同名附件是否已经挂在页面上。
// 实测事故：冒烟测试传过一次 测试作品集.pdf，完整填充又传一次，
// 美团作品集里并排躺着两个同名文件 —— 用户看到的就是「重复上传」。
// v0.6.81：上一版这里照抄了 antd/mtd 组件库的通用类名（.mtd-upload-list-item ...），
// 但美团简历页的附件列表**根本不是这个结构**。DOM 探针实测真实结构是：
//   <div class="sample_list"><div class="model_list">
//       <div class="name">测试作品集.pdf</div><i class="mtdicon-delete-o"></i>
//   </div></div>
// 选择器全部落空 → 去重形同虚设 → 冒烟测试传过的 pdf 在完整填充时又被传一次，
// 页面上并排两个同名文件。这里改成「美团真实结构 + 通用结构」双保险。
// v0.7.1：类名清单改成「快路径」，命中不了就走通用的 findFileNameNodes 兜底。
// live 实测：字节 3 个已上传附件在旧逻辑下全判 false —— 去重完全失效，
// 等于把 v0.6.80/0.6.81 在美团修掉的「重复上传两个同名文件」事故原样搬到了字节。
function isAlreadyUploaded(name) {
  const target = String(name || "").trim();
  if (!target) return false;
  if (isAlreadyUploadedByClass(target)) return true;
  for (const n of findFileNameNodes(target)) {
    if (!UPLOAD_FAIL_RE.test(attachmentScopeText(n, target))) return true;
  }
  return false;
}

function isAlreadyUploadedByClass(target) {
  const nodes = document.querySelectorAll(
    // 美团真实结构（作品集/附件列表）
    "[class*='sample_list'] [class*='name'], [class*='model_list'] [class*='name'], " +
      "[class*='upload_sample_reel'] [class*='name'], [class*='attachment'] [class*='name'], " +
      // 通用组件库结构（字节/蔚来/飞书等）
      ".mtd-upload-list-item, .mtd-upload-list-item-name, [class*='upload-list'] li, " +
      "[class*='upload'] [class*='file-name'], [class*='upload'] [class*='fileName']"
  );
  for (const n of nodes) {
    const t = (n.innerText || n.textContent || "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    // 只在「短文本节点」上判定，避免命中把整块区域文字都包进来的祖先容器
    if (t.length > 200) continue;
    if (t.indexOf(target) >= 0) {
      // v0.7.1（#166）：**上传失败的条目也会把文件名留在列表里**。
      // 字节实测：9.4MB 的 测试简历.pdf 传失败后，列表里照样显示文件名，
      // 旁边才是一行小字「上传失败，请重试」。只认名字的话，重跑插件会判定
      // 「已在页面上」直接跳过 —— 用户永远等不到这份简历被补传，而且看到的是
      // 绿色的「跳过重复上传」，比不提示还误导。带失败文案的条目一律不算已上传。
      if (UPLOAD_FAIL_RE.test(attachmentScopeText(n, target))) continue;
      return true;
    }
  }
  return false;
}

// v0.7.1（#166）：上传结果校验。
// 招聘站对附件大小/格式的限制经常【完全不写在页面上】——字节的简历附件区通篇找不到
// 任何「不超过 N MB」的文案，只有传完才在文件名旁边冒出一行「上传失败，请重试」。
// 旧逻辑只要 setFileInput 派发 change 成功就 showToast「已上传 xxx」并记 upload_ok，
// 用户看到绿色提示以为稳了 —— 实测 9.4MB 的 测试简历.pdf 连传两次都失败，
// 插件全程没有任何异常提示，简历栏实际是空的。这在投递场景是最致命的一类静默失败。
// 这里在上传后回读页面，确认文件名旁边有没有失败态文案。
// 失败文案的匹配必须「宁紧勿松」。
// 第一版写得太贪心（重新上传|超过|过大|文件大小|不支持|格式(不|错)|error），
// live 一跑就翻车：美团简历区正常长这样 ——
//   「测试简历.pdf 预览｜删除｜重新上传  支持doc、docx、pdf格式（10M以下）」
// 「重新上传」是常驻操作按钮、「格式（10M以下）」是格式提示，结果一份**上传成功**的
// 简历被判成失败 → 插件会对着成功的上传弹警告、还会因为去重失效再传一份同名文件。
// 误报比漏报更伤：用户会开始不信任所有提示。所以这里只保留「明确在说失败」的说法。
const UPLOAD_FAIL_RE =
  /上传失败|上传出错|上传异常|上传未成功|解析失败|失败[，,、!！。]?\s*(请)?重试|请重新上传|文件过大|文件太大|图片过大|附件过大|大小超出|已超过|超过大小|超出大小|超过最大|格式不支持|不支持该?此?格式|格式错误|格式不正确|类型不支持|upload\s*(failed|error)|failed\s*to\s*upload/i;

const FILE_NAME_RE = /[^\s，,、|/\\]+\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|gif|zip|rar|7z|mp4|mov|avi)\b/gi;

// 插件自己吐的提示条里也带着文件名（「正在上传 测试简历.pdf…」），
// 扫页面找附件时必须把它排除掉，否则会拿自己的提示当成网站的上传结果 —— 那就成了
// 「自己证明自己成功」，校验形同虚设。
function isPluginOwnNode(n) {
  try {
    for (let p = n; p; p = p.parentElement) {
      if (p.id === "rfa-toast" || p.id === "rfa-panel" || /^rfa-/.test(p.id || "")) return true;
    }
  } catch (e) {}
  return false;
}

// 附件列表条目的通用识别：文件名所在的短节点。
// 为什么不再靠类名清单：美团是 .sample_list .name，字节是 p.uploadFile-loadedFilename
// （注意不是 file-name 也不是 fileName，属性选择器大小写敏感，老选择器一个都不中），
// 蔚来/腾讯还会是别的写法 —— 按站点追类名是永远追不完的打地鼠。
// 改成「短文本节点里出现文件名 + 处在上传类容器或带删除/更新等列表操作」来判定。
const UPLOAD_CTX_CLS_RE = /upload|attach|file|附件/i;
const UPLOAD_CTX_TEXT_RE = /删除|移除|预览|下载|重新上传|更新|上次上传|remove|delete|preview|download/i;
// 用 TreeWalker 直接遍历文本节点定位文件名，而不是 querySelectorAll 全站扫元素。
// 前一版对每个 p/span/div/li/a 调 innerText 判断，在字节的简历页上（文件名会被 35 个
// 祖先节点同时"包含"）直接跑到 60 秒超时 —— 那可是要跑在用户页面上的代码，不能这么写。
// 文本节点遍历既便宜又精确：命中的 parentElement 就是承载文件名的那个叶子节点。
function findFileNameNodes(target) {
  if (!target || !document.body) return [];
  const out = [];
  try {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let tn;
    while ((tn = walker.nextNode())) {
      const v = tn.nodeValue;
      if (!v || v.indexOf(target) < 0) continue;
      const el = tn.parentElement;
      if (!el || out.indexOf(el) >= 0) continue;
      const tag = el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "TITLE" || tag === "NOSCRIPT") continue;
      if (isPluginOwnNode(el)) continue;
      // 确认它确实是「附件列表里的一条」，而不是描述框/说明文字里顺口提到的文件名
      let ancestorOk = false;
      let p = el;
      for (let i = 0; i < 5 && p; i++) {
        const cn = p.className;
        const cls = String((cn && cn.baseVal !== undefined ? cn.baseVal : cn) || "");
        if (UPLOAD_CTX_CLS_RE.test(cls)) { ancestorOk = true; break; }
        p = p.parentElement;
      }
      if (!ancestorOk && !UPLOAD_CTX_TEXT_RE.test(attachmentScopeText(el, target))) continue;
      out.push(el);
      if (out.length >= 12) break;
    }
  } catch (e) {}
  return out;
}

// 取「这一条附件自己的」文字范围。
// 为什么不能简单向上固定两层：附件列表里多份文件是并排的兄弟节点，往上两层很容易
// 窜到整个列表容器甚至 body —— 隔壁 portfolio 上传失败，就会把 resume 也判成失败
// （反过来同理，会把失败的当成成功）。所以向上扩张时定两条边界：
//   ① 文字长度别超过 200 字；② 一旦括进了**另一个文件名**，说明已经跨到别的附件了，立刻停。
function attachmentScopeText(node, target) {
  let box = node;
  // 用 textContent 而不是 innerText：innerText 会强制浏览器重排，
  // 在字节这种上千节点的 SPA 上逐个调用直接把页面卡死（live 实测探针 60s 超时）。
  let text = ((node.textContent || "") + "").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3 && box.parentElement; i++) {
    const p = box.parentElement;
    // 先用「便宜的结构特征」挡掉大容器，再去取文字。
    // 否则一旦向上摸到 <body>，textContent 会把整页（字节页里还塞着内联 JSON，好几 MB）
    // 拼成一个大字符串，只为了下一行判断它「太长了，不要」—— live 实测直接把探针拖到 60s 超时。
    // 这段代码是要跑在用户正在填的页面上的，不能有这种代价。
    const tag = p.tagName;
    if (tag === "BODY" || tag === "HTML" || tag === "MAIN" || tag === "FORM") break;
    if (p.children.length > 12) break;
    const t = ((p.textContent || "") + "").replace(/\s+/g, " ").trim();
    if (!t || t.length > 200) break;
    FILE_NAME_RE.lastIndex = 0;
    const others = (t.match(FILE_NAME_RE) || []).filter((f) => target.indexOf(f) < 0);
    if (others.length) break;
    box = p;
    text = t;
  }
  return text.slice(0, 300);
}

async function verifyUploadResult(fileName, waitMs, opts) {
  opts = opts || {};
  const target = String(fileName || "").trim();
  if (!target) return { ok: true, reason: "" };
  const probe = async (deadline) => {
    let lastCtx = "";
    let hiddenOnly = false;
    while (Date.now() < deadline) {
      await sleep(600);
      // 找到承载该文件名的最小节点（已排除插件自己的提示条），再看它所在的那一小块区域有没有失败文案
      const all = findFileNameNodes(target);
      if (!all.length) continue;
      // v0.7.1（#185）：只认「可见」的文件名节点。
      // 实测腾讯超限简历（7MB > 其 6MB 上限）：页面确实渲染了 <a class="el-upload-list__item-name">
      // 承载文件名，但整条是隐藏的（isVisible=0），正常成功的 3.1MB 简历则是可见的（=1）。
      // findFileNameNodes 不判可见性（去重上传那边需要连隐藏项一起匹配），
      // 所以这里必须自己过滤 —— 否则隐藏残留会被当成「上传成功」，
      // 造出最致命的「绿色已上传 + 空简历栏」。
      const nodes = all.filter(isVisible);
      if (!nodes.length) {
        hiddenOnly = true;
        try { lastCtx = attachmentScopeText(all[0], target); } catch (e) {}
        continue; // 可能还在渲染中，继续等；等不到可见节点就按失败处理
      }
      for (const n of nodes) {
        // 只看「这一条附件」的局部上下文，别扩散到整页/隔壁附件
        const ctx = attachmentScopeText(n, target);
        lastCtx = ctx;
        if (UPLOAD_FAIL_RE.test(ctx)) {
          const m = ctx.match(UPLOAD_FAIL_RE);
          return { ok: false, reason: (m && m[0]) || "上传失败", ctx: ctx.slice(0, 160) };
        }
      }
      // 文件名已出现且局部没有失败文案 → 判定成功
      return { ok: true, reason: "" };
    }
    // 等到超时都没看到文件名：多半没挂上去
    return {
      ok: false,
      reason: hiddenOnly ? "文件名节点存在但不可见（疑似被网站拒收）" : "页面未出现该文件",
      ctx: lastCtx.slice(0, 160),
    };
  };

  // v0.8.x（字节上传专项）：先判明确失败/成功，避免无条件死等拖慢整条填充。
  const first = await probe(Date.now() + (waitMs && waitMs > 0 ? waitMs : 9000));
  if (first.ok) return first; // 文件名已可见且无失败文案 → 立即成功返回（不再傻等）
  // 明确失败文案（上传失败/过大/格式不支持…）→ 立即返回，省去无谓复查
  if (first.reason && /失败|过大|不支持|错误|超出|拒绝|retry|failed|error/i.test(first.reason)) return first;
  if (!opts.recheck) return first;

  // 仅当「文件名未出现/不可见」（可能还在传）才做一次轻量复查；
  // 封顶 sleep≤6s + probe≤8s，彻底砍掉原先「4s+12s+15s≈31s」的死等（字节/大文件上传卡顿主因）。
  // 若复查期间文件名出现且无失败，probe 内会立即成功返回，不会真等满 8s。
  await sleep(Math.min(opts.recheckMs || 12000, 6000));
  const again = await probe(Date.now() + Math.min((opts.recheckMs2 || 15000), 8000));
  if (!again.ok) {
    return {
      ok: false,
      reason: again.reason === "页面未出现该文件" ? "上传后文件名消失（疑似被网站拒收）" : again.reason,
      ctx: again.ctx,
    };
  }
  return again;
}

// 各站点附件大小上限（字节）。美团实测：简历 10MB / 作品集 150MB；证件照页面未标注，按保守 5MB 兜底。
// v0.7.1：字节实测 9.4MB 的简历 PDF 会被拒（页面无任何限制文案），故字节的简历上限单独收紧到 8MB
// —— 这是「已知会失败」的经验值，宁可提前提醒用户压缩，也别让人以为传成功了。
// v0.7.1（#185）：取所有站点最严上限 = 腾讯简历 ≤6MB。统一把 resume 上限收到 6MB（原本 10MB），
// 这样字节(实测 9.4MB 被拒)与腾讯都按 6MB 预警，避免「看着没超 10MB 实则被站拒」的静默失败。
const SIZE_LIMITS = { resume: 6 * 1024 * 1024, photo: 300 * 1024, portfolio: 6 * 1024 * 1024 };
const SIZE_LIMIT_LABEL = { resume: "6MB(各站最低可接受)", photo: "300KB(腾讯最严)", portfolio: "6MB(保守下限)" };
const SIZE_LIMITS_BYTEDANCE = { resume: 8 * 1024 * 1024 };
// v0.7.1（#185）：腾讯页面明文写死简历「控制在6M以内」；个人照片页面亦标注「请选择 6M 以内的图片」。
// 故腾讯证件照上限统一按 6MB 处理（与用户 08-06 实测截图一致），不再用旧版 300KB 保守值。
const SIZE_LIMITS_TENCENT = { resume: 6 * 1024 * 1024, photo: 300 * 1024 };
function sizeLimitFor(cat) {
  try {
    if (/jobs\.bytedance\.com/i.test(location.hostname + location.pathname) && SIZE_LIMITS_BYTEDANCE[cat]) {
      return { limit: SIZE_LIMITS_BYTEDANCE[cat], label: "8MB(字节实测 9.4MB 被拒)" };
    }
    if (/join\.qq\.com|careers\.tencent\.com/i.test(location.hostname) && SIZE_LIMITS_TENCENT[cat]) {
      return {
        limit: SIZE_LIMITS_TENCENT[cat],
        label: cat === "photo" ? "300KB(腾讯最严)" : "6MB(腾讯页面明示)",
      };
    }
  } catch (e) {}
  return { limit: SIZE_LIMITS[cat], label: SIZE_LIMIT_LABEL[cat] || "" };
}

// v0.7.4（#204）：证件照超过站点上限时，自动压到上限内再注入。
// 腾讯照片 ≤6MB、通用 ≤6MB；超限不只提示，直接 resize+降质压到上限内，
// 杜绝「传上去才被拒」的静默失败。仅在浏览器环境运行（依赖 canvas/Image）。
async function compressPhotoToDataUrl(dataUrl, maxBytes) {
  try {
    const [meta, b64] = String(dataUrl || "").split(",");
    const mime = (meta.match(/:(.*?);/) || [, "image/jpeg"])[1] || "image/jpeg";
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const blob = new Blob([u8], { type: mime });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    URL.revokeObjectURL(url);
    let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const maxDim = 1200;
    if (w > maxDim || h > maxDim) { const r = Math.min(maxDim / w, maxDim / h); w = Math.round(w * r); h = Math.round(h * r); }
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    let q = 0.9;
    let out = await new Promise((res) => canvas.toBlob(res, "image/jpeg", q));
    while (out && out.size > maxBytes && q > 0.35) { q -= 0.08; out = await new Promise((res) => canvas.toBlob(res, "image/jpeg", q)); }
    if (!out) return dataUrl;
    return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(out); });
  } catch (e) {
    rfaLog({ act: "photo-compress-err", err: String((e && e.message) || e) });
    return dataUrl;
  }
}
async function handleFileUploads(items) {
  let manualNeeded = false;
  const usedInputs = new Set();
  items = filterMeituanUploads(items);
  // v0.7.1（#185）：整个上传过程全程挂 observer，任何站点、任何时间点弹出的
  // 「解析并覆盖」都会被自动点掉，不再只靠上传后那一小段轮询。
  try {
    if ((items || []).length) startParseOverlayObserver(120000);
  } catch (e) {}
  for (const it of items || []) {
    let v = it && it.data;
    if (!v) continue;
    // 大小上限预警：超过站点上限时记录并提示（不阻断，仍尝试传，便于验证边界）
    // v0.7.1：改走 sizeLimitFor()，字节的简历上限按实测收紧到 8MB
    const _sl = sizeLimitFor(it.cat);
    const _overLimit = !!(v.size && _sl.limit && v.size > _sl.limit);
    if (_overLimit) {
      rfaLog({ type: "size_over_limit", cat: it.cat, name: v.name, size: v.size, limit: _sl.limit });
      showToast(`⚠ ${v.name}（${(v.size / 1048576).toFixed(1)}MB）超过站点上限${_sl.label}，可能被网站拒绝`, "warn");
    }

    // 如果消息里没传 base64，但有 storageKey，就从 storage 读取分片
    if (!v.base64 && v.storageKey) {
      const loaded = await loadFragmentedFileForUpload(v.storageKey);
      v = Object.assign({}, v, { base64: loaded });
    }

    rfaLog({ type: "upload_item", cat: it.cat, name: v.name, size: v.size, hasBase64: !!v.base64 });

    // v0.6.80：同名附件已经在页面上了就别再传一遍（见 isAlreadyUploaded 注释里的重复上传事故）
    if (v.name && isAlreadyUploaded(v.name)) {
      rfaLog({ type: "upload_skip_dup", cat: it.cat, name: v.name });
      showToast(`${v.name} 已在页面上，跳过重复上传`, "ok");
      continue;
    }

    let input = findFileInputFor(it.cat, usedInputs, v.name, it.workIndex);
    // 简历/作品/视频都可能要先点「选择文件/上传简历/添加作品」按钮才渲染出 input[type=file]
    if (!input) {
      const opened = await tryOpenUploadArea(it.cat);
      if (opened) input = findFileInputFor(it.cat, usedInputs, v.name, it.workIndex);
    }
    if (!input) {
      rfaLog({ type: "upload_no_input", cat: it.cat, name: v.name });
      manualNeeded = true;
      continue;
    }
    // v0.6.80：multiple 的上传框能接多个附件（美团作品集 accept=.rar,.zip,.7z,.pdf + multiple）。
    // 传完一个就标记「已用」会让第 2~4 个文件找不到落点，直接退化成「需要手动上传」。
    // v0.7.4（#204）：证件照按站点上限自动压缩后再注入。
    if (it.cat === "photo") {
      const _psl = sizeLimitFor("photo");
      if (v.size && v.size > _psl.limit && v.base64) {
        showToast(`压缩证件照至${_psl.label}…`, "wait");
        try {
          const compressed = await compressPhotoToDataUrl(v.base64, _psl.limit);
          if (compressed && compressed !== v.base64) {
            v = Object.assign({}, v, { base64: compressed, compressed: true });
            rfaLog({ act: "photo-compress", name: v.name });
          }
        } catch (ce) { rfaLog({ act: "photo-compress-err", err: String(ce) }); }
      }
    }
    if (!input.multiple) usedInputs.add(input);
    if (v.manual) {
      simulateClick(findUploadTrigger(input));
      manualNeeded = true;
      showToast(`请在弹出的窗口中选择「${v.name}」`, "wait");
    } else if (v.base64) {
      const ok = await setFileInput(input, v.base64, v.name);
      if (ok) {
        rfaLog({ type: "upload_ok", cat: it.cat, name: v.name });
        showToast(`正在上传 ${v.name}…`, "wait");
        if (it.cat === "resume") await dismissParseOverlay();
        setTimeout(() => tryDismissFormatErrorOnce(), 300);
        setTimeout(() => tryDismissFormatErrorOnce(), 900);
        const vr = await verifyUploadResult(v.name, null, {
          recheck: true,
          recheckMs: 12000,
        });
        if (vr.ok) {
          showToast(`已上传 ${v.name}`, "ok");
          rfaLog({ type: "upload_verified", cat: it.cat, name: v.name });
        } else {
          manualNeeded = true;
          rfaLog({ type: "upload_verify_fail", cat: it.cat, name: v.name, size: v.size, reason: vr.reason, ctx: vr.ctx, inputCtx: (typeof buildFileContext === "function" && buildFileContext(input) ? buildFileContext(input).all : "").slice(0, 240) });
          if (_overLimit) {
            showToast(`⚠ ${v.name} 被网站拒绝（${(v.size / 1048576).toFixed(1)}MB，上限${_sl.label}），请压缩后手动上传`, "warn");
          } else {
            showToast(`⚠ ${v.name} 未上传成功（${vr.reason}），已为你打开选择框，请手动重传`, "warn");
            simulateClick(findUploadTrigger(input));
          }
        }
      } else {
        rfaLog({ type: "upload_fail", cat: it.cat, name: v.name });
        simulateClick(findUploadTrigger(input));
        manualNeeded = true;
      }
      if (input.multiple) await sleep(1200);
    } else {
      manualNeeded = true;
    }
  }
  return manualNeeded;
}

// 上传简历 PDF 后，招聘站常弹「要不要用附件内容覆盖下面已填的表单」提示：
//   蔚来：提示条「将简历内容解析到下方表单？」+「解析并覆盖」
//   美团：弹窗「是否需要对简历附件进行解析并填充下方简历内容」+「是 / 否」
// 一旦被解析覆盖，插件刚填好的内容就没了 → 统一自动点「取消 / 否 / 关闭」。
// v0.7.3（#200）：腾讯弹窗极多，文案五花八门。下面在原有「解析覆盖类」基础上，
// 增补腾讯常见的「附件/简历已上传→提示是否用附件内容填充/同步更新下方」等文案，
// 让 observer 能识别更多腾讯弹窗并自动点掉拒绝按钮（绝不错点蓝色「解析并覆盖」）。
// v0.7.5：补齐百度/京东/拼多多/Moka 系文案（用户 2026-08-07 铁律：弹窗必须先清场再填）。
//   百度：「解析填充并覆盖」「是否将简历解析结果填充至下方」
//   Moka/大疆：「检测到简历附件，是否自动填写」
//   京东/拼多多：「是否根据附件自动填写简历信息」「将覆盖当前已填写内容」
const PARSE_OVERLAY_TEXT_RE =
  /解析并覆盖|解析填充并覆盖|解析填充|解析到下方表单|解析结果填充|解析内容覆盖|将简历内容解析|对简历附件进行解析|解析并填充|附件进行解析|用附件内容填充|用附件填充下方|同步更新下方|覆盖下方表单|覆盖当前已填|覆盖已填写|覆盖原有内容|附件内容将填充|是否用附件|是否解析你的简历|简历解析|附件解析|自动填充下方|填充到下方表单|自动填写简历|根据附件自动填写|自动带入|智能填写|一键导入简历|导入简历信息|检测到简历附件/;

// 判断是不是「拒绝」按钮。注意：「否」是单字，必须精确匹配，
// 否则会被「是否需要…」这类含「否」的长文本骗到，反而点成确认。
// v0.6.88-fix：美团弹窗左侧按钮实际文案是「仅做附件上传」（没有「否」字），
// 必须把这类「仅做附件/仅上传/仅作为附件」也识别为拒绝解析。
function isDeclineButton(b) {
  const t = getText(b).trim();
  if (!t || t.length > 20) return false;
  // 以「否/不/取消/忽略/跳过/算了/暂不」开头的短按钮（排除含「是否」的说明文字）
  if (/^(否|不|取消|忽略|跳过|算了|暂不)([，,、；;：:\s].*)?$/i.test(t) && !/是否/.test(t)) return true;
  if (/^(否|不|不用|不要|不需要|暂不|暂不需要|取消|忽略|算了|跳过|以后再说|no)$/i.test(t)) return true;
  // 「暂不解析」「不需要解析」「取消解析」这类短语也放行，但排除任何含「是否」的说明文字
  if (/^(取消|忽略|暂不|不用|不需要|算了|跳过)/.test(t) && !/是否/.test(t)) return true;
  // 美团 2026-08 实测：弹窗按钮直接就是「仅做附件上传」，没有「否」前缀
  if (/仅做附件|仅上传附件|仅作为附件|只做附件|只上传|仅附件/i.test(t)) return true;
  return false;
}

// v0.7.4（#202）：腾讯上传后常弹「不支持当前格式」类提示（如 zip/特殊格式被拒）。
// 自动点「取消/知道/知道了/关闭」按钮关闭；绝不错点确认/解析键。
const FORMAT_ERR_TEXT_RE = /不支持当前格式|格式不支持|不支持该?格式|文件格式(不正确|错误)|类型不支持|当前格式(不支持|不被支持)/;
function tryDismissFormatErrorOnce() {
  try {
    const tips = Array.from(document.querySelectorAll("div,section,span,p,li"))
      .filter(isVisible)
      .filter((el) => { const t = getText(el); return t && t.length < 80 && FORMAT_ERR_TEXT_RE.test(t); });
    if (!tips.length) return false;
    tips.sort((a, b) => getText(a).length - getText(b).length);
    const el = tips[0];
    const container = findOverlayContainer(el) || el;
    const btns = Array.from(container.querySelectorAll("button,a,[role='button'],.btn,div[class*='button']")).filter(isVisible);
    const cancel = btns.find((b) => /^(取消|知道|知道了|关闭|暂不|no)$/i.test(getText(b).trim())) || btns.find(isDeclineButton);
    if (cancel) {
      simulateClick(cancel);
      showToast("已关闭格式提示弹窗", "ok");
      rfaLog({ act: "format-error-dismiss", text: getText(el) });
      return true;
    }
    rfaLog({ act: "format-error-no-cancel", text: getText(el) });
    return false;
  } catch (e) { return false; }
}

// 确认解析/覆盖的按钮。用于兜底：如果弹窗里有确认按钮，就点另一个非确认按钮。
function isConfirmButton(b) {
  const t = getText(b).trim();
  if (!t || t.length > 30) return false;
  if (/^(是|是的|确定|确认|OK|ok|同步更新|解析并覆盖|解析内容|覆盖|更新简历|继续)/i.test(t)) return true;
  if (/同步更新|解析并覆盖|解析内容|解析简历|覆盖简历|更新简历/i.test(t)) return true;
  return false;
}

// 找到包含 el 的弹窗/遮罩容器。
// v0.6.89 修复：美团弹窗是 .mtd-modal 包 .mtd-modal-body(文字) + .mtd-modal-footer(按钮)，
// 旧逻辑从提示文字往上爬遇到 .mtd-modal-body(类名含 modal)就停，但按钮在它的兄弟 footer 里，导致点不到。
// 新版收集所有候选弹窗容器，优先返回「同时包含可见按钮」的那个（即完整的 .mtd-modal），
// 否则返回最外层候选容器。绝不爬到 body 去扫页面常驻按钮。
function findOverlayContainer(el) {
  const candidates = [];
  let node = el;
  while (node && node !== document.body) {
    const role = node.getAttribute && node.getAttribute("role");
    const cls = (node.className || "").toString();
    const style = getComputedStyle(node);
    const isModal = role === "dialog" || role === "alertdialog"
      || /modal|dialog|overlay|mask|popover|popup|drawer/i.test(cls)
      || style.position === "fixed";
    if (isModal) candidates.push(node);
    node = node.parentElement;
  }
  if (!candidates.length) return null;
  // 优先：包含可见按钮（且文字非空）的弹窗容器 —— 说明这是真正包住「文字+按钮」的完整弹窗。
  const withBtn = candidates.find((c) => {
    const btns = c.querySelectorAll("button, a, [role='button'], .mtd-btn, .btn, div[class*='button']");
    return Array.from(btns).some((b) => isVisible(b) && getText(b).trim().length >= 1);
  });
  if (withBtn) return withBtn;
  // 否则返回最外层（最靠近根）的候选容器
  return candidates[candidates.length - 1];
}

function tryDismissParseOverlayOnce() {
  const tips = Array.from(document.querySelectorAll("div, section, span, p"))
    .filter(isVisible)
    .filter((el) => {
      const t = getText(el);
      return t && t.length < 120 && PARSE_OVERLAY_TEXT_RE.test(t);
    });
  if (!tips.length) return false;
  // 取文本最短的那个（最贴近提示语本身的节点，避免拿到整页容器）
  tips.sort((a, b) => getText(a).length - getText(b).length);
  const matchedTextEl = tips[0];
  // 关键：只在一个「弹窗/遮罩」容器里找按钮，绝不允许爬到 body 去扫页面常驻按钮。
  let container = findOverlayContainer(matchedTextEl);
  // 兜底：如果确实没有弹窗容器（如蔚来提示条），最多向上爬 3 层且不能到 body。
  if (!container) {
    container = matchedTextEl;
    for (let k = 0; k < 3 && container && container !== document.body; k++) {
      container = container.parentElement;
    }
    if (!container || container === document.body) container = matchedTextEl;
  }
  // 优先识别蔚来专用关闭图标（div.uploadResume-updateHint-close，无文字，原逻辑漏掉）
  const closeIcon = Array.from(container.querySelectorAll(".uploadResume-updateHint-close")).filter(isVisible);
  if (closeIcon.length) {
    simulateClick(closeIcon[0]);
    showToast("已自动关闭「解析并覆盖」提示，保留已填内容", "ok");
    return true;
  }
  // 其次识别「否 / 取消 / 暂不 / 仅做附件上传」等拒绝按钮
  let btns = Array.from(container.querySelectorAll("button, a, [role='button'], .mtd-btn, .btn, div[class*='button']"))
    .filter(isVisible)
    .filter(isDeclineButton);
  if (btns.length) {
    // 如果有多个拒绝按钮（理论上不应），优先点文本以「否/不/仅」开头的（真正的弹窗选项）。
    btns.sort((a, b) => {
      const ta = getText(a).trim();
      const tb = getText(b).trim();
      const aNo = /^(否|不|仅)/.test(ta) ? 0 : 1;
      const bNo = /^(否|不|仅)/.test(tb) ? 0 : 1;
      return aNo - bNo || ta.length - tb.length;
    });
    simulateClick(btns[0]);
    rfaLog({ act: "parse_overlay_declined", btn: getText(btns[0]).trim() });
    showToast("已自动拒绝简历附件解析覆盖，保留已填内容", "ok");
    return true;
  }

  // v0.6.88 兜底：若弹窗里存在明显的「确认/同步更新/解析并覆盖」按钮，
  // 则自动点击同容器内另一个可见按钮（即美团「仅做附件上传」白色按钮）。
  const allBtns = Array.from(container.querySelectorAll("button, a, [role='button'], .mtd-btn, .btn, div[class*='button']"))
    .filter(isVisible)
    .filter((el) => {
      const t = getText(el).trim();
      return t && t.length <= 30;
    });
  const confirmBtn = allBtns.find(isConfirmButton);
  if (confirmBtn && allBtns.length >= 2) {
    // v0.7.3（#200）：腾讯常有「双确认键」弹窗（如两个蓝色按钮），
    // 必须排除所有 isConfirmButton，只点真正非确认的按钮，绝不误点蓝色确认键。
    const other = allBtns.find((el) => el !== confirmBtn && !isConfirmButton(el));
    if (other) {
      simulateClick(other);
      rfaLog({ act: "parse_overlay_declined", btn: getText(other).trim(), fallback: "confirm-sibling" });
      showToast("已自动拒绝简历附件解析覆盖，保留已填内容", "ok");
      return true;
    }
  }
  return false;
}

// v0.7.1（#185）：轮询窗口从 6s 拉长到 20s。腾讯/美团的解析确认弹窗是等附件真正上传完
// （走完一次服务端请求）才弹的，6s 常常还没弹出来就退出了，等于没探测。
async function dismissParseOverlay() {
  if (tryDismissParseOverlayOnce()) return true;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (tryDismissParseOverlayOnce()) return true;
  }
  return false;
}

// v0.7.1（#185）：这个 observer 之前定义了却从来没人调用 —— 等于"反复探测"是空的。
// 现在在上传流程和 runAutofill 开始时都启动它，任何时间点冒出来的解析弹窗都会被点掉。
// ttlMs 后自动停，避免长期挂在页面上空转。
function startParseOverlayObserver(ttlMs) {
  if (window.__rfaParseOverlayObserver) {
    // 已在跑：顺延存活时间
    if (window.__rfaParseOverlayTimer) clearTimeout(window.__rfaParseOverlayTimer);
    window.__rfaParseOverlayTimer = setTimeout(stopParseOverlayObserver, ttlMs || 600000);
    return;
  }
  if (!document.body) return;
  let timer = null;
  const observer = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        // v0.7.5：observer 改走三档分诊清场（原来只处理「解析覆盖」一种，
        // 腾讯/百度那些格式提示、必填提醒弹窗全漏了，会挡住后续点击）。
        const n = sweepDialogsOnce();
        if (n) rfaLog({ type: "dialog_dismissed_by_observer", n });
      } catch (e) {}
    }, 200);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.__rfaParseOverlayObserver = observer;
  window.__rfaParseOverlayTimer = setTimeout(stopParseOverlayObserver, ttlMs || 600000);
  rfaLog({ type: "parse_overlay_observer_start", ttl: ttlMs || 600000 });
}

function stopParseOverlayObserver() {
  try {
    if (window.__rfaParseOverlayObserver) window.__rfaParseOverlayObserver.disconnect();
  } catch (e) {}
  window.__rfaParseOverlayObserver = null;
  if (window.__rfaParseOverlayTimer) clearTimeout(window.__rfaParseOverlayTimer);
  window.__rfaParseOverlayTimer = null;
}

/* ================= v0.7.5 弹窗三档分诊 + 清场门禁 =================
 * 用户 2026-08-07 铁律：
 *   1) 招聘站上传附件后普遍弹「要不要解析」，腾讯一次能弹三四个；
 *      插件必须自主按掉，不能留给用户。
 *   2) 弹窗没解决就不许往下填 —— 先清场，再填表。
 *   3) 【致命】绝不按按钮颜色判断。腾讯「解析并覆盖」正是蓝色主按钮，
 *      按颜色点就等于亲手清空刚填的内容。只按文字语义判断。
 *
 * 三档分诊：
 *   ①「危险弹窗」= 解析/覆盖/自动填写类 → 点拒绝键（否/取消/仅做附件上传/关闭）
 *   ②「安全提示」= 纯通知/格式错/大小超限/保存成功/必填提醒 → 点关闭键（知道了/确定/关闭）
 *   ③「未知弹窗」= 认不出来 → 不猜按钮，只尝试右上角 X 图标；仍关不掉就记日志标黄，
 *                  由清场门禁上报，绝不瞎点导致数据丢失。
 */
const DLG_SAFE_TEXT_RE =
  /不支持当前格式|格式不支持|不支持该?格式|文件格式(不正确|错误)|类型不支持|当前格式(不支持|不被支持)|文件(过大|太大|大小超出|超过)|大小不能超过|请选择\s*\d+\s*M|上传成功|保存成功|操作成功|提交成功|已保存|修改成功|温馨提示|系统提示|网络异常|请求失败|请稍后重试|加载失败|请完善|请先完善|不能为空|为必填|请填写|请选择|完善度|信息未填写完整|登录已过期/;

// 【新增 2026-08-08 · v0.8.8】引导选择弹窗：**必须选一个才能进入表单**，绝不能关掉。
// 美团 zhaopin.meituan.com 一进个人中心就弹「请选择你的求职状态 / 在校学生 / 职场人士」，
// 它的文案里带「请选择」，被上面的 DLG_SAFE_TEXT_RE 命中 → 旧代码按②安全档点了 X 关掉，
// 引导流程没走完，简历表单永远不渲染（rfaLog: form-never-appeared），美团长期挂 0%。
// 这类是**流程闸门**，判据是文案在问"你是谁/什么状态/什么身份"。
const DLG_ONBOARD_TEXT_RE =
  /求职状态|你的身份|您的身份|选择身份|当前身份|求职身份|应聘类型|你是(在校|应届)|投递类型|选择你的|选择您的/;
// 命中闸门后要选的那一项（测试人 = 2026 校招应届在校生）。
const DLG_ONBOARD_PICK_RE = /^(在校(生|学生)?|学生|校园招聘|校招|应届(生|毕业生)?|全日制在校生)$/;

// 未知弹窗兜底：只点这些「纯关闭」控件，绝不点任何有语义的文字按钮。
const DLG_CLOSE_SELECTORS = [
  ".ant-modal-close", ".ant-drawer-close", ".el-dialog__headerbtn", ".el-message-box__headerbtn",
  ".mtd-modal-close", ".arco-modal-close-btn", ".semi-modal-close", ".zent-dialog-r-close",
  ".uploadResume-updateHint-close", ".modal-close", ".dialog-close", ".popup-close",
  "[aria-label='Close']", "[aria-label='close']", "[aria-label='关闭']",
  ".close-icon", ".icon-close", ".close-btn",
].join(",");

function dlgLog(entry) {
  try {
    if (!window.__RFA_DIALOGS) window.__RFA_DIALOGS = [];
    window.__RFA_DIALOGS.push(Object.assign({ t: Date.now(), url: location.href.slice(0, 120) }, entry));
    rfaLog(Object.assign({ type: "dialog" }, entry));
  } catch (e) {}
}

// 找出页面上当前所有「可见弹窗容器」（含遮罩层、抽屉、气泡确认框）。
function findVisibleModals() {
  const sel = [
    "[role='dialog']", "[role='alertdialog']",
    ".ant-modal-wrap:not([style*='display: none'])", ".ant-modal-confirm", ".ant-popover:not(.ant-popover-hidden)",
    ".el-dialog__wrapper", ".el-message-box__wrapper", ".el-message-box",
    ".mtd-modal", ".mtd-modal-wrapper",
    ".arco-modal", ".semi-modal", ".zent-dialog-r",
    ".atsx-modal", ".atsx-drawer",
    "[class*='Modal_']", "[class*='modal-wrapper']", "[class*='dialog-wrapper']",
    "[class*='confirmModal']", "[class*='ConfirmModal']",
  ].join(",");
  let list = [];
  try { list = Array.from(document.querySelectorAll(sel)); } catch (e) { return []; }
  const out = [];
  for (const el of list) {
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 40) continue;
    // 去掉被别的候选包含的（只留最外层完整弹窗，避免同一个弹窗算两遍）
    if (out.some((o) => o.contains(el))) continue;
    for (let i = out.length - 1; i >= 0; i--) if (el.contains(out[i])) out.splice(i, 1);
    out.push(el);
  }
  return out;
}

// 在一个容器里找可见按钮（文字长度合理）
function dlgButtons(container) {
  const sel = "button, a[role='button'], [role='button'], .mtd-btn, .btn, .ant-btn, .el-button, .atsx-btn, div[class*='button'], span[class*='btn']";
  let btns = [];
  try { btns = Array.from(container.querySelectorAll(sel)); } catch (e) { return []; }
  return btns.filter((b) => {
    if (!isVisible(b)) return false;
    const t = getText(b).trim();
    if (!t || t.length > 30) return false;
    // 排除嵌套：如果它内部还有别的按钮，说明它是包装层
    try { if (b.querySelector(sel)) return false; } catch (e) {}
    return true;
  });
}

// 「安全关闭键」：用于②档纯提示弹窗。这类弹窗点确定不会毁数据。
function isSafeCloseButton(b) {
  const t = getText(b).trim();
  return /^(我?知道了?|好的?|确定|确认|关闭|返回|OK|ok|Got it|取消|我已知悉|继续填写)$/i.test(t);
}

// 分诊 + 处置单个弹窗。返回 'danger' | 'safe' | 'unknown-closed' | 'unknown-stuck' | null(没动)
function handleOneDialog(container) {
  let text = "";
  try { text = (getText(container) || "").replace(/\s+/g, " ").slice(0, 200); } catch (e) {}
  if (!text) return null;
  const btns = dlgButtons(container);
  const btnTexts = btns.map((b) => getText(b).trim());

  // 【保护】Moka/大疆等站点的「个人信息编辑抽屉」也是 drawer/modal 结构。
  // 用户 2026-08-07 铁律：右上角编辑抽屉交给用户自己，插件不点开、也绝不替他关掉。
  // 判据：容器里有 ≥2 个可见输入控件 = 这是一张表单，不是提示弹窗。
  let inputCount = 0;
  try {
    inputCount = Array.from(container.querySelectorAll("input:not([type=hidden]):not([type=file]),textarea,select"))
      .filter(isVisible).length;
  } catch (e) {}
  const isFormDrawer = inputCount >= 2;

  // ===== ① 危险档：解析/覆盖/自动填写 → 必须点拒绝 =====
  if (PARSE_OVERLAY_TEXT_RE.test(text)) {
    // a. 蔚来式无文字关闭图标
    const icon = Array.from(container.querySelectorAll(".uploadResume-updateHint-close")).filter(isVisible)[0];
    if (icon) { simulateClick(icon); dlgLog({ tier: "danger", act: "close-icon", text: text.slice(0, 80) }); return "danger"; }
    // b. 明确拒绝键
    const decline = btns.filter(isDeclineButton).sort((a, b) => {
      const ta = getText(a).trim(), tb = getText(b).trim();
      return (/^(否|不|仅)/.test(ta) ? 0 : 1) - (/^(否|不|仅)/.test(tb) ? 0 : 1) || ta.length - tb.length;
    })[0];
    if (decline) {
      simulateClick(decline);
      dlgLog({ tier: "danger", act: "decline", btn: getText(decline).trim(), all: btnTexts, text: text.slice(0, 80) });
      showToast("已自动拒绝简历解析覆盖，保留已填内容", "ok");
      return "danger";
    }
    // c. 只有确认键 + 另一个非确认键 → 点非确认那个（按语义，不看颜色）
    const confirmBtn = btns.find(isConfirmButton);
    if (confirmBtn && btns.length >= 2) {
      const other = btns.find((el) => el !== confirmBtn && !isConfirmButton(el));
      if (other) {
        simulateClick(other);
        dlgLog({ tier: "danger", act: "confirm-sibling", btn: getText(other).trim(), all: btnTexts });
        return "danger";
      }
    }
    // d. 全都是确认键 → 宁可点 X 也不点确认
    const x = Array.from(container.querySelectorAll(DLG_CLOSE_SELECTORS)).filter(isVisible)[0];
    if (x) { simulateClick(x); dlgLog({ tier: "danger", act: "x-icon", all: btnTexts }); return "danger"; }
    dlgLog({ tier: "danger", act: "STUCK", all: btnTexts, text: text.slice(0, 120) });
    return "unknown-stuck";
  }

  // 表单抽屉（用户自己开的编辑面板）到此为止：只记录，不动它。
  if (isFormDrawer) {
    if (!window.__rfaDrawerLogged) {
      window.__rfaDrawerLogged = true;
      dlgLog({ tier: "form-drawer", act: "skip", inputs: inputCount, text: text.slice(0, 80) });
    }
    return null;
  }

  // ===== ①.5 引导闸门档：必须选一个才能进入表单，绝不能关掉 =====
  // 必须排在②安全档**之前**：美团文案含「请选择」会被安全档抢走然后点 X 关掉。
  if (DLG_ONBOARD_TEXT_RE.test(text)) {
    // 选项常常不是 <button> 而是可点的卡片 div / label，所以放宽扫描范围；
    // 只收文字很短的叶子节点，避免选到「包住整块」的父容器。
    let cands = [];
    try {
      cands = Array.from(container.querySelectorAll("button,div,li,label,span,a,[role=button]"))
        .filter(function (el) {
          if (!isVisible(el)) return false;
          const t = (getText(el) || "").replace(/\s+/g, "").trim();
          return t.length >= 2 && t.length <= 10 && DLG_ONBOARD_PICK_RE.test(t);
        });
    } catch (e) {}
    // 文字最短 = 最贴近真正的可点选项
    const pick = cands.sort(
      (a, b) => (getText(a) || "").trim().length - (getText(b) || "").trim().length
    )[0];
    if (pick) {
      simulateClick(pick);
      dlgLog({ tier: "onboard", act: "select", btn: getText(pick).trim(), all: btnTexts, text: text.slice(0, 80) });
      // 有的站选完还要再点一次「确定/下一步」才真正进去
      setTimeout(function () {
        try {
          const c = dlgButtons(container).filter(isVisible).find(function (b) {
            return /^(确定|确认|下一步|开始|进入|完成|提交)$/.test((getText(b) || "").trim());
          });
          if (c) simulateClick(c);
        } catch (e) {}
      }, 500);
      return "safe";
    }
    dlgLog({ tier: "onboard", act: "no-match", all: btnTexts, text: text.slice(0, 120) });
  }

  // ===== ② 安全档：纯提示/格式错/大小超限/必填提醒 → 点关闭 =====
  if (DLG_SAFE_TEXT_RE.test(text)) {
    const safe = btns.filter(isSafeCloseButton)
      .sort((a, b) => {
        // 优先「知道了/好的/关闭」，其次「确定」，最后「取消」
        const rank = (s) => (/^(我?知道了?|好的?|关闭|Got it|OK|ok)$/i.test(s) ? 0 : /^(确定|确认)$/.test(s) ? 1 : 2);
        return rank(getText(a).trim()) - rank(getText(b).trim());
      })[0];
    if (safe) {
      simulateClick(safe);
      dlgLog({ tier: "safe", act: "close", btn: getText(safe).trim(), all: btnTexts, text: text.slice(0, 80) });
      return "safe";
    }
    const x = Array.from(container.querySelectorAll(DLG_CLOSE_SELECTORS)).filter(isVisible)[0];
    if (x) { simulateClick(x); dlgLog({ tier: "safe", act: "x-icon", text: text.slice(0, 80) }); return "safe"; }
  }

  // ===== ③ 未知档：不猜按钮，只点 X =====
  // 排除「插件自己的面板 / 页面本来就有的下拉面板」这类误报
  if (/一键填充|简历自动填充|RFA/.test(text)) return null;
  const x = Array.from(container.querySelectorAll(DLG_CLOSE_SELECTORS)).filter(isVisible)[0];
  if (x) {
    simulateClick(x);
    dlgLog({ tier: "unknown", act: "x-icon", all: btnTexts, text: text.slice(0, 120) });
    return "unknown-closed";
  }
  dlgLog({ tier: "unknown", act: "STUCK", all: btnTexts, text: text.slice(0, 160) });
  return "unknown-stuck";
}

// 扫一遍页面所有弹窗并处置。返回处置数量。
function sweepDialogsOnce() {
  let n = 0;
  try {
    // 先用老的文本匹配路径兜住「非标准弹窗」（蔚来提示条、内联提示）
    if (tryDismissParseOverlayOnce()) n++;
    if (tryDismissFormatErrorOnce()) n++;
    const modals = findVisibleModals();
    for (const m of modals) {
      const r = handleOneDialog(m);
      if (r && r !== "unknown-stuck") n++;
    }
  } catch (e) { dlgLog({ act: "sweep-error", error: String(e) }); }
  return n;
}

// 【清场门禁】开跑前 / 关键步骤前调用：反复清弹窗，直到页面上没有可见弹窗为止。
// 返回 { clean:true } 或 { clean:false, stuck:[...] }，卡住的弹窗会被上报，绝不装作没看见。
// ===== v0.7.6（#258）清理「多余空白卡片」=====
// 【为什么需要】腾讯这类页面会**自动保存草稿**：插件每跑一次，若判定「档案有 N 条经历、
// 页面只有 M 张卡片」就点一次「添加」，多出来的卡片刷新后依然在。几轮下来页面上堆满
// 空白卡片（实测教育经历堆到 3 张、项目经历 4 张、作品集 4 组），字段总数从 88 一路涨到 113，
// 用户看到的就是「一大片空白」。所以填完后必须把纯空白的多余卡片删掉。
// 【安全红线】① 只删「卡片内所有可见输入框全空」的；② 卡片里只要出现文件名/链接/标签
// （已上传附件、已选下拉）一律不动；③ 每个区块至少保留 1 张卡片；④ 只点卡片内的
// 「删除xx」按钮，绝不碰提交/投递。
const CARD_DEL_RE = /^(删除|移除|delete|remove)\s*(该|此|本|这)?\s*(学历|教育|经历|经验|项目|获奖|奖项|论文|作品|证书|技能|记录|信息|条目|一栏|项)?$/i;
const CARD_FILE_RE = /[\w\u4e00-\u9fa5\-()（）]+\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|jpe?g|png|gif|webp|mp4|mov|avi|mp3)\b/i;

function rfaCardOf(btn) {
  let n = btn, hop = 0, best = null;
  while (n && n !== document.body && hop < 10) {
    n = n.parentElement; hop++;
    if (!n) break;
    let inputs = [];
    try {
      inputs = Array.from(n.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]),textarea"))
        .filter(isVisible);
    } catch (e) {}
    if (inputs.length < 2) continue;
    // 这个容器里必须只有 1 个删除按钮，否则说明已经爬到「整个区块」了（会一次删掉多张卡片）
    let dels = [];
    try {
      dels = Array.from(n.querySelectorAll("button,a,span,div,i,em")).filter(
        (x) => isVisible(x) && CARD_DEL_RE.test(getText(x).trim())
      ).filter((x) => !Array.from(x.querySelectorAll("*")).some((c) => CARD_DEL_RE.test(getText(c).trim())));
    } catch (e) {}
    if (dels.length > 1) break;
    best = n;
    break;
  }
  return best;
}

function rfaCardIsEmpty(card) {
  if (!card) return false;
  let inputs = [];
  try {
    inputs = Array.from(card.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]),textarea"))
      .filter(isVisible);
  } catch (e) { return false; }
  if (inputs.length < 2) return false;
  if (inputs.some((i) => (i.value || "").trim())) return false;
  // 已选中的下拉标签 / 单选多选选中态 → 不算空
  try {
    if (card.querySelector(".el-tag, .ant-select-selection-item, [class*='tag__text']")) return false;
    if (card.querySelector("input[type=radio]:checked, input[type=checkbox]:checked")) return false;
    if (card.querySelector(".is-checked, .is-active[class*='radio'], [aria-checked='true']")) return false;
  } catch (e) {}
  // 出现文件名或外链 → 里面有已上传的附件，绝不能删
  const txt = getText(card) || "";
  if (CARD_FILE_RE.test(txt)) return false;
  try { if (card.querySelector("a[href^='http'], img[src^='http'], img[src^='blob']")) return false; } catch (e) {}
  return true;
}

// 删除确认框：这里必须点「确定」——和「解析并覆盖」类弹窗的处理**方向相反**，
// 所以单独写一个，不复用 clearBlockingDialogs（那个专门点「否/取消」）。
async function confirmCardDeleteDialog() {
  for (let i = 0; i < 6; i++) {
    let modals = [];
    try { modals = findVisibleModals(); } catch (e) { modals = []; }
    const dlg = modals.find((m) => {
      const t = (getText(m) || "").trim();
      return t && t.length < 200 && /删除|移除|确认.*删|删.*确认/.test(t) && !/解析|覆盖|上传/.test(t);
    });
    if (!dlg) return i > 0;
    const btns = Array.from(dlg.querySelectorAll("button,a,[role='button'],.btn,div[class*='button']")).filter(isVisible);
    const yes = btns.find((b) => /^(确定|确认|是|删除|ok|yes)$/i.test(getText(b).trim()));
    if (!yes) return false;
    simulateClick(yes);
    await sleep(450);
  }
  return true;
}

async function cleanupEmptyRepeatCards(maxRounds) {
  const rounds = maxRounds || 15;
  let removed = 0;
  for (let r = 0; r < rounds; r++) {
    let btns = [];
    try {
      btns = Array.from(document.querySelectorAll("button,a,span,div,i,em")).filter((b) => {
        if (!isVisible(b)) return false;
        const t = getText(b).trim();
        if (!t || t.length > 8 || !CARD_DEL_RE.test(t)) return false;
        // 只要最内层那个元素，避免把包着它的父容器也当按钮
        return !Array.from(b.querySelectorAll("*")).some((c) => CARD_DEL_RE.test(getText(c).trim()));
      });
    } catch (e) { break; }
    let target = null;
    for (const b of btns) {
      const card = rfaCardOf(b);
      if (card && rfaCardIsEmpty(card)) { target = { b: b, card: card }; break; }
    }
    if (!target) break;
    const label = getText(target.b).trim();
    try { simulateClick(target.b); } catch (e) { break; }
    await sleep(550);
    try { await confirmCardDeleteDialog(); } catch (e) {}
    await sleep(400);
    removed++;
    rfaLog({ act: "cleanup-empty-card", n: removed, btn: label });
  }
  if (removed) {
    rfaLog({ act: "cleanup-done", removed: removed });
    try { showToast("已清掉 " + removed + " 张空白卡片", "ok"); } catch (e) {}
  }
  return removed;
}

async function clearBlockingDialogs(maxRounds) {
  const rounds = maxRounds || 12;
  for (let i = 0; i < rounds; i++) {
    const modals = findVisibleModals().filter((m) => {
      const t = (getText(m) || "").trim();
      if (!t || /一键填充|简历自动填充|RFA/.test(t)) return false;
      // 表单抽屉（用户自己打开的编辑面板）不算「挡路弹窗」，不清也不算卡住
      let n = 0;
      try { n = Array.from(m.querySelectorAll("input:not([type=hidden]):not([type=file]),textarea,select")).filter(isVisible).length; } catch (e) {}
      return n < 2;
    });
    const inlineTip = (() => {
      try {
        return Array.from(document.querySelectorAll("div,section,span,p")).filter(isVisible)
          .some((el) => { const t = getText(el); return t && t.length < 120 && PARSE_OVERLAY_TEXT_RE.test(t); });
      } catch (e) { return false; }
    })();
    if (!modals.length && !inlineTip) {
      if (i > 0) dlgLog({ act: "gate-clean", rounds: i });
      return { clean: true, rounds: i };
    }
    sweepDialogsOnce();
    await sleep(450);
  }
  const left = findVisibleModals()
    .filter((m) => { const t = (getText(m) || "").trim(); return t && !/一键填充|简历自动填充|RFA/.test(t); })
    .map((m) => (getText(m) || "").replace(/\s+/g, " ").slice(0, 120));
  if (left.length) {
    dlgLog({ act: "gate-STUCK", left });
    showToast("有弹窗没能自动关闭，已记录（不影响继续填充）", "warn");
    return { clean: false, stuck: left };
  }
  return { clean: true, rounds };
}

// 简历/作品/视频板块都可能要先点「选择文件/上传/添加」按钮才出现 input[type=file]：
// 尝试点击并等待渲染。蔚来等招聘网站用自定义按钮（class 含 atsx-btn uploadPlaceholder-selectFile），
// 点击后才会触发系统文件对话框，所以也要识别。
async function tryOpenUploadArea(cat) {
  let keywords;
  if (cat === "video") {
    keywords = /视频|video|短片|demo|上传视频/;
  } else if (cat === "resume") {
    keywords = /选择文件|上传简历|添加简历|简历上传|简历附件|上传附件|import resume|resume upload|选择简历|上传.*简历|简历.*上传/;
  } else if (cat === "avatar") {
    keywords = /照片|头像|证件照|个人照片|avatar|photo|选择文件/;
  } else {
    keywords = /选择文件|添加作品|新增作品|作品集|作品上传|上传作品|添加附件|作品|portfolio|attachment/;
  }
  const candidates = Array.from(document.querySelectorAll("button, a, div, span, [role='button']"))
    .filter(isRealAddButton)
    .filter((el) => {
      const t = getText(el);
      return t && keywords.test(t) && t.length < 20;
    })
    .filter((el) => isVisible(el));
  // 取最靠下的（简历/作品板块通常在页面下方或侧边抽屉）
  if (!candidates.length) return false;
  candidates.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
  const target = candidates[0];
  // 若按钮自身/后代已包含 input[type=file]，无需点击
  if (target.querySelector("input[type=file]")) return true;
  simulateClick(target);
  // 等上传框渲染（最多约 2.4s）
  for (let i = 0; i < 6; i++) {
    await sleep(400);
    if (document.querySelectorAll("input[type=file]").length) return true;
  }
  return true;
}

// 渲染未填字段面板（页面右侧，可点击跳转）
function renderUnfilledPanel(list) {
  let panel = document.getElementById("rf-unfilled-panel");
  if (panel) panel.remove();
  if (!list.length) return;
  panel = document.createElement("div");
  panel.id = "rf-unfilled-panel";
  panel.style.cssText =
    "position:fixed;top:80px;right:12px;width:200px;max-height:70vh;overflow:auto;background:#fff;" +
    "border:1px solid #e5e6eb;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.12);z-index:2147483646;" +
    "font-family:-apple-system,'PingFang SC',sans-serif;font-size:12px;color:#1f2329;padding:10px;";
  const title = document.createElement("div");
  title.style.cssText = "font-weight:600;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;";
  title.innerHTML = `<span>未填字段（${list.length}）</span><span id="rf-unfilled-close" style="cursor:pointer;color:#999;">收起</span>`;
  panel.appendChild(title);
  list.forEach((item) => {
    const chip = document.createElement("div");
    chip.textContent = "○ " + (item.label || "字段");
    chip.style.cssText =
      "padding:5px 7px;margin-bottom:5px;border-radius:6px;background:#FAEEDA;color:#633806;cursor:pointer;";
    chip.addEventListener("click", () => {
      if (String(item.idx).startsWith("file-")) {
        showToast("请在上传框选择：" + item.label, "wait");
        const cat = item.idx.replace("file-", "");
        const inp = findFileInputFor(cat);
        if (inp) simulateClick(inp);
        return;
      }
      const el = document.querySelector(`[${ATTR}="${item.idx}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const oldShadow = el.style.getPropertyValue("box-shadow");
      el.style.setProperty("box-shadow", "0 0 0 2px #EF9F27", "important");
      setTimeout(() => {
        el.style.setProperty("box-shadow", oldShadow, oldShadow ? "important" : "");
      }, 1600);
      if (el.focus) el.focus({ preventScroll: true });
    });
    panel.appendChild(chip);
  });
  document.body.appendChild(panel);
  const close = panel.querySelector("#rf-unfilled-close");
  if (close) close.addEventListener("click", () => panel.remove());
}

// 收集未填字段
function buildUnfilledPanel(fields, filledIdx, vault) {
  const list = [];
  // v0.6.51：兜底扫描 DOM，不依赖 scanFields 的 fields/idx，避免漏扫导致未填面板缺字段。
  getEmptyFillableEls().forEach((el) => {
    const label = getLabel(el) || "字段";
    list.push({ idx: el.getAttribute(ATTR) || "x", label });
  });
  const vaultObj = vault || {};
  Object.keys(vaultObj).forEach((cat) => {
    const v = vaultObj[cat];
    if (v && v.manual) list.push({ idx: "file-" + cat, label: "手动上传：" + v.name });
  });
  renderUnfilledPanel(list);
  return list;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "exportFields") {
    exportFields()
      .then((res) => sendResponse(res))
      .catch((e) => sendResponse({ error: String(e) }));
    return true; // 异步响应（展开下拉框抓选项需要时间）
  }
  if (msg.action === "openPanel") {
    openFloatPanel();
    sendResponse({ ok: true });
    return;
  }
  if (msg.action === "autofill") {
    // v0.8.13：区号来源优先级 = 档案 basic.phoneCc（面板「手机号」拆格里选的，随简历版本走）
    //                                 > 旧版全局 rfa_phone_cc（兼容历史设置）> 无（铁律：档案没有就不动站点区号下拉）。
    // 先同步读出再开始填充——区号下拉逻辑需要同步读取（RFA_USER_PHONE_CC），不能边填边异步等 storage。
    const fromProfile = (msg.profile && msg.profile.basic && msg.profile.basic.phoneCc) || "";
    chrome.storage.local.get("rfa_phone_cc", (r) => {
      RFA_USER_PHONE_CC = fromProfile || (r && r.rfa_phone_cc) || "";
      runAutofill(msg.profile, msg.fileVault || {}, msg.options || {}, msg.works || [])
        .then((res) => sendResponse(res))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
    });
    return true; // async
  }
  if (msg.action === "clearPage") {
    const r = clearCurrentPageForm();
    sendResponse(r);
    return;
  }
});

// 网页表单一键清空：清空当前招聘页所有可填文本/下拉/单选/多选/日期，触发 input/change 事件；
// 文件上传里：简历/证件照由插件 fileVault 管理、且页面 file input 无法程序清空，故保留；
// 但「作品集」上传文件必须一并清除（用户铁律：除简历/证件照外一键消除，作品集也要消）。
function removeUploadedPortfolioFiles() {
  // 各站「已上传文件列表项」类名各异，用通用选择器一次性抓全
  const listItems = document.querySelectorAll(
    ".mtd-upload-list-item, [class*='upload_sample_reel'] li, [class*='attachment'] li, " +
    "[class*='upload-list'] li, [class*='upload'] [class*='file-name'], [class*='upload'] [class*='fileName'], " +
    ".el-upload-list__item, [class*='uploadItem'], [class*='fileItem'], [class*='file-item']"
  );
  let removed = 0;
  listItems.forEach((item) => {
    // 上下文 = 该项自身 + 向上 8 层祖先的 文本/类名
    let ctx = "", node = item;
    for (let i = 0; i < 8 && node; i++) {
      ctx += (node.innerText || "") + " " + (typeof node.className === "string" ? node.className : "");
      node = node.parentElement;
    }
    const isResume = /简历|resume|证件照|头像|avatar|photo/i.test(ctx);
    const isPortfolio = /作品|portfolio|附件|attachment/i.test(ctx);
    if (isResume || !isPortfolio) return; // 简历/证件照 或 拿不准 → 一律保留，绝不误删
    // 找该项的删除/移除按钮（图标或文字）
    const delBtn =
      item.querySelector("[class*='delete' i],[class*='remove' i]") ||
      Array.from(item.querySelectorAll("button,i,span,a,[role='button']")).find((b) => {
        const t = (b.getAttribute ? (b.getAttribute("class") || b.getAttribute("title") || "") : "") + " " + (b.innerText || "");
        return /delete|remove|删除|移除/i.test(t);
      });
    if (delBtn) { try { delBtn.click(); removed++; } catch (e) {} }
  });
  return removed;
}

function clearCurrentPageForm() {
  try {
    const els = document.querySelectorAll("input, textarea, select");
    let n = 0;
    els.forEach((el) => {
      const t = (el.tagName || "").toLowerCase();
      if (t === "input") {
        const it = (el.type || "text").toLowerCase();
        if (["text", "email", "tel", "url", "number", "search", "password", "date", "month", "week", "time"].includes(it)) {
          if (el.value) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); n++; }
        } else if (it === "radio" || it === "checkbox") {
          if (el.checked) { el.checked = false; el.dispatchEvent(new Event("change", { bubbles: true })); n++; }
        }
      } else if (t === "textarea") {
        if (el.value) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); n++; }
      } else if (t === "select") {
        if (el.selectedIndex > 0 || (el.value && el.value !== "")) {
          try { el.selectedIndex = 0; } catch (e) {}
          el.value = "";
          el.dispatchEvent(new Event("change", { bubbles: true }));
          n++;
        }
      }
    });
    // 作品集上传文件一并清除（简历/证件照按用户要求保留）
    let pf = 0;
    try { pf = removeUploadedPortfolioFiles(); } catch (e) {}
    if (pf) { rfaLog({ act: "clear-page-portfolio", count: pf }); }
    rfaLog({ act: "clear-page", count: n });
    try {
      const extra = pf ? `，已移除 ${pf} 个作品集附件` : "";
      showToast(`已清空网页表单 ${n} 个字段${extra}`, "ok");
    } catch (e) {}
    return { ok: true, count: n, portfolioRemoved: pf };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ================= 填充完成覆盖层（后台也能保证用户切回标签时看到）+ 短促提示音 ================= */
function showDoneOverlay(filled, total, unfilled) {
  try {
    const id = "rfa-done-overlay";
    if (document.getElementById(id)) return;
    const ov = document.createElement("div");
    ov.id = id;
    ov.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);" +
      "display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;";
    const unfilledHtml = unfilled
      ? `，还有 <b style="color:#d97706;">${unfilled}</b> 个需你确认 / 手动填`
      : "，未填字段均已标黄";
    ov.innerHTML =
      '<div style="background:#fff;border-radius:16px;max-width:420px;width:86%;padding:28px 26px;' +
      'box-shadow:0 20px 60px rgba(0,0,0,.35);text-align:center;">' +
      '<div style="font-size:46px;line-height:1;margin-bottom:8px;">✅</div>' +
      '<div style="font-size:20px;font-weight:700;color:#1a1a1a;margin-bottom:6px;">美团简历已填充完成</div>' +
      `<div style="font-size:14px;color:#555;margin-bottom:14px;">已填 <b style="color:#16a34a;">${filled}</b> / ${total} 个字段${unfilledHtml}。请检查后再提交。</div>` +
      '<button id="rfa-done-ok" style="margin-top:6px;background:#7c5cff;color:#fff;border:0;border-radius:10px;' +
      'padding:11px 30px;font-size:15px;font-weight:600;cursor:pointer;">我知道了，去验收</button>' +
      "</div>";
    document.documentElement.appendChild(ov);
    const close = () => {
      try { ov.remove(); } catch (e) {}
    };
    ov.querySelector("#rfa-done-ok").addEventListener("click", function () {
      // 通知「我的进程」停止 afplay 响铃（跨世界共享 DOM 属性，进程侧 CDP 轮询读取）
      try { document.documentElement.setAttribute("data-rfa-ack", "1"); } catch (e) {}
      close();
    });
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    // 提示音由「我的进程 afplay 循环」负责（绕过浏览器自动播放限制，离开也响）；
    // 用户点「我知道了」→ 置 data-rfa-ack → 我的进程停止响铃。
  } catch (e) {}
}

/* ================= 一键投递核心（popup 弹窗与页面悬浮按钮共用） ================= */
// ── v0.8.0（#264）：拼多多只读展示页 → 点「编辑」原地展开成可填表单 ──────────────
// 只对 careers.pddglobalhr.com 生效，其它站一律不碰「编辑」入口（用户铁律：抽屉不点）。
// 拼多多是用户明确点名破例的唯一一站。
async function expandPddInlineEdit() {
  try {
    if (!/pddglobalhr\.com/i.test(location.hostname)) return false;
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const countInputs = () =>
      Array.from(document.querySelectorAll("input,textarea,select")).filter(visible).length;

    const before = countInputs();
    // 已经是展开态（十几个输入框）就不用再点
    if (before >= 8) {
      rfaLog({ act: "pdd-inline-edit", state: "already-open", inputs: before });
      return true;
    }

    let clicked = 0;
    // 1) 首选：基本信息卡片右上角的编辑图标（class 带构建 hash，用前缀匹配）
    const editEls = Array.from(
      document.querySelectorAll('[class*="index_edit__"], [class*="index_btn__"]')
    ).filter(visible);
    for (const el of editEls) {
      ["pointerdown", "mousedown", "mouseup", "click"].forEach((t) =>
        el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))
      );
      clicked++;
      if (clicked >= 2) break;
    }

    // 2) 兜底：按文字找「编辑」
    if (!clicked) {
      const all = Array.from(document.querySelectorAll("div,span,button,a"));
      for (const el of all) {
        if (el.children.length > 1) continue;
        const t = (el.innerText || "").trim();
        if (t !== "编辑" && t !== "编辑资料" && t !== "编辑个人信息") continue;
        if (!visible(el)) continue;
        ["pointerdown", "mousedown", "mouseup", "click"].forEach((tt) =>
          el.dispatchEvent(new MouseEvent(tt, { bubbles: true, cancelable: true, view: window }))
        );
        clicked++;
        break;
      }
    }

    // 等表单渲染出来（最多 6 秒）
    let after = before;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 500));
      after = countInputs();
      if (after >= 8) break;
    }
    rfaLog({ act: "pdd-inline-edit", clicked, inputsBefore: before, inputsAfter: after });
    return after > before;
  } catch (e) {
    rfaLog({ act: "pdd-inline-edit", err: String(e && e.message) });
    return false;
  }
}

// ── 2026-08-11 拼多多专用板块展开（#PDD）：拼多多 careers.pddglobalhr.com 的各板块
//  「添加」按钮是 span/DIV（class 形如 wrapper-education-experience_addBtn / ant-btn），
//  且整页没有 applyFormModuleWrapper 容器，所以通用的 expandWrapperArraySection 在拼多多上
//  wrappers.length===0 直接 return，selfEval/social 等分支根本没展开 → 拼多多永远停在 15 框。
//  实测（CDP 探针）用「按文字精确点击」能稳定把字段从 15 → 93（24 输入框 + 69 下拉），
//  故这里独立实现拼多多展开逻辑，不依赖通用器。
//  注意：拼多多 education 板块点「添加教育经历」会展开整张教育卡（含多字段），
//  languages 板块点「添加语言能力」展开语言卡，selfEval/social 点一次即可。
async function expandPddCards(profile) {
  try {
    if (!/pddglobalhr\.com/i.test(location.hostname)) return false;
    const P = profile || {};
    const vis = (el) => el && el.offsetParent !== null;
    const clickByText = (txt) => {
      const els = Array.from(document.querySelectorAll("*")).filter(
        (e) => (e.textContent || "").replace(/\s+/g, "").trim() === txt && vis(e)
      );
      if (!els.length) return "NO_EL:" + txt;
      els.slice(0, 1).forEach((el) =>
        ["pointerdown", "mousedown", "mouseup", "click"].forEach((t) =>
          el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))
        )
      );
      return "ok:" + txt;
    };
    const seen = new Set();
    const plan = [];
    if ((P.education || []).length) plan.push("添加教育经历");
    if ((P.languages || []).length) plan.push("添加语言能力");
    if ((P.selfEval || "").trim() || (P.awards || []).length) plan.push("添加自我评价");
    if ((P.social || []).length) plan.push("添加社交账号");
    const log = [];
    for (const t of plan) {
      if (seen.has(t)) continue;
      seen.add(t);
      log.push(clickByText(t));
      await sleep(700);
    }
    rfaLog({ act: "pdd-cards-expand", plan, log });
    return true;
  } catch (e) {
    rfaLog({ act: "pdd-cards-expand-err", err: String(e && e.message) });
    return false;
  }
}

// ── v0.8.3（#266）：京东校招简历页 → 各板块是「空卡 + 添加」，不点就没有输入框 ──
// campus.jd.com/#/resume 结构：
//   · 「基本信息」默认展开（11 个可见框）
//   · 「教育经历 / 实习经历 / 校园经历 / 其他信息(获奖·技能·证书·论文·专利)」全是空壳，
//     每块各有一个 <a class="am-button addBtn___xxx">+ 添加</a>，点了才 inline 生成整张表单卡。
// 不点 → 插件只能看见基本信息那 11 格（实测 2/11 = 18%）。点完 8 个 → 47 个可填框。
// 与拼多多同理：这是页面内联展开，不是「右上角编辑抽屉」（用户铁律里不碰的是抽屉）。
//
// 【实测踩坑】不能用「记住点过的元素引用」去重：React 点击后会重建按钮节点，
// 旧引用失效 → 每轮都命中同一个按钮 → 同一板块被加出 2 张空卡（实测 71→251 框，全是空卡）。
// 正解：按钮总数恒定（每板块 1 个，点完仍在原位），**按 DOM 索引 0..N-1 依次点一遍**即可。
// v0.8.13b（#284）：京东展开改为「幂等精准补卡」——按 profile 各类目标卡数补差额，
// 绝不盲点所有 +添加（那会复现 70 空卡灾难）。合并区（技能/证书/外语）目标数单独算。
// v0.8.13b（#284）：京东展开改为「按 section 标题定位 + 按目标卡数补卡」。
// 京东经历板块默认折叠，只露一个「+ 添加」按钮；点后才展开成 formGroupItem 卡。
// 旧版按「字段标签」识别 section，对折叠态完全失效。现按标题（教育经历/实习经历/…/语言证书技能）定位，
// 每 section 点 +(目标-已有) 次，幂等：已展开到目标数就不再点（避免复现 70 空卡灾难）。
async function expandJdCards(profile) {
  try {
    if (!/campus\.jd\.com/i.test(location.hostname)) return false;
    const P = profile || {};
    const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // v0.8.13c（#285）：京东各板块有**唯一 id**（来自右侧 ant-anchor 导航的 href 锚点）：
    //   #edu(教育) #experience(实习) #campus(校园) #program(项目) #honor(荣誉) #thesis(论文) #skill(语言/证书/技能)
    // 旧版按「祖先标题文本」定位 section，但标题都在右侧锚点导航里（每个容器祖先都含全部标题文本），
    // 导致「实习经历」的 +添加 反被匹配到「教育经历」容器 → 点了教育卡。现直接按 id 定位，精准无误。
    const SEC = { education: "edu", internships: "experience", projects: "program", campus: "campus", awards: "honor", papers: "thesis" };
    const defs = [
      ["education", (P.education || []).length],
      ["internships", (P.internships || []).length],
      ["projects", (P.projects || []).length],
      ["campus", (P.campus || []).length],
      ["awards", (P.awards || []).length],
      ["papers", (P.papers || []).length],
    ];
    for (const [key, target] of defs) {
      if (!target) continue;
      const secId = SEC[key];
      const secEl = secId && document.getElementById(secId);
      if (!secEl) { rfaLog({ act: "jd-expand-skip", section: key, reason: "no #" + secId }); continue; }
      const addBtn = () => { const b = secEl.querySelector("a.am-button, button.am-button"); return b && visible(b) ? b : null; };
      const countCards = () => secEl.querySelectorAll('[class*="formGroupItem___"]').length;
      let clicks = 0;
      while (countCards() < target && clicks < target + 2) {
        const b = addBtn();
        if (!b) { rfaLog({ act: "jd-expand-nobtn", section: key }); break; }
        try { b.scrollIntoView({ block: "center" }); } catch (e) {}
        // 真·原生 click 才能触发 React 的 onClick（A.am-button 用合成 MouseEvent 不展开）；合成事件仅兜底。
        try { b.click(); } catch (e) {
          ["pointerdown", "mousedown", "mouseup", "click"].forEach((tp) => {
            try { b.dispatchEvent(new MouseEvent(tp, { bubbles: true, cancelable: true, view: window })); } catch (e2) {}
          });
        }
        clicks++;
        await sleep(850);
      }
      rfaLog({ act: "jd-expand-section", section: key, target, clicks, have: countCards() });
    }
    const after = Array.from(document.querySelectorAll("input,textarea,select")).filter(visible).length;
    rfaLog({ act: "jd-expand-idempotent", inputsAfter: after });
    return true;
  } catch (e) {
    rfaLog({ act: "jd-expand-err", err: String((e && e.message) || e) });
    return false;
  }
}

// ── v0.8.13（#283）：京东校招「卡片级」精确映射 ─────────────────────────────
// 血泪起因（2026-08-09 下午实测）：通用 fallbackMap 靠「板块 + 同一标签第二次出现」推断
// 经历序号，在京东页面上彻底串台 —— 第 2 张教育卡的「学院名称 / 专业名称」被填成
// awards[0].name（"国家奖学金"），第 4 张被填成"校级优秀毕业生"。
// 根因：guessSection 是逐字段判断的，京东的板块标题与卡片不在同一 DOM 子树，
//       边界飘忽 → 教育卡的字段被归进 awards 板块，于是取了错误的数据源。
// 正解：京东每条经历都是一张 .formGroupItem___xxx 卡，卡内字段固定、顺序固定、标签唯一。
//       直接「按卡认类型 → 卡在同类中的序号 → 卡内按标签取值」，
//       完全不依赖全局板块推断，一次根治串台 + 错位两个问题。
// 返回 [{idx, value, section}]，由主流程覆盖 fallbackMap 的同 idx 结果。
const JD_CARD_KINDS = [
  ["education", /学校名称/],
  ["internships", /公司名称/],
  ["projects", /项目名称/],
  ["campus", /活动名称/],
  ["awards", /奖项类型|奖项名称/],
  ["papers", /论文名称/],
  ["certificates", /证书名称/],
  ["languages", /语种/],
  ["skills", /技能类型|技能名称/],
  ["basic", /姓名/],
];

function jdKindOfCard(card) {
  const t = (card && card.innerText) || "";
  for (const [k, re] of JD_CARD_KINDS) if (re.test(t)) return k;
  return null;
}

// 从 arxiv 链接反推发表年月：/abs/2403.00001 → 2024.03（京东「发表时间」是必填日历）
function jdYearMonthFromLink(link) {
  const m = String(link || "").match(/\/(?:abs|pdf)\/(\d{2})(\d{2})\./);
  if (!m) return "";
  return "20" + m[1] + "." + m[2];
}

function jdAwardLevel(name) {
  const s = String(name || "");
  if (/国家|全国|国际/.test(s)) return "国家级";
  if (/省|华东|华北|区域/.test(s)) return "省级";
  if (/校|院/.test(s)) return "校级";
  return "其他";
}

// 专业大类：京东「专业类别」是 ant-cascader，给出末级名称交由级联匹配逐级展开
function jdMajorCategory(major) {
  const s = String(major || "");
  if (/计算机|软件|人工智能|数据|信息安全|网络空间/.test(s)) return "计算机类";
  if (/电子|通信|集成电路|微电子/.test(s)) return "电子信息类";
  if (/自动化|控制|机械|机器人/.test(s)) return "自动化类";
  if (/数学|统计/.test(s)) return "数学类";
  if (/管理|工商|会计|财务/.test(s)) return "管理科学与工程类";
  return "计算机类";
}

// 卡内某一行的标签（京东每行形如「*学校名称: xxx」）
function jdRowLabel(row) {
  const t = ((row && row.innerText) || "").replace(/\s+/g, " ").trim();
  return t.split(":")[0].split("：")[0].replace(/^\*/, "").trim().slice(0, 20);
}

// 规则表：[标签正则, 取值函数(item, ctx, k)]，k = 该行内第几个可填元素（日期行 0=开始 1=结束）
const JD_RULES = {
  basic: [
    [/^姓名/, (it, c) => c.basic.name],
    [/^性别/, (it, c) => c.basic.gender],
    [/^手机号码|^手机|^电话/, (it, c) => c.basic.phone],
    [/^电子邮箱|^邮箱/, (it, c) => c.basic.email],
    [/^国家.*地区|^国籍/, (it, c) => c.basic.nationality || "中国"],
    [/^籍贯/, (it, c) => [c.basic.hometownProvince, c.basic.hometownCity].filter(Boolean).join("/")],
    [/^民族/, () => "汉族"],
    [/^所在城市|^现居/, (it, c) => c.basic.locationCity || c.basic.locationProvince],
    [/^证件类型$|^个人证件$/, (it, c) => (c.basic.idType || "身份证").replace(/^中华人民共和国/, "") || "身份证"],
    [/^证件号码|^身份证号/, (it, c) => c.basic.idNumber],
    [/^出生日期|^出生年月/, (it, c) => c.basic.birth],
    [/^微信/, (it, c) => c.basic.wechat],
  ],
  education: [
    [/^起止时间|^就读时间/, (it, c, k) => (k === 0 ? it.start : it.end)],
    [/^学校名称|^毕业院校/, (it) => it.school],
    [/^学院名称/, (it) => it.college],
    [/^专业类别/, (it) => jdMajorCategory(it.major)],
    [/^专业名称/, (it) => it.major],
    [/^学历层次|^学历$/, (it) => it.degree],
    [/^学习形式/, (it) => it.eduType || "全日制"],
    [/^是否最高学历/, (it, c, k, i) => (i === c.topEduIdx ? "是" : "否")],
    [/^是否双学位/, () => "否"],
    [/^专业成绩排名|^成绩排名/, (it) => it.rank],
    [/^实验室/, (it) => it.lab],
    [/^导师/, (it) => it.tutor],
    [/^研究方向/, (it) => it.research],
  ],
  internships: [
    [/^起止时间|^实习时间/, (it, c, k) => (k === 0 ? it.start : it.end)],
    [/^公司名称/, (it) => it.company],
    [/^职位名称|^实习岗位/, (it) => it.title],
    [/^工作描述|^实习内容|^工作内容/, (it) =>
      [it.responsibilities, it.achievements].filter(Boolean).join(" "),
    ],
    [/^所在部门|^部门/, (it) => it.department],
  ],
  projects: [
    [/^起止时间|^项目时间/, (it, c, k) => (k === 0 ? it.start : it.end)],
    [/^项目名称/, (it) => it.name],
    [/^担任角色|^项目角色/, (it) => it.role],
    [/^项目描述|^项目内容/, (it) =>
      [it.description, it.responsibilities, it.achievements].filter(Boolean).join(" "),
    ],
    [/^项目链接/, (it) => it.link],
  ],
  campus: [
    [/^起止时间/, (it, c, k) => (k === 0 ? it.start : it.end)],
    [/^活动名称|^组织名称/, (it) => it.name],
    [/^担任职务|^职务/, (it) => it.role],
    [/^经历描述|^活动描述|^描述/, (it) => it.description],
  ],
  awards: [
    [/^奖项类型/, (it) => (it.category || "").trim()],   // 京东「奖项类型」= 类别，读 category
    [/级别/, (it) => it.level || jdAwardLevel(it.name)],  // 京东级别标签随类别前缀变化(奖学金级别/竞赛奖项级别/评优表彰级别)，用/级别/通配
    [/名称/, (it) => it.name],                            // 奖项名称(京东标签为「X名称」)，填名称；与获奖情况分开
    [/获奖时间/, (it) => it.date],
    [/获奖情况|描述/, (it) =>
      [it.name, it.description].filter(Boolean).join("："),
    ],
  ],
  papers: [
    [/^论文名称/, (it) => it.name],
    [/^作者顺序/, (it) =>
      /一作|第一/.test(String(it.order)) ? "第一作者"
        : /二作|第二/.test(String(it.order)) ? "第二作者"
          : /三作|第三/.test(String(it.order)) ? "第三作者" : it.order,
    ],
    [/^发表时间/, (it) => jdYearMonthFromLink(it.link)],
    [/^刊物|^期刊|^机构/, (it) => it.venue],
    [/^论文详情|^论文描述/, (it) =>
      [it.venue ? "发表于 " + it.venue : "", it.impact ? "影响因子 " + it.impact : "", it.description]
        .filter(Boolean).join("，"),
    ],
  ],
  certificates: [
    [/^证书名称/, (it) => it.name],
    [/^获得时间|^颁发时间/, (it) => it.date],
  ],
  languages: [
    [/^语种|^语言/, (it) => it.name],
    [/^考试|^证书/, (it) => it.exam],
    [/^分数|^成绩/, (it) => it.score],
    [/^水平|^等级/, (it) => it.level],
  ],
  skills: [
    [/^技能类型|^技能名称/, (it) => it],
  ],
};

function jdCardRemap(fields, profile) {
  const out = [];
  try {
    if (!/campus\.jd\.com/i.test(location.hostname)) return out;
    const P = profile || {};
    const basic = P.basic || {};
    // 最高学历所在条目（用于「是否最高学历」单选）
    const degRank = (d) =>
      /博士|phd/i.test(d) ? 4 : /硕士|研究生|master/i.test(d) ? 3 : /本科|学士|bachelor/i.test(d) ? 2 : 1;
    let topEduIdx = 0, topRank = -1;
    (P.education || []).forEach((e, i) => {
      const r = degRank((e && e.degree) || "");
      if (r > topRank) { topRank = r; topEduIdx = i; }
    });
    const ctx = { basic, topEduIdx };
    const LIST = {
      education: P.education || [],
      internships: P.internships || [],
      projects: P.projects || [],
      campus: P.campus || [],
      awards: P.awards || [],
      papers: P.papers || [],
      certificates: P.certificates || [],
      languages: P.languages || [],
      skills: ["编程语言", "开发框架与工具", "其他技能"],
    };
    const cards = Array.from(document.querySelectorAll('[class*="formGroupItem___"]'));
    const counter = {};
    let hit = 0, miss = 0;
    cards.forEach((card) => {
      const kind = jdKindOfCard(card);
      if (!kind) return;
      if (kind === "skills") return; // 合并区（技能类型下拉）由 jdFillCombinedSkills 专门处理，避免套用坏规则
      const i = counter[kind] === undefined ? (counter[kind] = 0) : ++counter[kind];
      const rules = JD_RULES[kind];
      if (!rules) return;
      const item = kind === "basic" ? basic : (LIST[kind] || [])[i];
      if (item === undefined || item === null) return; // 卡比数据多 → 该卡留空（后续会被清理）
      // v0.8.16（#JD）：京东每个字段是 .fieldItem___ 行，卡片直接 children 在某些重渲染瞬间
      // 会错位（实测把下一行的 [data-rfa-idx] 当成当前行 → 姓名被填成手机号、整体 +1 串台）。
      // 改为直接定位 .fieldItem___ 行，再取「本行」的 [data-rfa-idx]，杜绝串台。
      Array.from(card.querySelectorAll('[class*="fieldItem___"]')).forEach((row) => {
        const label = jdRowLabel(row);
        if (!label) return;
        const rule = rules.find(([re]) => re.test(label));
        if (!rule) return;
        const els = Array.from(row.querySelectorAll("[" + ATTR + "]"));
        if (!els.length) return;
        els.forEach((el, k) => {
          let v;
          try { v = rule[1](item, ctx, k, i); } catch (e) { v = null; }
          if (v === undefined || v === null || v === "") { miss++; return; }
          const idx = el.getAttribute(ATTR);
          if (idx === null) return;
          // v0.8.17（#364）：固定推送【字符串】idx。scanFields/fallbackMap 全站统一用
          // 字符串 idx（String(i)），而此处历史上用 isNaN(+idx)?idx:+idx 会把数值 idx 转成
          // number —— 导致下游合并(jdByIdx.has)、去重(seen.has)、map-table(_mv.has(f.idx))
          // 全部 number/string 失配：fallback 错误值（姓名=手机号）无法被卡片级映射覆盖、
          // jdCardRemap 条目被去重丢弃 → 表现为 basic 整段串台 + map-table 显示 ∅。
          out.push({ idx: String(idx), value: String(v), section: kind, jd: true });
          hit++;
        });
      });
    });
    rfaLog({ act: "jd-card-remap", cards: cards.length, mapped: hit, empty: miss, kinds: counter });
  } catch (e) {
    rfaLog({ act: "jd-card-remap", err: String((e && e.message) || e) });
  }
  return out;
}

// ── v0.8.13b（#284）：京东「语言/证书/技能」两级合并卡专用填充 ──────────────────
// 京东把 技能 / 证书 / 外语 合并成一个 section：每张卡先选「技能类型」下拉
// （开发语言 / 外语语种 / 证书 / 其他技能），对应子字段才出现：
//   开发语言 → 第二下拉(开发语言列表) + 一个 input
//   外语语种 → 第二下拉(语种) + input(考试类型及成绩)
//   证书     → input(技能证书)
//   其他技能 → input(其他技能)
// 通用 jdCardRemap 看不到「选完类型才出现的子字段」，故此处专门处理。
// 下拉选项为京东固定值（已用 CDP 实测）：开发语言 17 项、外语语种 9 项。
const JD_DEV_LANG_OPTS = ["Java", "Python", "Go", "C++", "C", "C#", "PHP", "JavaScript", "TypeScript", "SQL", "Shell", "Rust", "Ruby", "Swift", "Kotlin", "Dart", "其他"];
const JD_FORLANG_OPTS = ["英语", "日语", "韩语", "德语", "法语", "阿拉伯语", "马来西亚语", "西班牙语", "其他"];

function jdSetReactInput(el, val) {
  try {
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (e) {}
}

async function jdFillCombinedSkills(profile) {
  try {
    if (!/campus\.jd\.com/i.test(location.hostname)) return;
    const P = profile || {};
    const DEV = new Set(JD_DEV_LANG_OPTS), FL = new Set(JD_FORLANG_OPTS);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    // 合并区容器 = #skill（语言/证书/技能板块唯一 id，见 expandJdCards SEC 注释）。
    const skillSec = document.getElementById("skill");
    const combinedCards = () =>
      skillSec ? Array.from(skillSec.querySelectorAll('[class*="formGroupItem___"]')) : [];

    // 组装计划：开发语言(在选项里) / 其他技能(不在选项里+非外语语种语言) / 外语语种(按语言名去重) / 证书
    const plan = [];
    (P.skills || []).forEach((s) => { if (DEV.has(s)) plan.push({ type: "开发语言", v: String(s) }); });
    (P.skills || []).forEach((s) => { if (!DEV.has(s)) plan.push({ type: "其他技能", v: String(s) }); });
    (P.languages || []).forEach((l) => { if (!FL.has(l.name)) plan.push({ type: "其他技能", v: [l.name, l.level].filter(Boolean).join(" ") }); });
    const flBy = {};
    (P.languages || []).forEach((l) => { if (FL.has(l.name)) (flBy[l.name] = flBy[l.name] || []).push(l); });
    Object.keys(flBy).forEach((name) => {
      const parts = flBy[name].map((l) => [l.exam, l.level, l.score].filter(Boolean).join(" ").trim()).filter(Boolean);
      plan.push({ type: "外语语种", lang: name, text: parts.join(" / ") });
    });
    (P.certificates || []).forEach((c) => plan.push({ type: "证书", v: (c && c.name) || c }));

    // 合并区卡片由本函数自己负责补齐（不再依赖 expandJdCards）：
    // 直接定位 #skill 板块的 +添加 按钮，点到 plan.length 张为止。
    const combinedAddBtn = () => {
      if (!skillSec) return null;
      const b = skillSec.querySelector("a.am-button, button.am-button");
      return b && vis(b) ? b : null;
    };
    let guard = 0;
    while (combinedCards().length < plan.length && guard++ < plan.length + 3) {
      const ab = combinedAddBtn();
      if (!ab) { rfaLog({ act: "jd-skill-nobtn" }); break; }
      try { ab.click(); } catch (e) {
        ["pointerdown", "mousedown", "mouseup", "click"].forEach((tp) => { try { ab.dispatchEvent(new MouseEvent(tp, { bubbles: true, cancelable: true, view: window })); } catch (e2) {} });
      }
      await sleep(900);
    }
    rfaLog({ act: "jd-skill-added", plan: plan.length, cards: combinedCards().length });

    // 逐卡填充
    const cards = combinedCards();
    for (let i = 0; i < plan.length; i++) {
      const card = cards[i];
      if (!card) continue;
      const p = plan[i];
      const typeSel = card.querySelectorAll(".ant-select")[0];
      if (typeSel) { try { await tryPickGenericSelect(typeSel, p.type, { label: "技能类型" }); } catch (e) {} }
      await sleep(550);
      if (p.type === "开发语言") {
        const devSel = card.querySelectorAll(".ant-select")[1];
        if (devSel) { try { await tryPickGenericSelect(devSel, p.v, { label: "开发语言" }); } catch (e) {} }
      } else if (p.type === "外语语种") {
        const langSel = card.querySelectorAll(".ant-select")[1];
        if (langSel) { try { await tryPickGenericSelect(langSel, p.lang, { label: "外语语种" }); } catch (e) {} }
        await sleep(450);
        const inp = Array.from(card.querySelectorAll("input,textarea")).find((el) => !el.closest(".ant-select") && vis(el));
        if (inp && p.text) jdSetReactInput(inp, p.text);
      } else {
        const inp = Array.from(card.querySelectorAll("input,textarea")).find((el) => !el.closest(".ant-select") && vis(el));
        if (inp && p.v) jdSetReactInput(inp, p.v);
      }
      await sleep(350);
    }
    rfaLog({
      act: "jd-skill-fill",
      plan: plan.length,
      cards: cards.length,
      dev: plan.filter((p) => p.type === "开发语言").length,
      other: plan.filter((p) => p.type === "其他技能").length,
      fl: plan.filter((p) => p.type === "外语语种").length,
      cert: plan.filter((p) => p.type === "证书").length,
    });
  } catch (e) {
    rfaLog({ act: "jd-skill-fill-err", err: String((e && e.message) || e) });
  }
}

// ── v0.8.x（JD 荣誉奖励第二轮专填）：奖项类型选完后京东才揭示「级别 / 名称」子字段，
// 它们不在首次 scanFields 的 fields 列表里（map-table 里压根没有 => 主流程漏填），
// 竞赛奖项因 级别 标签恰为通用「奖项级别」偶发被旧规则命中、其余类别前缀标签全漏。
// 这里做第二轮：定位每张获奖卡的「X级别」下拉与「X名称」输入框，按 profile.awards[i] 补填。
async function jdFillAwards(profile) {
  try {
    if (!/campus\.jd\.com/i.test(location.hostname)) return;
    const P = profile || {};
    const awards = P.awards || [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    await sleep(800); // 等奖项类型回填触发的子字段揭示渲染完成
    const cards = Array.from(document.querySelectorAll('[class*="formGroupItem___"]'))
      .filter((c) => /奖项类型|奖项名称/.test(c.innerText || ''));
    let filled = 0;
    const dbg = [];
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const item = awards[i];
      if (!item) continue;
      const rows = () => Array.from(card.querySelectorAll('[class*="fieldItem___"]'));
      // 0) 先把「奖项类型」选上，京东才会揭示「级别 / 名称」子字段（主循环在二轮之后才回填奖项类型，
      //    故此处必须自助选类型，否则级别/名称行根本不在 DOM 里）
      const typeRow = rows().find((r) => /奖项类型/.test(r.innerText || ''));
      const typeSel = typeRow ? typeRow.querySelector('.ant-select') : null;
      if (typeSel && vis(typeSel) && item.category) {
        try { await tryPickGenericSelect(typeSel, item.category, { label: '奖项类型' }); } catch (e) {}
        await sleep(600);
      }
      // 1) 级别（标签随类别前缀：奖学金级别 / 竞赛奖项级别 / 评优表彰级别）
      let lvlRow = rows().find((r) => /级别/.test(r.innerText || ''));
      const lvlSel = lvlRow ? lvlRow.querySelector('.ant-select') : null;
      const lvl = item.level || jdAwardLevel(item.name);
      let lvlRes = 'skip';
      if (lvlSel && vis(lvlSel) && lvl) {
        try { lvlRes = String(await tryPickGenericSelect(lvlSel, lvl, { label: '奖项级别' })); if (lvlRes === 'true') filled++; }
        catch (e) { lvlRes = 'ERR:' + e.message; }
        if (lvlRes !== 'true') {
          try {
            const optTxt = Array.from(document.querySelectorAll('.ant-select-dropdown .ant-select-item-option-content')).map(o => o.innerText.trim()).filter(Boolean);
            dbg.push(`card${i + 1} lvl="${lvl}" res=${lvlRes} opts=${JSON.stringify(optTxt.slice(0, 12))}`);
          } catch (e2) { dbg.push(`card${i + 1} lvl="${lvl}" res=${lvlRes} optErr=${e2.message}`); }
        }
      } else {
        dbg.push(`card${i + 1} lvlRow=${!!lvlRow} lvlSel=${!!lvlSel} vis=${lvlSel ? vis(lvlSel) : 'na'} lvl="${lvl}"`);
      }
      await sleep(300);
      // 2) 名称（标签：奖学金名称 / 竞赛奖项名称 / 评优表彰名称）
      let nameRow = rows().find((r) => /名称/.test(r.innerText || ''));
      const nameInp = nameRow ? nameRow.querySelector('input,textarea') : null;
      if (nameInp && vis(nameInp) && !nameInp.closest('.ant-select') && item.name) {
        try { jdSetReactInput(nameInp, item.name); filled++; } catch (e) {}
      } else {
        dbg.push(`card${i + 1} nameRow=${!!nameRow} nameInp=${!!nameInp} vis=${nameInp ? vis(nameInp) : 'na'} name="${item.name}"`);
      }
    }
    rfaLog({ act: 'jd-award-fill', cards: cards.length, awards: awards.length, filled, dbg });
  } catch (e) {
    rfaLog({ act: 'jd-award-fill-err', err: String((e && e.message) || e) });
  }
}

// ── v0.8.11（#280）：全流程超时护栏 ────────────────────────────────────────
// 血泪起因（2026-08-09 凌晨）：京东 97 个字段永远 0%。挂 console 抓 [RFA-STAGE]
// 日志才发现，流程卡在 upload-first-done 与 expand-done 之间（expandExperienceSections
// 一去不返，75s 无声无息），另一轮卡在 handleFileUploads（简历 PDF 实际 9.4MB，
// 超出 6MB 上限 57%）。这些步骤全是串行 await 且没有任何超时 —— 一旦某步卡住，
// 后面所有字段填充代码根本没机会执行。
// 直接后果：用户改了一整天字段映射却毫无变化，因为改的代码在阻塞点之后，压根没被跑到。
// 铁律：附件上传 / 卡片展开 / 弹窗清场 失败都可以降级，字段留白不可以。
//       任何单步都不许拖垮主流程 —— 最差也要保证「字段填上了，附件没传成」。
const RFA_STEP_TIMEOUT = {
  expandJd: 120000,
  enterEdit: 20000,
  uploadFirst: 60000,
  expand: 45000,
  upload: 90000,
  dialogs: 20000,
  map: 60000,
};

async function rfaStep(label, ms, fn) {
  const t0 = Date.now();
  let timer = null;
  const TO = "__RFA_STEP_TIMEOUT__";
  try {
    const r = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((res) => { timer = setTimeout(() => res(TO), ms); }),
    ]);
    if (r === TO) {
      console.warn("[RFA-STAGE] TIMEOUT " + label + " 超过 " + Math.round(ms / 1000) + "s，已跳过，继续后续步骤");
      try { rfaLog({ act: "step-timeout", step: label, ms: ms }); } catch (e) {}
      try { showToast(label + "超时已跳过，继续填写字段", "err"); } catch (e) {}
      return null;
    }
    try { rfaLog({ act: "step-ok", step: label, ms: Date.now() - t0 }); } catch (e) {}
    return r;
  } catch (e) {
    console.warn("[RFA-STAGE] ERROR " + label + " → " + (e && e.message));
    try { rfaLog({ act: "step-error", step: label, err: String(e && e.message).slice(0, 140) }); } catch (e2) {}
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runAutofill(profile, fileVault, options, works) {
  // 每一轮开跑先清空日志，保证事后读到的永远是「本轮」的决策记录
  //（多轮补填时尤其重要，否则上一轮的日志会把本轮挤掉）。
  try { RFA_LOG.length = 0; RFA_LOG_ONCE.clear(); } catch (e) {}
  CURRENT_PROFILE = profile || null;
  if (!profile) {
    showToast("请先在插件里解析你的简历档案", "err");
    return { ok: false, error: "no profile" };
  }

  // ── #551（2026-08-21）：前程无忧 ATS 系统（xyz.51job.com/consumer/pc/resume/index）──
  // 「自己点加号 + 确认」的弹窗式简历编辑器，模型与通用 inline 展开完全不同，
  // 整段走专属适配器。仅 51job 域名进入；其它站点完全不受影响（下方通用流程照旧）。
  if (isQiancheng()) {
    rfaLog({ act: "qiancheng-dispatch" });
    try {
      return await runQianchengAdapter(profile, fileVault, options, works);
    } catch (e) {
      rfaLog({ act: "qiancheng-fatal", err: String((e && e.stack) || e) });
      showToast("前程无忧适配器执行异常，已停止（未做任何破坏性填写）", "err");
      return { ok: false, error: "qiancheng adapter exception: " + e };
    }
  }

  // v0.8.13（08-21 用户反馈「填充卡死/下拉点不开」）：字节新增 AI 助手浮层
  // （campus-ai-assistant__fab-popover「👋 Hi，有什么可以帮你？」）常驻页面右上，
  // 挡住表单点击 —— 期望工作地点等下拉永远打不开 → fillCombobox 卡死 → 整个投递卡住。
  // 用户只能手动关；这里在填充开始前注入 CSS 把整个 AI 助手组件隐藏（!important 盖住
  // React 重渲染，任何站点状态都能自愈，不影响表单功能）。
  try {
    if (/jobs\.bytedance\.com/i.test(location.hostname)) {
      let st = document.getElementById("rfa-hide-byte-ai");
      if (!st) {
        st = document.createElement("style");
        st.id = "rfa-hide-byte-ai";
        st.textContent = '[class*="campus-ai-assistant"]{display:none !important;visibility:hidden !important;pointer-events:none !important;}';
        (document.head || document.documentElement).appendChild(st);
      }
      rfaLog({ act: "byte-ai-hidden" });
    }
  } catch (e) { try { rfaLog({ act: "byte-ai-hide-err", err: String(e) }); } catch (x) {} }

  // v0.7.5：整个填充流程全程挂 observer（三档分诊清场），任何时候冒出的弹窗都自动按掉。
  // ttl 拉到 10 分钟，覆盖「上传 + 展开 + 填充 + 复填」全生命周期。
  try { window.__RFA_DIALOGS = []; } catch (e) {}
  try { startParseOverlayObserver(600000); } catch (e) {}

  // 【清场门禁 #1】用户铁律：弹窗没解决不许往下填。
  // 开跑第一件事就是把页面上残留的弹窗（上一轮没关的、刷新后自动弹的）全清掉。
  console.log("[RFA-STAGE] gate1-begin"); rfaMark("gate1-begin");
  showToast("正在检查并关闭页面弹窗…", "wait");
  const gate1 = (await rfaStep("弹窗清场", RFA_STEP_TIMEOUT.dialogs, () => clearBlockingDialogs(10))) || { clean: false, stuck: ["timeout"] };
  console.log("[RFA-STAGE] gate1-done", JSON.stringify(gate1)); rfaMark("gate1-done");
  rfaLog({ act: "gate1", clean: gate1.clean, stuck: gate1.stuck || [] });

  // ── v0.8.0（#264）：拼多多「只读展示页」破例展开 ────────────────────────────
  // 用户 2026-08-07 明确授权：拼多多这站可以点「编辑」。
  // 拼多多 careers.pddglobalhr.com 的简历页默认是只读展示态，整页只有 2 个可见输入框，
  // 所有字段（姓名/性别/出生年月/证件号码/最高学历/邮箱/微信号/住址/获奖/论文…）
  // 都要点「基本信息 - 编辑」才原地展开成表单（注意：不是抽屉/弹窗，是 inline 展开）。
  // 不展开 → 插件扫不到字段 → 永远 0%。
  await expandPddInlineEdit();
  // 2026-08-11（#PDD）：拼多多各板块「添加」按钮专用展开（通用器在拼多多上识别不到容器）。
  if (/pddglobalhr\.com/i.test(location.hostname)) {
    await rfaStep("拼多多板块展开", RFA_STEP_TIMEOUT.expand || 20000, () => expandPddCards(profile));
  }

  // ── v0.8.3（#266）：京东各板块「+ 添加」空卡展开（同属 inline 展开，非抽屉）──
  await rfaStep("京东空卡展开", RFA_STEP_TIMEOUT.expandJd, () => expandJdCards(profile));

  // ── v0.8.6（#274）：通用「进入编辑态」门禁 ─────────────────────────────────────
  // 有一类站点打开后压根**没有表单**，先要点一个入口按钮才会渲染出简历编辑页。
  // 真机实测（dbg.js）美团 zhaopin.meituan.com/web/personal-center/resume-detail：
  //     整页 input=0 / textarea=0 / select=0，正文写着「你当前还没有创建简历 / 立即创建」
  // 插件因此报 scan-done=0 直接放弃 → 美团长期 0%，一直被误当成「反爬/登录问题」。
  // B站要点「编辑」、小红书要从投递页进编辑页，都是同一类形态，故做成通用能力。
  await rfaStep("进入编辑态", RFA_STEP_TIMEOUT.enterEdit, () => enterEditModeIfNeeded());

  // 可选：先传简历 PDF，等网站自动解析
  if (options.uploadResumeFirst && fileVault.resume && !fileVault.resume.manual) {
    showToast("正在先上传简历 PDF，请稍候…", "wait");
    await rfaStep("首传简历PDF", RFA_STEP_TIMEOUT.uploadFirst, () =>
      handleFileUploads([{ cat: "resume", data: fileVault.resume }])
    );
    await new Promise((r) => setTimeout(r, 2500));
    // 【清场门禁 #2】上传后必弹「要不要解析」，这里守死，绝不让它覆盖后面填的内容。
    await rfaStep("弹窗清场#2", RFA_STEP_TIMEOUT.dialogs, () => clearBlockingDialogs(14));
  }

  console.log("[RFA-STAGE] upload-first-done"); rfaMark("upload-first-done");
  showToast("正在展开经历表单并填充…", "wait");

  // 先尝试展开经历板块的"添加"按钮
  // 2026-08-07：多轮补填时，第 2 轮起必须传 options.noExpand=true。
  // 原因：expandSection 里 toAdd = needed - countItemsForSection()，而部分站点（腾讯「获奖」）
  // 的卡片计数器认不出已存在的卡 → 每跑一轮就凭空多出 N 张空卡。
  // 实测腾讯校招 R1=97/100(97%)，R2 因多出 2 张空获奖卡反而掉到 96/108(89%)。
  // 所以：第 1 轮负责「建卡 + 填主干」，之后各轮只填卡内细项，绝不再点「添加」。
  // v0.8.x（2026-08-14·字节语言卡修复）：字节简历从服务端懒加载，语言等 array-card 板块
  // 在开跑瞬间常未挂载。开跑前先等语言卡片稳定（确认已加载），避免 expand 计数=0 误 over-click、
  // scan 扫不到卡片导致「所有卡都填成英语」的错位。
  if (/jobs\.bytedance\.com/i.test(location.hostname)) {
    await waitBytedanceLangStable(33000);
  }

  if (options && options.noExpand) {
    rfaLog({ act: "expand-skipped", why: "noExpand（补填轮，不再新增卡片）" });
  } else {
    await rfaStep("展开经历板块", RFA_STEP_TIMEOUT.expand, () => expandExperienceSections(profile));
  }
  console.log("[RFA-STAGE] expand-done"); rfaMark("expand-done");

  // 表单展开后，再等一会儿让 React 渲染完成（飞书/字节系动态表单较慢）
  await new Promise((r) => setTimeout(r, 400));
  // v0.8.x（2026-08-14）：字节新卡延迟挂载，展开后再等一次语言卡片稳定，确保 scanFields 扫到全部卡片。
  if (/jobs\.bytedance\.com/i.test(location.hostname)) {
    await waitBytedanceLangStable(20000);
  }

  let fields = scanFields();
  console.log("[RFA-STAGE] scan-done", fields.length); rfaMark("scan-done");
  if (!fields || !fields.length) {
    // 兜底：scanFields 对某些站点（如腾讯 Element UI）偶发返回 0，改用宽松扫描直接取可见可填元素
    let els = getAllFillableEls();
    if (!els || !els.length) {
      els = [].slice.call(document.querySelectorAll("input,textarea,select,[contenteditable='true'],[role='textbox'],[role='combobox']"))
        .filter(e => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return s.display !== "none" && s.visibility !== "hidden" && (r.width > 0 || r.height > 0); });
    }
    fields = (els || []).map((el, i) => ({
      idx: String(i),
      label: getLabel(el) || "",
      type: el.tagName.toLowerCase() + (el.type ? ":" + el.type : ""),
      role: (el.getAttribute && el.getAttribute("role")) || "",
      required: detectRequired(el),
      section: "",
    }));
    console.log("[RFA-STAGE] scan-fallback", fields.length);
  }
  if (fields.length === 0) {
    showToast("当前页面没有找到可填写的表单字段", "err");
    // #552：提前退出也停观察器，不留长期挂载
    try { stopParseOverlayObserver(); } catch (e) {}
    return { ok: false, error: "no fields" };
  }

  // ===== 文件上传（作品集 / 简历）：独立于 LLM 映射回调，提前执行 =====
  // 原因：原先作品集上传被包在 mapFields 的回调里，一旦后台 LLM 无响应，
  // 整段（含上传）都不会执行。现提前到此处，确保无论 LLM 是否可用都能上传。
  let fileManual = null;
  try {
    const uploadItems = [];
    if (fileVault && fileVault.resume) uploadItems.push({ cat: "resume", data: fileVault.resume });
    if (fileVault && fileVault.photo) uploadItems.push({ cat: "avatar", data: fileVault.photo });
    // 2026-08-14（用户决策）：作品集附件【只上传第一个】（默认传作品集里出现的第一个）。
    // ① 腾讯等站作品集是「多个文字卡片 + 单个共享上传槽」，旧逻辑把 works 全量灌进同一槽，
    //   同一文件在上传列表被重复出现多次（实测 测试作品集.pdf 出现 3 次），刷新/重跑后
    //   易整组丢失或错乱；② 用户明确只要第一个作品集附件；其它作品卡片的【文字字段】
    //   （名称/链接/描述/密码）仍照常填（不受此限制，数量铁律 作品集4 不变）。
    // ③ 同名附件去重，避免多个作品指向同一文件时被上传多次。
    let _pfPushed = false;
    const _pfSeen = new Set();
    (works || []).filter(Boolean).forEach((w, i) => {
      const att = w && (w.attachment || w.video || w.pdf);
      if (!att || !att.name) return;
      if (_pfPushed) {
        rfaLog({ type: "attachment_skip_nonfirst", workIndex: i, name: att.name, note: "only-first-portfolio(by design 2026-08-14)" });
        return;
      }
      if (_pfSeen.has(att.name)) {
        rfaLog({ type: "attachment_dup_skip", workIndex: i, name: att.name });
        return;
      }
      _pfSeen.add(att.name);
      uploadItems.push({ cat: "portfolio", data: att, workIndex: 0 });
      _pfPushed = true;
      rfaLog({ type: "attachment_source", workIndex: 0, name: att.name, note: "only-first-portfolio(by design 2026-08-14)" });
    });
    console.log("[RFA-STAGE] upload-begin", uploadItems.length); rfaMark("upload-begin");
    // v0.8.11：附件超限预警。9.4MB 的简历 PDF 是拖垮京东整条流水线的元凶之一，
    // 各站上限最严 6MB（腾讯），超了要么传不上要么卡到天荒地老，必须当场喊出来。
    try {
      uploadItems.forEach((it) => {
        const d = it && it.data;
        const raw = d && (d.size || (typeof d.dataUrl === "string" ? Math.round(d.dataUrl.length * 0.75) : 0));
        if (raw && raw > 6 * 1024 * 1024) {
          const mb = (raw / 1024 / 1024).toFixed(1);
          console.warn("[RFA-STAGE] 附件超限 " + it.cat + " = " + mb + "MB（上限 6MB）");
          rfaLog({ act: "attachment-oversize", cat: it.cat, mb: mb });
          showToast("附件 " + (d.name || it.cat) + " 有 " + mb + "MB，超出 6MB 上限，可能上传失败", "err");
        }
      });
    } catch (e) {}
    if (uploadItems.length) {
      // 2026-08-11（#PDD）：拼多多上传校验恒失败（upload_verify_fail: 页面未出现该文件），
      // 失败后页面重渲染会把已展开的卡片全弄丢（实测 142→60 框）。且文件上传非拼多多核心字段，
      // 故拼多多整段跳过上传，仅填表单，避免触发布局重载。
      if (/pddglobalhr\.com/i.test(location.hostname)) {
        rfaLog({ act: "upload-skip-pdd", reason: "PDD upload verify always fails → skip to avoid reload" });
      } else {
      fileManual = await rfaStep("附件上传", RFA_STEP_TIMEOUT.upload, () => handleFileUploads(uploadItems));
      // 【清场门禁 #3】简历/证件照/作品集上传完，各站必弹解析确认或格式提示 —— 先清干净再填字段。
      await rfaStep("弹窗清场#3", RFA_STEP_TIMEOUT.dialogs, () => clearBlockingDialogs(16));
      }
    }
  } catch (e) { rfaLog({ act: "upload-error", error: String(e) }); }

  // LLM 映射：经保活端口调用后台，3 次重试兜底。即使后台偶发无响应，
  // 也照常继续用兜底规则填充，绝不永久卡死。
  console.log("[RFA-STAGE] upload-done"); rfaMark("upload-done");
  const mapRes = await rfaStep("LLM字段映射", RFA_STEP_TIMEOUT.map, () => rfaMapFields(fields, profile));
  console.log("[RFA-STAGE] map-done"); rfaMark("map-done");
  if (!mapRes || !mapRes.ok) rfaLog({ act: "map-fallback", reason: (mapRes && mapRes.error) || "unknown" });

  return new Promise((resolve) => {
    (async () => {
      // 以确定性「标签匹配」为主（完全可控、可验证），LLM 仅补充它没覆盖的字段，
      // 避免 LLM 误填/颠倒（用户明确要求：先看标签语义，再从简历取对应内容）。
      let mappings = fallbackMap(fields, profile);
      let source = "fallback";

      // v0.8.13（#283）：京东经历卡专用「卡片级」映射，覆盖 fallbackMap 的 section 推断，
      // 根治"串台"（教育卡字段被归到 awards 源、值取自奖项名）。京东每个经历块是独立卡片，
      // 卡片内行标签精确对应 profile 的某条数组元素，比"全局标签猜 section"可靠得多。
      if (/campus\.jd\.com/i.test(location.hostname)) {
        try {
          const jdMaps = jdCardRemap(fields, profile);
          if (jdMaps.length) {
            const jdByIdx = new Map(jdMaps.map((m) => [m.idx, m]));
            // 1) 替换同 idx 的 fallback 结果（卡片级精确映射覆盖 section 推断错误）
            mappings = mappings.map((m) => (jdByIdx.has(m.idx) ? jdByIdx.get(m.idx) : m));
            // 2) 补回 fallback 漏掉的卡片字段
            const have = new Set(mappings.map((m) => m.idx));
            for (const m of jdMaps) if (!have.has(m.idx)) { mappings.push(m); have.add(m.idx); }
            source = "jd-card-remap";
            rfaLog({ act: "jd-card-remap-applied", n: jdMaps.length });
          }
        } catch (e) {
          rfaLog({ act: "jd-card-remap-apply-err", err: String((e && e.message) || e) });
        }
      }

      // v0.8.13b（#284）：京东「语言/证书/技能」两级合并卡专用填充（技能类型下拉→子字段）
      if (/campus\.jd\.com/i.test(location.hostname)) {
        try { await jdFillCombinedSkills(profile); }
        catch (e) { rfaLog({ act: "jd-skill-fill-call-err", err: String((e && e.message) || e) }); }
        // v0.8.17（#364）：基本信息卡内「无 data-rfa-idx 映射」的字段（籍贯级联）专用填充
        try { await jdFillBasicCard(profile); }
        catch (e) { rfaLog({ act: "jd-basic-call-err", err: String((e && e.message) || e) }); }
        // v0.8.17（#364）：论文详情文本框通用链命中失败，按标签直接写富文本
        try { await jdFillPapers(profile); }
        catch (e) { rfaLog({ act: "jd-paper-call-err", err: String((e && e.message) || e) }); }
        // v0.8.17（#366）：其他信息 4 槽（成绩单/证书/专利/作品集）附件上传
        try { await jdFillAttachments(fileVault); }
        catch (e) { rfaLog({ act: "jd-att-call-err", err: String((e && e.message) || e) }); }
        // v0.8.x：荣誉奖励「级别 / 名称」为奖项类型选定后才揭示的子字段，主流程漏填，二轮补填
        try { await jdFillAwards(profile); }
        catch (e) { rfaLog({ act: "jd-award-call-err", err: String((e && e.message) || e) }); }
      }

      // v0.8.6（#270）：把「每个字段 → 映射到什么值」整张表打进日志。
      // 这是定位「某字段为什么留白」的唯一有效手段：留白只有两种成因——
      //   ∅   = 映射阶段就没取到值（问题在 fallbackMap / 数据源 / section 归属判断）
      //   有值但页面仍空 = 填充阶段被组件吃掉（问题在 fillFieldAsync 的组件适配）
      // 没有这张表时两者现象完全一样，只能靠猜（Moka 5 家就是这么白耗了一整晚）。
      try {
        const _mv = new Map(mappings.map((m) => [m.idx, String(m.value).slice(0, 18)]));
        rfaLog({
          act: "map-table",
          n: fields.length,
          rows: fields.map(
            (f) =>
              f.idx +
              "|" +
              (f.section || "?") +
              "|" +
              String(f.label || f.rawLabel || f.placeholder || "").slice(0, 14) +
              "=>" +
              (_mv.has(f.idx) ? _mv.get(f.idx) : "∅")
          ),
        });
      } catch (e) {}

      const mappedIdx = new Set(mappings.map((m) => m.idx));
      if (mapRes && mapRes.ok && Array.isArray(mapRes.mappings)) {
        let llmAdded = 0;
        for (const m of mapRes.mappings) {
          if (mappedIdx.has(m.idx)) continue;
          const f = fields.find((x) => x.idx === m.idx);
          if (!f) continue;
          // 主观/决策字段（调剂/期望薪资等）无论 LLM 还是兜底都绝不填
          if (FORBIDDEN_RE.test(f.label || "")) continue;
          if (m.value === undefined || m.value === null || m.value === "") continue;
          mappings.push(m);
          mappedIdx.add(m.idx);
          llmAdded++;
        }
        if (llmAdded > 0) source = "fallback+llm";
      }

      // v0.7.4（#210）：必填选择类字段（下拉/单选/组合框）即使档案无值也要触发填充，
      // 让 fillDropdown/fillCombobox/fillRadioGroup 的 R4「唯一选项必选」兜底选中，
      // 满足产品铁律：单选唯一项必选，不让用户去点。仅选择类，文本框不强行塞空值。
      for (const f of fields) {
        if (mappedIdx.has(f.idx)) continue;
        const _req = f.required || /\*/.test(f.label || "");
        if (!_req) continue;
        const el0 = document.querySelector(`[${ATTR}="${f.idx}"]`);
        if (!el0) continue;
        if (!(isRadioGroup(el0) || isDropdownField(el0) || isCombobox(el0))) continue;
        mappings.push({ idx: f.idx, value: null, section: f.section || "unknown" });
        mappedIdx.add(f.idx);
      }

      // 校验每个映射：防止 LLM 把手机号填进邮箱、把描述填进链接等
      mappings = mappings.filter((m) => {
        const f = fields.find((x) => x.idx === m.idx);
        return f && validateValueForField(m.value, f);
      });

      // 去重：同 idx 保留第一次
      const seen = new Set();
      mappings = mappings.filter((m) => {
        if (seen.has(m.idx)) return false;
        seen.add(m.idx);
        return true;
      });

      // v0.8.14（#286）/ v0.8.15（#287）：Moka/飞书等站页面自带「工作经历」默认空卡，
      // 而应届生只有实习经历。needed=0 的 expandable section 字段必须整段剔除，
      // 否则兜底会把实习数据错填进工作经历空卡（大疆 R1 / 安踏 R1 实测）。
      // 逻辑已抽成公共函数 filterZeroSectionMappings —— cascadeRefill 处必须调用同一个，
      // 否则二次补漏会把刚过滤掉的字段重新灌回去（安踏 R1 就是这么漏的）。
      mappings = filterZeroSectionMappings(mappings, fields, profile, "main");

      // 处理「无标签的选择框」（如基本信息里的性别 / 城市 / 学历 / 学历类型，飞书常不带标签）。
      // 展开后读取选项反推该框类型，再从档案取对应值填充。
      for (const f of fields) {
        const el2 = document.querySelector(`[${ATTR}="${f.idx}"]`);
        if (f.section === "basic" && !f.label && el2 && isCombobox(el2)) {
          if (mappedIdx.has(f.idx)) continue;
          if (!el2) continue;
          try {
            const inferred = await inferComboboxValue(el2, f, profile);
            if (inferred && inferred.value) {
              mappings.push({ idx: f.idx, value: inferred.value, section: "basic" });
              mappedIdx.add(f.idx);
              source = "fallback+infer";
            }
          } catch (e) {}
        }
      }

      // v0.6.64 诊断：日期选择器几乎不触发，需要区分「没扫到」还是「扫到了但没匹配出值」
      {
        const finalIdx = new Set(mappings.map((m) => m.idx));
        const dateFields = fields.filter((f) => /时间|日期|date/i.test(f.label || ""));
        const mappedDates = dateFields.filter((f) => finalIdx.has(f.idx));
        const missDates = dateFields.filter((f) => !finalIdx.has(f.idx));
        rfaLog({ act: "map-summary", fields: fields.length, mappings: mappings.length, source: source });
        rfaLog({
          act: "map-date",
          total: dateFields.length,
          mapped: mappedDates.length,
          sample: mappedDates.slice(0, 6).map((f) => f.section + "|" + f.label + "=" + (mappings.find((m) => m.idx === f.idx) || {}).value),
        });
        rfaLog({ act: "map-date-miss", n: missDates.length, list: missDates.slice(0, 16).map((f) => f.section + "|" + f.label) });
      }

      let filled = 0;
      let total = mappings.length;
      const filledIdx = new Set();
      const sectionHits = {};
      if (total === 0) {
        showToast(`识别到 ${fields.length} 个字段，但无法匹配任何可填内容。`, "err");
        // #552：提前退出也停观察器，不留长期挂载
        try { stopParseOverlayObserver(); } catch (e) {}
        resolve({ ok: false, error: "no mappings", scanned: fields.length });
        return;
      }

      let _dismissTick = 0;
      for (const m of mappings) {
        const el = document.querySelector(`[${ATTR}="${m.idx}"]`);
        if (!el) continue;
        // v0.8.17（#364）：京东基本信息卡的下拉/单选/级联由 jdFillBasicCard 按标签填充，
        // 主循环此处跳过，避免 scanFields 序号与京东原生 data-rfa-idx 错配导致串台/误填。
        if (/campus\.jd\.com/i.test(location.hostname)) {
          const _b = el.closest('[class*="formGroupItem___"]');
          if (_b && _b.querySelector('[data-rfa-idx="1"]') && el.closest(".ant-radio-group, .ant-select, .ant-cascader-picker, .ant-cascader")) {
            continue;
          }
        }
        const f = fields.find((x) => x.idx === m.idx);
        // #561b（北森）：长表单的字段多在视口外（北森表单 2000px+），
        // 组件点击/输入对不可见元素无效 → 填充前统一滚到可见。对其它站点无副作用。
        try { el.scrollIntoView({ block: "center" }); await sleep(120); } catch (e) {}
        const ok = await fillFieldGuarded(el, m.value, f);
        highlight(el, ok ? "ok" : "warn");
        if (ok) {
          filled++;
          filledIdx.add(m.idx);
          const sec = (f && f.section) || "unknown";
          sectionHits[sec] = (sectionHits[sec] || 0) + 1;
        }
        // v0.7.3（#200）：填充中途也可能冒出腾讯悬浮弹窗，周期性探测点掉（不阻断主流程）
        if ((++_dismissTick) % 12 === 0) {
          try { tryDismissParseOverlayOnce(); } catch (e) {}
        }
      }

      // ---- v0.6.70：级联字段二次填充 ----
      // 美团教育经历是「学校名称 → 学院名称 → 专业名称」三级级联，主循环一次跑不完：
      //   · 没选学校前，「专业名称」下拉是 disabled 的，isFillable 直接过滤掉，scanFields 根本扫不到它；
      //   · 选中学校后 React 会重建「学院/专业」这两个下拉的 DOM 节点，
      //     扫描时打在旧节点上的 data-rfa-idx 标记随之丢失，
      //     主循环里 document.querySelector 拿到 null 就 continue 了 —— 于是「学院名称」
      //     明明匹配到了值（档案里有 college），却一次都没被填过，日志里连一条记录都没有。
      // 解法：主循环结束后重新扫描 + 重新匹配，只补填「此刻仍为空」的字段。
      // 三级级联最多需要 2 轮（第 1 轮补学院，第 2 轮补解锁后的专业）；某轮没补上任何字段就提前收工。
      const cascadeRefill = async (round) => {
        await sleep(600); // 等上一轮选中触发的 React 重渲染稳定
        const reFields = scanFields();
        if (!reFields.length) return 0;
        // 必须用「完整字段列表」跑匹配：fallbackMap 内部按板块锚点递增条目下标，
        // 只传空字段会让第 2 张卡的「学院名称」被当成第 1 条，取错数据。
        let reMap = fallbackMap(reFields, profile).filter((m) => {
          const f = reFields.find((x) => x.idx === m.idx);
          return f && validateValueForField(m.value, f);
        });
        const seenRe = new Set();
        reMap = reMap.filter((m) => {
          if (seenRe.has(m.idx)) return false;
          seenRe.add(m.idx);
          return true;
        });
        // v0.8.15（#287）：二次补漏必须走和主映射同一道「零需求板块」过滤器。
        // 安踏 R1 实测：主映射把工作经历卡正确留空（map-table 7 行全 ∅），
        // 结果这里重新 fallbackMap 又把 internships[0] 灌了进去，
        // 同一段字节实习在「工作经历」和「实习经历」各出现一次。
        reMap = filterZeroSectionMappings(reMap, reFields, profile, "refill" + round);

        const pending = [];
        for (const m of reMap) {
          const el = document.querySelector(`[${ATTR}="${m.idx}"]`);
          if (!el) continue;
          if (el.disabled) continue;
          // 已填的绝不重填：mtd 下拉再点一次会把已选值清掉
          if (isFieldFilled(el)) continue;
          pending.push({ el, m, f: reFields.find((x) => x.idx === m.idx) });
        }
        if (!pending.length) return 0;

        rfaLog({
          act: "refill-round",
          round,
          pending: pending.length,
          labels: pending.slice(0, 12).map((p) => (p.f && p.f.label) || ""),
        });

        let n = 0;
        for (const p of pending) {
          const ok = await fillFieldGuarded(p.el, p.m.value, p.f);
          highlight(p.el, ok ? "ok" : "warn");
          if (ok) {
            n++;
            const sec = (p.f && p.f.section) || "unknown";
            sectionHits[sec] = (sectionHits[sec] || 0) + 1;
          }
        }
        rfaLog({ act: "refill-done", round, tried: pending.length, filled: n });
        return n;
      };

      for (let round = 1; round <= 2; round++) {
        const n = await cascadeRefill(round);
        filled += n;
        total += n;
        if (!n) break;
      }

      // v0.8.x（#404 京东荣誉奖励）：奖项类型在主循环/级联回填之后才被设进 UI，
      // 而「级别 / 名称」是奖项类型选定后才会揭示的子字段。上面 line 9781 的二轮补填
      // 虽已自助选类型，但主循环随后重设奖项类型可能冲掉已填的级别/名称。
      // 此处作为最后兜底，在所有回填结束后再跑一次，保证级别/名称最终落库。
      try { await jdFillAwards(profile); } catch (e) {
        rfaLog({ act: "jd-award-final-err", err: String((e && e.message) || e) });
      }

      // v0.6.48/v0.6.51：对「插件未匹配 / 故意不填 / 无数据 / 校验失败」的空字段统一标黄。
      // 不再依赖 scanFields 的 idx 去 querySelector，而是直接兜底扫描页面上所有可见可填元素。
      // 这样能避免 scanFields 因时序/懒加载/动态渲染漏掉字段（如语言能力-精通程度、申请信息-是否为全日制）。
      // 站点专属/主观决策字段（调剂/全日制/精通程度等）因为本就留空，仍会标黄提醒用户手动处理。
      //
      // ── v0.8.40（2026-08-14 · A2 修复「填对了还标黄」）─────────────────────────────
      // 旧实现只对**空字段**补标黄，从不清除已填字段上的**旧黄框**，于是出现顽固误标黄：
      //   京东：基本信息卡（国家/地区、民族、所在城市、证件类型）由 jdFillBasicCard 专门填，
      //         主循环 continue 跳过 → 这些 idx 没进 filledIdx → cascadeRefill 判定为 pending
      //         → 又填一遍且返回 ok=false → 9637 行 highlight(el,"warn") 打上黄框；
      //         等走到这里时 isFieldFilled 已判「已填」→ 不再补标黄，**但旧黄框没人擦** → 永久留黄。
      //   安踏/大疆(Moka sd-Select)：身份证、精通程度 display-value 已选、placeholder 已清空，
      //         同样是「早期 ok=false 打黄 → 后期判已填但不擦」→ 用户实测「填对了还标黄」。
      // 改法：最后统一按「当前 DOM 真实状态」全量刷一遍——已填 → highlight(el,"ok")（擦掉黄框），
      // 空 → highlight(el,"warn")。以真实状态为唯一依据，杜绝任何中间态残留，且对全站通用。
      repaintWarnByRealState("pre-cleanup");

      // 清理教育板块多余的空白卡片（页面默认预创建了 N 条，用户档案只有 K 条 → 删 N-K 条）
      rfaLog({ act: "pre-cleanup", t: Date.now() });
      // v0.7.1（#185 收尾）：曾在此空等 25s，理由是「空卡删除按钮懒渲染」——经 DOM 解剖证伪：
      // 腾讯空卡的「删除学历」按钮自始至终就在卡片内且可见，无需等待。只留短暂等待让 DOM 稳定。
      await sleep(1500);
      await cleanupEmptyEducationCards(profile);
      // v0.7.3（#198）：删掉「语种下拉为空」的语言卡片（页面不支持的语种，如普通话）
      await cleanupEmptyLanguageCards(profile);
      // v0.8.15（#287）：应届生无 work 数据时，删掉被误填出内容的「工作经历」卡
      await cleanupZeroNeedWorkCards(profile);
      // v0.8.13（字节·用户铁律 2026-08-21）：语言/社交板块「主下拉为空」的卡片必删——
      // 语言名/平台在页面下拉里没有对应选项（普通话/小红书/B站等 picked:null）时，
      // 不留空白卡（用户明确：没有就不做、删掉）。cleanupEmptyLanguageCards 的 maxRemovable
      // 上限（totalCards−langNeed）会禁止删这种卡，这里独立兜底，只对字节站生效。
      await removeBlankMainSelectCardsByte();

      // v0.8.40（A2 加固）：清卡会让框架（React/Vue）重建剩余卡片的 DOM 节点，
      // inline style 上的黄框随节点一起消失；同时删卡后原本被遮住的空字段可能才露出来。
      // 所以在三步清卡**之后**再做一次全量重绘「定妆」——函数幂等，重复调用无副作用。
      await new Promise((r) => setTimeout(r, 600)); // 等框架重排稳定，否则量到的是中间态
      repaintWarnByRealState("post-cleanup");

      // 文件上传（作品集 / 简历）已在 runAutofill 开头独立执行，此处保留 worksArr 供未填面板使用。
      const worksArr = (works || []).filter(Boolean);

      // 未填字段面板（返回字段清单，用于数据上报）
      const combinedVault = Object.assign({}, fileVault);
      worksArr.forEach((w, i) => {
        const att = w.attachment || w.video || w.pdf;
        if (att) combinedVault["work_attachment_" + i] = att;
      });
      const unfilledList = buildUnfilledPanel(fields, filledIdx, combinedVault);
      const unfilledLabels = unfilledList.map((x) => x.label);

      const sourceHint = source === "fallback" ? "（兜底规则）" : "";
      showToast(
        `填充完成${sourceHint}：${filled}/${total} 个字段。黄色=未填/需确认。请检查后再提交。`,
        "ok"
      );
      // 不再在填充中途弹窗（会过早叫回）。完成信号留给跑批脚本在审计后统一弹窗+响铃。
      try { window.__RFA_DONE__ = { filled, total, unfilled: unfilledList.length + (fileManual ? 1 : 0), source }; } catch (e) {}
      // #552 铁律（2026-08-26）：填完一轮即死，立即停掉弹窗观察器，不再长期挂载反应。
      try { stopParseOverlayObserver(); } catch (e) {}
      resolve({
        ok: true,
        uploadPending: !!fileManual,
        filled,
        total,
        scanned: fields.length,
        unfilled: unfilledList.length + (fileManual ? 1 : 0),
        source,
        unfilledFields: unfilledLabels,
        sectionHits,
        hasFile: !!(fileVault && fileVault.resume),
      });
    })();
  });
}

/* ================= 页面内可拖动面板（整块插件界面注入页面，可随意拖动） ================= */
let rfaPanelEl = null;
let rfaBallEl = null;

/* ================= 悬浮小球（FAB）+ 助手卡片 =================
 * 设计定稿（浅紫柔光，只用产品紫 #9b7bff / #7c5cff / #f6f4ff）：
 *  - 小球钉在助手卡片右上角，只左下1/4压住卡片、3/4露在外面；
 *  - 浅紫柔光渐变 + 白色外环/浅紫光晕，与卡片紫色头分开；
 *  - 自由定位（抓到哪停哪，无磁吸），位置存 localStorage fab_card_pos_v3；
 *  - 拖动小球带动卡片；点击小球（无位移）切换卡片展开/收起；
 *  - 卡片含：版本块（通用版/AI运营版/作品集版 单选）+ ⚡一键投递/🔍标黄查漏/🔄同步到插件/⤢放大面板。
 */
let rfaCardEl = null;       // 助手卡片
let rfaCardOpen = false;    // 卡片默认收起（用户要求：刷新后只留球，不展开）
const RFA_CARD_W = 280;     // 卡片宽
let rfaCardX = 0, rfaCardY = 0; // 卡片主体坐标（视口）
// 在我们的「网页版 / 开发者页面」上不注入悬浮小球与助手卡片（小球只留在招聘站等真实页面，避免与网页自身 UI 冲突）
function RFA_onWebapp() {
  try {
    const h = location.hostname, p = location.port;
    // 本地开发者页面（intel-server 后端：localhost:3000 / 127.0.0.1:3000）
    if ((h === "localhost" || h === "127.0.0.1") && p === "3000") return true;
    // 已部署的 Get Offer 网页版：页面含专属元素 #rfaJobImport（CSV 导入按钮，常态隐藏但必在 DOM）
    if (document.getElementById("rfaJobImport")) return true;
  } catch (e) {}
  return false;
}
// —— 关闭 / 再打开 悬浮助手（用户要求：能"叉掉"） ——
// 设计：× 只隐藏「当前页面」（内存态，不写任何持久存储）；刷新或切到别的页面后 content.js 会
// 重新初始化，小球自动重新出现。扩展弹窗里的「显示/隐藏悬浮助手」通过消息通道切换同一内存态，
// 因此不管用哪种方式重新出现，一律是「小球」形态（可拖动），不会直接弹出大版面。
let rfaHidden = false; // 当前页是否隐藏（仅内存，刷新即复位）

function rfaSetHidden(hidden) {
  rfaHidden = !!hidden;
  if (rfaHidden) { hideBall(); return; }
  // 重新显示：一律回到球形态（不自动展开版面），球可拖动
  rfaCardOpen = false;
  const b = ensureBall();
  if (b) b.style.display = "flex";
  if (rfaCardEl) rfaCardEl.style.display = "none";
}
function rfaCloseFab() { rfaSetHidden(true); }    // × 临时关闭（刷新后自动出现）
function rfaReopenFab() { rfaSetHidden(false); }   // 重新显示（球形态）

function rfaSetupGlobalListeners() {
  // 扩展弹窗「显示/隐藏悬浮助手」→ 通过消息通道切换到本页内存态
  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || !msg.action) return;
      if (msg.action === "rfa_toggle_fab") {
        rfaSetHidden(!rfaHidden);
        try { sendResponse({ hidden: rfaHidden }); } catch (e) {}
        return true;
      }
      if (msg.action === "rfa_get_fab_state") {
        try { sendResponse({ hidden: rfaHidden }); } catch (e) {}
        return true;
      }
    });
  } catch (e) {}
  // 快捷键 Alt+Q 切换显隐（备用）
  document.addEventListener("keydown", function (e) {
    if (e.altKey && (e.key === "q" || e.key === "Q")) { rfaSetHidden(!rfaHidden); }
  });
}

function ensureBall() {
  if (RFA_onWebapp()) return null;
  if (rfaBallEl && document.body && document.body.contains(rfaBallEl)) return rfaBallEl;

  // —— 样式（一次性注入，浅紫柔光，只用产品紫） ——
  const style = document.createElement("style");
  style.textContent =
    ".rfa-ball{position:fixed;width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;" +
    "background:linear-gradient(135deg,#9b7bff 0%,#7c5cff 100%);color:#fff;font-size:22px;cursor:grab;z-index:2147483647;" +
    "user-select:none;transition:transform .18s ease;" +
    "box-shadow:0 6px 18px rgba(124,92,255,.35),0 0 0 5px rgba(255,255,255,.85),0 0 22px rgba(255,255,255,.95),0 0 34px rgba(155,123,255,.35);}" +
    ".rfa-ball:active{cursor:grabbing;transform:scale(.96);}" +
    ".rfa-ball .rfa-ball-tip{position:absolute;top:-30px;left:50%;transform:translateX(-50%);background:#2c2c2c;color:#fff;" +
    "font-size:11px;padding:4px 9px;border-radius:7px;white-space:nowrap;opacity:0;transition:.15s;pointer-events:none;}" +
    ".rfa-ball:hover .rfa-ball-tip{opacity:1;}" +
    ".rfa-card{position:fixed;width:280px;background:#fff;border-radius:16px;z-index:2147483645;overflow:hidden;" +
    "box-shadow:0 14px 40px rgba(90,74,224,.18);" +
    "font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;}" +
    ".rfa-card .rfa-chead{background:linear-gradient(135deg,#9b7bff 0%,#7c5cff 100%);color:#fff;padding:14px 16px 24px;}" +
    ".rfa-card .rfa-chead .t{font-size:15px;font-weight:700;}" +
    ".rfa-card .rfa-chead .tip{font-size:11px;opacity:.85;margin-top:3px;}" +
    ".rfa-card .rfa-cbody{padding:14px 16px 16px;}" +
    ".rfa-card .rfa-vers-h{font-size:11px;font-weight:700;color:#5b6472;margin-bottom:7px;}" +
    ".rfa-card .rfa-vers-sel{width:100%;font-size:13px;padding:9px 10px;margin-bottom:14px;border-radius:10px;border:1.5px solid #d8d2f5;background:#F9F8FF;color:#3d3556;font-weight:600;cursor:pointer;appearance:auto;}" +
    ".rfa-card .rfa-acts{display:flex;flex-direction:column;gap:9px;}" +
    ".rfa-card .rfa-act{display:flex;align-items:center;justify-content:center;gap:7px;font-size:13.5px;font-weight:600;color:#fff;" +
    "border:none;padding:12px 14px;border-radius:11px;cursor:pointer;background:#9b7bff;transition:.15s;font-family:inherit;}" +
    ".rfa-card .rfa-act:hover{filter:brightness(1.05);}" +
    ".rfa-card .rfa-act.mag{background:#7c5cff;}" +
    ".rfa-card .rfa-tip2{font-size:12px;color:#7c5cff;min-height:16px;margin-top:8px;text-align:center;opacity:.95;font-weight:600;}" +
    ".rfa-close{position:absolute;top:-7px;right:-7px;width:18px;height:18px;border-radius:50%;background:#fff;color:#7c5cff;" +
    "font-size:13px;line-height:16px;text-align:center;cursor:pointer;z-index:2147483647;box-shadow:0 2px 6px rgba(60,40,160,.35);" +
    "border:none;font-weight:700;padding:0;}" +
    ".rfa-close:hover{background:#7c5cff;color:#fff;}" +
    ".rfa-chead{position:relative;}" +
    ".rfa-chead .rfa-x{position:absolute;top:10px;right:12px;width:22px;height:22px;border-radius:50%;" +
    "background:rgba(255,255,255,.28);color:#fff;border:none;font-size:15px;line-height:22px;cursor:pointer;}" +
    ".rfa-chead .rfa-x:hover{background:rgba(255,255,255,.5);}" +
    ".rfa-card .rfa-dismiss-tip{font-size:11px;color:#9aa0ad;margin-top:10px;text-align:center;}";
  document.documentElement.appendChild(style);

  // —— 助手卡片（主体） ——
  const card = document.createElement("div");
  card.className = "rfa-card";
  card.id = "rfa-card";
  card.innerHTML =
    '<div class="rfa-chead"><div class="t">秋招网申助手</div><div class="tip">点小球展开 / 收起 · 拖动小球可移动 · 点 × 暂时关闭（刷新后自动出现）</div><button class="rfa-x" title="暂时关闭（刷新页面会自动出现）">×</button></div>' +
    '<div class="rfa-cbody">' +
      '<div class="rfa-vers-h">选择简历版本</div>' +
      '<select class="rfa-vers-sel" id="rfa-quick-vers"></select>' +
      '<div class="rfa-acts">' +
        '<button class="rfa-act" id="rfa-bDeliver">⚡ 一键投递</button>' +
        '<button class="rfa-act" id="rfa-bMark">🔍 标黄查漏</button>' +
        '<button class="rfa-act" id="rfa-bSync">🔄 同步到插件</button>' +
      '</div>' +
      '<div class="rfa-tip2" id="rfa-tip2"></div>' +
    '</div>';
  document.body.appendChild(card);
  rfaCardEl = card;
  const tip2 = card.querySelector("#rfa-tip2");

  // —— 小球（钉在卡片右上角） ——
  const ball = document.createElement("div");
  ball.className = "rfa-ball";
  ball.id = "rfa-ball";
  ball.setAttribute("role", "button");
  ball.setAttribute("tabindex", "0");
  ball.setAttribute("title", "秋招网申助手 · 点击展开 / 收起 · 拖动可移动");
  ball.innerHTML = '✦<span class="rfa-ball-tip">秋招网申助手 · 拖动我</span><button class="rfa-close" title="暂时关闭（刷新页面会自动出现）">×</button>';
  document.body.appendChild(ball);
  rfaBallEl = ball;

  // —— × 关闭按钮（小球角标 + 卡片头） ——
  const closeBtn = ball.querySelector(".rfa-close");
  if (closeBtn) {
    closeBtn.addEventListener("mousedown", function (e) { e.stopPropagation(); e.preventDefault(); });
    closeBtn.addEventListener("click", function (e) { e.stopPropagation(); e.preventDefault(); rfaCloseFab(); });
  }
  const headX = card.querySelector(".rfa-x");
  if (headX) headX.addEventListener("click", function (e) { e.stopPropagation(); e.preventDefault(); rfaCloseFab(); });

  // —— 定位：小球钉卡片右上角，左下 1/4 压住卡片 ——
  function place() {
    card.style.left = rfaCardX + "px";
    card.style.top = rfaCardY + "px";
    card.style.display = rfaCardOpen ? "block" : "none";
    // 球钉卡片左上角（用户要求球在左边，故改到左侧）→ 球左 = 卡左 - 28；球顶 = 卡顶 - 28
    ball.style.left = (rfaCardX - 28) + "px";
    ball.style.top = (rfaCardY - 28) + "px";
    // 大面板：钉在小球左下（小球右上角压大面板右上角），始终位于小球下方
    if (rfaPanelEl && rfaPanelEl.style.display !== "none") {
      clampPanelToViewport(rfaPanelEl);
    }
  }
  function clampPos() {
    const maxX = window.innerWidth - RFA_CARD_W - 10;
    const maxY = window.innerHeight - 150;
    rfaCardX = Math.min(Math.max(rfaCardX, 10), Math.max(10, maxX));
    rfaCardY = Math.min(Math.max(rfaCardY, 10), Math.max(10, maxY));
  }
  function initPos() {
    // 用户要求：刷新后默认收成球、钉在「左边中间」，不恢复历史拖拽位置
    rfaCardX = 40;
    rfaCardY = Math.round(window.innerHeight / 2);
    clampPos();
    place();
  }
  initPos();
  // 视口变化时重新夹紧，避免滚出屏幕
  window.addEventListener("resize", function () { clampPos(); place(); });

  // —— 拖动 + 点击切换 ——
  // 位移超过阈值视为拖动（移动卡片 + 小球跟随 + 存位置），未超阈值视为点击（切换卡片展开/收起）。
  let drag = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
  ball.addEventListener("mousedown", function (e) {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = true; moved = false;
    sx = e.clientX; sy = e.clientY; ox = rfaCardX; oy = rfaCardY;
    ball.style.transition = "none";
  });
  document.addEventListener("mousemove", function (e) {
    if (!drag) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && Math.hypot(dx, dy) > 4) moved = true;
    if (!moved) return;
    rfaCardX = ox + dx; rfaCardY = oy + dy;
    clampPos(); place();
  });
  document.addEventListener("mouseup", function () {
    if (!drag) return;
    drag = false;
    if (!moved) {
      // 视作点击：切换卡片展开 / 收起
      rfaCardOpen = !rfaCardOpen;
      place();
    } else {
      // 拖动：保存位置（自由定位，无磁吸）
      try { localStorage.setItem("fab_card_pos_v3", JSON.stringify({ x: rfaCardX, y: rfaCardY })); } catch (e) {}
    }
  });

  // —— 版本下拉（动态读真实 profiles，切换 activeProfileId；下拉式可容纳任意数量版本） ——
  async function renderVers() {
    const box = card.querySelector("#rfa-quick-vers");
    if (!box) return;
    const store = await new Promise(function (r) { chrome.storage.local.get(["profiles", "activeProfileId"], r); });
    const list = store.profiles || [];
    const activeId = store.activeProfileId;
    box.innerHTML = "";
    list.forEach(function (p) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = (p.name || "未命名") + (p.data ? "" : "（空）");
      if (p.id === activeId) o.selected = true;
      box.appendChild(o);
    });
    if (!list.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "暂无档案";
      box.appendChild(o);
    }
  }
  renderVers();
  // 下拉选择切换版本：立即写 activeProfileId（填充时 __RFA.run 实时读它）
  const versSel = card.querySelector("#rfa-quick-vers");
  if (versSel) {
    versSel.addEventListener("change", async function () {
      const id = versSel.value;
      if (!id) return;
      await new Promise(function (r) { chrome.storage.local.set({ activeProfileId: id }, r); });
      tip2.textContent = "已选版本：" + (versSel.selectedOptions[0] ? versSel.selectedOptions[0].textContent : "");
    });
  }
  // 插件 profiles 被外部（网页同步）更新时，自动刷新版本面板
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === "local" && changes.profiles) { renderVers(); }
    });
  } catch (e) {}
  function curVer() {
    const s = card.querySelector("#rfa-quick-vers");
    return (s && s.value) ? s.value : "";
  }

  // —— ⚡ 一键投递（真实填充当前页，复用 window.__RFA.run 全套逻辑，只填不提交） ——
  card.querySelector("#rfa-bDeliver").addEventListener("click", function () {
    const v = curVer();
    tip2.textContent = "正在一键投递（" + v + "）哒哒哒哒…";
    try {
      const run = (window.__RFA && window.__RFA.run) ? window.__RFA.run : null;
      if (!run) { tip2.textContent = "⚠️ 插件未就绪，请刷新页面后重试"; return; }
      Promise.resolve(run()).then(function (r) {
        tip2.textContent = (r && r.ok)
          ? ("✅ 投递完成（" + v + "）")
          : ("⚠️ 投递未完成：" + ((r && r.error) || "未知"));
      }).catch(function (e) {
        tip2.textContent = "⚠️ 投递出错：" + (e && e.message ? e.message : e);
      });
    } catch (e) {
      tip2.textContent = "⚠️ 无法启动投递：" + (e && e.message ? e.message : e);
    }
  });
  // —— 🔍 标黄查漏（调用真实全量重绘标黄） ——
  card.querySelector("#rfa-bMark").addEventListener("click", function () {
    try {
      const r = repaintWarnByRealState("card-mark");
      tip2.textContent = "🔍 已标黄查漏：剩 " + (r && r.warn != null ? r.warn : 0) + " 个未填字段";
    } catch (e) { tip2.textContent = "🔍 已触发标黄查漏"; }
  });
  // —— 🔄 同步到插件 ——
  card.querySelector("#rfa-bSync").addEventListener("click", function () {
    const v = curVer();
    try {
      if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
        try { chrome.runtime.sendMessage({ action: "syncToPlugin", version: v }); } catch (e) {}
      }
    } catch (e) {}
    tip2.textContent = "🔄 已同步到插件（" + v + "）";
  });

  return ball;
}
function restoreBallPos() {
  // 卡片/小球位置现由 ensureBall() 内的 fab_card_pos_v3 统一管理，
  // 旧的 rfa_ball_pos（磁吸时代）不再使用，避免覆盖新定位。
  return;
}
function showBall() { if (RFA_onWebapp()) return; const b = ensureBall(); if (!b) return; restoreBallPos(); b.style.display = "flex"; }
function hideBall() { if (rfaBallEl) rfaBallEl.style.display = "none"; if (rfaCardEl) rfaCardEl.style.display = "none"; }
function collapseToBall() {
  if (RFA_onWebapp()) return;
  if (rfaPanelEl) rfaPanelEl.style.display = "none";
  showBall();
}
function rfaInitLauncher() {
  let _listenersReady = false;
  function go() {
    if (!_listenersReady) { rfaSetupGlobalListeners(); _listenersReady = true; }
    rfaSetHidden(false); // 每次页面加载都显示小球；× 仅是当前页临时隐藏
  }
  if (document.body) go();
  else document.addEventListener("DOMContentLoaded", go, { once: true });
}

function clampPanelToViewport(panelEl) {
  // #559（2026-08-26）：面板定位曾直接用 rfaCardX + RFA_CARD_W - pw，球被 clamp 到
  // 左缘 40px 时该式恒为负（40+280-440=-120），面板永远卡在左下角只露 1/4、拖不动。
  // 这里把面板夹紧在视口内：left/top 均取 [10, 视口-面板尺寸-10]，绝不超出屏幕。
  try {
    const pw = (panelEl.offsetWidth || 440);
    const ph = (panelEl.offsetHeight || 660);
    let left = rfaCardX + RFA_CARD_W - pw;
    let top = rfaCardY;
    const maxL = Math.max(10, window.innerWidth - pw - 10);
    const maxT = Math.max(10, window.innerHeight - ph - 10);
    left = Math.min(Math.max(left, 10), maxL);
    top = Math.min(Math.max(top, 10), maxT);
    panelEl.style.left = left + "px";
    panelEl.style.top = top + "px";
    panelEl.style.right = "auto";
    return { left, top };
  } catch (e) { return null; }
}

function openFloatPanel() {
  // #559：先恢复小球（作为面板的拖动把手）。用户此前点 × 关过球的话，
  // 球是 hidden 的 → 面板出现但无把手 → 「拖不动 + 小球不见了」。
  // 打开面板时强制回到球形态（卡片收起），球作为把手可拖动、可再收起。
  try { rfaSetHidden(false); } catch (e) {}
  // 已存在则重新显示并置顶
  if (rfaPanelEl && document.body.contains(rfaPanelEl)) {
    rfaPanelEl.style.display = "flex";
    rfaPanelEl.style.zIndex = "2147483646";
    // 重新钉到小球左下（小球位置可能已变化），并夹紧在视口内
    clampPanelToViewport(rfaPanelEl);
    // 若被收起了，重新加载 iframe 保证数据最新
    const f = rfaPanelEl.querySelector("iframe");
    if (f && !f.src) f.src = chrome.runtime.getURL("popup.html") + "?mode=float&t=" + Date.now();
    return;
  }

  const panel = document.createElement("div");
  panel.className = "rfa-panel";
  panel.innerHTML = `
    <div class="rfa-panel-head">
      <span class="rfa-panel-title">秋招网申助手</span>
      <button class="rfa-panel-close" title="收起，回到小卡片">收起 ✕</button>
    </div>
    <div class="rfa-panel-body"></div>
  `;
  const body = panel.querySelector(".rfa-panel-body");
  const frame = document.createElement("iframe");
  frame.src = chrome.runtime.getURL("popup.html") + "?mode=float&t=" + Date.now();
  frame.setAttribute("frameborder", "0");
  frame.setAttribute("allow", "clipboard-read; clipboard-write");
  frame.setAttribute("allowtransparency", "true");
  body.appendChild(frame);
  // 隐藏 popup.html 自带的 #closePopup：iframe 内 window.close 对我们面板无效，
  // 保留它会和面板拖动手柄并存两个 ×，体验割裂。注入样式直接藏掉原生关闭键。
  frame.addEventListener("load", function () {
    try {
      const doc = frame.contentDocument;
      if (doc && doc.head) {
        const s = doc.createElement("style");
        s.textContent = "#closePopup{display:none!important}";
        doc.head.appendChild(s);
      }
    } catch (e) {}
  });

  const style = document.createElement("style");
  style.textContent = `
    .rfa-panel{position:fixed;left:0;top:0;width:440px;height:660px;max-width:96vw;max-height:94vh;
      background:#fff;border-radius:12px;box-shadow:0 12px 44px rgba(0,0,0,.28);z-index:2147483646;
      display:flex;flex-direction:column;overflow:hidden;
      font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
      min-width:320px;min-height:420px;resize:both;}
    .rfa-panel-head{height:40px;flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:0 12px;
      background:#7c5cff;color:#fff;user-select:none;font-size:13px;border-radius:12px 12px 0 0;}
    .rfa-panel-title{font-weight:600;white-space:nowrap;flex:1;}
    .rfa-panel-close{border:none;background:rgba(255,255,255,.18);color:#fff;font-size:12px;
      padding:5px 10px;border-radius:8px;cursor:pointer;font-family:inherit;}
    .rfa-panel-close:hover{background:rgba(255,255,255,.32);}
    .rfa-panel-body{flex:1;min-height:0;position:relative;}
    .rfa-panel-body iframe{position:absolute;inset:0;width:100%;height:100%;border:none;background:#fff;}
  `;
  document.documentElement.appendChild(style);

  // 统一由「小球」(把手)拖动带动本面板，面板自身不再独立拖动。
  // 收起按钮：隐藏大面板，回到小卡片（小球仍最上层、可继续拖动）。
  panel.querySelector(".rfa-panel-close").addEventListener("click", function () {
    panel.style.display = "none";
  });

  document.body.appendChild(panel);
  rfaPanelEl = panel;
  // 钉在小球左下（小球永远在最上层，大面板位于其下方），并夹紧在视口内（#559）
  clampPanelToViewport(panel);
}

/* ================= 清理教育板块多余的空白卡片 ================= */
// 页面默认会预创建 N 条教育空白模板（用户档案只有 K 条），填完后删除多余的空白卡片。
// 蔚来删除按钮：<svg data-icon="DeleteTrashOutlined">（用户提供确认）。
// 判断一个按钮是不是「删除这张经历卡片」的按钮。
// 蔚来/飞书系是垃圾桶图标；美团是文字按钮「删除这段经历」。
// 必须排除「删除附件/删除文件/移除」这类子级删除，否则会误删卡片里的上传文件。
function isDeleteCardButton(btn) {
  if (!btn) return false;
  if (btn.querySelector && btn.querySelector('svg[data-icon="DeleteTrashOutlined"]')) return true;
  const t = getText(btn).trim();
  if (!t || t.length > 12) return false;
  if (/附件|文件|图片|照片|视频/.test(t)) return false;
  // v0.7.1（#185 收尾）：腾讯教育卡删除按钮文案是「删除学历」（<BUTTON class="el-button el-button--text">删除学历</BUTTON>），
  // 既不带 DeleteTrashOutlined 图标、也不匹配原 /\^删除(这段|此段|该段|本段)?(经历|记录|信息)?\$/ 的「学历/教育」分支 ——
  // 导致 cleanupEmptyEducationCards 找不到删除按钮、永远删不掉多出的空白教育卡，
  // 那张空卡的必填项（学历*/学校名称*/起止时间*/院系*/专业*）一直挂在未填清单里，制造「还有一堆必填没填」的假象。
  // 这里补上腾讯系「删除学历 / 删除教育经历 / 删除当前教育经历 / 删除当前学历」等变体（仍排除附件/文件/照片类删除）。
  return (
    // v0.8.6（#273）：Moka 全家（app.mokahr.com + 大疆）的卡片删除按钮文案是**「删除本条」**，
    // 上面那条正则里只有「本段」没有「本条」，两条都匹配不到 → isDeleteCardButton 恒 false →
    // cleanupEmptyEducationCards 的「由删除按钮反推卡片容器」兜底拿到空数组，日志报 no-cards，
    // 于是每跑一轮页面就多留几张空白教育卡（robosense 实测堆到 5 张，档案只有 2 段），
    // 分母从 48 涨到 75、达标率被硬生生稀释掉一大截。
    /^删除(这段|此段|该段|本段|当前|本条|此条|该条)?(经历|记录|信息)?$/.test(t) ||
    /删除这段经历|删除该经历|删除此条|删除本条|删除学历|删除教育经历|删除当前教育经历|删除当前学历/.test(t)
  );
}

function isAntSelectEmpty(sel) {
  try {
    // ── v0.8.17（#289 蔚来）：先按「显示值」判定，再看 placeholder ──────────────
    // 老实现的两个致命误判（实测把**填好的日语卡**也删了）：
    //  ① 飞书 UD Select 选中后，placeholder 节点**并不会从 DOM 移除**，只是被 CSS 藏起来。
    //     `querySelector("[class*='placeholder']")` 依旧命中 → 一律判空。
    //  ② `[class*='placeholder']` 通配太狠，连搜索框的 placeholder 壳子都算数。
    // 正确口径：飞书的真实选中值在 .ud__select__selector__content 里，且容器会挂
    // `ud__select__selector-not-empty`；有实值就是非空，直接短路返回。
    const cls = typeof sel.className === "string" ? sel.className : "";
    if (/selector-not-empty/.test(cls) || sel.querySelector("[class*='selector-not-empty']")) return false;
    // v0.8.40（A1 · 美团 mtd 组件）：mtd-select 的**真实选中值**在
    //   <span class="mtd-select-filter-label" title="普通话">普通话</span>
    // 里，内部 <input value=""> 永远是空串，且 class 不含 display-value/selection-item。
    // 漏读它 → 填好的语言卡被判空 → 被 cleanupEmptyLanguageCards 当空卡删掉
    // （08-13 实测：英语/日语两张已填卡的下拉控件被整个摘掉，页面只剩 label）。
    const disp = sel.querySelector(
      "[class*='select__selector__content'], [class*='ant-select-selection-item'], [class*='display-value'], [class*='selected-value'], [class*='select-filter-label'], [class*='select-selected']"
    );
    if (disp) {
      let dv = (disp.innerText || disp.textContent || "").trim();
      const ph = disp.querySelector("[class*='placeholder']");
      if (ph) dv = dv.replace((ph.innerText || ph.textContent || "").trim(), "").trim();
      if (dv && !/^(请选择|请输入|未选择|select|please)/i.test(dv)) return false; // 有实值 → 非空
    }
    if (sel.querySelector(".ant-select-selection-placeholder")) return true;
    const t = (sel.innerText || "").replace(/\s+/g, " ").trim();
    if (!t || /请选择|未选择|选择语言|select language/i.test(t)) return true;
    return false;
  } catch (e) { return false; }
}

// ── v0.8.18（#290）：语言卡清理·三道护栏重写 ─────────────────────────────────
// 事故复盘（蔚来 R2）：原实现把「语言能力」**整个板块容器**当成卡片删掉了，
// 结果 3 张已填好的语言卡（英语/日语/普通话）连同板块一起消失，页面只剩「添加」。
// 三处致命缺陷：
//   ① 兜底分支用 `li, section` 做卡片选择器 + 只看前 40 字含「语言」→ 板块标题必然命中，
//      板块的第一个 select（可能是第 1 张卡里的）为空就把整个板块塞进 toRemove。
//   ② 第一个分支只判下拉空不空，**完全不看卡里其它字段是否已填**，
//      配合 isAntSelectEmpty 的误判（飞书选中后 placeholder 节点仍留 DOM）直接团灭。
//   ③ toRemove 里祖先 + 后代同时存在时，删祖先＝连坐删掉所有兄弟卡。
// 现在的规则：只删「多余的、彻头彻尾空白的」卡，且删除数量有硬上限。
function langCardHasAnyValue(c) {
  try {
    const hasInput = Array.from(c.querySelectorAll("input,textarea")).some(
      (i) => i.type !== "checkbox" && i.type !== "radio" && (i.value || "").trim()
    );
    if (hasInput) return true;
    // 下拉的真实值往往只在展示 span 里（飞书 ud__select / Moka sd-Select / antd / element）
    // v0.8.40：补上美团 mtd（.mtd-select-filter-label）——它是「已填」的唯一痕迹，
    // 漏读会让已填语言卡被判空并遭清理器删除。
    const DISPLAY =
      ".ud__select__selector__content, .display-value, .ant-select-selection-item, " +
      ".el-select__selected-item, [class*='selected-item'], [class*='selectedValue'], " +
      "[class*='select-filter-label'], [class*='select-selected']";
    return Array.from(c.querySelectorAll(DISPLAY)).some((s) => {
      const t = (s.textContent || "").trim();
      return t && !/请选择|请输入|未选择|select|choose/i.test(t);
    });
  } catch (e) {
    return true; // 判不了就当有值 —— 宁可不删，绝不误删
  }
}
// 板块容器 vs 单张卡：板块里必然有「添加/新增」按钮，卡片里没有
function looksLikeSectionBox(c) {
  try {
    const btns = Array.from(c.querySelectorAll("button,[role='button'],[class*='Button'],a,span"));
    return btns.some(
      (b) => isVisible(b) && /^\s*[+＋]?\s*(添加|新增|添加语言|add)\s*[+＋]?\s*$/i.test((b.textContent || "").trim())
    );
  } catch (e) {
    return true; // 判不了就当是板块 —— 不删
  }
}
// v0.8.33（#316）：判断一张语言卡是否「语言名(类型)下拉为空」。
// 修复非分数型站点（字节/蔚来/小鹏）残留「多一个空白语言卡」：
// 页面预建/插件多建的卡里，语言类型下拉是空的，但「精通程度」被默认选中成「母语」，
// 旧逻辑 langCardHasAnyValue 只看了展示 span（含"母语"）→ 误判为有值 → 不删，
// 结果留一张连语种都没选的废卡。语言名都没选，程度/分数填了也提交不了，必删。
// ── v0.8.40（2026-08-14 · A1 关键修复）「把控件外壳误当成一张卡」────────────────
// 旧写法 dd.closest("[class*='form-item'], [class*='card'] …") 取的是**最近**祖先，
// 在美团 mtd 表单里命中的是 `.mtd-form-item-wrapper`（单个控件的外壳），
// 于是「一张语言卡」被拆成 7 个"卡"，删除时 c.remove() 摘掉 wrapper →
// 页面上 label 还在、下拉控件消失 = 用户看到的「空白卡」。真正的卡容器是 `.model_list`。
//
// 正确口径：从控件往上爬，第一个满足「是一段可重复记录」的容器才算卡：
//   · 含自带的删除按钮（删除这段信息 / 删除本条 / 删除学历…），或
//   · 内部含 ≥2 个字段 label（一条记录必然是多字段的）
// 并且显式跳过一切 *-wrapper / *-body / *-ctx 这类控件外壳，避免粒度错乱。
function resolveRepeatCard(el, cardSel) {
  try {
    // 控件外壳（*-wrapper / *-body / *-inner …）永远不是一条记录，直接跳过
    const SHELL_RE = /(wrapper|body|ctx|inner|content|control|affix|filter)/i;
    const isShell = (p) => SHELL_RE.test(typeof p.className === "string" ? p.className : "");
    const hasDelBtn = (p) =>
      Array.prototype.some.call(
        p.querySelectorAll("button,a,span,div,i"),
        (b) => isVisible(b) && isDeleteCardButton(b)
      );
    const labelCount = (p) => p.querySelectorAll("label, .label, [class*='form-item-label']").length;

    // 收集从控件到板块边界之间的祖先链（不越过含「添加」按钮的板块容器）
    const chain = [];
    let p = el.parentElement;
    for (let i = 0; i < 12 && p && p !== document.body; i++, p = p.parentElement) {
      if (looksLikeSectionBox(p)) break;
      if (!isShell(p)) chain.push(p);
    }
    if (!chain.length) return null;

    // 第一趟：「自带删除按钮」是一条可重复记录最可靠的标志（美团 .model_list 走这条）。
    // 注意不能拿 cardSel 做硬门槛 —— 美团真卡 class="model_list"，不匹配 CARD_SEL 里
    // 任何一项（card/form-item/listItem…），一旦硬过滤就永远返回 null（实测卡数=0）。
    for (const c of chain) if (hasDelBtn(c)) return c;

    // 第二趟：没有删除按钮的站点，退回「一条记录至少有 2 个字段 label」。
    // 此时才让 cardSel 参与打分：命中 cardSel 的优先，避免选到过大的容器。
    for (const c of chain) if (labelCount(c) >= 2 && cardSel && c.matches(cardSel)) return c;
    for (const c of chain) if (labelCount(c) >= 2) return c;

    // 一个都不满足：宁可返回 null（不删），也绝不返回粒度错误的容器
    return null;
  } catch (e) {
    return null;
  }
}

// ── v0.8.41 关键护栏：「开发语言」不是语言！（顶层函数，便于单测直接调用）──────────
// 京东实测事故：语言卡清理器按 /语言/ 收候选，把技能板块的
// 「*技能类型: 开发语言 / *开发语言: Python」整张卡当成语言卡，
// 一次删掉 4 张用户已填好的技能卡（Python/C++/JavaScript/Go）。
// 这与美团「已填语言卡被删」是同源事故的另一形态：判据太宽 → 删了真数据。
const LANG_LAB_RE = /语言|语种|language/i;
const NOT_LANG_LAB_RE = /开发语言|编程语言|程序语言|代码语言|技能|框架|技术栈|开发工具|programming/i;

// 卡片级判据：整张卡是「技能卡」而非「语种卡」
function isSkillNotLanguageCard(c) {
  try {
    // innerText 兜底 textContent：① jsdom 无 innerText；② 真机上隐藏/未布局节点的
    // innerText 会返回空串 → 会把技能卡漏判成"不是技能卡"，那正是误删的入口。
    // 判据宁可"多认成技能卡"（结果=不删），也绝不能漏判（结果=删掉真数据）。
    const t = String((c && (c.innerText || c.textContent)) || "")
      .replace(/\s+/g, " ")
      .slice(0, 600);
    return (
      /技能类型|开发语言|编程语言|技术栈|开发工具/.test(t) &&
      !/语言类型|语种|外语|语言能力|语言水平|掌握语言/.test(t)
    );
  } catch (e) {
    return false;
  }
}

// 标签级 + 卡片级双层判据：这个下拉是否真的是「语种」下拉
function isLanguageTypeDropdown(dd, cardSel) {
  try {
    const lab = getLabel(dd) || findNearestText(dd) || "";
    if (!LANG_LAB_RE.test(lab) || NOT_LANG_LAB_RE.test(lab)) return false;
    const card = resolveRepeatCard(dd, cardSel || "[class*='card'], [class*='Card'], .el-form-item, [class*='form-item']");
    if (card && isSkillNotLanguageCard(card)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function langNameSelectEmpty(c) {
  try {
    const SEL = ".el-dropdown, .ant-select, [class*='select'], [role='combobox'], [class*='combobox'], select";
    const nameRe = /语言类型|语言种类|语种|语言$/i;
    const dds = Array.from(c.querySelectorAll(SEL)).filter((dd) => {
      const lab = getLabel(dd) || findNearestText(dd) || "";
      // v0.8.41：/语言$/ 会命中「开发语言」→ 技能卡的开发语言下拉曾被当成语种名下拉。
      if (NOT_LANG_LAB_RE.test(lab)) return false;
      return nameRe.test(lab);
    });
    if (!dds.length) return false; // 找不到名下拉就不凭空删
    return dds.every((dd) => isDropdownEmpty(dd) || isAntSelectEmpty(dd));
  } catch (e) {
    return false;
  }
}
// v0.8.13（字节·用户铁律 2026-08-21）：语言/社交板块「主下拉（语言名/平台）为空」的卡片必删。
// 页面下拉没有该选项（普通话/小红书/B站等 picked:null）→ 不留空白卡。只对字节站生效，零影响其他站点。
async function removeBlankMainSelectCardsByte() {
  if (!/jobs\.bytedance\.com/i.test(location.hostname)) return;
  for (const title of ["语言能力", "社交账号"]) {
    for (let pass = 0; pass < 12; pass++) {
      const ws = Array.from(
        document.querySelectorAll("[class*='applyFormModuleWrapper']")
      ).filter((el) => getText(el).includes(title));
      const w = ws.filter((x) => /添加/.test(getText(x))).sort((a, b) => getText(a).length - getText(b).length)[0] || ws[0];
      if (!w) break;
      const cards = Array.from(w.querySelectorAll("[class*='apply-form-array-card__']"));
      let removed = false;
      for (const c of cards) {
        // 主下拉 = 卡内第一个可见 select（语言名 / 社交平台）
        const sels = Array.from(c.querySelectorAll(".ud__select, [class*='select']")).filter((s) =>
          isVisible(s)
        );
        if (!sels.length) continue;
        const mainTxt = getText(sels[0]).trim();
        if (mainTxt) continue; // 主下拉有值 → 保留
        // 主下拉为空 → 必删（页面无此选项），点删除按钮
        const del =
          c.querySelector("[class*='operate'] .ud__button--icon, [class*='operate'] button") ||
          c.querySelector("button.ud__button--icon") ||
          Array.from(c.querySelectorAll("button, [role='button']")).find((b) =>
            /删除|移除|remove|delete/i.test(getText(b).trim())
          );
        if (del) {
          try { simulateClick(del); removed = true; } catch (e) {}
          break; // 删一张后等 DOM 重建，下一轮再处理
        }
      }
      if (!removed) break;
      await sleep(1200);
    }
  }
  rfaLog({ act: "byte-blank-card-cleanup", done: true });
}

async function cleanupEmptyLanguageCards(profile) {
  // v0.7.3（#198）：字节/蔚来等「语言类型」是固定下拉选项。
  // 若档案里某语种（如普通话）页面下拉根本没有这个选项，matchField 填不进去会留一张空卡。
  // 这里在所有字段填完后，扫描语言类型下拉为空的卡片并删除 —— 实现「页面无此选项就不传」。
  try {
    const SEL = ".el-dropdown, .ant-select, [class*='select'], [role='combobox'], [class*='combobox']";
    const CARD_SEL =
      "[class*='card'], [class*='Card'], .el-form-item, .experience_box, [class*='form-item'], [class*='item-wrap'], [class*='listItem']";
    const emptyOf = (dd) => isDropdownEmpty(dd) || isAntSelectEmpty(dd);

    // v0.8.41：判据已上提为顶层 isLanguageTypeDropdown / isSkillNotLanguageCard
    // （见本文件上方，附京东技能卡误删事故说明），此处只做本卡选择器绑定，便于单测直连。
    const cardIsSkillNotLang = (c) => isSkillNotLanguageCard(c);
    const isLangDropdown = (dd) => isLanguageTypeDropdown(dd, CARD_SEL);

    // 候选卡：控件 label 含语言/语种（且非技能语义），向上找到最近的卡片容器
    const cand = new Set();
    Array.from(document.querySelectorAll(SEL)).forEach((dd) => {
      if (!isLangDropdown(dd)) return;
      if (!emptyOf(dd)) return;
      const card = resolveRepeatCard(dd, CARD_SEL);
      if (card) cand.add(card);
    });

    // 护栏①：剔除板块容器（含「添加」按钮的、或把别的候选卡整个包住的祖先）
    let cards = Array.from(cand).filter((c) => !looksLikeSectionBox(c));
    cards = cards.filter((c) => !cards.some((o) => o !== c && c.contains(o)));

    // 护栏②：卡里任何一个「非语言名」字段有值 → 一律保留（isAntSelectEmpty 误判的最后一道保险）。
    // 但若「语言名(类型)下拉为空」→ 必是空白废卡（连语种都没选，程度/分数填了也提交不了），
    // 无论其他字段是否有值都删 —— 修复非分数型站点残留的多余空白语言卡（#316）。
    const empties = cards.filter((c) => langNameSelectEmpty(c) || !langCardHasAnyValue(c));

    // 护栏③：删除数量硬上限 = 现有卡数 − 档案语种数，档案够多就一张都不许删
    // v0.8.40（A1 规格·关键修复）：这里原先用**未去重**的 profile.languages.length（种子=6：
    // 英语×4 + 日语 + 普通话），而建卡端 languagesForPage 已去重成 3 张 →
    // maxRemovable = 卡数 − 6 恒为 0 → **一张空白卡都不许删**，
    // 正是美团/飞书系「空白语言卡怎么都清不掉」的真凶。必须与建卡端用同一份去重后数组。
    const langNeed = languagesForPage(profile).length || 0;
    // v0.8.40：卡容器解析同样必须走 resolveRepeatCard —— 旧的 closest(CARD_SEL) 在美团
    // 会把每个控件外壳算成一张卡（实测 totalCards=7，真实只有 3 张），
    // 导致 maxRemovable = 7 − 3 = 4，白送 4 个删除额度去删「被误判为空」的已填卡。
    // 分母同样要用 isLangDropdown 过滤：京东实测分母被技能卡撑到 19（真实语言卡 0 张），
    // maxRemovable = 19 − 3 = 16 的删除额度就是那 4 张技能卡被删的直接原因。
    const totalCards = new Set(
      Array.from(document.querySelectorAll(SEL))
        .filter((dd) => isLangDropdown(dd))
        .map((dd) => resolveRepeatCard(dd, CARD_SEL))
        .filter(Boolean)
        .filter((c) => !looksLikeSectionBox(c))
    ).size;
    const maxRemovable = langNeed > 0 ? Math.max(0, totalCards - langNeed) : empties.length;
    const toRemove = empties.slice(0, maxRemovable);

    rfaLog({
      act: "lang-card-cleanup-plan",
      cand: cand.size,
      cards: cards.length,
      empties: empties.length,
      totalCards,
      langNeed,
      maxRemovable,
      willRemove: toRemove.length,
    });

    // ── v0.8.17（#289）：优先点卡片自带的「删除」按钮，而不是 c.remove() ──────────
    // 老实现直接把 DOM 节点摘掉，在 React/Vue 受控表单里等于「只骗过了眼睛」：
    // 组件 state 里那条记录还在，一次重渲染就原样长回来，提交时照样把空卡带给后端。
    let removed = 0;
    for (const c of toRemove) {
      const snippet = (c.innerText || "").slice(0, 24);
      // 最后一道保险：真要按下删除键之前，再确认这张卡不是技能卡（京东「开发语言」事故）。
      // 候选阶段已过滤过，这里重查一次是因为删卡会触发重渲染，卡引用可能已指向别的内容。
      if (cardIsSkillNotLang(c)) {
        rfaLog({ act: "lang-card-cleanup-skip", why: "skill-card-not-language", text: snippet });
        continue;
      }
      try {
        const delBtn = Array.prototype.find.call(
          c.querySelectorAll("button, a, span, div, i"),
          (b) => isVisible(b) && isDeleteCardButton(b) // 收元素而非文本：内部要读 svg 图标
        );
        if (delBtn) {
          simulateClick(delBtn);
          await sleep(700);
          await dismissConfirmIfAny();
          rfaLog({ act: "lang-card-cleanup", via: "btn", text: snippet });
          removed++;
          continue;
        }
        // ── v0.8.40（A1 关键修复）：绝不再用 c.remove() 兜底 ─────────────────────
        // 两条硬理由：
        //  ① 受控表单（React/Vue）里摘 DOM 只骗过眼睛，组件 state 里那条记录还在，
        //     一次重渲染就长回来，提交时照样把空卡带给后端；
        //  ② 一旦卡容器识别有偏差（美团实测把 .mtd-form-item-wrapper 当成卡），
        //     remove 会把**填好字段的控件**摘掉 → 用户看到「明明填对了却变成空白卡」。
        // 找不到删除按钮就放过这张卡，交给标黄提示用户手动删——宁可留一张空卡，
        // 也绝不弄坏已填数据。
        rfaLog({ act: "lang-card-cleanup-skip", why: "no-delete-button", text: snippet });
      } catch (e) {}
    }
    rfaLog({ act: "lang-card-cleanup", removed });
  } catch (e) {
    rfaLog({ act: "lang-card-cleanup-err", err: String((e && e.message) || e) });
  }
}

// ── v0.8.15（#287）：清掉「工作经历」板块里被误填出内容的卡片 ────────────────
// 场景：应届生档案 work=[]，但 Moka/飞书页面自带一张「工作经历」默认空卡。
// 主映射已正确留空（map-table 全 ∅），可二次补漏/兜底仍可能把 internships[0] 灌进去，
// 结果同一段实习在「工作经历」和「实习经历」各出现一次（大疆 R1、安踏 R1 均实测复现）。
// 映射侧已由 filterZeroSectionMappings 双点拦截；这里是最后一道 DOM 兜底：
// 板块需求为 0 却出现有内容的卡 → 点「删除本条」真删（DOM remove 不会同步到服务端，
// 大疆实测必须走真按钮 + 保存才落库）。空白卡不动，避免误删站点必需的占位卡。
async function cleanupZeroNeedWorkCards(profile) {
  try {
    if (getSectionNeeded(profile, "work") !== 0) return;
    if (!pageHasSection("internships")) return; // 页面只有工作经历时，实习数据本就该填进去
    let removed = 0;
    for (let guard = 0; guard < 6; guard++) {
      // 标题必须精确等于「工作经历」——「工作经验」是个人信息里的下拉字段，绝不能命中
      const head = Array.from(document.querySelectorAll("*")).find(
        (e) => e.children.length === 0 && /^\s*\*?\s*工作经历\s*$/.test(e.textContent || "")
      );
      if (!head) break;
      let box = head;
      for (let k = 0; k < 14 && box.parentElement; k++) {
        box = box.parentElement;
        if (/公司|单位|企业/.test(box.textContent || "")) break;
      }
      if (!/公司|单位|企业/.test(box.textContent || "")) break;
      // 越界保护：容器不能把「实习经历」也吞进来，否则会误删实习卡
      if (/实习经历/.test(box.textContent || "")) break;
      const hasValue = Array.from(box.querySelectorAll("input,textarea")).some(
        (el) => (el.value || "").trim() && el.type !== "checkbox" && el.type !== "radio"
      );
      if (!hasValue) break; // 空白卡保留
      const btn = Array.from(box.querySelectorAll("button,[class*='Button'],[role='button']")).find((b) =>
        isDeleteCardButton(b)
      );
      if (!btn) {
        rfaLog({ act: "work-card-cleanup-nobtn", txt: (box.innerText || "").slice(0, 40) });
        break;
      }
      simulateClick(btn);
      await sleep(900);
      await dismissConfirmIfAny();
      await sleep(500);
      removed++;
    }
    if (removed) rfaLog({ act: "work-card-cleanup", removed });
  } catch (e) {
    rfaLog({ act: "work-card-cleanup-err", err: String((e && e.message) || e).slice(0, 120) });
  }
}

async function cleanupEmptyEducationCards(profile) {
  try {
    const target = (profile && profile.education || []).length;
    rfaLog({ act: "cleanup-edu-ENTER", hasProfile: !!profile, eduLen: target });
    if (target <= 0) return;

    // v0.7.1（#185 收尾·根治）：此前多轮都在「数删除按钮的个数」上打转，全错。
    // 实测腾讯教育区 DOM（inspect-edu4 解剖）真相：
    //   卡1「当前教育经历」= .experience_box，14 个输入全填，**没有删除按钮**（固定首段，不可删）
    //   卡2「先前教育经历-1」= .experience_box，13 个输入全填，有可见「删除学历」
    //   卡3「先前教育经历-2」= .experience_box，13 个输入只填 1 个，**同样有可见「删除学历」**
    // 于是 delBtns=2、target=2（档案 2 段教育）→ 旧代码 `if (delBtns.length <= target) return` 直接早返回，
    // 永远不清理；而页面实际有 3 张卡（首段不带删除按钮、从没被计入），数量口径根本对不上。
    // 且「空卡删除按钮在板块层、需懒渲染等 25s」的假设也是错的：它一直在卡片内且可见。
    // 改为不靠数量猜 —— 逐卡判断「是否实质为空」，只删空卡，并保证剩余卡数 >= target。
    let eduSection = document.querySelector("li.send_box.educationBox");
    if (!eduSection) {
      eduSection = Array.from(document.querySelectorAll("li, section, div")).find(
        (x) =>
          /教育经历|教育背景|学历信息/.test((getText(x) || "").slice(0, 24)) &&
          x.querySelectorAll("input").length > 3
      );
    }
    const scope = eduSection || document;

    // 从某个元素向上找「卡片级容器」（无 .experience_box 类名的站点走这条兜底）
    function findCardFromEl(el) {
      let cur = el;
      for (let i = 0; i < 16 && cur; i++) {
        cur = cur.parentElement;
        if (!cur) break;
        const cls = (cur.className || "").toString();
        if (/experience_box|resume-card|card-item|el-card|mtd-card/.test(cls)) return cur;
        const inp = Array.from(cur.querySelectorAll("input, textarea")).filter(
          (e) => (e.type || "").toLowerCase() !== "file"
        );
        if (inp.length >= 4) return cur; // 教育卡至少含学历/学校/起止/专业等多个输入
      }
      return null;
    }

    // 收集教育卡片：优先 .experience_box（腾讯），否则由删除按钮反推容器并去重
    let cards = Array.from(scope.querySelectorAll(".experience_box"));
    if (!cards.length) {
      const seen = [];
      Array.from(scope.querySelectorAll("button, a, [role='button'], span"))
        .filter(isDeleteCardButton)
        .forEach((b) => {
          const c = findCardFromEl(b);
          if (c && seen.indexOf(c) < 0) seen.push(c);
        });
      cards = seen;
    }
    if (!cards.length) {
      rfaLog({ act: "cleanup-edu", note: "no-cards" });
      return;
    }

    // 「实质为空」判定：核心字段（学历 / 学校名称 / 专业）全部没值。
    // 不能用「一个值都没有」判空 —— 腾讯空卡自带 1 个默认/隐藏值输入（实测 filled=1），会被误判成已填。
    // v0.7.7（#259）：旧写法把「学历」也算进核心字段，而腾讯草稿残留的空卡往往
    // 学历=本科（被上一轮填过或站点默认），于是 core.every(空) 恒 false → 空卡永远删不掉。
    // 实测第三张卡：学历"本科"、学校名称/起止/院系/专业/排名/GPA 全空，却被判 "F"（已填）。
    // 改为：以「学校名称」为身份字段——学校名称空 = 这张卡就是垃圾卡，其余字段一概不看。
    // 另：只看可见输入（腾讯把导师/实验室/研究方向藏起来，且常残留脏值，会干扰判断）。
    function coreEmpty(card) {
      const inputs = Array.from(card.querySelectorAll("input, textarea")).filter(
        (e) => (e.type || "").toLowerCase() !== "file" && isVisible(e)
      );
      const labOf = (inp) =>
        (inp.getAttribute("data-rfa-label") || inp.getAttribute("placeholder") || "") +
        " " +
        (getText(inp.closest(".info_box") || inp.parentElement || inp) || "").slice(0, 40);
      const named = inputs.filter((inp) => /学校名称|院校名称|毕业院校|学校全称/.test(labOf(inp)));
      if (named.length) return named.every((inp) => !String(inp.value || "").trim());
      // 兜底：认不出学校名称时，退回「学历+专业」全空
      const core = inputs.filter((inp) => /请选择学历|学历|专业/.test(labOf(inp)));
      if (!core.length) return false; // 认不出核心字段 → 保守不删
      return core.every((inp) => !String(inp.value || "").trim());
    }

    // v0.7.7（#259）：改为「删一张 → 重扫一次」。旧写法一次性算出 removable 列表后连删，
    // 第一张删掉后 DOM 已重渲染，后面几个引用全是失效节点，点了没反应还白等 1.2s。
    const collectCards = () => {
      let cs = Array.from(scope.querySelectorAll(".experience_box"));
      if (!cs.length) {
        const seen = [];
        Array.from(scope.querySelectorAll("button, a, [role='button'], span"))
          .filter(isDeleteCardButton)
          .forEach((b) => {
            const c = findCardFromEl(b);
            if (c && seen.indexOf(c) < 0) seen.push(c);
          });
        cs = seen;
      }
      return cs;
    };
    const delBtnOf = (c) =>
      Array.from(c.querySelectorAll("button, a, [role='button'], span"))
        .filter(isDeleteCardButton)
        .filter((b) => {
          const tag = (b.tagName || "").toLowerCase();
          if (tag === "button" || tag === "a" || b.getAttribute("role") === "button") return true;
          return !b.closest("button, a, [role='button']"); // 一个删除按钮 BUTTON>SPAN 只留一个
        })[0] || null;

    const info0 = cards.map((c, i) => ({ i, empty: coreEmpty(c), del: !!delBtnOf(c) }));
    rfaLog({
      act: "cleanup-edu-scan",
      cards: info0.length,
      target,
      detail: info0.map((x) => x.i + (x.empty ? "E" : "F") + (x.del ? "D" : "-")).join(","),
    });

    // 【数据丢失熔断 · v0.7.7】每张已填卡的「学校名称」当身份指纹。删完一张后重新点名，
    // 只要有一张原本填好的卡凭空消失，立刻停止清理并大声记日志 —— 宁可留一张空卡，
    // 也绝不能把用户填好的经历删掉（08-07 已因此丢过一整段硕士经历）。
    const fingerprints = (cards2) =>
      cards2
        .map((c) => {
          const inp = Array.from(c.querySelectorAll("input, textarea")).filter(
            (e) => (e.type || "").toLowerCase() !== "file" && isVisible(e)
          );
          const s = inp.find((x) =>
            /学校名称|院校名称|毕业院校|学校全称/.test(
              (x.getAttribute("data-rfa-label") || x.getAttribute("placeholder") || "") +
                " " +
                (getText(x.closest(".info_box") || x.parentElement || x) || "").slice(0, 40)
            )
          );
          return s ? String(s.value || "").trim() : "";
        })
        .filter(Boolean)
        .sort()
        .join("|");

    let removed = 0;
    for (let round = 0; round < 8; round++) {
      const cs = collectCards();
      if (cs.length <= target) break; // 剩余卡数不得少于档案条数（保护已填卡）
      let hit = -1;
      for (let i = cs.length - 1; i >= 0; i--) {
        if (coreEmpty(cs[i]) && delBtnOf(cs[i])) { hit = i; break; }
      }
      if (hit < 0) {
        if (!removed) rfaLog({ act: "cleanup-edu", note: "nothing-to-remove", cards: cs.length, target });
        break;
      }
      const fpBefore = fingerprints(cs);
      const btn = delBtnOf(cs[hit]);
      rfaLog({ act: "cleanup-remove", idx: hit, txt: getText(btn).slice(0, 10) });
      simulateClick(btn);
      await sleep(900); // 等卡片删除动画 + 框架重渲染
      await dismissConfirmIfAny(); // 只在真·确认对话框里点确定
      await sleep(500);
      const fpAfter = fingerprints(collectCards());
      if (fpBefore && fpAfter !== fpBefore) {
        rfaLog({ act: "cleanup-ABORT-dataloss", before: fpBefore.slice(0, 80), after: fpAfter.slice(0, 80) });
        showToast("已填经历疑似被误删，已停止清理空白卡片", "err");
        break;
      }
      removed++;
    }
    if (removed) rfaLog({ act: "cleanup-done", removed, cards: collectCards().length });
  } catch (e) {
    showToast("清理教育空白时出错：" + (e && e.message || e), "err");
  }
}

// 删除卡片后若出现二次确认对话框（含「确定/删除/确认」按钮），自动点掉
//
// 【2026-08-07 事故复盘 · v0.7.7】旧写法在**整个 document** 里找文字含「删除/确定」
// 且长度 ≤6 的按钮就点。腾讯每张教育卡自带一颗「删除学历」按钮（4 个字、可见、
// 是真 <button>），于是在「压根没有确认框」的场景下，它顺手点掉了页面上第一张卡的
// 删除按钮 —— 实测把已填好的「硕士 · 示例学校」整段教育经历删没了，属于直接丢数据。
// 修正两点：① 只在**真正的模态对话框容器内部**找按钮；② 文字必须精确等于确认词，
// 「删除学历 / 删除经历」这种带宾语的一律不认（那是页面按钮，不是确认框按钮）。
const CONFIRM_DIALOG_SEL = [
  ".el-message-box", ".el-message-box__wrapper", ".el-dialog",
  ".ant-modal", ".arco-modal", ".mtd-modal", ".mtd-dialog", ".ivu-modal",
  "[role='dialog']", "[role='alertdialog']",
].join(",");
const CONFIRM_WORD_RE = /^(确定|确认|删除|移除|是|好的|好|ok|yes|confirm|delete|sure)$/i;

async function dismissConfirmIfAny() {
  for (let i = 0; i < 6; i++) {
    const dialogs = Array.from(document.querySelectorAll(CONFIRM_DIALOG_SEL)).filter(isVisible);
    for (const d of dialogs) {
      const btns = Array.from(d.querySelectorAll("button, [role='button'], .el-button"))
        .filter(isVisible)
        .filter((b) => CONFIRM_WORD_RE.test(getText(b).trim()));
      // 同时存在「确定」和「删除」时优先「确定」（Element MessageBox 的主按钮）
      const pick = btns.find((b) => /^(确定|确认|ok|confirm)$/i.test(getText(b).trim())) || btns[0];
      if (pick) {
        rfaLog({ act: "confirm-dialog-click", txt: getText(pick).trim().slice(0, 8) });
        simulateClick(pick);
        return true;
      }
    }
    await sleep(200);
  }
  return false; // 没有确认框 —— 属正常情况，绝不能退而求其次去点页面上的按钮
}

// 页面加载完成后，自动把插件里已保存的作品附件恢复到网页对应作品框。
// 只在用户开启开关（默认开）且当前页面有作品附件框时执行。
async function autoRestoreWorkAttachments() {
  // 远程调试安全开关：设置 localStorage.rfa_no_upload=1 可彻底禁止自动上传附件
  if (localStorage.getItem("rfa_no_upload") === "1") {
    rfaLog({ type: "auto_restore_skipped_by_flag" });
    return;
  }
  try {
    const r = await new Promise((resolve) => chrome.storage.local.get(["works", "options"], resolve));
    const works = r.works || [];
    const opts = r.options || {};
    if (opts.autoRestoreWorksAttachments === false) {
      rfaLog({ type: "auto_restore_disabled" });
      return;
    }
    // 2026-08-14（用户决策）：只恢复第一个作品集附件（与上传策略一致，避免整组错乱）
    const toRestore = works.map((w, i) => ({ w, i })).filter(({ w }) => w && w.attachment && w.attachment.storageKey).slice(0, 1);
    if (!toRestore.length) return;

    // 先等页面基本渲染
    await sleep(1500);
    if (!document.querySelector("input[type=file]")) return;

    // 等作品附件框出现（作品卡片是动态渲染的）
    let attempts = 0;
    while (attempts < 16) {
      const boxes = Array.from(document.querySelectorAll("input[type=file]")).filter((inp) => {
        const ctx = buildFileContext(inp).all;
        return /作品|portfolio|附件|attachment/.test(ctx);
      });
      if (boxes.length >= toRestore.length) break;
      await sleep(500);
      attempts++;
    }

    const usedInputs = new Set();
    for (const { w, i } of toRestore) {
      const att = w.attachment;
      let input = findFileInputFor("portfolio", usedInputs, att.name, i);
      if (!input) {
        const opened = await tryOpenUploadArea("portfolio");
        if (opened) input = findFileInputFor("portfolio", usedInputs, att.name, i);
      }
      if (!input) {
        rfaLog({ type: "auto_restore_miss", workIndex: i, name: att.name });
        continue;
      }
      // 框里已有文件：可能是网站记住了，或用户手动选了，不要覆盖
      if (input.files && input.files.length > 0) {
        usedInputs.add(input);
        rfaLog({ type: "auto_restore_skip_occupied", workIndex: i, name: att.name });
        continue;
      }
      const base64 = await loadFragmentedFileForUpload(att.storageKey);
      if (!base64) {
        rfaLog({ type: "auto_restore_load_fail", workIndex: i, name: att.name });
        continue;
      }
      const ok = await setFileInput(input, base64, att.name);
      if (ok) {
        usedInputs.add(input);
        rfaLog({ type: "auto_restore_ok", workIndex: i, name: att.name });
        showToast(`已自动恢复作品 #${i + 1} 附件：${att.name}`, "ok");
      } else {
        rfaLog({ type: "auto_restore_fail", workIndex: i, name: att.name });
      }
    }
  } catch (err) {
    rfaLog({ type: "auto_restore_error", error: err && err.message });
  }
}

function maybeAutoRestoreWorkAttachments() {
  // #552 铁律（2026-08-26 用户拍板）：插件跑完一轮即死，绝不自动反应。
  // 页面加载自动上传作品集附件曾在用户「点保存后」随页面刷新再次触发，
  // 把存储里的附件重新塞进文件框（真实事故：内置测试档案的附件覆盖了用户文件）。
  // 作品集附件只允许在用户主动点「一键填充」时由 runAutofill 上传，
  // 因此本函数不再被自动调用；保留定义仅为兼容旧引用，永不自动执行。
  return;
}
// #552：不再自动调用 maybeAutoRestoreWorkAttachments()（页面加载自动传附件已禁用）
// maybeAutoRestoreWorkAttachments();

// ===== 自动化调试钩子（远程调试用，可安全删除） =====
// 等价于在插件面板里点「一键填充」，但由外部（Playwright / 控制台）触发。
// 注意：本钩子只填充表单字段，绝不点击「提交 / 投简历 / 上传简历」等按钮。

// 版本探针：写入主世界可读的 DOM 属性，供驱动脚本校验“重载是否真的换上新代码”
try { document.documentElement.dataset.rfaVer = "0.8.10"; } catch (e) {}

// 长连接保活端口：页面注入即建立，保持 SW 温热，避免冷启动丢 LLM 映射消息
let RFA_PORT = null;
function rfaEnsurePort() {
  if (RFA_PORT) { try { if (RFA_PORT.error) RFA_PORT = null; } catch (e) {} }
  if (RFA_PORT) return RFA_PORT;
  try {
    RFA_PORT = chrome.runtime.connect({ name: "rfa-keepalive" });
    RFA_PORT.onDisconnect.addListener(() => { RFA_PORT = null; });
  } catch (e) { RFA_PORT = null; }
  return RFA_PORT;
}
rfaEnsurePort(); // 注入即建立，使 SW 在整个页面会话期间保持温热

// 经保活端口调用后台 mapFields，带 3 次重试 + 30s 超时（应对 SW 偶发唤醒竞态）
async function rfaMapFields(fields, profile) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const port = rfaEnsurePort();
    if (!port) { await new Promise((r) => setTimeout(r, 600)); continue; }
    const r = await new Promise((resolve) => {
      let done = false;
      const to = setTimeout(() => {
        if (!done) { done = true; resolve({ ok: false, error: "port_timeout" }); }
      }, 30000);
      const handler = (msg) => {
        if (msg && msg.__rfaMapResp) {
          done = true; clearTimeout(to);
          try { port.onMessage.removeListener(handler); } catch (e) {}
          resolve(msg);
        }
      };
      port.onMessage.addListener(handler);
      try {
        port.postMessage({ action: "mapFields", fields, profile });
      } catch (e) {
        done = true; clearTimeout(to);
        try { port.onMessage.removeListener(handler); } catch (e2) {}
        resolve({ ok: false, error: String(e) });
      }
    });
    if (r && r.ok) return r;
    RFA_PORT = null; // 强制下次重建端口
    await new Promise((r) => setTimeout(r, 600));
  }
  return { ok: false, error: "mapFields_failed_3x" };
}

// 重载桥接：主世界 dispatchEvent → 隔离世界监听到 → 调 chrome.runtime.reload()
document.addEventListener("rfa-reload", function () {
  try { chrome.runtime.reload(); } catch (e) {}
});

window.__RFA = {
  version: "0.7.0",
  ready: true,
  // 改完代码后由驱动脚本调用，自动重载扩展（等价于在 chrome://extensions 点刷新），无需人工点击
  reload: function () {
    try { chrome.runtime.reload(); console.log("[RFA] 扩展已重新加载，页面刷新后将注入新代码。"); }
    catch (e) { console.error("[RFA] reload 失败:", e); }
  },
  run: async function (options) {
    try {
      const store = await new Promise((res) =>
        chrome.storage.local.get(["profiles", "activeProfileId", "fileVault", "works"], res)
      );
      const profiles = store.profiles || [];
      const active = profiles.find((p) => p.id === store.activeProfileId) || profiles[0];
      if (!active || !active.data) {
        const msg = "[RFA] 没有可用的简历档案，请先在插件面板里保存一份。";
        console.error(msg);
        return { ok: false, error: "no_profile" };
      }
      const profile = active.data;
      const fileVault = store.fileVault || {};
      const works = store.works || [];
      const opts = (options && options.options) || {};
      console.log("[RFA] 开始自动填充，档案：", (profile.basic && profile.basic.name) || "(未命名)");
      window.__RFA_LAST = { startedAt: Date.now() };
      // v0.8.1（#265）：把「运行中 / 已完成」写进 DOM dataset。
      // 起因：百度 talent.baidu.com 有反调试——CDP 一执行 Runtime.enable，页面 2.5 秒内
      // 自己 location → about:blank 自毁（实测复现，稳定 100%）。而跑批端判断「填充完成」
      // 原本靠 Runtime.consoleAPICalled，那必须先 Runtime.enable，于是百度永远 0%。
      // 改成把完成信号写到 DOM 上（MAIN world 与 content script 共享同一个 DOM），
      // 跑批端只用 Runtime.evaluate 轮询即可，全程不碰 Runtime.enable。
      try {
        delete document.documentElement.dataset.rfaDone;
        delete document.documentElement.dataset.rfaErr;
        document.documentElement.dataset.rfaRun = String(Date.now());
      } catch (e) {}
      await runAutofill(profile, fileVault, opts, works);
      // 收尾：再清一遍弹窗（填充过程中触发的校验提示/保存确认），保证页面干净可验收
      try { await clearBlockingDialogs(8); } catch (e) {}
      // v0.7.6（#258）：删掉「多余的空白卡片」——页面自动存草稿会让历次运行新增的
      // 空经历/空作品卡片一直堆着，不清掉用户打开就是一大片黄框空白。
      try { await cleanupEmptyRepeatCards(15); } catch (e) { rfaLog({ act: "cleanup-error", err: String(e).slice(0, 120) }); }
      try { await clearBlockingDialogs(6); } catch (e) {}
      window.__RFA_LAST = {
        startedAt: window.__RFA_LAST.startedAt,
        doneAt: Date.now(),
        dialogs: (window.__RFA_DIALOGS || []).slice(0, 60),
      };
      try { document.documentElement.dataset.rfaDone = String(Date.now()); } catch (e) {}
      console.log("[RFA] 自动填充完成。");
      return { ok: true };
    } catch (e) {
      // 出错也要落 DOM 标记，否则不用 console 的跑批端会一直干等到超时
      try {
        document.documentElement.dataset.rfaErr = String(e && e.message ? e.message : e).slice(0, 200);
        document.documentElement.dataset.rfaDone = String(Date.now());
      } catch (e2) {}
      console.error("[RFA] 自动填充出错：", e);
      return { ok: false, error: String((e && e.stack) || e) };
    }
  },
  status: function () {
    return { ready: true, version: "0.7.0", last: window.__RFA_LAST || null };
  },
};
console.log("[RFA] 调试钩子已就绪，调用 window.__RFA.run() 触发填充。");

// 跨世界桥接：主世界（Playwright / 页面）派发 DOM 事件 -> 隔离世界里的钩子执行
document.addEventListener("__RFA_RUN__", function (e) {
  const opts = (e && e.detail) || {};
  Promise.resolve(window.__RFA.run(opts)).then(function (r) {
    document.dispatchEvent(new CustomEvent("__RFA_RUN_RESULT__", { detail: r }));
  }).catch(function (err) {
    document.dispatchEvent(new CustomEvent("__RFA_RUN_RESULT__", { detail: { ok: false, error: String(err) } }));
  });
});
document.addEventListener("__RFA_STATUS__", function () {
  document.dispatchEvent(new CustomEvent("__RFA_STATUS_RESULT__", { detail: window.__RFA.status() }));
});
// 档案概览：扁平化 profile，输出「路径 → 值预览」，用来判断某字段没填是"缺映射"还是"档案本来就空"
document.addEventListener("__RFA_PROFILE__", function () {
  const flat = {};
  function walk(obj, prefix, depth) {
    if (depth > 4 || obj == null) return;
    if (Array.isArray(obj)) {
      flat[prefix + ".[len]"] = obj.length;
      obj.slice(0, 3).forEach((v, i) => walk(v, prefix + "[" + i + "]", depth + 1));
      return;
    }
    if (typeof obj === "object") {
      Object.keys(obj).forEach((k) => walk(obj[k], prefix ? prefix + "." + k : k, depth + 1));
      return;
    }
    const s = String(obj);
    if (s !== "") flat[prefix] = s.length > 40 ? s.slice(0, 40) + "…" : s;
  }
  chrome.storage.local.get(["profiles", "activeProfileId"], function (store) {
    let detail;
    try {
      const profiles = store.profiles || [];
      const active = profiles.find((p) => p.id === store.activeProfileId) || profiles[0];
      walk((active && active.data) || {}, "", 0);
      detail = { ok: true, name: (active && active.name) || "", keys: Object.keys(flat).length, flat: flat };
    } catch (e) {
      detail = { ok: false, error: String(e) };
    }
    document.dispatchEvent(new CustomEvent("__RFA_PROFILE_RESULT__", { detail: detail }));
  });
});
// 导出内部运行日志 + 当前扫描到的字段（远程诊断用，不影响填充逻辑）
document.addEventListener("__RFA_LOG__", function () {
  let fields = [];
  try { fields = scanFields(); } catch (e) { fields = [{ error: String(e) }]; }
  let secs = [];
  try {
    secs = detectSections().map(function (s) {
      return { name: s.name, top: Math.round(s.top), text: getText(s.el).slice(0, 30), tag: s.el.tagName };
    });
  } catch (e) { secs = [{ error: String(e) }]; }
  document.dispatchEvent(new CustomEvent("__RFA_LOG_RESULT__", {
    detail: { version: "0.7.0", log: RFA_LOG.slice(-800), fields: fields, sections: secs },
  }));
});
// 只跑「附件上传」这一步（调试用）。完整填充要跑 80s+，而验证 ZIP/7Z/RAR/PDF 四种格式
// 需要反复试，没必要每次都把整张表重填一遍。此钩子不碰任何表单字段。
document.addEventListener("__RFA_UPLOAD__", function () {
  (async function () {
    try {
      const store = await new Promise((res) => chrome.storage.local.get(["fileVault", "works"], res));
      const fileVault = store.fileVault || {};
      const items = [];
      if (fileVault.resume) items.push({ cat: "resume", data: fileVault.resume });
      // 2026-08-14（用户决策）：调试上传钩子也只传第一个作品集附件，与主流程一致
      var _pfFirst = true;
      (store.works || []).filter(Boolean).forEach(function (w, i) {
        const att = w && (w.attachment || w.video || w.pdf);
        if (att && _pfFirst) { items.push({ cat: "portfolio", data: att, workIndex: 0 }); _pfFirst = false; }
      });
      const manual = await handleFileUploads(items);
      // #552：调试钩子跑完也即停观察器，不留长期挂载
      try { stopParseOverlayObserver(); } catch (e) {}
      document.dispatchEvent(
        new CustomEvent("__RFA_UPLOAD_RESULT__", { detail: { ok: true, manual: manual, n: items.length } })
      );
    } catch (err) {
      document.dispatchEvent(
        new CustomEvent("__RFA_UPLOAD_RESULT__", { detail: { ok: false, error: String((err && err.stack) || err) } })
      );
    }
  })();
});
document.addEventListener("__RFA_RELOAD__", function () {
  try { chrome.runtime.reload(); }
  catch (e) { document.dispatchEvent(new CustomEvent("__RFA_RELOAD_RESULT__", { detail: { ok: false, error: String(e) } })); }
});
// 外部把数据写进插件存储（档案 / apiKey 等），供自动填充前注入
document.addEventListener("__RFA_SETSTORAGE__", function (e) {
  const payload = (e && e.detail) || {};
  try {
    // 单版本合并：网页「立即同步到插件」推当前版本 → 合并进 profiles（不丢其他版本）
    if (payload.__rfa_sync_one) {
      const one = payload.__rfa_sync_one;
      chrome.storage.local.get(["profiles", "activeProfileId"], function (cur) {
        let profiles = Array.isArray(cur.profiles) ? cur.profiles : [];
        let found = false;
        profiles = profiles.map(function (p) {
          if (p.id === one.id) { found = true; return { id: p.id, name: one.name || p.name, data: one.data || p.data }; }
          return p;
        });
        if (!found) profiles.push({ id: one.id, name: one.name || "未命名", data: one.data || {} });
        // 文件字节单独存
        if (one.__files && typeof one.__files === "object") {
          chrome.storage.local.set({ ["rfa_files_" + one.id]: one.__files }, function () {
            // v0.8.13（08-21 用户反馈「简历 PDF 没上传到招聘官网」）：网页同步的文件之前只存
            // rfa_files_<id>，而 popup 一键投递读的是 fileVault —— 两者无桥，导致
            // fileVault.resume/photo 恒空，简历/证件照附件永远传不上招聘官网。
            // 这里把 __files 里的 resume/photo 按插件分片存储约定写入 fileVault。
            // ⚠️ v0.8.13b（08-21 用户实测「PDF 传不上官网」最终根因）：网页版 gatherSyncFiles
            //   的 rfaBlobToB64 输出的是【纯 base64（无 data: 前缀）】，而 setFileInput 解析
            //   用 `dataUrl.split(",")` 取 MIME —— 纯 base64 无逗号 → b64=undefined → 注入
            //   永远失败。popup 自己上传的文件（readAsDataURL）带前缀所以没事。
            //   此处写入分片前必须补成 data URL（对齐 popup 格式），否则简历/证件照静默传不上去。
            try {
              const files = one.__files || {};
              chrome.storage.local.get(["fileVault"], function (cur) {
                const vault = cur.fileVault || {};
                let changed = false;
                ["resume", "photo"].forEach(function (cat) {
                  const f = files[cat];
                  const storageKey = "rfa_file_" + cat;
                  if (f && f.base64 && !f.skip) {
                    // 网页版有该文件 → 写入分片 + fileVault（带 data: 前缀，见上注释）
                    const mime = f.type || (cat === "resume" ? "application/pdf" : "application/octet-stream");
                    const dataUrl = "data:" + mime + ";base64," + f.base64;
                    const FRAG = 1024 * 1024;
                    const frags = [];
                    for (let i = 0; i < dataUrl.length; i += FRAG) frags.push(dataUrl.slice(i, i + FRAG));
                    const batch = {};
                    batch[storageKey] = { name: f.name, size: f.size || 0, manual: false, fragments: frags.length };
                    frags.forEach(function (p, idx) { batch[storageKey + "_part" + idx] = p; });
                    chrome.storage.local.set(batch);
                    vault[cat] = { name: f.name, size: f.size || 0, manual: false, storageKey: storageKey };
                    changed = true;
                  } else if (!f) {
                    // v0.8.13c（08-21 用户追问「网页和插件不是同步的吗」）：网页版【没有】该文件类别
                    // （上传区显示未选择）→ 同步时清掉插件里对应的旧文件 + 分片，
                    // 让插件与网页版真正一致，避免「我没传却自动带上旧附件」。
                    // ⚠️ 回调是异步的，必须【在回调里】写回 fileVault（不能靠 forEach 后的统一 set，
                    //    否则 changed 还没置位 set 已执行 → fileVault 旧值残留，实测踩坑）。
                    (function (cat) {
                      chrome.storage.local.get([storageKey, storageKey + "_part0"], function (old) {
                        const keys = [];
                        if (old[storageKey]) {
                          keys.push(storageKey);
                          const frags = (old[storageKey].fragments) || 1;
                          for (let i = 0; i < frags; i++) keys.push(storageKey + "_part" + i);
                        }
                        if (keys.length) chrome.storage.local.remove(keys);
                        if (vault[cat]) {
                          delete vault[cat];
                          chrome.storage.local.set({ fileVault: vault });
                        }
                      });
                    })(cat);
                  }
                  // f.skip（网页版有文件但超内联上限）：保留现有状态不动
                });
                if (changed) chrome.storage.local.set({ fileVault: vault });
                // v0.8.13d（08-21 用户反馈「作品集文件上传了但投递没有」）：网页版作品集板块附件
                // （key 形如 "<verId>|portfolio|<索引>|文件"）之前只存 rfa_files_<id>，从不进插件
                // works → popup 投递读 works 为空 → 作品集附件不传。这里组装进 works（按卡片索引）。
                try {
                  const workKeys = Object.keys(files).filter(function (k) {
                    return /^[^|]+\|portfolio\|\d+\|/.test(k) && files[k] && files[k].base64 && !files[k].skip;
                  });
                  if (workKeys.length) {
                    chrome.storage.local.get(["works"], function (cur) {
                      const works = Array.isArray(cur.works) ? cur.works.slice() : [];
                      // v0.8.13e（08-21 用户反馈「插件录入的跟网页版不一样」）：works 是插件全局的，
                      // 之前只追加不清理 → 切版本后残留上一个版本（如运营版）的作品集附件，
                      // 而网页版当前是产品版 → 三方不一致。同步必须【以当前版本为准】：
                      // 先清掉所有旧 attachment（保留 name/link 等文字），再写当前版本的作品集附件。
                      works.forEach(function (w) { if (w) delete w.attachment; });
                      workKeys.forEach(function (k) {
                        const f = files[k];
                        const parts = String(k).split("|");
                        const idx = parseInt(parts[2], 10);
                        if (isNaN(idx)) return;
                        const storageKey = "rfa_file_work_" + idx;
                        const mime = f.type || "application/octet-stream";
                        const dataUrl = "data:" + mime + ";base64," + f.base64;
                        const FRAG = 1024 * 1024;
                        const frags = [];
                        for (let i = 0; i < dataUrl.length; i += FRAG) frags.push(dataUrl.slice(i, i + FRAG));
                        const batch = {};
                        batch[storageKey] = { name: f.name, size: f.size || 0, manual: false, fragments: frags.length };
                        frags.forEach(function (p, pi) { batch[storageKey + "_part" + pi] = p; });
                        chrome.storage.local.set(batch);
                        while (works.length <= idx) works.push({});
                        works[idx] = works[idx] || {};
                        works[idx].attachment = { name: f.name, size: f.size || 0, manual: false, storageKey: storageKey };
                      });
                      chrome.storage.local.set({ works: works });
                    });
                  }
                } catch (e) {}
              });
            } catch (e) {}
          });
        }
        let activeId = cur.activeProfileId || one.id;
        chrome.storage.local.set({ profiles: profiles, activeProfileId: activeId }, function () {
          const err = chrome.runtime.lastError;
          document.dispatchEvent(new CustomEvent("__RFA_SETSTORAGE_RESULT__", { detail: { ok: !err, error: err ? err.message : null } }));
        });
      });
      return;
    }
    // 全量版本：网页 versions → profiles 直接覆盖（按 id 对齐）
    if (Array.isArray(payload.profiles)) {
      chrome.storage.local.set({ profiles: payload.profiles, activeProfileId: payload.activeProfileId || null }, function () {
        const err = chrome.runtime.lastError;
        document.dispatchEvent(new CustomEvent("__RFA_SETSTORAGE_RESULT__", { detail: { ok: !err, error: err ? err.message : null } }));
      });
      return;
    }
    chrome.storage.local.set(payload, function () {
      const err = chrome.runtime.lastError;
      document.dispatchEvent(new CustomEvent("__RFA_SETSTORAGE_RESULT__", { detail: { ok: !err, error: err ? err.message : null } }));
    });
  } catch (ex) {
    document.dispatchEvent(new CustomEvent("__RFA_SETSTORAGE_RESULT__", { detail: { ok: false, error: String(ex) } }));
  }
});
document.addEventListener("__RFA_GETSTORAGE__", function (e) {
  const detail = (e && e.detail) || {};
  const keys = Array.isArray(detail.keys) ? detail.keys : null;
  try {
    if (keys) {
      chrome.storage.local.get(keys, function (res) {
        document.dispatchEvent(new CustomEvent("__RFA_GETSTORAGE_RESULT__", { detail: res || {} }));
      });
    } else {
      chrome.storage.local.get(null, function (res) {
        document.dispatchEvent(new CustomEvent("__RFA_GETSTORAGE_RESULT__", { detail: res || {} }));
      });
    }
  } catch (ex) {
    document.dispatchEvent(new CustomEvent("__RFA_GETSTORAGE_RESULT__", { detail: { error: String(ex) } }));
  }
});


// 构建戳：CDP 可直接读 document.documentElement.dataset.rfaBuild，
// 用来确认「页面上跑的到底是不是我刚改的这版 content.js」。
// 之前多次出现「改完码没重载扩展、对着旧码调了半天」的浪费，加这一行成本极低。
try { document.documentElement.dataset.rfaBuild = "20260826-r556-572"; } catch (e) {}

// ============ 百度抓取模式（读优先，不依赖 CDP 读页面） ============
// 百度 ATS 检测到 CDP Runtime.enable 会自毁 about:blank，所以不能用 CDP 读。
// 改为：在百度页注入一个悬浮按钮，用户点一下 → content.js 扫整页 →
// 经 background SW（网络不受页面 CSP 限制）转发到本地 8901 接收器。
// 全程不挂 CDP 调试器，百度不会 blank。
function rfaGuessLabel(el) {
  try {
    if (el.id) {
      var l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
      if (l && (l.innerText || '').trim()) return l.innerText.trim().split('\n')[0].replace(/[:：]\s*$/, '');
    }
    var p = el.closest ? el.closest('label') : null;
    if (p && (p.innerText || '').trim()) return p.innerText.trim().split('\n')[0].replace(/[:：]\s*$/, '');
    var node = el;
    for (var i = 0; i < 5; i++) {
      node = node.parentElement;
      if (!node) break;
      var kids = node.children || [];
      for (var k = 0; k < kids.length; k++) {
        var kt = (kids[k].innerText || '').trim();
        if (kt && kt.length < 30 && /[:：]/.test(kt)) return kt.replace(/[:：]\s*$/, '');
      }
    }
  } catch (e) {}
  return '';
}

function rfaCapture() {
  var report = { url: location.href, host: location.hostname, ts: Date.now(), sections: [], fields: [] };
  try {
    var secSel = 'h1,h2,h3,h4,h5,h6,[class*="section"],[class*="Section"],[class*="module"],[class*="Module"],[class*="card-title"],[class*="title"],[class*="form-item-label"]';
    document.querySelectorAll(secSel).forEach(function (el) {
      var t = (el.innerText || '').trim().split('\n')[0];
      if (t && t.length < 40) report.sections.push({ tag: el.tagName, text: t, cls: (el.className || '').toString().slice(0, 60) });
    });
    var sel = 'input,textarea,select,[contenteditable="true"],[role="combobox"],[role="listbox"],[aria-haspopup],[class*="select"],[class*="Select"],[class*="dropdown"],[class*="picker"],[class*="Picker"],[class*="brick"]';
    document.querySelectorAll(sel).forEach(function (el) {
      var cls = (el.className && el.className.toString) ? el.className.toString() : '';
      // 跳过明显是容器而非控件的元素（含大量子节点且自身无输入语义）
      var info = {
        tag: el.tagName,
        type: el.getAttribute('type') || '',
        cls: cls.slice(0, 90),
        id: el.id || '',
        name: el.getAttribute('name') || '',
        placeholder: el.getAttribute('placeholder') || '',
        value: (typeof el.value === 'string' ? el.value : '').slice(0, 150),
        ariaExpanded: el.getAttribute('aria-expanded') || '',
        ariaSelected: el.getAttribute('aria-selected') || '',
        checked: (typeof el.checked === 'boolean' ? el.checked : ''),
        text: (el.innerText || '').trim().slice(0, 180),
        label: rfaGuessLabel(el),
        html: el.outerHTML.slice(0, 600)
      };
      report.fields.push(info);
    });
  } catch (e) {
    report.error = String((e && e.stack) || e);
  }
  return report;
}

function rfaInjectCaptureBtn() {
  try {
    if (!/baidu\.com/i.test(location.hostname)) return;
    if (document.getElementById('__rfa_capture_btn__')) return;
    var b = document.createElement('button');
    b.id = '__rfa_capture_btn__';
    b.textContent = 'RFA抓取字段';
    b.style.cssText = 'position:fixed;right:12px;bottom:80px;z-index:2147483647;background:#7c5cff;color:#fff;border:none;border-radius:8px;padding:10px 14px;font-size:14px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    b.onclick = function () {
      b.textContent = '抓取中…';
      try {
        var data = rfaCapture();
        // 直接写插件内部存储（content script 有 chrome.storage 权限，不受百度 CSP/代理影响）
        chrome.storage.local.set({ __rfa_baidu_capture: data }, function () {
          b.textContent = '已抓取✓';
          // 打开内部查看页（非百度页，CDP 读取安全），自动渲染+备份
          try { window.open(chrome.runtime.getURL('debug.html')); } catch (e) {}
          setTimeout(function () { b.textContent = 'RFA抓取字段'; }, 2500);
        });
      } catch (e) {
        b.textContent = 'ERR';
      }
    };
    document.body.appendChild(b);
  } catch (e) {}
}

window.__RFA_CAPTURE__ = rfaCapture;
if (document.body) rfaInjectCaptureBtn();
else document.addEventListener('DOMContentLoaded', rfaInjectCaptureBtn);

// 悬浮小球入口：页面载入即常驻一个小圆球，点它展开 / 收起大面板
rfaInitLauncher();

// >>> #551 前程无忧 ATS 适配器 BEGIN (2026-08-26 重写) >>>
// =====================================================================
// 前程无忧招聘系统（xyz.51job.com/consumer/pc/resume/index?ctmid=...）
// 真机 DOM 实测（2026-08-26，CDP 逐模块探测）：
//   1) 页面不是「点加号→el-dialog 弹窗」模型！已展开板块（基本信息/教育经历/实习经验）
//      就是标准 Element UI inline 表单（.el-form-item__label + .el-input__inner），
//      通用 scanFields/fallbackMap/fillFieldAsync 完全可以直接填。
//   2) 收起板块（在校实践/项目、在校期间获得荣誉、自我评价）header 里有
//      <span class="custom-button">添加/编辑</span>，点它原地展开为 inline 表单（无弹窗）。
//   3) 「语言能力」模块默认就有 inline 表单（英语水平等），field-list-box 是附加列表。
//   4) 全页无 el-dialog（旧版适配器假设弹窗模型，导致"一个都填不上"）。
// 重写策略：展开所有收起板块 → 调通用扫描/映射/填充 → 不点任何「确认」（inline 表单）。
// 铁律（用户 2026-08-21）：宁愿不填错——映射不确定就放弃该字段，绝不误填。
// 仅 51job 域名进入，其它站点完全走原流程。
// =====================================================================
function isQiancheng() {
  return /51job\.com/i.test(location.hostname);
}

// 51job 板块标题 → 档案字段。onlyExpand=true 表示单值板块只需展开一次；数组板块按档案条数建卡。
const QC_SECTIONS = [
  { title: "基本信息", key: "basic", many: false },
  { title: "教育经历", key: "education", many: true },
  { title: "实习经验", key: "internships", many: true },
  { title: "在校实践经验/项目经验", key: "campus", many: true },
  { title: "语言能力", key: "languages", many: true },
  { title: "在校期间获得荣誉", key: "awards", many: true },
  { title: "自我评价", key: "selfEval", many: false },
];

// 找板块根容器：标题文字精确命中（.resume-module 内 .title）
function qcFindSectionBlock(title) {
  const mods = Array.from(document.querySelectorAll(".resume-module"));
  for (const m of mods) {
    const t = (m.querySelector(".title") || {}).innerText || "";
    if (t.trim() === title.trim() || (title === "在校实践经验/项目经验" && t.indexOf("在校实践") >= 0)) {
      if (isVisible(m)) return m;
    }
  }
  // 兜底：标题包含匹配（兼容标题带提示文字的情况）
  for (const m of mods) {
    const t = (m.querySelector(".title") || {}).innerText || "";
    if (t.indexOf(title) >= 0 && isVisible(m)) return m;
  }
  return null;
}

// 板块内找「添加/编辑」按钮：优先 .custom-button（span），兜底文字匹配
function qcFindAddButton(block) {
  if (!block) return null;
  const cb = Array.from(block.querySelectorAll(".custom-button")).filter(function (el) { return isVisible(el); });
  if (cb.length) return cb[0];
  // 兜底：按钮类元素 + 文字匹配
  const all = Array.from(block.querySelectorAll("button, [role=button], span, div, a"))
    .filter(function (el) { return isVisible(el) && /添加|编辑|新建|新增/.test(getText(el)); });
  if (!all.length) return null;
  function isCtrl(el) { return /^(button|a|input)$/i.test(el.tagName) || (el.getAttribute && el.getAttribute("role") === "button"); }
  const controls = all.filter(isCtrl);
  const cands = controls.length ? controls : all;
  const leaf = cands.filter(function (el) { return !cands.some(function (o) { return o !== el && el.contains(o); }); });
  const pick = leaf.length ? leaf : cands;
  return pick[0] || null;
}

// 展开一个板块（点 custom-button），最多等 ~8s。返回 true=已展开/本就展开。
async function qcExpandSection(block) {
  if (!block) return false;
  // 已有可见可填字段 → 已展开，直接返回
  const hasField = Array.from(block.querySelectorAll("input, textarea, select")).some(function (el) {
    const r = el.getBoundingClientRect(); return r.width > 0 && el.type !== "hidden" && el.type !== "file";
  });
  if (hasField) return true;
  const btn = qcFindAddButton(block);
  if (!btn) return false;
  rfaLog({ act: "qc-expand-click", title: ((block.querySelector(".title") || {}).innerText || "").slice(0, 16) });
  // 滚动到按钮位置，确保可见可点
  try { btn.scrollIntoView({ block: "center" }); } catch (e) {}
  await sleep(300);
  simulateClick(btn);
  // 等字段出现
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await sleep(400);
    const has = Array.from(block.querySelectorAll("input, textarea, select")).some(function (el) {
      const r = el.getBoundingClientRect(); return r.width > 0 && el.type !== "hidden" && el.type !== "file";
    });
    if (has) return true;
  }
  return false;
}

// 展开所有收起板块（在校实践/荣誉/自我评价等）
async function qcExpandAllSections() {
  let expanded = 0;
  for (const sec of QC_SECTIONS) {
    try {
      const block = qcFindSectionBlock(sec.title);
      if (!block) { rfaLog({ act: "qc-no-block", title: sec.title }); continue; }
      const ok = await qcExpandSection(block);
      if (ok) expanded++;
      rfaLog({ act: "qc-expand-result", title: sec.title, ok: ok });
    } catch (e) {
      rfaLog({ act: "qc-expand-err", title: sec.title, err: String(e) });
    }
  }
  rfaLog({ act: "qc-expand-all-done", expanded: expanded });
  return expanded;
}

async function runQianchengAdapter(profile, fileVault, options, works) {
  showToast("前程无忧：正在展开板块并填充…", "wait");
  rfaLog({ act: "qc-begin", host: location.hostname });
  // 1) 先展开所有收起板块
  try { await qcExpandAllSections(); } catch (e) { rfaLog({ act: "qc-expand-fatal", err: String(e) }); }
  await sleep(600); // 等 Vue 渲染稳定
  // 2) 复用通用流程：扫描 → 映射 → 填充
  let fields = scanFields();
  if (!fields || !fields.length) {
    fields = getAllFillableEls() || [];
  }
  rfaLog({ act: "qc-scan", n: fields.length });
  if (!fields.length) {
    showToast("前程无忧：未扫描到可填字段（可能未登录或页面未加载）", "err");
    return { ok: false, filled: 0, report: [], error: "no fields" };
  }
  let mappings = [];
  try { mappings = fallbackMap(fields, profile) || []; } catch (e) { rfaLog({ act: "qc-map-err", err: String(e) }); }
  // 过滤：无值不填；校验不通过不填（铁律：宁愿不填错）
  mappings = mappings.filter(function (m) {
    if (m.value === undefined || m.value === null || m.value === "") return false;
    const f = fields.find(function (x) { return x.idx === m.idx; });
    return f && validateValueForField(m.value, f);
  });
  // 去重
  const seenQc = new Set();
  mappings = mappings.filter(function (m) { if (seenQc.has(m.idx)) return false; seenQc.add(m.idx); return true; });
  rfaLog({ act: "qc-map", total: fields.length, mapped: mappings.length });
  let filled = 0;
  for (const m of mappings) {
    const el = document.querySelector("[" + ATTR + '="' + m.idx + '"]');
    if (!el) continue;
    try {
      const f = fields.find(function (x) { return x.idx === m.idx; });
      const ok = await fillFieldGuarded(el, m.value, f);
      highlight(el, ok ? "ok" : "warn");
      if (ok) filled++;
    } catch (e) { rfaLog({ act: "qc-fill-err", idx: m.idx, err: String(e) }); }
  }
  // 3) 标黄查漏（未填字段统一黄框）
  try { repaintWarnByRealState("qc-done"); } catch (e) {}
  showToast("前程无忧填写完成（" + filled + "/" + mappings.length + " 字段），请人工核对", "ok");
  return { ok: true, filled: filled, report: { scanned: fields.length, mapped: mappings.length } };
}
