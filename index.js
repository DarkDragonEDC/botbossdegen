// index.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const cron = require('node-cron');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
});

const SCHEDULE_FILE = path.join(__dirname, 'schedules.json');
const BOSSES_FILE = path.join(__dirname, 'bosses.json');
const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';

// ===== Funções de utilidade =====
function loadSchedules() {
    if (!fs.existsSync(SCHEDULE_FILE)) fs.writeFileSync(SCHEDULE_FILE, '[]', 'utf8');
    try {
        return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function saveSchedules(arr) {
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

function timeToCronExpression(time) {
    const [hh, mm] = time.split(':').map(Number);
    if (isNaN(hh) || isNaN(mm)) return null;
    return `0 ${mm} ${hh} * * *`;
}

let scheduledTasks = [];
function clearScheduledTasks() {
    scheduledTasks.forEach(t => t.stop());
    scheduledTasks = [];
}

function scheduleAll(client) {
    clearScheduledTasks();
    const schedules = loadSchedules();
    schedules.forEach(s => {
        const expr = timeToCronExpression(s.time);
        if (!expr) return;

        const task = cron.schedule(
            expr,
            async () => {
                try {
                    const channel = await client.channels.fetch(s.channelId).catch(() => null);
                    if (!channel) return;
                    const roleMention = `<@&${s.roleId}>`;

                    console.log(`[CRON] Disparando ${s.time} -> ${s.message}`);

                    // envia com embed se tiver imagem
                    if (s.image) {
                        const embed = new EmbedBuilder()
                            .setColor(0x00aeff)
                            .setTitle('⚔️ Boss Spawn Imminente!')
                            .setDescription(s.message)
                            .setImage(s.image)
                            .setTimestamp();

                        await channel.send({ content: roleMention, embeds: [embed] });
                    } else {
                        await channel.send(`${roleMention} ${s.message}`);
                    }
                } catch (err) {
                    console.error('Erro ao enviar mensagem:', err);
                }
            },
            { timezone: TIMEZONE }
        );

        scheduledTasks.push(task);
        console.log(`Agendado: ${s.time} -> canal ${s.channelId} role ${s.roleId}`);
    });
}

// ===== Eventos =====
client.once('ready', () => {
    console.log(`Bot pronto: ${client.user.tag}`);
    scheduleAll(client);
});

client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;

    const isAdmin =
        message.member.permissions.has('Administrator') ||
        message.member.permissions.has('ManageGuild');
    if (!isAdmin) return;

    const content = message.content.trim();

    // ---- !agenda HH:MM #canal @role nome_do_boss [mensagem opcional]
    if (content.startsWith('!agenda ')) {
        const parts = content.split(' ');
        const time = parts[1];
        const channelMention = (message.mentions.channels.first() || {}).id || parts[2];
        const roleMention = (message.mentions.roles.first() || {}).id || parts[3];
        const bossKey = parts[4] ? parts[4].toLowerCase() : null;
        const extraText = parts.slice(5).join(' ');

        if (!time || !channelMention || !roleMention || !bossKey) {
            message.reply('Uso: `!agenda HH:MM #canal @role nome_do_boss [mensagem opcional]`');
            return;
        }
        if (!/^\d{2}:\d{2}$/.test(time)) {
            message.reply('Hora inválida. Use HH:MM');
            return;
        }

        // tenta carregar boss
        let bosses = [];
        if (fs.existsSync(BOSSES_FILE)) {
            bosses = JSON.parse(fs.readFileSync(BOSSES_FILE, 'utf8'));
        }
        const boss = bosses.find(b => b.nome.toLowerCase() === bossKey);

        let msgText;
        let imageUrl = null;

        if (boss) {
            msgText = `${extraText ? extraText + '\n' : ''}A preparação para o boss **${boss.titulo}** vai terminar em 10 minutos!`;
            imageUrl = boss.imagem;
        } else {
            msgText = extraText || `Mensagem agendada (${bossKey})`;
        }

        const schedules = loadSchedules();
        const id = Date.now().toString();
        schedules.push({
            id,
            time,
            channelId: channelMention,
            roleId: roleMention,
            message: msgText,
            image: imageUrl
        });
        saveSchedules(schedules);
        scheduleAll(client);
        message.reply(`Agenda criada: ${time} -> <#${channelMention}> <@&${roleMention}> (id: ${id})`);
        return;
    }

    // ---- !listaschedules
    if (content === '!listaschedules') {
        const schedules = loadSchedules();
        if (!schedules.length) {
            message.reply('Nenhuma agenda cadastrada.');
            return;
        }
        const lines = schedules.map(
            s => `ID:${s.id} - ${s.time} - <#${s.channelId}> - <@&${s.roleId}>`
        );
        for (let i = 0; i < lines.length; i += 10) {
            await message.channel.send(lines.slice(i, i + 10).join('\n'));
        }
        return;
    }

    // ---- !removeschedule ID
    if (content.startsWith('!removeschedule ')) {
        const id = content.split(' ')[1];
        if (!id) {
            message.reply('Coloque o ID: `!removeschedule ID`');
            return;
        }
        let schedules = loadSchedules();
        const before = schedules.length;
        schedules = schedules.filter(s => s.id !== id);
        if (schedules.length === before) {
            message.reply('ID não encontrado.');
            return;
        }
        saveSchedules(schedules);
        scheduleAll(client);
        message.reply('Agenda removida: ' + id);
        return;
    }

    // ---- !run ID (força envio)
    if (content.startsWith('!run ')) {
        const id = content.split(' ')[1];
        if (!id) {
            message.reply('Uso: !run ID');
            return;
        }
        const schedules = loadSchedules();
        const s = schedules.find(x => x.id === id);
        if (!s) {
            message.reply('ID não encontrado');
            return;
        }
        try {
            const channel = await client.channels.fetch(s.channelId).catch(() => null);
            if (!channel) {
                message.reply('Canal não encontrado');
                return;
            }
            const roleMention = `<@&${s.roleId}>`;
            if (s.image) {
                const embed = new EmbedBuilder()
                    .setColor(0x00aeff)
                    .setTitle('⚔️ Boss Spawn Imminente!')
                    .setDescription(s.message)
                    .setImage(s.image)
                    .setTimestamp();
                await channel.send({ content: roleMention, embeds: [embed] });
            } else {
                await channel.send(`${roleMention} ${s.message}`);
            }
            message.reply('Mensagem enviada.');
        } catch (err) {
            console.error(err);
            message.reply('Erro ao enviar, veja logs.');
        }
        return;
    }

    // ---- !debugschedules
    if (content === '!debugschedules') {
        const schedules = loadSchedules();
        message.reply(`TIMEZONE=${TIMEZONE}\nSchedules carregados: ${schedules.length}`);
        console.log('Schedules:', schedules);
        return;
    }
});

// ===== Login =====
client.login(process.env.DISCORD_TOKEN);
