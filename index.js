require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionsBitField,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const fs = require("fs");
const path = require("path");

// =================== 설정 ===================

// 티켓 생성 시 관리자 호출 멘션(원하면 수정)
const ADMIN_MENTIONS = "<@1335541065700216842> <@1130008967167361104>";

// 계좌 문구
const ACCOUNT_TEXT = "토스뱅크 1002-4249-3478 김형준";

// ✅ 구매-로그 채널 ID (고정)
const LOG_CHANNEL_ID = "1475527552775753779";

// (선택) 랭킹 자동 업로드 채널 ID (원하면 넣기, 아니면 "")
const RANK_CHANNEL_ID = "";

// (선택) 일매출 자동 리포트 채널 ID (원하면 넣기, 아니면 "")
const SALES_REPORT_CHANNEL_ID = "";

// ✅ 역할 이름(서버 역할명과 완전 동일해야 자동 지급됨)
const ROLE_BUYER_NAME = "구매자";
const ROLE_VIP_NAME = "VIP [50,000]";
const ROLE_VVIP_NAME = "VVIP [100,000]";

// 등급 기준(누적 구매금액, 원)
const VIP_MIN_WON = 50000;
const VVIP_MIN_WON = 100000;

// 할인율
const VIP_DISCOUNT = 0.03; // VIP 3%
const VVIP_DISCOUNT = 0.05; // VVIP 5%

// 가격 환산: 0.1 = 1000원 기준 -> 10000 (0.3 -> 3000원)
const PRICE_TO_WON_MULTIPLIER = 10000;

// ✅ 상품 목록 (아누부부 1개 고정 제거)
const PRODUCTS = [
  { label: "머니 , 캔디 콜로살 코브라 10개", value: "cobra10", unitPrice: 0.3, ticketName: "코브라10개" },
  { label: "머니 캔디 콜로살 큐피트론 10개", value: "cupid10", unitPrice: 0.3, ticketName: "큐피트론10개" },
  { label: "머니 , 캔디 콜로살 미야올 10개", value: "miya10", unitPrice: 0.3, ticketName: "미야올10개" },
  { label: "다이야 아누부부", value: "anubu", unitPrice: 0.4, ticketName: "아누부부" },
];

// 데이터 파일
const DATA_PATH = path.join(__dirname, "data.json");

// =================== 유틸 ===================

function loadData() {
  try {
    if (!fs.existsSync(DATA_PATH)) {
      const init = { users: {}, totalSalesWon: 0, totalOrders: 0, salesByDate: {}, ordersByDate: {} };
      fs.writeFileSync(DATA_PATH, JSON.stringify(init, null, 2), "utf-8");
      return init;
    }
    const parsed = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
    if (!parsed.users) parsed.users = {};
    if (typeof parsed.totalSalesWon !== "number") parsed.totalSalesWon = 0;
    if (typeof parsed.totalOrders !== "number") parsed.totalOrders = 0;
    if (!parsed.salesByDate) parsed.salesByDate = {};
    if (!parsed.ordersByDate) parsed.ordersByDate = {};
    return parsed;
  } catch {
    return { users: {}, totalSalesWon: 0, totalOrders: 0, salesByDate: {}, ordersByDate: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function formatWon(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "가격정보없음";
  return n.toLocaleString("ko-KR") + "원";
}

function getKSTDateKey(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(date); // YYYY-MM-DD
}

function calcTotalPriceStr(unitPrice, qty) {
  const total = Math.round(unitPrice * qty * 100) / 100;
  return total.toFixed(1); // "0.6"
}

async function ensureRoleByName(guild, roleName) {
  if (!roleName) return null;
  return guild.roles.cache.find((r) => r.name === roleName) || null;
}

async function grantRoleIfExists(member, roleName) {
  const role = await ensureRoleByName(member.guild, roleName);
  if (!role) return false;
  if (member.roles.cache.has(role.id)) return true;
  await member.roles.add(role).catch(() => null);
  return true;
}

function getTierBySpent(spentWon) {
  if (spentWon >= VVIP_MIN_WON) return "VVIP";
  if (spentWon >= VIP_MIN_WON) return "VIP";
  return "NORMAL";
}

function getDiscountRateBySpent(spentWon) {
  const tier = getTierBySpent(spentWon);
  if (tier === "VVIP") return VVIP_DISCOUNT;
  if (tier === "VIP") return VIP_DISCOUNT;
  return 0;
}

function getPrefixByTier(tier) {
  if (tier === "VVIP") return "a";
  if (tier === "VIP") return "b";
  return "c";
}

function tierLabel(tier) {
  if (tier === "VVIP") return "🚨 **VVIP 우선 처리 티켓입니다**";
  if (tier === "VIP") return "✨ **VIP 우선 처리 티켓입니다**";
  return "🧾 **일반 티켓입니다**";
}

function discountTextByTier(tier) {
  if (tier === "VVIP") return `VVIP ${Math.round(VVIP_DISCOUNT * 100)}% 할인`;
  if (tier === "VIP") return `VIP ${Math.round(VIP_DISCOUNT * 100)}% 할인`;
  return "할인 없음";
}

function buildTop5RankingText(data) {
  const entries = Object.entries(data.users || {})
    .map(([userId, u]) => ({ userId, spentWon: u?.spentWon || 0 }))
    .filter((x) => x.spentWon > 0)
    .sort((a, b) => b.spentWon - a.spentWon)
    .slice(0, 5);

  if (entries.length === 0) return "아직 구매 기록이 없습니다.";

  return entries
    .map((e, i) => {
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "🏅";
      return `${medal} <@${e.userId}> — ${formatWon(e.spentWon)}`;
    })
    .join("\n");
}

// =================== 봇 ===================

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once("ready", () => {
  console.log(`${client.user.tag} 로그인됨`);
  scheduleDailySalesReport();
});

// =================== (선택) 자동 일매출 리포트 ===================

function scheduleDailySalesReport() {
  if (!SALES_REPORT_CHANNEL_ID) return;

  const now = new Date();
  const kstNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const next = new Date(kstNow);
  next.setHours(0, 5, 0, 0);
  if (next <= kstNow) next.setDate(next.getDate() + 1);

  const delay = next.getTime() - kstNow.getTime();

  setTimeout(() => {
    sendYesterdaySalesReport().catch(() => null);
    setInterval(() => sendYesterdaySalesReport().catch(() => null), 24 * 60 * 60 * 1000);
  }, delay);
}

async function sendYesterdaySalesReport() {
  const data = loadData();

  const y = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  y.setDate(y.getDate() - 1);
  const yKey = getKSTDateKey(y);

  const sales = data.salesByDate?.[yKey] || 0;
  const orders = data.ordersByDate?.[yKey] || 0;

  for (const [, guild] of client.guilds.cache) {
    const ch = await guild.channels.fetch(SALES_REPORT_CHANNEL_ID).catch(() => null);
    if (!ch) continue;
    await ch.send(`# 📌 일매출 리포트\n어제(${yKey}) 매출: **${formatWon(sales)}** / **${orders}건**`);
  }
}

// =================== 명령어 ===================

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // ✅ 구매 버튼 설치
  if (message.content === "!구매설치") {
    const buyBtn = new ButtonBuilder().setCustomId("buy_open").setLabel("🛒 구매하기").setStyle(ButtonStyle.Primary);

    await message.channel.send({
      content: "📦 아래 버튼을 눌러 상품을 구매하세요.",
      components: [new ActionRowBuilder().addComponents(buyBtn)],
    });

    return message.reply("✅ 설치 완료");
  }

  // ✅ 총 매출 확인 (관리자만)
  if (message.content === "!매출") {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply("❌ 관리자만 사용할 수 있어.");
    }
    const data = loadData();
    return message.reply(`📊 총 매출: ${formatWon(data.totalSalesWon)} / 📦 총 판매: ${data.totalOrders}건`);
  }

  // ✅ 오늘 매출 확인 (관리자만)
  if (message.content === "!일매출") {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply("❌ 관리자만 사용할 수 있어.");
    }
    const data = loadData();
    const todayKey = getKSTDateKey();
    const todaySales = data.salesByDate?.[todayKey] || 0;
    const todayOrders = data.ordersByDate?.[todayKey] || 0;
    return message.reply(`📊 오늘(${todayKey}) 매출: ${formatWon(todaySales)} / ${todayOrders}건`);
  }

  // ✅ 랭킹
  if (message.content === "!랭킹") {
    const data = loadData();
    const topText = buildTop5RankingText(data);
    return message.channel.send(`# 🏆 누적 구매금액 TOP 5\n${topText}`);
  }

  // ✅ 특정 유저 누적금액 (관리자만)
  if (message.content.startsWith("!누적금액")) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply("❌ 관리자만 사용할 수 있어.");
    }
    const mentioned = message.mentions.users.first();
    if (!mentioned) return message.reply("❌ 조회할 유저를 멘션해주세요.\n예: !누적금액 @유저");

    const data = loadData();
    const userData = data.users?.[mentioned.id];
    if (!userData) return message.reply("📊 해당 유저는 구매 기록이 없습니다.");

    const spent = userData.spentWon || 0;
    const tier = getTierBySpent(spent);
    return message.reply(`📊 <@${mentioned.id}> 누적 구매금액: ${formatWon(spent)}\n🏷️ 현재 등급: ${tier}`);
  }

  // ✅ 매출만 초기화 (관리자만) - 누적 구매금액/랭킹 유지
  if (message.content === "!매출초기화") {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply("❌ 관리자만 사용할 수 있습니다.");
    }

    const data = loadData();
    data.totalSalesWon = 0;
    data.totalOrders = 0;
    data.salesByDate = {};
    data.ordersByDate = {};
    saveData(data);

    return message.reply("📉 매출 데이터만 초기화되었습니다.\n(누적 구매금액 / 등급 / 랭킹은 유지됩니다)");
  }

  // ✅ 랭킹만 초기화 (관리자만) - 매출 유지
  if (message.content === "!랭킹초기화") {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply("❌ 관리자만 사용할 수 있습니다.");
    }

    const data = loadData();

    // 랭킹/누적 구매금액 데이터만 초기화
    data.users = {};

    saveData(data);

    return message.reply("🏆 랭킹(누적 구매금액/구매횟수)만 초기화되었습니다.\n(매출 데이터는 유지됩니다)");
  }

  // ✅ 구매완료 (관리자만 / 티켓에서만)
  if (message.content === "!구매완료") {
    if (!message.channel.name.includes("ticket-")) return message.reply("❌ 티켓 채널에서만 사용 가능");
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply("❌ 관리자만 사용할 수 있어.");
    }

    const logChannel = await message.guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (!logChannel) return message.reply("❌ 구매-로그 채널 ID 확인");

    const topic = message.channel.topic || "";
    const buyerMatch = topic.match(/buyer:(\d{17,20})/);
    const productMatch = topic.match(/product:([a-z0-9_]+)/i);
    const qtyMatch = topic.match(/qty:(\d+)/);
    const wonMatch = topic.match(/won:(\d+)/);
    const baseWonMatch = topic.match(/basewon:(\d+)/);
    const discountMatch = topic.match(/discount:([0-9.]+)/);

    const buyerId = buyerMatch ? buyerMatch[1] : null;
    const productValue = productMatch ? productMatch[1] : null;
    const qty = qtyMatch ? Number(qtyMatch[1]) : null;
    const finalWon = wonMatch ? Number(wonMatch[1]) : null;
    const baseWon = baseWonMatch ? Number(baseWonMatch[1]) : null;
    const discountRate = discountMatch ? Number(discountMatch[1]) : 0;

    if (!buyerId) return message.reply("❌ 구매자 정보 없음");
    if (typeof finalWon !== "number") return message.reply("❌ 결제금액 정보 없음");

    const productObj = PRODUCTS.find((p) => p.value === productValue);
    const productLabel = productObj ? productObj.label : "(상품정보없음)";
    const qtyText = Number.isInteger(qty) ? ` / 수량: ${qty}개` : "";

    const data = loadData();
    if (!data.users[buyerId]) data.users[buyerId] = { spentWon: 0, orders: 0 };
    if (typeof data.users[buyerId].spentWon !== "number") data.users[buyerId].spentWon = 0;
    if (typeof data.users[buyerId].orders !== "number") data.users[buyerId].orders = 0;

    data.users[buyerId].spentWon += finalWon;
    data.users[buyerId].orders += 1;

    data.totalSalesWon += finalWon;
    data.totalOrders += 1;

    const todayKey = getKSTDateKey();
    data.salesByDate[todayKey] = (data.salesByDate[todayKey] || 0) + finalWon;
    data.ordersByDate[todayKey] = (data.ordersByDate[todayKey] || 0) + 1;

    saveData(data);

    const spent = data.users[buyerId].spentWon;
    const tier = getTierBySpent(spent);

    const buyerMember = await message.guild.members.fetch(buyerId).catch(() => null);
    if (buyerMember) {
      await grantRoleIfExists(buyerMember, ROLE_BUYER_NAME);
      if (tier === "VIP" || tier === "VVIP") await grantRoleIfExists(buyerMember, ROLE_VIP_NAME);
      if (tier === "VVIP") await grantRoleIfExists(buyerMember, ROLE_VVIP_NAME);
    }

    let nextText = "";
    if (tier === "NORMAL") nextText = `VIP까지 ${formatWon(VIP_MIN_WON - spent)} 남음`;
    else if (tier === "VIP") nextText = `VVIP까지 ${formatWon(VVIP_MIN_WON - spent)} 남음`;
    else nextText = "🎉 최고 등급 VVIP 입니다!";

    await logChannel.send(
      `✅ <@${buyerId}>님 ${productLabel}${qtyText} 구매 감사합니다! 🎉\n` +
        `💰 원가: ${typeof baseWon === "number" ? formatWon(baseWon) : formatWon(finalWon)}\n` +
        `💸 할인: ${Math.round(discountRate * 100)}%\n` +
        `💵 결제금액: ${formatWon(finalWon)}\n` +
        `🏷️ 등급: ${tier}\n` +
        `📌 누적 구매금액: ${formatWon(spent)}\n` +
        `⭐ ${nextText}\n` +
        `처리자: <@${message.author.id}>`
    );

    if (RANK_CHANNEL_ID) {
      const rankCh = await message.guild.channels.fetch(RANK_CHANNEL_ID).catch(() => null);
      if (rankCh) {
        const d = loadData();
        const topText = buildTop5RankingText(d);
        rankCh.send(`# 🏆 누적 구매금액 TOP 5\n${topText}`).catch(() => null);
      }
    }

    let newName = message.channel.name;
    if (!newName.includes("-완료-")) newName = newName.replace(/^([abc])-ticket-/, "$1-완료-ticket-");
    if (newName.length > 100) newName = newName.slice(0, 100);
    await message.channel.setName(newName).catch(() => null);

    await message.reply("✅ 구매 완료 처리됨. 5초 후 티켓 삭제");
    setTimeout(() => message.channel.delete("Auto delete after purchase complete").catch(() => null), 5000);
  }
});

// =================== 인터랙션 ===================

client.on("interactionCreate", async (interaction) => {
  const findExistingTicket = () =>
    interaction.guild.channels.cache.find((ch) => {
      if (ch.type !== ChannelType.GuildText) return false;
      if (!/(^a-ticket-|^b-ticket-|^c-ticket-)/.test(ch.name)) return false;
      if (ch.name.includes("-완료-")) return false;
      const t = ch.topic || "";
      return t.includes(`buyer:${interaction.user.id}`);
    });

  // 구매하기 버튼 → 상품 선택
  if (interaction.isButton() && interaction.customId === "buy_open") {
    const already = findExistingTicket();
    if (already) {
      return interaction.reply({ content: `❌ 이미 진행 중인 티켓이 있습니다: <#${already.id}>`, ephemeral: true });
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId("product_select")
      .setPlaceholder("상품을 선택하세요")
      .addOptions(
        PRODUCTS.map((p) => ({
          label: p.label,
          description: `가격: ${p.unitPrice}`,
          value: p.value,
        }))
      );

    return interaction.reply({
      content: "📦 상품을 선택해주세요.",
      components: [new ActionRowBuilder().addComponents(menu)],
      ephemeral: true,
    });
  }

  // 상품 선택 → 수량 입력(모달)
  if (interaction.isStringSelectMenu() && interaction.customId === "product_select") {
    const already = findExistingTicket();
    if (already) {
      return interaction.reply({ content: `❌ 이미 진행 중인 티켓이 있습니다: <#${already.id}>`, ephemeral: true });
    }

    const selectedValue = interaction.values[0];
    const selected = PRODUCTS.find((p) => p.value === selectedValue);
    if (!selected) return interaction.reply({ content: "상품 정보를 찾을 수 없음 ❌", ephemeral: true });

    const modal = new ModalBuilder().setCustomId(`qty_modal:${selected.value}`).setTitle("수량 입력 (최대 100개)");

    const qtyInput = new TextInputBuilder()
      .setCustomId("qty")
      .setLabel("수량을 숫자로 입력하세요")
      .setPlaceholder("예: 1, 2, 10, 100")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
    return interaction.showModal(modal);
  }

  // 모달 제출 → 티켓 생성
  if (interaction.isModalSubmit() && interaction.customId.startsWith("qty_modal:")) {
    const already = findExistingTicket();
    if (already) {
      return interaction.reply({ content: `❌ 이미 진행 중인 티켓이 있습니다: <#${already.id}>`, ephemeral: true });
    }

    const productValue = interaction.customId.split(":")[1];
    const selected = PRODUCTS.find((p) => p.value === productValue);
    if (!selected) return interaction.reply({ content: "상품 정보를 찾을 수 없음 ❌", ephemeral: true });

    const qtyRaw = interaction.fields.getTextInputValue("qty").trim();
    const qtyClean = qtyRaw.replace(/,/g, "").replace(/\s/g, "");
    if (!/^\d+$/.test(qtyClean)) {
      return interaction.reply({ content: "❌ 수량은 숫자만 입력하세요. 예: 3", ephemeral: true });
    }

    const qty = Number(qtyClean);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) {
      return interaction.reply({ content: "❌ 수량은 1~100 사이로 입력하세요.", ephemeral: true });
    }

    const data = loadData();
    const spentWon = data.users?.[interaction.user.id]?.spentWon || 0;

    const tier = getTierBySpent(spentWon);
    const prefix = getPrefixByTier(tier);
    const discountRate = getDiscountRateBySpent(spentWon);

    const totalPriceStr = calcTotalPriceStr(selected.unitPrice, qty);
    const baseWon = Math.round(Number(totalPriceStr) * PRICE_TO_WON_MULTIPLIER);
    const finalWon = Math.round(baseWon * (1 - discountRate));

    const discountText = discountTextByTier(tier);
    const priorityText = tierLabel(tier);

    let nextTierText = "";
    if (tier === "NORMAL") nextTierText = `VIP까지 ${formatWon(VIP_MIN_WON - spentWon)} 남음`;
    else if (tier === "VIP") nextTierText = `VVIP까지 ${formatWon(VVIP_MIN_WON - spentWon)} 남음`;
    else nextTierText = "🎉 최고 등급 VVIP 입니다!";

    const safeUser = interaction.user.username.replace(/[^a-zA-Z0-9가-힣]/g, "");
    const channelName = `${prefix}-ticket-${selected.ticketName}x${qty}-${safeUser}`.toLowerCase();

    const ticketChannel = await interaction.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      topic: `buyer:${interaction.user.id} product:${selected.value} qty:${qty} basewon:${baseWon} won:${finalWon} discount:${discountRate}`,
      permissionOverwrites: [
        { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel] },
      ],
    });

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle("🎫 티켓이 정상적으로 생성되었습니다")
      .setDescription(
        "안녕하세요 👋\n\n" +
          `🏷️ **등급:** ${tier}\n` +
          `💸 **할인:** ${discountText}\n` +
          `📊 **누적 구매금액:** ${formatWon(spentWon)}\n` +
          `⭐ ${nextTierText}\n\n` +
          "🧾 **주문 정보**\n" +
          `📦 제품: **${selected.label}**\n` +
          `📦 수량: **${qty}개**\n` +
          `💰 원가: **${formatWon(baseWon)}**\n` +
          `💵 결제금액: **${formatWon(finalWon)}**\n\n` +
          "💳 **입금 안내**\n" +
          `계좌: ${ACCOUNT_TEXT}\n\n` +
          "📸 입금 후 **이중창 인증 스크린샷**을 이 채널에 보내주세요.\n" +
          "👇 아래 버튼을 눌러 계좌 문구를 복사하세요."
      )
      .setFooter({ text: "입금금액을 채팅으로 입력할 필요 없습니다. 스샷만 보내주세요." })
      .setTimestamp();

    const copyBtn = new ButtonBuilder()
      .setCustomId(`copy_account:${finalWon}`)
      .setLabel("💳 계좌 문구 복사")
      .setStyle(ButtonStyle.Success);

    await ticketChannel.send({
      content: `${ADMIN_MENTIONS}\n${priorityText}\n\n💰 **결제금액: ${formatWon(finalWon)}** (${discountText})`,
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(copyBtn)],
    });

    return interaction.reply({ content: `✅ 티켓 생성 완료: ${ticketChannel}`, ephemeral: true });
  }

  // 계좌 복사 버튼
  if (interaction.isButton() && interaction.customId.startsWith("copy_account:")) {
    const won = Number(interaction.customId.split(":")[1]);
    const text = `${ACCOUNT_TEXT}\n금액 ${formatWon(won)}`;
    return interaction.reply({ content: `\`\`\`${text}\`\`\``, ephemeral: true });
  }
});

client.login((process.env.DISCORD_TOKEN || "").trim());