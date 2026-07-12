# 句型道場 · 独立部署版

这是从 Claude 里那个 artifact 移植出来的独立版本,原来的功能（每日复习、每日作业、每周挑战、聴解練習、错题本、断点续做……）**一个都没少**,代码是直接从原文件复制过来的,只改了两个地方：

1. **AI 出题/判卷**：原来直连 Claude,现在改成先打到你自己的一个小后端接口,再由它转发给 **Gemini**（免费额度）
2. **进度存储**：原来用 Claude 的 `window.storage`，现在换成 **Supabase** 数据库（免费额度），并且支持**登录后跨设备同步**

全程不需要你会写代码，跟着下面的步骤点就行，大概 20~30 分钟能弄完。

---

## 你需要准备这几个账号（都免费，不用绑卡）

| 用途 | 平台 | 网址 |
|---|---|---|
| AI 出题判卷 | Google AI Studio | https://aistudio.google.com |
| 数据库+登录 | Supabase | https://supabase.com |
| 网站托管 | Vercel | https://vercel.com |
| 存代码（Vercel 需要） | GitHub | https://github.com |

---

## 第一步：申请 Gemini API Key

1. 打开 https://aistudio.google.com ，用你的 Google 账号登录
2. 左侧找到 **"Get API key"**，点 **"Create API key"**
3. 复制生成的这一长串字符，先粘贴到备忘录存着（等下部署到 Vercel 时要用）

**⚠️ 重要提醒**：申请过程中如果看到"启用结算/绑定信用卡"这类选项，**千万不要点**。免费额度不需要绑卡；一旦绑了卡开通计费，免费额度反而会立刻消失，所有调用都变成收费。

---

## 第二步：创建 Supabase 项目（数据库 + 登录）

1. 打开 https://supabase.com ，用 GitHub 账号登录最方便
2. 点 **"New Project"**，随便起个名字（比如 `jp-trainer`），数据库密码随便设一个记住就行，地区选离你近的（比如 Singapore）
3. 等 1~2 分钟项目创建完成后，左侧菜单点 **"SQL Editor"** → **"New query"**
4. 打开这个项目里的 `supabase/schema.sql` 文件，把里面的内容**整段复制粘贴**进去，点右下角 **"Run"**
   - 看到 "Success. No rows returned" 就说明建表成功了
5. 左侧菜单 **"Authentication"** → **"Providers"**，确认 **"Email"** 是打开状态（默认就是开的，一般不用改）
6. 左侧菜单 **"Authentication"** → **"URL Configuration"**，在 **"Redirect URLs"** 里先留空，等第四步部署到 Vercel 拿到网址后再回来填（下面会提醒你）
7. 左侧菜单 **"Project Settings"** → **"API"**，这个页面里有两个东西要记下来：
   - **Project URL**（形如 `https://xxxxxxxx.supabase.co`）
   - **anon public** 这一栏的 key（一长串字符）

---

## 第三步：把代码传到 GitHub

1. 打开 https://github.com ，点右上角 **"+"** → **"New repository"**，起名字（比如 `jp-trainer`），设成 **Private**（私有，别人看不到），点 **"Create repository"**
2. 把这整个项目文件夹上传上去。最简单的办法：GitHub 网页里点 **"uploading an existing file"**，把这个文件夹里所有文件拖进去上传（`node_modules` 文件夹如果有的话不用传，本来也没有）

（如果你熟悉命令行，也可以用 `git init` / `git add .` / `git commit` / `git push` 这套标准流程，效果一样）

---

## 第四步：部署到 Vercel

1. 打开 https://vercel.com ，用 GitHub 账号登录
2. 点 **"Add New..."** → **"Project"**，选择刚才那个 GitHub 仓库，点 **"Import"**
3. 展开 **"Environment Variables"**，依次添加三个：

   | Name | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | 第二步记下来的 Project URL |
   | `VITE_SUPABASE_ANON_KEY` | 第二步记下来的 anon public key |
   | `GEMINI_API_KEY` | 第一步申请的 Gemini API key |

4. 点 **"Deploy"**，等 1~2 分钟

5. 部署完成后，Vercel 会给你一个网址，形如 `https://jp-trainer-xxxx.vercel.app` —— **这就是你以后手机电脑都用这个网址打开的入口**，先复制下来

6. **回到 Supabase**：左侧菜单 **"Authentication"** → **"URL Configuration"**，把刚才那个 Vercel 网址填进 **"Site URL"**，并在 **"Redirect URLs"** 里也加一条（同样填这个网址），保存

---

## 第五步：打开网站，登录测试

1. 打开第四步拿到的那个 Vercel 网址
2. 输入你的邮箱，点"发送登录链接"
3. 去邮箱里点那条登录链接（第一次没收到就看看垃圾邮件）
4. 登录成功后就是完整的句型道場界面了，跟 Claude 里那个一模一样
5. **手机上重复第 1~3 步**，用同一个邮箱登录，进度会自动同步

---

## 想先在自己电脑上跑起来看看效果？（可选）

如果电脑上装了 Node.js，可以在这个项目文件夹里依次执行：

```bash
npm install
cp .env.example .env
# 编辑 .env,填入 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY(GEMINI_API_KEY 不用填在这里)
npm install -g vercel
vercel dev
```

`vercel dev` 会同时把 `/api/generate` 这个后端接口也跑起来（第一次运行会让你登录 Vercel 账号并配置 `GEMINI_API_KEY`），然后浏览器打开它提示的本地网址就能测试了。

---

## 把 Claude 里原来的学习进度搬过来

这个独立版本里"数据备份"那两个按钮（导出进度 / 导入进度）功能还在,格式完全兼容。操作方法：

1. 回到 Claude 里那个 artifact，点"导出进度"，复制那一整段文字
2. 打开这个新网站，登录后，首页最下面找到"导入进度"，粘贴进去，确认导入

就能把之前攒的学习记录原样搬过来。

---

## 关于费用（再强调一遍）

- **Gemini API**：Flash 模型免费额度是每分钟 15 次、每天 1500 次调用，这个应用每道题大概消耗 2 次调用，正常使用完全够，不会花钱。**千万别在 Google AI Studio 或 Google Cloud 里开通"结算"**，一旦开通，免费额度会直接消失。
- **Supabase**：免费额度是 500MB 数据库 + 5万月活用户，你一个人用，完全用不到这个量级。
- **Vercel**：免费额度对个人项目也很宽裕。

正常使用（每天做做题、复习）这一整套东西应该是**完全免费**的。

---

## 常见问题

**登录邮件收不到？**
去 Supabase 后台 → Authentication → Users，看看有没有生成用户记录；再检查垃圾邮件文件夹；如果一直收不到，Supabase 免费版的邮件发送有速率限制（每小时几封），等会儿再试。

**打开网站后一片空白？**
按 F12 打开浏览器控制台看报错信息，大概率是环境变量填错了（检查 Vercel 项目设置里那三个变量的值有没有多余的空格）。

**AI 出题一直失败？**
去 Google AI Studio 确认 API Key 还有效；也检查有没有不小心开通了结算导致 key 被限制。

**想自己绑个域名（比如换成好记的网址）？**
Vercel 项目设置里 "Domains" 那一栏可以加自定义域名，免费，跟着提示操作就行。

---

有任何一步卡住了，把具体报错信息或者截图发给我，我可以帮你继续排查。
