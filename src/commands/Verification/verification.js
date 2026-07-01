import { botConfig, getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { createEmbed, infoEmbed, successEmbed } from '../../utils/embeds.js';
import { getGuildConfig, setGuildConfig } from '../../services/guildConfig.js';
import { handleInteractionError, withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { removeVerification, verifyUser } from '../../services/verificationService.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getWelcomeConfig } from '../../utils/database.js';
import verificationDashboard from './modules/verification_dashboard.js';

export default {
    data: new SlashCommandBuilder()
        .setName("weryfikacja")
        .setDescription("Zarządzaj systemem weryfikacji serwera")
        .addSubcommand(subcommand =>
            subcommand
                .setName("konfiguracja")
                .setDescription("Ustaw weryfikacje serwera")
                .addChannelOption(option =>
                    option
                        .setName("verification_channel")
                        .setDescription("Kanał gdzie będzie system weryfikacji")
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true)
                )
                .addRoleOption(option =>
                    option
                        .setName("verified_role")
                        .setDescription("Rola, jaką należy przyznać zweryfikowanym użytkownikom")
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName("message")
                        .setDescription("Customowa wiadomość weryfikacji")
                        .setMaxLength(2000)
                        .setRequired(false)
                )
                .addStringOption(option =>
                    option
                        .setName("button_text")
                        .setDescription("Tekst przycisku weryfikacji")
                        .setMaxLength(80)
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("usuń")
                .setDescription("Usuń weryfikację z użytkownika")
                .addUserOption(option =>
                    option
                        .setName("user")
                        .setDescription("Użytkownik, z którego ma usunąć weryfikację")
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("dashboard")
                .setDescription("Otwórz dashboard konfiguracji systemu weryfikacji")
        ),

    async execute(interaction, config, client) {
        const wrappedExecute = withErrorHandling(async () => {
            const subcommand = interaction.options.getSubcommand();
            const guild = interaction.guild;

            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                throw createError(
                    'Missing ManageGuild permission for verification admin subcommand',
                    ErrorTypes.PERMISSION,
                    'Aby korzystać z tego podpolecenia weryfikacyjnego, potrzebujesz uprawnienia **Zarządzaj serwerem**.',
                    { subcommand, requiredPermission: 'ManageGuild', userId: interaction.user.id }
                );
            }

            switch (subcommand) {
                case "setup":
                    return await handleSetup(interaction, guild, client);
                case "remove":
                    return await handleRemove(interaction, guild, client);
                case "dashboard":
                    return await verificationDashboard.execute(interaction, config, client);
                default:
                    throw createError(
                        `Nieznane podpolecenie: ${subcommand}`,
                        ErrorTypes.VALIDATION,
                        "Proszę wybrać prawidłowe podpolecenie.",
                        { subcommand }
                    );
            }
        }, { command: 'weryfikacja', subcommand: interaction.options.getSubcommand() });

        return await wrappedExecute(interaction, config, client);
    }
};

async function handleSetup(interaction, guild, client) {
    const verificationChannel = interaction.options.getChannel("verification_channel");
    const verifiedRole = interaction.options.getRole("verified_role");
    const message = interaction.options.getString("message") || botConfig.verification.defaultMessage;
    const buttonText = interaction.options.getString("button_text") || botConfig.verification.defaultButtonText;
    const botMember = guild.members.me;

    if (!botMember) {
        throw createError(
            'Bot member not found in guild cache',
            ErrorTypes.CONFIGURATION,
            'Nie mogłem zweryfikować swoich uprawnień na tym serwerze. Proszę spróbować jeszcze raz za chwilę.',
            { guildId: guild.id }
        );
    }

    const requiredChannelPermissions = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks
    ];
    const missingChannelPerms = requiredChannelPermissions.filter(perm => 
        !verificationChannel.permissionsFor(botMember).has(perm)
    );
    
    if (missingChannelPerms.length > 0) {
        throw createError(
            `Missing channel permissions: ${missingChannelPerms.join(', ')}`,
            ErrorTypes.PERMISSION,
            'I need **View Channel**, **Send Messages**, and **Embed Links** in the verification channel.',
            { missingPermissions: missingChannelPerms, channel: verificationChannel.id }
        );
    }

    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        throw createError(
            "Missing ManageRoles permission",
            ErrorTypes.PERMISSION,
            "Potrzebuję uprawnienia „Zarządzaj rolami”, aby nadać zweryfikowane role.",
            { missingPermission: "ManageRoles" }
        );
    }

    if (verifiedRole.id === guild.id || verifiedRole.managed) {
        throw createError(
            'Wybrano nieprawidłową zweryfikowaną rolę',
            ErrorTypes.VALIDATION,
            'Prosze wybrac inna role (nie @everyone).',
            { roleId: verifiedRole.id, managed: verifiedRole.managed }
        );
    }

    const botRole = botMember.roles.highest;
    if (verifiedRole.position >= botRole.position) {
        throw createError(
            "Role hierarchy error",
            ErrorTypes.PERMISSION,
            "Zweryfikowana rola musi być niższa od mojej najwyższej roli w hierarchii .",
            { rolePosition: verifiedRole.position, botRolePosition: botRole.position }
        );
    }

    const guildConfig = await getGuildConfig(client, guild.id);
    const welcomeConfig = await getWelcomeConfig(client, guild.id);
    const hasAutoVerifyEnabled = Boolean(guildConfig.verification?.autoVerify?.enabled);
    const hasAutoRoleConfigured = Boolean(guildConfig.autoRole) || (Array.isArray(welcomeConfig.roleIds) && welcomeConfig.roleIds.length > 0);

    if (hasAutoVerifyEnabled || hasAutoRoleConfigured) {
        throw createError(
            'Konfiguracja weryfikacji zablokowana przez konfliktowy system wdrażania',
            ErrorTypes.CONFIGURATION,
            'Nie można włączyć systemu weryfikacji, gdy **AutoVerify** lub **AutoRole** jest skonfigurowany. Wyłącz je jako pierwsze.',
            {
                guildId: guild.id,
                hasAutoVerifyEnabled,
                hasAutoRoleConfigured,
                expected: true,
                suppressErrorLog: true
            }
        );
    }

    await InteractionHelper.safeDefer(interaction);

    const verifyEmbed = createEmbed({
        title: "Weryfikacja",
        description: message,
        color: getColor('success')
    });

    const verifyButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("verify_user")
            .setLabel(buttonText)
            .setStyle(ButtonStyle.Success)
            .setEmoji("✅")
    );

    const verifyMessage = await verificationChannel.send({
        embeds: [verifyEmbed],
        components: [verifyButton]
    });

    guildConfig.verification = {
        enabled: true,
        channelId: verificationChannel.id,
        messageId: verifyMessage.id,
        roleId: verifiedRole.id,
        message: message,
        buttonText: buttonText
    };

    await setGuildConfig(client, guild.id, guildConfig);

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(
            'system weryfikacji zaaktualizowano',
            [
                `Channel: ${verificationChannel}`,
                `Verified Role: ${verifiedRole}`,
                `Button Text: ${buttonText}`
            ].join('\n')
        )]
    });
}

async function handleRemove(interaction, guild, client) {
    const targetUser = interaction.options.getUser("user");
    
    try {
        const result = await removeVerification(client, guild.id, targetUser.id, {
            moderatorId: interaction.user.id,
            reason: 'admin_removal'
        });

        if (!result.success) {
            if (result.notVerified) {
                return await InteractionHelper.safeReply(interaction, {
                    embeds: [infoEmbed('Nie zweryfikowany', `${targetUser.tag} nie posiada obecnie zweryfikowanej roli.`)],
                    flags: MessageFlags.Ephemeral
                });
            }
        }

        logger.info('Verification removed via command', {
            guildId: guild.id,
            targetUserId: targetUser.id,
            moderatorId: interaction.user.id
        });

        return await InteractionHelper.safeReply(interaction, {
            embeds: [successEmbed('weryfikacja usunieta', `usunieto weryfikacje z ${targetUser.tag}.`)]
        });

    } catch (error) {
        await handleInteractionError(
            interaction,
            error,
            { command: 'weryfikacja', subcommand: 'usuń' }
        );
    }
}
