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

// ✅ 구매리뷰 채널 ID (여기에 리뷰 채널 ID 넣기 / 안 쓰면 비워둬도 됨)
const REVIEW_CHANNEL_ID = "1477334923932340416";

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

// ✅ 재고를 "티켓 생성 시점"에 홀드(예약)할지 여부
const HOLD_STOCK_ON_TICKET_CREATE = true;

// ✅ 상품 목록 (packSize = 수량 1개당 차감되는 "마리" 수)
const PRODUCTS = [
  { label: "다이아 메타", value: "meta", unitPrice: 0.5, ticketName: "다이아메타", packSize: 1 },
  { label: "다이아 막뮤", value: "makmyu", unitPrice: 0.5, ticketName: "다이아막뮤", packSize: 1 },
  { label: "다이야 아누부부", value: "anubu", unitPrice: 0.3, ticketName: "아누부부", packSize: 1 },
];

// 데이터 파일
const DATA_PATH = path.join(__dirname, "data.json");

// =================== 유틸 ===================

function loadData() {
  try {
    if (!fs.existsSync(DATA_PATH)) {
      const init = {
        users: {}, // { [userId]: { spentWon, orders, psid? } }
        totalSalesWon: 0,
        totalOrders: 0,
        salesByDate: {},
        ordersByDate: {},
        stock: {},
      };
      fs.writeFileSync(DATA_PATH, JSON.stringify(init, null, 2), "utf-8");
      return init;
    }
    const parsed = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
    if (!parsed.users) parsed.users = {};
    if (typeof parsed.totalSalesWon !== "number") parsed.totalSalesWon = 0;
    if (typeof parsed.totalOrders !== "number") parsed.totalOrders = 0;
    if (!parsed.salesByDate) parsed.salesByDate = {};
    if (!parsed.ordersByDate) parsed.ordersByDate = {};
    if (!parsed.stock) parsed.stock = {};
    return parsed;
  } catch {
    return { users: {}, totalSalesWon: 0, totalOrders: 0, salesByDate: {}, ordersByDate: {}, stock: {} };
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

// ✅ 한글/코드 상품명 → value로 변환
function resolveProductValue(inputRaw) {
  if (!inputRaw) return null;

  const input = String(inputRaw).trim().toLowerCase().replace(/\s+/g, "");

  const byCode = PRODUCTS.find((p) => p.value.toLowerCase() === input);
  if (byCode) return byCode.value;

  const byTicketName = PRODUCTS.find((p) => String(p.ticketName).toLowerCase().replace(/\s+/g, "") === input);
  if (byTicketName) return byTicketName.value;

  const byLabel = PRODUCTS.find((p) => String(p.label).toLowerCase().replace(/\s+/g, "") === input);
  if (byLabel) return byLabel.value;

  const keywordMap = [
    { keywords: ["아누부부", "아누"], value: "anubu" },
    { keywords: ["다이아메타", "다이아 메타", "메타"], value: "meta" },
    { keywords: ["막뮤", "다이아막뮤", "다이아 막뮤"], value: "makmyu" },
  ];

  for (const item of keywordMap) {
    if (item.keywords.some((k) => input.includes(k))) return item.value;
  }

  return null;
}

// ✅ 티켓 접두사: VVIP > VIP > 구매자 > 신규
async function getTicketPrefixForUser(guild, userId) {
  const data = loadData();
  const u = data.users?.[userId];
  const spentWon = u?.spentWon || 0;
  const orders = u?.orders || 0;

  const tier = getTierBySpent(spentWon);

  const member = await guild.members.fetch(userId).catch(() => null);
  const hasBuyerRole = member?.roles?.cache?.some((r) => r.name === ROLE_BUYER_NAME);
  const isBuyer = hasBuyerRole || orders > 0 || spentWon > 0;

  if (tier === "VVIP") return "vvip";
  if (tier === "VIP") return "vip";
  if (isBuyer) return "구매자";
  return "신규";
}

// =================== 재고 유틸 ===================

function ensureStockKeys(data) {
  if (!data.stock) data.stock = {};
  for (const p of PRODUCTS) {
    if (typeof data.stock[p.value] !== "number") data.stock[p.value] = 0;
  }
}

function getStockAnimals(data, productValue) {
  ensureStockKeys(data);
  return data.stock[productValue] || 0;
}

function addStockAnimals(data, productValue, amount) {
  ensureStockKeys(data);
  data.stock[productValue] = Math.max(0, (data.stock[productValue] || 0) + amount);
}

function setStockAnimals(data, productValue, amount) {
  ensureStockKeys(data);
  data.stock[productValue] = Math.max(0, amount);
}

function formatAnimals(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "재고정보없음";
  return `${n.toLocaleString("ko-KR")}마리`;
}

function buildStockText(data) {
  ensureStockKeys(data);
  return PRODUCTS
    .map((p) => {
      const animals = getStockAnimals(data, p.value);
      const packs = p.packSize > 0 ? Math.floor(animals / p.packSize) : 0;
      return `• **${p.value}** (${p.label}) → 재고: **${formatAnimals(animals)}** / 구매가능(수량): **${packs}개**`;
    })
    .join("\n");
}

// =================== 봇 ===================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
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

  // ✅ 패널 설치 (관리자만) - 구매/정보 버튼 2개
  if (message.content === "!패널설치") {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply("❌ 관리자만 사용할 수 있어.");
    }

    const panelEmbed = new EmbedBuilder()
      .setColor(0x2f8cff)
      .setTitle("알파몰")
      .setDescription("아래 버튼을 클릭해 제품을 구매하실 수 있습니다.")
      .setTimestamp();

    const buyBtn = new ButtonBuilder().setCustomId("buy_open").setLabel("구매").setStyle(ButtonStyle.Primary);
    const infoBtn = new ButtonBuilder().setCustomId("panel_info").setLabel("정보").setStyle(ButtonStyle.Secondary);

    await message.channel.send({
      embeds: [panelEmbed],
      components: [new ActionRowBuilder().addComponents(buyBtn, infoBtn)],
    });

    return message.reply("✅ 패널 설치 완료");
  }

  // ✅ 후기 버튼 설치 (관리자만)
  if (message.content === "!후기설치") {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply("❌ 관리자만 사용할 수 있어.");
    }
    if (!REVIEW_CHANNEL_ID) return message.reply("❌ REVIEW_CHANNEL_ID 먼저 넣어줘.");

    const reviewBtn = new ButtonBuilder().setCustomId("review_open").setLabel("⭐ 후기 남기기").setStyle(ButtonStyle.Success);
    await message.channel.send({
      content: "📝 아래 버튼을 눌러 구매후기를 남겨주세요!",
      components: [new ActionRowBuilder().addComponents(reviewBtn)],
    });
    return message.reply("✅ 후기 버튼 설치 완료");
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

  // ✅ 매출만 초기화 (관리자만)
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

  // ✅ 랭킹만 초기화 (관리자만)
  if (message.content === "!랭킹초기화") {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply("❌ 관리자만 사용할 수 있습니다.");
    }

    const data = loadData();
    data.users = {};
    saveData(data);

    return message.reply("🏆 랭킹(누적 구매금액/구매횟수)만 초기화되었습니다.\n(매출 데이터는 유지됩니다)");
  }

  // ✅ 재고 보기 (관리자만)
  if (message.content === "!재고") {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply("❌ 관리자만 사용할 수 있어.");
    const data = loadData();
    return message.reply(`📦 **현재 재고(마리 기준)**\n${buildStockText(data)}`);
  }

  // ✅ 재고 충전 (관리자만)
  if (message.content.startsWith("!재고충전")) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply("❌ 관리자만 사용할 수 있어.");
    const parts = message.content.trim().split(/\s+/);

    const productValue = resolveProductValue(parts[1]);
    const amount = Number(parts[2]);

    if (!productValue || !Number.isFinite(amount)) {
      return message.reply(
        "❌ 사용법: `!재고충전 상품명 마리수`\n" +
          "예: `!재고충전 메타 100`\n" +
          "가능 상품: 메타, 막뮤, 아누부부"
      );
    }

    const data = loadData();
    addStockAnimals(data, productValue, Math.floor(amount));
    saveData(data);

    return message.reply(`✅ 재고 충전 완료: **${productValue}** → 현재 ${formatAnimals(getStockAnimals(data, productValue))}`);
  }

  // ✅ 재고 삭제/차감 (관리자만)
  if (message.content.startsWith("!재고삭제")) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply("❌ 관리자만 사용할 수 있어.");
    const parts = message.content.trim().split(/\s+/);

    const productValue = resolveProductValue(parts[1]);
    const amountRaw = parts[2];

    if (!productValue) {
      return message.reply(
        "❌ 사용법: `!재고삭제 상품명 [마리수]`\n" +
          "예: `!재고삭제 메타 30` 또는 `!재고삭제 메타`\n" +
          "가능 상품: 메타, 막뮤, 아누부부"
      );
    }

    const data = loadData();
    if (amountRaw == null) {
      setStockAnimals(data, productValue, 0);
    } else {
      const amount = Number(amountRaw);
      if (!Number.isFinite(amount)) return message.reply("❌ 마리수는 숫자여야 함");
      addStockAnimals(data, productValue, -Math.floor(amount));
    }
    saveData(data);

    return message.reply(`✅ 재고 반영 완료: **${productValue}** → 현재 ${formatAnimals(getStockAnimals(data, productValue))}`);
  }

  // ✅ 티켓 취소 (관리자만 / 티켓에서만)
  if (message.content === "!티켓취소") {
    if (!message.channel.name.includes("ticket-")) return message.reply("❌ 티켓 채널에서만 사용 가능");
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply("❌ 관리자만 사용할 수 있어.");

    const topic = message.channel.topic || "";
    const productMatch = topic.match(/product:([a-z0-9_]+)/i);
    const holdMatch = topic.match(/hold:(\d+)/);
    const heldMatch = topic.match(/held:(\d)/);

    const productValue = productMatch ? productMatch[1] : null;
    const holdAnimals = holdMatch ? Number(holdMatch[1]) : 0;
    const held = heldMatch ? Number(heldMatch[1]) : 0;

    if (HOLD_STOCK_ON_TICKET_CREATE && held === 1 && productValue && holdAnimals > 0) {
      const data = loadData();
      addStockAnimals(data, productValue, holdAnimals);
      saveData(data);
      await message.reply(`✅ 홀드된 재고 복구: **${productValue}** +${formatAnimals(holdAnimals)} (현재 ${formatAnimals(getStockAnimals(data, productValue))})`);
    } else {
      await message.reply("✅ 티켓 취소(재고 홀드 없음 또는 복구할 값 없음)");
    }

    setTimeout(() => message.channel.delete("Ticket canceled").catch(() => null), 1500);
  }

  // ✅ 구매완료 (관리자만 / 티켓에서만) + 구매로그를 Embed(사진 느낌)로 출력
  if (message.content === "!구매완료") {
    if (!message.channel.name.includes("ticket-")) return message.reply("❌ 티켓 채널에서만 사용 가능");
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply("❌ 관리자만 사용할 수 있어.");

    const logChannel = await message.guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (!logChannel) return message.reply("❌ 구매-로그 채널 ID 확인");

    const topic = message.channel.topic || "";
    const buyerMatch = topic.match(/buyer:(\d{17,20})/);
    const productMatch = topic.match(/product:([a-z0-9_]+)/i);
    const qtyMatch = topic.match(/qty:(\d+)/);
    const wonMatch = topic.match(/won:(\d+)/);
    const baseWonMatch = topic.match(/basewon:(\d+)/);
    const discountMatch = topic.match(/discount:([0-9.]+)/);
    const holdMatch = topic.match(/hold:(\d+)/);
    const heldMatch = topic.match(/held:(\d)/);
    const psidMatch = topic.match(/psid:([^ ]+)/i);

    const buyerId = buyerMatch ? buyerMatch[1] : null;
    const productValue = productMatch ? productMatch[1] : null;
    const qty = qtyMatch ? Number(qtyMatch[1]) : null;
    const finalWon = wonMatch ? Number(wonMatch[1]) : null;
    const baseWon = baseWonMatch ? Number(baseWonMatch[1]) : null;
    const discountRate = discountMatch ? Number(discountMatch[1]) : 0;

    const holdAnimals = holdMatch ? Number(holdMatch[1]) : 0;
    const held = heldMatch ? Number(heldMatch[1]) : 0;

    const psid = psidMatch ? psidMatch[1] : "미입력";

    if (!buyerId) return message.reply("❌ 구매자 정보 없음");
    if (typeof finalWon !== "number") return message.reply("❌ 결제금액 정보 없음");

    const productObj = PRODUCTS.find((p) => p.value === productValue);
    const productLabel = productObj ? productObj.label : "(상품정보없음)";

    // ✅ 안전장치: held=0(홀드 안 된 티켓) 이면 여기서 재고 차감
    if (productObj && (!HOLD_STOCK_ON_TICKET_CREATE || held !== 1)) {
      const needAnimals =
        Number.isInteger(qty) && qty > 0
          ? qty * (productObj.packSize || 1)
          : holdAnimals > 0
            ? holdAnimals
            : 0;

      if (needAnimals > 0) {
        const stockData = loadData();
        const currentAnimals = getStockAnimals(stockData, productObj.value);

        if (currentAnimals < needAnimals) {
          const packs = productObj.packSize > 0 ? Math.floor(currentAnimals / productObj.packSize) : 0;
          return message.reply(
            `❌ 재고 부족으로 완료 불가\n` +
              `현재: ${formatAnimals(currentAnimals)} (구매가능 ${packs}개)\n` +
              `필요: ${formatAnimals(needAnimals)}`
          );
        }

        addStockAnimals(stockData, productObj.value, -needAnimals);
        saveData(stockData);
      }
    }

    // 데이터 반영
    const data = loadData();
    if (!data.users[buyerId]) data.users[buyerId] = { spentWon: 0, orders: 0 };
    if (typeof data.users[buyerId].spentWon !== "number") data.users[buyerId].spentWon = 0;
    if (typeof data.users[buyerId].orders !== "number") data.users[buyerId].orders = 0;

    data.users[buyerId].spentWon += finalWon;
    data.users[buyerId].orders += 1;

    // ✅ PSID 저장(정보 버튼에서 보이게)
    data.users[buyerId].psid = psid;

    data.totalSalesWon += finalWon;
    data.totalOrders += 1;

    const todayKey = getKSTDateKey();
    data.salesByDate[todayKey] = (data.salesByDate[todayKey] || 0) + finalWon;
    data.ordersByDate[todayKey] = (data.ordersByDate[todayKey] || 0) + 1;
    saveData(data);

    const spent = data.users[buyerId].spentWon;
    const tier = getTierBySpent(spent);

    // 역할 지급
    const buyerMember = await message.guild.members.fetch(buyerId).catch(() => null);
    if (buyerMember) {
      await grantRoleIfExists(buyerMember, ROLE_BUYER_NAME);
      if (tier === "VIP" || tier === "VVIP") await grantRoleIfExists(buyerMember, ROLE_VIP_NAME);
      if (tier === "VVIP") await grantRoleIfExists(buyerMember, ROLE_VVIP_NAME);
    }

    // 다음 등급 안내
    let nextText = "";
    if (tier === "NORMAL") nextText = `VIP까지 ${formatWon(VIP_MIN_WON - spent)} 남음`;
    else if (tier === "VIP") nextText = `VVIP까지 ${formatWon(VVIP_MIN_WON - spent)} 남음`;
    else nextText = "🎉 최고 등급 VVIP 입니다!";

    // 남은 재고 표시(로그용)
    let stockLeftText = "";
    if (productObj) {
      const left = getStockAnimals(loadData(), productObj.value);
      stockLeftText = `\n📦 남은 재고: ${formatAnimals(left)}`;
    }

    // ✅ 구매로그 Embed (사진 느낌: • 리스트 / PSID, DISCORD, 구매상품, 구매 갯수)
    const buyerUser = await client.users.fetch(buyerId).catch(() => null);
    const purchaseEmbed = new EmbedBuilder()
      .setColor(0x2f8cff)
      .setTitle(`${psid}님의 구매 로그`)
      .setThumbnail(buyerUser?.displayAvatarURL?.({ size: 256 }) || null)
      .setDescription(
        `• 🆔 유저 PSID: **${psid}**\n` +
        `• 👤 유저 DISCORD: <@${buyerId}>\n` +
        `• 💰 구매상품: ${productLabel}\n` +
        `• 💰 구매 갯수: **${Number.isInteger(qty) ? qty : "미기록"}**`
      )
      .setTimestamp();

    await logChannel.send({ embeds: [purchaseEmbed] });

    // ✅ 랭킹 자동 업로드 채널
    if (RANK_CHANNEL_ID) {
      const rankCh = await message.guild.channels.fetch(RANK_CHANNEL_ID).catch(() => null);
      if (rankCh) {
        const d = loadData();
        const topText = buildTop5RankingText(d);
        rankCh.send(`# 🏆 누적 구매금액 TOP 5\n${topText}`).catch(() => null);
      }
    }

    let newName = message.channel.name;
    if (!newName.includes("-완료-")) newName = newName.replace(/^(vvip|vip|구매자|신규)-ticket-/, "$1-완료-ticket-");
    if (newName.length > 100) newName = newName.slice(0, 100);
    await message.channel.setName(newName).catch(() => null);

    await message.reply(
      `✅ 구매 완료 처리됨\n` +
      `💰 원가: ${typeof baseWon === "number" ? formatWon(baseWon) : formatWon(finalWon)}\n` +
      `💸 할인: ${Math.round(discountRate * 100)}%\n` +
      `💵 결제금액: ${formatWon(finalWon)}\n` +
      `🏷️ 등급: ${tier}\n` +
      `📌 누적 구매금액: ${formatWon(spent)}\n` +
      `⭐ ${nextText}${stockLeftText}\n` +
      `5초 후 티켓 삭제`
    );

    setTimeout(() => message.channel.delete("Auto delete after purchase complete").catch(() => null), 5000);
  }
});

// =================== 인터랙션 ===================

client.on("interactionCreate", async (interaction) => {
  const findExistingTicket = () =>
    interaction.guild.channels.cache.find((ch) => {
      if (ch.type !== ChannelType.GuildText) return false;
      if (!/(^vvip-ticket-|^vip-ticket-|^구매자-ticket-|^신규-ticket-)/.test(ch.name)) return false;
      if (ch.name.includes("-완료-")) return false;
      const t = ch.topic || "";
      return t.includes(`buyer:${interaction.user.id}`);
    });

  // ✅ 패널 "정보" 버튼 (사진 느낌)
  if (interaction.isButton() && interaction.customId === "panel_info") {
    const data = loadData();
    const u = data.users?.[interaction.user.id] || {};
    const psid = u.psid || "미등록";
    const spentWon = u.spentWon || 0;

    const tier = getTierBySpent(spentWon);
    const tierText = tier === "VVIP" ? "VVIP" : tier === "VIP" ? "VIP" : "비구매자";

    const embed = new EmbedBuilder()
      .setColor(0x2f8cff)
      .setTitle("📝 기본 정보")
      .setDescription(
        `• 👤 아이디: ${interaction.user.id}\n` +
        `• 🆔 PSID: ${psid}\n\n` +
        `💰 **금액 정보**\n` +
        `• 💵 잔액: 0원\n` +
        `• 🎁 누적구매: ${formatWon(spentWon)}\n\n` +
        `👑 **등급 정보**\n` +
        `• 🏅 등급: ${tierText}`
      )
      .setTimestamp();

    const passBtn = new ButtonBuilder().setCustomId("auth_pass").setLabel("PASS 인증하기").setStyle(ButtonStyle.Secondary);
    const smsBtn = new ButtonBuilder().setCustomId("auth_sms").setLabel("SMS 인증하기").setStyle(ButtonStyle.Secondary);

    return interaction.reply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(passBtn), new ActionRowBuilder().addComponents(smsBtn)],
      ephemeral: true,
    });
  }

  // PASS / SMS 버튼 (일단 안내만)
  if (interaction.isButton() && interaction.customId === "auth_pass") {
    return interaction.reply({ content: "✅ PASS 인증은 준비중입니다. (원하면 링크/절차 붙여줄게)", ephemeral: true });
  }
  if (interaction.isButton() && interaction.customId === "auth_sms") {
    return interaction.reply({ content: "✅ SMS 인증은 준비중입니다. (원하면 링크/절차 붙여줄게)", ephemeral: true });
  }

  // 구매하기 버튼 → 상품 선택
  if (interaction.isButton() && interaction.customId === "buy_open") {
    const already = findExistingTicket();
    if (already) return interaction.reply({ content: `❌ 이미 진행 중인 티켓이 있습니다: <#${already.id}>`, ephemeral: true });

    const data = loadData();

    const menu = new StringSelectMenuBuilder()
      .setCustomId("product_select")
      .setPlaceholder("제품을 선택하세요")
      .addOptions(
        PRODUCTS.map((p) => {
          const animals = getStockAnimals(data, p.value);
          const packs = p.packSize > 0 ? Math.floor(animals / p.packSize) : 0;
          const soldout = packs <= 0;
          return {
            label: soldout ? `❌ 품절 | ${p.label}` : p.label,
            description: soldout ? `품절 (재고 0)` : `가격: ${p.unitPrice} / 재고(구매가능): ${packs}개`,
            value: p.value,
          };
        })
      );

    return interaction.reply({
      content: "📦 제품을 선택하세요.",
      components: [new ActionRowBuilder().addComponents(menu)],
      ephemeral: true,
    });
  }

  // 상품 선택 → 수량+PSID 입력(모달)
  if (interaction.isStringSelectMenu() && interaction.customId === "product_select") {
    const already = findExistingTicket();
    if (already) return interaction.reply({ content: `❌ 이미 진행 중인 티켓이 있습니다: <#${already.id}>`, ephemeral: true });

    const selectedValue = interaction.values[0];
    const selected = PRODUCTS.find((p) => p.value === selectedValue);
    if (!selected) return interaction.reply({ content: "상품 정보를 찾을 수 없음 ❌", ephemeral: true });

    const data = loadData();
    const animals = getStockAnimals(data, selected.value);
    const packs = selected.packSize > 0 ? Math.floor(animals / selected.packSize) : 0;
    if (packs <= 0) return interaction.reply({ content: "❌ 해당 상품은 현재 품절입니다.", ephemeral: true });

    const modal = new ModalBuilder().setCustomId(`qty_modal:${selected.value}`).setTitle("수량/PSID 입력");

    const qtyInput = new TextInputBuilder()
      .setCustomId("qty")
      .setLabel("수량(1~100)")
      .setPlaceholder("예: 1, 2, 10")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const psidInput = new TextInputBuilder()
      .setCustomId("psid")
      .setLabel("PSID 입력(필수)")
      .setPlaceholder("예: zhqmfk2011")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
    modal.addComponents(new ActionRowBuilder().addComponents(psidInput));
    return interaction.showModal(modal);
  }

  // 모달 제출 → 티켓 생성
  if (interaction.isModalSubmit() && interaction.customId.startsWith("qty_modal:")) {
    const already = findExistingTicket();
    if (already) return interaction.reply({ content: `❌ 이미 진행 중인 티켓이 있습니다: <#${already.id}>`, ephemeral: true });

    const productValue = interaction.customId.split(":")[1];
    const selected = PRODUCTS.find((p) => p.value === productValue);
    if (!selected) return interaction.reply({ content: "상품 정보를 찾을 수 없음 ❌", ephemeral: true });

    const qtyRaw = interaction.fields.getTextInputValue("qty").trim();
    const qtyClean = qtyRaw.replace(/,/g, "").replace(/\s/g, "");
    if (!/^\d+$/.test(qtyClean)) return interaction.reply({ content: "❌ 수량은 숫자만 입력하세요. 예: 3", ephemeral: true });

    const qty = Number(qtyClean);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) return interaction.reply({ content: "❌ 수량은 1~100 사이로 입력하세요.", ephemeral: true });

    const psidRaw = interaction.fields.getTextInputValue("psid").trim();
    const psid = psidRaw.replace(/\s+/g, "");
    if (!psid) return interaction.reply({ content: "❌ PSID를 입력해주세요.", ephemeral: true });

    const needAnimals = qty * (selected.packSize || 1);

    const stockData = loadData();
    const currentAnimals = getStockAnimals(stockData, selected.value);
    if (currentAnimals < needAnimals) {
      const packs = selected.packSize > 0 ? Math.floor(currentAnimals / selected.packSize) : 0;
      return interaction.reply({
        content:
          `❌ 재고 부족!\n` +
          `현재 재고: ${formatAnimals(currentAnimals)} (구매가능 수량: ${packs}개)\n` +
          `요청: ${formatAnimals(needAnimals)} (수량 ${qty}개)`,
        ephemeral: true,
      });
    }

    let held = 0;
    if (HOLD_STOCK_ON_TICKET_CREATE) {
      addStockAnimals(stockData, selected.value, -needAnimals);
      saveData(stockData);
      held = 1;
    }

    // ✅ PSID 유저 데이터에도 저장(정보 버튼에서 보이게)
    const d0 = loadData();
    if (!d0.users[interaction.user.id]) d0.users[interaction.user.id] = { spentWon: 0, orders: 0 };
    d0.users[interaction.user.id].psid = psid;
    saveData(d0);

    const data = loadData();
    const spentWon = data.users?.[interaction.user.id]?.spentWon || 0;
    const tier = getTierBySpent(spentWon);

    const prefix = await getTicketPrefixForUser(interaction.guild, interaction.user.id);
    const discountRate = getDiscountRateBySpent(spentWon);

    const totalPriceStr = calcTotalPriceStr(selected.unitPrice, qty);
    const baseWon = Math.round(Number(totalPriceStr) * PRICE_TO_WON_MULTIPLIER);
    const finalWon = Math.round(baseWon * (1 - discountRate));

    const discountText = discountTextByTier(tier);
    const priorityText = tierLabel(tier);

    const safeUser = interaction.user.username.replace(/[^a-zA-Z0-9가-힣]/g, "");
    const channelName = `${prefix}-ticket-${selected.ticketName}x${qty}-${safeUser}`.toLowerCase();

    const ticketChannel = await interaction.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      topic: `buyer:${interaction.user.id} psid:${psid} product:${selected.value} qty:${qty} basewon:${baseWon} won:${finalWon} discount:${discountRate} hold:${needAnimals} held:${held}`,
      permissionOverwrites: [
        { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel] },
      ],
    });

    // ✅ 등급 높은 티켓이 항상 위로 오게 자동 정렬
    try {
      const category = ticketChannel.parent;
      const siblings = category
        ? category.children.cache.filter((ch) => ch.id !== ticketChannel.id).sort((a, b) => a.position - b.position)
        : null;

      let newPosition = siblings ? siblings.size : 1000;
      if (tier === "VVIP") newPosition = 0;
      else if (tier === "VIP") newPosition = 1;
      else if (prefix === "구매자") newPosition = 2;
      else newPosition = 3;

      await ticketChannel.setPosition(newPosition);
    } catch (e) {
      console.log("정렬 오류:", e?.message || e);
    }

    // ✅✅✅ 티켓 생성 안내 문구 (C안 + 차감 제거 + 샵 느낌)
    const embed = new EmbedBuilder()
      .setTitle("🎫 결제 안내")
      .setDescription(
        `• 🆔 PSID: ${psid}\n` +
          `• 📦 제품: ${selected.label}\n` +
          `• 🔢 수량: ${qty}개\n\n` +
          `💵 **결제금액: ${formatWon(finalWon)}** (${discountText})\n\n` +
          `🏦 계좌\n` +
          `\`\`\`\n${ACCOUNT_TEXT}\n\`\`\`\n` +
          `입금 후 스샷 인증 보내주세요.`
      )
      .setTimestamp();

    const copyBtn = new ButtonBuilder().setCustomId(`copy_account:${finalWon}`).setLabel("💳 계좌 문구 복사").setStyle(ButtonStyle.Success);

    await ticketChannel.send({
      content: `${ADMIN_MENTIONS}\n${priorityText}`,
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

  // 후기 버튼 → 모달
  if (interaction.isButton() && interaction.customId === "review_open") {
    if (!REVIEW_CHANNEL_ID) return interaction.reply({ content: "❌ REVIEW_CHANNEL_ID 먼저 설정해줘.", ephemeral: true });

    const modal = new ModalBuilder().setCustomId("review_modal").setTitle("구매후기 작성");

    const productInput = new TextInputBuilder()
      .setCustomId("product")
      .setLabel("구매한 상품")
      .setPlaceholder("예: 로블 새 계정 / 5글자 계정 / 다이아 메타 등")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const starInput = new TextInputBuilder()
      .setCustomId("stars")
      .setLabel("별점(1~5 숫자)")
      .setPlaceholder("예: 5")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const contentInput = new TextInputBuilder()
      .setCustomId("content")
      .setLabel("후기 내용")
      .setPlaceholder("예: 빠르고 친절해요!")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(productInput));
    modal.addComponents(new ActionRowBuilder().addComponents(starInput));
    modal.addComponents(new ActionRowBuilder().addComponents(contentInput));

    return interaction.showModal(modal);
  }

  // 후기 모달 제출 → 후기 채널에 Embed 업로드(사진 느낌)
  if (interaction.isModalSubmit() && interaction.customId === "review_modal") {
    if (!REVIEW_CHANNEL_ID) return interaction.reply({ content: "❌ REVIEW_CHANNEL_ID 먼저 설정해줘.", ephemeral: true });

    const product = interaction.fields.getTextInputValue("product").trim();
    const starsRaw = interaction.fields.getTextInputValue("stars").trim();
    const content = interaction.fields.getTextInputValue("content").trim();

    const starsNum = Number(starsRaw);
    if (!Number.isInteger(starsNum) || starsNum < 1 || starsNum > 5) {
      return interaction.reply({ content: "❌ 별점은 1~5 숫자로 입력해줘.", ephemeral: true });
    }

    const stars = "⭐".repeat(starsNum);

    const reviewCh = await interaction.guild.channels.fetch(REVIEW_CHANNEL_ID).catch(() => null);
    if (!reviewCh) return interaction.reply({ content: "❌ 리뷰 채널을 찾을 수 없음 (ID 확인)", ephemeral: true });

    const embed = new EmbedBuilder()
      .setColor(0x2f8cff)
      .setTitle(`${interaction.user.username}님의 구매후기`)
      .setThumbnail(interaction.user.displayAvatarURL({ size: 256 }))
      .setDescription(`• 구매한 상품: ${product}\n• 별점: ${stars}\n• 후기내용: ${content}`)
      .setTimestamp();

    await reviewCh.send({ embeds: [embed] });
    return interaction.reply({ content: "✅ 후기 등록 완료!", ephemeral: true });
  }
});

client.login((process.env.DISCORD_TOKEN || "").trim());