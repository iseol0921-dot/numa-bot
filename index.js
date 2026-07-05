import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder
} from 'discord.js';
import fs from 'fs';

const SERVER_IDS = [
  '1519109990101815386',
  '1506990201204117565'
];

const DATA_FILE = './data.json';
const NOTICE_REFRESH_COUNT = 5;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { raids: {}, notices: {}, contribution: {} };
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!data.raids) data.raids = {};
    if (!data.notices) data.notices = {};
    if (!data.contribution) data.contribution = {};
    return data;
  } catch {
    return { raids: {}, notices: {}, contribution: {} };
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

function getParcelFee(amount) {
  return 10000 + Math.floor(amount * 0.04);
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
    .addStringOption(o => o.setName('공대원구매금액').setDescription('예: 100000000 / 없으면 0').setRequired(true))
    .addNumberOption(o => o.setName('공대원할인율').setDescription('예: 10 / 없으면 0').setRequired(true))
    .addIntegerOption(o => o.setName('인원수').setDescription('분배 인원').setRequired(true))
    .addNumberOption(o => o.setName('뿌리기최저가').setDescription('뿌리기 아이템 경매장 최저가 / 없으면 0').setRequired(false))
    .addIntegerOption(o => o.setName('뿌리기사용갯수').setDescription('뿌리기 사용 갯수 / 없으면 0').setRequired(false)),

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
    .setDescription('이 채널의 상시공지를 삭제합니다')
].map(c => c.toJSON());

client.once('ready', async () => {
  console.log(`${client.user.tag} 로그인 완료!`);
  if (!fs.existsSync(DATA_FILE)) saveData({ raids: {}, notices: {}, contribution: {} });

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  await rest.put(Routes.applicationCommands(client.user.id), { body: [] });

  for (const guildId of SERVER_IDS) {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guildId),
      { body: commands }
    );
  }

  console.log('모든 서버 명령어 등록 완료!');
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
        const buyerAmounts = parseMoneyList(interaction.options.getString('공대원구매금액'));
        const discount = interaction.options.getNumber('공대원할인율');
        const people = interaction.options.getInteger('인원수');
        const scatterPrice = interaction.options.getNumber('뿌리기최저가') || 0;
        const scatterCount = interaction.options.getInteger('뿌리기사용갯수') || 0;

        const auctionTotal = auctionAmounts.reduce((a, b) => a + b, 0);
        const scissorTotal = scissorAmounts.reduce((a, b) => a + b, 0);
        const buyerRawTotal = buyerAmounts.reduce((a, b) => a + b, 0);
        const buyerFinalTotal = Math.floor(buyerRawTotal * (100 - discount) / 100);
        const scatterTotal = Math.floor(scatterPrice * scatterCount);

        const totalPoolBeforeScatter = auctionTotal - scissorTotal + buyerFinalTotal;
        const totalPool = totalPoolBeforeScatter - scatterTotal;
        const perPersonShare = Math.floor(totalPool / people);
        const sendCount = people - 1;
        const parcelFeePerSend = getParcelFee(perPersonShare);
        const totalParcelFee = parcelFeePerSend * sendCount;
        const totalSendBudget = perPersonShare * sendCount;
        const receivePerMember = sendCount > 0
          ? Math.floor((totalSendBudget - totalParcelFee) / sendCount)
          : 0;

        const scatterLine = scatterCount > 0
          ? `뿌리기 비용 차감: -${formatMesos(scatterTotal)} 메소 (최저가 ${formatMesos(scatterPrice)} × ${scatterCount}개)\n`
          : '';

        await interaction.reply(
          `💰 공대 분배 정산 결과\n\n` +
          `경매장 수령금액 합계: ${formatMesos(auctionTotal)} 메소\n` +
          `가위값 차감: -${formatMesos(scissorTotal)} 메소\n` +
          `공대원 구매금액: ${formatMesos(buyerRawTotal)} 메소\n` +
          `공대원 할인율: ${discount}%\n` +
          `할인 적용 구매금액: ${formatMesos(buyerFinalTotal)} 메소\n` +
          scatterLine +
          `\n총 정산금: ${formatMesos(totalPool)} 메소\n` +
          `분배 인원: ${people}명\n\n` +
          `1인당 분배금: ${formatMesos(perPersonShare)} 메소\n` +
          `택배 발송 대상: ${sendCount}명\n` +
          `1회 택배비: ${formatMesos(parcelFeePerSend)} 메소\n` +
          `총 택배비: ${formatMesos(totalParcelFee)} 메소\n` +
          `실수령액: ${formatMesos(receivePerMember)} 메소`
        );
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
  

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('오류가 발생했어. Railway 로그 확인 필요!');
      } else {
        await interaction.reply({ content: '오류가 발생했어. Railway 로그 확인 필요!', ephemeral: true });
      }
    } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN);
