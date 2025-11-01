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
    } catch (e) {
        console.error('Erro ao ler schedules.json:', e);
        return [];
    }
}

function saveSchedules(arr) {
    try {
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(arr, null, 2), 'utf8');
    } catch (e) {
        console.error('Erro ao salvar schedules.json:', e);
    }
}

function loadBosses() {
    if (!fs.existsSync(BOSSES_FILE)) return [];
    try {
        const raw = JSON.parse(fs.readFileSync(BOSSES_FILE, 'utf8'));
        return raw.map(b => ({
            key: (b.nome || b.name || b.id || b.key || '').toString().toLowerCase(),
            titulo: b.titulo || b.title || b.nome || b.name || null,
            imagem: b.imagem || b.image || b.img || b.picture || null,
            id: b.id || null,
            raw: b
        }));
    } catch (e) {
        console.error('Erro ao ler bosses.json:', e);
        return [];
    }
}

function timeToCronExpression(time) {
    const [hh, mm] = time.split(':').map(Number);
    if (isNaN(hh) || isNaN(mm)) return null;
    // node-cron: second minute hour day month weekday
    return `0 ${mm} ${hh} * * *`;
}

let scheduledTasks = [];
function clearScheduledTasks() {
    scheduledTasks.forEach(t => {
        try { t.stop(); } catch (e) { /* ignore */ }
    });
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
                    const roleMention = s.roleId ? `<@&${s.roleId}>` : '';

                    console.log(`[CRON] Disparando ${s.time} -> ${s.message}`);

                    // tenta garantir que temos imagem: se não tiver, tenta recarregar bosses.json pelo boss salvo
                    let imageToUse = s.image || null;
                    if (!imageToUse && s.boss) {
                        try {
                            const bossesNow = loadBosses();
                            const b = bossesNow.find(x =>
                                (x.titulo && x.titulo.toLowerCase() === (s.boss || '').toLowerCase()) ||
                                x.key === (s.boss || '').toLowerCase()
                            );
                            if (b && b.imagem) imageToUse = b.imagem;
                        } catch (e) {
                            console.error('Erro ao tentar recarregar bosses para imagem:', e);
                        }
                    }

                    if (imageToUse) {
                        const embed = new EmbedBuilder()
                            .setColor(0x00aeff)
                            .setTitle('⚔️ Boss Spawn Imminente!')
                            .setDescription(s.message)
                            .setImage(imageToUse)
                            .setTimestamp();

                        await channel.send({ content: roleMention, embeds: [embed] });
                    } else {
                        await channel.send(`${roleMention} ${s.message}`);
                    }

                    // Após executar, remover este agendamento para que ocorra apenas uma vez
                    try {
                        let schedulesList = loadSchedules();
                        schedulesList = schedulesList.filter(x => x.id !== s.id);
                        saveSchedules(schedulesList);
                        try { task.stop(); } catch (e) { console.error('Erro ao parar task:', e); }
                        console.log(`Agendamento ${s.id} removido após execução.`);
                    } catch (err2) {
                        console.error('Erro ao remover agendamento após execução:', err2);
                    }

                } catch (err) {
                    // Catch principal do callback do cron
                    console.error('Erro ao enviar mensagem (cron):', err);
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
    try {
        if (message.author.bot || !message.guild) return;

        const isAdmin =
            (message.member && (message.member.permissions.has('Administrator') || message.member.permissions.has('ManageGuild')));
        if (!isAdmin) return;

        const content = message.content.trim();

        // ---- !agenda HH:MM #canal @role nome_do_boss [mensagem opcional]
        if (content.startsWith('!agenda ')) {
            const parts = content.split(/\s+/); // separa por espaços (1 ou mais)
            const time = parts[1];

            if (!time || !/^\d{2}:\d{2}$/.test(time)) {
                return message.reply('Uso: `!agenda HH:MM #canal @role nome_do_boss [mensagem opcional]` (hora inválida)');
            }

            // tenta extrair canal e role por mentions (preferência)
            const mentionedChannel = message.mentions.channels.first();
            const mentionedRole = message.mentions.roles.first();

            // tentativa de obter ids a partir das partes (se não houver mention)
            const possibleChannel = mentionedChannel ? mentionedChannel.id : (parts[2] && parts[2].replace(/[^0-9]/g, '')) || null;
            const possibleRole = mentionedRole ? mentionedRole.id : (parts[3] && parts[3].replace(/[^0-9]/g, '')) || null;

            // agora precisamos encontrar o bossKey: primeiro token que NÃO é menção/ID do canal nem role
            let bossKey = null;
            let bossIndex = -1;
            for (let i = 2; i < parts.length; i++) {
                const tok = parts[i];

                // ignora tokens que sejam menções de canal (#<id> ou <#id>) ou menções de role (<@&id>) ou ids puros
                if (/^<#[0-9]+>$/.test(tok) || /^#/.test(tok)) continue;
                if (/^<@&[0-9]+>$/.test(tok) || /^@/.test(tok)) continue;
                if (/^[0-9]{17,19}$/.test(tok)) {
                    // pode ser um id puro — se for igual ao canal/role, pula
                    if (tok === possibleChannel || tok === possibleRole) continue;
                }
                // Se chegou aqui, é o bossKey
                bossKey = tok;
                bossIndex = i;
                break;
            }

            if (!bossKey) {
                return message.reply('Não consegui encontrar o nome do boss. Uso: `!agenda HH:MM #canal @role nome_do_boss [mensagem opcional]`');
            }

            // o texto extra é tudo depois do bossIndex
            const extraText = parts.slice(bossIndex + 1).join(' ');

            // resolve canalId e roleId definitivos (prioriza mentions)
            const channelId = mentionedChannel ? mentionedChannel.id : (possibleChannel || null);
            const roleId = mentionedRole ? mentionedRole.id : (possibleRole || null);

            if (!channelId || !roleId) {
                return message.reply('Canal ou Role inválidos. Marque um canal e uma role ou use ids válidos.');
            }

            // carrega bosses normalizados
            const bosses = loadBosses();
            const boss = bosses.find(b =>
                b.key === bossKey.toString().toLowerCase() ||
                (b.id && b.id.toString().toLowerCase() === bossKey.toString().toLowerCase()) ||
                (b.titulo && b.titulo.toString().toLowerCase() === bossKey.toString().toLowerCase())
            );

            let msgText;
            let imageUrl = null;
            const bossSaved = boss ? (boss.titulo || boss.key) : bossKey;

            if (boss) {
                msgText = `${extraText ? extraText + '\n' : ''}A preparação para o boss **${bossSaved}** vai terminar em 10 minutos!`;
                imageUrl = boss.imagem || null;
            } else {
                msgText = extraText || `Mensagem agendada (${bossKey})`;
            }

            // salva schedule
            const schedules = loadSchedules();
            const id = Date.now().toString();
            schedules.push({
                id,
                time,
                channelId,
                roleId,
                boss: bossSaved,
                message: msgText,
                image: imageUrl
            });
            saveSchedules(schedules);
            scheduleAll(client);
            message.reply(`Agenda criada: ${time} -> <#${channelId}> <@&${roleId}> (id: ${id})`);
            return;
        }

        // ---- !lista
        if (content === '!lista') {
            const schedules = loadSchedules();
            if (!schedules.length) {
                message.reply('Nenhuma agenda cadastrada.');
                return;
            }
            const lines = schedules.map(s => {
                const bossText = s.boss ? `Boss: ${s.boss}` : 'Boss: (não informado)';
                const msgText = s.message ? `Mensagem: ${s.message}` : 'Mensagem: (vazia)';
                return `ID:${s.id} - ${s.time} - ${bossText} - ${msgText} - Canal: <#${s.channelId}> - Role: <@&${s.roleId}>`;
            });
            for (let i = 0; i < lines.length; i += 10) {
                await message.channel.send(lines.slice(i, i + 10).join('\n'));
            }
            return;
        }

        // ---- !remover ID
        if (content.startsWith('!remover ')) {
            const id = content.split(' ')[1];
            if (!id) {
                message.reply('Coloque o ID: `!remover ID`');
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

        // ---- !limpar (apaga todos os alarmes)
        if (content === '!limpar') {
            const schedules = loadSchedules();
            if (!schedules.length) {
                message.reply('Nenhum alarme existente para apagar.');
                return;
            }
            saveSchedules([]);
            clearScheduledTasks();
            message.reply(`🧹 Todos os ${schedules.length} alarmes foram apagados com sucesso!`);
            console.log('Todos os alarmes foram apagados manualmente.');
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
                const roleMention = s.roleId ? `<@&${s.roleId}>` : '';

                // tenta obter imagem dinamicamente caso não exista em s.image
                let imageToUse = s.image || null;
                if (!imageToUse && s.boss) {
                    try {
                        const bossesNow = loadBosses();
                        const b = bossesNow.find(x =>
                            (x.titulo && x.titulo.toLowerCase() === (s.boss || '').toLowerCase()) ||
                            x.key === (s.boss || '').toLowerCase()
                        );
                        if (b && b.imagem) imageToUse = b.imagem;
                    } catch (e) {
                        console.error('Erro ao recarregar bosses para run:', e);
                    }
                }

                if (imageToUse) {
                    const embed = new EmbedBuilder()
                        .setColor(0x00aeff)
                        .setTitle('⚔️ Boss Spawn Imminente!')
                        .setDescription(s.message)
                        .setImage(imageToUse)
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

        // ---- !debug
        if (content === '!debug') {
            const schedules = loadSchedules();
            message.reply(`TIMEZONE=${TIMEZONE}\nSchedules carregados: ${schedules.length}`);
            console.log('Schedules:', schedules);
            return;
        }
    } catch (outerErr) {
        console.error('Erro no handler messageCreate:', outerErr);
    }
});

// ===== Login =====
client.login(process.env.DISCORD_TOKEN).catch(e => {
    console.error('Erro ao logar cliente Discord:', e);
});
