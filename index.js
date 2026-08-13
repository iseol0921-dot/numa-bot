import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder,
  ChannelType, PermissionFlagsBits
} from 'discord.js';
import fs from 'fs';

const SERVER_IDS = [
  '1519109990101815386',
  '1506990201204117565',
  '1507442329890455662',
  '1530925354141749258'
];

const DATA_FILE = './data.json';
const NOTICE_REFRESH_COUNT = 5;

// ===== 아이템 거래방 자동 리셋 설정 =====
const TRADE_CHANNEL_ID = '1507418733520617745'; // 아이템 거래방
const RESET_INTERVAL_DAYS = 2;
const RESET_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1시간마다 체크

// ===== 티켓 시스템 설정 =====
// 티켓 종류(type)별 + 서버(guildId)별로 카테고리/운영진 역할을 지정.
// 같은 서버에 티켓 종류를 추가하고 싶으면 해당 종류의 guilds 객체에 줄만 추가하면 됨.
const TICKET_TYPES = {
  join: {
    label: '가입문의 티켓',
    channelPrefix: 'ticket',
    guilds: {
      '1506990201204117565': {
        categoryId: '1530486582111506432',
        staffRoleIds: ['1506996344563171458', '1506996779139207239']
      }
      // '1519109990101815386': { categoryId: '...', staffRoleIds: ['...'] },
      // '1507442329890455662': { categoryId: '...', staffRoleIds: ['...'] },
    }
  },
  inquiry: {
    label: '문의/상담 티켓',
    channelPrefix: 'inquiry',
    guilds: {
      '1506990201204117565': {
        categoryId: '1506990407853281432',
        staffRoleIds: ['1506996344563171458', '1506996779139207239']
      },
      '1530925354141749258': {
        categoryId: '1530931388646162504',
        staffRoleIds: ['1537593535102984212']
      }
    }
  }
};

// ===== 직업패널 설정 =====
// 서버(guildId)별로 직업 → 역할ID 매핑. 새 서버에 직업패널을 추가하고 싶으면
// 아래에 guildId 블록만 추가하면 됨.
const JOB_ROLES = {
  '1530925354141749258': {
    전사: '1537004690452250694',
    궁수: '1537004733028638731',
    도적: '1537004769971802142',
    법사: '1537004800602935366',
    해적: '1537585446781984898',
    용병: '1537586179287810109'
  }
};

const JOB_ORDER = ['전사', '궁수', '도적', '법사', '해적'];
const MERCENARY_JOB = '용병';
const MERCENARY_PREFIX = '[용병] ';

function withMercenaryPrefix(nickname) {
  return nickname.startsWith(MERCENARY_PREFIX) ? nickname : `${MERCENARY_PREFIX}${nickname}`;
}

function withoutMercenaryPrefix(nickname) {
  return nickname.startsWith(MERCENARY_PREFIX) ? nickname.slice(MERCENARY_PREFIX.length) : nickname;
}

async function setMercenaryNickname(member, isMercenary) {
  const currentName = member.nickname || member.user.username;
  const targetName = isMercenary ? withMercenaryPrefix(currentName) : withoutMercenaryPrefix(currentName);

  if (targetName === currentName) return;
  if (targetName.length > 32) return; // 디스코드 닉네임 길이 제한

  await member.setNickname(targetName).catch(() => {});
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { raids: {}, notices: {}, contribution: {}, resetState: {}, tickets: {} };
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!data.raids) data.raids = {};
    if (!data.notices) data.notices = {};
    if (!data.contribution) data.contribution = {};
    if (!data.resetState) data.resetState = {};
    if (!data.tickets) data.tickets = {};
    return data;
  } catch {
    return { raids: {}, notices: {}, contribution: {}, resetState: {}, tickets: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getBossEmoji(boss) {
  if (boss.includes('혼텔') || boss.includes('혼테일')) return '🐍';
  if (boss.includes('핑빈') || boss.includes('핑크빈')) return '🐷';
  if (boss.includes('카쿰') || boss.includes('자쿰')) return '💀';
  if (boss.includes('카텔')) return '🐲';
  return '⚔️';
}

function makeEmbed(raid) {
  const list = raid.members.length
    ? raid.members.map((m, i) => `${i + 1}. ${m.nickname} / ${m.job} / ${m.level}`).join('\n')
    : '아직 신청자가 없습니다.';

return new EmbedBuilder()
  .setTitle(`${getBossEmoji(raid.boss)} ${raid.boss} ${raid.date} ${raid.time}`)
  .setDescription(`현재 신청 인원: **${raid.members.length} / ${raid.limit}명**\n\n${list}`)
  .setColor(0x7c5cff);
}

function makeButtons(raidId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`join:${raidId}`).setLabel('참여신청').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`cancel:${raidId}`).setLabel('신청취소').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`list:${raidId}`).setLabel('명단확인').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`party:${raidId}`).setLabel('공대편성').setStyle(ButtonStyle.Secondary)
  );
}

function parseMoneyList(text) {
  if (!text || text === '0') return [];
  return text
    .split(',')
    .map(v => Number(v.trim().replaceAll(',', '')))
    .filter(v => !isNaN(v) && v > 0);
}

function formatMesos(num) {
  return Math.floor(num).toLocaleString('ko-KR');
}

// 택배 수수료: 고정 10,000메소 + 금액의 8%
function getParcelFee(amount) {
  return 10000 + Math.floor(amount * 0.08);
}

// 직거래(교환) 수수료: 금액의 6% (고정비 없음)
function getDirectTradeFee(amount) {
  return Math.floor(amount * 0.06);
}

function restoreRaidFromMessage(interaction, raidId) {
  const embed = interaction.message.embeds[0];
  if (!embed) return null;

  const rawTitle = embed.title ?? '';
  const title = rawTitle.replace(/^.+?\s/, '');
  const parts = title.split(' ');
  const boss = parts[0] ?? '보스';
  const date = parts[1] ?? '';
  const time = parts.slice(2).join(' ') || '';
  const desc = embed.description ?? '';
  const limitMatch = desc.match(/\/\s*(\d+)명/);
  const limit = limitMatch ? Number(limitMatch[1]) : 0;

  return {
    id: raidId,
    boss,
    date,
    time,
    limit,
    messageId: interaction.message.id,
    channelId: interaction.channelId,
    createdBy: '',
    members: [],
    parties: { party1: [], party2: [], party3: [] }
  };
}

function parseNames(text) {
  if (!text) return [];
  return text
    .split(',')
    .map(v => v.trim())
    .filter(v => v.length > 0);
}

function pickMembersByName(raid, names) {
  return names
    .map(name =>
      raid.members.find(m =>
        m.nickname.toLowerCase() === name.toLowerCase()
      )
    )
    .filter(Boolean);
}

function partyText(title, members) {
  const body = members.length
    ? members.map((m, i) => `${i + 1}. ${m.nickname} / ${m.job} / ${m.level}`).join('\n')
    : '없음';

  return `${title}\n${body}`;
}

async function repostNotice(guildId, channelId) {
  const data = loadData();
  const notice = data.notices?.[guildId]?.[channelId];
  if (!notice) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  if (notice.messageId) {
    const oldMsg = await channel.messages.fetch(notice.messageId).catch(() => null);
    if (oldMsg) {
      await oldMsg.delete().catch(() => {});
    }
  }

 const embed = new EmbedBuilder()
  .setTitle('💗 공지 안 읽으면 머머리 💗')
  .setDescription(notice.content)
  .setColor(0xff69b4);
const newMsg = await channel.send({ embeds: [embed] });
  notice.messageId = newMsg.id;
  notice.count = 0;

  data.notices[guildId][channelId] = notice;
  saveData(data);
}

function parseMessageLink(link) {
  const match = link.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (!match) return null;
  return { guildId: match[1], channelId: match[2], messageId: match[3] };
}

async function getAllPollVoters(message) {
  const voterIds = new Set();
  if (!message.poll) return voterIds;
  for (const answer of message.poll.answers.values()) {
    let after;
    while (true) {
      const voters = await answer.fetchVoters({ limit: 100, after });
      if (voters.size === 0) break;
      voters.forEach(u => voterIds.add(u.id));
      if (voters.size < 100) break;
      after = voters.last().id;
    }
  }
  return voterIds;
}

// ===== 아이템 거래방 자동 리셋 로직 =====

// 채널의 모든 메시지를 삭제 (14일 이내 메시지는 bulkDelete, 그 이상은 개별 삭제)
async function purgeChannelMessages(channel) {
  let totalDeleted = 0;

  while (true) {
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages || messages.size === 0) break;

    // 14일 이내 메시지는 bulkDelete로 한번에, 오래된 메시지는 개별 삭제
    const bulkDeletable = messages.filter(
      m => Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000
    );
    const tooOld = messages.filter(
      m => Date.now() - m.createdTimestamp >= 14 * 24 * 60 * 60 * 1000
    );

    if (bulkDeletable.size > 0) {
      const deleted = await channel.bulkDelete(bulkDeletable, true).catch(() => null);
      totalDeleted += deleted ? deleted.size : 0;
    }

    for (const [, msg] of tooOld) {
      await msg.delete().catch(() => {});
      totalDeleted += 1;
    }

    if (messages.size < 100) break;
  }

  return totalDeleted;
}

async function resetTradeChannel() {
  const channel = await client.channels.fetch(TRADE_CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error('[거래방 리셋] 채널을 찾을 수 없음. TRADE_CHANNEL_ID 확인 필요');
    return;
  }

  const deletedCount = await purgeChannelMessages(channel);
  console.log(`[거래방 리셋] ${deletedCount}개 메시지 삭제됨`);

  const notice = await channel.send('🔄 아이템 거래방 내역이 초기화되었습니다.');
  setTimeout(() => notice.delete().catch(() => {}), 10000);
}

async function checkAndResetTradeChannel() {
  const data = loadData();
  const lastResetStr = data.resetState?.tradeChannel;
  const lastReset = lastResetStr ? new Date(lastResetStr) : null;
  const now = new Date();

  const dueForReset =
    !lastReset || (now.getTime() - lastReset.getTime()) >= RESET_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

  if (!dueForReset) return;

  await resetTradeChannel();

  data.resetState.tradeChannel = now.toISOString();
  saveData(data);
}

// ===== 티켓 시스템 로직 =====

function makeTicketPanelEmbed(type) {
  return new EmbedBuilder()
    .setTitle(`🎫 ${TICKET_TYPES[type].label}`)
    .setDescription('아래 버튼을 눌러 개인 문의 채널을 생성해줘.')
    .setColor(0xff69b4);
}

function makeTicketPanelButton(type) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`create_ticket:${type}`)
      .setLabel(`${TICKET_TYPES[type].label} 생성`)
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🎫')
  );
}

function makeTicketCloseButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('close_ticket')
      .setLabel('티켓 닫기')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒')
  );
}

async function handleCreateTicket(interaction, type) {
  const data = loadData();
  const guild = interaction.guild;
  const user = interaction.user;

  const ticketType = TICKET_TYPES[type];
  const config = ticketType?.guilds?.[guild.id];
  if (!config) {
    await interaction.reply({
      content: '이 서버에는 티켓 설정이 안 되어 있어. 관리자에게 문의해줘.',
      ephemeral: true
    });
    return;
  }

  // 같은 종류의 티켓이 이미 열려있는지 확인 (종류별로 따로 카운트)
  const existingChannelId = Object.keys(data.tickets).find(
    channelId =>
      data.tickets[channelId].userId === user.id &&
      data.tickets[channelId].guildId === guild.id &&
      data.tickets[channelId].type === type
  );

  if (existingChannelId) {
    const existingChannel = guild.channels.cache.get(existingChannelId);
    if (existingChannel) {
      await interaction.reply({
        content: `이미 열려있는 ${ticketType.label}이 있어: ${existingChannel}`,
        ephemeral: true
      });
      return;
    }
    // 채널이 실제로는 없는데 데이터만 남아있는 경우 정리
    delete data.tickets[existingChannelId];
    saveData(data);
  }

  const ticketChannel = await guild.channels.create({
    name: `${ticketType.channelPrefix}-${user.username}`,
    type: ChannelType.GuildText,
    parent: config.categoryId,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel]
      },
      {
        id: user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
      },
      ...config.staffRoleIds.map(roleId => ({
        id: roleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
      }))
    ]
  });

  data.tickets[ticketChannel.id] = {
    userId: user.id,
    guildId: guild.id,
    type,
    createdAt: new Date().toISOString()
  };
  saveData(data);

  const embed = new EmbedBuilder()
    .setTitle(`🎫 ${ticketType.label}`)
    .setDescription(`${user} 님, 문의 내용을 남겨줘. 스태프가 확인 후 답변할게.`)
    .setColor(0xff69b4);

  await ticketChannel.send({ embeds: [embed], components: [makeTicketCloseButton()] });

  await interaction.reply({
    content: `✅ ${ticketType.label}이 생성됐어: ${ticketChannel}`,
    ephemeral: true
  });
}

async function handleCloseTicket(interaction) {
  const data = loadData();
  const ticket = data.tickets[interaction.channelId];
  const config = ticket ? TICKET_TYPES[ticket.type]?.guilds?.[interaction.guildId] : null;

  const isStaff =
    interaction.member.permissions.has('Administrator') ||
    (config && config.staffRoleIds.some(roleId => interaction.member.roles.cache.has(roleId)));
  const isOwner = ticket?.userId === interaction.user.id;

  if (!isStaff && !isOwner) {
    await interaction.reply({ content: '티켓 생성자나 스태프만 닫을 수 있어.', ephemeral: true });
    return;
  }

  await interaction.reply('🔒 5초 후 이 티켓을 닫을게...');

  delete data.tickets[interaction.channelId];
  saveData(data);

  setTimeout(() => {
    interaction.channel.delete().catch(() => {});
  }, 5000);
}

// ===== 직업패널 로직 =====

function makeJobPanelEmbed() {
  return new EmbedBuilder()
    .setTitle('⚔️ 직업 선택 패널')
    .setDescription('아래 버튼에서 본인 직업을 선택해줘. (직업 역할은 1개만 유지돼)')
    .setColor(0x7c5cff);
}

function makeJobPanelButtons() {
  const row1 = new ActionRowBuilder().addComponents(
    JOB_ORDER.slice(0, 3).map(job =>
      new ButtonBuilder().setCustomId(`job:${job}`).setLabel(job).setStyle(ButtonStyle.Primary)
    )
  );
  const row2 = new ActionRowBuilder().addComponents(
    JOB_ORDER.slice(3, 5).map(job =>
      new ButtonBuilder().setCustomId(`job:${job}`).setLabel(job).setStyle(ButtonStyle.Primary)
    )
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('job_reset').setLabel('리셋').setStyle(ButtonStyle.Danger)
  );

  return [row1, row2, row3];
}

function makeMercenaryPanelEmbed() {
  return new EmbedBuilder()
    .setTitle('🛡️ 용병 패널')
    .setDescription('아래 버튼을 눌러 용병 역할을 설정하거나 해제해줘.')
    .setColor(0x7c5cff);
}

function makeMercenaryPanelButtons() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`job:${MERCENARY_JOB}`).setLabel(MERCENARY_JOB).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('mercenary_reset').setLabel('리셋').setStyle(ButtonStyle.Danger)
  );

  return [row];
}

async function handleJobSelect(interaction, job) {
  const guildId = interaction.guildId;
  const jobRoles = JOB_ROLES[guildId];

  if (!jobRoles) {
    await interaction.reply({ content: '이 서버에는 직업패널 설정이 안 되어 있어. 관리자에게 문의해줘.', ephemeral: true });
    return;
  }

  const targetRoleId = jobRoles[job];
  if (!targetRoleId) {
    await interaction.reply({ content: '알 수 없는 직업이야.', ephemeral: true });
    return;
  }

  const member = interaction.member;
  const allJobRoleIds = Object.values(jobRoles);
  const mercenaryRoleId = jobRoles[MERCENARY_JOB];

  const rolesToRemove = allJobRoleIds.filter(
    roleId => roleId !== targetRoleId && member.roles.cache.has(roleId)
  );
  if (rolesToRemove.length) {
    await member.roles.remove(rolesToRemove).catch(() => {});
  }

  if (!member.roles.cache.has(targetRoleId)) {
    await member.roles.add(targetRoleId).catch(() => {});
  }

  if (job === MERCENARY_JOB) {
    await setMercenaryNickname(member, true);
  } else if (mercenaryRoleId && rolesToRemove.includes(mercenaryRoleId)) {
    await setMercenaryNickname(member, false);
  }

  await interaction.reply({ content: `✅ [${job}] 역할로 설정됐어.`, ephemeral: true });
}

async function handleJobReset(interaction) {
  const guildId = interaction.guildId;
  const jobRoles = JOB_ROLES[guildId];

  if (!jobRoles) {
    await interaction.reply({ content: '이 서버에는 직업패널 설정이 안 되어 있어. 관리자에게 문의해줘.', ephemeral: true });
    return;
  }

  const member = interaction.member;
  const allJobRoleIds = Object.values(jobRoles);
  const mercenaryRoleId = jobRoles[MERCENARY_JOB];
  const rolesToRemove = allJobRoleIds.filter(roleId => member.roles.cache.has(roleId));

  if (rolesToRemove.length) {
    await member.roles.remove(rolesToRemove).catch(() => {});
  }

  if (mercenaryRoleId && rolesToRemove.includes(mercenaryRoleId)) {
    await setMercenaryNickname(member, false);
  }

  await interaction.reply({ content: '✅ 직업 역할이 초기화됐어.', ephemeral: true });
}

async function handleMercenaryReset(interaction) {
  const guildId = interaction.guildId;
  const jobRoles = JOB_ROLES[guildId];

  if (!jobRoles) {
    await interaction.reply({ content: '이 서버에는 용병패널 설정이 안 되어 있어. 관리자에게 문의해줘.', ephemeral: true });
    return;
  }

  const mercenaryRoleId = jobRoles[MERCENARY_JOB];
  if (!mercenaryRoleId) {
    await interaction.reply({ content: '이 서버에는 용병 역할이 설정 안 되어 있어.', ephemeral: true });
    return;
  }

  const member = interaction.member;
  if (member.roles.cache.has(mercenaryRoleId)) {
    await member.roles.remove(mercenaryRoleId).catch(() => {});
  }

  await setMercenaryNickname(member, false);

  await interaction.reply({ content: '✅ 용병 역할이 초기화됐어.', ephemeral: true });
}

const commands = [
  new SlashCommandBuilder()
    .setName('모집생성')
    .setDescription('공대 모집글 생성')
    .addStringOption(o => o.setName('보스').setDescription('예: 혼텔, 카텔, 핑빈, 카쿰').setRequired(true))
    .addStringOption(o => o.setName('날짜').setDescription('예: 6/24(수)').setRequired(true))
    .addStringOption(o => o.setName('시간').setDescription('예: 22시').setRequired(true))
    .addIntegerOption(o => o.setName('정원').setDescription('모집 기준 인원').setRequired(true)),

  new SlashCommandBuilder()
    .setName('공대분배정산')
    .setDescription('공대 분배금 정산 계산')
    .addStringOption(o => o.setName('경매장수령금액').setDescription('예: 135500000,86800000').setRequired(true))
    .addStringOption(o => o.setName('가위값').setDescription('예: 6000000 / 없으면 0').setRequired(true))
    .addIntegerOption(o => o.setName('인원수').setDescription('분배 전체 인원 (용병 포함)').setRequired(true))
    .addIntegerOption(o => o.setName('용병인원수').setDescription('전체 인원 중 용병 인원수 / 없으면 0').setRequired(false))
    .addNumberOption(o => o.setName('공대장보너스율').setDescription('용병 제외 금액 중 공대장 고생금 비율(%) / 없으면 0').setRequired(false))
    .addNumberOption(o => o.setName('뿌리기최저가').setDescription('뿌리기 아이템 경매장 최저가 / 없으면 0').setRequired(false))
    .addIntegerOption(o => o.setName('뿌리기사용갯수').setDescription('뿌리기 사용 갯수 / 없으면 0').setRequired(false))
    .addStringOption(o => o.setName('불의눈값').setDescription('자쿰 입장용 불의눈 구매 비용 / 없으면 0').setRequired(false)),

  new SlashCommandBuilder()
    .setName('상시공지설정')
    .setDescription('이 채널에 상시공지를 설정합니다')
    .addStringOption(o =>
      o.setName('내용')
        .setDescription('상시공지 내용')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('상시공지삭제')
    .setDescription('이 채널의 상시공지를 삭제합니다'),

  new SlashCommandBuilder()
    .setName('투표미참여')
    .setDescription('디스코드 투표(Poll)에 참여하지 않은 서버원 명단을 보여줍니다')
    .addStringOption(o =>
      o.setName('메시지링크')
        .setDescription('투표 메시지 우클릭 → 링크 복사 로 가져온 주소')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('거래방리셋')
    .setDescription('아이템 거래방 내역을 지금 바로 초기화합니다 (관리자 전용)'),

  new SlashCommandBuilder()
    .setName('채팅내역삭제')
    .setDescription('이 채널의 채팅 내역을 전부 삭제합니다 (관리자 전용)'),

  new SlashCommandBuilder()
    .setName('가입문의패널')
    .setDescription('이 채널에 가입문의 티켓 생성 버튼 패널을 올립니다 (관리자 전용)'),

  new SlashCommandBuilder()
    .setName('문의및상담패널')
    .setDescription('이 채널에 문의/상담 티켓 생성 버튼 패널을 올립니다 (관리자 전용)'),

  new SlashCommandBuilder()
    .setName('직업패널')
    .setDescription('이 채널에 직업 선택 버튼 패널을 올립니다 (관리자 전용)'),

  new SlashCommandBuilder()
    .setName('용병패널')
    .setDescription('이 채널에 용병 선택 버튼 패널을 올립니다 (관리자 전용)')
].map(c => c.toJSON());

client.once('ready', async () => {
  console.log(`${client.user.tag} 로그인 완료!`);
  if (!fs.existsSync(DATA_FILE)) saveData({ raids: {}, notices: {}, contribution: {}, resetState: {}, tickets: {} });

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  await rest.put(Routes.applicationCommands(client.user.id), { body: [] });

  for (const guildId of SERVER_IDS) {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guildId),
      { body: commands }
    );
  }

  console.log('모든 서버 명령어 등록 완료!');

  // 봇 시작 시 한 번 체크 (재시작 사이에 주기를 놓친 경우 대비), 이후 1시간마다 체크
  checkAndResetTradeChannel().catch(err => console.error('[거래방 리셋] 초기 체크 오류:', err));
  setInterval(() => {
    checkAndResetTradeChannel().catch(err => console.error('[거래방 리셋] 체크 오류:', err));
  }, RESET_CHECK_INTERVAL_MS);
});

client.on('messageCreate', async message => {
  try {
  if (!message.guild) return;
  if (message.author.id === client.user.id) return;
    const guildId = message.guild.id;
    const channelId = message.channel.id;

    const data = loadData();
    const notice = data.notices?.[guildId]?.[channelId];
    if (!notice) return;

    notice.count = (notice.count || 0) + 1;

    if (notice.count < NOTICE_REFRESH_COUNT) {
      data.notices[guildId][channelId] = notice;
      saveData(data);
      return;
    }

    data.notices[guildId][channelId] = notice;
    saveData(data);

    await repostNotice(guildId, channelId);
  } catch (error) {
    console.error('상시공지 재생성 오류:', error);
  }
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === '직업패널') {
        if (!interaction.member.permissions.has('Administrator')) {
          await interaction.reply({ content: '관리자만 사용할 수 있어.', ephemeral: true });
          return;
        }

        if (!JOB_ROLES[interaction.guildId]) {
          await interaction.reply({ content: '이 서버에는 직업패널 설정이 안 되어 있어.', ephemeral: true });
          return;
        }

        await interaction.channel.send({
          embeds: [makeJobPanelEmbed()],
          components: makeJobPanelButtons()
        });

        await interaction.reply({ content: '✅ 직업패널을 올렸어.', ephemeral: true });
        return;
      }

      if (interaction.commandName === '용병패널') {
        if (!interaction.member.permissions.has('Administrator')) {
          await interaction.reply({ content: '관리자만 사용할 수 있어.', ephemeral: true });
          return;
        }

        if (!JOB_ROLES[interaction.guildId]?.[MERCENARY_JOB]) {
          await interaction.reply({ content: '이 서버에는 용병패널 설정이 안 되어 있어.', ephemeral: true });
          return;
        }

        await interaction.channel.send({
          embeds: [makeMercenaryPanelEmbed()],
          components: makeMercenaryPanelButtons()
        });

        await interaction.reply({ content: '✅ 용병패널을 올렸어.', ephemeral: true });
        return;
      }

      if (interaction.commandName === '가입문의패널' || interaction.commandName === '문의및상담패널') {
        if (!interaction.member.permissions.has('Administrator')) {
          await interaction.reply({ content: '관리자만 사용할 수 있어.', ephemeral: true });
          return;
        }

        const type = interaction.commandName === '가입문의패널' ? 'join' : 'inquiry';

        await interaction.channel.send({
          embeds: [makeTicketPanelEmbed(type)],
          components: [makeTicketPanelButton(type)]
        });

        await interaction.reply({ content: `✅ ${TICKET_TYPES[type].label} 패널을 올렸어.`, ephemeral: true });
        return;
      }

      if (interaction.commandName === '거래방리셋') {
        if (!interaction.member.permissions.has('Administrator')) {
          await interaction.reply({ content: '관리자만 사용할 수 있어.', ephemeral: true });
          return;
        }

        await interaction.deferReply({ ephemeral: true });
        await resetTradeChannel();

        const data = loadData();
        data.resetState.tradeChannel = new Date().toISOString();
        saveData(data);

        await interaction.editReply('✅ 아이템 거래방을 초기화했어. 다음 자동 리셋 주기도 지금부터 다시 계산돼.');
        return;
      }

      if (interaction.commandName === '채팅내역삭제') {
        if (!interaction.member.permissions.has('Administrator')) {
          await interaction.reply({ content: '관리자만 사용할 수 있어.', ephemeral: true });
          return;
        }

        await interaction.deferReply({ ephemeral: true });

        const deletedCount = await purgeChannelMessages(interaction.channel);

        // 이 채널이 아이템 거래방이면 자동 리셋 주기도 지금부터 다시 계산
        if (interaction.channelId === TRADE_CHANNEL_ID) {
          const data = loadData();
          data.resetState.tradeChannel = new Date().toISOString();
          saveData(data);
        }

        await interaction.editReply(`✅ 이 채널의 채팅 내역 ${deletedCount}개를 삭제했어.`);
        return;
      }

      if (interaction.commandName === '상시공지설정') {
        const content = interaction.options.getString('내용');
        const guildId = interaction.guildId;
        const channelId = interaction.channelId;

        const data = loadData();
        if (!data.notices) data.notices = {};
        if (!data.notices[guildId]) data.notices[guildId] = {};

        const oldNotice = data.notices[guildId][channelId];

        if (oldNotice?.messageId) {
          const oldMsg = await interaction.channel.messages.fetch(oldNotice.messageId).catch(() => null);
          if (oldMsg) await oldMsg.delete().catch(() => {});
        }

       const embed = new EmbedBuilder()
  .setTitle('💗 공지 안 읽으면 머머리 💗')
  .setDescription(content)
  .setColor(0xff69b4);

const msg = await interaction.channel.send({ embeds: [embed] });
        data.notices[guildId][channelId] = {
          content,
          messageId: msg.id,
          count: 0
        };

        saveData(data);

        await interaction.reply({
          content: '✅ 이 채널 상시공지 설정 완료! 채팅 10개마다 다시 올라와.',
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '상시공지삭제') {
        const guildId = interaction.guildId;
        const channelId = interaction.channelId;

        const data = loadData();
        const notice = data.notices?.[guildId]?.[channelId];

        if (!notice) {
          await interaction.reply({
            content: '이 채널에는 설정된 상시공지가 없어.',
            ephemeral: true
          });
          return;
        }

        if (notice.messageId) {
          const oldMsg = await interaction.channel.messages.fetch(notice.messageId).catch(() => null);
          if (oldMsg) await oldMsg.delete().catch(() => {});
        }

        delete data.notices[guildId][channelId];
        saveData(data);

        await interaction.reply({
          content: '✅ 이 채널 상시공지 삭제 완료!',
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '공대분배정산') {
        const auctionAmounts = parseMoneyList(interaction.options.getString('경매장수령금액'));
        const scissorAmounts = parseMoneyList(interaction.options.getString('가위값'));
        const people = interaction.options.getInteger('인원수');
        const mercenaryCount = interaction.options.getInteger('용병인원수') || 0;
        const bonusRate = interaction.options.getNumber('공대장보너스율') || 0;
        const scatterPrice = interaction.options.getNumber('뿌리기최저가') || 0;
        const scatterCount = interaction.options.getInteger('뿌리기사용갯수') || 0;
        const eyeOfFireAmounts = parseMoneyList(interaction.options.getString('불의눈값'));

        if (mercenaryCount < 0 || mercenaryCount > people) {
          await interaction.reply({
            content: '용병인원수가 잘못됐어. 0 이상, 인원수 이하로 입력해줘.',
            ephemeral: true
          });
          return;
        }

        const regularCount = people - mercenaryCount;
        if (regularCount <= 0) {
          await interaction.reply({
            content: '고정공대원이 0명이야. 공대장 몫을 계산할 수 없어. 용병인원수를 확인해줘.',
            ephemeral: true
          });
          return;
        }

        const auctionTotal = auctionAmounts.reduce((a, b) => a + b, 0);
        const scissorTotal = scissorAmounts.reduce((a, b) => a + b, 0);
        const scatterTotal = Math.floor(scatterPrice * scatterCount);
        const eyeOfFireTotal = eyeOfFireAmounts.reduce((a, b) => a + b, 0);

        const totalPoolBeforeScatter = auctionTotal - scissorTotal - eyeOfFireTotal;
        const totalPool = totalPoolBeforeScatter - scatterTotal;

        // 1) 전체 인원 기준 1인분 = 용병 몫 (용병은 이 금액에서 택배비만 빠짐)
        const mercenaryShare = Math.floor(totalPool / people);
        const mercenaryTotalPaid = mercenaryShare * mercenaryCount;

        // 2) 용병 몫 제외한 나머지에서 공대장 고생금(보너스) 산출
        const remainingPool = totalPool - mercenaryTotalPaid;
        const leaderBonus = Math.floor(remainingPool * bonusRate / 100);
        const afterBonusPool = remainingPool - leaderBonus;

        // 3) 보너스 뗀 나머지를 고정공대원(공대장 포함) 인원수로 재분배
        const regularShare = Math.floor(afterBonusPool / regularCount);
        const otherRegularCount = regularCount - 1; // 공대장 제외 고정공대원
        const leaderTotal = regularShare + leaderBonus; // 공대장은 자기 몫이라 택배비 없음

        // 택배비: 몫 R에서 수수료(8%+1만)를 미리 뗀 금액을 분배장이 보내고, 받는사람은 그 금액을 받음
        const mercenaryFeePerSend = mercenaryCount > 0 ? getParcelFee(mercenaryShare) : 0;
        const mercenaryReceive = mercenaryShare - mercenaryFeePerSend;
        const mercenaryTotalFee = mercenaryFeePerSend * mercenaryCount;

        const regularFeePerSend = otherRegularCount > 0 ? getParcelFee(regularShare) : 0;
        const regularReceive = regularShare - regularFeePerSend;
        const regularTotalFee = regularFeePerSend * otherRegularCount;

        // 직거래(교환) 수수료 6% 버전 - 택배 대신 직거래로 줄 경우 수령액
        const mercenaryDirectFee = mercenaryCount > 0 ? getDirectTradeFee(mercenaryShare) : 0;
        const mercenaryDirectReceive = mercenaryShare - mercenaryDirectFee;

        const regularDirectFee = otherRegularCount > 0 ? getDirectTradeFee(regularShare) : 0;
        const regularDirectReceive = regularShare - regularDirectFee;

        const scatterLine = scatterCount > 0
          ? `뿌리기 비용 차감: -${formatMesos(scatterTotal)} 메소 (최저가 ${formatMesos(scatterPrice)} × ${scatterCount}개)\n`
          : '';

        const eyeOfFireLine = eyeOfFireTotal > 0
          ? `불의눈 구매 비용 차감: -${formatMesos(eyeOfFireTotal)} 메소\n`
          : '';

        const mercenaryLine = mercenaryCount > 0 && bonusRate > 0
          ? `\n👤 용병 (${mercenaryCount}명)\n` +
            `1인 기본 몫: ${formatMesos(mercenaryShare)} 메소\n` +
            `📦 택배(수수료 8%+1만): 수수료 ${formatMesos(mercenaryFeePerSend)} 제외 송금액 ${formatMesos(mercenaryReceive)} 메소\n` +
            `🤝 직거래(수수료 6% 받는사람 부담): 수수료 ${formatMesos(mercenaryDirectFee)} 제외 실수령 ${formatMesos(mercenaryDirectReceive)} 메소\n`
          : '';

        const bonusLine = bonusRate > 0
          ? `공대장 고생금(${bonusRate}%) 차감: -${formatMesos(leaderBonus)} 메소\n`
          : '';

        const leaderBonusText = bonusRate > 0 ? ` + 고생금 ${formatMesos(leaderBonus)} 메소` : '';

        const leaderSection = bonusRate > 0
          ? `👑 공대장\n` +
            `기본 몫: ${formatMesos(regularShare)} 메소${leaderBonusText}\n` +
            `실수령액: ${formatMesos(leaderTotal)} 메소 (본인 몫이라 택배비 없음)\n\n`
          : '';

        await interaction.reply(
          `💰 공대 분배 정산 결과\n\n` +
          `경매장 수령금액 합계: ${formatMesos(auctionTotal)} 메소\n` +
          `가위값 차감: -${formatMesos(scissorTotal)} 메소\n` +
          eyeOfFireLine +
          scatterLine +
          `\n총 정산금: ${formatMesos(totalPool)} 메소\n` +
          `전체 인원: ${people}명 (용병 ${mercenaryCount}명 / 고정 ${regularCount}명)\n` +
          mercenaryLine +
          (bonusRate > 0 ? `\n용병 몫 제외 금액: ${formatMesos(remainingPool)} 메소\n` : '') +
          bonusLine +
          `고정 재분배 금액: ${formatMesos(afterBonusPool)} 메소 ÷ ${regularCount}명\n\n` +
          leaderSection +
          `👥 고정공대원 (공대장 제외, ${otherRegularCount}명)\n` +
          `1인 기본 몫: ${formatMesos(regularShare)} 메소\n` +
          `📦 택배(수수료 8%+1만): 수수료 ${formatMesos(regularFeePerSend)} 제외 송금액 ${formatMesos(regularReceive)} 메소\n` +
          `🤝 직거래(수수료 6% 받는사람 부담): 수수료 ${formatMesos(regularDirectFee)} 제외 실수령 ${formatMesos(regularDirectReceive)} 메소`
        );
        return;
      }

      if (interaction.commandName === '투표미참여') {
        await interaction.deferReply({ ephemeral: true });

        const link = interaction.options.getString('메시지링크');
        const parsed = parseMessageLink(link);
        if (!parsed) {
          await interaction.editReply('메시지 링크 형식이 올바르지 않아. 투표 메시지 우클릭 → 링크 복사로 가져와줘.');
          return;
        }

        const channel = await client.channels.fetch(parsed.channelId).catch(() => null);
        if (!channel) {
          await interaction.editReply('그 채널을 찾을 수 없어. 봇이 채널을 볼 수 있는지 확인해줘.');
          return;
        }

        const pollMessage = await channel.messages.fetch(parsed.messageId).catch(() => null);
        if (!pollMessage) {
          await interaction.editReply('그 메시지를 찾을 수 없어.');
          return;
        }

        if (!pollMessage.poll) {
          await interaction.editReply('그 메시지에는 디스코드 투표(Poll)가 없어.');
          return;
        }

        const voterIds = await getAllPollVoters(pollMessage);

        const guild = interaction.guild;
        await guild.members.fetch();
        const allHumanMembers = guild.members.cache.filter(m => !m.user.bot);
        const nonVoters = allHumanMembers.filter(m => !voterIds.has(m.id));

        const totalCount = allHumanMembers.size;
        const votedCount = totalCount - nonVoters.size;

        const listText = nonVoters.size
          ? nonVoters.map(m => `- ${m.displayName} (${m.user.tag})`).join('\n')
          : '없음 (전원 투표 완료!)';

        const header =
          `📊 투표 참여 현황\n` +
          `전체 인원: ${totalCount}명 / 투표 참여: ${votedCount}명 / 미참여: ${nonVoters.size}명\n\n` +
          `미투표 인원 목록:\n`;

        const full = header + listText;

        if (full.length > 1900) {
          const buffer = Buffer.from(full, 'utf-8');
          await interaction.editReply({
            content: header + '(인원이 많아 파일로 첨부할게)',
            files: [{ attachment: buffer, name: '미투표_명단.txt' }]
          });
        } else {
          await interaction.editReply(full);
        }
        return;
      }

      if (interaction.commandName !== '모집생성') return;

      const raidId = `${Date.now()}`;
      const raid = {
        id: raidId,
        boss: interaction.options.getString('보스'),
        date: interaction.options.getString('날짜'),
        time: interaction.options.getString('시간'),
        limit: interaction.options.getInteger('정원'),
        messageId: null,
        channelId: interaction.channelId,
        createdBy: interaction.user.id,
        members: [],
        parties: {
          party1: [],
          party2: [],
          party3: []
        }
      };

      await interaction.reply({
        embeds: [makeEmbed(raid)],
        components: [makeButtons(raidId)]
      });

      const message = await interaction.fetchReply();
      raid.messageId = message.id;

      const data = loadData();
      data.raids[raidId] = raid;
      saveData(data);
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('job:')) {
        const job = interaction.customId.split(':')[1];
        await handleJobSelect(interaction, job);
        return;
      }

      if (interaction.customId === 'job_reset') {
        await handleJobReset(interaction);
        return;
      }

      if (interaction.customId === 'mercenary_reset') {
        await handleMercenaryReset(interaction);
        return;
      }

      if (interaction.customId.startsWith('create_ticket:')) {
        const type = interaction.customId.split(':')[1];
        await handleCreateTicket(interaction, type);
        return;
      }

      if (interaction.customId === 'close_ticket') {
        await handleCloseTicket(interaction);
        return;
      }

      const [action, raidId] = interaction.customId.split(':');
      const data = loadData();

      let raid = data.raids[raidId];

      if (!raid) {
        raid = restoreRaidFromMessage(interaction, raidId);
        if (!raid) {
          await interaction.reply({ content: '모집글 정보를 찾을 수 없어. 다시 생성해줘.', ephemeral: true });
          return;
        }
        data.raids[raidId] = raid;
        saveData(data);
      }

      if (action === 'join') {
        const modal = new ModalBuilder()
          .setCustomId(`modal_join:${raidId}`)
          .setTitle(`${raid.boss} 참여신청`);

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('nickname').setLabel('닉네임').setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('job').setLabel('직업').setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('level').setLabel('레벨').setStyle(TextInputStyle.Short).setRequired(true)
          )
        );

        await interaction.showModal(modal);
        return;
      }

      if (action === 'cancel') {
        const index = raid.members.findIndex(m => m.userId === interaction.user.id);
        if (index === -1) {
          await interaction.reply({ content: '신청 내역이 없어.', ephemeral: true });
          return;
        }

        raid.members.splice(index, 1);
        data.raids[raidId] = raid;
        saveData(data);

        await interaction.message.edit({ embeds: [makeEmbed(raid)], components: [makeButtons(raidId)] });
        await interaction.reply({ content: '✅ 신청 취소 완료', ephemeral: true });
        return;
      }

      if (action === 'list') {
        const list = raid.members.length
          ? raid.members.map((m, i) => `${i + 1}. ${m.nickname} / ${m.job} / ${m.level}`).join('\n')
          : '아직 신청자가 없습니다.';

        await interaction.reply({
          content: `📋 ${raid.boss} 신청 명단\n\n${list}\n\n총 ${raid.members.length}명`,
          ephemeral: true
        });
        return;
      }

      if (action === 'party') {
        if (interaction.user.id !== raid.createdBy && raid.createdBy !== '') {
          await interaction.reply({
            content: '공대장만 사용할 수 있어.',
            ephemeral: true
          });
          return;
        }

        if (!raid.members.length) {
          await interaction.reply({
            content: '아직 신청자가 없어서 공대편성을 할 수 없어.',
            ephemeral: true
          });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId(`party_modal:${raidId}`)
          .setTitle(`${raid.boss} 공대편성`);

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('party1')
              .setLabel('1공대 닉네임, 쉼표로 구분')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('party2')
              .setLabel('2공대 닉네임, 쉼표로 구분')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('party3')
              .setLabel('3공대 닉네임, 쉼표로 구분')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
          )
        );

        await interaction.showModal(modal);
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      const [action, raidId] = interaction.customId.split(':');

      if (action === 'party_modal') {
        const data = loadData();
        const raid = data.raids[raidId];

        if (!raid) {
          await interaction.reply({
            content: '모집글 정보를 찾을 수 없어. 다시 생성해줘.',
            ephemeral: true
          });
          return;
        }

        const party1 = pickMembersByName(raid, parseNames(interaction.fields.getTextInputValue('party1')));
        const party2 = pickMembersByName(raid, parseNames(interaction.fields.getTextInputValue('party2')));
        const party3 = pickMembersByName(raid, parseNames(interaction.fields.getTextInputValue('party3')));
        const allPartyMembers = [...party1, ...party2, ...party3];

        if (!data.contribution) data.contribution = {};

        for (const m of allPartyMembers) {
          if (!data.contribution[m.nickname]) {
            data.contribution[m.nickname] = {
              count: 0,
              job: m.job,
              level: m.level
            };
          }

          data.contribution[m.nickname].count += 1;
          data.contribution[m.nickname].job = m.job;
          data.contribution[m.nickname].level = m.level;
        }

       raid.parties = raid.parties || { party1: [], party2: [], party3: [] };

raid.parties = raid.parties || { party1: [], party2: [], party3: [] };

if (party1.length) raid.parties.party1 = party1;
if (party2.length) raid.parties.party2 = party2;
if (party3.length) raid.parties.party3 = party3;

data.raids[raidId] = raid;
saveData(data);

await interaction.reply({
  content:
`📢 ${raid.boss} ${raid.date} ${raid.time} 공대 편성 결과

${partyText('🟥 1공대', raid.parties.party1)}

${partyText('🟦 2공대', raid.parties.party2)}

${partyText('🟩 3공대', raid.parties.party3)}`,
  ephemeral: false
});
        return;
      }

      if (action !== 'modal_join') return;

      const data = loadData();
      const raid = data.raids[raidId];

      if (!raid) {
        await interaction.reply({ content: '모집글 정보를 찾을 수 없어. 다시 생성해줘.', ephemeral: true });
        return;
      }

    const isAdmin = interaction.member.permissions.has('Administrator');

const existing = raid.members.find(
  m => m.userId === interaction.user.id
);

if (existing && !isAdmin) {
  await interaction.reply({
    content: `이미 신청되어 있어.\n${existing.nickname} / ${existing.job} / ${existing.level}`,
    ephemeral: true
  });
  return;
}

      const nickname = interaction.fields.getTextInputValue('nickname');
      const job = interaction.fields.getTextInputValue('job');
      const level = interaction.fields.getTextInputValue('level');

      raid.members.push({ userId: interaction.user.id, nickname, job, level });
      data.raids[raidId] = raid;
      saveData(data);

      const channel = await client.channels.fetch(raid.channelId);
      const msg = await channel.messages.fetch(raid.messageId);

      await msg.edit({ embeds: [makeEmbed(raid)], components: [makeButtons(raidId)] });

      await interaction.reply({
        content: `✅ 신청 완료\n${nickname} / ${job} / ${level}`,
        ephemeral: true
          });
    }
  } catch (error) {
    console.error('interactionCreate 오류:', error);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('오류가 발생했어. Railway 로그 확인 필요!');
      } else {
        await interaction.reply({ content: '오류가 발생했어. Railway 로그 확인 필요!', ephemeral: true });
      }
    } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ 디스코드 로그인 실패:', err);
});
