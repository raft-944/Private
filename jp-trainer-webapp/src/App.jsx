import { useState, useEffect, useRef, Component } from "react";

/* ================= 数据:大家的日语 初级 I+II 句型库 =================
   格式: [课, 句型, 接续, 意思, 例句(日), 例句(中)] */
const RAW = [
[1,"NはNです","名詞1 は 名詞2 です","…是…(判断句)","わたしは会社員です。","我是公司职员。"],
[1,"NはNではありません","名詞1 は 名詞2 ではありません","…不是…","サントスさんは学生ではありません。","桑托斯先生不是学生。"],
[1,"NはNですか","句尾 + か","…是…吗?(疑问)","ミラーさんは会社員ですか。","米勒先生是公司职员吗?"],
[1,"Nも","名詞 + も","…也…","サントスさんも会社員です。","桑托斯先生也是公司职员。"],
[2,"これ／それ／あれはNです","これ・それ・あれ は 名詞です","这/那/那(远)是…","これは辞書です。","这是词典。"],
[2,"このN／そのN／あのN","この・その・あの + 名詞","这个/那个…(修饰名词)","この傘はわたしのです。","这把伞是我的。"],
[2,"NのN(所属・内容)","名詞1 の 名詞2","…的…","これはコンピューターの本です。","这是关于电脑的书。"],
[3,"ここ／そこ／あそこはNです","ここ・そこ・あそこ は 名詞です","这里/那里是…","ここは食堂です。","这里是食堂。"],
[3,"NはN(場所)です","名詞 は 場所 です","…在…(位置)","電話は2階です。","电话在二楼。"],
[3,"Nはどこ／いくらですか","名詞 は どこ・いくら ですか","…在哪里/多少钱?","このワインはいくらですか。","这瓶葡萄酒多少钱?"],
[4,"今〜時〜分です","今 〜時〜分 です","现在是…点…分","今4時5分です。","现在是4点5分。"],
[4,"Vます／Vません／Vました","動詞ます形","动词敬体(现在/否定/过去)","毎朝6時に起きます。","每天早上6点起床。"],
[4,"〜から〜まで","名詞 から 名詞 まで","从…到…","9時から5時まで働きます。","从9点工作到5点。"],
[5,"N(場所)へ行きます","場所 へ 行きます・来ます・帰ります","去/来/回…(移动)","来月京都へ行きます。","下个月去京都。"],
[5,"N(乗り物)で行きます","乗り物 で 行きます","乘…去(交通手段)","電車で大阪へ行きます。","坐电车去大阪。"],
[5,"N(人)と行きます","人 と 動詞","和…一起…","家族と日本へ来ました。","和家人一起来了日本。"],
[6,"NをVます","名詞 を 動詞(他動詞)","…做…(宾语)","ジュースを飲みます。","喝果汁。"],
[6,"N(場所)でVます","場所 で 動詞","在…(地点)做…","駅で新聞を買います。","在车站买报纸。"],
[6,"一緒にVませんか","動詞ませんか","要不要一起…?(邀请)","一緒に京都へ行きませんか。","要不要一起去京都?"],
[6,"Vましょう","動詞ましょう","…吧(提议)","ちょっと休みましょう。","休息一下吧。"],
[7,"N(道具)でVます","道具・手段 で 動詞","用…(工具)做…","はしでご飯を食べます。","用筷子吃饭。"],
[7,"N(人)にあげます／もらいます","人 に あげます・もらいます","给…/从…得到","木村さんに花をあげました。","送给了木村小姐花。"],
[7,"もうVました","もう + 動詞ました","已经…了","もう昼ご飯を食べました。","已经吃过午饭了。"],
[8,"い形／な形容詞です","い形容詞です・な形容詞です","形容词谓语句","富士山は高いです。桜はきれいです。","富士山很高。樱花很漂亮。"],
[8,"あまり〜ません","あまり + 否定形","不太…","この町はあまりにぎやかではありません。","这个城市不太热闹。"],
[8,"Nはどうですか／どんなNですか","名詞 は どうですか・どんな 名詞","…怎么样?/什么样的…?","日本の生活はどうですか。","在日本的生活怎么样?"],
[9,"Nが好きです／上手です","名詞 が 好きです・嫌いです・上手です・下手です","喜欢/擅长…","わたしはイタリア料理が好きです。","我喜欢意大利菜。"],
[9,"Nがわかります／あります","名詞 が わかります・あります","懂…/有…","わたしは日本語が少しわかります。","我懂一点日语。"],
[9,"どうして…／〜から","文 + から","为什么…/因为…","時間がありませんから、新聞を読みません。","因为没有时间,所以不看报纸。"],
[10,"Nがあります／います","名詞 が あります(物)・います(人・動物)","有…(存在)","机の上に写真があります。","桌子上有照片。"],
[10,"N(場所)にNがあります／います","場所 に 名詞 が あります・います","在…有…","公園に子どもがいます。","公园里有孩子。"],
[10,"NはN(場所)にあります／います","名詞 は 場所 に あります・います","…在…(所在)","東京ディズニーランドは千葉県にあります。","东京迪士尼乐园在千叶县。"],
[11,"数量詞","〜つ・〜人・〜枚・〜台・〜本・〜冊 など","数量词(个/人/张/台…)","りんごを4つ買いました。","买了4个苹果。"],
[11,"期間に〜回","期間 に 〜回 動詞","(时间段)内…次(频率)","1か月に2回映画を見ます。","一个月看两次电影。"],
[11,"数量詞だけ","数量詞 + だけ","只…(仅仅)","りんごを1つだけ買いました。","只买了一个苹果。"],
[12,"N1はN2より〜","名詞1 は 名詞2 より 形容詞","…比…更…","飛行機は船より速いです。","飞机比船快。"],
[12,"N1とN2とどちらが〜","名詞1 と 名詞2 と どちらが 〜/〜のほうが〜","…和…哪个更…?","サッカーと野球とどちらが面白いですか。","足球和棒球哪个更有意思?"],
[12,"Nの中で〜が一番〜","名詞(範囲) の中で 〜が 一番 〜","在…之中…最…","日本料理の中で寿司が一番好きです。","日本菜里面最喜欢寿司。"],
[12,"形容詞の過去形","い形→〜かったです／な形→〜でした","形容词过去式","昨日は暑かったです。","昨天很热。"],
[13,"Nがほしいです","名詞 が ほしいです","想要…(东西)","わたしは車がほしいです。","我想要一辆车。"],
[13,"Vたいです","動詞ます形去ます + たいです","想做…","沖縄へ行きたいです。","想去冲绳。"],
[13,"N(場所)へVに行きます","場所 へ 動詞ます形去ます/名詞 に 行きます","去…做…(目的)","神戸へ映画を見に行きます。","去神户看电影。"],
[14,"Vてください","動詞て形 + ください","请做…","ちょっと待ってください。","请稍等。"],
[14,"Vています(進行)","動詞て形 + います","正在做…","今雨が降っています。","现在正在下雨。"],
[14,"Vましょうか","動詞ましょうか","我来…好吗?(主动帮忙)","荷物を持ちましょうか。","我来帮您拿行李吧?"],
[15,"Vてもいいです","動詞て形 + もいいです","可以做…(许可)","ここで写真を撮ってもいいですか。","可以在这里拍照吗?"],
[15,"Vてはいけません","動詞て形 + はいけません","不可以做…(禁止)","ここでたばこを吸ってはいけません。","这里不可以吸烟。"],
[15,"Vています(状態・職業)","動詞て形 + います","…着(状态)/从事…","わたしは結婚しています。姉は銀行で働いています。","我已经结婚了。姐姐在银行工作。"],
[16,"Vて、Vて、〜(順序)","動詞て形 でつなぐ","做…,然后做…(先后)","朝ジョギングをして、シャワーを浴びて、会社へ行きます。","早上跑步,然后洗澡,再去公司。"],
[16,"〜くて／〜で(並列)","い形→くて/な形・名詞→で","又…又…(并列描述)","ミラーさんは若くて、元気です。","米勒先生又年轻又有活力。"],
[16,"Vてから","動詞て形 + から","做完…之后再…","仕事が終わってから、飲みに行きます。","工作结束后去喝酒。"],
[16,"N1はN2が〜(属性)","名詞1 は 名詞2 が 形容詞","…的…很…(整体+部分)","大阪は食べ物がおいしいです。","大阪的食物很好吃。"],
[17,"Vないでください","動詞ない形 + でください","请不要做…","ここで写真を撮らないでください。","请不要在这里拍照。"],
[17,"Vなければなりません","動詞ない形去ない + なければなりません","必须做…","毎日薬を飲まなければなりません。","每天必须吃药。"],
[17,"Vなくてもいいです","動詞ない形去ない + なくてもいいです","不做…也可以","明日来なくてもいいです。","明天不来也可以。"],
[18,"Vることができます","動詞辞書形 + ことができます/名詞 が できます","会做…/能做…","ミラーさんは漢字を読むことができます。","米勒先生会读汉字。"],
[18,"趣味はVることです","趣味は 動詞辞書形 + ことです","爱好是做…","わたしの趣味は映画を見ることです。","我的爱好是看电影。"],
[18,"Vる／Nの前に","動詞辞書形・名詞の + 前に","做…之前","寝る前に、本を読みます。","睡觉前看书。"],
[19,"Vたことがあります","動詞た形 + ことがあります","曾经做过…(经历)","馬に乗ったことがあります。","骑过马。"],
[19,"Vたり、Vたりします","動詞た形 + り、動詞た形 + りします","又做…又做…(列举)","日曜日はテニスをしたり、映画を見たりします。","星期天打打网球、看看电影。"],
[19,"〜くなります／〜になります","い形→く/な形・名詞→に + なります","变得…(变化)","だんだん寒くなります。","渐渐变冷。"],
[20,"普通形(简体)","です・ます → 普通形","简体句(朋友间口语)","明日東京へ行く。寿司が好きだ。","明天去东京。喜欢寿司。"],
[21,"〜と思います","普通形 + と思います","我觉得/我认为…","明日雨が降ると思います。","我觉得明天会下雨。"],
[21,"〜と言いました","「引用」/普通形 + と言いました","(某人)说了…","首相は来月アメリカへ行くと言いました。","首相说下个月去美国。"],
[21,"Vるでしょう?","普通形 + でしょう?(升调)","…对吧?(确认)","明日パーティーに行くでしょう?","明天会去派对的吧?"],
[22,"名詞修飾節","普通形 + 名詞","…的…(定语从句)","これはミラーさんが作ったケーキです。","这是米勒先生做的蛋糕。"],
[23,"〜とき","普通形・名詞の + とき","…的时候","図書館で本を借りるとき、カードが要ります。","在图书馆借书的时候需要借书卡。"],
[23,"Vると、〜","動詞辞書形 + と","一…就…(自然结果)","このボタンを押すと、お釣りが出ます。","一按这个按钮,零钱就出来。"],
[24,"Nをくれます","人 は わたしに 名詞 を くれます","(别人)给我…","佐藤さんはわたしにチョコレートをくれました。","佐藤小姐给了我巧克力。"],
[24,"Vてあげます／もらいます／くれます","動詞て形 + あげます・もらいます・くれます","为别人做/请别人做/别人为我做","母はわたしにセーターを送ってくれました。","妈妈给我寄来了毛衣。"],
[25,"〜たら(条件)","動詞・形容詞た形 + ら","如果…的话/…之后","雨が降ったら、出かけません。","如果下雨就不出门。"],
[25,"〜ても(逆接)","動詞・形容詞て形 + も","即使…也…","雨が降っても、出かけます。","即使下雨也要出门。"],
[26,"〜んです","普通形 + んです","(说明原因/关切询问)","どうして遅れたんですか。","(你)为什么迟到了呢?"],
[26,"Vていただけませんか","動詞て形 + いただけませんか","能否请您…?(郑重请求)","いい先生を紹介していただけませんか。","能否请您介绍一位好老师?"],
[26,"疑問詞+Vたらいいですか","疑問詞 + 動詞た形 + らいいですか","该…才好呢?(请教)","どこでカメラを買ったらいいですか。","在哪里买相机好呢?"],
[27,"可能動詞","一段:見られる/五段:話せる/する→できる","会…/能…(可能形)","わたしは日本語が少し話せます。","我会说一点日语。"],
[27,"見えます／聞こえます","名詞 が 見えます・聞こえます","看得见/听得见(自然感知)","新幹線から富士山が見えます。","从新干线上看得见富士山。"],
[27,"しか〜ません","名詞 + しか + 否定形","只…(带遗憾语气)","ローマ字しか書けません。","只会写罗马字。"],
[28,"Vながら","動詞ます形去ます + ながら","一边…一边…","音楽を聞きながら、食事します。","一边听音乐一边吃饭。"],
[28,"Vています(習慣)","動詞て形 + います","(反复的习惯)","毎朝ジョギングをしています。","每天早上都跑步。"],
[28,"〜し、〜し","普通形 + し、普通形 + し","又…又…(列举理由)","田中先生は熱心だし、経験もあります。","田中老师既热心,又有经验。"],
[29,"Vています(結果の状態)","動詞て形 + います","…着(结果状态)","窓が割れています。","窗户破了(处于破的状态)。"],
[29,"Vてしまいました","動詞て形 + しまいました","(不小心)…了/彻底…了","パスポートをなくしてしまいました。","不小心把护照弄丢了。"],
[30,"Vてあります","動詞て形 + あります","(有人特意)…着(准备好的状态)","カレンダーに今月の予定が書いてあります。","日历上写着这个月的安排。"],
[30,"Vておきます","動詞て形 + おきます","事先做好…(准备)","旅行の前に、切符を買っておきます。","旅行前先把票买好。"],
[31,"意向形(Vよう)","五段:行こう/一段:食べよう/する→しよう","…吧(意志,简体)","少し休もう。","休息一会儿吧。"],
[31,"Vようと思っています","意向形 + と思っています","打算…(内心的打算)","週末は海へ行こうと思っています。","打算周末去海边。"],
[31,"Vるつもりです","動詞辞書形・ない形 + つもりです","打算…/不打算…","国へ帰って、会社をつくるつもりです。","打算回国开公司。"],
[31,"Vる予定です","動詞辞書形・名詞の + 予定です","预定…(计划安排)","7月に大阪へ出張する予定です。","预定7月去大阪出差。"],
[32,"Vたほうがいいです","動詞た形・ない形 + ほうがいいです","最好…/最好不要…(建议)","毎日運動したほうがいいです。","最好每天运动。"],
[32,"〜でしょう(推測)","普通形 + でしょう","大概…吧(推测)","明日は晴れるでしょう。","明天大概是晴天吧。"],
[32,"〜かもしれません","普通形 + かもしれません","也许…(可能性低)","約束の時間に間に合わないかもしれません。","也许赶不上约定的时间。"],
[33,"命令形／禁止形","五段:行け/一段:食べろ/+ な(禁止)","命令/禁止(强硬)","逃げろ。ここに入るな。","快逃!不许进这里。"],
[33,"〜という意味です","「〜」は 〜という意味です","是…的意思","「止まれ」は止まらなければならないという意味です。","「止まれ」是必须停下的意思。"],
[33,"〜と言っていました","人は 普通形 + と言っていました","(某人)说过…(转达)","田中さんは明日休むと言っていました。","田中先生说他明天休息。"],
[34,"Vた／Nのとおりに","動詞た形・名詞の + とおりに","按照…那样做","わたしがやったとおりに、やってください。","请按照我做的那样做。"],
[34,"Vたあとで","動詞た形・名詞の + あとで","…之后","仕事が終わったあとで、飲みに行きます。","工作结束之后去喝酒。"],
[34,"Vて／Vないで(付帯)","動詞て形/ない形 + で","(不)…的状态下做…","朝ご飯を食べないで、会社へ来ました。","没吃早饭就来公司了。"],
[35,"〜ば(条件形)","五段:押せば/一段:見れば/い形:安ければ","如果…就…(假定条件)","このボタンを押せば、窓が開きます。","按这个按钮的话,窗户就会开。"],
[35,"〜なら","名詞・普通形 + なら","要说…的话(就对方话题建议)","温泉なら、白馬がいいですよ。","要说温泉的话,白马不错哦。"],
[36,"〜ように(目的)","動詞辞書形・ない形 + ように","为了能…(目的)","早く泳げるように、毎日練習しています。","为了能早点学会游泳,每天都在练习。"],
[36,"Vようになりました","動詞辞書形(可能形) + ようになりました","变得能…了(能力变化)","日本語が話せるようになりました。","变得会说日语了。"],
[36,"Vようにしています","動詞辞書形・ない形 + ようにしています","坚持做…(努力保持)","毎日日記を書くようにしています。","坚持每天写日记。"],
[37,"受身(被动)","五段:言われる/一段:見られる/する→される","被…(被动)","わたしは部長に褒められました。","我被部长表扬了。"],
[38,"Vるのは〜です","動詞辞書形 + のは 形容詞です","做…(这件事)很…","絵をかくのは楽しいです。","画画很开心。"],
[38,"Vるのが〜です","動詞辞書形 + のが 好き・上手 など","喜欢/擅长做…","わたしは花を育てるのが好きです。","我喜欢养花。"],
[38,"Vるのを忘れました","動詞辞書形 + のを忘れました","忘了做…","車の窓を閉めるのを忘れました。","忘了关车窗。"],
[38,"〜のは〜です(強調)","強調したい部分を後ろに","…的是…(强调句)","初めて日本へ来たのは10年前です。","第一次来日本是10年前。"],
[39,"〜て／〜くて(原因)","動詞て形・い形くて・な形で","因为…(自然感情/状态的原因)","ニュースを聞いて、びっくりしました。","听到新闻吓了一跳。"],
[39,"〜ので","普通形(な形・名詞は+な) + ので","因为…(委婉客观理由)","用事があるので、お先に失礼します。","因为有事,先告辞了。"],
[40,"疑問詞〜か","疑問詞 + 普通形 + か","…呢(嵌入疑问)","パーティーに何人来るか、わかりません。","不知道有多少人来参加派对。"],
[40,"〜かどうか","普通形 + かどうか","是否…","忘れ物がないかどうか、調べてください。","请检查一下有没有遗忘的东西。"],
[40,"Vてみます","動詞て形 + みます","试着做…","もう一度考えてみます。","再考虑考虑看。"],
[41,"いただきます／くださいます","目上の人から:いただく・くださる","(敬语)得到/给我","わたしは部長にワインをいただきました。","我从部长那里得到了葡萄酒。"],
[41,"Vていただきました／てくださいました","動詞て形 + いただきます・くださいます","(敬语)请人做/别人为我做","部長の奥さんに茶道を教えていただきました。","请部长夫人教了我茶道。"],
[42,"〜ために(目的)","動詞辞書形・名詞の + ために","为了…(意志性目的)","家を買うために、貯金しています。","为了买房子在存钱。"],
[42,"〜のに(用途)","動詞辞書形 + のに 使います・要ります など","用于…(用途/评价)","このはさみは花を切るのに使います。","这把剪刀用来剪花。"],
[43,"〜そうです(様態)","動詞ます形去ます・形容詞語幹 + そうです","眼看要…/看起来…","今にも雨が降りそうです。このケーキはおいしそうです。","眼看就要下雨了。这个蛋糕看起来很好吃。"],
[43,"Vてきます","動詞て形 + きます","去…(马上)回来","ちょっとジュースを買ってきます。","我去买瓶果汁就回来。"],
[44,"〜すぎます","動詞ます形去ます・形容詞語幹 + すぎます","过于…/…过头","ゆうべ飲みすぎました。","昨晚喝多了。"],
[44,"Vやすい／Vにくい","動詞ます形去ます + やすい・にくい","容易…/难以…","このパソコンは使いやすいです。","这台电脑很好用。"],
[44,"〜く／〜にします","い形→く/な形・名詞→に + します","把…弄成…(人为改变)","音を小さくしてください。","请把声音调小。"],
[45,"〜場合は","動詞・形容詞普通形・名詞の + 場合は","…的情况下(万一)","領収書をなくした場合は、どうしたらいいですか。","万一弄丢了发票,该怎么办?"],
[45,"〜のに(逆接)","普通形(な形・名詞+な) + のに","明明…却…(意外/不满)","約束をしたのに、彼女は来ませんでした。","明明约好了,她却没来。"],
[46,"〜ところです","辞書形+ところ/ている+ところ/た形+ところ","正要…/正在…/刚刚…","これから昼ご飯を食べるところです。","现在正要吃午饭。"],
[46,"Vたばかりです","動詞た形 + ばかりです","刚…(说话人觉得时间短)","さっき駅に着いたばかりです。","刚刚到车站。"],
[46,"〜はずです","普通形(な形な・名詞の) + はずです","按理说应该…(有依据推断)","ミラーさんは今日来るはずです。","米勒先生今天应该会来。"],
[47,"〜そうです(伝聞)","普通形 + そうです","听说…(传闻)","天気予報によると、明日は寒くなるそうです。","据天气预报说,明天会变冷。"],
[47,"〜ようです","普通形(な形な・名詞の) + ようです","好像…(根据观察推测)","人がおおぜい集まっていますね。事故のようです。","聚集了好多人啊,好像是出事故了。"],
[48,"使役(させます)","五段:行かせる/一段:食べさせる/する→させる","让/叫(某人)做…","娘にピアノを習わせます。","让女儿学钢琴。"],
[48,"使役て形+いただけませんか","使役て形 + いただけませんか","能否允许我…?(请求许可)","すみませんが、早く帰らせていただけませんか。","不好意思,能让我早点回去吗?"],
[49,"尊敬語","れます・られます/お〜になります/特殊形","尊敬语(抬高对方)","社長はもう帰られました。先生は何時にお出かけになりますか。","社长已经回去了。老师几点出门?"],
[49,"お〜ください","お + 動詞ます形去ます + ください","请您…(郑重指示)","こちらで少々お待ちください。","请您在这边稍等。"],
[50,"謙譲語","お〜します・いたします/特殊形(伺う・申す など)","谦让语(降低自己)","重そうですね。お持ちしましょう。明日3時に伺います。","看起来很重,我来帮您拿吧。明天3点拜访您。"],
];

/* ===== 補充句型:课本精简遗漏 + N4高频实用扩展(标记「補充」) ===== */
const EXTRA = [
[3,"Nをください","名詞 を ください","请给我…(购物·点单)","すみません、このりんごを3つください。","不好意思,请给我3个这种苹果。"],
[4,"〜曜日","日・月・火・水・木・金・土曜日","星期…","今日は何曜日ですか。…水曜日です。","今天星期几?…星期三。"],
[5,"いつ〜ますか","いつ + 動詞","什么时候…?","いつ日本へ来ましたか。","你是什么时候来日本的?"],
[5,"どこ[へ]も〜ません","疑問詞 + も + 否定形","哪儿也不…/谁也不…","日曜日はどこへも行きません。","星期天哪儿也不去。"],
[6,"Nをお願いします","名詞 を お願いします","麻烦给我…(比ください更礼貌)","コーヒーをお願いします。","麻烦来一杯咖啡。"],
[8,"〜が、〜(前置き)","文 + が、文","…,(不过/请问)…(委婉开场)","すみませんが、駅はどこですか。","不好意思,请问车站在哪里?"],
[8,"〜ね／〜よ(終助詞)","文末 + ね・よ","…呢(共鸣)/…哦(告知)","今日は暑いですね。この店、おいしいですよ。","今天真热啊。这家店很好吃哦。"],
[9,"よく／あまり／全然","頻度副詞 + 動詞(全然・あまりは否定)","经常/不太/完全不…","彼は全然お酒を飲みません。","他完全不喝酒。"],
[10,"Nの上／下／中／隣","名詞 の 上・下・中・前・後ろ・隣・近く","…的上面/里面/旁边(方位)","銀行は郵便局の隣にあります。","银行在邮局旁边。"],
[10,"〜や〜(など)","名詞 や 名詞(など)","…和…等(不完全列举)","机の上に本やペンなどがあります。","桌上有书和笔等东西。"],
[11,"どのくらい","どのくらい かかりますか など","多长时间/多少(询问程度)","家から会社までどのくらいかかりますか。","从家到公司要花多长时间?"],
[11,"〜ずつ","数量詞 + ずつ","每…各…","一人に2枚ずつ配ってください。","请给每人各发两张。"],
[12,"〜と同じ／〜と違います","名詞 と 同じです・違います","和…一样/不一样","わたしのかばんはあなたのと同じです。","我的包和你的一样。"],
[13,"何か／どこか","何か・どこか + 動詞","(吃)点什么/(去)个什么地方","おなかがすきましたね。何か食べたいです。","肚子饿了呢,想吃点什么。"],
[13,"Vたがっています","動詞ます形去ます + たがっています","(第三人称)想…","娘は犬を飼いたがっています。","女儿很想养狗。"],
[14,"V方(かた)","動詞ます形去ます + 方","…的方法(读法/用法/做法)","この漢字の読み方を教えてください。","请告诉我这个汉字的读法。"],
[15,"まだVていません","まだ + 動詞て形 + いません","还没…(与もう〜ました相对)","昼ご飯はまだ食べていません。","午饭还没吃。"],
[16,"どうやって","どうやって + 動詞","怎么(做)?(询问方式)","駅までどうやって行きますか。","到车站怎么走?"],
[17,"〜なくちゃ／〜なきゃ(口語)","〜なければならない の口語縮約形","得…了(口语)","もう遅いから、帰らなくちゃ。","已经很晚了,我得回去了。"],
[18,"Vることがあります","動詞辞書形・ない形 + ことがあります","有时会…","忙しいとき、昼ご飯を食べないことがあります。","忙的时候有时不吃午饭。"],
[20,"〜かな(口語)","普通形 + かな","…吗/…呢(自言自语的疑问)","明日は晴れるかな。","明天会放晴吗(嘀咕)。"],
[21,"〜でしょうか","文 + でしょうか","…吗?(比ですか更委婉)","田中さんは今日来るでしょうか。","田中先生今天会来吗?"],
[22,"〜というN","名詞 + という + 名詞","叫做…的…","「さくら」というレストランを知っていますか。","你知道一家叫「さくら」的餐厅吗?"],
[24,"〜てくれてありがとう","動詞て形 + くれて、ありがとう","谢谢你为我…","手伝ってくれて、ありがとう。","谢谢你帮我。"],
[25,"もし〜たら","もし + 〜たら","如果…(强调假设)","もし1億円あったら、何をしたいですか。","如果有一亿日元,你想做什么?"],
[25,"〜たら(発見)","〜たら、〜た(過去)","一…发现…(意外发现)","家に帰ったら、友達が来ていました。","一回到家,发现朋友来了。"],
[26,"〜んですが、〜","〜んですが + 依頼・相談","我…,(能不能…)(委婉引出请求)","パソコンが動かないんですが、ちょっと見ていただけませんか。","我电脑动不了了,能帮我看一下吗?"],
[26,"〜たらどうですか","動詞た形 + らどうですか","…怎么样?(提建议)","薬を飲んだらどうですか。","吃点药怎么样?"],
[27,"疑問詞+でも","何でも・いつでも・どこでも・だれでも","无论什么/随时/哪里都…","わからないことがあったら、何でも聞いてください。","有不懂的,什么都可以问。"],
[28,"〜とか、〜とか","名詞・動詞 + とか","…啦…啦(口语列举)","日曜日は掃除とか洗濯とかをします。","星期天做做扫除啦、洗衣服啦。"],
[29,"〜ちゃった(口語)","〜てしまった の口語縮約形","(口语)不小心…了","電車の中にかさを忘れちゃった。","把伞忘在电车里了。"],
[30,"〜まま","動詞た形・名詞の + まま","保持…的状态(没变)","電気をつけたまま、出かけてしまいました。","开着灯就出门了。"],
[31,"Vることにしました","動詞辞書形・ない形 + ことにしました","决定…(自己做的决定)","来年、日本へ留学することにしました。","我决定明年去日本留学。"],
[31,"Vることになりました","動詞辞書形・ない形 + ことになりました","(客观)定下来要…","来月、大阪へ転勤することになりました。","(公司安排)下个月要调去大阪了。"],
[32,"きっと／たぶん／もしかしたら","副詞 +(でしょう・かもしれません)","一定/大概/说不定(推测副词呼应)","明日はたぶん雨が降るでしょう。","明天大概会下雨吧。"],
[33,"Vなさい","動詞ます形去ます + なさい","(父母对孩子等)快…!","早く宿題をしなさい。","快点写作业!"],
[35,"〜ばよかった","動詞ば形 + よかった","要是…就好了(后悔)","かさを持ってくればよかった。","要是带伞来就好了。"],
[37,"迷惑の受身","わたしは 人に 〜られました","被…(受害·添麻烦的被动)","電車で隣の人に足を踏まれました。","在电车上被旁边的人踩了脚。"],
[39,"〜て、すみません","動詞て形 + すみません","因为…,对不起","返事が遅れて、すみません。","回复晚了,对不起。"],
[40,"Vてみたいです","動詞て形 + みたいです","想尝试一次…","一度着物を着てみたいです。","想穿一次和服试试。"],
[43,"Vていきます","動詞て形 + いきます","…了再去/…着去(与てきます相对)","寒いですから、コートを着ていきます。","很冷,所以穿上大衣去。"],
[44,"Nにします(選択)","名詞 + にします","决定要…(点单·选择)","飲み物は何にしますか。…コーヒーにします。","饮料要什么?…我要咖啡。"],
[45,"いくら〜ても","いくら + 〜ても","无论怎么…都…","いくら押しても、ドアが開きません。","怎么推门都打不开。"],
[46,"〜はずがありません","普通形 + はずがありません","不可能…(有依据的否定)","まじめな彼が嘘をつくはずがありません。","认真的他不可能说谎。"],
[47,"〜らしいです","普通形 + らしいです","好像/据说…(听来的推断)","あの二人は来月結婚するらしいです。","那两个人好像下个月要结婚。"],
[48,"使役受身(させられる)","五段:飲まされる/一段:食べさせられる","被迫做…","子どものとき、母に嫌いな野菜を食べさせられました。","小时候被妈妈逼着吃讨厌的蔬菜。"],
[49,"お／ご+N(美化語)","お + 和語/ご + 漢語","(礼貌接头词)您的…","お名前とご住所をお書きください。","请写下您的姓名和住址。"],
[50,"〜ております(謙譲)","動詞て形 + おります","(谦让)正在…(商务·电话用语)","田中はただ今、席を外しております。","田中现在不在座位上。"],
];

const PATTERNS = [
  ...RAW.map((r, i) => ({ id: i, ext: false, lesson: r[0], jp: r[1], conn: r[2], cn: r[3], exJp: r[4], exCn: r[5] })),
  ...EXTRA.map((r, i) => ({ id: RAW.length + i, ext: true, lesson: r[0], jp: r[1], conn: r[2], cn: r[3], exJp: r[4], exCn: r[5] })),
];
/* 学习与展示顺序:按课次排序;id 保持稳定,已保存的进度不受影响 */
const ORDERED = [...PATTERNS].sort((a, b) => a.lesson - b.lesson || a.id - b.id);

/* ================= 遗忘曲线参数 ================= */
const INTERVALS = [1, 2, 4, 7, 15, 30, 60]; // 天
const STORE_KEY = "jp_srs_v1";
const TOPICS = ["日常生活","工作·公司","旅行","购物","天气·季节","家庭","饮食","兴趣爱好","交通·车站","健康·医院","学习·学校","朋友之间"];

/* 北京时间日期 */
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const mondayOf = (d) => { const dt = new Date(d + "T00:00:00Z"); const day = dt.getUTCDay(); dt.setUTCDate(dt.getUTCDate() + (day === 0 ? -6 : 1) - day); return dt.toISOString().slice(0, 10); };
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const DEFAULT_DB = { prog: {}, settings: { newPerDay: 3, voiceURI: null }, meta: { date: "", newDone: 0 }, mistakes: [], stats: { total: 0, ok: 0 }, listenStats: { total: 0, ok: 0 }, session: null };

/* 听力难度分级:根据听力累计答对次数自动升级 */
function listenTier(ok) {
  if (ok >= 20) return { name: "高级", spec: "句子长度20~35个日语字符,可以包含两个分句或一个从属结构(比如用て形连接、から表原因、条件句等),用词可以更丰富一些(仍在N4范围内),信息量更接近自然口语。" };
  if (ok >= 8) return { name: "中级", spec: "句子长度15~25个日语字符,可以包含一个简单的连接(比如て形、から、し等),比最基础的单句稍微复杂一点。" };
  return { name: "基础", spec: "句子长度8~14个日语字符,单句,只使用最常见的N5核心词汇,结构简单清晰。" };
}

/* ================= AI 调用 ================= */
/* 从文本中提取第一段完整、闭合的 JSON 对象(正确跳过字符串内的引号/转义,不会被
   字符串里偶然出现的花括号,或AI多输出的第二段内容干扰) */
function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
  }
  return null; // 花括号没配平,大概率是被截断了
}

async function callAI(system, user) {
  let lastErr;
  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_tokens: 1200, system, user }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = (data && data.error && data.error.message) || ("HTTP " + res.status);
        const err = new Error(msg);
        err.status = res.status;
        err.retryAfter = data && data.error && data.error.retryAfter;
        throw err;
      }
      const text = (data.content || []).map((c) => (c.type === "text" ? c.text : "")).join("");
      const jsonStr = extractFirstJsonObject(text);
      if (!jsonStr) throw new Error("返回内容不含完整JSON:" + text.slice(0, 80));
      const parsed = JSON.parse(jsonStr);
      if (!parsed || typeof parsed !== "object") throw new Error("解析结果异常");
      return parsed;
    } catch (e) {
      lastErr = e;
      const s = e && e.status;
      if (s === 429) {
        // Gemini免费额度的短时限流,通常等它建议的秒数就能恢复,自动等一下再重试(而不是直接放弃)
        if (attempt < MAX_ATTEMPTS - 1) {
          const wait = e.retryAfter && e.retryAfter > 0 ? Math.min(e.retryAfter, 45) : 15;
          await new Promise((r) => setTimeout(r, wait * 1000 + 500));
          continue;
        }
        throw e;
      }
      // 其它4xx(除408外)属确定性错误(参数不对、密钥问题等),重试无意义,直接抛出
      if (s >= 400 && s < 500 && s !== 408) throw e;
      if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/* 用浏览器内置的语音合成朗读日语,免费、不消耗AI额度 */
function speakJa(text, rate = 1, voiceURI) {
  if (!window.speechSynthesis) return false;
  window.speechSynthesis.cancel(); // 打断上一句还没播完的
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ja-JP";
  u.rate = rate;
  if (voiceURI) {
    const v = window.speechSynthesis.getVoices().find((v) => v.voiceURI === voiceURI);
    if (v) u.voice = v;
  }
  window.speechSynthesis.speak(u);
  return true;
}

async function genComboQuestion(p1, p2, avoid) {
  const sys = "あなたは日本語教師です。学習者:JLPT N5〜N4(《大家的日语》初级水平)。出题词汇必须限定在初级范围内。只输出JSON,不要输出任何其他文字、说明或Markdown。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号\",否则会破坏JSON格式。";
  const user = `请出一道"複合作文"练习题,要求学习者在同一句话(或简短的两三句对话)中,同时正确使用以下两个句型。
句型A: ${p1.jp}(${p1.conn} / ${p1.cn})
句型B: ${p2.jp}(${p2.conn} / ${p2.cn})
请给出一个中文情境提示(30字以内),说明想表达的内容,让学习者据此写出同时包含这两个句型的日语句子或简短对话。
${avoid && avoid.length ? "避免与这些情境雷同: " + avoid.join(" / ") : ""}
输出JSON格式: {"task":"情境提示(中文)","hint":""}`;
  const q = await callAI(sys, user);
  if (!q.task) throw new Error("bad question");
  return { ...q, type: "combo", label: "複合作文 · 请在一句话/一段小对话里同时用上下面两个句型" };
}

async function gradeCombo(p1, p2, q, answer) {
  const sys = "あなたは丁寧で親切な日本語教師です。判定と讲解を行います。讲解は中文为主、适当夹杂日语术语(中日混合)。学習者水平:N5〜N4。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号\",否则会破坏JSON格式。";
  const user = `句型A: ${p1.jp}(${p1.conn} / ${p1.cn})
句型B: ${p2.jp}(${p2.conn} / ${p2.cn})
题目(複合作文): ${q.task}
学生的答案: ${answer}

判定标准:
- "correct": 两个句型都被正确使用,整体语法通顺
- "partial": 至少正确用了一个句型,或两个都用了但有小错误
- "wrong": 两个句型基本都没用对,或严重语法错误,或没有作答

输出JSON: {"verdict":"correct|partial|wrong","reference":"一个自然的参考答案(日语,需同时包含两个句型)","explanation":"分别点评两个句型各自的使用情况,指出哪里好、哪里需要改,中日混合,150字以内"}`;
  const g = await callAI(sys, user);
  if (!g.verdict) throw new Error("bad grade");
  return g;
}

async function genListeningSentence(p, avoid, tier) {
  const sys = "あなたは日本語教師です。学習者:JLPT N5〜N4(《大家的日语》初级水平)。词汇必须限定在初级范围内,句子要自然、适合朗读听力练习。只输出JSON,不要输出任何其他文字、说明或Markdown。重要:JSON字符串内部如果需要引用假名/单词,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。";
  const user = `请为以下句型新造一句自然的日语例句(不要用课本原句),用于听力练习,学习者只能听、看不到文字。
句型: ${p.jp}(${p.conn} / ${p.cn})
难度档位(${tier.name}): ${tier.spec}
其他要求:
1. 必须包含该句型
2. 尽量避免使用读音容易产生歧义的多音字(比如「町」可读まち也可读ちょう、「方」可读かた也可读ほう、「今日」可读きょう也可读こんにち等),如果拿不准某个汉字在这个语境下会不会被朗读引擎读错,就换一种说法
3. 同时给出这句话完整、准确的平假名读音(所有汉字都转写为该语境下正确的读音,片假名词保留片假名,这份读音会被直接朗读引擎使用,绝对不能有歧义或错误)
${avoid && avoid.length ? "避免与这些句子雷同: " + avoid.join(" / ") : ""}
输出JSON格式: {"jp":"日语例句(汉字假名混写,自然书写形式)","yomi":"这句话完整的平假名读音(不含汉字,供朗读使用)","cn":"对应的中文意思(参考答案)"}`;
  const s = await callAI(sys, user);
  if (!s.jp || !s.cn) throw new Error("bad listening sentence");
  return s;
}

async function gradeListening(p, q, answer) {
  const sys = "あなたは丁寧で親切な日本語教師です。判定と讲解を行います。讲解は中文为主、适当夹杂日语术语(中日混合)。学習者水平:N5〜N4。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词,一律使用「」或中文引号包裹,绝对不能使用英文直引号,否则会破坏JSON格式。";
  const user = `目标句型: ${p.jp}(${p.conn} / ${p.cn})
听力原文(日语,学生只听到了声音,没看到文字): ${q.jp}
学生听写下来的内容(允许用假名代替汉字,这不算错): ${answer}

这是"听写"练习,检验的是听觉辨音的精确度,不是翻译理解能力,请按以下标准判定:
- "correct": 每个词、助词、动词/形容词的活用形式都听对了(汉字写成假名、或明显的打字失误不算错;只要读音和语法形式对应正确即可)
- "partial": 大体框架听对了,但漏听/听错了个别助词、词尾变化或某个词
- "wrong": 明显没听清,内容和原文有实质性出入,或没有作答

输出JSON: {"verdict":"correct|partial|wrong","explanation":"具体指出听写内容和原文的差异(比如漏了哪个助词、把哪个词的活用形式听错了),再用一句话说明这句话的中文意思,中日混合,120字以内"}`;
  const g = await callAI(sys, user);
  if (!g.verdict) throw new Error("bad grade");
  return { ...g, reference: q.jp };
}

async function genQuestion(p, avoid, forceType) {
  const type = forceType || (Math.random() < 0.6 ? "translation" : "composition");
  const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
  const sys = "あなたは日本語教師です。学習者:JLPT N5〜N4(《大家的日语》初级水平)。出题词汇必须限定在初级范围内。只输出JSON,不要输出任何其他文字、说明或Markdown。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号\",否则会破坏JSON格式。";
  const user = `请围绕以下句型出一道练习题。
句型: ${p.jp}
接续: ${p.conn}
意思: ${p.cn}
课本例句: ${p.exJp}
题目类型: ${type === "translation" ? "翻译题——给出一句自然的中文短句(15字以内),该句翻译成日语时必须使用上述句型" : `造句题——请按以下要求出题:
1. 场景(中文,25字以内)只能表达一个清晰、单一的意思,不能同时塞入两件不相关的信息(例如不要把"喜欢什么"和"东西放在哪里"混在同一个场景里)
2. 场景要让人一眼就能看出应该表达什么内容、用什么结构回答,不能有歧义,不能让人猜"到底要写哪一层意思"
3. 场景里包含的信息必须刚好等于、也只等于目标句型所需要表达的内容——不多给、也不少给
4. 提示词(1~2个日语单词,不是整句)必须直接服务于这唯一的意思,不能引向别的方向`}
话题方向: ${topic}
${avoid && avoid.length ? "避免与这些题目雷同: " + avoid.join(" / ") : ""}
输出JSON格式: {"type":"${type}","task":"题目内容(中文)","hint":"提示(可为空字符串,如提示词或注意点)"}`;
  const q = await callAI(sys, user);
  if (!q.task) throw new Error("bad question");
  return q;
}

async function gradeAnswer(p, q, answer) {
  const sys = "あなたは丁寧で親切な日本語教師です。判定と讲解を行います。讲解は中文为主、适当夹杂日语术语(中日混合)。学習者水平:N5〜N4。只输出JSON,不要输出任何其他文字。重要:JSON字符串内部如果需要引用假名/单词/例句,一律使用「」或中文引号包裹,绝对不能使用英文直引号\",否则会破坏JSON格式。";
  const user = `句型: ${p.jp}(${p.conn} / ${p.cn})
题目(${q.type === "translation" ? "翻译题" : "造句题"}): ${q.task} ${q.hint ? "提示:" + q.hint : ""}
学生的答案: ${answer}

判定标准:
- "correct": 语法正确且正确使用了目标句型(允许不同但自然的表达、汉字/假名书写差异)
- "partial": 用了目标句型且意思基本传达,但有小错误(助词、活用、时态等)
- "wrong": 没有使用目标句型,或有严重语法错误,或意思不对

输出JSON: {"verdict":"correct|partial|wrong","reference":"一个自然的参考答案(日语)","explanation":"针对学生答案的具体讲解,指出好在哪/错在哪及如何改,中日混合,120字以内"}`;
  const g = await callAI(sys, user);
  if (!g.verdict) throw new Error("bad grade");
  return g;
}

/* ================= 印章组件(签名元素) ================= */
function Stamp({ verdict }) {
  const cfg = {
    correct: { mark: "◎", label: "よくできました", sub: "花丸!完全正确" },
    partial: { mark: "△", label: "おしい!", sub: "接近了,还有小错" },
    wrong: { mark: "✗", label: "もう一度", sub: "句型没用对,再来" },
  }[verdict];
  return (
    <div className="stamp">
      <div className="stamp-mark">{cfg.mark}</div>
      <div className="stamp-label">{cfg.label}</div>
      <div className="stamp-sub">{cfg.sub}</div>
    </div>
  );
}

/* ================= 主应用 ================= */
function AppInner() {
  const [db, setDb] = useState(null);
  const [storageOk, setStorageOk] = useState(true);
  const [needsFirstUseConfirm, setNeedsFirstUseConfirm] = useState(false);
  const [speechOk] = useState(() => typeof window !== "undefined" && !!window.speechSynthesis);
  const [jaVoices, setJaVoices] = useState([]);

  useEffect(() => {
    if (!window.speechSynthesis) return;
    const loadVoices = () => {
      const all = window.speechSynthesis.getVoices();
      setJaVoices(all.filter((v) => v.lang && v.lang.toLowerCase().startsWith("ja")));
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices; // 语音列表常常是异步加载的
    return () => { window.speechSynthesis.onvoiceschanged = null; };
  }, []);
  const [view, setView] = useState("home"); // home | session | library | mistakes
  const loaded = useRef(false);

  /* --- 学习会话状态 --- */
  const [queue, setQueue] = useState([]);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState("idle"); // intro | loadingQ | question | grading | result | error | done
  const [q, setQ] = useState(null);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState(null);
  const [freeMode, setFreeMode] = useState(false);
  const [homeworkMode, setHomeworkMode] = useState(false);
  const [weeklyMode, setWeeklyMode] = useState(false);
  const [listenMode, setListenMode] = useState(false);
  const [weeklyFormal, setWeeklyFormal] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importMsg, setImportMsg] = useState("");
  const [copyMsg, setCopyMsg] = useState("");
  const [sessionStats, setSessionStats] = useState({ ok: 0, partial: 0, wrong: 0 });
  const [errMsg, setErrMsg] = useState("");
  const [openLesson, setOpenLesson] = useState(null);
  const actionsRef = useRef({});
  const recentTasks = useRef({});

  /* --- 读档 --- */
  useEffect(() => {
    (async () => {
      let ok = false;
      let data = null;
      const MAX_ATTEMPTS = 8;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !ok; attempt++) {
        try {
          if (!window.storage || typeof window.storage.get !== "function") {
            // 存储桥接尚未就绪(移动端常见的注入延迟),稍等后重试,而不是直接放弃
            throw new Error("storage bridge not ready yet");
          }
          const r = await window.storage.get(STORE_KEY);
          // get 成功就一定代表读到了真实数据(官方文档:不存在的 key 只会抛错,不会返回 null)
          data = r && r.value ? { ...DEFAULT_DB, ...JSON.parse(r.value) } : { ...DEFAULT_DB };
          ok = true;
        } catch {
          // 拿不到明确结果:可能真的是首次使用,也可能只是网络/桥接抖动
          // 这两种情况没法从一次失败里区分,所以这里绝不自动写入空白数据去"验证可用性"
          // 那样做一旦命中"其实是抖动"的情况,就会把已有的真实进度覆盖成空白
        }
        if (!ok) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
      setStorageOk(ok);
      if (ok) {
        setDb(data);
        setTimeout(() => (loaded.current = true), 0);
      } else {
        // 反复重试都无法确认云端状态:交给用户手动确认,而不是替他做"当作首次使用"这个有风险的决定
        setNeedsFirstUseConfirm(true);
      }
    })();
  }, []);

  /* --- 存档 --- */
  useEffect(() => {
    if (!db || !loaded.current) return;
    let cancelled = false;
    (async () => {
      const MAX_ATTEMPTS = 5;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          if (window.storage && typeof window.storage.set === "function") {
            const w = await window.storage.set(STORE_KEY, JSON.stringify(db));
            if (w) { if (!cancelled) setStorageOk(true); return; }
          }
        } catch { /* 重试 */ }
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
      if (!cancelled) setStorageOk(false);
    })();
    return () => { cancelled = true; };
  }, [db]);

  /* --- 断点快照:每次题号/队列变化时,把"做到第几题"写入 db.session --- */
  useEffect(() => {
    if (!loaded.current || view !== "session" || queue.length === 0 || phase === "done") return;
    let kind = null;
    if (weeklyMode && weeklyFormal) kind = "weekly";
    else if (homeworkMode) kind = "homework";
    else if (listenMode) kind = "listen";
    else if (!freeMode) kind = "srs";
    if (!kind) return; // 自由练习/单题重练,不必断点续做
    const items = queue.map((it) => {
      if (kind === "homework") return it.sub === "combo" ? { sub: "combo", pid1: it.p1.id, pid2: it.p2.id, mistakeId: it.mistakeId } : { pid: it.p.id, hw: it.hw, mistakeId: it.mistakeId };
      if (kind === "weekly") return it.sub === "combo" ? { sub: "combo", pid1: it.p1.id, pid2: it.p2.id, mistakeId: it.mistakeId } : { sub: "weak", pid: it.p.id, mistakeId: it.mistakeId };
      return { pid: it.p.id, isNew: it.isNew };
    });
    setDb((d) => ({ ...d, session: { kind, items, idx, stats: sessionStats } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, idx, sessionStats, phase, view, weeklyMode, weeklyFormal, homeworkMode, listenMode, freeMode]);

  /* --- 回车快捷键:讲解页/新句型页/错误页按 Enter 等同于点主按钮(答题框内是 Enter 提交、Shift+Enter 换行,逻辑写在文本框自己的 onKeyDown 里) --- */
  useEffect(() => {
    if (view !== "session") return;
    const onKey = (e) => {
      if (e.key !== "Enter") return;
      const a = actionsRef.current;
      if (phase === "intro" && a.cur && a.loadQuestion) { e.preventDefault(); a.loadQuestion(a.cur.p); }
      else if (phase === "result" && a.next) { e.preventDefault(); a.next(); }
      else if (phase === "error" && a.retry) { e.preventDefault(); a.retry(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, phase]);

  const confirmFirstUse = () => {
    setDb({ ...DEFAULT_DB });
    setNeedsFirstUseConfirm(false);
    setTimeout(() => (loaded.current = true), 0);
  };

  if (needsFirstUseConfirm) {
    return (
      <div className="app"><Style />
        <div className="confirm-screen">
          <div className="confirm-title serif">連不上云端存储</div>
          <div className="confirm-text">
            反复尝试后,还是没能确认云端是否已经保存过你的学习记录。
            <br /><br />
            <b>如果你之前用过这个应用、应该是有进度的</b>——请先刷新页面重试,暂时不要点下面的按钮,避免这次被误判成"首次使用"、把你的真实记录覆盖掉。
            <br /><br />
            如果这确实是你第一次打开这个应用,点击下面按钮正常开始就可以。
          </div>
          <button className="btn-main" onClick={confirmFirstUse}>确认是首次使用,开始学习</button>
        </div>
      </div>
    );
  }

  if (!db) return <div className="app"><Style /><div className="center-msg">読み込み中…</div></div>;

  /* --- 派生数据 --- */
  const t = today();
  const learnedIds = Object.keys(db.prog).map(Number);
  const dueList = PATTERNS.filter((p) => db.prog[p.id] && db.prog[p.id].due <= t);
  const unlearned = PATTERNS.filter((p) => !db.prog[p.id]);
  const newDoneToday = db.meta.date === t ? db.meta.newDone : 0;
  const newSlots = Math.max(0, db.settings.newPerDay - newDoneToday);
  const newList = unlearned.slice(0, newSlots);
  const learnedPatterns = PATTERNS.filter((p) => db.prog[p.id]);
  const recentCutoff = addDays(t, -6);
  const recentPool = learnedPatterns.filter((p) => db.prog[p.id].learnedDate && db.prog[p.id].learnedDate >= recentCutoff);
  const comboPool = recentPool.length >= 2 ? recentPool : learnedPatterns;
  const weekReady = comboPool.length >= 2;
  const weekDone = db.meta.weekKey === mondayOf(t);

  /* --- 会话流程 --- */
  const startSession = () => {
    const items = [
      ...dueList.sort((a, b) => (db.prog[a.id].due < db.prog[b.id].due ? -1 : 1)).map((p) => ({ p, isNew: false })),
      ...newList.map((p) => ({ p, isNew: true })),
    ];
    if (!items.length) return;
    setQueue(items); setIdx(0); setFreeMode(false); setHomeworkMode(false); setWeeklyMode(false); setWeeklyFormal(false); setListenMode(false);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 });
    setView("session");
    beginItem(items[0]);
  };

  const startFree = (p, mistakeId) => {
    setQueue([{ p, isNew: false, mistakeId }]); setIdx(0); setFreeMode(true); setHomeworkMode(false); setWeeklyMode(false); setWeeklyFormal(false); setListenMode(false);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 });
    setView("session");
    loadQuestion(p);
  };

  const startListenFree = (p, mistakeId) => {
    const item = { p, isNew: false, mistakeId };
    setQueue([item]); setIdx(0); setFreeMode(true); setHomeworkMode(false); setWeeklyMode(false); setWeeklyFormal(false); setListenMode(true);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 });
    setView("session");
    beginListenItem(item);
  };

  const startHomework = () => {
    const learned = PATTERNS.filter((p) => db.prog[p.id]);
    if (learned.length === 0) return;
    const pickN = (n, pool) => {
      const shuffled = [...pool].sort(() => Math.random() - 0.5);
      const out = [];
      for (let i = 0; i < n; i++) out.push(shuffled[i % shuffled.length]);
      return out;
    };

    // 优先把当前错题混进今天的作业里,做对了会自动从錯題本移除,不用你另外再点一次"闯关"
    let compCount = 0, transCount = 0;
    const mistakeItems = [];
    for (const m of db.mistakes) {
      if (mistakeItems.length >= 10) break;
      if (m.pid2 !== undefined) mistakeItems.push({ sub: "combo", p1: PATTERNS[m.pid], p2: PATTERNS[m.pid2], mistakeId: m.id });
      else if (compCount <= transCount) { mistakeItems.push({ p: PATTERNS[m.pid], hw: "comp", mistakeId: m.id }); compCount++; }
      else { mistakeItems.push({ p: PATTERNS[m.pid], hw: "trans", mistakeId: m.id }); transCount++; }
    }
    const remain = Math.max(0, 10 - mistakeItems.length);
    const remainComp = Math.min(remain, Math.max(0, 5 - compCount));
    const remainTrans = remain - remainComp;
    const items = [
      ...mistakeItems,
      ...pickN(remainComp, learned).map((p) => ({ p, hw: "comp" })),
      ...pickN(remainTrans, learned).map((p) => ({ p, hw: "trans" })),
    ];
    setQueue(items); setIdx(0); setFreeMode(true); setHomeworkMode(true); setWeeklyMode(false); setWeeklyFormal(false); setListenMode(false);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 });
    setView("session");
    beginHomeworkItem(items[0]);
  };

  const startWeekly = () => {
    if (comboPool.length < 2) return;
    const pickPair = () => {
      const a = comboPool[Math.floor(Math.random() * comboPool.length)];
      let b = comboPool[Math.floor(Math.random() * comboPool.length)];
      let tries = 0;
      while (b.id === a.id && tries < 10) { b = comboPool[Math.floor(Math.random() * comboPool.length)]; tries++; }
      return [a, b];
    };
    const combos = Array.from({ length: 5 }, pickPair);
    const cutoff = recentCutoff;
    const counts = {};
    db.mistakes.forEach((m) => { if (m.date >= cutoff) counts[m.pid] = (counts[m.pid] || 0) + 1; });
    let weakPids = Object.keys(counts).map(Number).sort((a, b) => counts[b] - counts[a]).slice(0, 3);
    if (weakPids.length === 0) {
      weakPids = [...learnedPatterns].sort((a, b) => db.prog[a.id].lv - db.prog[b.id].lv).slice(0, 3).map((p) => p.id);
    }
    const items = [
      ...combos.map(([p1, p2]) => ({ sub: "combo", p1, p2 })),
      ...weakPids.map((pid) => ({ sub: "weak", p: PATTERNS[pid] })),
    ];
    setQueue(items); setIdx(0); setFreeMode(true); setHomeworkMode(false); setWeeklyMode(true); setWeeklyFormal(true); setListenMode(false);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 });
    setView("session");
    beginWeeklyItem(items[0]);
  };

  const startListening = () => {
    const learned = PATTERNS.filter((p) => db.prog[p.id]);
    if (learned.length === 0) return;
    const shuffled = [...learned].sort(() => Math.random() - 0.5);
    const items = Array.from({ length: 8 }, (_, i) => ({ p: shuffled[i % shuffled.length], isNew: false }));
    setQueue(items); setIdx(0); setFreeMode(true); setHomeworkMode(false); setWeeklyMode(false); setWeeklyFormal(false); setListenMode(true);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 });
    setView("session");
    beginListenItem(items[0]);
  };

  const beginListenItem = (item) => {
    setAnswer(""); setResult(null);
    loadListeningQuestion(item.p);
  };

  const loadListeningQuestion = async (p) => {
    setPhase("loadingQ"); setAnswer(""); setResult(null);
    try {
      const key = "listen_" + p.id;
      const avoid = recentTasks.current[key] || [];
      const tier = listenTier(db.listenStats.ok);
      const s = await genListeningSentence(p, avoid, tier);
      recentTasks.current[key] = [...avoid, s.jp].slice(-4);
      setQ({ type: "listening", jp: s.jp, yomi: s.yomi || s.jp, cnRef: s.cn, task: "", hint: "", label: `聴解(聴き取り・${tier.name}) · 只听声音,写出你听到的日语(仮名でもOK)` });
      setPhase("question");
    } catch (e) {
      setErrMsg("出题失败:" + (e && e.message ? e.message : String(e))); setPhase("error");
    }
  };

  const startComboFree = (p1, p2, mistakeId) => {
    setQueue([{ sub: "combo", p1, p2, mistakeId }]); setIdx(0); setFreeMode(true); setHomeworkMode(false); setWeeklyMode(true); setWeeklyFormal(false); setListenMode(false);
    setSessionStats({ ok: 0, partial: 0, wrong: 0 });
    setView("session");
    beginWeeklyItem({ sub: "combo", p1, p2, mistakeId });
  };

  const beginItem = (item) => {
    setAnswer(""); setResult(null); setQ(null);
    if (item.isNew) setPhase("intro");
    else loadQuestion(item.p);
  };

  const resumeSession = () => {
    const s = db.session;
    if (!s) return;
    let items;
    if (s.kind === "homework") items = s.items.map((d) => d.sub === "combo" ? { sub: "combo", p1: PATTERNS[d.pid1], p2: PATTERNS[d.pid2], mistakeId: d.mistakeId } : { p: PATTERNS[d.pid], hw: d.hw, mistakeId: d.mistakeId });
    else if (s.kind === "weekly") items = s.items.map((d) => d.sub === "combo" ? { sub: "combo", p1: PATTERNS[d.pid1], p2: PATTERNS[d.pid2], mistakeId: d.mistakeId } : { sub: "weak", p: PATTERNS[d.pid], mistakeId: d.mistakeId });
    else items = s.items.map((d) => ({ p: PATTERNS[d.pid], isNew: d.isNew }));
    setQueue(items); setIdx(s.idx); setSessionStats(s.stats || { ok: 0, partial: 0, wrong: 0 });
    setFreeMode(s.kind !== "srs"); setHomeworkMode(s.kind === "homework"); setWeeklyMode(s.kind === "weekly"); setWeeklyFormal(s.kind === "weekly"); setListenMode(s.kind === "listen");
    setView("session");
    const item = items[s.idx];
    if (s.kind === "weekly") beginWeeklyItem(item);
    else if (s.kind === "homework") beginHomeworkItem(item);
    else if (s.kind === "listen") beginListenItem(item);
    else beginItem(item);
  };

  const discardSession = () => setDb((d) => ({ ...d, session: null }));

  const copyExport = async () => {
    const text = JSON.stringify(db);
    try {
      await navigator.clipboard.writeText(text);
      setCopyMsg("已复制到剪贴板,可以粘贴到备忘录/微信里保存");
    } catch {
      setCopyMsg("自动复制失败,请长按下面的文本框手动全选复制");
    }
    setTimeout(() => setCopyMsg(""), 4000);
  };

  const doImport = () => {
    try {
      const parsed = JSON.parse(importText.trim());
      if (!parsed || typeof parsed !== "object" || !parsed.prog) throw new Error("format");
      setDb({ ...DEFAULT_DB, ...parsed });
      setImportMsg("导入成功!");
      setTimeout(() => { setShowImport(false); setImportText(""); setImportMsg(""); }, 1200);
    } catch {
      setImportMsg("导入失败,请确认粘贴的是完整的导出内容(以 { 开头、} 结尾的一长串文字)");
    }
  };

  const beginWeeklyItem = (item) => {
    setAnswer(""); setResult(null);
    if (item.sub === "combo") loadComboQuestion(item.p1, item.p2);
    else loadQuestion(item.p, "translation");
  };

  const loadComboQuestion = async (p1, p2) => {
    setPhase("loadingQ"); setAnswer(""); setResult(null);
    try {
      const key = p1.id + "_" + p2.id;
      const avoid = recentTasks.current[key] || [];
      const question = await genComboQuestion(p1, p2, avoid);
      recentTasks.current[key] = [...avoid, question.task].slice(-4);
      setQ(question); setPhase("question");
    } catch (e) {
      setErrMsg("出题失败:" + (e && e.message ? e.message : String(e))); setPhase("error");
    }
  };

  const beginHomeworkItem = (item) => {
    setAnswer(""); setResult(null);
    if (item.sub === "combo") {
      loadComboQuestion(item.p1, item.p2);
    } else if (item.hw === "comp") {
      setQ({ type: "composition", task: `この文型「${item.p.jp}」を使って、自由に文を作ってください。`, hint: "", label: "作文 · 请用该句型自由造句(无场景限定)" });
      setPhase("question");
    } else {
      loadQuestion(item.p, "translation");
    }
  };

  const loadQuestion = async (p, forceType) => {
    setPhase("loadingQ"); setAnswer(""); setResult(null);
    try {
      const avoid = recentTasks.current[p.id] || [];
      const question = await genQuestion(p, avoid, forceType);
      recentTasks.current[p.id] = [...avoid, question.task].slice(-4);
      setQ(question); setPhase("question");
    } catch (e) {
      setErrMsg("出题失败:" + (e && e.message ? e.message : String(e))); setPhase("error");
    }
  };

  const submit = async () => {
    const item = queue[idx];
    if (!answer.trim()) return;
    setPhase("grading");
    try {
      const g = (weeklyMode || homeworkMode) && item.sub === "combo"
        ? await gradeCombo(item.p1, item.p2, q, answer.trim())
        : q && q.type === "listening"
        ? await gradeListening(item.p, q, answer.trim())
        : await gradeAnswer(item.p, q, answer.trim());
      setResult(g);
      applyResult(item, g);
      setPhase("result");
    } catch (e) {
      setErrMsg("判卷失败:" + (e && e.message ? e.message : String(e))); setPhase("error");
    }
  };

  const giveUp = () => {
    // 不会写/听不懂:直接按 wrong 计,但需要参考答案 → 走判卷,答案标记为空
    const item = queue[idx];
    setPhase("grading");
    const gradeCall = (weeklyMode || homeworkMode) && item.sub === "combo"
      ? gradeCombo(item.p1, item.p2, q, "(学生表示不会写,请给出参考答案和讲解)")
      : q && q.type === "listening"
      ? gradeListening(item.p, q, "(学生表示没听懂,请给出参考答案和讲解)")
      : gradeAnswer(item.p, q, "(学生表示不会写,请给出参考答案和该句型的关键讲解)");
    gradeCall.then((g) => {
      const r = { ...g, verdict: "wrong" };
      setResult(r); applyResult(item, r); setPhase("result");
    }).catch((e) => { setErrMsg("获取答案失败:" + (e && e.message ? e.message : String(e))); setPhase("error"); });
  };

  const applyResult = (item, g) => {
    setSessionStats((s) => ({ ...s, [g.verdict === "correct" ? "ok" : g.verdict]: s[g.verdict === "correct" ? "ok" : g.verdict] + 1 }));
    setDb((d) => {
      const nd = { ...d, prog: { ...d.prog }, meta: { ...d.meta }, stats: { ...d.stats }, listenStats: { ...d.listenStats }, mistakes: [...d.mistakes] };
      nd.stats.total += 1;
      const isCombo = (weeklyMode || homeworkMode) && item.sub === "combo";
      const isListening = q && q.type === "listening";
      if (isListening) nd.listenStats.total += 1;
      if (g.verdict === "correct") {
        nd.stats.ok += 1;
        if (isListening) nd.listenStats.ok += 1;
        // 如果这道题是从错题本重练来的,做对了就自动移除,不用手动清
        if (item.mistakeId) nd.mistakes = nd.mistakes.filter((m) => m.id !== item.mistakeId);
      } else {
        const base = { task: q.task, type: q.type, ans: answer.trim() || "(未作答)", ref: g.reference, exp: g.explanation, date: t };
        const idPart = isCombo ? { pid: item.p1.id, pid2: item.p2.id } : { pid: item.p.id };
        if (item.mistakeId) {
          // 重练了还是不对:刷新原来那条记录,而不是再叠加一条新的
          const pos = nd.mistakes.findIndex((m) => m.id === item.mistakeId);
          if (pos !== -1) nd.mistakes[pos] = { ...nd.mistakes[pos], ...base };
          else nd.mistakes.unshift({ ...base, ...idPart, id: newId() });
        } else {
          nd.mistakes.unshift({ ...base, ...idPart, id: newId() });
        }
        nd.mistakes = nd.mistakes.slice(0, 100);
      }
      if (!freeMode) {
        const existed = nd.prog[item.p.id];
        const cur = existed ? { ...existed } : { lv: 0, ok: 0, ng: 0, learnedDate: t };
        let { lv } = cur;
        let due;
        if (g.verdict === "correct") { due = addDays(t, INTERVALS[Math.min(lv, INTERVALS.length - 1)]); lv = Math.min(lv + 1, INTERVALS.length); cur.ok++; }
        else if (g.verdict === "partial") { due = addDays(t, Math.max(1, Math.round(INTERVALS[Math.min(lv, INTERVALS.length - 1)] / 2))); cur.ok++; }
        else { lv = Math.max(0, lv - 2); due = addDays(t, 1); cur.ng++; }
        nd.prog[item.p.id] = { ...cur, lv, due };
        if (item.isNew) {
          if (nd.meta.date !== t) { nd.meta.date = t; nd.meta.newDone = 0; }
          nd.meta.newDone += 1;
        }
      }
      return nd;
    });
  };

  const next = () => {
    if (idx + 1 < queue.length) {
      setIdx(idx + 1);
      const nextItem = queue[idx + 1];
      if (weeklyMode) beginWeeklyItem(nextItem);
      else if (homeworkMode) beginHomeworkItem(nextItem);
      else if (listenMode) beginListenItem(nextItem);
      else beginItem(nextItem);
    } else {
      setDb((d) => {
        const nd = { ...d, meta: { ...d.meta }, session: null };
        if (homeworkMode) nd.meta.hwDate = t;
        if (weeklyFormal) nd.meta.weekKey = mondayOf(t);
        return nd;
      });
      setPhase("done");
    }
  };

  const retry = () => {
    const item = queue[idx];
    if ((weeklyMode || homeworkMode) && item.sub === "combo") {
      if (!q) loadComboQuestion(item.p1, item.p2);
      else if (result === null && answer.trim()) submit();
      else loadComboQuestion(item.p1, item.p2);
    } else if (listenMode) {
      if (!q) loadListeningQuestion(item.p);
      else if (result === null && answer.trim()) submit();
      else loadListeningQuestion(item.p);
    } else {
      const ft = (weeklyMode && item.sub === "weak") || (homeworkMode && item.hw === "trans") ? "translation" : undefined;
      if (!q) loadQuestion(item.p, ft);
      else if (result === null && answer.trim()) submit();
      else loadQuestion(item.p, ft);
    }
  };

  /* ================= 渲染 ================= */
  const cur = queue[idx];
  actionsRef.current = { cur, next, retry, loadQuestion };
  const lessons = [...new Set(PATTERNS.map((p) => p.lesson))];

  return (
    <div className="app">
      <Style />
      <header className="top">
        <div className="brand serif">句型道場</div>
        <div className="brand-sub">大家的日语 I・II × 遗忘曲线</div>
      </header>

      {!storageOk && <div className="warn">⚠ 暂时连不上进度存储:本次做题记录关闭后会丢失。请尝试刷新页面,连上后此提示会自动消失。</div>}

      {/* ---------- 首页 ---------- */}
      {view === "home" && (
        <main className="page">
          <div className="date-line">{t}(北京时间)</div>

          {db.session && (
            <section className="resume-card">
              <div className="resume-text">
                有未完成的{db.session.kind === "homework" ? "每日作业" : db.session.kind === "weekly" ? "每周挑战" : "今日学习"}
                ,进行到第 {db.session.idx + 1}/{db.session.items.length} 题
              </div>
              <div className="btn-row">
                <button className="btn-main" onClick={resumeSession}>继续做</button>
                <button className="btn-ghost" onClick={discardSession}>放弃</button>
              </div>
            </section>
          )}

          <section className="today-card">
            <div className="today-nums">
              <div className="num-block"><div className="num shu">{dueList.length}</div><div className="num-label">待复习</div></div>
              <div className="num-block"><div className="num ai-c">{newList.length}</div><div className="num-label">新句型</div></div>
              <div className="num-block"><div className="num">{learnedIds.length}<span className="num-total">/{PATTERNS.length}</span></div><div className="num-label">已学</div></div>
            </div>
            {dueList.length + newList.length > 0 ? (
              <button className="btn-main" onClick={startSession}>開始 · 今日の学習</button>
            ) : (
              <div className="all-done serif">今日の分は終わりました 🎌<br /><span className="all-done-sub">今天的任务已全部完成,明天见</span></div>
            )}
          </section>

          <section className="hw-card">
            <div className="hw-top">
              <div>
                <div className="hw-title serif">毎日の宿題</div>
                <div className="hw-sub">从已学句型抽 5 造句 + 5 翻译(优先混入当前错题),统一批改讲解</div>
              </div>
              {db.meta.hwDate === t && <span className="hw-done">✓ 今日已完成</span>}
            </div>
            {learnedIds.length === 0 ? (
              <div className="hw-empty">先学几个句型,再来做作业吧</div>
            ) : (
              <button className="btn-outline" onClick={startHomework}>
                {db.meta.hwDate === t ? "再练一组作业" : "開始 · 今日の宿題"}
              </button>
            )}
          </section>

          <section className="hw-card wk-card">
            <div className="hw-top">
              <div>
                <div className="hw-title serif">週間チャレンジ</div>
                <div className="hw-sub">5道複合作文(一句话用两个句型)+ 3道本周弱点重测</div>
              </div>
              {weekDone && <span className="hw-done">✓ 本周已完成</span>}
            </div>
            {!weekReady ? (
              <div className="hw-empty">至少学会 2 个句型后解锁</div>
            ) : (
              <button className="btn-outline" onClick={startWeekly}>
                {weekDone ? "再来一组" : "開始 · 今週のチャレンジ"}
              </button>
            )}
          </section>

          <section className="hw-card ls-card">
            <div className="hw-top">
              <div>
                <div className="hw-title serif">聴解練習</div>
                <div className="hw-sub">8题:听写模式,只听声音,写出假名即可(不用管汉字),不经过中文翻译这一步</div>
              </div>
              <span className="hw-done ls-tier">Lv.{listenTier(db.listenStats.ok).name}</span>
            </div>
            <div className="ls-progress">
              累计听力答对 {db.listenStats.ok} 题
              {db.listenStats.ok < 8 && ` · 还差 ${8 - db.listenStats.ok} 题升级到中级`}
              {db.listenStats.ok >= 8 && db.listenStats.ok < 20 && ` · 还差 ${20 - db.listenStats.ok} 题升级到高级`}
              {db.listenStats.ok >= 20 && " · 已是最高档"}
            </div>
            {speechOk && jaVoices.length > 1 && (
              <div className="voice-picker">
                <select
                  value={db.settings.voiceURI || ""}
                  onChange={(e) => setDb((d) => ({ ...d, settings: { ...d.settings, voiceURI: e.target.value || null } }))}
                >
                  <option value="">系统默认声音</option>
                  {jaVoices.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name}</option>)}
                </select>
                <button className="btn-mini" onClick={() => speakJa("こんにちは、聞こえますか。これはテストです。", 1, db.settings.voiceURI)}>试听</button>
              </div>
            )}
            {learnedIds.length === 0 ? (
              <div className="hw-empty">先学几个句型,再来练听力吧</div>
            ) : !speechOk ? (
              <div className="hw-empty">当前浏览器不支持语音朗读,建议换电脑浏览器(Chrome/Edge/Safari)使用这个功能</div>
            ) : (
              <button className="btn-outline ls-btn" onClick={startListening}>開始 · 聴解練習</button>
            )}
          </section>

          <section className="settings-row">
            <span>每天新学句型</span>
            <div className="stepper">
              <button onClick={() => setDb((d) => ({ ...d, settings: { newPerDay: Math.max(0, d.settings.newPerDay - 1) } }))}>−</button>
              <b>{db.settings.newPerDay}</b>
              <button onClick={() => setDb((d) => ({ ...d, settings: { newPerDay: Math.min(10, d.settings.newPerDay + 1) } }))}>＋</button>
            </div>
          </section>

          {db.stats.total > 0 && (
            <div className="mini-stats">累计答题 {db.stats.total} · 正确率 {Math.round((db.stats.ok / db.stats.total) * 100)}%</div>
          )}

          <section className="backup-section">
            <div className="backup-head">数据备份(跨设备手动搬运,以防云端存储连不上)</div>
            <div className="btn-row">
              <button className="btn-mini" onClick={() => { setShowExport(true); setShowImport(false); }}>导出进度</button>
              <button className="btn-mini ghost" onClick={() => { setShowImport(true); setShowExport(false); }}>导入进度</button>
            </div>
            {showExport && (
              <div className="backup-card">
                <div className="backup-title">复制下面这段文字,保存到备忘录/微信"文件传输助手"里,换设备时粘贴进"导入进度"即可</div>
                <textarea className="backup-box" readOnly value={JSON.stringify(db)} onFocus={(e) => e.target.select()} />
                <div className="btn-row">
                  <button className="btn-mini" onClick={copyExport}>复制</button>
                  <button className="btn-mini ghost" onClick={() => setShowExport(false)}>关闭</button>
                </div>
                {copyMsg && <div className="copy-msg">{copyMsg}</div>}
              </div>
            )}
            {showImport && (
              <div className="backup-card">
                <div className="backup-title">粘贴之前导出的文字,会覆盖当前设备上的记录</div>
                <textarea className="backup-box" value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="粘贴导出的内容…" />
                <div className="btn-row">
                  <button className="btn-mini" onClick={doImport}>确认导入(覆盖当前记录)</button>
                  <button className="btn-mini ghost" onClick={() => { setShowImport(false); setImportText(""); setImportMsg(""); }}>取消</button>
                </div>
                {importMsg && <div className="copy-msg">{importMsg}</div>}
              </div>
            )}
          </section>
        </main>
      )}

      {/* ---------- 学习会话 ---------- */}
      {view === "session" && cur && (
        <main className="page">
          {phase !== "done" && (
            <div className="progress-row">
              <div className="progress-bar"><div className="progress-fill" style={{ width: `${(idx / queue.length) * 100}%` }} /></div>
              <span className="progress-text">{idx + 1} / {queue.length}</span>
            </div>
          )}

          {phase !== "done" && (
            <div className="pattern-head">
              <span className={"tag " + (weeklyMode ? "tag-wk" : homeworkMode ? "tag-hw" : listenMode ? "tag-ls" : cur.isNew ? "tag-new" : "tag-rev")}>
                {weeklyMode ? (cur.sub === "combo" ? "週間 · 複合作文" : "週間 · 弱点再測") : homeworkMode ? (cur.sub === "combo" ? "作業 · 複合作文" : cur.hw === "comp" ? "作業 · 造句" : "作業 · 翻訳") : listenMode ? "聴解練習" : freeMode ? "自由练习" : cur.isNew ? "新句型" : "复习"}
              </span>
              {(weeklyMode || homeworkMode) && cur.sub === "combo" ? (
                <>
                  <span className="pattern-name serif">{cur.p1.jp}</span>
                  <span className="combo-plus">＋</span>
                  <span className="pattern-name serif">{cur.p2.jp}</span>
                </>
              ) : listenMode && phase !== "result" ? (
                <span className="pattern-name serif">？？？</span>
              ) : (
                <>
                  <span className="pattern-name serif">{cur.p.jp}</span>
                  <span className="pattern-lesson">第{cur.p.lesson}課</span>
                </>
              )}
            </div>
          )}

          {phase === "intro" && (
            <section className="card intro-card">
              <div className="intro-row"><label>接続</label><div className="serif">{cur.p.conn}</div></div>
              <div className="intro-row"><label>意味</label><div>{cur.p.cn}</div></div>
              <div className="intro-row"><label>例文</label><div><div className="serif ex-jp">{cur.p.exJp}</div><div className="ex-cn">{cur.p.exCn}</div></div></div>
              <button className="btn-main" onClick={() => loadQuestion(cur.p)}>読めた,开始做题 →</button>
            </section>
          )}

          {(phase === "loadingQ" || phase === "grading") && (
            <section className="card loading-card">
              <div className="dots"><span /><span /><span /></div>
              <div className="loading-text">{phase === "loadingQ" ? "先生が問題を作っています…" : "先生が採点しています…"}</div>
            </section>
          )}

          {phase === "error" && (
            <section className="card">
              {/rate|limit|429|overload|529/i.test(errMsg) ? (
                <p className="err-hint">当前账号的 AI 用量暂时达到上限(判题/出题都会消耗你订阅的额度)。稍等几分钟额度恢复后再点重试即可,已完成的进度不会丢失。</p>
              ) : null}
              <p className="err-text">{errMsg}</p>
              <button className="btn-main" onClick={retry}>重试</button>
            </section>
          )}

          {(phase === "question" || phase === "result") && q && (
            <section className="card">
              <div className="q-type">{q.label || (q.type === "translation" ? "翻訳 · 把下面的中文译成日语" : "作文 · 根据场景用该句型造句")}</div>
              {q.type === "listening" ? (
                <div className="listen-box">
                  <button className="btn-listen" onClick={() => speakJa(q.yomi || q.jp, 1, db.settings.voiceURI)}>▶ 播放</button>
                  <button className="btn-listen ghost" onClick={() => speakJa(q.yomi || q.jp, 0.65, db.settings.voiceURI)}>🐢 慢速</button>
                </div>
              ) : (
                <div className="q-task serif">{q.task}</div>
              )}
              {q.hint && <div className="q-hint">ヒント: {q.hint}</div>}

              {phase === "question" && (
                <>
                  <textarea
                    className="answer-box serif"
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (answer.trim()) submit();
                        else if (q.type === "listening") speakJa(q.yomi || q.jp, 1, db.settings.voiceURI);
                      }
                    }}
                    placeholder={q.type === "listening" ? "用假名写出听到的内容…不用管汉字(Enter 提交 / Shift+Enter 换行)" : "ここに日本語で書いてください…(Enter 提交 / Shift+Enter 换行)"}
                    rows={3}
                    autoFocus
                  />
                  <div className="btn-row">
                    <button className="btn-ghost" onClick={giveUp}>{q.type === "listening" ? "听不懂,看原文" : "不会写,看答案"}</button>
                    <button className="btn-main" disabled={!answer.trim()} onClick={submit}>提交 · 採点する</button>
                  </div>
                </>
              )}

              {phase === "result" && result && (
                <div className="result-wrap">
                  <Stamp verdict={result.verdict} />
                  {answer.trim() && <div className="your-ans"><label>你的答案</label><div className="serif">{answer}</div></div>}
                  <div className="ref-block"><label>参考答案</label><div className="serif ref-jp">{result.reference}</div></div>
                  <div className="exp-block"><label>先生の講評</label><div>{result.explanation}</div></div>
                  <button className="btn-main" onClick={next}>{idx + 1 < queue.length ? "次へ →" : "完成今日学習"}</button>
                </div>
              )}
            </section>
          )}

          {phase === "done" && (
            <section className="card done-card">
              <div className="done-title serif">お疲れさまでした</div>
              <div className="done-stats">
                <span className="d-ok">◎ {sessionStats.ok}</span>
                <span className="d-pt">△ {sessionStats.partial}</span>
                <span className="d-ng">✗ {sessionStats.wrong}</span>
              </div>
              <p className="done-note">{weeklyMode ? "本周综合挑战已完成,做错的组合题/弱点题已收入錯題本。" : homeworkMode ? "今日作业已完成,做对的错题已自动清除。" : listenMode ? "聴解練習已完成,没听懂的已收入錯題本。" : "答对的句型间隔已拉长,答错的明天会再次出现。"}</p>
              <button className="btn-main" onClick={() => setView("home")}>返回首页</button>
            </section>
          )}

          {phase !== "done" && (
            <button className="quit-link" onClick={() => setView("home")}>中断,返回首页(进度已保存)</button>
          )}
        </main>
      )}

      {/* ---------- 句型库 ---------- */}
      {view === "library" && (
        <main className="page">
          <h2 className="page-title serif">句型库</h2>
          {lessons.map((l) => {
            const ps = PATTERNS.filter((p) => p.lesson === l);
            const learned = ps.filter((p) => db.prog[p.id]).length;
            return (
              <div key={l} className="lesson-block">
                <button className="lesson-head" onClick={() => setOpenLesson(openLesson === l ? null : l)}>
                  <span>第{l}課</span>
                  <span className="lesson-count">{learned}/{ps.length} 已学</span>
                </button>
                {openLesson === l && ps.map((p) => {
                  const pr = db.prog[p.id];
                  return (
                    <div key={p.id} className="pattern-row">
                      <div className="pr-top">
                        <span className="serif pr-name">{p.jp}</span>
                        {p.ext && <span className="badge badge-ext">補充</span>}
                        {pr ? <span className="badge badge-on">Lv{pr.lv} · {pr.due <= t ? "今日到期" : pr.due + " 复习"}</span> : <span className="badge">未学</span>}
                      </div>
                      <div className="pr-meaning">{p.cn} 〔{p.conn}〕</div>
                      <div className="pr-ex serif">{p.exJp}</div>
                      <button className="btn-mini" onClick={() => startFree(p)}>练一题(不影响排期)</button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </main>
      )}

      {/* ---------- 错题本 ---------- */}
      {view === "mistakes" && (
        <main className="page">
          <h2 className="page-title serif">錯題本</h2>
          {db.mistakes.length === 0 && <div className="center-msg">还没有错题。錯題は宝物です — 出错了才会来这里。</div>}
          {db.mistakes.length > 0 && (
            <div className="drill-bar">
              <div className="drill-note">这些错题会优先混入「毎日の宿題」,做对了自动移除,不用额外再点什么</div>
            </div>
          )}
          {db.mistakes.map((m, i) => {
            const p = PATTERNS[m.pid];
            const p2 = m.pid2 !== undefined ? PATTERNS[m.pid2] : null;
            return (
              <div key={m.id || i} className="card mistake-card">
                <div className="mk-head"><span className="serif">{p.jp}{p2 && <> ＋ {p2.jp}</>}</span><span className="mk-date">{m.date}</span></div>
                <div className="mk-task">{m.type === "listening" ? "🎧 聴解练习(听力原文见下方参考答案)" : m.task}</div>
                <div className="mk-line"><label>当时答</label><span className="serif">{m.ans}</span></div>
                <div className="mk-line"><label>参考</label><span className="serif shu">{m.ref}</span></div>
                <div className="mk-exp">{m.exp}</div>
                <div className="btn-row">
                  <button className="btn-mini" onClick={() => (p2 ? startComboFree(p, p2, m.id) : m.type === "listening" ? startListenFree(p, m.id) : startFree(p, m.id))}>{p2 ? "重练这组合" : m.type === "listening" ? "重新听一次" : "重练这个句型"}</button>
                  <button className="btn-mini ghost" onClick={() => setDb((d) => ({ ...d, mistakes: d.mistakes.filter((x, j) => (m.id ? x.id !== m.id : j !== i)) }))}>移除</button>
                </div>
              </div>
            );
          })}
        </main>
      )}

      {/* ---------- 底部导航 ---------- */}
      <nav className="nav">
        {[["home", "今日"], ["library", "句型库"], ["mistakes", "錯題本"]].map(([v, label]) => (
          <button key={v} className={view === v ? "nav-btn on" : "nav-btn"} onClick={() => setView(v)}>{label}</button>
        ))}
      </nav>
    </div>
  );
}

/* ================= 样式 ================= */
function Style() {
  return (
    <style>{`
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;600;700&display=swap');

:root{
  --paper:#F5F3EC; --card:#FFFFFF; --ink:#2A2B30; --ink-soft:#6B6D76;
  --ai:#2E4A7D; --ai-deep:#223A5E; --shu:#C0392F; --line:#E4E0D4;
}
*{box-sizing:border-box;margin:0;padding:0}
.app{min-height:100vh;background:var(--paper);color:var(--ink);
  font-family:"Noto Sans JP","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;
  padding-bottom:76px;max-width:640px;margin:0 auto}
.serif{font-family:"Noto Sans JP","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif}

.top{padding:20px 20px 6px;display:flex;align-items:baseline;gap:10px}
.brand{font-size:22px;font-weight:700;letter-spacing:2px;color:var(--ai-deep)}
.brand-sub{font-size:11px;color:var(--ink-soft);letter-spacing:1px}
.warn{margin:8px 20px;padding:8px 12px;background:#FCEBE9;color:var(--shu);font-size:12px;border-radius:8px}

.page{padding:12px 20px 20px}
.page-title{font-size:18px;margin:6px 0 14px;color:var(--ai-deep)}
.date-line{font-size:12px;color:var(--ink-soft);margin-bottom:10px}
.resume-card{background:#FDF6E9;border:1px solid #E8D5A8;border-radius:14px;padding:16px;margin-bottom:14px}
.resume-text{font-size:14px;color:#8A6A2A;margin-bottom:10px;line-height:1.6}
.resume-card .btn-row{margin-top:0}
.resume-card .btn-main{flex:1}
.resume-card .btn-ghost{flex:0 0 auto}
.center-msg{padding:60px 20px;text-align:center;color:var(--ink-soft)}
.confirm-screen{max-width:640px;margin:0 auto;padding:60px 24px;text-align:center}
.confirm-title{font-size:20px;color:var(--shu);margin-bottom:16px}
.confirm-text{font-size:14px;line-height:1.8;color:var(--ink);margin-bottom:24px;text-align:left}
.confirm-screen .btn-main{max-width:320px;margin:0 auto}

.today-card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px;box-shadow:0 2px 10px rgba(34,58,94,.05)}
.today-nums{display:flex;justify-content:space-around;margin-bottom:20px}
.num-block{text-align:center}
.num{font-size:34px;font-weight:700;color:var(--ai-deep);line-height:1.1}
.num.shu{color:var(--shu)} .num.ai-c{color:var(--ai)}
.num-total{font-size:15px;color:var(--ink-soft);font-weight:400}
.num-label{font-size:12px;color:var(--ink-soft);margin-top:4px;letter-spacing:2px}

.btn-main{display:block;width:100%;padding:14px;background:var(--ai);color:#fff;border:none;border-radius:12px;
  font-size:16px;font-weight:600;letter-spacing:2px;cursor:pointer;transition:background .15s}
.btn-main:hover{background:var(--ai-deep)}
.btn-main:disabled{background:#B9C2D2;cursor:not-allowed}
.btn-ghost{padding:14px 16px;background:none;border:1px solid var(--line);border-radius:12px;color:var(--ink-soft);cursor:pointer;font-size:14px;white-space:nowrap}
.btn-row{display:flex;gap:10px;margin-top:12px}
.btn-row .btn-main{margin-top:0}
.btn-mini{padding:6px 12px;font-size:12px;border:1px solid var(--ai);color:var(--ai);background:none;border-radius:8px;cursor:pointer;margin-top:8px}
.btn-mini.ghost{border-color:var(--line);color:var(--ink-soft)}
.quit-link{display:block;margin:18px auto 0;background:none;border:none;color:var(--ink-soft);font-size:12px;text-decoration:underline;cursor:pointer}

.all-done{text-align:center;font-size:18px;color:var(--ai-deep);line-height:1.9;padding:8px 0}
.all-done-sub{font-size:12px;color:var(--ink-soft);font-family:sans-serif}

.hw-card{margin-top:16px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px}
.hw-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:12px}
.hw-title{font-size:17px;color:var(--ai-deep)}
.hw-sub{font-size:12px;color:var(--ink-soft);margin-top:4px;line-height:1.6}
.hw-done{flex:0 0 auto;font-size:11px;color:var(--shu);background:#FCEBE9;padding:3px 8px;border-radius:6px;white-space:nowrap}
.ls-tier{color:#2E7D5B;background:#E4F0EC}
.ls-progress{font-size:12px;color:var(--ink-soft);margin-bottom:12px}
.hw-empty{font-size:13px;color:var(--ink-soft);text-align:center;padding:8px 0}
.btn-outline{display:block;width:100%;padding:12px;background:none;color:var(--ai);border:1.5px solid var(--ai);border-radius:12px;
  font-size:15px;font-weight:600;letter-spacing:1px;cursor:pointer}
.btn-outline:hover{background:#EAF0F9}
.tag-hw{background:#FCEBE9;color:var(--shu)}
.tag-wk{background:#EFE6F5;color:#6B3F9A}
.tag-ls{background:#E4F0EC;color:#2E7D5B}
.combo-plus{font-size:18px;color:var(--ink-soft);margin:0 -2px}
.wk-card{border-color:#D9C7E8}
.ls-card{border-color:#B7D9C9}
.voice-picker{display:flex;gap:8px;margin-bottom:12px;align-items:center}
.voice-picker select{flex:1;padding:9px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;background:#FDFCF9;color:var(--ink)}
.voice-picker .btn-mini{margin-top:0;flex:0 0 auto;white-space:nowrap}
.ls-btn{border-color:#2E7D5B;color:#2E7D5B}
.ls-btn:hover{background:#E4F0EC}

.settings-row{display:flex;justify-content:space-between;align-items:center;margin-top:16px;padding:12px 16px;
  background:var(--card);border:1px solid var(--line);border-radius:12px;font-size:14px}
.stepper{display:flex;align-items:center;gap:14px}
.stepper button{width:30px;height:30px;border-radius:8px;border:1px solid var(--line);background:none;font-size:16px;cursor:pointer;color:var(--ai-deep)}
.mini-stats{margin-top:14px;font-size:12px;color:var(--ink-soft);text-align:center}

.backup-section{margin-top:22px;padding-top:14px;border-top:1px dashed var(--line)}
.backup-head{font-size:11px;color:var(--ink-soft);letter-spacing:1px;margin-bottom:8px;text-align:center}
.backup-card{margin-top:10px;padding:14px;background:var(--card);border:1px solid var(--line);border-radius:12px}
.backup-title{font-size:12px;color:var(--ink-soft);line-height:1.6;margin-bottom:8px}
.backup-box{width:100%;height:90px;font-size:11px;padding:8px;border:1px solid var(--line);border-radius:8px;
  background:#FDFCF9;color:var(--ink);resize:vertical;word-break:break-all}
.copy-msg{margin-top:8px;font-size:12px;color:var(--ai)}

.progress-row{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.progress-bar{flex:1;height:6px;background:var(--line);border-radius:3px;overflow:hidden}
.progress-fill{height:100%;background:var(--ai);transition:width .3s}
.progress-text{font-size:12px;color:var(--ink-soft)}

.pattern-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.pattern-name{font-size:20px;font-weight:700;color:var(--ai-deep)}
.pattern-lesson{font-size:12px;color:var(--ink-soft)}
.tag{font-size:11px;padding:3px 8px;border-radius:6px;letter-spacing:1px}
.tag-new{background:#EAF0F9;color:var(--ai)}
.tag-rev{background:#F6ECE4;color:#9A6B3F}

.card{position:relative;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;box-shadow:0 2px 10px rgba(34,58,94,.05)}
.intro-row{display:flex;gap:14px;margin-bottom:14px;font-size:15px;line-height:1.7}
.intro-row label{flex:0 0 40px;font-size:12px;color:var(--shu);letter-spacing:2px;padding-top:3px}
.ex-jp{font-size:16px} .ex-cn{font-size:13px;color:var(--ink-soft);margin-top:2px}
.intro-card .btn-main{margin-top:8px}

.loading-card{text-align:center;padding:44px 20px}
.dots span{display:inline-block;width:8px;height:8px;margin:0 4px;border-radius:50%;background:var(--ai);animation:blink 1.2s infinite}
.dots span:nth-child(2){animation-delay:.2s}.dots span:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,80%,100%{opacity:.2}40%{opacity:1}}
.loading-text{margin-top:14px;font-size:13px;color:var(--ink-soft)}
.err-text{color:var(--shu);margin-bottom:14px;font-size:13px;word-break:break-word;line-height:1.6}
.err-hint{background:#FAF4EC;border-radius:10px;padding:12px;font-size:14px;line-height:1.7;color:#8A6A2A;margin-bottom:12px}

.q-type{font-size:11px;letter-spacing:2px;color:var(--shu);margin-bottom:10px}
.q-task{font-size:19px;line-height:1.7;margin-bottom:8px}
.listen-box{display:flex;gap:10px;margin-bottom:8px;padding:14px 0}
.btn-listen{padding:14px 20px;background:var(--ai);color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer}
.btn-listen.ghost{background:none;border:1.5px solid var(--ai);color:var(--ai)}
.q-hint{font-size:13px;color:var(--ink-soft);margin-bottom:8px}
.answer-box{width:100%;margin-top:10px;padding:12px;font-size:17px;line-height:1.7;border:1.5px solid var(--line);
  border-radius:12px;background:#FDFCF9;resize:vertical;color:var(--ink)}
.answer-box:focus{outline:2px solid var(--ai);border-color:var(--ai)}

.result-wrap{position:relative;margin-top:6px}
.your-ans{margin-top:14px;padding:10px 12px;background:#F7F6F1;border-radius:10px;font-size:15px}
.your-ans label,.ref-block label,.exp-block label,.mk-line label{display:block;font-size:11px;color:var(--ink-soft);letter-spacing:2px;margin-bottom:3px}
.ref-block{margin-top:14px}
.ref-jp{font-size:17px;color:var(--ai-deep)}
.exp-block{margin-top:12px;font-size:14px;line-height:1.8;background:#FAF4EC;border-radius:10px;padding:12px}
.exp-block label{margin-bottom:6px}
.card .btn-main{margin-top:16px}

.stamp{position:absolute;top:-22px;right:2px;margin:0;width:150px;height:150px;border:3px solid var(--shu);border-radius:50%;
  display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--shu);background:var(--card);
  box-shadow:0 4px 14px rgba(192,57,47,.18);
  transform:rotate(-8deg);animation:stampIn .4s cubic-bezier(.2,1.6,.4,1);gap:2px;z-index:2}
.stamp-mark{font-size:40px;line-height:1;font-weight:700}
.stamp-label{font-size:15px;font-weight:700;letter-spacing:1px;font-family:"Noto Sans JP","Noto Sans SC",sans-serif}
.stamp-sub{font-size:10px;opacity:.8}
@keyframes stampIn{0%{transform:scale(2) rotate(-8deg);opacity:0}70%{transform:scale(.94) rotate(-8deg);opacity:1}100%{transform:scale(1) rotate(-8deg)}}

.done-card{text-align:center;padding:36px 24px}
.done-title{font-size:24px;color:var(--ai-deep);margin-bottom:16px;letter-spacing:2px}
.done-stats{display:flex;justify-content:center;gap:22px;font-size:18px;margin-bottom:14px}
.d-ok{color:var(--shu);font-weight:700}.d-pt{color:#B08830}.d-ng{color:var(--ink-soft)}
.done-note{font-size:13px;color:var(--ink-soft);margin-bottom:8px}

.lesson-block{margin-bottom:8px}
.lesson-head{width:100%;display:flex;justify-content:space-between;padding:12px 16px;background:var(--card);
  border:1px solid var(--line);border-radius:12px;font-size:15px;cursor:pointer;color:var(--ink)}
.lesson-count{font-size:12px;color:var(--ink-soft)}
.pattern-row{margin:8px 0 8px 10px;padding:12px 14px;background:var(--card);border-left:3px solid var(--ai);border-radius:0 12px 12px 0}
.pr-top{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.pr-name{font-size:16px;font-weight:700;color:var(--ai-deep)}
.badge{font-size:11px;padding:2px 8px;border-radius:6px;background:#EFEDE5;color:var(--ink-soft)}
.badge-on{background:#EAF0F9;color:var(--ai)}
.badge-ext{background:#F6ECE4;color:#9A6B3F}
.pr-meaning{font-size:13px;color:var(--ink-soft);margin-top:4px}
.pr-ex{font-size:14px;margin-top:4px}

.drill-bar{margin-bottom:16px;padding:14px 16px;background:#F6F0FA;border:1px solid #D9C7E8;border-radius:12px}
.drill-note{font-size:12px;color:#6B3F9A;margin-bottom:0;line-height:1.6}
.drill-bar .btn-outline{border-color:#6B3F9A;color:#6B3F9A}
.drill-bar .btn-outline:hover{background:#EFE6F5}
.mistake-card{margin-bottom:12px;padding:16px}
.mk-head{display:flex;justify-content:space-between;font-size:15px;font-weight:700;color:var(--ai-deep)}
.mk-date{font-size:11px;color:var(--ink-soft);font-weight:400}
.mk-task{font-size:14px;margin:8px 0}
.mk-line{margin:6px 0;font-size:14px}
.mk-line label{display:inline-block;margin-right:8px;margin-bottom:0}
.shu{color:var(--shu)}
.mk-exp{font-size:13px;color:var(--ink-soft);line-height:1.7;margin-top:6px}

.nav{position:fixed;bottom:0;left:0;right:0;max-width:640px;margin:0 auto;display:flex;
  background:var(--card);border-top:1px solid var(--line);padding:6px 0 max(6px, env(safe-area-inset-bottom))}
.nav-btn{flex:1;padding:12px 0;background:none;border:none;font-size:14px;color:var(--ink-soft);cursor:pointer;letter-spacing:2px}
.nav-btn.on{color:var(--ai-deep);font-weight:700}

@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`}</style>
  );
}

/* ================= 错误边界:防止崩溃时白屏/黑屏 ================= */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // 记录到控制台,方便排查具体是哪台设备、哪段代码出的问题
    console.error("句型道場 crashed:", error, info && info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", padding: "32px 24px", textAlign: "center",
          fontFamily: "sans-serif", background: "#F5F3EC", color: "#2A2B30", gap: "14px",
        }}>
          <div style={{ fontSize: "17px", fontWeight: 700 }}>页面出了点问题,没能正常加载</div>
          <div style={{ fontSize: "13px", color: "#6B6D76", maxWidth: "320px", lineHeight: 1.7 }}>
            可能是当前设备/浏览器与某个功能不兼容。点击下面按钮重试;如果反复出现,把这段信息截图发给我,方便定位问题:
          </div>
          <div style={{
            fontSize: "11px", color: "#C0392F", background: "#FCEBE9", padding: "10px 14px",
            borderRadius: "8px", maxWidth: "320px", wordBreak: "break-word", textAlign: "left",
          }}>
            {String(this.state.error && this.state.error.message || this.state.error)}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: "8px", padding: "12px 22px", background: "#2E4A7D", color: "#fff",
              border: "none", borderRadius: "10px", fontSize: "15px", fontWeight: 600, cursor: "pointer",
            }}
          >重试</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}
