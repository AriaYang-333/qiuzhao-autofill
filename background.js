// background.js — Service Worker
// 负责：调用 DeepSeek API（解析简历 / 字段映射），多简历存储。反馈由 popup 直接调起邮件发送。

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-chat";
const PLUGIN_VERSION = "0.7.0";

// ---------- 通用简历数据结构 ----------
const RESUME_SCHEMA = `{
  "basic": { "name": "", "gender": "", "phone": "", "email": "", "location": "", "birth": "", "nationality": "", "hometown": "", "ethnicity": "", "hobbies": "", "targetPosition": "", "idType": "", "idNumber": "", "wechat": "", "qq": "", "emergencyContact": "", "emergencyPhone": "", "emergencyRelation": "", "homepage": "", "idCountry": "", "currentResidence": "", "studyLocation": "", "internshipDuration": "", "weeklyDays": "" },
  "education": [{ "school": "", "major": "", "degree": "", "eduType": "", "start": "", "end": "", "college": "", "lab": "", "tutor": "", "research": "", "rank": "", "gpa": "", "gpaBase": "", "transcript": "" }],
  "internships": [
    {
      "company": "",
      "title": "",
      "department": "",
      "start": "",
      "end": "",
      "description": "",
      "responsibilities": "",
      "achievements": "",
      "workType": ""
    }
  ],
  "projects": [
    {
      "name": "",
      "role": "",
      "start": "",
      "end": "",
      "link": "",
      "description": "",
      "responsibilities": "",
      "achievements": ""
    }
  ],
  "portfolio": [
    { "name": "", "link": "", "description": "", "video": "", "pdf": "", "password": "" }
  ],
  "awards": [{ "name": "", "date": "", "category": "", "level": "", "description": "" }],
  "campus": [{ "name": "", "role": "", "start": "", "end": "", "description": "" }],
  "papers": [{ "name": "", "venue": "", "order": "", "impact": "", "link": "" }],
  "competitions": [{ "name": "", "level": "", "date": "", "description": "" }],
  "certificates": [{ "name": "", "date": "", "description": "", "file": "" }],
  "patents": [{ "type": "", "name": "", "regNo": "", "date": "", "rank": "", "summary": "", "file": "" }],
  "skills": [],
  "languages": [{ "name": "", "level": "", "exam": "", "score": "" }],
  "social": [{ "platform": "", "account": "", "link": "" }],
  "selfEval": "",
  "intent": { "expectedCities": [], "interviewCity": "", "availableFrom": "", "internshipDuration": "", "weeklyDays": "", "expectedSalary": "", "acceptOtherCities": "" },
  "reference": { "name": "", "identity": "", "phone": "" },
  "aiSkills": { "tools": "", "collabProject": "", "link": "" }
}`;

const PARSE_SYSTEM =
  "你是简历解析助手。把用户提供的简历或项目经历文本，解析成下面这个 JSON 结构。" +
  "规则：只填能从文本中确定的内容；没有的字段留空字符串或空数组。" +
  "时间统一写成 YYYY.MM 形式，分别放到 start 和 end 字段（不要合并成一段）。如果某段经历仍在进行中，end 字段可填「至今」。" +
  "\n\n【绝对禁止混用】education、internships、projects 这三个数组必须严格区分：" +
  "* education（教育经历）：只能放学校、院系、专业、学历/学位、学习形式、在校起止时间。任何实习、项目、课程作业都不要放进来。" +
  "* internships（实习/工作经历）：只能放公司名称、职位/岗位、部门、实习起止时间、工作内容、业绩。不要把项目经历塞进来。" +
  "* projects（项目经历）：只能放项目名称、担任角色/岗位、项目起止时间、项目描述、职责、成果。不要把实习公司或学校课程塞进来。" +
  "* portfolio（作品集）：只放「作品集/作品」板块里的独立作品（作品名、链接、描述、视频、PDF）。不要把项目经历塞进来，项目和作品是两件事。" +
  "\n* role/title = 这段经历里你担任的职务/岗位/角色/职位；" +
  "* responsibilities = 你具体做了什么、承担了哪些职责；" +
  "* achievements = 你取得的成果、业绩、量化产出；" +
  "* description = 整体背景、目标、概述性内容。" +
  "不要把职责和成果混进 description，也不要把职务混进职责。" +
  "\n基本信息中：phone 只填手机号；email 必须包含 @ 符号，不要把手机号、QQ 号填进 email；targetPosition=求职意向/目标岗位/应聘职位；" +
  "basic.location=所在地点（格式：国家/地区/省/市/区，如 中国大陆/四川省/成都市/锦江区；港澳台直接填 中国香港/中国澳门/中国台湾），basic.hometown=家乡/籍贯（同 location 格式）。" +
  "【直辖市特别注意】北京市、上海市、天津市、重庆市是直辖市，省级和市级写同一个名字，例如「北京市朝阳区」必须输出成「中国大陆/北京市/北京市/朝阳区」；普通省份如「浙江省杭州市西湖区」输出成「中国大陆/浙江省/杭州市/西湖区」。" +
  "个人证件：若原文出现身份证号/护照号/港澳台居民居住证等，提取 basic.idNumber（证件号码原文），basic.idType 填证件类型（身份证/护照/港澳通行证/台湾通行证），未出现则两者都留空。" +
  "基本信息扩展：basic.ethnicity=民族（如 汉族/满族/回族，原文出现才填，如「民族：汉族」）；basic.hobbies=兴趣爱好（如 摄影/写作/篮球/小提琴，多个用顿号或逗号分隔，原文有才填，没有留空）；basic.hometown=籍贯/家乡（同 location 格式）；basic.location=所在城市（同 location 格式）；basic.currentResidence=现居住地（同 location 格式）。" +
  "教育经历：必须提取 degree（学历/学位）和 eduType（学习形式，常见：全日制/非全日制/统招/自考/成人教育/网络教育/在职）。eduType 未明确则留空。" +
  "教育经历扩展字段（有就填，没有一律留空，不要编造）：college=学院/院系名称（如 计算机学院、软件学院、机械工程学院），lab=实验室/研究所/课题组名称，tutor=导师/指导老师姓名，research=研究方向/领域方向（如 计算机视觉、自然语言处理），rank=成绩排名（如 3/120、前5%、专业第一，只填排名百分比/名次，不要填绩点数字），gpa=绩点/平均学分绩点（如 3.8、3.95，纯数字；原文出现「GPA」「绩点」「平均学分绩」「CGPA」才填，没有留空），gpaBase=所在院校满绩绩点（如 4.0、5.0；原文出现「满绩」「绩点满分」「4分制」「5分制」「绩点满分」才填，没有留空），transcript=成绩单文件文件名（如 成绩单.pdf，有才填，没有留空）。" +
  "实习/工作经历：workType=工作类型（实习/兼职/全职/社会实践）。若这段经历明显是在校期间的实习，填「实习」；明显是正式工作填「全职」；无法判断则留空。" +
  "项目经历：必须提取 role（项目职务/岗位/角色，如 项目负责人、核心开发、算法工程师、后端负责人）。若原文有项目链接/URL/演示地址，必须提取到 projects[].link；若一个项目有多个链接用空格或分号隔开。" +
  "作品集：若原文有「作品集」板块，逐条提取到 portfolio[]（name=作品名，link=作品链接/URL，description=作品描述，video=视频文件名如 xxx.mp4，pdf=作品集PDF文件名，password=作品访问密码/提取码如网盘提取码，没有则留空）；没有则留空数组。" +
  "校园经历：若原文有「校园经历/学生工作/社团经历/学生组织」板块，逐条提取到 campus[]（name=校园经历名称如 学生会主席团/ACM协会，role=角色/职务如 主席/部长/负责人，start/end=起止时间 YYYY.MM，description=校园经历描述）；没有则留空数组。校园经历不要塞进 internships 或 projects。" +
  "荣誉奖项：逐条提取到 awards[]（name=荣誉名称如 国家奖学金/优秀毕业生，date=获得时间 YYYY.MM，description=荣誉描述/评定说明，type=奖项级别/类型如 国家级/省部级/校级/院级/奖学金/竞赛获奖/其他；若原文明确写了国家级/省部级/校级等，必须填到 type）。" +
  "证书：逐条提取到 certificates[]（name=证书名称，date=获得时间 YYYY.MM，description=证书描述/说明如证书编号或颁发机构，没有就不填）；若有证书扫描件/图片文件名可填 certificates[].file（如 证书名.jpg）。" +
  "发明成果专利：若原文有「专利/发明成果/知识产权/实用新型/发明专利」板块，逐条提取到 patents[]：type=成果类型（如 发明专利/实用新型专利/外观设计专利/软件著作权），name=成果名称/专利名称，regNo=登记号/专利号/申请号（如 CN202310000000.0），date=登记日期/授权日期/申请日期（YYYY.MM），rank=发明人排名（如一作/第一发明人/二作/共同发明人/排序 3/5），summary=核心简介/专利摘要（一句话说明技术内容与价值）；没有则留空数组。" +
  "论文：若原文有「论文/学术成果/发表论文」板块，逐条提取到 papers[]（name=论文名称，venue=发表渠道/期刊名/会议名，order=作者顺序如 一作/第一作者/二作/共同一作，impact=影响因子，link=论文链接/DOI/URL）；没有则留空数组。" +
  "【影响因子必须抓】原文若出现「影响因子：8.6」「IF=7.2」「影响因子 5.4」等写法，必须把纯数字填到该论文的 impact 字段（只填数字如 8.6，不要带「影响因子」三个字，也不要填「—」）；确实没写才留空。" +
  "竞赛：若原文有「竞赛/获奖大赛/学科竞赛」板块，逐条提取到 competitions[]（name=获奖大赛名称，level=获奖级别如 一等奖/金奖/银牌/全国二等奖，date=获奖时间 YYYY.MM，description=竞赛描述）；没有则留空数组。竞赛与 awards（荣誉奖学金类）分开放，同一件事可以同时出现在两处。" +
  "语言能力：每条语言拆成 name（语种，如 英语/日语/普通话）、level（语言水平/熟练程度，如 无障碍商务沟通/精通/熟练/良好/母语）、exam（语言考试，必须是固定集合之一：CET-4、CET-6、TEM-4、TEM-8、TOEFL、IELTS、GRE、其他）、score（考试分数，如 598、621、7.5、108、满分、一级甲等）；没有则留空。" +
  "注意：一个语种若考了多个考试（如英语同时有 CET-4、CET-6、IELTS、TOEFL），必须拆成多条 languages 记录，每条对应一个 exam+score；日语 N1、普通话等不在固定集合里的考试，exam 填「其他」，score 填实际等级。" +
  "社交账号：若简历/作品集里有社交主页链接（GitHub、知乎、微博、掘金、CSDN、LeetCode、B站、公众号等），提取到 social[]（platform=平台名如 GitHub/知乎，account=账号/用户名/ID/UID，link=主页完整 URL）；没有则留空数组。" +
  "求职意向：必须提取。常见写法分散在「基本信息」或单独「求职意向」板块。expectedCities=期望城市/期望工作城市（可多个，如 [\"北京\",\"上海\",\"深圳\"]，只填城市名不要带省，多个用顿号、逗号、分号分隔）；interviewCity=可参加面试城市/面试城市；availableFrom=最早可到岗时间/到岗时间/可入职时间（如 2026.07、随时）；internshipDuration=可实习时长/实习时间/实习月数（如 6个月、3个月）；weeklyDays=每周可出勤天数/每周出勤/每周工作天数（如 5天、4天）。没有则对应字段留空或空数组，但只要有上述关键词就必须填。" +
  "资料证明人：必须提取。常见标题「资料证明人」「证明人」「推荐人」。reference.name=证明人/证明人姓名；reference.identity=证明人身份/与本人关系/职务（如 硕士导师、部门主管、实习导师）；reference.phone=证明人联系电话/证明人电话。没有则留空，但看到「证明人」关键词就必须输出。" +
  "AI应用技能：必须提取。常见标题「AI应用技能」「常用AI工具」「与AI协作」。aiSkills.tools=常用AI工具&模型/具体工具名称&模型名称（如 Cursor、Copilot、Claude、GPT-5、DeepSeek、Midjourney，多个用顿号/逗号分隔）；aiSkills.collabProject=与AI协作完成的项目或任务/项目目标背景（含目标背景、工具选择原因、你与AI的分工、核心挑战及解决方案、项目结果）；aiSkills.link=相关项目或作品链接/GitHub仓库/个人博客/线上Demo（多个用空格或分号分隔）。没有则留空，但看到「AI工具」「与AI协作」等关键词就必须输出。" +
  "描述尽量保留原文关键句。必须返回合法的 JSON 对象，不要输出任何解释文字。结构如下：\n" +
  RESUME_SCHEMA;

const MAP_SYSTEM =
  "你是招聘表单字段匹配助手。给你两部分输入：1) 招聘网页上扫到的字段列表（每项有 idx、label、section、type）；" +
  "2) 用户的简历 JSON 数据。你的任务：为每个能合理匹配的字段，决定要填入的值。" +
  "规则：先看 section 锁定数据范围，再看 label 语义选具体字段；值要从简历数据里取；只有当字段语义完全和简历无关，或简历里确实没有对应信息时，才留空。" +
  "\n【禁止跨板块】每个字段的 section 已经标明它属于哪个板块，你只能从这个板块对应的数据里取值：" +
  "section='basic' → 只能用 basic（姓名/手机/邮箱/性别/城市/出生年月/国籍地区/家乡/求职意向/证件类型/证件号码/民族/兴趣爱好）；" +
  "section='patents' → 只能用 patents[]（成果类型/成果名称/登记号/登记日期/发明人排名/核心简介），绝对不能用论文或项目数据；" +
  "section='education' → 只能用 education[]（学校/专业/学历/学习形式/起止时间/学院/实验室/导师/研究方向/成绩排名），绝对不能用项目或实习数据；" +
  "section='internships' → 只能用 internships[]（公司/职位/职责/业绩/工作类型），绝对不能用教育或项目数据；" +
  "section='projects' → 只能用 projects[]（项目名/角色/描述/职责/成果）和 portfolio[]（作品链接），绝对不能用教育或实习数据；" +
  "section='awards' → 只能用 awards[]（获奖名称/时间/描述）；" +
  "section='portfolio' → 只能用 portfolio[]（作品名/链接/描述）；" +
  "section='social' → 只能用 social[]（platform=平台如 GitHub/知乎，account=账号/用户名，link=主页链接）；简历没有 social 时用 portfolio[].link 或 projects[].link 作为社交主页链接，平台名从域名推断；" +
  "section='languages' → 只能用 languages[]（语种/熟练程度/分数证书）；" +
  "section='selfEval' → 只能用 selfEval 文本，以及 portfolio[] 里的链接（用于「URL/ID/主页/作品链接/社交账号」这类字段）。" +
  "\n【简历 JSON 各字段语义】：" +
  "basic.name=姓名，basic.phone=电话，basic.email=邮箱（必须含@），basic.gender=性别，basic.birth=出生年月/生日/Date of Birth（统一输出 YYYY-MM 格式，如 2002-03），basic.location=所在地点（格式：国家/地区/省/市/区，如 中国大陆/四川省/成都市/锦江区；港澳台直接填 中国香港/中国澳门/中国台湾），basic.nationality=国籍/地区（如 中国），basic.hometown=家乡/籍贯（同 location 格式），basic.targetPosition=求职意向/目标岗位，basic.idType=证件类型（身份证/护照等），basic.idNumber=证件号码/身份证号，basic.wechat=微信号/微信ID，basic.qq=QQ号，basic.emergencyContact=紧急联系人姓名，basic.emergencyPhone=紧急联系人电话，basic.emergencyRelation=紧急联系人与本人关系，basic.homepage=个人主页/个人网站链接，basic.idCountry=证件所属国家/地区（如 中国大陆），basic.currentResidence=当前所处地（同 location 格式），basic.studyLocation=目前就读地/学校所在地（同 location 格式），basic.internshipDuration=可实习时长，basic.weeklyDays=每周可出勤天数，basic.ethnicity=民族（如 汉族），basic.hobbies=兴趣爱好（如 摄影/篮球，多个用顿号分隔）；" +
  "education[].school=学校名称，major=专业，degree=学历/学位（如 本科/硕士/博士），eduType=学习形式（全日制/非全日制/统招/自考/成人教育/网络教育），start/end=教育起止时间（YYYY.MM，进行中可填「至今」），college=学院/院系名称，lab=实验室/研究所/课题组，tutor=导师/指导老师，research=研究方向/领域方向，rank=成绩排名（如 3/120、前5%、专业第一，只填排名不含绩点），gpa=绩点/平均学分绩点（如 3.8、3.95），gpaBase=所在院校满绩绩点（如 4.0、5.0）；" +
  "internships[].company=公司/组织名称，title=职位/岗位，department=部门，start/end=工作起止时间，responsibilities=工作内容/职责（即实习职责），achievements=工作成果/业绩（即实习成果），description=实习描述/实习概况，workType=工作类型（实习/兼职/全职）；" +
  "projects[].name=项目名称，role=项目职务/角色，start/end=项目起止时间，link=项目链接/URL/演示地址，description=项目描述/背景，responsibilities=项目职责/负责内容，achievements=项目成果/业绩；" +
  "portfolio[].name=作品名，link=作品链接/URL，description=作品描述，password=作品访问密码/提取码；" +
  "awards[].name=获奖名称/奖项，date=获奖时间（YYYY 或 YYYY.MM），description=获奖描述；" +
  "languages[].name=语种（英语/日语等），level=熟练程度（精通/熟练/良好/一般），score=分数或证书（如 CET-6 621/雅思 7.5）；" +
  "selfEval=自我评价；devLang=开发语言/技术栈（如 Python/JavaScript，多个用顿号分隔）；aiSkills.tools=常用的 AI 工具&模型（如 Cursor、Copilot、Claude、GPT-5 等），aiSkills.collabProject=与 AI 协作完成的项目或任务描述，aiSkills.link=相关项目或作品链接（GitHub/线上Demo/博客等）；reference.name=资料证明人姓名，reference.identity=证明人身份/职务，reference.phone=证明人联系电话；patents[].type=成果类型（发明专利/实用新型/软著等），name=成果名称/专利名称，regNo=登记号/专利号，date=登记日期（YYYY.MM），rank=发明人排名（第一发明人/3/5），summary=核心简介。" +
  "\n【链接字段特别注意】：label 含「作品链接/作品集/作品URL」的字段 → 填 portfolio[].link；label 含「项目链接/演示/URL」的字段 → 填 projects[].link；都必须是合法网址，不要把描述文字当链接填。" +
  "\n【绝对不要填的字段】：凡是 label 含「调剂/是否接受/是否到岗/是否应届/是否统招/是否在职/同意条款/隐私政策/用户协议/实习时长/到岗时间/入职时间/期望薪资/薪资范围/薪资要求」等需要用户自己决策的是/否或主观选择，一律留空，不要返回映射。" +
  "\n【证件号码】：label 含「证件号码/身份证号/证件号」的字段，一律不要返回映射（插件会在本地直接填充，简历 JSON 里看到的 [本地填充] 是占位符，绝对不要当成真实值填出去）。证件类型可以正常映射。" +
  "\n【是否全日制】：label 含「是否全日制」属于客观事实，可以填。根据 education[].eduType 推导：eduType 含「全日制/统招/普通全日制」→ 填「是」；含「非全日制/在职/自考/成人/网络教育/函授」→ 填「否」；eduType 为空则留空不填。" +
  "\n【日期处理】：label 含‘开始/起始/入学/入职’只填 start；含‘结束/截止/毕业/离职’只填 end（YYYY.MM 或「至今」）；只有单一‘起止时间’字段才写成‘开始-结束’。" +
  "\n必须返回合法 JSON 对象，格式为：{\"mappings\":[{\"idx\":\"字段idx\",\"value\":\"要填的值\"}]}";

// ---------- 工具 ----------
function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function setStorage(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}
function genId() {
  return "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function getApiKey() {
  const r = await getStorage("apiKey");
  return r.apiKey || "";
}

async function callDeepSeek(systemPrompt, userText) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error("请先在插件里填写 DeepSeek API Key");

  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
    temperature: 0.1,
    stream: false,
  };

  // 超时保护：DeepSeek 偶发无响应（连接黑洞），若无超时整个填充流程会永久卡死。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`DeepSeek 请求失败 (${res.status})：${t.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  } catch (e) {
    if (e && e.name === "AbortError") {
      throw new Error("DeepSeek 请求超时（15s 无响应），已自动跳过 LLM 映射，仅用兜底规则填充");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function safeParseJSON(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (e2) {}
    }
    return null;
  }
}

// 从链接推断社交平台名（github.com → GitHub 等）
function guessSocialPlatform(url) {
  const s = String(url || "").toLowerCase();
  const rules = [
    [/github/i, "GitHub"], [/gitee/i, "Gitee"], [/zhihu/i, "知乎"], [/weibo/i, "微博"],
    [/bilibili/i, "哔哩哔哩"], [/linkedin/i, "LinkedIn"], [/twitter|x\.com/i, "Twitter/X"],
    [/douyin/i, "抖音"], [/juejin/i, "掘金"], [/csdn/i, "CSDN"], [/leetcode/i, "LeetCode"],
    [/mp\.weixin|wechat/i, "微信公众号"],
  ];
  for (const [re, name] of rules) if (re.test(s)) return name;
  return "";
}

function cleanProfile(p) {
  if (!p) return p;
  if (p.basic && p.basic.email) {
    const em = p.basic.email.trim();
    if (!em.includes("@") || /^\d{11}@/.test(em)) p.basic.email = "";
  }
  if (p.basic && p.basic.phone) {
    p.basic.phone = p.basic.phone.replace(/[^\d\-+\s]/g, "").trim();
  }
  if (p.languages && Array.isArray(p.languages)) {
    p.languages = p.languages.map((l) => {
      if (typeof l === "string") {
        const m = l.match(/^(.+?)\s*[:：]\s*(.+)$/);
        if (m) return { name: m[1].trim(), level: "", score: m[2].trim() };
        return { name: l.trim(), level: "", score: "" };
      }
      return l;
    });
  }
  if (p.social && Array.isArray(p.social)) {
    p.social = p.social.map((s) => {
      if (typeof s === "string") {
        const url = s.trim();
        if (/^https?:\/\//i.test(url)) return { platform: guessSocialPlatform(url), account: "", link: url };
        return { platform: s.trim(), account: "", link: "" };
      }
      return s;
    });
  }
  const cleanedEdu = [];
  (p.education || []).forEach((edu) => {
    const school = (edu.school || "").trim();
    const major = (edu.major || "").trim();
    const looksLikeProject =
      /项目|课题|竞赛|大赛|作品|AI |社媒|创作|运营|策划/.test(school) ||
      (/\d{4}\.\d{2}/.test(major) && !/[学专院系科]/.test(major));
    if (looksLikeProject && (edu.description || edu.start || edu.end)) {
      p.projects = p.projects || [];
      p.projects.push({
        name: school || "项目经历",
        role: "",
        start: edu.start || "",
        end: edu.end || "",
        link: "",
        description: edu.description || major || "",
        responsibilities: "",
        achievements: "",
      });
    } else {
      cleanedEdu.push(edu);
    }
  });
  p.education = cleanedEdu;
  return p;
}

// v0.7.2：本地兜底抽取「校园经历 / 论文 / 竞赛」。
// 线上观察：DeepSeek 偶尔把这三段整段漏掉（返回空数组），导致用户「解析全空白」。
// 这里用规则从原始简历文本里补抽，只在 LLM 留空时才覆盖，避免覆盖 LLM 的更好结果。
// 文本格式：每个标签占一行（extractDocxText 把 </w:p> 换成 \n），如
//   校园经历名称：X｜角色：Y / 起止时间：S 至 E / 校园经历描述：D
//   论文名称：X / 发表渠道：V / 作者顺序：O / 影响因子：I / 论文链接：L
//   获奖大赛：赛事名（级别）
function extractSections(text) {
  const lines = String(text || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const res = { campus: [], papers: [], competitions: [] };
  // ---- 校园经历 ----
  let cur = null;
  const pushCampus = () => { if (cur) res.campus.push(cur); };
  for (const line of lines) {
    let m;
    if ((m = line.match(/^校园经历名称[:：]\s*(.+?)\s*[｜|]\s*角色[:：]\s*(.+)$/))) {
      pushCampus();
      cur = { name: m[1].trim(), role: m[2].trim(), start: "", end: "", description: "" };
    } else if (cur && (m = line.match(/^起止时间[:：]\s*(.+?)\s*至\s*(.+)$/))) {
      cur.start = m[1].trim(); cur.end = m[2].trim();
    } else if (cur && (m = line.match(/^校园经历描述[:：]\s*(.+)$/))) {
      cur.description = m[1].trim();
    }
  }
  pushCampus();
  // ---- 论文 ----
  cur = null;
  const pushPaper = () => { if (cur) res.papers.push(cur); };
  for (const line of lines) {
    let m;
    if ((m = line.match(/^论文名称[:：]\s*(.+)$/))) {
      pushPaper();
      cur = { name: m[1].trim(), venue: "", order: "", impact: "", link: "" };
    } else if (cur && (m = line.match(/^发表渠道[:：]\s*(.+)$/))) cur.venue = m[1].trim();
    else if (cur && (m = line.match(/^作者顺序[:：]\s*(.+)$/))) cur.order = m[1].trim();
    else if (cur && (m = line.match(/^影响因子[:：]\s*(.+)$/))) cur.impact = String(m[1]).replace(/[^\d.]/g, "").trim();
    else if (cur && (m = line.match(/^论文链接[:：]\s*(.+)$/))) cur.link = m[1].trim();
  }
  pushPaper();
  // ---- 竞赛 ----
  for (const line of lines) {
    const m = line.match(/^获奖大赛[:：]\s*(.+)$/);
    if (m) {
      let nm = m[1].trim();
      let level = "";
      const pm = nm.match(/^(.*?)[（(]([^）)]+)[）)]\s*$/);
      if (pm) { nm = pm[1].trim(); level = pm[2].trim(); }
      res.competitions.push({ name: nm, level, date: "", description: "" });
    }
  }
  return res;
}

// v0.7.4：LLM 对「求职意向 / 资料证明人 / AI应用技能」三块的输出极不稳定，用规则兜底补抽。
// 只要原文里有对应关键词，就强制回填到 profile，避免档案界面这三块恒空。
function extractIntentReferenceAiSkills(text) {
  const t = String(text || "");
  const res = { intent: {}, reference: {}, aiSkills: {} };

  // ---- 求职意向 ----
  const cityMatch = t.match(/期望城市[：:]\s*([^\n]+)/);
  if (cityMatch) {
    res.intent.expectedCities = cityMatch[1].split(/[、,，;；]+/).map((s) => s.trim()).filter(Boolean);
  }
  const interviewMatch = t.match(/可参加面试城市[：:]\s*([^\n]+)/);
  if (interviewMatch) res.intent.interviewCity = interviewMatch[1].trim();
  const availMatch = t.match(/(?:最早可)?到岗时间[：:]\s*([^\n]+)/);
  if (availMatch) res.intent.availableFrom = availMatch[1].trim();
  const durMatch = t.match(/可实习时长[：:]\s*([^\n]+)/);
  if (durMatch) res.intent.internshipDuration = durMatch[1].trim();
  const weeklyMatch = t.match(/每周(?:可)?出勤[：:]\s*([^\n]+)/);
  if (weeklyMatch) res.intent.weeklyDays = weeklyMatch[1].trim();

  // ---- 资料证明人：只在「资料证明人」板块内匹配，避免误抓紧急联系人电话 ----
  const refSectionMatch = t.match(/(?:资料)?证明人[\s\S]{0,600}?AI应用技能|(?:资料)?证明人[\s\S]{0,600}$/);
  const refSection = refSectionMatch ? refSectionMatch[0] : "";
  const refNameMatch = refSection.match(/(?:资料)?证明人[：:]\s*([^\n]+)/);
  if (refNameMatch) res.reference.name = refNameMatch[1].trim();
  const refIdentityMatch = refSection.match(/身份[：:]\s*([^\n]+)/);
  if (refIdentityMatch) res.reference.identity = refIdentityMatch[1].trim();
  const refPhoneMatch = refSection.match(/(?:证明人联系)?电话[：:]\s*([\d\-+\s()]+)/);
  if (refPhoneMatch) res.reference.phone = refPhoneMatch[1].trim();

  // ---- AI应用技能：只在「AI应用技能」板块内匹配 ----
  const aiSectionMatch = t.match(/AI应用技能[\s\S]{0,2000}?$/);
  const aiSection = aiSectionMatch ? aiSectionMatch[0] : "";
  const aiToolsMatch = aiSection.match(/常用\s*AI\s*工具[＆&]模型[：:]\s*([^\n]+)/);
  if (aiToolsMatch) res.aiSkills.tools = aiToolsMatch[1].trim();
  const aiProjMatch = aiSection.match(/与\s*AI\s*协作完成的项目或任务[：:]\s*([\s\S]*?)(?=③\s*相关项目或作品链接|AI应用技能|$)/);
  if (aiProjMatch) {
    res.aiSkills.collabProject = aiProjMatch[1].replace(/\n+/g, " ").trim();
  }
  const aiLinkMatch = aiSection.match(/相关项目或作品链接[：:]\s*([^\n]+)/);
  if (aiLinkMatch) res.aiSkills.link = aiLinkMatch[1].trim();

  // ---- 紧急联系人：basic.emergencyContact / emergencyPhone / emergencyRelation ----
  // v0.8.11：Word 解析此前从不抽取紧急联系人，导致腾讯等站该三连恒空。
  // 这里用规则兜底补抽（仅当 LLM 也没给时由调用处回填）。
  const emSectionMatch = t.match(/紧急联系人[\s\S]{0,400}?(?=资料证明人|AI应用技能|求职意向|校园经历|教育经历|实习经历|项目经历|论文|竞赛|$)/);
  const emText = emSectionMatch ? emSectionMatch[0] : "";
  const em = {};
  const emName = emText.match(/姓名[：:]\s*([^\n]+)/) || emText.match(/紧急联系人[：:]\s*([^\n]+)/);
  if (emName) em.emergencyContact = emName[1].trim();
  const emPhone = emText.match(/电话[：:]\s*([\d\-+\s()]+)/);
  if (emPhone) em.emergencyPhone = emPhone[1].trim();
  const emRel = emText.match(/(?:与本人)?关系[：:]\s*([^\n]+)/);
  if (emRel) em.emergencyRelation = emRel[1].trim();
  if (Object.keys(em).length) res.emergency = em;

  return res;
}

// 字段映射时对敏感信息脱敏：证件号码绝不出本机，由 content.js 本地规则直接填入表单
function redactSensitive(profile) {
  if (!profile || typeof profile !== "object") return profile;
  let copy;
  try {
    copy = JSON.parse(JSON.stringify(profile));
  } catch (e) {
    return profile;
  }
  if (copy.basic && copy.basic.idNumber) copy.basic.idNumber = "[本地填充]";
  return copy;
}

// ---------- 多简历存储 ----------
async function ensureProfiles() {
  const r = await getStorage(["profiles", "activeProfileId"]);
  let profiles = r.profiles || [];
  let activeId = r.activeProfileId;
  if (!profiles.length) {
    profiles = [{ id: genId(), name: "简历1", data: null }];
    activeId = profiles[0].id;
    await setStorage({ profiles, activeProfileId: activeId });
  } else if (!profiles.find((p) => p.id === activeId)) {
    activeId = profiles[0].id;
    await setStorage({ activeProfileId: activeId });
  }
  return { profiles, activeId };
}

// ---------- 反馈：由 popup 直接调起邮件发送（见 popup.js），background 不再处理 ----------

// ---------- 主世界文件注入（v0.6.74 关键修复） ----------
// 背景：content.js 跑在 isolated world，它 new 出来的 File 对象页面（main world）的
// React 上传组件读不到 —— onChange 会触发，但框架拿到的 files 是空的，
// 整条预签名上传链路根本不会发出（表现为插件报「上传成功」、作品集列表却始终空白）。
// 早先尝试过在 content.js 里 append 一个 inline <script> 到页面来跨世界，
// 但美团站点的 CSP 会直接拦掉这种注入脚本（实测注入体从未执行）。
// 正解：chrome.scripting.executeScript({world:"MAIN"}) —— 由扩展发起，豁免页面 CSP，
// 且执行在主世界 realm，创建的 File 才是页面认得的那一个。
// 该函数会被序列化后注入页面，因此不能引用本文件里的任何外部变量。
// v0.6.74 修正：不再依赖 content.js（isolated world）打的临时属性定位 input——
// 实测发现跨世界打的 data-rfa-up 属性定位到的 input 节点，React 不上传；
// 改为与「CDP 直接注入」完全一致的方式：直接用 querySelector 定位作品集 input。
function mimeFromName(name) {
  var ext = String(name || "").toLowerCase().split(".").pop();
  var MAP = {
    pdf: "application/pdf", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    zip: "application/zip", rar: "application/x-rar-compressed", "7z": "application/x-7z-compressed",
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
    mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo"
  };
  return MAP[ext] || "application/octet-stream";
}

function mainWorldSetFile(b64, name, mime, attr, token) {
  var inp = null;
  try {
    // v0.6.83：优先按 content.js 打的临时属性(token)定位到「findFileInputFor 选中的正确 input」。
    // 这样简历/证件照/作品集三通道各自落到自己的框，主世界注入不会误塞进作品集框。
    // DOM 跨世界共享，故主世界能读到隔离世界打的 data-rfa-up 属性。
    if (token && attr) {
      try { inp = document.querySelector("[" + attr + "='" + token + "']"); } catch (e) { inp = null; }
    }
    // 兜底：仍按作品集区域/accept 定位（兼容未传 token 的旧路径）
    if (!inp) {
      var sec = document.querySelector("[class*='upload_sample_reel']");
      if (sec) inp = sec.querySelector("input[type=file]");
    }
    if (!inp) {
      inp = document.querySelector(
        "input[type=file][accept*='7z'],input[type=file][accept*='zip'],input[type=file][accept*='rar'],input[type=file][accept*='pdf']"
      );
    }
    if (!inp) return { ok: false, reason: "input_not_found" };

    var bin = atob(b64);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    // 内联 mimeFromName：本函数被序列化注入主世界，无法引用外部函数
    var ext = String(name || "").toLowerCase().split(".").pop();
    var mimeMap = {
      pdf: "application/pdf", doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      zip: "application/zip", rar: "application/x-rar-compressed", "7z": "application/x-7z-compressed",
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
      mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo"
    };
    var realMime = mimeMap[ext] || "";
    var f = new File([arr], name, { type: (realMime || mime || "application/octet-stream") });

    var dt = new DataTransfer();
    dt.items.add(f);
    inp.files = dt.files;
    var n = inp.files ? inp.files.length : 0;
    inp.dispatchEvent(new Event("change", { bubbles: true }));

    // 飞书/字节系拖拽上传组件（.atsx-upload-drag）不听 input.change，只听容器 drop
    try {
      var dc = inp.closest(".atsx-upload-drag") || inp.closest("[class*='atsx-upload']");
      if (dc) {
        var dt2 = new DataTransfer();
        dt2.items.add(f);
        var mk = function (t) {
          var ev =
            typeof DragEvent !== "undefined"
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

    return { ok: true, n: n, size: arr.length };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

// ---------- 消息入口 ----------
// 长连接保活端口：content 侧注入即建立，使 MV3 SW 在「重载→填充」间隙保持温热，
// 避免冷启动导致 mapFields 消息/响应丢失（这是之前下拉框全空的根因）。
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "rfa-keepalive") return;
  port.onMessage.addListener(async (msg) => {
    if (msg.action === "ping") {
      try { port.postMessage({ __rfaPong: true }); } catch (e) {}
      return;
    }
    if (msg.action === "mapFields") {
      const userText =
        "简历数据 JSON：\n" + JSON.stringify(redactSensitive(msg.profile), null, 2) +
        "\n\n页面字段列表（每项含 idx 和 label）：\n" + JSON.stringify(msg.fields, null, 2) +
        "\n\n请返回匹配映射 JSON。";
      try {
        const content = await callDeepSeek(MAP_SYSTEM, userText);
        const result = safeParseJSON(content);
        if (!result) throw new Error("映射结果不是合法 JSON");
        port.postMessage({ __rfaMapResp: true, ok: true, mappings: result.mappings || [] });
      } catch (err) {
        port.postMessage({ __rfaMapResp: true, ok: false, error: err.message });
      }
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "parseResume") {
    callDeepSeek(PARSE_SYSTEM, "请解析以下简历文本为 JSON：\n\n" + msg.doc)
      .then(async (content) => {
        let profile = safeParseJSON(content);
        if (!profile) throw new Error("解析结果不是合法 JSON");
        profile = cleanProfile(profile);
        // v0.7.2：LLM 偶尔漏掉 校园经历/论文/竞赛，这里用本地规则兜底补抽（仅当 LLM 留空）
        try {
          const local = extractSections(msg.doc || "");
          ["campus", "papers", "competitions"].forEach((k) => {
            if ((!profile[k] || (Array.isArray(profile[k]) && profile[k].length === 0)) && local[k] && local[k].length) {
              profile[k] = local[k];
            }
          });
        } catch (e) {}
        // v0.7.4：LLM 对求职意向/证明人/AI技能输出不稳定，本地兜底补抽（LLM 有值时保留 LLM，没值时回填）
        try {
          const localIRA = extractIntentReferenceAiSkills(msg.doc || "");
          ["intent", "reference", "aiSkills"].forEach((k) => {
            profile[k] = profile[k] || {};
            const localObj = localIRA[k] || {};
            Object.keys(localObj).forEach((sub) => {
              const cur = profile[k][sub];
              const lv = localObj[sub];
              const isEmpty = (cur === undefined || cur === null || cur === "" || (Array.isArray(cur) && cur.length === 0));
              if (isEmpty && (lv !== undefined && lv !== null && lv !== "" && !(Array.isArray(lv) && lv.length === 0))) {
                profile[k][sub] = lv;
              }
            });
          });
          // v0.8.11：紧急联系人兜底回填到 basic（LLM 没给时才填）
          const localEm = localIRA.emergency || {};
          profile.basic = profile.basic || {};
          ["emergencyContact", "emergencyPhone", "emergencyRelation"].forEach((k) => {
            const lv = localEm[k];
            const cur = profile.basic[k];
            const isEmpty = (cur === undefined || cur === null || cur === "");
            if (isEmpty && (lv !== undefined && lv !== null && lv !== "")) profile.basic[k] = lv;
          });
        } catch (e) {}
        // 合并已保存的「精通程度」：重新解析不应清空用户为每个语言单独设的等级
        try {
          const store = await getStorage(["profiles", "activeProfileId"]);
          const prev = (store.profiles || []).find((x) => x.id === store.activeProfileId);
          const prevLang = prev && prev.data && (prev.data.languages || []);
          if (prevLang && prevLang.length) {
            const m = {};
            prevLang.forEach((l) => { if (l && l.name && l.level) m[l.name] = l.level; });
            (profile.languages || []).forEach((l) => { if (l && l.name && m[l.name]) l.level = m[l.name]; });
          }
        } catch (e) {}
        const { profiles, activeId } = await ensureProfiles();
        const p = profiles.find((x) => x.id === activeId) || profiles[0];
        p.data = profile;
        await setStorage({ profiles, activeProfileId: p.id });
        sendResponse({ ok: true, profile });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.action === "mapFields") {
    const userText =
      "简历数据 JSON：\n" + JSON.stringify(redactSensitive(msg.profile), null, 2) +
      "\n\n页面字段列表（每项含 idx 和 label）：\n" + JSON.stringify(msg.fields, null, 2) +
      "\n\n请返回匹配映射 JSON。";
    callDeepSeek(MAP_SYSTEM, userText)
      .then((content) => {
        const result = safeParseJSON(content);
        if (!result) throw new Error("映射结果不是合法 JSON");
        sendResponse({ ok: true, mappings: result.mappings || [] });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.action === "injectFileMainWorld") {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "no_tab" });
      return true;
    }
    const target = { tabId };
    if (typeof sender.frameId === "number") target.frameIds = [sender.frameId];
    chrome.scripting
      .executeScript({
        target,
        world: "MAIN",
        func: mainWorldSetFile,
        args: [msg.b64, msg.name, msg.mime || "", msg.attr, msg.token],
      })
      .then((res) => {
        const r = res && res[0] ? res[0].result : null;
        sendResponse({ ok: !!(r && r.ok), detail: r || null });
      })
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  if (msg.action === "getFeedbackCount") {
    getStorage("feedbackQueue").then((r) =>
      sendResponse({ ok: true, count: (r.feedbackQueue || []).length })
    );
    return true;
  }

  // 百度抓取模式：content.js 在百度页扫完字段后发来，这里转发到本地 8901 接收器。
  // 用 background SW 的网络请求（不受百度页面 CSP 限制）绕过反调试读取。
  if (msg.action === "rfaCapture") {
    const data = msg.data || {};
    fetch("http://127.0.0.1:8901/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
});

// 点扩展图标 → 直接在当前招聘页打开「页面内面板」。
// 不再使用右上角小弹窗：小弹窗无法拖动，且打开系统文件选择框时会被浏览器强制关闭
// （这是 popup 的固有缺陷，正是之前「作品文件选不上」和「面板拖不动」的根因）。
chrome.action.onClicked.addListener((tab) => {
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { action: "openPanel" }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      // 当前页面无法注入（如 chrome://、扩展管理页等），退化为打开独立标签页
      chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
    }
  });
});
