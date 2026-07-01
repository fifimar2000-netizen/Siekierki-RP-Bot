import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { infoEmbed, successEmbed } from '../../utils/embeds.js';
import { withErrorHandling } from '../../utils/errorHandler.js';
import { verifyUser } from '../../services/verificationService.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    data: new SlashCommandBuilder()
        .setName('weryfikacja')
        .setDescription('Zweryfikuj siebie i uzyskaj dostęp do serwera'),

    async execute(interaction, config, client) {
        const wrappedExecute = withErrorHandling(async () => {
            const guild = interaction.guild;

            const result = await verifyUser(client, guild.id, interaction.user.id, {
                source: 'command_self',
                moderatorId: null
            });

            if (!result.success) {
                if (result.alreadyVerified) {
                    return await InteractionHelper.safeReply(interaction, {
                        embeds: [infoEmbed('Jesteś już zweryfikowany', "Jesteś już zweryfikowany.")],
                        flags: MessageFlags.Ephemeral
                    });
                }

                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Podczas weryfikacji wystąpił błąd. Spróbuj ponownie lub skontaktuj się z administratorem.' });
            }

            await InteractionHelper.safeReply(interaction, {
                embeds: [successEmbed(
                    "Weryfikacja zakończona",
                    `Zostałeś zweryfikowany i otrzymałeś **${result.roleName}** role! Witamy na serwerze! 🎉`
                )],
                flags: MessageFlags.Ephemeral
            });
        }, { command: 'zweryfikuj' });

        return await wrappedExecute(interaction, config, client);
    }
};
